"""CameraSessions against a fake camera.

Needs the `homeassistant` package (for StreamType and the camera helper that
gets patched out); see the README for how to run it.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
import unittest
from unittest import mock

from homeassistant.components.camera import StreamType
from homeassistant.components.camera.webrtc import WebRTCAnswer, WebRTCCandidate
from homeassistant.exceptions import HomeAssistantError
from webrtc_models import RTCIceCandidateInit

import camera as camera_module
from camera import CameraSessions


class FakeCamera:
    def __init__(self, stream_types: set[StreamType]) -> None:
        self.camera_capabilities = SimpleNamespace(frontend_stream_types=stream_types)
        self.offers: list[tuple[str, str]] = []
        self.closed: list[str] = []

    def async_get_webrtc_client_configuration(self):
        return SimpleNamespace(
            to_frontend_dict=lambda: {
                "configuration": {"iceServers": []},
                "getCandidatesUpfront": False,
                "dataChannel": "dataSendChannel",
            }
        )

    async def async_handle_async_webrtc_offer(self, sdp, session_id, send_message):
        self.offers.append((session_id, sdp))
        send_message(WebRTCAnswer("v=0 answer"))
        send_message(WebRTCCandidate(RTCIceCandidateInit("candidate:1", sdp_mid="0")))
        send_message(WebRTCCandidate(RTCIceCandidateInit("candidate:2", sdp_mid="0")))

    def close_webrtc_session(self, session_id):
        self.closed.append(session_id)


def frame(kind: str, session: str = "session-1", **extra) -> dict:
    return {
        "type": "webrtc",
        "session_id": session,
        "entity_id": "camera.front_door",
        "message": {"type": kind, **extra},
    }


class CameraSessionsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.sent: list[dict] = []
        self.camera = FakeCamera({StreamType.WEB_RTC})
        hass = SimpleNamespace(loop=asyncio.get_running_loop())
        self.sessions = CameraSessions(hass, self.sent.append)
        patches = [
            mock.patch(
                "homeassistant.components.camera.helper.get_camera_from_entity_id",
                side_effect=self._lookup,
            ),
            mock.patch.object(
                camera_module, "async_track_time_interval", return_value=lambda: None
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _lookup(self, _hass, entity_id):
        if entity_id != "camera.front_door":
            raise HomeAssistantError("Camera not found")
        return self.camera

    async def settle(self) -> None:
        # Replies are scheduled with call_soon_threadsafe.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    async def test_handshake(self) -> None:
        await self.sessions.handle(frame("start"))
        await self.sessions.handle(frame("offer", sdp="v=0 offer"))
        await self.settle()

        self.assertEqual(self.camera.offers, [("session-1", "v=0 offer")])
        messages = [f["message"] for f in self.sent]
        self.assertEqual(messages[0]["type"], "config")
        self.assertEqual(messages[0]["config"]["dataChannel"], "dataSendChannel")
        self.assertEqual(messages[1], {"type": "answer", "answer": "v=0 answer"})
        self.assertEqual([f.get("seq") for f in self.sent[2:]], [0, 1])
        self.assertEqual(messages[2]["candidate"]["candidate"], "candidate:1")
        self.assertTrue(all(f["session_id"] == "session-1" for f in self.sent))

        await self.sessions.handle(frame("close"))
        self.assertEqual(self.camera.closed, ["session-1"])

    async def test_camera_without_webrtc_is_refused(self) -> None:
        self.camera.camera_capabilities.frontend_stream_types = {StreamType.HLS}
        await self.sessions.handle(frame("start"))
        self.assertEqual(self.sent[0]["message"]["type"], "error")
        self.assertEqual(self.sent[0]["message"]["code"], "unsupported")

    async def test_offer_without_start_is_refused(self) -> None:
        await self.sessions.handle(frame("offer", sdp="v=0 offer"))
        self.assertEqual(self.sent[0]["message"]["code"], "unknown_session")
        self.assertEqual(self.camera.offers, [])

    async def test_idle_sessions_are_closed(self) -> None:
        await self.sessions.handle(frame("start"))
        await self.sessions.handle(frame("offer", sdp="v=0 offer"))
        with mock.patch.object(
            camera_module.time, "monotonic", return_value=10**9
        ):
            self.sessions._sweep(None)
        self.assertEqual(self.camera.closed, ["session-1"])

    async def test_close_all_ends_every_session(self) -> None:
        for sid in ("session-1", "session-2"):
            await self.sessions.handle(frame("start", session=sid))
            await self.sessions.handle(frame("offer", session=sid, sdp="v=0"))
        self.sessions.close_all()
        self.assertEqual(sorted(self.camera.closed), ["session-1", "session-2"])

    async def test_ignores_malformed_frames(self) -> None:
        await self.sessions.handle({"type": "webrtc", "session_id": "x"})
        await self.sessions.handle({**frame("start"), "entity_id": "light.kitchen"})
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
