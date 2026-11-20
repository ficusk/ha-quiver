from __future__ import annotations

import unittest
from time import monotonic

from edge_relay import EdgeRelay, EdgeRelayError


SOURCE = r"""
(() => ({
  initialState: { seen: {} },
  onMessage(frame, state) {
    const message = JSON.parse(frame);
    if (message.type === "snapshot") {
      return { state: { seen: { ...message.values } }, send: frame };
    }
    if (message.type === "value") {
      if (state.seen[message.id] === message.value) return undefined;
      state.seen[message.id] = message.value;
      return {
        send: [
          frame,
          JSON.stringify({ type: "count", values: Object.keys(state.seen).length }),
        ],
      };
    }
    return { send: frame };
  },
}))()
"""


class EdgeRelayTests(unittest.TestCase):
    def test_preserves_state_and_returns_generated_frames(self) -> None:
        relay = EdgeRelay(SOURCE)

        self.assertEqual(
            relay.process({"type": "snapshot", "values": {"a": 1}}),
            [{"type": "snapshot", "values": {"a": 1}}],
        )
        self.assertEqual(relay.process({"type": "value", "id": "a", "value": 1}), [])
        self.assertEqual(
            relay.process({"type": "value", "id": "a", "value": 2}),
            [
                {"type": "value", "id": "a", "value": 2},
                {"type": "count", "values": 1},
            ],
        )

    def test_rejects_a_program_without_the_relay_contract(self) -> None:
        with self.assertRaisesRegex(EdgeRelayError, "onMessage"):
            EdgeRelay("({})")

    def test_rejects_non_json_output(self) -> None:
        relay = EdgeRelay(
            "({initialState:{},onMessage(){return {send:'not json'}}})"
        )
        with self.assertRaisesRegex(EdgeRelayError, "invalid JSON"):
            relay.process({"type": "anything"})

    def test_interrupts_runaway_code(self) -> None:
        relay = EdgeRelay(
            "({initialState:{},onMessage(){while(true){} }})"
        )
        started = monotonic()
        with self.assertRaisesRegex(EdgeRelayError, "interrupted"):
            relay.process({"type": "anything"})
        self.assertLess(monotonic() - started, 0.5)

    def test_releases_the_worker_and_rejects_later_frames(self) -> None:
        relay = EdgeRelay(SOURCE)
        relay.close()
        relay.close()

        with self.assertRaisesRegex(EdgeRelayError, "closed"):
            relay.process({"type": "anything"})


if __name__ == "__main__":
    unittest.main()
