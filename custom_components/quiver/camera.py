"""Live camera video, signalled over the Quiver link.

Video never crosses the link. The browser and the camera's stream source
(Google's servers for a Nest camera, go2rtc in Home Assistant for most
others) set up a WebRTC connection directly; this module only carries the
handshake between them, using the same camera entity methods Home
Assistant's own frontend reaches through its WebSocket API.

A session goes:

  down: start      → up: config     (ICE servers, data channel the camera wants)
  down: offer(sdp) → up: answer, then zero or more candidates
  down: keepalive  (every minute while someone is watching)
  down: close

The browser gathers its ICE candidates before sending the offer, so
candidates only ever flow up. A session that misses keepalives is closed
here, so a closed laptop lid doesn't leave a Nest stream running.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
import logging
import time
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval

_LOGGER = logging.getLogger(__name__)

_IDLE_TIMEOUT = 180.0  # seconds without a keepalive
_SWEEP_INTERVAL = 60.0
_MAX_SESSIONS = 8
_MAX_ID_LENGTH = 64

Send = Callable[[dict[str, Any]], None]


class CameraError(Exception):
    """A session request that can't be honoured, with a code for the browser."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class _Session:
    entity_id: str
    last_seen: float = field(default_factory=time.monotonic)
    candidates: int = 0
    offered: bool = False


class CameraSessions:
    """WebRTC sessions between Quiver viewers and this home's cameras."""

    def __init__(self, hass: HomeAssistant, send: Send) -> None:
        self._hass = hass
        self._send = send
        self._sessions: dict[str, _Session] = {}
        self._unsub_sweep: Callable[[], None] | None = None

    async def handle(self, msg: dict[str, Any]) -> None:
        """Handle one `webrtc` frame from the quiver."""
        session_id = msg.get("session_id")
        entity_id = msg.get("entity_id")
        body = msg.get("message")
        if (
            not _valid_id(session_id)
            or not _valid_id(entity_id)
            or not entity_id.startswith("camera.")
            or not isinstance(body, dict)
        ):
            return

        kind = body.get("type")
        try:
            if kind == "start":
                self._start(session_id, entity_id)
            elif kind == "offer":
                await self._offer(session_id, entity_id, body.get("sdp"))
            elif kind == "keepalive":
                session = self._sessions.get(session_id)
                if session is not None:
                    session.last_seen = time.monotonic()
            elif kind == "close":
                self._close(session_id)
        except CameraError as err:
            self._fail(session_id, err.code, str(err))
        except Exception as err:  # noqa: BLE001 — report, don't drop the link
            _LOGGER.warning("Camera session %s failed: %s", session_id, err)
            self._fail(session_id, "home_assistant_error", str(err))

    def close_all(self) -> None:
        """End every session; the link they were signalled over is gone."""
        for session_id in list(self._sessions):
            self._close(session_id)
        if self._unsub_sweep is not None:
            self._unsub_sweep()
            self._unsub_sweep = None

    # ---- session steps ----------------------------------------------------

    def _start(self, session_id: str, entity_id: str) -> None:
        camera = _webrtc_camera(self._hass, entity_id)
        config = camera.async_get_webrtc_client_configuration().to_frontend_dict()

        if session_id not in self._sessions and len(self._sessions) >= _MAX_SESSIONS:
            oldest = min(self._sessions, key=lambda s: self._sessions[s].last_seen)
            self._close(oldest)
        self._sessions[session_id] = _Session(entity_id)
        self._ensure_sweep()
        self._reply(session_id, {"type": "config", "config": config})

    async def _offer(self, session_id: str, entity_id: str, sdp: Any) -> None:
        session = self._sessions.get(session_id)
        if session is None or session.entity_id != entity_id:
            raise CameraError("unknown_session", "Session expired; start a new one")
        if session.offered:
            raise CameraError("duplicate_offer", "Session already has an offer")
        if not isinstance(sdp, str) or not sdp:
            raise CameraError("invalid_offer", "Offer has no SDP")

        camera = _webrtc_camera(self._hass, entity_id)
        session.offered = True
        session.last_seen = time.monotonic()

        @callback
        def send_message(message: Any) -> None:
            self._hass.loop.call_soon_threadsafe(
                self._reply, session_id, message.as_dict()
            )

        await camera.async_handle_async_webrtc_offer(sdp, session_id, send_message)

    def _close(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None or not session.offered:
            return
        try:
            camera = _camera(self._hass, session.entity_id)
            camera.close_webrtc_session(session_id)
        except Exception as err:  # noqa: BLE001 — camera may already be gone
            _LOGGER.debug("Closing camera session %s: %s", session_id, err)

    # ---- plumbing ---------------------------------------------------------

    def _reply(self, session_id: str, message: dict[str, Any]) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return
        frame: dict[str, Any] = {
            "type": "webrtc",
            "session_id": session_id,
            "entity_id": session.entity_id,
            "message": message,
        }
        if message.get("type") == "candidate":
            frame["seq"] = session.candidates
            session.candidates += 1
        self._send(frame)

    def _fail(self, session_id: str, code: str, message: str) -> None:
        # Errors are sent even for sessions we never registered (a bad start),
        # so the viewer stops waiting.
        self._send(
            {
                "type": "webrtc",
                "session_id": session_id,
                "message": {"type": "error", "code": code, "message": message[:300]},
            }
        )
        self._close(session_id)

    def _ensure_sweep(self) -> None:
        if self._unsub_sweep is None:
            self._unsub_sweep = async_track_time_interval(
                self._hass, self._sweep, timedelta(seconds=_SWEEP_INTERVAL)
            )

    @callback
    def _sweep(self, _now: Any) -> None:
        cutoff = time.monotonic() - _IDLE_TIMEOUT
        for session_id, session in list(self._sessions.items()):
            if session.last_seen < cutoff:
                _LOGGER.debug("Closing idle camera session %s", session_id)
                self._close(session_id)
        if not self._sessions and self._unsub_sweep is not None:
            self._unsub_sweep()
            self._unsub_sweep = None


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= _MAX_ID_LENGTH


def _camera(hass: HomeAssistant, entity_id: str) -> Any:
    # Imported lazily: a home without the camera integration shouldn't pay for
    # it, and these helpers only exist on Home Assistant 2024.11 and later.
    try:
        from homeassistant.components.camera.helper import get_camera_from_entity_id
    except ImportError as err:
        raise CameraError(
            "unsupported", "Live video needs Home Assistant 2024.11 or later"
        ) from err
    try:
        return get_camera_from_entity_id(hass, entity_id)
    except Exception as err:  # HomeAssistantError: missing or turned off
        raise CameraError("unavailable", str(err)) from err


def _webrtc_camera(hass: HomeAssistant, entity_id: str) -> Any:
    from homeassistant.components.camera import StreamType

    camera = _camera(hass, entity_id)
    capabilities = getattr(camera, "camera_capabilities", None)
    stream_types = getattr(capabilities, "frontend_stream_types", set())
    if StreamType.WEB_RTC not in stream_types:
        raise CameraError(
            "unsupported", "This camera doesn't offer a WebRTC stream"
        )
    return camera
