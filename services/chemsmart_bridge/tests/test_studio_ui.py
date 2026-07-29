from __future__ import annotations

import json
import stat
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from chemsmart_studio_bridge.studio_ui import (
    MAX_LEDGER_LINE_BYTES,
    StudioUiEventEmitter,
    StudioUiLedgerError,
)


class StudioUiEventEmitterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.ledger = Path(self.temporary_directory.name) / "studio-ui-events.ndjson"

    def emitter(self, **kwargs) -> StudioUiEventEmitter:
        options = {
            "clock": lambda: datetime(2026, 7, 22, 4, 30, tzinfo=timezone.utc),
            "event_id_factory": lambda: "ui-fixed",
        }
        options.update(kwargs)
        return StudioUiEventEmitter(
            "session-1",
            self.ledger,
            **options,
        )

    def test_accepts_and_persists_generated_identity_before_publish(self) -> None:
        published = []
        emitter = self.emitter(publish=published.append)
        result = emitter.emit(
            {
                "kind": "status",
                "message": "Inspecting <script>without rendering it</script>.",
                "extensions": {},
            }
        )

        self.assertEqual(
            result, {"accepted": True, "eventId": "ui-fixed", "sequence": 0}
        )
        event = json.loads(self.ledger.read_text())
        self.assertEqual(event["sessionId"], "session-1")
        self.assertEqual(event["timestamp"], "2026-07-22T04:30:00.000Z")
        self.assertEqual(published, [event])
        self.assertEqual(stat.S_IMODE(self.ledger.stat().st_mode), 0o600)

    def test_persists_runtime_agent_response_as_bounded_notice(self) -> None:
        emitter = self.emitter()

        result = emitter.emit_runtime_notice("The preview is ready for review.")

        self.assertEqual(
            result, {"accepted": True, "eventId": "ui-fixed", "sequence": 0}
        )
        event = json.loads(self.ledger.read_text())
        self.assertEqual(event["source"], "runtime")
        self.assertEqual(event["kind"], "notice")
        self.assertEqual(
            event["payload"], {"message": "The preview is ready for review."}
        )
        self.assertEqual(event["extensions"], {})

        oversized = emitter.emit_runtime_notice("x" * 4096)
        self.assertTrue(oversized["accepted"])
        bounded = list(emitter.events())[-1]["payload"]["message"]
        self.assertEqual(len(bounded), 2048)
        self.assertTrue(bounded.endswith("…"))

    def test_rejects_trusted_or_approval_fields_without_writing(self) -> None:
        result = self.emitter().emit(
            {
                "kind": "notice",
                "message": "Attempting to forge approval.",
                "approvalId": "approval-forged",
                "extensions": {},
            }
        )

        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "SCHEMA_INVALID")
        self.assertFalse(self.ledger.exists())

    def test_requires_progress_and_focus_context(self) -> None:
        emitter = self.emitter()
        progress = emitter.emit(
            {"kind": "progress", "message": "Missing run.", "extensions": {}}
        )
        focus = emitter.emit(
            {
                "kind": "molecule_focus",
                "message": "Missing target.",
                "documentId": "mol-1",
                "revision": 0,
                "extensions": {},
            }
        )

        self.assertEqual(progress["error"]["code"], "SCHEMA_INVALID")
        self.assertEqual(focus["error"]["code"], "SCHEMA_INVALID")
        self.assertFalse(self.ledger.exists())

    def test_recovers_monotonic_sequence_after_restart(self) -> None:
        first = self.emitter()
        self.assertTrue(
            first.emit({"kind": "status", "message": "First.", "extensions": {}})[
                "accepted"
            ]
        )
        second = self.emitter(event_id_factory=lambda: "ui-second")

        result = second.emit({"kind": "notice", "message": "Second.", "extensions": {}})

        self.assertEqual(result["sequence"], 1)
        self.assertEqual([event["sequence"] for event in second.events()], [0, 1])

    def test_persists_when_publish_fails_and_replays_in_order(self) -> None:
        def unavailable(_event):
            raise ConnectionError("renderer unavailable")

        emitter = self.emitter(publish=unavailable)
        result = emitter.emit({"kind": "status", "message": "Saved.", "extensions": {}})
        replayed = []

        self.assertTrue(result["accepted"])
        self.assertEqual(emitter.last_delivery_error, "ConnectionError")
        self.assertEqual(emitter.replay(replayed.append), 1)
        self.assertEqual(replayed[0]["eventId"], "ui-fixed")

    def test_persists_typed_stale_focus_rejection(self) -> None:
        def reject_stale(_event):
            return {
                "accepted": False,
                "eventId": "ui-fixed",
                "sequence": 0,
                "error": {
                    "code": "REVISION_CONFLICT",
                    "message": "Molecule focus revision is stale",
                },
            }

        result = self.emitter(publish=reject_stale).emit(
            {
                "kind": "molecule_focus",
                "message": "Focus atom.",
                "documentId": "mol-1",
                "revision": 2,
                "atomIds": ["a-1"],
                "extensions": {},
            }
        )

        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "REVISION_CONFLICT")
        self.assertEqual(result["sequence"], 0)
        self.assertEqual(len(list(self.emitter().events())), 1)

    def test_rejects_mismatched_electron_acknowledgement(self) -> None:
        emitter = self.emitter(
            publish=lambda _event: {
                "accepted": True,
                "eventId": "ui-forged",
                "sequence": 0,
            }
        )

        result = emitter.emit(
            {"kind": "notice", "message": "Persist first.", "extensions": {}}
        )

        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "DELIVERY_REJECTED")
        self.assertEqual(emitter.last_delivery_error, "DELIVERY_REJECTED")
        self.assertEqual(len(list(emitter.events())), 1)

    def test_rejects_out_of_order_or_oversized_existing_ledger(self) -> None:
        event = {
            "eventId": "ui-bad",
            "sessionId": "session-1",
            "sequence": 2,
            "timestamp": "2026-07-22T04:30:00Z",
            "source": "model_tool",
            "kind": "status",
            "payload": {"message": "Out of order."},
            "extensions": {},
        }
        self.ledger.write_text(json.dumps(event) + "\n")
        with self.assertRaisesRegex(StudioUiLedgerError, "sequence mismatch"):
            self.emitter()

        self.ledger.write_bytes(b"x" * (MAX_LEDGER_LINE_BYTES + 1) + b"\n")
        with self.assertRaisesRegex(StudioUiLedgerError, "size limit"):
            self.emitter()

    def test_rejects_oversized_new_event_without_advancing_sequence(self) -> None:
        emitter = self.emitter()
        result = emitter.emit(
            {
                "kind": "status",
                "message": "Too large.",
                "extensions": {"test.large": {"value": "x" * MAX_LEDGER_LINE_BYTES}},
            }
        )

        self.assertFalse(result["accepted"])
        self.assertEqual(result["error"]["code"], "EVENT_TOO_LARGE")
        self.assertEqual(emitter.next_sequence, 0)
        self.assertFalse(self.ledger.exists())


if __name__ == "__main__":
    unittest.main()
