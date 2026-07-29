"""Pinned ChemSmart AgentSession adapter for Studio molecule tools."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, is_dataclass, replace
from enum import Enum
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
from time import perf_counter
from typing import Any, Iterator, Literal
from uuid import uuid4

from chemsmart.agent import CommandSynthesisSession
from chemsmart.agent.core import AgentSession
from chemsmart.agent.harness.workflow_state import workflow_state_scope
from chemsmart.agent.permissions import (
    ApprovalDecision,
    PermissionMode,
    PermissionPolicy,
    ResolvedDecision,
    ResolvedPermission,
)
from chemsmart.agent.provider_adapter import ToolRequest
from chemsmart.agent.public_visibility import sanitize_public_text
from chemsmart.agent.registry import ToolRegistry, build_tool_spec
from chemsmart.agent.runtime import TaskPhase
from chemsmart.agent.runtime.calculations import (
    inspect_calculation as inspect_agent_calculation,
)
from chemsmart.agent.runtime.tool_catalog import PhaseToolProfile
from chemsmart.agent.studio import (
    StudioCapability,
    StudioToolAdapters,
    build_studio_tool_specs,
)
from chemsmart.agent.services.result_codec import json_safe as agent_json_safe
from chemsmart.agent.tool_protocol import RuntimeToolMetadata
from jsonschema import Draft202012Validator
from pydantic import BaseModel

from .command_inspection import CommandInspectionAdapter
from .project_workspace import (
    critic_project,
    list_projects,
    read_project,
    validate_project,
)
from .generated_protocol import (
    COMMAND_SYNTHESIS_RUNTIME_SCHEMA,
    CONTROLLED_CALCULATION_RUNTIME_SCHEMA,
    PROJECT_WORKSPACE_RUNTIME_SCHEMA,
    OPTIMIZATION_TRAJECTORY_RUNTIME_SCHEMA,
    STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA,
    STUDIO_AGENT_MOLECULE_REQUEST_RUNTIME_SCHEMA,
    STUDIO_AGENT_TOOL_INPUT_SCHEMAS,
    STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA,
    STUDIO_CONTROL_RUNTIME_SCHEMA,
)
from .molecule_import import import_molecule
from .rpc import JsonRpcPeer, RpcFault
from .studio_ui import StudioUiEventEmitter
from .trajectory_store import (
    LedgerError,
    RunNotFound,
    append_frame,
    append_final_event,
    finish_run,
    list_run_ids,
    parse_ledger,
    start_run,
)

SAFE_STUDIO_TOOLS = {
    "list_workspace",
    "read_behavior_rules",
    "synthesize_command",
    "repair_command",
    "read_project_yaml",
    "extract_project_protocol",
    "validate_project_yaml",
    "critic_project_yaml",
    "search_basis_sets",
    "get_molecule_snapshot",
    "preview_molecule_patch",
    "commit_molecule_preview",
    "discard_molecule_preview",
    "report_studio_result",
    "get_studio_context",
    "analyze_current_molecule",
    "prepare_molecule_optimization",
    "validate_prepared_optimization",
    "get_optimization_status",
    "list_calculation_artifacts",
    "read_calculation_artifact",
    "get_optimization_replay",
    "compare_optimization_frames",
    "recommend_method",
    "inspect_calculation",
}
ALWAYS_STUDIO_APPROVAL = {
    "start_molecule_optimization",
    "cancel_molecule_optimization",
    "accept_optimization_geometry",
    "reject_optimization_geometry",
    "start_prepared_optimization",
    "import_completed_calculation",
    "run_local",
    "submit_hpc",
    "execute_chemsmart_command",
}
_STUDIO_HANDLER_APPROVAL = {
    "start_prepared_optimization",
    "import_completed_calculation",
}
#: Frame fields that make up a `frameSummary` — everything a caller needs to describe a step
#: without carrying its coordinates.
_FRAME_SUMMARY_KEYS = (
    "runId",
    "stepIndex",
    "energy",
    "forceMetrics",
    "gradientNorm",
    "convergence",
    "timestamp",
)


def _frame_summary(frame: dict[str, Any]) -> dict[str, Any]:
    summary = {key: frame[key] for key in _FRAME_SUMMARY_KEYS if key in frame}
    # The ledger indexes frames by frameIndex; the public summary calls the same number stepIndex.
    summary.setdefault("stepIndex", frame.get("frameIndex"))
    return summary


def _catalog_record(project_root: Path, run_id: str) -> dict[str, Any]:
    """What the ledger alone can say about a run.

    Deliberately partial. A full `replayRecord` also carries `active`, `recovered` and `replayable`,
    which describe what main is doing right now rather than what was recorded — whether this is the
    run in progress, whether it was recovered after a crash. Main composes those onto this; the
    ledger has no way to know them and should not guess.

    `outcome` needs the same treatment in one case: a ledger with no terminal reads as `running`
    here, but a run that is not the active one was in fact interrupted. Only main knows which is
    active, so only main can make that distinction.
    """
    ledger = parse_ledger(project_root, run_id)
    latest = ledger.frames[-1] if ledger.frames else None
    return {
        "run": ledger.run,
        "frameCount": ledger.frame_count,
        "latestFrame": _frame_summary(latest) if latest else None,
        "outcome": ledger.outcome,
        "message": ledger.message,
        "updatedAt": ledger.updated_at,
        # Both halves are ledger facts: a run with no recorded input geometry has nothing to replay
        # its frames against, and one with no frames has nothing to show.
        "replayable": ledger.has_input_snapshot and ledger.frame_count > 0,
        "extensions": {},
    }


def _replay_catalog(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    """Runs newest first, paged by an opaque cursor rather than an offset.

    A cursor survives a run finishing mid-scroll; an index would silently shift the page.
    """
    after_run_id = params.get("afterRunId")
    limit = params.get("limit", 20)
    if not isinstance(limit, int) or not 1 <= limit <= 100:
        raise LedgerError("Optimization replay catalog query is invalid")
    run_ids = list_run_ids(project_root)
    start = 0
    if after_run_id is not None:
        if after_run_id not in run_ids:
            raise RunNotFound("Optimization replay cursor was not found")
        start = run_ids.index(after_run_id) + 1
    page = run_ids[start : start + limit]
    runs = [_catalog_record(project_root, run_id) for run_id in page]
    return {
        "totalRuns": len(run_ids),
        "runs": runs,
        "nextRunId": page[-1] if page and start + limit < len(run_ids) else None,
        "extensions": {},
    }


def _replay_timeline(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    run_id = params.get("runId")
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    if (
        not isinstance(run_id, str)
        or not isinstance(offset, int)
        or not isinstance(limit, int)
    ):
        raise LedgerError("Optimization replay timeline query is invalid")
    if offset < 0 or not 1 <= limit <= 500:
        raise LedgerError("Optimization replay timeline query is invalid")
    ledger = parse_ledger(project_root, run_id)
    return {
        "runId": run_id,
        "offset": offset,
        "limit": limit,
        "totalFrames": ledger.frame_count,
        "frames": [
            _frame_summary(frame) for frame in ledger.frames[offset : offset + limit]
        ],
        "extensions": {},
    }


def _replay_frame(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    run_id = params.get("runId")
    step_index = params.get("stepIndex")
    if not isinstance(run_id, str) or not isinstance(step_index, int) or step_index < 0:
        raise LedgerError("Optimization replay frame query is invalid")
    ledger = parse_ledger(project_root, run_id)
    if step_index >= ledger.frame_count:
        raise RunNotFound("Optimization replay frame was not found")
    return {
        "runId": run_id,
        "frame": ledger.frames[step_index],
        "frameCount": ledger.frame_count,
        "extensions": {},
    }


def _open_run(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    """Opens a ledger for a run main has already authorized.

    Deliberately ledger-only. The Qt handler this replaces also locked the revision, refused to
    start beside a preview or a replay, enforced one active run, and disabled the mutation tools —
    all of which are molecule-authority and interface concerns that stay in main. Moving them here
    would put the gating that stops a researcher editing geometry mid-run inside the sidecar.
    """
    run = params.get("run")
    timestamp = params.get("timestamp")
    if not isinstance(run, dict) or not isinstance(timestamp, str):
        raise LedgerError("External optimization reservation is invalid")
    hashes = {
        key: value
        for key, value in params.items()
        if key in ("inputSnapshotHash", "inputTopologyHash") and isinstance(value, str)
    }
    start_run(project_root, run, timestamp=timestamp, **hashes)
    return {"runId": run["runId"], "extensions": {}}


def _append_run_frame(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    frame = params.get("frame")
    if not isinstance(frame, dict):
        raise LedgerError("External optimization frame is invalid")
    run_id = frame.get("runId")
    if not isinstance(run_id, str):
        raise LedgerError("External optimization frame is missing its run")
    append_frame(project_root, run_id, frame)
    return {
        "accepted": True,
        "runId": run_id,
        "frameIndex": frame["frameIndex"],
        "extensions": {},
    }


def _close_run(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    terminal = params.get("terminal")
    if not isinstance(terminal, dict):
        raise LedgerError("External optimization terminal is invalid")
    run_id = terminal.get("runId")
    if not isinstance(run_id, str):
        raise LedgerError("External optimization terminal is missing its run")
    finish_run(project_root, run_id, terminal)
    outcome = (
        "awaiting_final_geometry"
        if terminal.get("status") == "completed"
        else terminal.get("status")
    )
    return {"runId": run_id, "outcome": outcome, "extensions": {}}


def _record_final_event(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    event = params.get("event")
    if not isinstance(event, dict) or not isinstance(event.get("runId"), str):
        raise LedgerError("Optimization final decision event is invalid")
    append_final_event(project_root, event["runId"], event)
    return {"accepted": True, "event": event, "extensions": {}}


def _run_state(project_root: Path, params: dict[str, Any]) -> dict[str, Any]:
    run_id = params.get("runId")
    if not isinstance(run_id, str):
        raise LedgerError("Optimization run state request is invalid")
    ledger = parse_ledger(project_root, run_id)
    return {
        "run": ledger.run,
        "frameCount": ledger.frame_count,
        "latestFrame": ledger.frames[-1] if ledger.frames else None,
        "terminal": ledger.terminal,
        "outcome": ledger.outcome,
        "latestFinalEvent": ledger.final_events[-1] if ledger.final_events else None,
        "extensions": {},
    }


_TRAJECTORY_METHODS = {
    "optimization.replay_catalog": _replay_catalog,
    "optimization.replay_timeline": _replay_timeline,
    "optimization.replay_frame": _replay_frame,
    "optimization.open_run": _open_run,
    "optimization.append_run_frame": _append_run_frame,
    "optimization.close_run": _close_run,
    "optimization.record_final_event": _record_final_event,
    "optimization.run_state": _run_state,
}
_TRAJECTORY_SCHEMA_DEFINITIONS = {
    "optimization.open_run": ("openRunRequest", "openRunResponse"),
    "optimization.append_run_frame": ("appendFrameRequest", "appendFrameResponse"),
    "optimization.close_run": ("closeRunRequest", "closeRunResponse"),
    "optimization.record_final_event": (
        "recordFinalEventRequest",
        "recordFinalEventResponse",
    ),
    "optimization.run_state": ("runStateRequest", "runStateResponse"),
}
_TRAJECTORY_VALIDATORS = {
    method: (
        Draft202012Validator(
            {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "$defs": OPTIMIZATION_TRAJECTORY_RUNTIME_SCHEMA["$defs"],
                "$ref": f"#/$defs/{definitions[0]}",
            }
        ),
        Draft202012Validator(
            {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "$defs": OPTIMIZATION_TRAJECTORY_RUNTIME_SCHEMA["$defs"],
                "$ref": f"#/$defs/{definitions[1]}",
            }
        ),
    )
    for method, definitions in _TRAJECTORY_SCHEMA_DEFINITIONS.items()
}
_PROJECT_METHODS = {
    "project.list": lambda _params: list_projects(),
    "project.read": read_project,
    "project.validate": validate_project,
    "project.critic": critic_project,
}
_PROJECT_SCHEMA_DEFINITIONS = {
    "project.list": ("listRequest", "listResult"),
    "project.read": ("readRequest", "readResult"),
    "project.validate": ("validateRequest", "validateResult"),
    "project.critic": ("critiqueRequest", "critiqueResult"),
}
_AGENT_SESSION_BINDING_NAME = "agent-session.json"
_CHEMSMART_SESSION_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")
_STUDIO_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_OPERATION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_BINDING_LIMIT_BYTES = 1024
_DIRECTORY_OPEN_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class _StudioPermissionPolicy(PermissionPolicy):
    """Route every Studio mutation or execution through main's trusted decision surface."""

    def resolve(self, request: ToolRequest) -> ResolvedPermission:
        if request.name in ALWAYS_STUDIO_APPROVAL:
            return ResolvedPermission(
                decision=ResolvedDecision.NEEDS_USER,
                reason="studio_always_ask",
            )
        return super().resolve(request)


def studio_permission_policy() -> PermissionPolicy:
    """Studio pins execution policy in code.

    `CHEMSMART.md` shapes prose only. Its `## Policy` section and the `xtb_real_runs` environment
    variable must never be able to widen what may run, because in Studio that decision belongs to the
    trusted approval gates rather than to a file the model can read.
    """
    return _StudioPermissionPolicy(
        mode=PermissionMode.PERMISSION,
        prompt_risky=True,
        session_allow=set(SAFE_STUDIO_TOOLS),
        xtb_real_runs="ask",
    )


"""
Tools that never appear in any Studio phase.

Project writers stay on deterministic typed IPC surfaces rather than putting a model into that path.
Generic filesystem reads and network or scheduler inspection are withheld until Studio has a bounded,
path-free contract for them. The three deliberately exposed execution tools are not in this set: they
are classified separately as always-ask and receive exact one-shot approval cards.
"""
STUDIO_WITHHELD_TOOLS = frozenset(
    {
        "save_geometry",
        "emit_studio_ui_update",
        "ssh_probe",
        "scheduler_query",
        "log_tail",
        "read",
        "render_project_yaml",
        "update_project_yaml",
        "write_behavior_rules",
        "write_project_yaml",
        "wizard_write",
    }
)
"""
Direct tools per phase, ten at most — the harness caps a phase's menu so routing stays reliable, and only
direct tools are offered to the model at all.

Studio therefore spends those slots on what the model must decide, and leaves the rest of the harness to the
researcher through typed IPC: the project workspace and the command console call `read_project_yaml`,
`render_project_yaml`, `validate_project_yaml`, `critic_project_yaml`, `extract_project_protocol` and
`search_basis_sets` deterministically, with no model in the loop.
"""
_STUDIO_PHASE_TOOLS = {
    TaskPhase.ROUTE: (
        "get_studio_context",
        "get_molecule_snapshot",
        "analyze_current_molecule",
        "read_project_yaml",
        "report_studio_result",
    ),
    TaskPhase.PROJECT: (
        "analyze_current_molecule",
        "preview_molecule_patch",
        "read_project_yaml",
        "validate_project_yaml",
        "critic_project_yaml",
        "report_studio_result",
    ),
    TaskPhase.PROJECT_READ: (
        "get_molecule_snapshot",
        "analyze_current_molecule",
        "get_optimization_status",
        "list_calculation_artifacts",
        "read_project_yaml",
        "report_studio_result",
    ),
    TaskPhase.PROJECT_WRITE: (
        "commit_molecule_preview",
        "accept_optimization_geometry",
        "reject_optimization_geometry",
        "import_completed_calculation",
        "report_studio_result",
    ),
    TaskPhase.SYNTHESIS: (
        "analyze_current_molecule",
        "preview_molecule_patch",
        "commit_molecule_preview",
        "prepare_molecule_optimization",
        "validate_prepared_optimization",
        "synthesize_command",
        "recommend_method",
        "report_studio_result",
    ),
    TaskPhase.VALIDATION: (
        "analyze_current_molecule",
        "validate_prepared_optimization",
        "get_optimization_status",
        "get_optimization_replay",
        "validate_project_yaml",
        "report_studio_result",
    ),
    TaskPhase.REPAIR: (
        "analyze_current_molecule",
        "prepare_molecule_optimization",
        "validate_prepared_optimization",
        "commit_molecule_preview",
        "discard_molecule_preview",
        "repair_command",
        "report_studio_result",
    ),
    TaskPhase.EXECUTION: (
        "start_prepared_optimization",
        "get_optimization_status",
        "get_optimization_replay",
        "cancel_molecule_optimization",
        "run_local",
        "submit_hpc",
        "execute_chemsmart_command",
        "report_studio_result",
    ),
    TaskPhase.DIAGNOSTICS: (
        "get_optimization_status",
        "list_calculation_artifacts",
        "read_calculation_artifact",
        "get_optimization_replay",
        "compare_optimization_frames",
        "inspect_calculation",
        "report_studio_result",
    ),
}
_STUDIO_SPECIALIST_TOOLS = (
    "analyze_current_molecule",
    "prepare_molecule_optimization",
    "validate_prepared_optimization",
    "synthesize_command",
    "repair_command",
    "report_studio_result",
)
_STUDIO_INSPECT_TOOLS = frozenset(
    {
        "get_studio_context",
        "get_molecule_snapshot",
        "analyze_current_molecule",
        "get_optimization_status",
        "list_calculation_artifacts",
        "read_calculation_artifact",
        "get_optimization_replay",
        "compare_optimization_frames",
        "inspect_calculation",
        "recommend_method",
        "report_studio_result",
    }
)
_STUDIO_PLAN_TOOLS = _STUDIO_INSPECT_TOOLS | {
    "prepare_molecule_optimization",
    "validate_prepared_optimization",
    "preview_molecule_patch",
    "discard_molecule_preview",
    "synthesize_command",
    "repair_command",
    "read_project_yaml",
    "validate_project_yaml",
    "critic_project_yaml",
}
_STUDIO_INSPECT_DIRECT = (
    "get_studio_context",
    "analyze_current_molecule",
    "get_optimization_status",
    "get_optimization_replay",
    "list_calculation_artifacts",
    "inspect_calculation",
    "recommend_method",
    "report_studio_result",
)
_STUDIO_ACT_DIRECT = (
    "get_studio_context",
    "analyze_current_molecule",
    "start_prepared_optimization",
    "get_optimization_status",
    "report_studio_result",
)
_STUDIO_COMPOSER_INTENTS = frozenset(
    {"inspect", "plan", "dry_run", "run", "review", "history", "new", "context"}
)
_STUDIO_DRY_RUN_TOOLS = (
    "get_studio_context",
    "analyze_current_molecule",
    "recommend_method",
    "synthesize_command",
    "repair_command",
    "report_studio_result",
)
_STUDIO_RUN_TOOLS = (
    "get_studio_context",
    "analyze_current_molecule",
    "recommend_method",
    "synthesize_command",
    "repair_command",
    "execute_chemsmart_command",
    "report_studio_result",
)


def _studio_agent_tool_profile(
    capability: StudioCapability,
    intent_kind: str | None = None,
) -> PhaseToolProfile:
    if intent_kind == "dry_run":
        return PhaseToolProfile(
            {phase: _STUDIO_DRY_RUN_TOOLS for phase in _STUDIO_PHASE_TOOLS},
            specialist_tools=(
                "recommend_method",
                "synthesize_command",
                "repair_command",
                "report_studio_result",
            ),
        )
    if intent_kind == "run":
        return PhaseToolProfile(
            {phase: _STUDIO_RUN_TOOLS for phase in _STUDIO_PHASE_TOOLS},
            specialist_tools=(
                "recommend_method",
                "synthesize_command",
                "repair_command",
                "execute_chemsmart_command",
                "report_studio_result",
            ),
        )
    if capability is StudioCapability.INSPECT:
        phase_tools = {phase: _STUDIO_INSPECT_DIRECT for phase in _STUDIO_PHASE_TOOLS}
    elif capability is StudioCapability.PLAN:
        phase_tools = {}
        for phase, tools in _STUDIO_PHASE_TOOLS.items():
            base = (
                "get_studio_context",
                "analyze_current_molecule",
            )
            additions = tuple(
                tool
                for tool in tools
                if tool in _STUDIO_PLAN_TOOLS
                and tool not in base
                and tool != "report_studio_result"
            )
            phase_tools[phase] = (
                *base,
                *additions[: 10 - len(base) - 1],
                "report_studio_result",
            )
    else:
        phase_tools = {}
        for phase, tools in _STUDIO_PHASE_TOOLS.items():
            actions = tuple(tool for tool in tools if tool not in _STUDIO_ACT_DIRECT)
            phase_tools[phase] = (
                *_STUDIO_ACT_DIRECT[:-1],
                *actions[: 10 - len(_STUDIO_ACT_DIRECT)],
                _STUDIO_ACT_DIRECT[-1],
            )
    allowed = frozenset(tool for tools in phase_tools.values() for tool in tools)
    return PhaseToolProfile(
        phase_tools,
        specialist_tools=tuple(
            tool for tool in _STUDIO_SPECIALIST_TOOLS if tool in allowed
        ),
    )


# Compatibility export for deterministic harnesses that exercise the complete act surface.
# Runtime Agent turns select a narrower profile from their main-issued capability.
STUDIO_AGENT_TOOL_PROFILE = _studio_agent_tool_profile(StudioCapability.ACT)


_REPORT_STUDIO_RESULT_INPUT_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$defs": STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA["$defs"],
    **STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA["$defs"]["reportStudioResultInput"],
}
_STUDIO_TOOL_INPUT_SCHEMAS = {
    **STUDIO_AGENT_TOOL_INPUT_SCHEMAS,
    "report_studio_result": _REPORT_STUDIO_RESULT_INPUT_SCHEMA,
}


def _definition_validator(
    runtime_schema: dict[str, Any],
    definition: str,
) -> Draft202012Validator:
    return Draft202012Validator(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": runtime_schema["$defs"],
            "$ref": f"#/$defs/{definition}",
        }
    )


_PROJECT_REQUEST_VALIDATORS = {
    method: _definition_validator(PROJECT_WORKSPACE_RUNTIME_SCHEMA, request)
    for method, (request, _result) in _PROJECT_SCHEMA_DEFINITIONS.items()
}
_PROJECT_RESULT_VALIDATORS = {
    method: _definition_validator(PROJECT_WORKSPACE_RUNTIME_SCHEMA, result)
    for method, (_request, result) in _PROJECT_SCHEMA_DEFINITIONS.items()
}
_COMMAND_SYNTHESIS_REQUEST_VALIDATOR = _definition_validator(
    COMMAND_SYNTHESIS_RUNTIME_SCHEMA,
    "request",
)
_COMMAND_SYNTHESIS_RESULT_VALIDATOR = _definition_validator(
    COMMAND_SYNTHESIS_RUNTIME_SCHEMA,
    "result",
)
_MATERIALIZE_MOLECULE_INPUT_REQUEST_VALIDATOR = _definition_validator(
    STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA,
    "materializeMoleculeInputRequest",
)
_MATERIALIZED_MOLECULE_INPUT_VALIDATOR = _definition_validator(
    STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA,
    "materializedMoleculeInput",
)
_CALCULATION_START_PROPERTIES = STUDIO_CONTROL_RUNTIME_SCHEMA["$defs"][
    "calculationStartApproval"
]["properties"]
_CALCULATION_START_VALIDATORS = {
    field: Draft202012Validator(_CALCULATION_START_PROPERTIES[field])
    for field in ("engine", "method", "settings")
}
_MOLECULE_REQUEST_VALIDATOR = Draft202012Validator(
    STUDIO_AGENT_MOLECULE_REQUEST_RUNTIME_SCHEMA
)
_CONTROLLED_CALCULATION_HOST_REQUEST_VALIDATOR = Draft202012Validator(
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": CONTROLLED_CALCULATION_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/hostRequest",
    }
)
_CONTROLLED_CALCULATION_HOST_RESPONSE_VALIDATOR = Draft202012Validator(
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": CONTROLLED_CALCULATION_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/hostResponse",
    }
)
_CONTROLLED_CALCULATION_RESULT_DEFINITIONS = {
    "get_studio_context": "studioContext",
    "analyze_current_molecule": "currentMoleculeAnalysis",
    "prepare_molecule_optimization": "preparedPlan",
    "validate_prepared_optimization": "preparedPlan",
    "start_prepared_optimization": "reservation",
    "get_optimization_status": "controlledCalculationStatus",
    "list_calculation_artifacts": "artifactList",
    "read_calculation_artifact": "artifactChunk",
    "get_optimization_replay": "controlledCalculationReplay",
    "compare_optimization_frames": "frameComparison",
    "import_completed_calculation": "importResult",
}
_CONTROLLED_CALCULATION_RESULT_VALIDATORS = {
    tool: Draft202012Validator(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": CONTROLLED_CALCULATION_RUNTIME_SCHEMA["$defs"],
            "$ref": f"#/$defs/{definition}",
        }
    )
    for tool, definition in _CONTROLLED_CALCULATION_RESULT_DEFINITIONS.items()
}
_STUDIO_TOOL_INPUT_VALIDATORS = {
    tool: Draft202012Validator(schema)
    for tool, schema in STUDIO_AGENT_TOOL_INPUT_SCHEMAS.items()
}
_STUDIO_EXECUTION_APPROVAL_DEFINITIONS = {
    "run_local": "runLocal",
    "submit_hpc": "submitHpc",
    "execute_chemsmart_command": "executeChemsmartCommand",
}
_STUDIO_EXECUTION_INPUT_SCHEMAS = {
    tool: deepcopy(
        STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA["$defs"][definition]["properties"][
            "arguments"
        ]
    )
    for tool, definition in _STUDIO_EXECUTION_APPROVAL_DEFINITIONS.items()
}
_STUDIO_EXECUTION_INPUT_SCHEMAS["execute_chemsmart_command"]["properties"][
    "command"
] = deepcopy(
    STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA["$defs"][
        "bundled_command_synthesis_schema_json"
    ]["$defs"]["command"]
)
_STUDIO_COMMIT_INPUT_SCHEMA = deepcopy(
    STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA["$defs"]["commitMoleculePreview"][
        "properties"
    ]["arguments"]
)
_STUDIO_COMMIT_INPUT_SCHEMA["properties"]["expected_revision"] = deepcopy(
    STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA["$defs"]["bundled_common_schema_json"][
        "$defs"
    ]["revision"]
)
_STUDIO_COMMIT_INPUT_SCHEMA["properties"]["preview_id"] = deepcopy(
    STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA["$defs"]["bundled_common_schema_json"][
        "$defs"
    ]["stableId"]
)
_STUDIO_APPROVAL_ARGUMENT_VALIDATORS = {
    tool: Draft202012Validator(schema)
    for tool, schema in _STUDIO_EXECUTION_INPUT_SCHEMAS.items()
}


class _StudioRpcAdapter:
    def __init__(self, runtime: "StudioAgentRuntime", session_id: str) -> None:
        self._runtime = runtime
        self._session_id = session_id

    def _request(self, tool: str, arguments: dict[str, Any]) -> Any:
        return self._runtime._controlled_calculation_request(
            self._session_id,
            tool,
            arguments,
        )

    def get_studio_context(self, arguments: dict[str, Any]) -> Any:
        return self._request("get_studio_context", arguments)

    def analyze_current_molecule(self, arguments: dict[str, Any]) -> Any:
        return self._request("analyze_current_molecule", arguments)

    def report_studio_result(self, arguments: dict[str, Any]) -> Any:
        return self._runtime._report_studio_result(
            self._session_id,
            arguments,
        )

    def prepare_molecule_optimization(self, arguments: dict[str, Any]) -> Any:
        return self._request("prepare_molecule_optimization", arguments)

    def validate_prepared_optimization(self, arguments: dict[str, Any]) -> Any:
        return self._request("validate_prepared_optimization", arguments)

    def start_prepared_optimization(self, arguments: dict[str, Any]) -> Any:
        return self._request("start_prepared_optimization", arguments)

    def get_optimization_status(self, arguments: dict[str, Any]) -> Any:
        return self._request("get_optimization_status", arguments)

    def list_calculation_artifacts(self, arguments: dict[str, Any]) -> Any:
        return self._request("list_calculation_artifacts", arguments)

    def read_calculation_artifact(self, arguments: dict[str, Any]) -> Any:
        return self._request("read_calculation_artifact", arguments)

    def get_optimization_replay(self, arguments: dict[str, Any]) -> Any:
        return self._request("get_optimization_replay", arguments)

    def compare_optimization_frames(self, arguments: dict[str, Any]) -> Any:
        return self._request("compare_optimization_frames", arguments)

    def import_completed_calculation(self, arguments: dict[str, Any]) -> Any:
        return self._request("import_completed_calculation", arguments)


class _StudioApprovalGrantAdapter:
    def __init__(self, runtime: "StudioAgentRuntime", session_id: str) -> None:
        self._runtime = runtime
        self._session_id = session_id

    def require_approval(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> None:
        normalized = dict(arguments)
        if tool_name == "execute_chemsmart_command":
            normalized.setdefault("test", False)
            normalized.setdefault("timeout_s", 3600)
        self._runtime._consume_studio_grant(
            self._session_id,
            tool_name,
            normalized,
        )


def _agent_wire_value(value: Any) -> Any:
    """Project AgentSession results into JSON values at the sidecar boundary."""
    if isinstance(value, BaseModel):
        return _agent_wire_value(value.model_dump(mode="json"))
    if is_dataclass(value) and not isinstance(value, type):
        return _agent_wire_value(asdict(value))
    if isinstance(value, dict):
        return {str(key): _agent_wire_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_agent_wire_value(item) for item in value]
    if isinstance(value, Enum):
        return _agent_wire_value(value.value)
    return agent_json_safe(value)


_TRACE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,127}$")


def _safe_public_keys(value: Any) -> list[str]:
    """Return only schema-like field names, never argument or result values."""

    if not isinstance(value, dict):
        return []
    keys: list[str] = []
    for key in sorted(str(item) for item in value):
        if _TRACE_KEY.fullmatch(key) and key not in keys:
            keys.append(key)
        if len(keys) == 64:
            break
    return keys


def _public_agent_result(value: Any) -> dict[str, Any]:
    """Remove sidecar-owned filesystem coordinates from a turn result."""

    result = _agent_wire_value(value)
    if not isinstance(result, dict):
        raise RpcFault(-32603, "AgentSession returned a non-object result")
    result.pop("session_dir", None)
    runtime = result.get("runtime_v2")
    if isinstance(runtime, dict):
        result["runtime_v2"] = {
            key: runtime[key]
            for key in (
                "mode",
                "phase",
                "exposed_tools",
                "shadow_violations",
            )
            if key in runtime
        }
    return result


def _path_free_calculation_result(value: Any) -> Any:
    """Project calculation inspection into the path-free Studio model surface."""

    if isinstance(value, dict):
        return {
            str(key): _path_free_calculation_result(item)
            for key, item in value.items()
            if "path" not in str(key).lower()
            and str(key).lower() not in {"cwd", "directory", "session_root"}
        }
    if isinstance(value, (list, tuple)):
        return [_path_free_calculation_result(item) for item in value]
    if isinstance(value, str):
        sanitized = sanitize_public_text(value)
        if "/" in sanitized or "\\" in sanitized:
            return "[path-bearing value withheld]"
        return sanitized
    return _agent_wire_value(value)


class CherryModelProvider:
    """OpenAI-shaped provider whose credentials and network calls stay in main."""

    name = "openai"
    wire_protocol = "openai"

    def __init__(
        self,
        peer: JsonRpcPeer,
        session_id: str,
        model_id: str,
    ) -> None:
        self._peer = peer
        self._session_id = session_id
        self.default_model = model_id
        self._operation_id: str | None = None

    def bind_model(self, model_id: str) -> None:
        if not isinstance(model_id, str) or not model_id.strip():
            raise ValueError("model_id must be a non-empty string")
        self.default_model = model_id

    def bind_operation(self, operation_id: str | None) -> None:
        self._operation_id = operation_id

    def chat(
        self, messages: list, tools: list | None = None, timeout_s: float = 120.0
    ) -> dict:
        request = {
            "sessionId": self._session_id,
            "modelId": self.default_model,
            "messages": messages,
            "tools": tools or [],
            "timeoutMs": int(timeout_s * 1000),
        }
        if self._operation_id is not None:
            request["operationId"] = self._operation_id
        result = self._peer.request(
            "model.generate",
            request,
            timeout=timeout_s + 10,
        )
        if not isinstance(result, dict):
            raise RpcFault(-32603, "model.generate returned a non-object response")
        return result


class _UnavailableModelProvider:
    """Registry-only placeholder; any attempted model call fails closed."""

    name = "openai"
    wire_protocol = "openai"
    default_model = "unavailable"

    @staticmethod
    def chat(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("No host model provider is bound")


_RULE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9._-]*$")
_PROJECT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_GATE_VERDICTS = {"ok", "warn", "reject", "unavailable"}


def _public_text(value: Any, fallback: str, *, limit: int = 2048) -> str:
    text = sanitize_public_text(str(value or "")).strip() or fallback
    return text[:limit]


def _rule_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        rule_id = str(item or "").strip()
        if _RULE_ID.fullmatch(rule_id) and rule_id not in result:
            result.append(rule_id)
        if len(result) == 128:
            break
    return result


def _gate_summary(
    payload: dict[str, Any],
    key: Literal["intent", "semantic"],
) -> dict[str, Any]:
    raw = payload.get(key)
    raw = raw if isinstance(raw, dict) else {}
    verdict = str(raw.get("verdict") or "unavailable")
    if verdict not in _GATE_VERDICTS:
        verdict = "unavailable"
    failed = _rule_ids(
        raw.get("failed_rule_ids")
        if "failed_rule_ids" in raw
        else raw.get("failedRuleIds")
    )
    return {
        "verdict": verdict,
        "failedRuleIds": failed,
        "message": (
            f"ChemSmart {key} gate returned {verdict}"
            + (f" for {len(failed)} rule(s)." if failed else ".")
        ),
        "extensions": {},
    }


def _public_synthesis_result(
    session_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    synthesis_id = f"synthesis-{uuid4().hex}"
    intent = _gate_summary(payload, "intent")
    semantic = _gate_summary(payload, "semantic")
    raw_command = str(payload.get("command") or "").strip()
    command_is_public = bool(
        raw_command
        and "/" not in raw_command
        and "\\" not in raw_command
        and all(
            ord(character) >= 32 and ord(character) != 127 for character in raw_command
        )
    )
    command = raw_command if command_is_public else ""

    raw_status = str(payload.get("status") or "").strip()
    status_map = {
        "needs_clarification": "needsClarification",
        "needsClarification": "needsClarification",
        "intent_reject": "intentRejected",
        "intentRejected": "intentRejected",
        "semantic_reject": "semanticRejected",
        "semanticRejected": "semanticRejected",
        "infeasible": "infeasible",
        "informational": "informational",
    }
    if (
        raw_status == "ready"
        and command
        and intent["verdict"] == "ok"
        and semantic["verdict"] == "ok"
    ):
        status = "ready"
    elif raw_status == "ready" and intent["verdict"] != "ok":
        status = "intentRejected"
    elif raw_status == "ready" and semantic["verdict"] != "ok":
        status = "semanticRejected"
    else:
        status = status_map.get(raw_status, "infeasible")

    project = str(payload.get("project") or "").strip()
    project_name = project if _PROJECT_NAME.fullmatch(project) else None
    missing: list[str] = []
    missing_items = payload.get("missing_info")
    if not isinstance(missing_items, list):
        missing_items = []
    for item in missing_items:
        text = _public_text(item, "Additional research input is required.")
        if text not in missing:
            missing.append(text)
        if len(missing) == 128:
            break

    evidence = []
    for key, kind, gate in (
        ("intent", "intentGate", intent),
        ("semantic", "semanticGate", semantic),
    ):
        evidence.append(
            {
                "evidenceId": f"{synthesis_id}:{key}",
                "kind": kind,
                "verdict": gate["verdict"],
                "summary": gate["message"],
                "ruleIds": gate["failedRuleIds"],
                "extensions": {},
            }
        )

    return {
        "schemaVersion": "1",
        "synthesisId": synthesis_id,
        "sessionId": session_id,
        "status": status,
        "command": command,
        "commandDigest": (
            hashlib.sha256(command.encode("utf-8")).hexdigest()
            if status == "ready"
            else None
        ),
        "explanation": _public_text(
            payload.get("explanation") or payload.get("reasoning"),
            "ChemSmart could not produce a fully authorized command.",
            limit=20_000,
        ),
        "projectName": project_name,
        "missingInfo": missing,
        "intent": intent,
        "semantic": semantic,
        "publicEvidence": evidence,
        "executionPerformed": False,
        "approvalRequiredForExecution": True,
        "extensions": {},
    }


def _studio_preflight_artifact(
    synthesis: dict[str, Any],
    payload: dict[str, Any],
    analysis: dict[str, Any],
    materialized_input: dict[str, Any],
) -> dict[str, Any]:
    """Bind one parser-owned command receipt to the visible Studio molecule."""

    preflight = payload.get("preflight")
    if not isinstance(preflight, dict):
        raise RpcFault(-32603, "Command synthesis omitted its preflight receipt")
    normalized_spec = preflight.get("normalized_spec")
    if not isinstance(normalized_spec, dict):
        raise RpcFault(-32603, "Command synthesis omitted its normalized SPEC")
    binding = analysis.get("binding")
    if not isinstance(binding, dict):
        raise RpcFault(-32603, "Current molecule analysis omitted its binding")

    engine = normalized_spec.get("program")
    raw_kind = str(normalized_spec.get("kind") or "")
    calculation_kind = {
        "xtb.sp": "single_point",
        "xtb.opt": "optimization",
        "xtb.hess": "frequency",
    }.get(raw_kind, "other")
    chemistry = normalized_spec.get("chemistry")
    chemistry = chemistry if isinstance(chemistry, dict) else {}
    if engine == "xtb":
        gfn_version = str(chemistry.get("gfn_version") or "gfn2").lower()
        method = {
            "gfn0": "GFN0-xTB",
            "gfn1": "GFN1-xTB",
            "gfn2": "GFN2-xTB",
            "gfnff": "GFN-FF",
        }.get(gfn_version)
    else:
        method = chemistry.get("functional") or chemistry.get("ab_initio")
        basis = chemistry.get("basis")
        if isinstance(method, str) and isinstance(basis, str):
            method = f"{method}/{basis}"
    if engine not in {"xtb", "gaussian", "orca"} or not isinstance(method, str):
        raise RpcFault(-32603, "Command preflight has no supported scientific method")

    state = binding.get("state")
    if state == "draft":
        revision = binding.get("baseRevision")
    elif state == "committed":
        revision = binding.get("revision")
    else:
        raise RpcFault(-32603, "Command preflight is not bound to an editable molecule")
    synthesis_id = synthesis["synthesisId"]
    command_digest = synthesis["commandDigest"]
    rule_ids = sorted(
        {
            *synthesis["intent"]["failedRuleIds"],
            *synthesis["semantic"]["failedRuleIds"],
        }
    )
    return {
        "artifactId": f"preflight-{synthesis_id}",
        "kind": "preflight_receipt",
        "heading": f"{method} {calculation_kind.replace('_', ' ')} preflight",
        "summary": (
            "The real ChemSmart parser accepted this command without starting "
            "a calculation process."
        ),
        "documentId": binding["documentId"],
        "revision": revision,
        "geometryHash": binding["geometryHash"],
        "charge": analysis["charge"],
        "multiplicity": analysis["multiplicity"],
        "engine": engine,
        "method": method,
        "calculationKind": calculation_kind,
        "planId": synthesis_id,
        "ruleIds": rule_ids,
        "verdict": "passed",
        "extensions": {
            "chemsmart.preflight": {
                "schemaVersion": preflight.get("schema_version"),
                "commandDigest": command_digest,
                "synthesisId": synthesis_id,
                "executionPerformed": False,
                "approvalRequiredForExecution": True,
                "projectRequired": engine != "xtb",
                "inputBasename": materialized_input["basename"],
                "inputDigest": materialized_input["sha256"],
            }
        },
    }


def _attach_registered_preflight_refs(
    arguments: dict[str, Any],
    registered_refs: list[tuple[str, str]],
    operation_id: str,
) -> dict[str, Any]:
    """Publish parser-owned receipts even when the model omits their opaque refs."""

    result = dict(arguments)
    existing = result.get("artifactRefs")
    refs = list(existing) if isinstance(existing, list) else []
    for registered_operation_id, reference in registered_refs:
        if (
            registered_operation_id == operation_id
            and reference not in refs
            and len(refs) < 8
        ):
            refs.append(reference)
    if refs:
        result["artifactRefs"] = refs
    return result


class StudioAgentRuntime:
    def __init__(self, session_root: Path, project_root: Path | None = None) -> None:
        self._peer: JsonRpcPeer | None = None
        self._session_root = session_root
        # The open `.cmsproj`, supplied at startup the same way `session_root` is. Trajectory
        # ledgers live inside it, so the sidecar that produces frames can append to them without a
        # round trip back through main. Optional so a runtime started without one still serves
        # everything else and refuses only the trajectory methods.
        self._project_root = project_root
        self._state_lock = threading.RLock()
        self._session_locks: dict[str, threading.RLock] = {}
        self._sessions: dict[str, AgentSession] = {}
        self._providers: dict[str, CherryModelProvider] = {}
        self._command_sessions: dict[str, CommandSynthesisSession] = {}
        self._studio_ui_emitters: dict[str, StudioUiEventEmitter] = {}
        self._trace_tool_call_ids: dict[tuple[str, str], list[str]] = {}
        self._studio_approval_grants: set[tuple[str, str | None, str, str]] = set()
        self._active_operation_ids: dict[str, str] = {}
        self._command_inspection = CommandInspectionAdapter(session_root)

    def bind_peer(self, peer: JsonRpcPeer) -> "StudioAgentRuntime":
        self._peer = peer
        return self

    def __call__(self, method: str, params: Any) -> Any:
        if method == "system.ping":
            return {"ok": True, "component": "chemsmart-studio-bridge"}
        if method == "command.inspect":
            return self._command_inspection.inspect(params)
        if method == "agent.run_turn":
            return self._run_turn(params)
        if method == "agent.close_session":
            session_id = self._required_string(params, "sessionId")
            with self._session_lock(session_id):
                with self._state_lock:
                    session_closed = self._sessions.pop(session_id, None) is not None
                    self._providers.pop(session_id, None)
                    self._command_sessions.pop(session_id, None)
                    self._active_operation_ids.pop(session_id, None)
                    emitter_closed = (
                        self._studio_ui_emitters.pop(session_id, None) is not None
                    )
                    self._studio_approval_grants = {
                        grant
                        for grant in self._studio_approval_grants
                        if grant[0] != session_id
                    }
            return {"closed": session_closed or emitter_closed}
        if method == "studio_ui.replay":
            return self._replay_studio_ui(params)
        # The researcher's own path into the harness: deterministic, no model in the loop, and every
        # answer is path-free because Studio names projects rather than locating them.
        if method in _PROJECT_METHODS:
            return self._project_request(method, params)
        if method == "command.synthesize":
            return self._synthesize_command(params)
        if method == "molecule.import":
            if self._peer is None:
                raise RpcFault(-32603, "RPC peer is not bound")
            return import_molecule(self._peer, params)
        if method in _TRAJECTORY_METHODS:
            return self._trajectory_request(method, params)
        raise RpcFault(-32601, f"Method not found: {method}")

    def _trajectory_request(self, method: str, params: Any) -> dict[str, Any]:
        """Serves the optimization ledger that used to live in the Qt helper.

        Frames originate in this process, so writing them here deletes the round trip they used to
        take through main. Reads are served from the same files, so a replay shows exactly what was
        recorded rather than a second copy of it.
        """
        if self._project_root is None:
            raise RpcFault(-32603, "No project is open for trajectory access")
        if not isinstance(params, dict):
            raise RpcFault(-32602, f"{method} params must be an object")
        try:
            validators = _TRAJECTORY_VALIDATORS.get(method)
            if validators and not validators[0].is_valid(params):
                raise LedgerError(f"{method} request is schema-invalid")
            result = _TRAJECTORY_METHODS[method](self._project_root, params)
            if validators and not validators[1].is_valid(result):
                raise LedgerError(f"{method} response is schema-invalid")
            return result
        except RunNotFound as error:
            raise RpcFault(
                -32004, str(error), {"studioCode": error.studio_code}
            ) from error
        except LedgerError as error:
            raise RpcFault(
                -32602, str(error), {"studioCode": error.studio_code}
            ) from error

    @staticmethod
    def _project_request(method: str, params: Any) -> dict[str, Any]:
        request_validator = _PROJECT_REQUEST_VALIDATORS[method]
        if not request_validator.is_valid(params):
            raise RpcFault(-32602, f"{method} request is schema-invalid")
        try:
            result = _PROJECT_METHODS[method](params)
        except ValueError as error:
            raise RpcFault(-32602, str(error)) from error
        if not _PROJECT_RESULT_VALIDATORS[method].is_valid(result):
            raise RpcFault(-32603, f"{method} produced an invalid public result")
        return result

    def _synthesize_command(self, params: Any) -> dict[str, Any]:
        operation_id = self._operation_id_from_params(params)
        public_params = self._without_operation_id(params)
        if not _COMMAND_SYNTHESIS_REQUEST_VALIDATOR.is_valid(public_params):
            raise RpcFault(-32602, "command.synthesize request is schema-invalid")
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        session_id = public_params["sessionId"]
        model_id = public_params["modelId"]
        request = public_params["request"]
        with self._session_lock(session_id):
            with self._operation_scope(session_id, operation_id):
                provider, command_session = self._provider_and_command_session(
                    session_id,
                    model_id,
                )
                provider.bind_model(model_id)
                provider.bind_operation(operation_id)
                with workflow_state_scope(session_id):
                    payload = dict(
                        agent_json_safe(command_session.synthesize_command(request))
                    )
                result = _public_synthesis_result(session_id, payload)
                if not _COMMAND_SYNTHESIS_RESULT_VALIDATOR.is_valid(result):
                    raise RpcFault(
                        -32603,
                        "command.synthesize produced an invalid public result",
                    )
                return result

    def _run_turn(self, params: Any) -> dict[str, Any]:
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        operation_id = self._operation_id_from_params(params)
        session_id = self._required_string(params, "sessionId")
        model_id = self._required_string(params, "modelId")
        request = self._required_string(params, "request")
        capability_value = (
            params.get("capability", "inspect")
            if isinstance(params, dict)
            else "inspect"
        )
        if not isinstance(capability_value, str) or not capability_value.strip():
            raise RpcFault(-32602, "Agent capability is invalid")
        try:
            capability = StudioCapability(capability_value)
        except ValueError as error:
            raise RpcFault(
                -32602,
                "Agent capability is invalid",
            ) from error
        intent_kind = params.get("intentKind", "inspect")
        if (
            not isinstance(intent_kind, str)
            or intent_kind not in _STUDIO_COMPOSER_INTENTS
        ):
            raise RpcFault(-32602, "Agent composer intent is invalid")
        tool_profile = _studio_agent_tool_profile(capability, intent_kind)
        with self._session_lock(session_id):
            with self._operation_scope(session_id, operation_id):
                provider, command_session = self._provider_and_command_session(
                    session_id,
                    model_id,
                )
                provider.bind_model(model_id)
                provider.bind_operation(operation_id)
                self._publish_agent_trace(
                    session_id,
                    kind="turn_started",
                    title="ChemSmart Agent",
                    summary="Understanding the current research request.",
                )
                self._publish_agent_trace(
                    session_id,
                    kind="reasoning_summary",
                    title="Reasoning",
                    summary=(
                        "Selecting a bounded tool path and validating the visible "
                        "molecule binding."
                    ),
                )
                session = self._sessions.get(session_id)
                if session is None:
                    session_options = {
                        "provider": provider,
                        "registry": self._studio_registry(
                            session_id,
                            command_session,
                        ),
                        "session_root": self._session_root,
                        "runtime_v2": "active",
                        "tool_profile": tool_profile,
                        "training_capture": "disabled",
                    }
                    persisted_session_id = self._read_agent_session_binding(session_id)
                    session = (
                        AgentSession.load(persisted_session_id, **session_options)
                        if persisted_session_id is not None
                        else AgentSession(**session_options)
                    )
                    self._sessions[session_id] = session
                session.bind_provider(provider)
                session.bind_tool_profile(tool_profile)
                turn_request = request
                if intent_kind == "run":
                    turn_request = (
                        f"{request}\n\n"
                        "Studio act intent: after deterministic command synthesis "
                        "returns a ready command, call execute_chemsmart_command "
                        "with that exact command. Do not finish with a preflight-only "
                        "answer. The trusted host will request one-shot approval and "
                        "revalidate the current molecule before starting a process."
                    )

                try:
                    raw_result = session.run_loop(
                        turn_request,
                        policy=studio_permission_policy(),
                        approver=lambda tool_request: self._approve(
                            session_id,
                            session.registry,
                            tool_request,
                        ),
                        on_session_created=lambda agent_session_id: (
                            self._persist_agent_session_binding(
                                session_id,
                                agent_session_id,
                            )
                        ),
                    )
                except Exception:
                    self._publish_agent_trace(
                        session_id,
                        kind="turn_blocked",
                        title="ChemSmart Agent",
                        summary="The turn stopped before a trusted result was available.",
                    )
                    raise
                internal_session_id = raw_result.get("session_id")
                if not isinstance(internal_session_id, str):
                    raise RpcFault(
                        -32603,
                        "AgentSession returned an invalid session identity",
                    )
                self._persist_agent_session_binding(
                    session_id,
                    internal_session_id,
                )
                limit_reason = raw_result.get("limit_reason")
                if isinstance(limit_reason, str) and limit_reason:
                    self._publish_agent_trace(
                        session_id,
                        kind="turn_blocked",
                        title="ChemSmart Agent",
                        summary="The turn reached a bounded runtime limit.",
                    )
                    raise RpcFault(
                        -32603,
                        f"ChemSmart agent turn stopped before completion ({limit_reason})",
                    )
                result = _public_agent_result(raw_result)
                self._publish_agent_trace(
                    session_id,
                    kind="turn_completed",
                    title="ChemSmart Agent",
                    summary="The turn completed.",
                )
                event = {
                    "sessionId": session_id,
                    "type": "turn_completed",
                    "result": result,
                }
                if operation_id is not None:
                    event["operationId"] = operation_id
                self._peer.notify("agent.event", event)
                return result

    def _approve(
        self,
        session_id: str,
        registry: ToolRegistry,
        request: ToolRequest,
    ) -> ApprovalDecision:
        assert self._peer is not None
        arguments = self._normalized_approval_arguments(registry, request)
        if arguments is None:
            return ApprovalDecision.DENY
        self._publish_agent_trace(
            session_id,
            kind="permission_waiting",
            tool_call_id=request.request_id,
            tool_name=request.name,
            title=request.name,
            summary="Waiting for an exact trusted decision.",
            detail={"argumentKeys": _safe_public_keys(arguments)},
        )
        try:
            approval_request = {
                "sessionId": session_id,
                "requestId": request.request_id,
                "tool": request.name,
                "arguments": arguments,
            }
            operation_id = self._current_operation_id(session_id)
            if operation_id is not None:
                approval_request["operationId"] = operation_id
            result = self._peer.request(
                "approval.request",
                approval_request,
                timeout=305,
            )
        except RpcFault:
            # Missing renderer authority must never widen mutation permission.
            self._publish_agent_trace(
                session_id,
                kind="tool_failed",
                tool_call_id=request.request_id,
                tool_name=request.name,
                title=request.name,
                summary="The trusted decision was unavailable.",
                detail={"verdict": "denied"},
            )
            return ApprovalDecision.DENY
        value = result.get("decision") if isinstance(result, dict) else None
        try:
            decision = ApprovalDecision(value)
            if (
                request.name in ALWAYS_STUDIO_APPROVAL
                and decision == ApprovalDecision.ALLOW_SESSION
            ):
                decision = ApprovalDecision.ALLOW_ONCE
            if (
                request.name in _STUDIO_HANDLER_APPROVAL
                and decision == ApprovalDecision.ALLOW_ONCE
            ):
                self._studio_approval_grants.add(
                    self._studio_grant_key(
                        session_id,
                        operation_id,
                        request.name,
                        arguments,
                    )
                )
            if decision in (
                ApprovalDecision.ALLOW_ONCE,
                ApprovalDecision.ALLOW_SESSION,
            ):
                self._trace_tool_call_ids.setdefault(
                    (session_id, request.name),
                    [],
                ).append(request.request_id)
            else:
                self._publish_agent_trace(
                    session_id,
                    kind="tool_failed",
                    tool_call_id=request.request_id,
                    tool_name=request.name,
                    title=request.name,
                    summary="The requested tool was denied.",
                    detail={"verdict": "denied"},
                )
            return decision
        except (TypeError, ValueError):
            self._publish_agent_trace(
                session_id,
                kind="tool_failed",
                tool_call_id=request.request_id,
                tool_name=request.name,
                title=request.name,
                summary="The trusted decision was invalid.",
                detail={"verdict": "denied"},
            )
            return ApprovalDecision.DENY

    @staticmethod
    def _normalized_approval_arguments(
        registry: ToolRegistry,
        request: ToolRequest,
    ) -> dict[str, Any] | None:
        if request.name not in ALWAYS_STUDIO_APPROVAL:
            return None
        tool = registry.get_tool(request.name)
        if tool is None:
            return None
        approval_validator = _STUDIO_APPROVAL_ARGUMENT_VALIDATORS.get(request.name)
        if approval_validator is not None:
            if not approval_validator.is_valid(request.arguments):
                return None
            arguments = _agent_wire_value(request.arguments)
        studio_validator = _STUDIO_TOOL_INPUT_VALIDATORS.get(request.name)
        if approval_validator is not None:
            pass
        elif studio_validator is not None:
            if not studio_validator.is_valid(request.arguments):
                return None
            arguments = _agent_wire_value(request.arguments)
        else:
            try:
                validated = tool.input_schema.model_validate(
                    request.arguments,
                    strict=True,
                )
            except Exception:
                return None
            arguments = validated.model_dump(mode="json")
        if not isinstance(arguments, dict):
            return None
        if request.name == "execute_chemsmart_command":
            arguments.setdefault("test", False)
            arguments.setdefault("timeout_s", 3600)
        for key in (
            "preview_id",
            "engine",
            "method",
            "run_id",
            "plan_id",
            "plan_digest",
            "artifact_id",
            "document_id",
            "geometry_hash",
        ):
            value = arguments.get(key)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                return None
        expected_revision = arguments.get("expected_revision")
        if expected_revision is not None and expected_revision < 0:
            return None
        if request.name == "start_molecule_optimization" and any(
            not validator.is_valid(arguments.get(field))
            for field, validator in _CALCULATION_START_VALIDATORS.items()
        ):
            return None
        return arguments

    @staticmethod
    def _studio_grant_key(
        session_id: str,
        operation_id: str | None,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> tuple[str, str | None, str, str]:
        return (
            session_id,
            operation_id,
            tool_name,
            json.dumps(
                arguments,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ),
        )

    def _consume_studio_grant(
        self,
        session_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> None:
        key = self._studio_grant_key(
            session_id,
            self._current_operation_id(session_id),
            tool_name,
            arguments,
        )
        if key not in self._studio_approval_grants:
            raise PermissionError("Trusted Studio approval is missing")
        self._studio_approval_grants.remove(key)

    def _molecule_request(
        self,
        session_id: str,
        method: str,
        params: dict[str, Any],
    ) -> Any:
        assert self._peer is not None
        request = {"sessionId": session_id, "method": method, "params": params}
        if not _MOLECULE_REQUEST_VALIDATOR.is_valid(request):
            raise RpcFault(-32602, "molecule.request envelope is schema-invalid")
        return self._peer.request(
            "molecule.request",
            self._operation_callback(session_id, request),
        )

    def _controlled_calculation_request(
        self,
        session_id: str,
        tool: str,
        arguments: dict[str, Any],
    ) -> Any:
        assert self._peer is not None
        request = {
            "type": "controlled_calculation_host_request",
            "sessionId": session_id,
            "request": {
                "type": "studio_agent_tool_request",
                "tool": tool,
                "arguments": arguments,
            },
        }
        if not _CONTROLLED_CALCULATION_HOST_REQUEST_VALIDATOR.is_valid(request):
            raise RpcFault(
                -32602,
                "calculation.request envelope is schema-invalid",
            )
        result = self._peer.request(
            "calculation.request",
            self._operation_callback(session_id, request),
        )
        if not _CONTROLLED_CALCULATION_HOST_RESPONSE_VALIDATOR.is_valid(
            result
        ) or not _CONTROLLED_CALCULATION_RESULT_VALIDATORS[tool].is_valid(result):
            raise RpcFault(
                -32603,
                "calculation.request response is schema-invalid",
            )
        return result

    def _report_studio_result(
        self,
        session_id: str,
        arguments: dict[str, Any],
    ) -> Any:
        assert self._peer is not None
        validator = Draft202012Validator(_REPORT_STUDIO_RESULT_INPUT_SCHEMA)
        errors = sorted(
            validator.iter_errors(arguments),
            key=lambda error: tuple(str(item) for item in error.absolute_path),
        )
        if errors:
            issues = []
            for error in errors[:8]:
                location = ".".join(str(item) for item in error.absolute_path) or "$"
                issues.append(f"{location}:{error.validator}")
            raise RpcFault(
                -32602,
                "report_studio_result arguments are schema-invalid at "
                + ", ".join(issues),
            )
        return self._peer.request(
            "agent.report_result",
            self._operation_callback(
                session_id,
                {
                    "sessionId": session_id,
                    "arguments": arguments,
                },
            ),
        )

    def _register_command_preflight(
        self,
        session_id: str,
        synthesis: dict[str, Any],
        artifact: dict[str, Any],
    ) -> Any:
        assert self._peer is not None
        return self._peer.request(
            "agent.register_preflight",
            self._operation_callback(
                session_id,
                {
                    "sessionId": session_id,
                    "synthesis": synthesis,
                    "artifact": artifact,
                },
            ),
        )

    def _materialize_current_molecule_input(
        self,
        session_id: str,
        analysis: dict[str, Any],
    ) -> dict[str, Any]:
        assert self._peer is not None
        binding = analysis.get("binding")
        if not isinstance(binding, dict):
            raise RpcFault(-32603, "Current molecule analysis omitted its binding")
        state = binding.get("state")
        revision = (
            binding.get("baseRevision")
            if state == "draft"
            else binding.get("revision")
            if state == "committed"
            else None
        )
        request = {
            "documentId": binding.get("documentId"),
            "revision": revision,
            "geometryHash": binding.get("geometryHash"),
        }
        if not _MATERIALIZE_MOLECULE_INPUT_REQUEST_VALIDATOR.is_valid(request):
            raise RpcFault(
                -32603,
                "Current molecule analysis cannot be materialized safely",
            )
        result = self._peer.request(
            "agent.materialize_input",
            self._operation_callback(
                session_id,
                {
                    "sessionId": session_id,
                    "input": request,
                },
            ),
        )
        if (
            not _MATERIALIZED_MOLECULE_INPUT_VALIDATOR.is_valid(result)
            or result["documentId"] != request["documentId"]
            or result["revision"] != request["revision"]
            or result["geometryHash"] != request["geometryHash"]
        ):
            raise RpcFault(
                -32603,
                "Materialized molecule input does not match the visible molecule",
            )
        return dict(result)

    def _studio_ui_emitter(self, session_id: str) -> StudioUiEventEmitter:
        emitter = self._studio_ui_emitters.get(session_id)
        if emitter is None:
            emitter = StudioUiEventEmitter(
                session_id,
                self._session_root / session_id / "studio-ui-events.ndjson",
                publish=self._publish_studio_ui_event,
            )
            self._studio_ui_emitters[session_id] = emitter
        return emitter

    def _read_agent_session_binding(self, studio_session_id: str) -> str | None:
        self._validate_studio_session_id(studio_session_id)
        root_descriptor: int | None = None
        session_descriptor: int | None = None
        binding_descriptor: int | None = None
        agent_session_descriptor: int | None = None
        try:
            try:
                root_descriptor = os.open(
                    self._session_root,
                    _DIRECTORY_OPEN_FLAGS,
                )
            except FileNotFoundError:
                return None
            try:
                session_descriptor = os.open(
                    studio_session_id,
                    _DIRECTORY_OPEN_FLAGS,
                    dir_fd=root_descriptor,
                )
            except FileNotFoundError:
                return None
            try:
                binding_descriptor = os.open(
                    _AGENT_SESSION_BINDING_NAME,
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=session_descriptor,
                )
            except FileNotFoundError:
                return None
            binding_stat = os.fstat(binding_descriptor)
            if (
                not stat.S_ISREG(binding_stat.st_mode)
                or binding_stat.st_size > _BINDING_LIMIT_BYTES
            ):
                raise ValueError("unsafe binding")
            encoded = self._read_bounded_descriptor(
                binding_descriptor,
                _BINDING_LIMIT_BYTES,
            )
            value = json.loads(encoded.decode("utf-8"))
            if (
                not isinstance(value, dict)
                or set(value) != {"agentSessionId", "schemaVersion"}
                or value.get("schemaVersion") != 1
                or not isinstance(value.get("agentSessionId"), str)
                or not _CHEMSMART_SESSION_ID.fullmatch(value["agentSessionId"])
            ):
                raise ValueError("invalid binding")
            agent_session_descriptor = os.open(
                value["agentSessionId"],
                _DIRECTORY_OPEN_FLAGS,
                dir_fd=root_descriptor,
            )
            return value["agentSessionId"]
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise RpcFault(-32603, "Agent session binding is invalid") from error
        finally:
            for descriptor in (
                agent_session_descriptor,
                binding_descriptor,
                session_descriptor,
                root_descriptor,
            ):
                if descriptor is not None:
                    os.close(descriptor)

    def _persist_agent_session_binding(
        self,
        studio_session_id: str,
        agent_session_id: str,
    ) -> None:
        if not _CHEMSMART_SESSION_ID.fullmatch(agent_session_id):
            raise RpcFault(-32603, "AgentSession returned an invalid session identity")
        self._validate_studio_session_id(studio_session_id)
        existing = self._read_agent_session_binding(studio_session_id)
        if existing is not None:
            if existing != agent_session_id:
                raise RpcFault(-32603, "Agent session binding changed unexpectedly")
            return

        temporary_name = f".{_AGENT_SESSION_BINDING_NAME}.{uuid4().hex}.tmp"
        encoded = json.dumps(
            {
                "agentSessionId": agent_session_id,
                "schemaVersion": 1,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        root_descriptor: int | None = None
        session_descriptor: int | None = None
        agent_session_descriptor: int | None = None
        temporary_descriptor: int | None = None
        temporary_created = False
        session_directory_created = False
        try:
            self._session_root.mkdir(parents=True, exist_ok=True)
            root_descriptor = os.open(
                self._session_root,
                _DIRECTORY_OPEN_FLAGS,
            )
            agent_session_descriptor = os.open(
                agent_session_id,
                _DIRECTORY_OPEN_FLAGS,
                dir_fd=root_descriptor,
            )
            try:
                os.mkdir(
                    studio_session_id,
                    mode=0o700,
                    dir_fd=root_descriptor,
                )
                session_directory_created = True
            except FileExistsError:
                pass
            session_descriptor = os.open(
                studio_session_id,
                _DIRECTORY_OPEN_FLAGS,
                dir_fd=root_descriptor,
            )
            os.fchmod(session_descriptor, 0o700)
            temporary_descriptor = os.open(
                temporary_name,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o600,
                dir_fd=session_descriptor,
            )
            temporary_created = True
            self._write_all(temporary_descriptor, encoded)
            os.fsync(temporary_descriptor)
            os.close(temporary_descriptor)
            temporary_descriptor = None
            try:
                os.link(
                    temporary_name,
                    _AGENT_SESSION_BINDING_NAME,
                    src_dir_fd=session_descriptor,
                    dst_dir_fd=session_descriptor,
                    follow_symlinks=False,
                )
            except FileExistsError:
                competing_binding = self._read_agent_session_binding(studio_session_id)
                if competing_binding != agent_session_id:
                    raise RpcFault(
                        -32603,
                        "Agent session binding changed unexpectedly",
                    )
            os.unlink(temporary_name, dir_fd=session_descriptor)
            temporary_created = False
            os.fsync(session_descriptor)
            if session_directory_created:
                os.fsync(root_descriptor)
        except OSError as error:
            raise RpcFault(
                -32603, "Agent session binding could not be written"
            ) from error
        finally:
            if temporary_descriptor is not None:
                os.close(temporary_descriptor)
            if temporary_created and session_descriptor is not None:
                try:
                    os.unlink(temporary_name, dir_fd=session_descriptor)
                except FileNotFoundError:
                    pass
            for descriptor in (
                session_descriptor,
                agent_session_descriptor,
                root_descriptor,
            ):
                if descriptor is not None:
                    os.close(descriptor)

    def _publish_studio_ui_event(self, event: dict[str, Any]) -> dict[str, Any]:
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        session_id = event.get("sessionId")
        params = (
            self._operation_callback(session_id, event)
            if isinstance(session_id, str)
            else event
        )
        result = self._peer.request("studio_ui.event", params, timeout=30)
        if not isinstance(result, dict):
            raise RpcFault(-32603, "studio_ui.event returned a non-object response")
        return result

    def _publish_agent_trace(
        self,
        session_id: str,
        *,
        kind: str,
        title: str,
        summary: str,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Send a public trace seed to main, where identity and ordering are assigned."""

        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        event: dict[str, Any] = {
            "sessionId": session_id,
            "kind": kind,
            "title": _public_text(title, "ChemSmart Agent", limit=256),
            "summary": _public_text(
                summary,
                "The Agent updated its trusted execution state.",
            ),
        }
        if tool_call_id is not None:
            event["toolCallId"] = tool_call_id
        if tool_name is not None:
            event["toolName"] = tool_name
        if detail:
            event["detail"] = detail
        result = self._peer.request(
            "agent.trace",
            self._operation_callback(session_id, event),
            timeout=30,
        )
        if not isinstance(result, dict):
            raise RpcFault(-32603, "agent.trace returned a non-object response")
        return result

    def _next_trace_tool_call_id(self, session_id: str, tool_name: str) -> str:
        key = (session_id, tool_name)
        pending = self._trace_tool_call_ids.get(key)
        if pending:
            tool_call_id = pending.pop(0)
            if not pending:
                self._trace_tool_call_ids.pop(key, None)
            return tool_call_id
        return f"tool-{uuid4().hex}"

    def _trace_registry(
        self,
        session_id: str,
        registry: ToolRegistry,
    ) -> ToolRegistry:
        traced_specs = []
        for source in registry.list_tools():
            tool_name = source.name
            original = source.func

            def traced_tool(
                *args: Any,
                _tool_name: str = tool_name,
                _original: Any = original,
                **arguments: Any,
            ) -> Any:
                tool_call_id = self._next_trace_tool_call_id(
                    session_id,
                    _tool_name,
                )
                self._publish_agent_trace(
                    session_id,
                    kind="tool_started",
                    tool_call_id=tool_call_id,
                    tool_name=_tool_name,
                    title=_tool_name,
                    summary="Using a validated ChemSmart tool.",
                    detail={"argumentKeys": _safe_public_keys(arguments)},
                )
                started_at = perf_counter()
                try:
                    result = _original(*args, **arguments)
                except Exception:
                    self._publish_agent_trace(
                        session_id,
                        kind="tool_failed",
                        tool_call_id=tool_call_id,
                        tool_name=_tool_name,
                        title=_tool_name,
                        summary="The tool failed before producing a trusted result.",
                        detail={
                            "durationMs": max(
                                0,
                                round((perf_counter() - started_at) * 1000),
                            )
                        },
                    )
                    raise
                wire_result = _agent_wire_value(result)
                failed = isinstance(wire_result, dict) and (
                    wire_result.get("ok") is False
                    or isinstance(wire_result.get("error"), dict)
                )
                self._publish_agent_trace(
                    session_id,
                    kind="tool_failed" if failed else "tool_succeeded",
                    tool_call_id=tool_call_id,
                    tool_name=_tool_name,
                    title=_tool_name,
                    summary=(
                        "The tool returned a validated failure."
                        if failed
                        else "The tool completed."
                    ),
                    detail={
                        "resultKeys": _safe_public_keys(wire_result),
                        "durationMs": max(
                            0,
                            round((perf_counter() - started_at) * 1000),
                        ),
                    },
                )
                return result

            traced_specs.append(replace(source, func=traced_tool))
        return ToolRegistry(traced_specs)

    def _publish_studio_ui_replay_event(
        self,
        replay_id: str,
        event: dict[str, Any],
    ) -> None:
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        self._peer.notify(
            "studio_ui.replay_event",
            {"replayId": replay_id, "event": event},
        )

    def _replay_studio_ui(self, params: Any) -> dict[str, int]:
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        session_id = self._required_string(params, "sessionId")
        replay_id = self._required_string(params, "replayId")
        after_sequence = self._optional_sequence(params, "afterSequence", -1)
        emitter = self._studio_ui_emitter(session_id)
        replayed = emitter.replay(
            lambda event: self._publish_studio_ui_replay_event(replay_id, event),
            after_sequence=after_sequence,
        )
        return {"replayed": replayed, "nextSequence": emitter.next_sequence}

    def _studio_registry(
        self,
        session_id: str,
        command_session: CommandSynthesisSession | StudioUiEventEmitter | None = None,
    ) -> ToolRegistry:
        if isinstance(command_session, StudioUiEventEmitter):
            command_session = None
        if command_session is None:
            command_session = (
                self._provider_and_command_session(
                    session_id,
                    "unavailable::registry",
                )[1]
                if self._peer is not None
                else CommandSynthesisSession(_UnavailableModelProvider())
            )

        def read_project_yaml(
            project: str,
            program: Literal["gaussian", "orca"],
        ) -> dict[str, Any]:
            """Read a named Studio method project without exposing its path."""

            return read_project(
                {
                    "projectName": project,
                    "program": program,
                    "extensions": {},
                }
            )

        def validate_project_yaml(
            yaml_text: str,
            program: Literal["gaussian", "orca"],
            project: str = "candidate",
        ) -> dict[str, Any]:
            """Validate a candidate method project without writing it."""

            return validate_project(
                {
                    "projectName": project,
                    "program": program,
                    "yamlText": yaml_text,
                    "extensions": {},
                }
            )

        def critic_project_yaml(
            yaml_text: str,
            program: Literal["gaussian", "orca"],
            project: str = "candidate",
        ) -> dict[str, Any]:
            """Critique a candidate method project without writing it."""

            return critic_project(
                {
                    "projectName": project,
                    "program": program,
                    "yamlText": yaml_text,
                    "extensions": {},
                }
            )

        def get_molecule_snapshot() -> dict[str, Any]:
            """Read the current committed molecule document and revision."""
            return self._molecule_request(session_id, "molecule.get_snapshot", {})

        def preview_molecule_patch(patch: dict[str, Any]) -> dict[str, Any]:
            """Render a schema-valid molecule patch as a non-committed preview."""
            return self._molecule_request(
                session_id,
                "molecule.preview_patch",
                {"patch": patch},
            )

        def commit_molecule_preview(
            preview_id: str, expected_revision: int
        ) -> dict[str, Any]:
            """Append a validated agent edit to Studio's recoverable molecule draft."""
            return self._molecule_request(
                session_id,
                "molecule.commit_preview",
                {"previewId": preview_id, "expectedRevision": expected_revision},
            )

        def discard_molecule_preview(preview_id: str) -> dict[str, Any]:
            """Discard an uncommitted molecule preview."""
            return self._molecule_request(
                session_id,
                "molecule.discard_preview",
                {"previewId": preview_id},
            )

        def start_molecule_optimization(
            engine: str,
            method: str,
            settings: dict[str, Any],
            expected_revision: int,
        ) -> dict[str, Any]:
            """Start an explicitly approved optimization of the committed revision."""
            return self._molecule_request(
                session_id,
                "optimization.start",
                {
                    "engine": engine,
                    "method": method,
                    "settings": settings,
                    "expectedRevision": expected_revision,
                },
            )

        def cancel_molecule_optimization(run_id: str) -> dict[str, Any]:
            """Cancel the active optimization and preserve its recorded frames."""
            return self._molecule_request(
                session_id,
                "optimization.cancel",
                {"runId": run_id},
            )

        def accept_optimization_geometry(
            run_id: str, expected_revision: int
        ) -> dict[str, Any]:
            """Commit the final geometry of a completed run after explicit approval."""
            return self._molecule_request(
                session_id,
                "optimization.accept_final",
                {"runId": run_id, "expectedRevision": expected_revision},
            )

        def reject_optimization_geometry(run_id: str) -> dict[str, Any]:
            """Reject a completed run's final geometry without changing the committed revision."""
            return self._molecule_request(
                session_id,
                "optimization.reject_final",
                {"runId": run_id},
            )

        def inspect_calculation(run_id: str) -> dict[str, Any]:
            """Inspect one opaque Studio run without exposing filesystem coordinates."""

            result = inspect_agent_calculation(
                run_id=run_id,
                session_root=str(self._session_root),
            )
            projected = _path_free_calculation_result(result)
            if not isinstance(projected, dict):
                raise RuntimeError("Calculation inspection returned an invalid result")
            return projected

        registered_preflight_refs: list[tuple[str, str]] = []

        def synthesize_command(request: str) -> dict[str, Any]:
            """Synthesize and register one parser-owned, non-executing preflight."""

            analysis = self._controlled_calculation_request(
                session_id,
                "analyze_current_molecule",
                {},
            )
            materialized_input = self._materialize_current_molecule_input(
                session_id,
                analysis,
            )
            bound_request = (
                f"{request}\n"
                "Use the current Studio molecule input with exact basename "
                f"{materialized_input['basename']}. "
                "For xTB, do not require project YAML."
            )
            payload = dict(
                agent_json_safe(command_session.synthesize_command(bound_request))
            )
            synthesis = _public_synthesis_result(session_id, payload)
            if synthesis["status"] != "ready":
                return payload
            artifact = _studio_preflight_artifact(
                synthesis,
                payload,
                analysis,
                materialized_input,
            )
            self._register_command_preflight(
                session_id,
                synthesis,
                artifact,
            )
            operation_id = self._active_operation_ids.get(session_id)
            if operation_id is None:
                raise RpcFault(
                    -32603, "Command preflight is outside an active Agent turn"
                )
            registered_preflight_refs.append((operation_id, synthesis["synthesisId"]))
            payload["synthesisId"] = synthesis["synthesisId"]
            payload["commandDigest"] = synthesis["commandDigest"]
            payload["studio_artifact_ref"] = synthesis["synthesisId"]
            payload["studio_result_instruction"] = (
                "Finish with report_studio_result and put the exact "
                "studio_artifact_ref in artifactRefs. Do not re-author the "
                "registered preflight artifact."
            )
            return payload

        studio_specs = []
        studio_specs.append(
            build_tool_spec(
                inspect_calculation,
                metadata=RuntimeToolMetadata(read_only=True),
                input_json_schema={
                    "additionalProperties": False,
                    "properties": {
                        "run_id": {
                            "description": "Opaque Studio calculation run identifier.",
                            "maxLength": 128,
                            "minLength": 1,
                            "pattern": r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
                            "type": "string",
                        }
                    },
                    "required": ["run_id"],
                    "type": "object",
                },
            )
        )
        for function in (
            read_project_yaml,
            validate_project_yaml,
            critic_project_yaml,
        ):
            studio_specs.append(
                build_tool_spec(
                    function,
                    metadata=RuntimeToolMetadata(read_only=True),
                )
            )
        for source in command_session.tool_specs():
            studio_specs.append(
                replace(
                    source,
                    func=(
                        synthesize_command
                        if source.name == "synthesize_command"
                        else source.func
                    ),
                )
            )
        definitions = [
            (get_molecule_snapshot, True, True, None),
            (preview_molecule_patch, False, True, None),
            (commit_molecule_preview, False, True, None),
            (discard_molecule_preview, False, True, None),
            (start_molecule_optimization, False, False, "starts a calculation process"),
            (
                cancel_molecule_optimization,
                False,
                False,
                "cancels an active calculation",
            ),
            (
                accept_optimization_geometry,
                False,
                False,
                "commits optimized final geometry",
            ),
            (
                reject_optimization_geometry,
                False,
                False,
                "rejects optimized final geometry",
            ),
        ]
        for function, read_only, edit_safe, side_effect in definitions:
            studio_specs.append(
                build_tool_spec(
                    function,
                    metadata=RuntimeToolMetadata(
                        read_only=read_only,
                        edit_safe=edit_safe,
                        side_effect=side_effect,
                    ),
                    input_json_schema=(
                        _STUDIO_COMMIT_INPUT_SCHEMA
                        if function.__name__ == "commit_molecule_preview"
                        else STUDIO_AGENT_TOOL_INPUT_SCHEMAS.get(function.__name__)
                    ),
                )
            )
        rpc_adapter = _StudioRpcAdapter(self, session_id)

        def report_studio_result(**arguments: Any) -> Any:
            operation_id = self._active_operation_ids.get(session_id)
            if operation_id is None:
                raise RpcFault(-32603, "Studio result is outside an active Agent turn")
            projected = _attach_registered_preflight_refs(
                arguments,
                registered_preflight_refs,
                operation_id,
            )
            result = rpc_adapter.report_studio_result(projected)
            registered_preflight_refs[:] = [
                item for item in registered_preflight_refs if item[0] != operation_id
            ]
            return result

        for source in build_studio_tool_specs(
            StudioToolAdapters(
                host=rpc_adapter,
                execution=rpc_adapter,
                artifacts=rpc_adapter,
                approvals=_StudioApprovalGrantAdapter(self, session_id),
            ),
            _STUDIO_TOOL_INPUT_SCHEMAS,
        ):
            studio_specs.append(
                replace(
                    source,
                    func=(
                        report_studio_result
                        if source.name == "report_studio_result"
                        else source.func
                    ),
                    description=(
                        "Publish the final bounded Studio answer. When a "
                        "command tool returns studio_artifact_ref, copy that "
                        "exact opaque value into artifactRefs and leave "
                        "artifacts empty; never re-author the registered "
                        "preflight receipt."
                        if source.name == "report_studio_result"
                        else source.description
                    ),
                )
            )
        default_registry = ToolRegistry.default()
        generic_execution_specs = []
        for tool_name, input_schema in _STUDIO_EXECUTION_INPUT_SCHEMAS.items():
            source = default_registry.get_tool(tool_name)
            if source is None:
                raise RuntimeError(
                    f"ChemSmart runtime is missing required Studio tool {tool_name}"
                )
            generic_execution_specs.append(
                build_tool_spec(
                    (
                        command_session.execute_command
                        if tool_name == "execute_chemsmart_command"
                        else source.func
                    ),
                    registered_name=tool_name,
                    description=source.description,
                    metadata=source.metadata,
                    input_json_schema=input_schema,
                )
            )
        studio_specs.extend(generic_execution_specs)
        base_registry = ToolRegistry(
            [
                spec
                for spec in default_registry.list_tools()
                if spec.name
                not in (
                    STUDIO_WITHHELD_TOOLS
                    | {
                        *_STUDIO_EXECUTION_INPUT_SCHEMAS,
                        "synthesize_command",
                        "repair_command",
                        "read_project_yaml",
                        "validate_project_yaml",
                        "critic_project_yaml",
                        "inspect_calculation",
                    }
                )
            ]
        )
        return self._trace_registry(
            session_id,
            base_registry.with_tools(studio_specs),
        )

    @staticmethod
    def _validate_studio_session_id(session_id: str) -> None:
        if not _STUDIO_SESSION_ID.fullmatch(session_id):
            raise RpcFault(-32603, "Agent session binding is invalid")

    @staticmethod
    def _read_bounded_descriptor(descriptor: int, limit: int) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(descriptor, limit + 1 - total)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            total += len(chunk)
        raise ValueError("unsafe binding")

    @staticmethod
    def _write_all(descriptor: int, value: bytes) -> None:
        offset = 0
        while offset < len(value):
            written = os.write(descriptor, value[offset:])
            if written <= 0:
                raise OSError("short binding write")
            offset += written

    @staticmethod
    def _without_operation_id(params: Any) -> dict[str, Any]:
        if not isinstance(params, dict):
            return {}
        return {key: value for key, value in params.items() if key != "operationId"}

    @staticmethod
    def _operation_id_from_params(params: Any) -> str | None:
        if not isinstance(params, dict):
            return None
        operation_id = params.get("operationId")
        if operation_id is None:
            return None
        if not isinstance(operation_id, str) or not _OPERATION_ID.fullmatch(
            operation_id
        ):
            raise RpcFault(-32602, "Invalid params: operationId is invalid")
        return operation_id

    @contextmanager
    def _operation_scope(
        self,
        session_id: str,
        operation_id: str | None,
    ) -> Iterator[None]:
        if operation_id is None:
            yield
            return
        with self._state_lock:
            if session_id in self._active_operation_ids:
                raise RpcFault(-32003, "A Studio operation is already active")
            self._active_operation_ids[session_id] = operation_id
        try:
            yield
        finally:
            with self._state_lock:
                if self._active_operation_ids.get(session_id) == operation_id:
                    self._active_operation_ids.pop(session_id, None)

    def _current_operation_id(self, session_id: str) -> str | None:
        with self._state_lock:
            return self._active_operation_ids.get(session_id)

    def _operation_callback(
        self,
        session_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation_id = self._current_operation_id(session_id)
        if operation_id is None:
            return params
        return {**params, "operationId": operation_id}

    def _session_lock(self, session_id: str) -> threading.RLock:
        with self._state_lock:
            lock = self._session_locks.get(session_id)
            if lock is None:
                lock = threading.RLock()
                self._session_locks[session_id] = lock
            return lock

    def _provider_and_command_session(
        self,
        session_id: str,
        model_id: str,
    ) -> tuple[CherryModelProvider, CommandSynthesisSession]:
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        with self._state_lock:
            provider = self._providers.get(session_id)
            if provider is None:
                provider = CherryModelProvider(
                    self._peer,
                    session_id,
                    model_id,
                )
                self._providers[session_id] = provider
            command_session = self._command_sessions.get(session_id)
            if command_session is None:
                command_session = CommandSynthesisSession(
                    provider,
                    before_execute=lambda command, test, timeout_s: (
                        self._consume_command_execution(
                            session_id,
                            command,
                            test,
                            timeout_s,
                        )
                    ),
                    working_directory=self._project_root,
                )
                self._command_sessions[session_id] = command_session
            return provider, command_session

    def _consume_command_execution(
        self,
        session_id: str,
        command: str,
        test: bool,
        timeout_s: int,
    ) -> None:
        if self._peer is None:
            raise RpcFault(-32603, "RPC peer is not bound")
        result = self._peer.request(
            "approval.consume",
            self._operation_callback(
                session_id,
                {
                    "sessionId": session_id,
                    "tool": "execute_chemsmart_command",
                    "arguments": {
                        "command": command,
                        "test": test,
                        "timeout_s": timeout_s,
                    },
                },
            ),
            timeout=30,
        )
        if not isinstance(result, dict) or result.get("accepted") is not True:
            raise RpcFault(-32003, "Trusted Studio approval was not consumed")

    @staticmethod
    def _required_string(params: Any, key: str) -> str:
        if (
            not isinstance(params, dict)
            or not isinstance(params.get(key), str)
            or not params[key].strip()
        ):
            raise RpcFault(-32602, f"Invalid params: {key} must be a non-empty string")
        return params[key]

    @staticmethod
    def _optional_sequence(params: Any, key: str, default: int) -> int:
        if not isinstance(params, dict):
            raise RpcFault(-32602, "Invalid params: expected an object")
        value = params.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < -1:
            raise RpcFault(-32602, f"Invalid params: {key} must be an integer >= -1")
        return value
