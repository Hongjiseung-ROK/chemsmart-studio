from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from chemsmart.agent.permissions import ApprovalDecision
from chemsmart.agent.project_yaml import extract_project_protocol
from chemsmart.agent.provider_adapter import ToolRequest
from chemsmart.agent.registry import ToolRegistry, build_tool_spec
from chemsmart_studio_bridge.rpc import RpcFault
from chemsmart_studio_bridge.runtime import (
    CherryModelProvider,
    StudioAgentRuntime,
    _attach_registered_preflight_refs,
    _studio_preflight_artifact,
)

OPERATION_ID = "01234567-89ab-4def-8123-456789abcdef"


class RecordingPeer:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []

    def request(self, method: str, params: dict, timeout: float) -> dict:
        del timeout
        self.requests.append((method, params))
        return {"choices": [{"message": {"content": "ok"}}]}


class HostProviderBoundaryTest(unittest.TestCase):
    def test_project_yaml_render_registers_one_path_free_gaussian_candidate(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            requests: list[tuple[str, dict]] = []
            peer = Mock()

            def host_response(method: str, params: dict, **_kwargs: object) -> dict:
                requests.append((method, params))
                return {
                    "previewId": "yaml-preview-1",
                    "program": "gaussian",
                    "status": "pending",
                }

            peer.request.side_effect = host_response
            runtime = StudioAgentRuntime(Path(directory)).bind_peer(peer)
            registry = runtime._studio_registry("session-1")
            protocol = extract_project_protocol(
                "Use Gaussian B3LYP/def2-SVP for a gas-phase optimization.",
                project_name="water",
                program="gaussian",
            )

            with runtime._operation_scope("session-1", OPERATION_ID):
                result = registry.call(
                    "render_project_yaml",
                    {
                        "protocol": protocol,
                        "project": "water",
                        "program": "gaussian",
                    },
                )

            self.assertEqual(result["previewId"], "yaml-preview-1")
            candidate_requests = [
                params for method, params in requests if method == "project.register_candidate"
            ]
            self.assertEqual(len(candidate_requests), 1)
            callback = candidate_requests[0]
            self.assertEqual(callback["operationId"], OPERATION_ID)
            self.assertEqual(callback["document"]["projectName"], "water")
            self.assertNotIn(str(Path(directory)), repr(callback))

            with runtime._operation_scope("session-1", OPERATION_ID):
                invalid = registry.call(
                    "render_project_yaml",
                    {
                        "protocol": protocol,
                        "project": "water",
                        "program": "xtb",
                    },
                )
            self.assertFalse(invalid["ok"])
            self.assertEqual(
                len([method for method, _params in requests if method == "project.register_candidate"]),
                1,
            )

    def test_registered_preflight_is_attached_to_the_matching_turn_result(
        self,
    ) -> None:
        result = _attach_registered_preflight_refs(
            {
                "answer": {"heading": "Ready", "summary": "Validated.", "sections": []},
                "artifacts": [],
            },
            [
                ("operation-old", "synthesis-old"),
                (OPERATION_ID, "synthesis-water-sp"),
            ],
            OPERATION_ID,
        )

        self.assertEqual(result["artifactRefs"], ["synthesis-water-sp"])

    def test_xtb_preflight_artifact_binds_parser_evidence_without_project_yaml(
        self,
    ) -> None:
        command_digest = "1" * 64
        synthesis = {
            "synthesisId": "synthesis-water-sp",
            "commandDigest": command_digest,
            "intent": {"failedRuleIds": []},
            "semantic": {"failedRuleIds": []},
        }
        payload = {
            "preflight": {
                "schema_version": "chemsmart.command-preflight.v1",
                "normalized_spec": {
                    "program": "xtb",
                    "kind": "xtb.sp",
                    "chemistry": {"gfn_version": "gfn2"},
                },
            }
        }
        analysis = {
            "binding": {
                "state": "committed",
                "documentId": "molecule-1",
                "revision": 2,
                "geometryHash": f"sha256:{'2' * 64}",
            },
            "charge": 0,
            "multiplicity": 1,
        }
        materialized_input = {
            "basename": "chemsmart-input-2222222222222222.xyz",
            "documentId": "molecule-1",
            "revision": 2,
            "geometryHash": f"sha256:{'2' * 64}",
            "sha256": "3" * 64,
        }

        artifact = _studio_preflight_artifact(
            synthesis,
            payload,
            analysis,
            materialized_input,
        )

        self.assertEqual(artifact["engine"], "xtb")
        self.assertEqual(artifact["method"], "GFN2-xTB")
        self.assertEqual(artifact["calculationKind"], "single_point")
        self.assertEqual(artifact["planId"], "synthesis-water-sp")
        self.assertFalse(
            artifact["extensions"]["chemsmart.preflight"]["projectRequired"]
        )
        self.assertEqual(
            artifact["extensions"]["chemsmart.preflight"]["inputBasename"],
            materialized_input["basename"],
        )
        self.assertEqual(
            artifact["extensions"]["chemsmart.preflight"]["inputDigest"],
            materialized_input["sha256"],
        )

    def test_provider_callback_carries_the_authorized_studio_session(self) -> None:
        peer = RecordingPeer()
        provider = CherryModelProvider(
            peer,  # type: ignore[arg-type]
            "session-1",
            "provider::model",
        )
        provider.bind_operation(OPERATION_ID)

        provider.chat([{"role": "user", "content": "Inspect."}], tools=[])

        self.assertEqual(peer.requests[0][0], "model.generate")
        self.assertEqual(peer.requests[0][1]["sessionId"], "session-1")
        self.assertEqual(peer.requests[0][1]["modelId"], "provider::model")
        self.assertEqual(peer.requests[0][1]["operationId"], OPERATION_ID)

    def test_operation_scope_tags_all_live_host_callback_envelopes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            requests: list[tuple[str, dict]] = []

            def host_response(
                method: str,
                params: dict,
                timeout: float = 120.0,
            ) -> dict:
                del timeout
                requests.append((method, params))
                if method == "approval.request":
                    return {"decision": "allow_once"}
                if method == "agent.trace":
                    return {"accepted": True}
                if method == "molecule.request":
                    return {"documentId": "molecule-1", "revision": 0}
                if method == "calculation.request":
                    return {
                        "type": "studio_context",
                        "sessionId": "session-1",
                        "project": {
                            "projectHandleId": "project-1",
                            "projectName": "Water",
                        },
                        "document": {
                            "documentId": "molecule-1",
                            "revision": 0,
                            "geometryHash": f"sha256:{'1' * 64}",
                        },
                        "display": {
                            "state": "committed",
                            "documentId": "molecule-1",
                            "revision": 0,
                            "geometryHash": f"sha256:{'1' * 64}",
                        },
                        "draft": None,
                        "selection": {"atomIds": [], "bondIds": []},
                        "editorMode": "build",
                        "panes": ["explorer", "agent"],
                        "activeRun": None,
                        "extensions": {},
                    }
                raise AssertionError(method)

            peer = Mock()
            peer.request.side_effect = host_response
            runtime = StudioAgentRuntime(Path(directory)).bind_peer(peer)
            arguments = {
                "plan_id": "plan-1",
                "plan_digest": f"sha256:{'1' * 64}",
            }
            approval = ToolRequest(
                request_id="approval-1",
                provider="openai",
                provider_call_id="call-1",
                name="start_prepared_optimization",
                arguments_json=json.dumps(arguments),
                arguments=arguments,
                raw={},
            )
            registry = Mock()
            registry.get_tool.return_value = Mock()

            with runtime._operation_scope("session-1", OPERATION_ID):
                self.assertEqual(
                    runtime._approve("session-1", registry, approval),
                    ApprovalDecision.ALLOW_ONCE,
                )
                runtime._molecule_request(
                    "session-1",
                    "molecule.get_snapshot",
                    {},
                )
                runtime._controlled_calculation_request(
                    "session-1",
                    "get_studio_context",
                    {},
                )
            self.assertEqual(
                [method for method, _params in requests],
                [
                    "agent.trace",
                    "approval.request",
                    "molecule.request",
                    "calculation.request",
                ],
            )
            self.assertTrue(
                all(
                    params["operationId"] == OPERATION_ID
                    for _method, params in requests
                )
            )

    def test_command_synthesis_requires_the_closed_request_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = StudioAgentRuntime(Path(directory))

            with self.assertRaisesRegex(
                RpcFault,
                "command.synthesize request is schema-invalid",
            ):
                runtime(
                    "command.synthesize",
                    {
                        "request": "Optimise water.",
                        "extensions": {},
                    },
                )

    def test_command_synthesis_projects_only_path_free_public_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = StudioAgentRuntime(Path(directory))
            runtime.bind_peer(Mock())
            provider = Mock()
            provider.bind_model = Mock()
            command_session = Mock()
            command_session.synthesize_command.return_value = {
                "status": "ready",
                "command": "chemsmart run xtb -f private/water.xyz opt",
                "explanation": f"Prepared from {directory}/private/water.xyz",
                "workflow_state": {"cwd": directory},
                "raw_response": {"private": True},
                "intent": {"verdict": "ok", "failed_rule_ids": []},
                "semantic": {"verdict": "ok", "failed_rule_ids": []},
            }
            runtime._provider_and_command_session = Mock(  # type: ignore[method-assign]
                return_value=(provider, command_session)
            )

            result = runtime(
                "command.synthesize",
                {
                    "sessionId": "session-1",
                    "modelId": "provider::model",
                    "operationId": OPERATION_ID,
                    "request": "Optimise water.",
                    "extensions": {},
                },
            )

            self.assertEqual(result["status"], "infeasible")
            provider.bind_operation.assert_called_once_with(OPERATION_ID)
            self.assertEqual(result["command"], "")
            self.assertIsNone(result["commandDigest"])
            self.assertNotIn(directory, repr(result))
            self.assertNotIn("workflow", repr(result))
            self.assertNotIn("raw_response", repr(result))

    def test_new_agent_session_is_bound_before_run_loop_continues(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            runtime = StudioAgentRuntime(session_root)
            peer = Mock()
            peer.request.side_effect = lambda method, _params, **_kwargs: (
                {"accepted": True}
                if method == "agent.trace"
                else {"choices": [{"message": {"content": "ok"}}]}
            )
            runtime.bind_peer(peer)
            provider = Mock()
            command_session = Mock()
            runtime._provider_and_command_session = Mock(  # type: ignore[method-assign]
                return_value=(provider, command_session)
            )
            runtime._studio_registry = Mock(  # type: ignore[method-assign]
                return_value=Mock()
            )
            internal_session_id = "20260726T000000Z-deadbeef"

            class FakeAgentSession:
                def __init__(self, **_: object) -> None:
                    pass

                def bind_provider(self, _: object) -> None:
                    pass

                def bind_tool_profile(self, _: object) -> None:
                    pass

                def run_loop(self, _: str, **kwargs: object) -> dict[str, object]:
                    internal_directory = session_root / internal_session_id
                    internal_directory.mkdir()
                    (internal_directory / "session.json").write_text("{}")
                    callback = kwargs["on_session_created"]
                    assert callable(callback)
                    callback(internal_session_id)
                    binding = session_root / "session-1" / "agent-session.json"
                    self.assert_binding(binding)
                    return {
                        "session_id": internal_session_id,
                        "assistant_output": "",
                        "terminal_outcome": "completed",
                        "limit_reason": None,
                    }

                @staticmethod
                def assert_binding(binding: Path) -> None:
                    assert binding.is_file()
                    assert internal_session_id in binding.read_text()

            with patch(
                "chemsmart_studio_bridge.runtime.AgentSession",
                FakeAgentSession,
            ):
                result = runtime(
                    "agent.run_turn",
                    {
                        "sessionId": "session-1",
                        "modelId": "provider::model",
                        "operationId": OPERATION_ID,
                        "request": "Inspect the current molecule.",
                        "workflow": "general",
                    },
                )

            self.assertEqual(result["session_id"], internal_session_id)
            peer.notify.assert_called_once()
            self.assertEqual(
                peer.notify.call_args.args[1]["operationId"],
                OPERATION_ID,
            )
            studio_session = session_root / "session-1"
            self.assertEqual(stat.S_IMODE(studio_session.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((studio_session / "agent-session.json").stat().st_mode),
                0o600,
            )

    def test_project_threads_keep_distinct_private_agent_session_bindings(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            first_agent_session = "20260726T000000Z-deadbeef"
            second_agent_session = "20260726T000001Z-cafebabe"
            for agent_session_id in (
                first_agent_session,
                second_agent_session,
            ):
                (session_root / agent_session_id).mkdir()
            runtime = StudioAgentRuntime(session_root)

            runtime._persist_agent_session_binding(
                "thread-first",
                first_agent_session,
            )
            runtime._persist_agent_session_binding(
                "thread-second",
                second_agent_session,
            )

            self.assertEqual(
                runtime._read_agent_session_binding("thread-first"),
                first_agent_session,
            )
            self.assertEqual(
                runtime._read_agent_session_binding("thread-second"),
                second_agent_session,
            )
            for studio_session_id in ("thread-first", "thread-second"):
                studio_session = session_root / studio_session_id
                binding = studio_session / "agent-session.json"
                self.assertEqual(
                    stat.S_IMODE(studio_session.stat().st_mode),
                    0o700,
                )
                self.assertEqual(
                    stat.S_IMODE(binding.stat().st_mode),
                    0o600,
                )

    def test_incomplete_agent_turn_returns_a_bounded_failed_outcome(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            internal_session_id = "20260726T000000Z-deadbeef"
            internal_directory = session_root / internal_session_id
            internal_directory.mkdir()
            (internal_directory / "session.json").write_text("{}")

            class FailedAgentSession:
                @staticmethod
                def bind_provider(_: object) -> None:
                    pass

                @staticmethod
                def bind_tool_profile(_: object) -> None:
                    pass

                @staticmethod
                def run_loop(_: str, **__: object) -> dict[str, object]:
                    return {
                        "session_id": internal_session_id,
                        "assistant_output": "",
                        "limit_reason": "provider_errors",
                        "terminal_outcome": "failed",
                    }

            runtime = StudioAgentRuntime(session_root)
            peer = Mock()
            peer.request.return_value = {"accepted": True}
            runtime.bind_peer(peer)
            runtime._sessions["session-1"] = FailedAgentSession()  # type: ignore[assignment]
            runtime._provider_and_command_session = Mock(  # type: ignore[method-assign]
                return_value=(Mock(), Mock())
            )

            result = runtime(
                "agent.run_turn",
                {
                    "sessionId": "session-1",
                    "modelId": "provider::model",
                    "operationId": OPERATION_ID,
                    "request": "Inspect the current molecule.",
                    "workflow": "general",
                },
            )

            self.assertEqual(result["terminal_outcome"], "failed")
            self.assertEqual(result["limit_reason"], "provider_errors")

    def test_domain_denial_returns_without_a_provider_follow_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            internal_session_id = "20260726T000000Z-deadbeef"
            internal_directory = session_root / internal_session_id
            internal_directory.mkdir()
            (internal_directory / "session.json").write_text("{}")
            run_loop = Mock(
                return_value={
                    "session_id": internal_session_id,
                    "assistant_output": "",
                    "limit_reason": None,
                    "terminal_outcome": "denied",
                }
            )
            session = Mock()
            session.run_loop = run_loop
            runtime = StudioAgentRuntime(session_root)
            peer = Mock()
            peer.request.return_value = {"accepted": True}
            runtime.bind_peer(peer)
            runtime._sessions["session-1"] = session
            runtime._provider_and_command_session = Mock(  # type: ignore[method-assign]
                return_value=(Mock(), Mock())
            )

            result = runtime(
                "agent.run_turn",
                {
                    "sessionId": "session-1",
                    "modelId": "provider::model",
                    "operationId": OPERATION_ID,
                    "request": "Run the approved calculation.",
                    "capability": "act",
                    "intentKind": "run",
                    "workflow": "calculation",
                },
            )

            self.assertEqual(result["terminal_outcome"], "denied")
            self.assertEqual(run_loop.call_count, 1)

    def test_tool_trace_projects_only_public_keys_and_trusted_lifecycle(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            requests: list[tuple[str, dict]] = []

            def host_response(
                method: str,
                params: dict,
                timeout: float = 120.0,
            ) -> dict:
                del timeout
                requests.append((method, params))
                return {"accepted": True}

            peer = Mock()
            peer.request.side_effect = host_response
            runtime = StudioAgentRuntime(Path(directory)).bind_peer(peer)

            def inspect_snapshot(document_id: str) -> dict[str, object]:
                return {"ok": True, "documentId": document_id}

            registry = runtime._trace_registry(
                "session-1",
                ToolRegistry([build_tool_spec(inspect_snapshot)]),
            )
            with runtime._operation_scope("session-1", OPERATION_ID):
                result = registry.call(
                    "inspect_snapshot",
                    {"document_id": "private-value"},
                )

            self.assertEqual(result["documentId"], "private-value")
            trace_params = [
                params for method, params in requests if method == "agent.trace"
            ]
            self.assertEqual(
                [params["kind"] for params in trace_params],
                ["tool_started", "tool_succeeded"],
            )
            self.assertEqual(
                trace_params[0]["detail"]["argumentKeys"],
                ["document_id"],
            )
            self.assertEqual(
                trace_params[1]["detail"]["resultKeys"],
                ["documentId", "ok"],
            )
            self.assertNotIn("private-value", repr(trace_params))
            self.assertTrue(
                all(params["operationId"] == OPERATION_ID for params in trace_params)
            )

    def test_session_directory_symlink_is_rejected_without_touching_target(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            agent_session_id = "20260726T000000Z-deadbeef"
            (session_root / agent_session_id).mkdir()
            outside = session_root / "outside"
            outside.mkdir()
            marker = outside / "marker"
            marker.write_text("unchanged")
            (session_root / "session-1").symlink_to(outside, target_is_directory=True)
            runtime = StudioAgentRuntime(session_root)

            with self.assertRaisesRegex(
                RpcFault,
                "Agent session binding is invalid",
            ):
                runtime._persist_agent_session_binding(
                    "session-1",
                    agent_session_id,
                )

            self.assertEqual(marker.read_text(), "unchanged")
            self.assertFalse((outside / "agent-session.json").exists())

    def test_competing_binding_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            requested_id = "20260726T000000Z-deadbeef"
            competing_id = "20260726T000001Z-cafebabe"
            for agent_session_id in (requested_id, competing_id):
                (session_root / agent_session_id).mkdir()
            studio_session = session_root / "session-1"
            binding = studio_session / "agent-session.json"
            runtime = StudioAgentRuntime(session_root)
            original_link = os.link
            competing_published = False

            def publish_competing_then_link(
                source: str,
                destination: str,
                *,
                src_dir_fd: int | None = None,
                dst_dir_fd: int | None = None,
                follow_symlinks: bool = True,
            ) -> None:
                nonlocal competing_published
                if not competing_published:
                    competing_published = True
                    binding.write_text(
                        json.dumps(
                            {
                                "agentSessionId": competing_id,
                                "schemaVersion": 1,
                            }
                        )
                    )
                original_link(
                    source,
                    destination,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                    follow_symlinks=follow_symlinks,
                )

            with (
                patch(
                    "chemsmart_studio_bridge.runtime.os.link",
                    side_effect=publish_competing_then_link,
                ),
                self.assertRaisesRegex(
                    RpcFault,
                    "Agent session binding changed unexpectedly",
                ),
            ):
                runtime._persist_agent_session_binding(
                    "session-1",
                    requested_id,
                )

            self.assertEqual(
                runtime._read_agent_session_binding("session-1"),
                competing_id,
            )
            self.assertEqual(
                list(studio_session.glob(".agent-session.json.*.tmp")),
                [],
            )

    def test_identical_competing_binding_is_accepted_without_replacement(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            agent_session_id = "20260726T000000Z-deadbeef"
            (session_root / agent_session_id).mkdir()
            studio_session = session_root / "session-1"
            binding = studio_session / "agent-session.json"
            runtime = StudioAgentRuntime(session_root)
            original_link = os.link
            competing_published = False

            def publish_identical_then_link(
                source: str,
                destination: str,
                *,
                src_dir_fd: int | None = None,
                dst_dir_fd: int | None = None,
                follow_symlinks: bool = True,
            ) -> None:
                nonlocal competing_published
                if not competing_published:
                    competing_published = True
                    binding.write_text(
                        json.dumps(
                            {
                                "agentSessionId": agent_session_id,
                                "schemaVersion": 1,
                            }
                        )
                    )
                original_link(
                    source,
                    destination,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                    follow_symlinks=follow_symlinks,
                )

            with patch(
                "chemsmart_studio_bridge.runtime.os.link",
                side_effect=publish_identical_then_link,
            ):
                runtime._persist_agent_session_binding(
                    "session-1",
                    agent_session_id,
                )

            self.assertEqual(
                runtime._read_agent_session_binding("session-1"),
                agent_session_id,
            )
            self.assertEqual(
                list(studio_session.glob(".agent-session.json.*.tmp")),
                [],
            )

    def test_binding_path_swap_does_not_change_open_descriptor_contents(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            first_id = "20260726T000000Z-deadbeef"
            second_id = "20260726T000001Z-cafebabe"
            for agent_session_id in (first_id, second_id):
                (session_root / agent_session_id).mkdir()
            studio_session = session_root / "session-1"
            studio_session.mkdir()
            binding = studio_session / "agent-session.json"
            binding.write_text(
                json.dumps({"agentSessionId": first_id, "schemaVersion": 1})
            )
            replacement = studio_session / "replacement.json"
            replacement.write_text(
                json.dumps({"agentSessionId": second_id, "schemaVersion": 1})
            )
            runtime = StudioAgentRuntime(session_root)
            original_read = os.read
            swapped = False

            def swap_then_read(descriptor: int, size: int) -> bytes:
                nonlocal swapped
                if not swapped:
                    swapped = True
                    os.replace(replacement, binding)
                return original_read(descriptor, size)

            with patch(
                "chemsmart_studio_bridge.runtime.os.read",
                side_effect=swap_then_read,
            ):
                self.assertEqual(
                    runtime._read_agent_session_binding("session-1"),
                    first_id,
                )

    def test_oversized_binding_path_swap_cannot_expand_the_open_read(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            agent_session_id = "20260726T000000Z-deadbeef"
            (session_root / agent_session_id).mkdir()
            studio_session = session_root / "session-1"
            studio_session.mkdir()
            binding = studio_session / "agent-session.json"
            binding.write_text(
                json.dumps(
                    {
                        "agentSessionId": agent_session_id,
                        "schemaVersion": 1,
                    }
                )
            )
            replacement = studio_session / "oversized.json"
            replacement.write_bytes(b"x" * 2048)
            runtime = StudioAgentRuntime(session_root)
            original_read = os.read
            swapped = False

            def swap_then_read(descriptor: int, size: int) -> bytes:
                nonlocal swapped
                if not swapped:
                    swapped = True
                    os.replace(replacement, binding)
                return original_read(descriptor, size)

            with patch(
                "chemsmart_studio_bridge.runtime.os.read",
                side_effect=swap_then_read,
            ):
                self.assertEqual(
                    runtime._read_agent_session_binding("session-1"),
                    agent_session_id,
                )

    def test_binding_growth_after_fstat_is_rejected_by_bounded_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session_root = Path(directory)
            agent_session_id = "20260726T000000Z-deadbeef"
            (session_root / agent_session_id).mkdir()
            studio_session = session_root / "session-1"
            studio_session.mkdir()
            binding = studio_session / "agent-session.json"
            binding.write_text(
                json.dumps(
                    {
                        "agentSessionId": agent_session_id,
                        "schemaVersion": 1,
                    }
                )
            )
            runtime = StudioAgentRuntime(session_root)
            original_fstat = os.fstat
            grown = False

            def grow_after_fstat(descriptor: int) -> os.stat_result:
                nonlocal grown
                result = original_fstat(descriptor)
                if not grown and stat.S_ISREG(result.st_mode):
                    grown = True
                    with binding.open("ab") as handle:
                        handle.write(b"x" * 2048)
                return result

            with (
                patch(
                    "chemsmart_studio_bridge.runtime.os.fstat",
                    side_effect=grow_after_fstat,
                ),
                self.assertRaisesRegex(
                    RpcFault,
                    "Agent session binding is invalid",
                ),
            ):
                runtime._read_agent_session_binding("session-1")


if __name__ == "__main__":
    unittest.main()
