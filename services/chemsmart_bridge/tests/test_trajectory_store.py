"""The trajectory ledger must refuse anything it could not honestly replay."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chemsmart_studio_bridge.trajectory_store import (
    LedgerError,
    RunNotFound,
    append_event,
    append_final_event,
    append_frame,
    finish_run,
    start_run,
    list_run_ids,
    parse_ledger,
)

RUN_ID = "run-1"
DOCUMENT_ID = "molecule-1"


def _run_started(run_id: str = RUN_ID, document_id: str = DOCUMENT_ID) -> dict:
    return {
        "type": "run_started",
        "timestamp": "2026-07-28T00:00:00Z",
        "run": {
            "runId": run_id,
            "documentId": document_id,
            "inputRevision": 2,
            "engine": "xtb",
            "method": "GFN2-xTB",
            "settings": {"maxSteps": 50, "extensions": {}},
            "frozenAtomIds": [],
            "constraintIds": [],
            "status": "running",
            "createdAt": "2026-07-28T00:00:00Z",
            "extensions": {"chemsmart.controlled": {}},
        },
    }


def _frame(index: int, *, run_id: str = RUN_ID, **overrides) -> dict:
    frame = {
        "type": "controlled_calculation_frame",
        "runId": run_id,
        "frameIndex": index,
        "engineStepIndex": index,
        "atomIds": ["atom-1", "atom-2"],
        "atomicNumbers": [8, 1],
        "positions": [[0.0, 0.0, 0.0], [0.96, 0.0, 0.0]],
        "coordinateUnit": "angstrom",
        "provenance": {
            "coordinateSource": "engine",
            "atomOrder": "document_stable_id_order",
            "transformation": "none",
        },
        "energy": {"value": -76.1 - index * 0.01, "unit": "hartree"},
        "forceMetrics": {"max": 0.002, "rms": 0.001, "unit": "hartree/bohr"},
        "structureHash": f"sha256:{str(index).rjust(64, '0')}",
        "timestamp": f"2026-07-28T00:0{index}:00Z",
        "extensions": {},
    }
    frame.update(overrides)
    return frame


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    package = tmp_path / "Water.cmsproj"
    package.mkdir()
    append_event(package, RUN_ID, _run_started())
    return package


class TestReadBack:
    def test_replays_the_frames_that_were_appended(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))
        append_frame(project, RUN_ID, _frame(1))

        ledger = parse_ledger(project, RUN_ID)

        assert ledger.frame_count == 2
        assert [frame["frameIndex"] for frame in ledger.frames] == [0, 1]
        assert ledger.atom_ids == ["atom-1", "atom-2"]

    def test_an_unwritten_run_is_not_found(self, tmp_path: Path) -> None:
        with pytest.raises(RunNotFound):
            parse_ledger(tmp_path, "run-missing")

    def test_lists_runs_that_have_a_ledger(self, project: Path) -> None:
        append_event(project, "run-2", _run_started("run-2"))
        (project / "runs" / "run-3").mkdir(parents=True)

        # run-3 has a directory but no ledger, so it is not a replayable run.
        assert list_run_ids(project) == ["run-2", "run-1"]

    def test_refuses_a_run_belonging_to_another_document(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="another document"):
            parse_ledger(project, RUN_ID, document_id="molecule-other")


class TestNeverInterpolated:
    """The property the whole ledger exists to protect."""

    def test_refuses_a_frame_that_was_not_computed_by_the_engine(
        self, project: Path
    ) -> None:
        interpolated = _frame(
            0,
            provenance={
                "coordinateSource": "interpolated",
                "atomOrder": "document_stable_id_order",
                "transformation": "none",
            },
        )

        with pytest.raises(LedgerError, match="schema-invalid"):
            append_frame(project, RUN_ID, interpolated)

    def test_refuses_a_transformed_frame(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="schema-invalid"):
            append_frame(
                project,
                RUN_ID,
                _frame(
                    0,
                    provenance={
                        "coordinateSource": "engine",
                        "atomOrder": "document_stable_id_order",
                        "transformation": "aligned",
                    },
                ),
            )

    def test_refuses_a_reordered_frame(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="schema-invalid"):
            append_frame(
                project,
                RUN_ID,
                _frame(
                    0,
                    provenance={
                        "coordinateSource": "engine",
                        "atomOrder": "input_order",
                        "transformation": "none",
                    },
                ),
            )

    def test_a_hand_edited_ledger_cannot_smuggle_a_frame_past_the_reader(
        self, project: Path
    ) -> None:
        # Validation on read, not only on write: the ledger is a plain file inside the
        # project package, so someone can append to it without going through us.
        append_frame(project, RUN_ID, _frame(0))
        forged = _frame(
            1,
            provenance={
                "coordinateSource": "interpolated",
                "atomOrder": "document_stable_id_order",
                "transformation": "none",
            },
        )
        path = project / "runs" / RUN_ID / "events.ndjson"
        with path.open("a") as handle:
            handle.write(json.dumps(forged) + "\n")

        with pytest.raises(LedgerError, match="schema-invalid"):
            parse_ledger(project, RUN_ID)


class TestOrdering:
    def test_refuses_a_gap(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))

        with pytest.raises(LedgerError, match="out of order"):
            append_frame(project, RUN_ID, _frame(2))

    def test_refuses_a_repeat(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))

        with pytest.raises(LedgerError, match="out of order"):
            append_frame(project, RUN_ID, _frame(0))

    def test_refuses_an_engine_step_that_disagrees(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="step index disagrees"):
            append_frame(project, RUN_ID, _frame(0, engineStepIndex=7))

    def test_refuses_a_frame_from_another_run(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="another run"):
            append_frame(project, RUN_ID, _frame(0, runId="run-other"))


class TestAtomIdentity:
    def test_refuses_a_changed_atom_set(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))

        # A molecule may move during an optimization; it may not become another molecule.
        with pytest.raises(LedgerError, match="atom identity changed"):
            append_frame(
                project,
                RUN_ID,
                _frame(1, atomIds=["atom-1", "atom-3"]),
            )

    def test_refuses_disagreeing_atom_arrays(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="schema-invalid|arrays disagree"):
            append_frame(project, RUN_ID, _frame(0, atomicNumbers=[8]))


class TestLedgerIntegrity:
    def test_refuses_a_truncated_final_line(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))
        path = project / "runs" / RUN_ID / "events.ndjson"
        with path.open("a") as handle:
            handle.write('{"type":"controlled_calculation_frame"')

        # An unterminated line means the writer was interrupted: the tail is not a fact.
        with pytest.raises(LedgerError, match="event boundary"):
            parse_ledger(project, RUN_ID)

    def test_refuses_malformed_json(self, project: Path) -> None:
        path = project / "runs" / RUN_ID / "events.ndjson"
        with path.open("a") as handle:
            handle.write("not json\n")

        with pytest.raises(LedgerError, match="malformed JSON"):
            parse_ledger(project, RUN_ID)

    def test_refuses_an_empty_event(self, project: Path) -> None:
        path = project / "runs" / RUN_ID / "events.ndjson"
        with path.open("a") as handle:
            handle.write("\n")

        with pytest.raises(LedgerError, match="empty event"):
            parse_ledger(project, RUN_ID)

    def test_refuses_a_ledger_that_does_not_start_with_the_run(
        self, tmp_path: Path
    ) -> None:
        package = tmp_path / "Broken.cmsproj"
        package.mkdir()
        append_event(package, RUN_ID, _frame(0))

        with pytest.raises(LedgerError, match="run start is schema-invalid"):
            parse_ledger(package, RUN_ID)

    def test_refuses_frames_after_the_run_closed(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))
        append_event(
            project,
            RUN_ID,
            {"type": "run_finished", "timestamp": "2026-07-28T01:00:00Z"},
        )

        with pytest.raises(LedgerError, match="past its terminal event"):
            append_frame(project, RUN_ID, _frame(1))


class TestRunLifecycle:
    """The writer must only produce ledgers the reader accepts."""

    def test_a_run_written_here_reads_back_here(self, tmp_path: Path) -> None:
        package = tmp_path / "Round.cmsproj"
        package.mkdir()
        run = _run_started()["run"]

        start_run(package, run, timestamp="2026-07-28T00:00:00Z")
        append_frame(package, RUN_ID, _frame(0))
        append_frame(package, RUN_ID, _frame(1))
        finish_run(
            package,
            RUN_ID,
            {
                "type": "controlled_calculation_terminal",
                "runId": RUN_ID,
                "status": "completed",
                "frameCount": 2,
                "outputGeometryHash": _frame(1)["structureHash"],
                "completedAt": "2026-07-28T00:05:00Z",
                "extensions": {},
            },
        )

        ledger = parse_ledger(package, RUN_ID)
        assert ledger.frame_count == 2
        assert ledger.closed is True

    def test_refuses_to_reuse_a_run_id(self, project: Path) -> None:
        # Appending onto an existing ledger would concatenate two runs into one
        # trajectory, and consecutive frame indices would make it look intentional.
        with pytest.raises(LedgerError, match="already exists"):
            start_run(project, _run_started()["run"], timestamp="2026-07-28T00:00:00Z")

    def test_refuses_a_run_that_is_not_controlled(self, tmp_path: Path) -> None:
        package = tmp_path / "Uncontrolled.cmsproj"
        package.mkdir()
        run = _run_started()["run"] | {"extensions": {}}

        # Without the marker the ledger would open and then reject every frame.
        with pytest.raises(LedgerError, match="not a controlled calculation"):
            start_run(package, run, timestamp="2026-07-28T00:00:00Z")

    def test_refuses_a_terminal_that_miscounts_the_frames(self, project: Path) -> None:
        append_frame(project, RUN_ID, _frame(0))

        with pytest.raises(LedgerError, match="frame count disagrees"):
            finish_run(
                project,
                RUN_ID,
                {
                    "type": "controlled_calculation_terminal",
                    "runId": RUN_ID,
                    "status": "completed",
                    "frameCount": 9,
                    "extensions": {},
                },
            )

    def test_refuses_to_close_a_run_twice(self, project: Path) -> None:
        terminal = {
            "type": "controlled_calculation_terminal",
            "runId": RUN_ID,
            "status": "cancelled",
            "frameCount": 0,
            "reason": "stopped by the researcher",
            "terminatedAt": "2026-07-28T00:05:00Z",
            "extensions": {},
        }
        finish_run(project, RUN_ID, terminal)

        with pytest.raises(LedgerError, match="already closed"):
            finish_run(project, RUN_ID, terminal)


class TestFinalDecisionJournal:
    def _close_completed(self, project: Path) -> str:
        frame = _frame(0)
        append_frame(project, RUN_ID, frame)
        finish_run(
            project,
            RUN_ID,
            {
                "type": "controlled_calculation_terminal",
                "runId": RUN_ID,
                "status": "completed",
                "frameCount": 1,
                "outputGeometryHash": frame["structureHash"],
                "completedAt": "2026-07-28T00:05:00Z",
                "extensions": {},
            },
        )
        return frame["structureHash"]

    def test_records_a_closed_acceptance_union_in_order(self, project: Path) -> None:
        geometry_hash = self._close_completed(project)
        append_final_event(
            project,
            RUN_ID,
            {
                "type": "optimization_final_accept_requested",
                "runId": RUN_ID,
                "expectedRevision": 2,
                "geometryHash": geometry_hash,
                "timestamp": "2026-07-28T00:06:00Z",
            },
        )
        append_final_event(
            project,
            RUN_ID,
            {
                "type": "optimization_final_accepted",
                "runId": RUN_ID,
                "revision": 3,
                "geometryHash": geometry_hash,
                "timestamp": "2026-07-28T00:07:00Z",
            },
        )

        ledger = parse_ledger(project, RUN_ID)
        assert ledger.outcome == "accepted"
        assert [event["type"] for event in ledger.final_events] == [
            "optimization_final_accept_requested",
            "optimization_final_accepted",
        ]

    def test_failed_decision_is_retryable_but_a_terminal_decision_is_not(
        self, project: Path
    ) -> None:
        geometry_hash = self._close_completed(project)
        request = {
            "type": "optimization_final_reject_requested",
            "runId": RUN_ID,
            "expectedRevision": 2,
            "geometryHash": geometry_hash,
            "timestamp": "2026-07-28T00:06:00Z",
        }
        append_final_event(project, RUN_ID, request)
        append_final_event(
            project,
            RUN_ID,
            {
                "type": "optimization_final_reject_failed",
                "runId": RUN_ID,
                "expectedRevision": 2,
                "geometryHash": geometry_hash,
                "timestamp": "2026-07-28T00:07:00Z",
                "error": {"code": "DURABLE_WRITE_FAILED", "message": "retry me"},
            },
        )
        append_final_event(project, RUN_ID, request | {"timestamp": "2026-07-28T00:08:00Z"})
        append_final_event(
            project,
            RUN_ID,
            {
                "type": "optimization_final_rejected",
                "runId": RUN_ID,
                "revision": 2,
                "geometryHash": geometry_hash,
                "timestamp": "2026-07-28T00:09:00Z",
            },
        )

        assert parse_ledger(project, RUN_ID).outcome == "rejected"
        with pytest.raises(LedgerError, match="out of order"):
            append_final_event(project, RUN_ID, request | {"timestamp": "2026-07-28T00:10:00Z"})

    def test_refuses_a_decision_before_a_completed_terminal(self, project: Path) -> None:
        with pytest.raises(LedgerError, match="invalid"):
            append_final_event(
                project,
                RUN_ID,
                {
                    "type": "optimization_final_accept_requested",
                    "runId": RUN_ID,
                    "expectedRevision": 2,
                    "geometryHash": _frame(0)["structureHash"],
                    "timestamp": "2026-07-28T00:06:00Z",
                },
            )
