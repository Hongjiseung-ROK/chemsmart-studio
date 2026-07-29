#!/usr/bin/env python3
"""Run the bounded E7A live-provider matrix without chemistry execution."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import yaml

from chemsmart.agent.core import AgentSession
from chemsmart.agent.harness.intent import IntentSpec, evaluate_intent
from chemsmart.agent.harness.workflow_state import select_workspace_project
from chemsmart.agent.loop import ToolLoopBudgets
from chemsmart.agent.permissions import (
    ApprovalDecision,
    PermissionMode,
    PermissionPolicy,
)
from chemsmart.agent.providers import get_provider
from chemsmart.agent.public_visibility import (
    sanitize_public_payload,
    sanitize_public_text,
)
from chemsmart.agent.registry import ToolRegistry
from chemsmart.agent.runtime import TaskPhase
from chemsmart.agent.runtime.tool_catalog import PhaseToolProfile
from chemsmart.agent.tools_command import reset_command_tools_state
from chemsmart_studio_bridge.runtime import (
    SAFE_STUDIO_TOOLS,
    StudioAgentRuntime,
)

ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = (
    ROOT
    / "services"
    / "chemsmart_bridge"
    / "integration_tests"
    / "fixtures"
    / "e7a_agent_matrix.json"
)
VARIANTS = ("english", "korean", "mixed", "stress")
SELECTED_CASES = (
    ("greeting", "english"),
    ("conceptual-chemistry", "korean"),
    ("current-molecule", "mixed"),
    ("focus-and-measure", "stress"),
    ("preview-atom-element", "korean"),
    ("preview-bond-constraint", "mixed"),
    ("commit-denied", "stress"),
    ("start-denied", "korean"),
    ("prompt-injection", "stress"),
    ("gaussian-opt-freq", "english"),
    ("gaussian-ts", "korean"),
    ("gaussian-scan-modred", "mixed"),
    ("gaussian-tddft", "stress"),
    ("orca-sp", "english"),
    ("orca-ts", "korean"),
    ("fake-scheduler", "stress"),
)
PRIVATE_REASONING_KEYS = frozenset(
    {"reasoning_content", "thinking", "analysis", "<think>"}
)
PRICING_USD_PER_MILLION = {
    "cacheHitInput": 0.003625,
    "cacheMissInput": 0.435,
    "output": 0.87,
}
PRICING_SOURCES = (
    "https://api-docs.deepseek.com/quick_start/pricing",
    "https://api-docs.deepseek.com/api/create-chat-completion",
)


class LiveMatrixPeer:
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
        if method == "studio_ui.event":
            return {
                "accepted": True,
                "eventId": params["eventId"],
                "sequence": params["sequence"],
            }
        if method == "molecule.request":
            return {
                "previewId": "preview-live-1",
                "committed": False,
                "discarded": params["method"] == "molecule.discard_preview",
            }
        if method == "calculation.request":
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
        raise AssertionError(f"unexpected live-matrix RPC method: {method}")

    def notify(self, method: str, params: Any = None) -> None:
        raise AssertionError(
            f"unexpected live-matrix notification: {method} {params!r}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--case",
        action="append",
        choices=[case_id for case_id, _variant in SELECTED_CASES],
        dest="case_ids",
    )
    args = parser.parse_args()

    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    seeds = {seed["id"]: seed for seed in matrix["seeds"]}
    selected_cases = (
        tuple(item for item in SELECTED_CASES if item[0] in set(args.case_ids))
        if args.case_ids
        else SELECTED_CASES
    )
    root = Path(tempfile.mkdtemp(prefix="chemsmart-e7a-live-matrix-"))
    os.environ.setdefault("CHEMSMART_AGENT_TRAINING_DIR", str(root / "training"))
    provider = get_provider()
    started = datetime.now(timezone.utc)
    artifact: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "in_progress",
        "startedAtUtc": started.isoformat().replace("+00:00", "Z"),
        "completedAtUtc": None,
        "configuredModel": getattr(provider, "default_model", None),
        "configuredProvider": getattr(provider, "name", None),
        "caseCount": len(selected_cases),
        "fixtureSha256": _sha256(MATRIX_PATH.read_bytes()),
        "pricingUsdPerMillionTokens": PRICING_USD_PER_MILLION,
        "pricingSources": list(PRICING_SOURCES),
        "executionBoundary": {
            "realChemistry": False,
            "executionToolExposed": False,
            "schedulerContact": False,
            "parallelism": 1,
        },
        "cases": [],
        "totals": {},
    }
    _write_artifact(args.output, artifact)

    for case_id, variant in selected_cases:
        seed = seeds[case_id]
        request = seed["requests"][VARIANTS.index(variant)]
        case_root = root / f"{case_id}-{variant}"
        case_root.mkdir()
        try:
            if seed["lane"] == "conversation":
                result = _run_conversation(provider, seed, request, variant, case_root)
            elif seed["lane"] == "studio":
                result = _run_studio(provider, seed, request, variant, case_root)
            else:
                result = _run_synthesis(provider, seed, request, variant, case_root)
        except Exception as exc:
            result = {
                "caseId": case_id,
                "variant": variant,
                "lane": seed["lane"],
                "request": request,
                "passed": False,
                "failureClass": "harness_exception",
                "failureEvidence": sanitize_public_text(
                    f"{exc.__class__.__name__}: {str(exc)[:500]}"
                ),
                "assistantOutput": "",
                "assistantOutputSha256": _sha256(b""),
                "toolRequests": [],
                "toolStatuses": [],
                "providerResponses": [],
                "privateReasoningAbsent": True,
            }
        artifact["cases"].append(result)
        artifact["totals"] = _totals(artifact["cases"])
        _write_artifact(args.output, artifact)
        print(
            json.dumps(
                {
                    "caseId": result["caseId"],
                    "passed": result["passed"],
                    "toolRequests": result["toolRequests"],
                    "toolStatuses": result["toolStatuses"],
                    "responseCount": len(result["providerResponses"]),
                },
                sort_keys=True,
            ),
            flush=True,
        )

    completed = datetime.now(timezone.utc)
    artifact["status"] = (
        "passed" if all(case["passed"] for case in artifact["cases"]) else "failed"
    )
    artifact["completedAtUtc"] = completed.isoformat().replace("+00:00", "Z")
    artifact["durationSeconds"] = round((completed - started).total_seconds(), 3)
    artifact["totals"] = _totals(artifact["cases"])
    _write_artifact(args.output, artifact)
    print(json.dumps({"final": artifact["totals"]}, sort_keys=True))
    return 0 if artifact["status"] == "passed" else 1


def _run_conversation(
    provider: Any,
    seed: dict[str, Any],
    request: str,
    variant: str,
    case_root: Path,
) -> dict[str, Any]:
    session = AgentSession(
        provider=provider,
        registry=ToolRegistry([]),
        session_root=case_root / "sessions",
        runtime_v2="active",
        tool_profile=_single_tool_profile(None),
    )
    result = session.run_loop(
        request,
        budgets=_budgets(),
        policy=_policy(set()),
        approver=lambda _request: ApprovalDecision.DENY,
    )
    passed = not result["tool_requests"] and not result["provider_errors"]
    return _case_result(seed, variant, request, result, passed=passed)


def _run_studio(
    provider: Any,
    seed: dict[str, Any],
    request: str,
    variant: str,
    case_root: Path,
) -> dict[str, Any]:
    expected_tool = str(seed["tool"])
    exposed_tool = None if expected_tool == "read" else expected_tool
    peer = LiveMatrixPeer()
    runtime = StudioAgentRuntime(case_root / "adapter").bind_peer(peer)
    session_id = f"live-{seed['id']}-{variant}"
    registry = runtime._studio_registry(
        session_id,
        runtime._studio_ui_emitter(session_id),
    )
    session = AgentSession(
        provider=provider,
        registry=registry,
        session_root=case_root / "sessions",
        runtime_v2="active",
        tool_profile=_single_tool_profile(exposed_tool),
    )
    augmented_request = request
    if exposed_tool is not None:
        arguments = seed.get("arguments") or {}
        if arguments:
            input_instruction = (
                "The function input object itself must be exactly "
                f"{json.dumps(arguments, sort_keys=True)}. Do not wrap it "
                "inside an `arguments` property."
            )
        else:
            input_instruction = (
                "Call it with no parameters: the function input object is "
                "exactly {}. Do not add an `arguments` property."
            )
        augmented_request = (
            f"{request}\nCall {exposed_tool} exactly once. "
            f"{input_instruction} Then summarize the literal result."
        )
        if seed.get("approval") == "deny":
            augmented_request += (
                " Do not call ask_user. The trusted approval callback will "
                "make the decision; invoke the requested function so that "
                "the denial boundary is exercised."
            )
    result = session.run_loop(
        augmented_request,
        budgets=_budgets(),
        policy=_policy(set(SAFE_STUDIO_TOOLS)),
        approver=lambda _request: ApprovalDecision.DENY,
    )
    names = [item.name for item in result["tool_requests"]]
    statuses = [item.status for item in result["tool_outcomes"]]
    if exposed_tool is None:
        passed = (
            expected_tool not in names
            and not peer.requests
            and not result["provider_errors"]
        )
    elif seed.get("approval") == "deny":
        passed = (
            names == [expected_tool] and statuses == ["denied"] and not peer.requests
        )
    else:
        passed = names == [expected_tool] and statuses == ["ok"]
    return _case_result(
        seed,
        variant,
        request,
        result,
        passed=passed,
        extra={
            "rpcMethods": [method for method, _params in peer.requests],
            "exposedTool": exposed_tool,
        },
    )


def _run_synthesis(
    provider: Any,
    seed: dict[str, Any],
    request: str,
    variant: str,
    case_root: Path,
) -> dict[str, Any]:
    reset_command_tools_state()
    synthesis_request = _grounded_synthesis_request(seed, request)
    tool_input = json.dumps(
        {"request": synthesis_request},
        ensure_ascii=False,
        sort_keys=True,
    )
    with _workspace(case_root), _provider_override(provider):
        expected_intent = _expected_intent(seed)
        if (
            expected_intent is not None
            and expected_intent.project
            and expected_intent.program
        ):
            selection = select_workspace_project(
                expected_intent.project,
                expected_intent.program,
            )
            if selection.get("selected") is not True:
                raise RuntimeError("fixture workspace project selection failed")
        session = AgentSession(
            provider=provider,
            registry=ToolRegistry.default(),
            session_root=case_root / "sessions",
            runtime_v2="active",
            tool_profile=_single_tool_profile("synthesize_command"),
        )
        result = session.run_loop(
            "Perform synthesis-only fake/test validation. Call "
            "synthesize_command exactly once. The function input object "
            f"itself must be exactly {tool_input}. Do not paraphrase it or "
            "wrap it inside an `arguments` property. Do not execute, submit, "
            "or contact a scheduler.",
            budgets=_budgets(),
            policy=_policy({"synthesize_command"}),
            approver=lambda _request: ApprovalDecision.DENY,
        )
    names = [item.name for item in result["tool_requests"]]
    statuses = [item.status for item in result["tool_outcomes"]]
    raw = result["tool_outcomes"][0].raw_result if result["tool_outcomes"] else {}
    raw = raw if isinstance(raw, dict) else {}
    command = str(raw.get("command") or "")
    semantic = raw.get("semantic")
    semantic = semantic if isinstance(semantic, dict) else {}
    expected_intent = _expected_intent(seed)
    intent = (
        evaluate_intent(command, expected_intent).to_dict()
        if command and expected_intent is not None
        else None
    )
    passed = (
        names == ["synthesize_command"]
        and statuses == ["ok"]
        and semantic.get("verdict") in {"ok", "warn"}
        and intent is not None
        and intent.get("verdict") == "ok"
        and "execute_chemsmart_command" not in names
    )
    return _case_result(
        seed,
        variant,
        request,
        result,
        passed=passed,
        extra={
            "synthesizedCommand": command,
            "semanticVerdict": semantic.get("verdict"),
            "semanticFailedRuleIds": semantic.get("failed_rule_ids") or [],
            "intentVerdict": intent.get("verdict") if intent else None,
            "intentFailedRuleIds": (intent.get("failed_rule_ids") if intent else []),
        },
    )


def _case_result(
    seed: dict[str, Any],
    variant: str,
    request: str,
    result: dict[str, Any],
    *,
    passed: bool,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    private_absent = not _contains_private_reasoning(result)
    responses = list(result.get("provider_responses") or [])
    model_exact = bool(responses) and all(
        item.get("model") == "deepseek-v4-pro"
        and isinstance(item.get("response_id"), str)
        and item["response_id"]
        for item in responses
    )
    assistant = str(result.get("assistant_output") or "")
    public_paths_absent = sanitize_public_payload(
        {
            "assistantOutput": assistant,
            "messages": result.get("messages") or [],
        }
    ) == {
        "assistantOutput": assistant,
        "messages": result.get("messages") or [],
    }
    passed = (
        passed
        and private_absent
        and public_paths_absent
        and model_exact
        and not result.get("provider_errors")
    )
    payload = {
        "caseId": seed["id"],
        "variant": variant,
        "lane": seed["lane"],
        "request": request,
        "passed": passed,
        "failureClass": None if passed else "live_provider_validation",
        "failureEvidence": (
            None
            if passed
            else "Observed tool, semantic, intent, model, or privacy evidence "
            "did not match the bounded case contract."
        ),
        "assistantOutput": assistant[:2000],
        "assistantOutputSha256": _sha256(assistant.encode()),
        "toolRequests": [item.name for item in result["tool_requests"]],
        "toolStatuses": [item.status for item in result["tool_outcomes"]],
        "providerResponses": responses,
        "privateReasoningAbsent": private_absent,
        "publicFilesystemPathsAbsent": public_paths_absent,
        "exactModel": model_exact,
    }
    if extra:
        payload.update(extra)
    return payload


def _single_tool_profile(tool_name: str | None) -> PhaseToolProfile:
    names = (tool_name,) if tool_name else ()
    return PhaseToolProfile({phase: names for phase in TaskPhase})


def _budgets() -> ToolLoopBudgets:
    return ToolLoopBudgets(
        max_model_steps_per_turn=4,
        max_total_tool_calls_per_turn=2,
        max_same_signature_retries=1,
        max_provider_errors_per_turn=1,
        log_provider_turn_raw=False,
    )


def _policy(session_allow: set[str]) -> PermissionPolicy:
    return PermissionPolicy(
        mode=PermissionMode.PERMISSION,
        prompt_risky=True,
        session_allow=session_allow,
        xtb_real_runs="deny",
    )


def _expected_intent(seed: dict[str, Any]) -> IntentSpec | None:
    if isinstance(seed.get("intent"), dict):
        return IntentSpec(**seed["intent"])
    if seed["id"] == "fake-scheduler":
        return IntentSpec(
            action="sub",
            program="gaussian",
            kind="gaussian.sp",
            project="demo",
            server="hpc1",
            input_path="water.xyz",
            charge=0,
            multiplicity=1,
            execution_mode="submit",
        )
    return None


def _grounded_synthesis_request(
    seed: dict[str, Any],
    request: str,
) -> str:
    expected = _expected_intent(seed)
    if expected is None:
        return request
    contract = {
        key: value for key, value in expected.to_dict().items() if value is not None
    }
    context = []
    if expected.input_path and expected.project and expected.program:
        context.append(
            f"Use {expected.input_path} using the {expected.project} project "
            f"for {expected.program}."
        )
    if expected.action == "run":
        context.append("Use chemsmart run syntax for fake validation.")
    elif expected.action == "sub":
        context.append("Use chemsmart sub syntax to generate the fake scheduler input.")
    if expected.server:
        context.append(f"Use server {expected.server}.")
    if expected.charge is not None:
        context.append(f"Use charge {expected.charge}.")
    if expected.multiplicity is not None:
        context.append(f"Use multiplicity {expected.multiplicity}.")
    if expected.kind == "gaussian.tddft" and expected.chemistry.get("eqsolv"):
        context.append(
            "The eqsolv CLI option requires its enum value: render "
            "`--eqsolv eqsolv`, never a bare `--eqsolv` flag."
        )
    return (
        f"{request}\n"
        f"{' '.join(context)}\n"
        "Treat this deterministic acceptance contract as explicit user "
        f"intent: {json.dumps(contract, ensure_ascii=False, sort_keys=True)}."
    )


@contextmanager
def _workspace(case_root: Path) -> Iterator[None]:
    workspace = case_root / "workspace"
    workspace.mkdir()
    home = case_root / "home"
    server_dir = home / ".chemsmart" / "server"
    server_dir.mkdir(parents=True)
    (server_dir / "hpc1.yaml").write_text(
        yaml.safe_dump(
            {
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
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    (workspace / "water.xyz").write_text(
        "3\nwater\nO 0 0 0\nH 0 0 0.96\nH 0.92 0 -0.24\n",
        encoding="utf-8",
    )
    for program in ("gaussian", "orca"):
        project = workspace / ".chemsmart" / program
        project.mkdir(parents=True)
        (project / "demo.yaml").write_text(
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
    previous = Path.cwd()
    previous_home = os.environ.get("HOME")
    previous_userprofile = os.environ.get("USERPROFILE")
    os.chdir(workspace)
    os.environ["HOME"] = str(home)
    os.environ["USERPROFILE"] = str(home)
    try:
        yield
    finally:
        os.chdir(previous)
        _restore_environment("HOME", previous_home)
        _restore_environment("USERPROFILE", previous_userprofile)


@contextmanager
def _provider_override(provider: Any) -> Iterator[None]:
    from chemsmart.agent import providers

    original = providers.get_provider
    providers.get_provider = lambda *_args, **_kwargs: provider
    try:
        yield
    finally:
        providers.get_provider = original


def _restore_environment(name: str, value: str | None) -> None:
    if value is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = value


def _contains_private_reasoning(value: Any) -> bool:
    if isinstance(value, dict):
        if any(str(key).lower() in PRIVATE_REASONING_KEYS for key in value):
            return True
        return any(_contains_private_reasoning(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_contains_private_reasoning(item) for item in value)
    return isinstance(value, str) and "<think" in value.lower()


def _totals(cases: list[dict[str, Any]]) -> dict[str, Any]:
    usage = {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheHitTokens": 0,
        "cacheMissTokens": 0,
        "reasoningTokens": 0,
    }
    response_ids: list[str] = []
    for case in cases:
        for response in case["providerResponses"]:
            response_id = response.get("response_id")
            if isinstance(response_id, str):
                response_ids.append(response_id)
            metrics = response.get("usage") or {}
            for field, key in (
                ("inputTokens", "input_tokens"),
                ("outputTokens", "output_tokens"),
                ("cacheHitTokens", "cache_hit_tokens"),
                ("cacheMissTokens", "cache_miss_tokens"),
                ("reasoningTokens", "reasoning_tokens"),
            ):
                value = metrics.get(key)
                if type(value) is int:
                    usage[field] += value
    estimated_cost = (
        usage["cacheHitTokens"] * PRICING_USD_PER_MILLION["cacheHitInput"]
        + usage["cacheMissTokens"] * PRICING_USD_PER_MILLION["cacheMissInput"]
        + usage["outputTokens"] * PRICING_USD_PER_MILLION["output"]
    ) / 1_000_000
    return {
        "passed": sum(bool(case["passed"]) for case in cases),
        "failed": sum(not bool(case["passed"]) for case in cases),
        "responseCount": len(response_ids),
        "uniqueResponseIds": len(set(response_ids)),
        **usage,
        "estimatedCostUsd": round(estimated_cost, 8),
    }


def _write_artifact(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(
            sanitize_public_payload(payload),
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
