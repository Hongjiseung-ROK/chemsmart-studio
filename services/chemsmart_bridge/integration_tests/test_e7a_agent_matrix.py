from __future__ import annotations

import json
import os
import stat
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import yaml

from chemsmart.agent.core import AgentSession
from chemsmart.agent.harness.intent import IntentSpec
from chemsmart.agent.permissions import (
    ApprovalDecision,
    PermissionMode,
    PermissionPolicy,
)
from chemsmart.agent.runtime import TaskPhase
from chemsmart.agent.runtime.tool_catalog import PhaseToolProfile
from chemsmart.agent.tools import (
    build_gaussian_settings,
    build_job,
    build_molecule,
    build_orca_settings,
)
from chemsmart.agent.tools_command import (
    register_command_intent,
    reset_command_tools_state,
)
from chemsmart.agent.v8_adapter import adapt
from chemsmart.jobs.runner import JobRunner
from chemsmart.settings.server import Server
from chemsmart_studio_bridge.runtime import (
    SAFE_STUDIO_TOOLS,
    STUDIO_AGENT_TOOL_PROFILE,
    StudioAgentRuntime,
)

_MATRIX = Path(__file__).with_name("fixtures") / "e7a_agent_matrix.json"
_VARIANT_DIMENSIONS = ("english", "korean", "mixed", "stress")
_CLI_PROFILE = PhaseToolProfile(
    {
        TaskPhase.EXECUTION: (
            "execute_chemsmart_command",
        )
    }
)


class ScriptedProvider:
    name = "openai"
    wire_protocol = "openai"
    default_model = "deterministic-e7a-matrix"

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def chat(self, messages, tools=None, timeout_s=30):
        self.calls.append(
            {
                "messages": messages,
                "tools": tools,
                "timeout_s": timeout_s,
            }
        )
        return self.responses.pop(0)


class MatrixPeer:
    def __init__(self) -> None:
        self.requests: list[tuple[str, Any]] = []

    def request(
        self,
        method: str,
        params: Any = None,
        timeout: float = 120.0,
    ) -> Any:
        del timeout
        self.requests.append((method, params))
        if method == "agent.trace":
            return {"accepted": True}
        if method == "approval.consume":
            assert params["tool"] == "execute_chemsmart_command"
            assert set(params["arguments"]) == {"command", "test", "timeout_s"}
            return {"accepted": True}
        if method == "molecule.request":
            return {
                "previewId": "preview-1",
                "committed": False,
                "discarded": params["method"] == "molecule.discard_preview",
            }
        if method == "calculation.request":
            if params["request"]["tool"] == "analyze_current_molecule":
                return {
                    "type": "current_molecule_analysis",
                    "molecule": {
                        "documentId": "mol-water",
                        "revision": 3,
                        "atoms": [
                            {
                                "id": "a-1",
                                "atomicNumber": 8,
                                "position": [0.0, 0.0, 0.0],
                                "formalCharge": 0,
                                "extensions": {},
                            },
                            {
                                "id": "a-2",
                                "atomicNumber": 1,
                                "position": [0.9572, 0.0, 0.0],
                                "formalCharge": 0,
                                "extensions": {},
                            },
                            {
                                "id": "a-3",
                                "atomicNumber": 1,
                                "position": [-0.239, 0.927, 0.0],
                                "formalCharge": 0,
                                "extensions": {},
                            },
                        ],
                        "bonds": [
                            {
                                "id": "b-1",
                                "atomIds": ["a-1", "a-2"],
                                "order": 1,
                                "extensions": {},
                            },
                            {
                                "id": "b-2",
                                "atomIds": ["a-1", "a-3"],
                                "order": 1,
                                "extensions": {},
                            },
                        ],
                        "selections": [],
                        "frozenAxes": {},
                        "constraints": [],
                        "properties": {
                            "name": "water",
                            "charge": 0,
                            "multiplicity": 1,
                            "extensions": {},
                        },
                        "extensions": {},
                    },
                    "geometryHash": "sha256:bbc8d0f0f7818866f9ac9c9b9c77aeb1b7cf58cf806703b8839c53b50c0cab87",
                    "binding": {
                        "state": "committed",
                        "documentId": "mol-water",
                        "revision": 3,
                        "geometryHash": "sha256:bbc8d0f0f7818866f9ac9c9b9c77aeb1b7cf58cf806703b8839c53b50c0cab87",
                    },
                    "atomCount": 3,
                    "bondCount": 2,
                    "elementCounts": [
                        {"atomicNumber": 1, "count": 2},
                        {"atomicNumber": 8, "count": 1},
                    ],
                    "formula": "H2O",
                    "charge": 0,
                    "multiplicity": 1,
                    "extensions": {},
                }
            return {
                "type": "studio_context",
                "sessionId": params["sessionId"],
                "document": {
                    "documentId": "ethanol",
                    "revision": 3,
                    "geometryHash": f"sha256:{'1' * 64}",
                },
                "activeRun": None,
                "extensions": {},
            }
        raise AssertionError(f"unexpected matrix RPC request: {method}")

    def notify(self, method: str, params: Any = None) -> None:
        raise AssertionError(f"unexpected matrix notification: {method}")


def _tool_call(
    call_id: str,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, sort_keys=True),
        },
    }


def _tool_response(*calls: dict[str, Any]) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": list(calls),
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


def _final_response(
    message: str = "Deterministic validation complete.",
) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": message},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 8, "completion_tokens": 4},
    }


def _load_matrix() -> dict[str, Any]:
    return json.loads(_MATRIX.read_text(encoding="utf-8"))


def _expanded_cases(matrix: dict[str, Any]) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for seed in matrix["seeds"]:
        for index, request in enumerate(seed["requests"]):
            cases.append(
                {
                    **seed,
                    "caseId": f"{seed['id']}::{_VARIANT_DIMENSIONS[index]}",
                    "variant": _VARIANT_DIMENSIONS[index],
                    "request": request,
                }
            )
    return cases


def test_e7a_matrix_contract_covers_required_inputs() -> None:
    matrix = _load_matrix()
    cases = _expanded_cases(matrix)
    tags = {
        str(tag) for seed in matrix["seeds"] for tag in seed.get("tags", [])
    }

    assert matrix["schemaVersion"] == 1
    assert tuple(matrix["variantDimensions"]) == _VARIANT_DIMENSIONS
    assert len(matrix["seeds"]) >= 12
    assert len(cases) >= 60
    assert len({case["caseId"] for case in cases}) == len(cases)
    assert all(len(seed["requests"]) == 4 for seed in matrix["seeds"])
    assert {
        "greeting",
        "conceptual-chemistry",
        "current-molecule",
        "transient-focus",
        "distance",
        "angle",
        "dihedral",
        "preview",
        "atom",
        "element",
        "periodic-table",
        "bond-order",
        "constraint",
        "approval",
        "denial",
        "revision",
        "prompt-injection",
        "secrets",
        "raw-path",
        "unrestricted-read",
        "gaussian",
        "opt",
        "freq",
        "transition-state",
        "scan",
        "modred",
        "tddft",
        "dias",
        "orca",
        "single-point",
        "database-selector",
        "fake-local",
        "fake-scheduler",
        "submission-script",
    } <= tags


def test_e7a_deterministic_matrix_uses_real_agent_and_fake_runners(
    tmp_path: Path,
) -> None:
    matrix = _load_matrix()
    cases = _expanded_cases(matrix)
    results = []

    for case in cases:
        case_root = tmp_path / case["caseId"].replace("::", "-")
        case_root.mkdir(parents=True)
        with _isolated_chemsmart_workspace(case_root):
            reset_command_tools_state()
            result = _run_case(case, case_root)
        results.append(result)

    assert len(results) == len(cases)
    assert len(results) >= 60
    failures = [result for result in results if not result["passed"]]
    assert not failures, json.dumps(failures, indent=2, sort_keys=True)
    assert all(result["runtimeMode"] == "active" for result in results)
    assert all(result["phaseProfileBound"] for result in results)
    assert all(result["evidenceReceipt"] for result in results)
    assert sum(result["fakeRunnerSelected"] for result in results) >= 24
    assert all(result["trustedUiEvents"] == 0 for result in results)
    assert sum(result["approvalDenied"] for result in results) >= 8
    assert sum(result["semanticRejected"] for result in results) >= 8


def test_e7a_fake_runner_factory_selects_only_fake_implementations(
    tmp_path: Path,
) -> None:
    case_root = tmp_path / "runner-contract"
    case_root.mkdir()
    with _isolated_chemsmart_workspace(case_root):
        molecule = build_molecule("water.xyz")
        server = Server.from_servername("local")
        jobs = (
            build_job(
                "gaussian.opt",
                molecule=molecule,
                settings=build_gaussian_settings("B3LYP", "def2-SVP"),
            ),
            build_job(
                "orca.sp",
                molecule=molecule,
                settings=build_orca_settings("B3LYP", "def2-SVP"),
            ),
        )

        runners = [
            JobRunner.from_job(
                job,
                server=server,
                scratch=False,
                fake=True,
            )
            for job in jobs
        ]

    assert all(runner.FAKE is True for runner in runners)
    assert [type(runner).__name__ for runner in runners] == [
        "FakeGaussianJobRunner",
        "FakeORCAJobRunner",
    ]


def _run_case(case: dict[str, Any], case_root: Path) -> dict[str, Any]:
    lane = case["lane"]
    if lane == "conversation":
        return _run_conversation_case(case, case_root)
    if lane == "studio":
        return _run_studio_case(case, case_root)
    if lane in {"cli-fake", "cli-reject", "cli-submit-fake"}:
        return _run_cli_case(case, case_root)
    raise AssertionError(f"unknown E7A matrix lane: {lane}")


def _run_conversation_case(
    case: dict[str, Any],
    case_root: Path,
) -> dict[str, Any]:
    peer = MatrixPeer()
    runtime = StudioAgentRuntime(case_root / "adapter").bind_peer(peer)
    provider = ScriptedProvider([_final_response("Safe advisory response.")])
    session = AgentSession(
        provider=provider,
        registry=runtime._studio_registry(case["caseId"]),
        session_root=case_root / "sessions",
        runtime_v2="active",
        tool_profile=STUDIO_AGENT_TOOL_PROFILE,
    )

    result = session.run_loop(
        case["request"],
        policy=_studio_policy(),
        approver=lambda _request: ApprovalDecision.DENY,
    )

    return _receipt(
        case,
        result,
        passed=not result["tool_requests"],
        peer=peer,
    )


def _run_studio_case(
    case: dict[str, Any],
    case_root: Path,
) -> dict[str, Any]:
    peer = MatrixPeer()
    runtime = StudioAgentRuntime(case_root / "adapter").bind_peer(peer)
    provider = ScriptedProvider(
        [
            _tool_response(
                _tool_call(
                    f"call-{case['caseId']}",
                    case["tool"],
                    case["arguments"],
                )
            ),
            _final_response(),
        ]
    )
    session = AgentSession(
        provider=provider,
        registry=runtime._studio_registry(case["caseId"]),
        session_root=case_root / "sessions",
        runtime_v2="active",
        tool_profile=STUDIO_AGENT_TOOL_PROFILE,
    )
    decision = ApprovalDecision(case.get("approval", "deny"))
    result = session.run_loop(
        case["request"],
        policy=_studio_policy(),
        approver=lambda _request: decision,
    )
    outcome = result["tool_outcomes"][0]
    passed = outcome.status == case["expectedStatus"]
    if case["tool"] == "read" and outcome.status == "error":
        passed = passed and outcome.error_type == "ToolExposureViolation"

    return _receipt(
        case,
        result,
        passed=passed,
        peer=peer,
        approval_denied=outcome.status == "denied",
    )


def _run_cli_case(
    case: dict[str, Any],
    case_root: Path,
) -> dict[str, Any]:
    peer = MatrixPeer()
    runtime = StudioAgentRuntime(case_root / "adapter").bind_peer(peer)
    studio_registry = runtime._studio_registry(case["caseId"])
    # Production Studio exposes this exact execution tool behind a one-shot trusted card. The matrix
    # keeps execution fake while exercising the same registry the model receives.
    registry = studio_registry

    if case["lane"] == "cli-fake":
        adapted = adapt(json.dumps(case["spec"]), default_project="demo")
        assert adapted["valid"], adapted["errors"]
        command = adapted["commands"][0]
        register_command_intent(command, IntentSpec(**case["intent"]))
    else:
        command = case["command"]
        if case["lane"] == "cli-submit-fake":
            register_command_intent(
                command,
                IntentSpec(
                    action="sub",
                    program="gaussian",
                    kind="gaussian.sp",
                    project="demo",
                    server="hpc1",
                    input_path="water.xyz",
                    charge=0,
                    multiplicity=1,
                    execution_mode="submit",
                ),
            )

    provider = ScriptedProvider(
        [
            _tool_response(
                _tool_call(
                    f"execute-{case['caseId']}",
                    "execute_chemsmart_command",
                    {"command": command, "test": True, "timeout_s": 30},
                ),
            ),
            _final_response(),
        ]
    )
    session = AgentSession(
        provider=provider,
        registry=registry,
        session_root=case_root / "sessions",
        runtime_v2="active",
        tool_profile=_CLI_PROFILE,
    )
    result = session.run_loop(
        case["request"],
        policy=PermissionPolicy(
            mode=PermissionMode.PERMISSION,
            prompt_risky=True,
            session_allow=set(),
            xtb_real_runs="ask",
        ),
        approver=lambda _request: ApprovalDecision.ALLOW_ONCE,
    )
    command_outcome = result["tool_outcomes"][0]
    raw = command_outcome.raw_result or {}
    semantic = raw.get("semantic") or {}
    semantic_rules = semantic.get("failed_rule_ids") or []
    executed_argv = raw.get("executed_argv") or []
    stdout = str(raw.get("stdout_tail") or "")
    terminal = raw.get("terminal_state") or {}
    generated_inputs = list(case_root.joinpath("workspace").glob("*_fake.*"))

    fake_runner_selected = (
        "--fake" in executed_argv
        and any(
            path.name.endswith(("_fake.com", "_fake.inp"))
            for path in generated_inputs
        )
        and (
            "FakeGaussianJobRunner" in stdout
            or "FakeORCAJobRunner" in stdout
            or raw.get("returncode") == 0
        )
    )
    if case["lane"] == "cli-fake":
        passed = (
            command_outcome.status == "ok"
            and raw.get("test") is True
            and raw.get("returncode") == 0
            and "--fake" in executed_argv
            and semantic.get("verdict") in {"ok", "warn"}
            and terminal.get("status") == "passed"
            and fake_runner_selected
            and bool(generated_inputs)
        )
    elif case["lane"] == "cli-reject":
        expected_rule = case["expectedRule"]
        passed = (
            command_outcome.status == "error"
            and semantic.get("verdict") == "reject"
            and any(
                str(rule).startswith(expected_rule) for rule in semantic_rules
            )
            and not executed_argv
            and not generated_inputs
        )
    else:
        submit_scripts = [
            path
            for path in case_root.joinpath("workspace").iterdir()
            if path.suffix in {".sh", ".pbs", ".slurm"}
        ]
        passed = (
            command_outcome.status == "ok"
            and raw.get("test") is True
            and raw.get("returncode") == 0
            and "--fake" in executed_argv
            and "--test" in executed_argv
            and bool(submit_scripts)
        )

    return _receipt(
        case,
        result,
        passed=passed,
        peer=peer,
        fake_runner_selected=fake_runner_selected,
        semantic_rejected=semantic.get("verdict") == "reject",
    )


def _receipt(
    case: dict[str, Any],
    result: dict[str, Any],
    *,
    passed: bool,
    peer: MatrixPeer,
    fake_runner_selected: bool = False,
    semantic_rejected: bool = False,
    approval_denied: bool = False,
) -> dict[str, Any]:
    runtime = result["runtime_v2"]
    return {
        "caseId": case["caseId"],
        "seed": case["id"],
        "variant": case["variant"],
        "lane": case["lane"],
        "passed": passed,
        "runtimeMode": runtime["mode"],
        "phase": runtime["phase"],
        "phaseProfileBound": runtime["mode"] == "active",
        "toolRequests": [request.name for request in result["tool_requests"]],
        "toolStatuses": [
            outcome.status for outcome in result["tool_outcomes"]
        ],
        "toolErrorTypes": [
            outcome.error_type for outcome in result["tool_outcomes"]
        ],
        "toolErrors": [
            outcome.error_message for outcome in result["tool_outcomes"]
        ],
        "fakeRunnerSelected": fake_runner_selected,
        "semanticRejected": semantic_rejected,
        "trustedUiEvents": sum(
            method == "studio_ui.event" for method, _params in peer.requests
        ),
        "approvalDenied": approval_denied,
        "evidenceReceipt": True,
    }


def _studio_policy() -> PermissionPolicy:
    return PermissionPolicy(
        mode=PermissionMode.PERMISSION,
        prompt_risky=True,
        session_allow=set(SAFE_STUDIO_TOOLS),
        xtb_real_runs="ask",
    )


@contextmanager
def _isolated_chemsmart_workspace(
    case_root: Path,
) -> Iterator[None]:
    workspace = case_root / "workspace"
    home = case_root / "home"
    binary_dir = case_root / "bin"
    workspace.mkdir()
    home.mkdir()
    binary_dir.mkdir()
    _write_workspace_fixture(workspace)
    _write_server_fixture(home)
    _write_clean_chemsmart_wrapper(binary_dir)

    previous_cwd = Path.cwd()
    previous_path = os.environ.get("PATH", "")
    previous_home = os.environ.get("HOME")
    os.environ["PATH"] = f"{binary_dir}:{previous_path}"
    os.environ["HOME"] = str(home)
    os.chdir(workspace)
    try:
        yield
    finally:
        os.chdir(previous_cwd)
        os.environ["PATH"] = previous_path
        if previous_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = previous_home


def _write_workspace_fixture(workspace: Path) -> None:
    (workspace / "water.xyz").write_text(
        "3\nwater\nO 0 0 0\nH 0 0 0.96\nH 0.92 0 -0.24\n",
        encoding="utf-8",
    )
    for program in ("gaussian", "orca"):
        project_dir = workspace / ".chemsmart" / program
        project_dir.mkdir(parents=True)
        (project_dir / "demo.yaml").write_text(
            "gas:\n"
            "  functional: b3lyp\n"
            "  basis: def2svp\n"
            "solv:\n"
            "  functional: b3lyp\n"
            "  basis: def2svp\n"
            "td:\n"
            "  functional: cam-b3lyp\n"
            "  basis: def2svp\n",
            encoding="utf-8",
        )


def _write_server_fixture(home: Path) -> None:
    server_dir = home / ".chemsmart" / "server"
    server_dir.mkdir(parents=True)
    local = {
        "SERVER": {"SCHEDULER": None, "NUM_CORES": 1},
        "GAUSSIAN": {
            "EXEFOLDER": "/tmp",
            "LOCAL_RUN": True,
            "SCRATCH": False,
        },
        "ORCA": {
            "EXEFOLDER": "/tmp",
            "LOCAL_RUN": True,
            "SCRATCH": False,
        },
    }
    hpc = {
        "SERVER": {
            "SCHEDULER": "PBS",
            "QUEUE_NAME": "normal",
            "NUM_HOURS": 1,
            "MEM_GB": 4,
            "NUM_CORES": 1,
            "NUM_THREADS": 1,
            "SUBMIT_COMMAND": "qsub",
            "SCRATCH_DIR": None,
        },
        "GAUSSIAN": {
            "EXEFOLDER": "/tmp",
            "LOCAL_RUN": False,
            "SCRATCH": False,
        },
    }
    (server_dir / "local.yaml").write_text(
        yaml.safe_dump(local),
        encoding="utf-8",
    )
    (server_dir / "hpc1.yaml").write_text(
        yaml.safe_dump(hpc),
        encoding="utf-8",
    )


def _write_clean_chemsmart_wrapper(binary_dir: Path) -> None:
    repository = Path(__file__).resolve().parents[3]
    python = (
        repository
        / "services"
        / "chemsmart_bridge"
        / ".venv"
        / "bin"
        / "python"
    )
    source = repository / "vendor" / "chemsmart"
    wrapper = binary_dir / "chemsmart"
    wrapper.write_text(
        "#!/bin/sh\n"
        f'PYTHONPATH={source} exec {python} -m chemsmart.cli.main "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
