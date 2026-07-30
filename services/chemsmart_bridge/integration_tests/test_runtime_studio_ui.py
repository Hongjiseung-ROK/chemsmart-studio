from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from chemsmart.agent.core import AgentSession
from chemsmart.agent.permissions import (
    ApprovalDecision,
    PermissionMode,
    PermissionPolicy,
)
from chemsmart.agent.provider_adapter import ToolRequest
from chemsmart.agent.runtime import ProviderRole, TaskPhase
from chemsmart.agent.runtime.tool_catalog import ToolCatalog
from chemsmart_studio_bridge.generated_protocol import (
    STUDIO_AGENT_TOOL_INPUT_SCHEMAS,
)
from chemsmart_studio_bridge.rpc import RpcFault
from chemsmart_studio_bridge.runtime import (
    SAFE_STUDIO_TOOLS,
    STUDIO_AGENT_TOOL_PROFILE,
    StudioAgentRuntime,
    studio_permission_policy,
)


class RecordingPeer:
    def __init__(
        self,
        responses: list[dict[str, Any]] | None = None,
        approval_decisions: list[str] | None = None,
        approval_fault: RpcFault | None = None,
        calculation_responses: list[dict[str, Any]] | None = None,
    ) -> None:
        self.notifications: list[tuple[str, Any]] = []
        self.requests: list[tuple[str, Any]] = []
        self.responses = list(responses or [])
        self.approval_decisions = list(approval_decisions or [])
        self.approval_fault = approval_fault
        self.calculation_responses = list(calculation_responses or [])

    def request(self, method: str, params: Any = None, timeout: float = 120.0) -> Any:
        del timeout
        self.requests.append((method, params))
        if method == "model.generate" and self.responses:
            return self.responses.pop(0)
        if method == "approval.request":
            if self.approval_fault is not None:
                raise self.approval_fault
            return {"decision": self.approval_decisions.pop(0)}
        if method == "molecule.request":
            return {"committed": True}
        if method == "calculation.request":
            if self.calculation_responses:
                return self.calculation_responses.pop(0)
            return {
                "type": "studio_context",
                "sessionId": params["sessionId"],
                "project": {
                    "projectHandleId": "project-ethanol",
                    "projectName": "Ethanol",
                },
                "document": {
                    "documentId": "ethanol",
                    "revision": 3,
                    "geometryHash": f"sha256:{'1' * 64}",
                },
                "display": {
                    "state": "committed",
                    "documentId": "ethanol",
                    "revision": 3,
                    "geometryHash": f"sha256:{'1' * 64}",
                },
                "draft": None,
                "selection": {"atomIds": [], "bondIds": []},
                "editorMode": "build",
                "panes": ["explorer", "agent"],
                "activeRun": None,
                "extensions": {},
            }
        if method == "studio_ui.event":
            return {
                "accepted": True,
                "eventId": params["eventId"],
                "sequence": params["sequence"],
            }
        if method == "agent.trace":
            return {"accepted": True}
        if method == "agent.report_result":
            return {"accepted": True}
        raise AssertionError(f"Unexpected RPC request: {method}")

    def notify(self, method: str, params: Any = None) -> None:
        self.notifications.append((method, params))


class ScriptedProvider:
    name = "openai"
    default_model = "studio-ui-test"

    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def chat(self, messages, tools=None, timeout_s=30):
        self.calls.append(
            {"messages": messages, "tools": tools, "timeout_s": timeout_s}
        )
        return self.responses.pop(0)


def tool_call_response(
    name: str,
    arguments: dict[str, Any],
    call_id: str = "call-ui-1",
) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


def final_response(message: str) -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": message},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 8, "completion_tokens": 4},
    }


class StudioUiRuntimeIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.peer = RecordingPeer()
        self.runtime = StudioAgentRuntime(Path(self.temporary_directory.name))
        self.runtime.bind_peer(self.peer)  # type: ignore[arg-type]

    def registry(self):
        emitter = self.runtime._studio_ui_emitter("session-1")
        return self.runtime._studio_registry("session-1", emitter)

    @staticmethod
    def approval_request(
        tool: str = "commit_molecule_preview",
        arguments: dict[str, Any] | None = None,
    ) -> ToolRequest:
        if arguments is None:
            arguments = {"preview_id": "preview-1", "expected_revision": 0}
        return ToolRequest(
            request_id="request-approval-1",
            provider="openai",
            provider_call_id="call-approval-1",
            name=tool,
            arguments_json=json.dumps(arguments),
            arguments=arguments,
            raw={},
        )

    def test_model_definitions_use_exact_self_contained_schema(self) -> None:
        registry = self.registry()
        spec = registry.get_tool("report_studio_result")
        self.assertIsNotNone(spec)
        assert spec is not None

        parameters = spec.openai_tool_def()["function"]["parameters"]
        self.assertEqual(parameters["type"], "object")
        self.assertEqual(set(parameters["required"]), {"answer", "artifacts"})
        self.assertEqual(spec.anthropic_tool_def()["input_schema"], parameters)
        self.assertIn("report_studio_result", SAFE_STUDIO_TOOLS)
        self.assertIsNone(registry.get_tool("emit_studio_ui_update"))
        self.assertNotIn("read", SAFE_STUDIO_TOOLS)
        self.assertIsNone(registry.get_tool("read"))

    def test_calculation_inspection_accepts_only_an_opaque_run_and_hides_paths(
        self,
    ) -> None:
        registry = self.registry()
        spec = registry.get_tool("inspect_calculation")
        self.assertIsNotNone(spec)
        assert spec is not None
        parameters = spec.openai_tool_def()["function"]["parameters"]
        self.assertEqual(set(parameters["properties"]), {"run_id"})
        self.assertEqual(parameters["required"], ["run_id"])

        with mock.patch(
            "chemsmart_studio_bridge.runtime.inspect_agent_calculation",
            return_value={
                "ok": True,
                "calculation": {
                    "run_id": "run-opaque-1",
                    "output_path": "/private/project/output.log",
                    "message": "Parsed /private/project/output.log",
                    "status": "parsed",
                },
            },
        ) as inspect:
            result = registry.call(
                "inspect_calculation",
                {"run_id": "run-opaque-1"},
            )

        inspect.assert_called_once_with(
            run_id="run-opaque-1",
            session_root=str(self.runtime._session_root),
        )
        self.assertNotIn("output_path", result["calculation"])
        self.assertEqual(
            result["calculation"]["message"],
            "Parsed [opaque-path]",
        )

    def test_molecule_request_binds_registry_session_to_generated_envelope(
        self,
    ) -> None:
        result = self.registry().call("get_molecule_snapshot", {})

        self.assertEqual(result, {"committed": True})
        self.assertEqual(
            [request for request in self.peer.requests if request[0] == "molecule.request"],
            [
                (
                    "molecule.request",
                    {
                        "sessionId": "session-1",
                        "method": "molecule.get_snapshot",
                        "params": {},
                    },
                )
            ],
        )

    def test_controlled_tools_use_public_specs_and_schema_owned_host_envelope(
        self,
    ) -> None:
        registry = self.registry()
        spec = registry.get_tool("get_studio_context")
        self.assertIsNotNone(spec)
        assert spec is not None
        self.assertEqual(
            spec.openai_tool_def()["function"]["parameters"],
            STUDIO_AGENT_TOOL_INPUT_SCHEMAS["get_studio_context"],
        )

        result = registry.call("get_studio_context", {})

        self.assertEqual(result["type"], "studio_context")
        self.assertEqual(
            [request for request in self.peer.requests if request[0] == "calculation.request"],
            [
                (
                    "calculation.request",
                    {
                        "type": "controlled_calculation_host_request",
                        "sessionId": "session-1",
                        "request": {
                            "type": "studio_agent_tool_request",
                            "tool": "get_studio_context",
                            "arguments": {},
                        },
                    },
                )
            ],
        )
        self.assertIsNone(registry.get_tool("read"))

    def test_studio_profile_preserves_molecule_and_controlled_capabilities(
        self,
    ) -> None:
        capabilities = STUDIO_AGENT_TOOL_PROFILE.capability_names
        for required in (
            "get_studio_context",
            "analyze_current_molecule",
            "preview_molecule_patch",
            "commit_molecule_preview",
            "start_prepared_optimization",
            "run_local",
            "submit_hpc",
            "execute_chemsmart_command",
            "report_studio_result",
        ):
            self.assertIn(required, capabilities)
        self.assertNotIn("emit_studio_ui_update", capabilities)
        self.assertNotIn("read", STUDIO_AGENT_TOOL_PROFILE.capability_names)
        self.assertNotIn(
            "start_molecule_optimization",
            STUDIO_AGENT_TOOL_PROFILE.capability_names,
        )
        for withheld in (
            "render_project_yaml",
            "ssh_probe",
            "scheduler_query",
            "log_tail",
            "update_project_yaml",
            "write_project_yaml",
        ):
            self.assertNotIn(withheld, STUDIO_AGENT_TOOL_PROFILE.capability_names)

        catalog = ToolCatalog(self.registry(), profile=STUDIO_AGENT_TOOL_PROFILE)
        for phase in TaskPhase:
            with self.subTest(phase=phase):
                selection = catalog.select(
                    phase=phase,
                    provider_role=ProviderRole.CONTROLLER,
                )
                self.assertLessEqual(len(selection.direct), 10)
                self.assertNotIn("read", selection.direct)
                self.assertNotIn("start_molecule_optimization", selection.direct)

    def test_generic_execution_model_schemas_match_the_trusted_card_surface(
        self,
    ) -> None:
        registry = self.registry()

        run_schema = registry.get_tool("run_local").openai_tool_def()["function"][
            "parameters"
        ]
        submit_schema = registry.get_tool("submit_hpc").openai_tool_def()[
            "function"
        ]["parameters"]
        command_schema = registry.get_tool(
            "execute_chemsmart_command"
        ).openai_tool_def()["function"]["parameters"]

        self.assertEqual(set(run_schema["properties"]), {"job"})
        self.assertEqual(
            submit_schema["properties"]["server"]["oneOf"],
            [
                {"type": "null"},
                {
                    "maxLength": 128,
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$",
                    "type": "string",
                },
            ],
        )
        self.assertEqual(
            command_schema["properties"]["command"]["pattern"],
            r"^[^/\\\u0000-\u001F\u007F]*$",
        )

    def test_controlled_tool_rejects_wrong_response_kind(self) -> None:
        class WrongResponsePeer(RecordingPeer):
            def request(
                self,
                method: str,
                params: Any = None,
                timeout: float = 120.0,
            ) -> Any:
                if method == "calculation.request":
                    return {
                        "type": "controlled_calculation_artifact_list",
                        "runId": "run-1",
                        "artifacts": [],
                        "nextAfterArtifactId": None,
                        "extensions": {},
                    }
                return super().request(method, params, timeout)

        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "wrong-response"
        )
        runtime.bind_peer(WrongResponsePeer())  # type: ignore[arg-type]
        registry = runtime._studio_registry(
            "session-wrong-response",
            runtime._studio_ui_emitter("session-wrong-response"),
        )

        result = registry.call("get_studio_context", {})

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["type"], "RpcFault")

    def test_risky_controlled_tool_requires_consumable_agent_approval(
        self,
    ) -> None:
        arguments = {
            "plan_id": "plan-1",
            "plan_digest": f"sha256:{'3' * 64}",
        }
        registry = self.registry()

        denied = registry.call("start_prepared_optimization", arguments)

        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["type"], "PermissionError")
        self.assertFalse(
            [
                request
                for request in self.peer.requests
                if request[0] in {"approval.request", "calculation.request"}
            ]
        )

        self.peer.approval_decisions = ["allow_session"]
        decision = self.runtime._approve(
            "session-1",
            registry,
            self.approval_request("start_prepared_optimization", arguments),
        )
        self.assertEqual(decision, ApprovalDecision.ALLOW_ONCE)

        class ReservationPeer(RecordingPeer):
            def request(
                inner_self,
                method: str,
                params: Any = None,
                timeout: float = 120.0,
            ) -> Any:
                if method == "approval.request":
                    return super().request(method, params, timeout)
                if method == "calculation.request":
                    inner_self.requests.append((method, params))
                    return {
                        "type": "controlled_calculation_reservation",
                        "runId": "run-1",
                        "planId": "plan-1",
                        "planDigest": f"sha256:{'3' * 64}",
                        "binding": {
                            "sessionId": "session-1",
                            "documentId": "ethanol",
                            "expectedRevision": 3,
                            "geometryHash": f"sha256:{'1' * 64}",
                        },
                        "executable": {
                            "kind": "local_executable",
                            "engine": "xtb",
                            "version": "fake",
                            "architecture": "arm64",
                            "executableDigest": f"sha256:{'4' * 64}",
                            "runtimeFingerprint": f"sha256:{'5' * 64}",
                            "libraries": [],
                            "verifiedAt": "2026-07-23T05:00:00Z",
                        },
                        "reservedAt": "2026-07-23T05:01:00Z",
                        "extensions": {},
                    }
                return super().request(method, params, timeout)

        reservation_peer = ReservationPeer()
        reservation_peer.approval_decisions = self.peer.approval_decisions
        self.runtime.bind_peer(reservation_peer)  # type: ignore[arg-type]
        approved = registry.call("start_prepared_optimization", arguments)
        replayed = registry.call("start_prepared_optimization", arguments)

        self.assertEqual(approved["type"], "controlled_calculation_reservation")
        self.assertFalse(replayed["ok"])
        self.assertEqual(replayed["error"]["type"], "PermissionError")
        self.assertEqual(
            [
                method
                for method, _params in reservation_peer.requests
                if method == "calculation.request"
            ],
            ["calculation.request"],
        )

    def test_invalid_molecule_request_envelope_fails_before_transport(self) -> None:
        with self.assertRaisesRegex(
            RpcFault,
            "molecule.request envelope is schema-invalid",
        ):
            self.runtime._molecule_request(
                "session with spaces",
                "molecule.get_snapshot",
                {},
            )

        self.assertFalse(self.peer.requests)

    def test_agent_cannot_change_the_researcher_selection(self) -> None:
        with self.assertRaisesRegex(
            RpcFault,
            "molecule.request envelope is schema-invalid",
        ):
            self.runtime._molecule_request(
                "session-1",
                "molecule.set_selection",
                {
                    "documentId": "molecule-1",
                    "expectedRevision": 0,
                    "atomIds": ["atom-1"],
                },
            )

        self.assertFalse(self.peer.requests)

    def test_structured_result_replaces_model_authored_ui_events(self) -> None:
        registry = self.registry()
        result = registry.call(
            "report_studio_result",
            {
                "answer": {
                    "answerId": "answer-1",
                    "heading": "Molecule inspection",
                    "summary": "The visible molecule is ready for review.",
                    "sections": [
                        {
                            "kind": "finding",
                            "heading": "Finding",
                            "summary": "The molecule has a valid immutable binding.",
                        }
                    ],
                    "extensions": {},
                },
                "artifacts": [],
            },
        )

        self.assertTrue(result["accepted"])
        methods = [method for method, _params in self.peer.requests]
        self.assertIn("agent.report_result", methods)
        self.assertNotIn("studio_ui.event", methods)
        self.assertIsNone(registry.get_tool("emit_studio_ui_update"))

    def test_approval_transport_fault_returns_deny(self) -> None:
        for code, message in (
            (-32002, "RPC request timed out: approval.request"),
            (-32001, "RPC peer closed"),
        ):
            with self.subTest(code=code):
                peer = RecordingPeer(approval_fault=RpcFault(code, message))
                runtime = StudioAgentRuntime(
                    Path(self.temporary_directory.name) / f"fault-{abs(code)}"
                )
                runtime.bind_peer(peer)  # type: ignore[arg-type]

                self.assertEqual(
                    runtime._approve(
                        "session-approval-fault",
                        runtime._studio_registry(
                            "session-approval-fault",
                            runtime._studio_ui_emitter("session-approval-fault"),
                        ),
                        self.approval_request(),
                    ),
                    ApprovalDecision.DENY,
                )

    def test_execution_approval_binds_session_and_exact_normalized_arguments(
        self,
    ) -> None:
        peer = RecordingPeer(approval_decisions=["allow_once"])
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "bound-approval"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]
        registry = runtime._studio_registry(
            "session-bound-approval",
            runtime._studio_ui_emitter("session-bound-approval"),
        )
        arguments = {
            "command": "chemsmart run gaussian sp water",
            "test": True,
            "timeout_s": 30,
        }

        decision = runtime._approve(
            "session-bound-approval",
            registry,
            self.approval_request("execute_chemsmart_command", arguments),
        )

        approval_params = next(
            params for method, params in peer.requests if method == "approval.request"
        )
        self.assertEqual(decision, ApprovalDecision.ALLOW_ONCE)
        self.assertEqual(
            approval_params,
            {
                "sessionId": "session-bound-approval",
                "requestId": "request-approval-1",
                "tool": "execute_chemsmart_command",
                "arguments": arguments,
            },
        )

    def test_malformed_and_non_studio_risky_calls_fail_without_prompt_or_forward(
        self,
    ) -> None:
        cases = (
            (
                "commit_molecule_preview",
                {"preview_id": "preview-1", "expected_revision": "4"},
            ),
            (
                "start_molecule_optimization",
                {
                    "engine": "xtb",
                    "method": "GFN2-xTB",
                    "settings": {"maxIterations": 100, "extensions": {}},
                    "expected_revision": 4,
                },
            ),
            (
                "start_molecule_optimization",
                {
                    "engine": "invalid-engine",
                    "method": "GFN2-xTB",
                    "settings": {"maxSteps": 100, "extensions": {}},
                    "expected_revision": 4,
                },
            ),
            (
                "start_molecule_optimization",
                {
                    "engine": "xtb",
                    "method": "   ",
                    "settings": {"maxSteps": 100, "extensions": {}},
                    "expected_revision": 4,
                },
            ),
            (
                "execute_chemsmart_command",
                {"command": "chemsmart run /private/input.xyz"},
            ),
        )
        for index, (tool, arguments) in enumerate(cases):
            with self.subTest(tool=tool):
                peer = RecordingPeer(
                    responses=[
                        tool_call_response(tool, arguments),
                        final_response("The risky action was denied."),
                    ]
                )
                runtime = StudioAgentRuntime(
                    Path(self.temporary_directory.name) / f"invalid-approval-{index}"
                )
                runtime.bind_peer(peer)  # type: ignore[arg-type]

                result = runtime(
                    "agent.run_turn",
                    {
                        "sessionId": f"session-invalid-approval-{index}",
                        "modelId": "provider::model",
                        "request": "Attempt a risky action.",
                    },
                )

                expected_status = (
                    "error" if tool == "commit_molecule_preview" else "denied"
                )
                self.assertEqual(
                    result["tool_outcomes"][0]["status"], expected_status
                )
                methods = [method for method, _params in peer.requests]
                self.assertNotIn("approval.request", methods)
                self.assertNotIn("molecule.request", methods)

    def test_denied_generic_execution_invokes_no_tool(self) -> None:
        calls: list[dict[str, Any]] = []

        def fake_execute(
            command: str,
            test: bool = False,
            timeout_s: int = 3600,
        ) -> dict[str, Any]:
            calls.append(
                {"command": command, "test": test, "timeout_s": timeout_s}
            )
            return {"ok": True}

        provider = ScriptedProvider(
            [
                tool_call_response(
                    "execute_chemsmart_command",
                    {
                        "command": "chemsmart run gaussian sp water",
                        "test": True,
                        "timeout_s": 30,
                    },
                ),
                final_response("The execution was denied."),
            ]
        )
        peer = RecordingPeer(approval_decisions=["deny"])
        with mock.patch(
            "chemsmart.agent.tools_command.execute_chemsmart_command",
            fake_execute,
        ):
            runtime = StudioAgentRuntime(
                Path(self.temporary_directory.name) / "denied-generic-execution"
            )
            runtime.bind_peer(peer)  # type: ignore[arg-type]
            registry = runtime._studio_registry(
                "session-denied-generic-execution",
                runtime._studio_ui_emitter(
                    "session-denied-generic-execution"
                ),
            )
            session = AgentSession(
                provider=provider,
                registry=registry,
                session_root=Path(self.temporary_directory.name)
                / "denied-generic-execution-session",
                runtime_v2="off",
            )
            result = session.run_loop(
                "Run the exact command.",
                policy=studio_permission_policy(),
                approver=lambda request: runtime._approve(
                    "session-denied-generic-execution",
                    registry,
                    request,
                ),
            )

        self.assertEqual(
            result["tool_outcomes"][0].status,
            "denied",
            result,
        )
        self.assertEqual(calls, [])
        self.assertEqual(
            [method for method, _params in peer.requests].count(
                "approval.request"
            ),
            1,
        )

    def test_legacy_optimization_start_is_hidden_from_active_profile(self) -> None:
        peer = RecordingPeer(
            responses=[
                tool_call_response(
                    "start_molecule_optimization",
                    {
                        "engine": "xtb",
                        "method": "GFN2-xTB",
                        "settings": {"maxSteps": 100, "extensions": {}},
                        "expected_revision": 7,
                    },
                ),
                final_response("The approved optimization was queued."),
            ],
            approval_decisions=["allow_once"],
        )
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "optimization"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-optimization",
                "modelId": "provider::model",
                "request": "Start the optimization.",
            },
        )

        self.assertEqual(result["tool_outcomes"][0]["status"], "error")
        self.assertEqual(
            result["tool_outcomes"][0]["error_type"],
            "ToolExposureViolation",
        )
        methods = [method for method, _params in peer.requests]
        self.assertEqual(methods.count("approval.request"), 1)
        self.assertNotIn("molecule.request", methods)

    def test_all_studio_risky_tools_downgrade_session_approval(self) -> None:
        arguments_by_tool = {
            "start_molecule_optimization": {
                "engine": "xtb",
                "method": "GFN2-xTB",
                "settings": {"extensions": {}},
                "expected_revision": 1,
            },
            "cancel_molecule_optimization": {"run_id": "run-1"},
            "accept_optimization_geometry": {
                "run_id": "run-1",
                "expected_revision": 1,
            },
            "reject_optimization_geometry": {"run_id": "run-1"},
            "run_local": {"job": "job_abcd"},
            "submit_hpc": {
                "job": "job_1234abcd",
                "server": "cluster-a",
                "execute": True,
            },
            "execute_chemsmart_command": {
                "command": "chemsmart run gaussian sp water",
                "test": True,
                "timeout_s": 30,
            },
        }
        peer = RecordingPeer(
            approval_decisions=["allow_session"] * len(arguments_by_tool)
        )
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "one-shot-tools"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]
        registry = runtime._studio_registry(
            "session-one-shot-tools",
            runtime._studio_ui_emitter("session-one-shot-tools"),
        )

        for tool, arguments in arguments_by_tool.items():
            with self.subTest(tool=tool):
                self.assertEqual(
                    runtime._approve(
                        "session-one-shot-tools",
                        registry,
                        self.approval_request(tool, arguments),
                    ),
                    ApprovalDecision.ALLOW_ONCE,
                )

    def test_compatibility_commit_appends_draft_without_approval(self) -> None:
        peer = RecordingPeer(
            responses=[
                tool_call_response(
                    "commit_molecule_preview",
                    {"preview_id": "preview-1", "expected_revision": 0},
                ),
                final_response("The preview was added to the draft."),
            ],
        )
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "draft-commit"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-draft-commit",
                "modelId": "provider::model",
                "request": "Commit the preview.",
                "capability": "act",
            },
        )

        self.assertEqual(result["tool_outcomes"][0]["status"], "ok")
        self.assertEqual(
            [method for method, _params in peer.requests].count("approval.request"),
            0,
        )
        self.assertEqual(
            [method for method, _params in peer.requests].count("molecule.request"),
            1,
        )

    def test_consecutive_compatibility_commits_append_without_reprompting(
        self,
    ) -> None:
        peer = RecordingPeer(
            responses=[
                tool_call_response(
                    "commit_molecule_preview",
                    {"preview_id": "preview-1", "expected_revision": 0},
                    "call-commit-1",
                ),
                tool_call_response(
                    "commit_molecule_preview",
                    {"preview_id": "preview-2", "expected_revision": 1},
                    "call-commit-2",
                ),
                final_response("Both previews were added to the draft."),
            ],
        )
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "draft-commits"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-draft-commits",
                "modelId": "provider::model",
                "request": "Commit both previews.",
                "capability": "act",
            },
        )

        methods = [method for method, _params in peer.requests]
        self.assertEqual(methods.count("approval.request"), 0)
        self.assertEqual(methods.count("molecule.request"), 2)
        self.assertEqual(
            [outcome["status"] for outcome in result["tool_outcomes"]],
            ["ok", "ok"],
        )

    def test_studio_runtime_runs_sidecar_turn_through_model_callback(self) -> None:
        peer = RecordingPeer(
            [
                tool_call_response(
                    "report_studio_result",
                    {
                        "answer": {
                            "answerId": "answer-1",
                            "heading": "Molecule inspection",
                            "summary": "No committed state changed.",
                            "sections": [
                                {
                                    "kind": "finding",
                                    "heading": "Finding",
                                    "summary": "The visible molecule was inspected.",
                                }
                            ],
                            "extensions": {},
                        },
                        "artifacts": [],
                    },
                ),
            ]
        )
        runtime = StudioAgentRuntime(Path(self.temporary_directory.name) / "runtime")
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-sidecar",
                "modelId": "provider::model",
                "request": "Run it now and report status.",
            },
        )

        self.assertEqual(result["assistant_output"], "")
        self.assertIsInstance(result["plan"], dict)
        self.assertEqual(result["tool_requests"][0]["name"], "report_studio_result")
        self.assertEqual(result["runtime_v2"]["mode"], "active")
        self.assertNotIn("session_dir", result)
        self.assertNotIn("event_log", result["runtime_v2"])
        self.assertNotIn("state_snapshot", result["runtime_v2"])
        self.assertNotIn(self.temporary_directory.name, json.dumps(result))
        json.dumps(result)
        self.assertEqual(
            [method for method, _params in peer.requests].count(
                "agent.report_result"
            ),
            1,
        )
        exposed_tools = [
            tool["function"]["name"]
            for method, params in peer.requests
            if method == "model.generate"
            for tool in params["tools"]
        ]
        self.assertNotIn("read", exposed_tools)
        self.assertNotIn("start_molecule_optimization", exposed_tools)
        self.assertNotIn(
            "studio_ui.event",
            [method for method, _params in peer.requests],
        )

    def test_studio_runtime_never_persists_provider_private_reasoning(self) -> None:
        response = tool_call_response(
            "report_studio_result",
            {
                "answer": {
                    "answerId": "answer-private-reasoning",
                    "heading": "Molecule inspection",
                    "summary": "The verified inspection is available.",
                    "sections": [
                        {
                            "kind": "finding",
                            "heading": "Finding",
                            "summary": "The visible molecule was inspected.",
                        }
                    ],
                    "extensions": {},
                },
                "artifacts": [],
            },
        )
        response["choices"][0]["message"]["reasoning_content"] = (
            "provider-private-reasoning-sentinel"
        )
        peer = RecordingPeer([response])
        session_root = Path(self.temporary_directory.name) / "private-reasoning"
        runtime = StudioAgentRuntime(session_root)
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-private-reasoning",
                "modelId": "provider::model",
                "operationId": "00000000-0000-4000-8000-000000000001",
                "request": "Inspect without exposing private reasoning.",
            },
        )

        self.assertNotIn("reasoning_content", json.dumps(result))
        self.assertNotIn("provider-private-reasoning-sentinel", json.dumps(result))
        persisted_text = []
        for candidate in session_root.rglob("*"):
            if not candidate.is_file():
                continue
            try:
                persisted_text.append(candidate.read_text(encoding="utf-8"))
            except UnicodeDecodeError:
                continue
        joined = "\n".join(persisted_text)
        self.assertNotIn("reasoning_content", joined)
        self.assertNotIn("provider-private-reasoning-sentinel", joined)

    def test_actual_agent_session_reads_controlled_studio_context(self) -> None:
        peer = RecordingPeer(
            responses=[
                tool_call_response("get_studio_context", {}),
                final_response("The committed ethanol context is current."),
            ]
        )
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "controlled-context"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-controlled-context",
                "modelId": "provider::model",
                "request": "Inspect the current Studio context.",
            },
        )

        self.assertEqual(result["tool_outcomes"][0]["status"], "ok")
        methods = [
            method
            for method, _params in peer.requests
            if method != "agent.trace"
        ]
        self.assertEqual(
            methods,
            [
                "model.generate",
                "calculation.request",
                "model.generate",
            ],
        )
        calculation_request = next(
            params
            for method, params in peer.requests
            if method == "calculation.request"
        )
        self.assertEqual(
            calculation_request,
            {
                "type": "controlled_calculation_host_request",
                "sessionId": "session-controlled-context",
                "request": {
                    "type": "studio_agent_tool_request",
                    "tool": "get_studio_context",
                    "arguments": {},
                },
            },
        )

    def test_actual_agent_session_consumes_one_controlled_start_approval(
        self,
    ) -> None:
        arguments = {
            "plan_id": "plan-1",
            "plan_digest": f"sha256:{'3' * 64}",
        }
        reservation = {
            "type": "controlled_calculation_reservation",
            "runId": "run-1",
            "planId": "plan-1",
            "planDigest": f"sha256:{'3' * 64}",
            "binding": {
                "sessionId": "session-controlled-start",
                "documentId": "ethanol",
                "expectedRevision": 3,
                "geometryHash": f"sha256:{'1' * 64}",
            },
            "executable": {
                "kind": "local_executable",
                "engine": "xtb",
                "version": "fake",
                "architecture": "arm64",
                "executableDigest": f"sha256:{'4' * 64}",
                "runtimeFingerprint": f"sha256:{'5' * 64}",
                "libraries": [],
                "verifiedAt": "2026-07-23T05:00:00Z",
            },
            "reservedAt": "2026-07-23T05:01:00Z",
            "extensions": {},
        }
        peer = RecordingPeer(
            responses=[
                tool_call_response(
                    "start_prepared_optimization",
                    arguments,
                ),
                final_response("The approved deterministic run was reserved."),
            ],
            approval_decisions=["allow_session"],
            calculation_responses=[reservation],
        )
        runtime = StudioAgentRuntime(
            Path(self.temporary_directory.name) / "controlled-start"
        )
        runtime.bind_peer(peer)  # type: ignore[arg-type]

        result = runtime(
            "agent.run_turn",
            {
                "sessionId": "session-controlled-start",
                "modelId": "provider::model",
                "request": "Start the validated controlled plan.",
                "capability": "act",
            },
        )

        self.assertEqual(result["tool_outcomes"][0]["status"], "ok")
        methods = [method for method, _params in peer.requests]
        self.assertEqual(methods.count("approval.request"), 1)
        self.assertEqual(methods.count("calculation.request"), 1)
        self.assertEqual(
            [method for method in methods if method != "agent.trace"],
            [
                "model.generate",
                "approval.request",
                "calculation.request",
                "model.generate",
            ],
        )
        self.assertFalse(runtime._studio_approval_grants)


if __name__ == "__main__":
    unittest.main()
