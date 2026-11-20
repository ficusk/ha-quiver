"""The reverse tunnel between this home and its Quiver channel.

Holds one WebSocket open to the quiver (it dials *out*, so nothing is
exposed at the house). On `ready` it pushes a full snapshot, a registry
frame (which area each entity lives in), and then streams every state
change; it runs `call_service` frames the quiver sends down and relays
camera WebRTC handshakes (see camera.py). Reconnects with backoff;
re-snapshots on every (re)connect.

Areas, hidden flags, and entity categories live in HA's area/device/entity
registries — not in the state machine — so they ride their own `registry`
frame, resent (coalesced) whenever a registry changes.

Wire protocol (this side ↔ quiver), JSON text frames:
  down: {"type":"ready","edge_relay":{...}}             authorize + relay
        {"type":"call_service","domain","service","data"} control
        {"type":"webrtc","session_id","entity_id","message"} camera handshake
  up:   {"type":"edge_relay_status",...}                  relay ack/error
        {"type":"snapshot","states":[...]}                after ready
        {"type":"registry","areas":[...],"entities":{...}} after ready + on change
        {"type":"state_changed","state":{...}}            per change
        {"type":"state_removed","entity_id":"..."}        entity gone
        {"type":"ingest_pressure","report":{...}}         relay aggregate
        {"type":"webrtc","session_id","message",...}      camera handshake
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later

from .camera import CameraSessions
from .edge_relay import EdgeRelay, EdgeRelayError

_LOGGER = logging.getLogger(__name__)
_MAX_BACKOFF = 60


def _serialize(state: State) -> dict[str, Any]:
    return {
        "entity_id": state.entity_id,
        "state": state.state,
        "attributes": dict(state.attributes),
        "last_changed": state.last_changed.isoformat() if state.last_changed else None,
        "last_updated": state.last_updated.isoformat() if state.last_updated else None,
    }


class QuiverLink:
    """Owns the connection lifecycle for one Quiver channel."""

    def __init__(self, hass: HomeAssistant, ws_url: str) -> None:
        self.hass = hass
        self.ws_url = ws_url
        self._task: asyncio.Task | None = None
        self._outbox: asyncio.Queue[tuple[dict[str, Any], bool]] | None = None
        self._unsub_state: Any = None
        self._unsub_registry: list[Any] = []
        self._registry_timer: Any = None
        self._edge_relay: EdgeRelay | None = None
        self._edge_relay_revision: str | None = None
        self._stopping = False
        # Handshake frames skip the edge relay: they aren't entity state, and
        # an SDP blob is the wrong thing to feed a 20ms-budget filter.
        self._cameras = CameraSessions(
            hass, lambda frame: self._enqueue(frame, apply_relay=False)
        )

    def start(self) -> None:
        self._task = self.hass.async_create_background_task(self._run(), "quiver-link")

    async def stop(self) -> None:
        self._stopping = True
        self._teardown_subscription()
        self._teardown_registry()
        self._clear_edge_relay()
        self._cameras.close_all()
        if self._task is not None:
            self._task.cancel()

    def _clear_edge_relay(self) -> None:
        relay = self._edge_relay
        self._edge_relay = None
        self._edge_relay_revision = None
        if relay is not None:
            relay.close()

    # ---- connection loop --------------------------------------------------

    async def _run(self) -> None:
        backoff = 1
        session = async_get_clientsession(self.hass)
        while not self._stopping:
            self._outbox = asyncio.Queue()
            writer: asyncio.Task | None = None
            try:
                async with session.ws_connect(self.ws_url, heartbeat=30) as ws:
                    backoff = 1
                    _LOGGER.info("Quiver link connected")
                    writer = asyncio.create_task(self._writer(ws))
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            await self._on_message(json.loads(msg.data))
                        elif msg.type in (
                            aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.ERROR,
                        ):
                            break
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — any failure → reconnect
                _LOGGER.warning("Quiver link error: %s", err)
            finally:
                self._teardown_subscription()
                self._teardown_registry()
                self._clear_edge_relay()
                self._cameras.close_all()
                if writer is not None:
                    writer.cancel()
            if self._stopping:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF)

    async def _writer(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        assert self._outbox is not None
        try:
            while True:
                frame, apply_relay = await self._outbox.get()
                outgoing = [frame]
                relay = self._edge_relay if apply_relay else None
                if relay is not None:
                    try:
                        outgoing = await self.hass.async_add_executor_job(
                            relay.process, frame
                        )
                    except EdgeRelayError as err:
                        revision = self._edge_relay_revision
                        self._clear_edge_relay()
                        _LOGGER.error(
                            "Quiver edge relay %s failed open: %s",
                            revision or "unknown",
                            err,
                        )
                        outgoing = [
                            {
                                "type": "edge_relay_status",
                                "active": False,
                                "revision": revision,
                                "error": _short_error(err),
                            },
                            frame,
                        ]
                for outgoing_frame in outgoing:
                    await ws.send_str(json.dumps(outgoing_frame, default=str))
        except asyncio.CancelledError:
            pass
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Quiver writer stopped: %s", err)

    # ---- inbound (control) ------------------------------------------------

    async def _on_message(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "ready":
            await self._configure_edge_relay(msg.get("edge_relay"))
            self._send_snapshot()
            self._send_registry()
            self._subscribe()
            self._subscribe_registry()
        elif kind == "call_service":
            domain = msg.get("domain")
            service = msg.get("service")
            data = msg.get("data") or {}
            if domain and service:
                await self.hass.services.async_call(
                    domain, service, data, blocking=False
                )
        elif kind == "webrtc":
            # An offer can take a second or two (Nest asks Google for a
            # stream), so don't hold up the read loop on it.
            self.hass.async_create_task(
                self._cameras.handle(msg), "quiver-camera-signal"
            )

    async def _configure_edge_relay(self, raw: Any) -> None:
        self._clear_edge_relay()
        if not isinstance(raw, dict):
            self._enqueue(
                {
                    "type": "edge_relay_status",
                    "active": False,
                    "error": "Quiver did not provide an edge relay",
                },
                apply_relay=False,
            )
            return

        revision = raw.get("revision")
        source = raw.get("source")
        version = raw.get("version")
        language = raw.get("language")
        if (
            language != "javascript"
            or not isinstance(version, int)
            or not isinstance(revision, str)
            or not revision
            or not isinstance(source, str)
        ):
            self._enqueue(
                {
                    "type": "edge_relay_status",
                    "active": False,
                    "error": "Quiver provided an invalid edge relay declaration",
                },
                apply_relay=False,
            )
            return

        try:
            relay = await self.hass.async_add_executor_job(EdgeRelay, source)
        except EdgeRelayError as err:
            _LOGGER.error("Could not load Quiver edge relay %s: %s", revision, err)
            self._enqueue(
                {
                    "type": "edge_relay_status",
                    "active": False,
                    "version": version,
                    "revision": revision,
                    "error": _short_error(err),
                },
                apply_relay=False,
            )
            return

        self._edge_relay = relay
        self._edge_relay_revision = revision
        self._enqueue(
            {
                "type": "edge_relay_status",
                "active": True,
                "version": version,
                "revision": revision,
            },
            apply_relay=False,
        )
        _LOGGER.info("Quiver edge relay %s active", revision)

    # ---- outbound (state) -------------------------------------------------

    def _send_snapshot(self) -> None:
        states = [_serialize(s) for s in self.hass.states.async_all()]
        self._enqueue({"type": "snapshot", "states": states})

    def _subscribe(self) -> None:
        if self._unsub_state is not None:
            return

        @callback
        def _on_state_changed(event: Event) -> None:
            new_state = event.data.get("new_state")
            if new_state is None:
                self._enqueue(
                    {"type": "state_removed", "entity_id": event.data.get("entity_id")}
                )
            else:
                self._enqueue({"type": "state_changed", "state": _serialize(new_state)})

        self._unsub_state = self.hass.bus.async_listen(
            EVENT_STATE_CHANGED, _on_state_changed
        )

    def _teardown_subscription(self) -> None:
        if self._unsub_state is not None:
            self._unsub_state()
            self._unsub_state = None

    # ---- outbound (registry: which area each entity lives in) -------------

    def _build_registry(self) -> dict[str, Any]:
        area_reg = ar.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)
        ent_reg = er.async_get(self.hass)

        areas = [
            {"area_id": area.id, "name": area.name, "floor_id": area.floor_id}
            for area in area_reg.async_list_areas()
        ]

        entities: dict[str, dict[str, Any]] = {}
        for entry in ent_reg.entities.values():
            # An entity's area is its own assignment, else its device's.
            area_id = entry.area_id
            if area_id is None and entry.device_id:
                device = dev_reg.async_get(entry.device_id)
                if device is not None:
                    area_id = device.area_id
            category = entry.entity_category
            entities[entry.entity_id] = {
                "area_id": area_id,
                "hidden": entry.hidden_by is not None,
                "category": category.value if category is not None else None,
            }
        return {"type": "registry", "areas": areas, "entities": entities}

    def _send_registry(self) -> None:
        self._enqueue(self._build_registry())

    def _subscribe_registry(self) -> None:
        if self._unsub_registry:
            return

        @callback
        def _on_registry_updated(_event: Event) -> None:
            self._schedule_registry_send()

        self._unsub_registry = [
            self.hass.bus.async_listen(
                ar.EVENT_AREA_REGISTRY_UPDATED, _on_registry_updated
            ),
            self.hass.bus.async_listen(
                dr.EVENT_DEVICE_REGISTRY_UPDATED, _on_registry_updated
            ),
            self.hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED, _on_registry_updated
            ),
        ]

    @callback
    def _schedule_registry_send(self) -> None:
        # A reload (or bulk edit) fires a burst of registry events; coalesce
        # them into a single resend a beat later.
        if self._registry_timer is not None:
            self._registry_timer()
        self._registry_timer = async_call_later(self.hass, 1.0, self._flush_registry)

    @callback
    def _flush_registry(self, _now: Any) -> None:
        self._registry_timer = None
        self._send_registry()

    def _teardown_registry(self) -> None:
        if self._registry_timer is not None:
            self._registry_timer()
            self._registry_timer = None
        for unsub in self._unsub_registry:
            unsub()
        self._unsub_registry = []

    def _enqueue(self, frame: dict[str, Any], *, apply_relay: bool = True) -> None:
        if self._outbox is not None:
            self._outbox.put_nowait((frame, apply_relay))


def _short_error(err: Exception) -> str:
    return str(err).replace("\n", " ")[:300]
