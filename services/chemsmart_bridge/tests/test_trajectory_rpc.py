"""The trajectory methods the Qt helper used to answer, now served by the sidecar."""

from __future__ import annotations

from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from chemsmart_studio_bridge.generated_protocol import OPTIMIZATION_REPLAY_RUNTIME_SCHEMA
from chemsmart_studio_bridge.rpc import RpcFault
from chemsmart_studio_bridge.runtime import StudioAgentRuntime
from chemsmart_studio_bridge.trajectory_store import append_frame, start_run

from test_trajectory_store import _frame, _run_started

RUN_ID = "run-1"


def _open_request() -> dict:
    return {
        "run": _run_started()["run"],
        "timestamp": "2026-07-28T00:00:00Z",
        "inputSnapshotHash": f"sha256:{'b' * 64}",
        "inputTopologyHash": f"sha256:{'c' * 64}",
    }


@pytest.fixture()
def runtime(tmp_path: Path) -> StudioAgentRuntime:
    project = tmp_path / "Water.cmsproj"
    project.mkdir()
    start_run(project, _run_started()["run"], timestamp="2026-07-28T00:00:00Z")
    append_frame(project, RUN_ID, _frame(0))
    append_frame(project, RUN_ID, _frame(1))
    return StudioAgentRuntime(tmp_path / "sessions", project)


def test_catalog_lists_the_run_with_its_frame_count(runtime: StudioAgentRuntime) -> None:
    result = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})

    assert result["totalRuns"] == 1
    assert result["runs"][0]["frameCount"] == 2
    assert result["runs"][0]["run"]["runId"] == RUN_ID
    assert result["nextRunId"] is None


def test_catalog_summarises_the_latest_frame_without_its_coordinates(
    runtime: StudioAgentRuntime,
) -> None:
    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]

    assert record["latestFrame"]["stepIndex"] == 1
    # A summary describes a step; it does not carry the geometry again.
    assert "positions" not in record["latestFrame"]


def test_catalog_latest_frame_conforms_to_the_frame_summary_contract(
    runtime: StudioAgentRuntime,
) -> None:
    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]

    # The host validates this half of the catalog on read against frameSummary
    # (additionalProperties:false). A summary that smuggled in the geometry hash would fail that
    # read-time check, so the ledger must not emit it.
    assert "structureHash" not in record["latestFrame"]
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": OPTIMIZATION_REPLAY_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/frameSummary",
    }
    assert not list(Draft202012Validator(schema).iter_errors(record["latestFrame"]))


def test_catalog_reports_a_run_with_no_terminal_as_still_running(
    runtime: StudioAgentRuntime,
) -> None:
    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]

    assert record["outcome"] == "running"


def test_catalog_reports_the_outcome_the_terminal_recorded(runtime: StudioAgentRuntime) -> None:
    runtime(
        "optimization.close_run",
        {
            "terminal": {
                "type": "controlled_calculation_terminal",
                "runId": RUN_ID,
                "status": "cancelled",
                "frameCount": 2,
                "reason": "stopped by the researcher",
                "terminatedAt": "2026-07-28T00:05:00Z",
                "extensions": {},
            }
        },
    )

    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]
    assert record["outcome"] == "cancelled"
    assert record["message"] == "stopped by the researcher"


def test_catalog_leaves_main_owned_state_to_main(runtime: StudioAgentRuntime) -> None:
    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]

    # active/recovered describe what main is doing now, not what was recorded.
    for key in ("active", "recovered"):
        assert key not in record


def test_a_run_without_a_recorded_input_cannot_be_replayed(runtime: StudioAgentRuntime) -> None:
    # The fixture opens its run without input hashes, so its frames have nothing to replay against.
    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]

    assert record["frameCount"] == 2
    assert record["replayable"] is False


def test_a_run_with_a_recorded_input_and_frames_is_replayable(tmp_path: Path) -> None:
    project = tmp_path / "Replayable.cmsproj"
    project.mkdir()
    runtime = StudioAgentRuntime(tmp_path / "sessions", project)
    runtime(
        "optimization.open_run",
            _open_request(),
    )
    runtime("optimization.append_run_frame", {"frame": _frame(0)})

    record = runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})["runs"][0]
    assert record["replayable"] is True


def test_timeline_pages_the_frames(runtime: StudioAgentRuntime) -> None:
    result = runtime(
        "optimization.replay_timeline", {"runId": RUN_ID, "offset": 1, "limit": 10}
    )

    assert result["totalFrames"] == 2
    assert [frame["stepIndex"] for frame in result["frames"]] == [1]
    assert "positions" not in result["frames"][0]
    assert "atomIds" not in result["frames"][0]


def test_timeline_frames_conform_to_the_coordinate_free_contract(
    runtime: StudioAgentRuntime,
) -> None:
    result = runtime(
        "optimization.replay_timeline", {"runId": RUN_ID, "offset": 0, "limit": 10}
    )
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": OPTIMIZATION_REPLAY_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/timelineResponse",
    }

    assert not list(Draft202012Validator(schema).iter_errors(result))


def test_frame_returns_the_step_that_was_asked_for(runtime: StudioAgentRuntime) -> None:
    result = runtime("optimization.replay_frame", {"runId": RUN_ID, "stepIndex": 1})

    assert result["frame"]["frameIndex"] == 1
    # What comes back is the recorded frame, not a re-derived one.
    assert result["frame"]["provenance"]["coordinateSource"] == "engine"
    # The host completes the viewer state from this count, so it must be the ledger's truth.
    assert result["frameCount"] == 2


def test_frame_response_conforms_to_the_full_frame_contract(
    runtime: StudioAgentRuntime,
) -> None:
    result = runtime("optimization.replay_frame", {"runId": RUN_ID, "stepIndex": 1})
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": OPTIMIZATION_REPLAY_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/frameResponse",
    }

    assert not list(Draft202012Validator(schema).iter_errors(result))


def test_a_step_past_the_end_is_not_found(runtime: StudioAgentRuntime) -> None:
    with pytest.raises(RpcFault) as caught:
        runtime("optimization.replay_frame", {"runId": RUN_ID, "stepIndex": 9})

    assert caught.value.data == {"studioCode": "RUN_NOT_FOUND"}


def test_an_unknown_run_is_not_found(runtime: StudioAgentRuntime) -> None:
    with pytest.raises(RpcFault) as caught:
        runtime("optimization.replay_timeline", {"runId": "run-absent", "offset": 0, "limit": 10})

    assert caught.value.data == {"studioCode": "RUN_NOT_FOUND"}


def test_a_malformed_query_is_refused(runtime: StudioAgentRuntime) -> None:
    with pytest.raises(RpcFault) as caught:
        runtime("optimization.replay_timeline", {"runId": RUN_ID, "offset": -1, "limit": 10})

    assert caught.value.data == {"studioCode": "SCHEMA_INVALID"}


def test_a_cursor_that_does_not_exist_is_refused(runtime: StudioAgentRuntime) -> None:
    with pytest.raises(RpcFault):
        runtime("optimization.replay_catalog", {"afterRunId": "run-absent", "limit": 20})


def test_trajectory_methods_need_an_open_project(tmp_path: Path) -> None:
    # A sidecar can start before a project is open; it serves everything else and refuses these.
    runtime = StudioAgentRuntime(tmp_path / "sessions")

    with pytest.raises(RpcFault, match="No project is open"):
        runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})


def test_unknown_methods_are_still_unknown(runtime: StudioAgentRuntime) -> None:
    with pytest.raises(RpcFault, match="Method not found"):
        runtime("optimization.invented", {})


class TestWritePath:
    """Ledger-only: the run-lifecycle gating the Qt handler also did stays in main."""

    def test_opens_a_run_and_reads_it_back(self, tmp_path: Path) -> None:
        project = tmp_path / "New.cmsproj"
        project.mkdir()
        runtime = StudioAgentRuntime(tmp_path / "sessions", project)

        opened = runtime(
            "optimization.open_run",
            _open_request(),
        )

        assert opened["runId"] == RUN_ID
        assert runtime("optimization.replay_catalog", {"afterRunId": None, "limit": 20})[
            "totalRuns"
        ] == 1

    def test_appends_a_frame_and_reports_where_it_landed(self, tmp_path: Path) -> None:
        project = tmp_path / "New.cmsproj"
        project.mkdir()
        runtime = StudioAgentRuntime(tmp_path / "sessions", project)
        runtime(
            "optimization.open_run",
            _open_request(),
        )

        result = runtime("optimization.append_run_frame", {"frame": _frame(0)})

        assert result == {
            "accepted": True,
            "runId": RUN_ID,
            "frameIndex": 0,
            "extensions": {},
        }

    def test_refuses_an_interpolated_frame_over_rpc(self, runtime: StudioAgentRuntime) -> None:
        forged = _frame(
            2,
            provenance={
                "coordinateSource": "interpolated",
                "atomOrder": "document_stable_id_order",
                "transformation": "none",
            },
        )

        # The invariant holds at the process boundary, not only inside the store.
        with pytest.raises(RpcFault) as caught:
            runtime("optimization.append_run_frame", {"frame": forged})
        assert caught.value.data == {"studioCode": "SCHEMA_INVALID"}

    def test_closes_a_run_with_the_count_it_recorded(self, runtime: StudioAgentRuntime) -> None:
        result = runtime(
            "optimization.close_run",
            {
                "terminal": {
                    "type": "controlled_calculation_terminal",
                    "runId": RUN_ID,
                    "status": "completed",
                    "frameCount": 2,
                    "outputGeometryHash": _frame(1)["structureHash"],
                    "completedAt": "2026-07-28T00:05:00Z",
                    "extensions": {},
                }
            },
        )

        assert result["outcome"] == "awaiting_final_geometry"

    def test_refuses_a_terminal_that_miscounts(self, runtime: StudioAgentRuntime) -> None:
        with pytest.raises(RpcFault) as caught:
            runtime(
                "optimization.close_run",
                {
                    "terminal": {
                        "type": "controlled_calculation_terminal",
                        "runId": RUN_ID,
                        "status": "completed",
                        "frameCount": 99,
                        "extensions": {},
                    }
                },
            )
        assert caught.value.data == {"studioCode": "SCHEMA_INVALID"}

    def test_records_and_recovers_the_closed_final_event_union(
        self, runtime: StudioAgentRuntime
    ) -> None:
        geometry_hash = _frame(1)["structureHash"]
        runtime(
            "optimization.close_run",
            {
                "terminal": {
                    "type": "controlled_calculation_terminal",
                    "runId": RUN_ID,
                    "status": "completed",
                    "frameCount": 2,
                    "outputGeometryHash": geometry_hash,
                    "completedAt": "2026-07-28T00:05:00Z",
                    "extensions": {},
                }
            },
        )
        requested = {
            "type": "optimization_final_accept_requested",
            "runId": RUN_ID,
            "expectedRevision": 2,
            "geometryHash": geometry_hash,
            "timestamp": "2026-07-28T00:06:00Z",
        }

        assert runtime(
            "optimization.record_final_event", {"event": requested}
        ) == {"accepted": True, "event": requested, "extensions": {}}
        state = runtime("optimization.run_state", {"runId": RUN_ID})

        assert state["outcome"] == "awaiting_final_geometry"
        assert state["frameCount"] == 2
        assert state["latestFrame"]["structureHash"] == geometry_hash
        assert state["terminal"]["outputGeometryHash"] == geometry_hash
        assert state["latestFinalEvent"] == requested
