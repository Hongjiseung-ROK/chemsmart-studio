from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from chemsmart.agent.behavior_rules import load_behavior_rules
from chemsmart.agent.permissions import ResolvedDecision
from chemsmart.agent.runtime.contracts import ProviderRole, TaskPhase
from chemsmart.agent.provider_adapter import ToolRequest
from chemsmart.agent.registry import ToolRegistry
from chemsmart_studio_bridge.runtime import (
    ALWAYS_STUDIO_APPROVAL,
    SAFE_STUDIO_TOOLS,
    STUDIO_AGENT_TOOL_PROFILE,
    STUDIO_WITHHELD_TOOLS,
    StudioAgentRuntime,
    _studio_agent_tool_profile,
    studio_permission_policy,
)

WIDENING_RULES = """# Project rules

Answer tersely and in English.

## Policy
xtb_real_runs: allow
"""


class StudioPermissionPolicyTest(unittest.TestCase):
    """`CHEMSMART.md` may shape prose. It must never widen what Studio is allowed to run."""

    def setUp(self) -> None:
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        (self.root / "CHEMSMART.md").write_text(WIDENING_RULES, encoding="utf-8")

    def test_rules_file_cannot_widen_real_runs(self) -> None:
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

        rules = load_behavior_rules()
        # The prose path works: the file is found in the workspace Studio gave the sidecar.
        self.assertTrue(rules.loaded)
        self.assertIn("tersely", rules.text)
        # And the file really does ask for a wider policy, so this is not a vacuous assertion.
        self.assertEqual(rules.policy.get("xtb_real_runs"), "allow")

        self.assertEqual(studio_permission_policy().xtb_real_runs, "ask")

    def test_environment_cannot_widen_real_runs(self) -> None:
        with mock.patch.dict(os.environ, {"CHEMSMART_XTB_REAL_RUNS": "auto"}):
            self.assertEqual(studio_permission_policy().xtb_real_runs, "ask")

    def test_only_non_executing_tools_are_session_allowed(self) -> None:
        policy = studio_permission_policy()

        self.assertEqual(policy.session_allow, set(SAFE_STUDIO_TOOLS))
        # Nothing that runs chemistry or reaches a cluster may be pre-allowed for the session.
        for tool in (
            "run_local",
            "submit_hpc",
            "start_prepared_optimization",
            "write_project_yaml",
        ):
            self.assertNotIn(tool, policy.session_allow)

    def test_preview_and_fake_execution_still_require_main_approval(self) -> None:
        policy = studio_permission_policy()
        requests = (
            tool_request(
                "execute_chemsmart_command",
                command="chemsmart run gaussian sp water",
                test=True,
            ),
            tool_request(
                "submit_hpc",
                job="job_abcd",
                server="cluster-a",
                execute=False,
            ),
            tool_request("run_local", job="job_abcd"),
        )

        for request in requests:
            with self.subTest(tool=request.name):
                resolved = policy.resolve(request)
                self.assertEqual(resolved.decision, ResolvedDecision.NEEDS_USER)
                self.assertEqual(resolved.reason, "studio_always_ask")


class StudioToolProfileTest(unittest.TestCase):
    """Studio exposes only the bounded tools assigned to each task phase."""

    def phase_tools(
        self, workflow: str = "calculation"
    ) -> dict[str, tuple[str, ...]]:
        profile = _studio_agent_tool_profile(workflow)
        return {
            phase.name: profile.tools_for(phase, ProviderRole.CONTROLLER)
            for phase in TaskPhase
        }

    def test_withheld_tools_never_appear_in_a_phase(self) -> None:
        for phase, tools in self.phase_tools().items():
            for withheld in STUDIO_WITHHELD_TOOLS:
                self.assertNotIn(
                    withheld, tools, f"{withheld} must not be reachable in {phase}"
                )

    def test_every_phase_respects_the_harness_menu_cap(self) -> None:
        # Only direct tools are offered to the model. The Studio contract allows at most ten in a
        # phase so the execution surface stays reviewable as it gains three explicit tools.
        for phase, tools in self.phase_tools().items():
            self.assertLessEqual(len(tools), 10, f"{phase} exposes {len(tools)} tools")

    def test_all_six_workflows_end_in_the_terminal_report_tool(self) -> None:
        for workflow in (
            "general",
            "project_setup",
            "command",
            "molecule",
            "calculation",
            "results",
        ):
            with self.subTest(workflow=workflow):
                for tools in self.phase_tools(workflow).values():
                    if not tools:
                        continue
                    self.assertEqual(tools[-1], "report_studio_result")
                    self.assertLessEqual(len(tools), 10)

    def test_general_is_read_only_science_and_inspection(self) -> None:
        exposed = set().union(*map(set, self.phase_tools("general").values()))

        self.assertIn("analyze_current_molecule", exposed)
        self.assertIn("recommend_method", exposed)
        self.assertNotIn("render_project_yaml", exposed)
        self.assertNotIn("synthesize_command", exposed)
        self.assertFalse(exposed & ALWAYS_STUDIO_APPROVAL)

    def test_project_setup_is_yaml_preview_only(self) -> None:
        exposed = set().union(*map(set, self.phase_tools("project_setup").values()))

        for tool in (
            "read_project_yaml",
            "render_project_yaml",
            "validate_project_yaml",
            "critic_project_yaml",
        ):
            self.assertIn(tool, exposed)
        self.assertNotIn("synthesize_command", exposed)
        self.assertNotIn("execute_chemsmart_command", exposed)

    def test_command_is_parser_owned_dry_run_without_yaml_or_execution(self) -> None:
        exposed = set().union(*map(set, self.phase_tools("command").values()))

        self.assertIn("synthesize_command", exposed)
        self.assertIn("repair_command", exposed)
        self.assertNotIn("render_project_yaml", exposed)
        self.assertNotIn("execute_chemsmart_command", exposed)
        self.assertFalse(exposed & ALWAYS_STUDIO_APPROVAL)

    def test_molecule_is_draft_editing_without_calculation(self) -> None:
        exposed = set().union(*map(set, self.phase_tools("molecule").values()))

        for tool in (
            "get_molecule_snapshot",
            "analyze_current_molecule",
            "preview_molecule_patch",
            "commit_molecule_preview",
            "discard_molecule_preview",
        ):
            self.assertIn(tool, exposed)
        self.assertNotIn("prepare_molecule_optimization", exposed)
        self.assertNotIn("execute_chemsmart_command", exposed)

    def test_calculation_is_preflight_plus_exact_approval_execution(self) -> None:
        tools = self.phase_tools("calculation")
        exposed = set().union(*map(set, tools.values()))

        for tool in (
            "prepare_molecule_optimization",
            "validate_prepared_optimization",
            "synthesize_command",
            "start_prepared_optimization",
            "run_local",
            "submit_hpc",
            "execute_chemsmart_command",
        ):
            self.assertIn(tool, exposed)
        for tool in ("run_local", "submit_hpc", "execute_chemsmart_command"):
            self.assertIn(tool, tools["EXECUTION"])
            self.assertIn(tool, ALWAYS_STUDIO_APPROVAL)

    def test_results_reads_run_artifact_trajectory_and_replay(self) -> None:
        exposed = set().union(*map(set, self.phase_tools("results").values()))

        for tool in (
            "get_optimization_status",
            "list_calculation_artifacts",
            "read_calculation_artifact",
            "get_optimization_replay",
            "compare_optimization_frames",
            "inspect_calculation",
        ):
            self.assertIn(tool, exposed)
        self.assertFalse(exposed & ALWAYS_STUDIO_APPROVAL)

    def test_project_yaml_writes_are_not_model_reachable(self) -> None:
        for tool in ("write_project_yaml", "update_project_yaml"):
            for workflow in (
                "general",
                "project_setup",
                "command",
                "molecule",
                "calculation",
                "results",
            ):
                for phase_tools in self.phase_tools(workflow).values():
                    self.assertNotIn(tool, phase_tools)
            self.assertNotIn(tool, SAFE_STUDIO_TOOLS)

    def test_execution_phase_exposes_only_the_three_generic_execution_tools(
        self,
    ) -> None:
        tools = self.phase_tools("calculation")["EXECUTION"]

        for name in ("run_local", "submit_hpc", "execute_chemsmart_command"):
            self.assertIn(name, tools)
            self.assertNotIn(name, SAFE_STUDIO_TOOLS)
            self.assertNotIn(name, STUDIO_WITHHELD_TOOLS)


def tool_request(name: str, **arguments: object) -> ToolRequest:
    return ToolRequest(
        request_id=f"req-{name}",
        provider="openai",
        provider_call_id=f"call-{name}",
        name=name,
        arguments_json="{}",
        arguments=dict(arguments),
        raw={},
    )


class StudioApprovalSurfaceTest(unittest.TestCase):
    """Which tools Studio can actually decide about, and what happens to the rest."""

    def test_project_yaml_writers_are_refused_without_a_revision_bound_surface(
        self,
    ) -> None:
        # Studio does not expose these tools to the model. Defense in depth still rejects a forged request
        # until a revision-bound project preview and trusted approval surface exist.
        for name in ("write_project_yaml", "update_project_yaml"):
            self.assertNotIn(name, ALWAYS_STUDIO_APPROVAL)
            self.assertIsNone(
                StudioAgentRuntime._normalized_approval_arguments(
                    registry=None,
                    request=tool_request(name, project="demo", program="gaussian"),
                )
            )

    def test_calculation_execution_writes_have_an_approval_surface(self) -> None:
        for name in (
            "start_prepared_optimization",
            "run_local",
            "submit_hpc",
            "execute_chemsmart_command",
        ):
            self.assertIn(name, ALWAYS_STUDIO_APPROVAL)
        self.assertIn("commit_molecule_preview", SAFE_STUDIO_TOOLS)
        self.assertNotIn("commit_molecule_preview", ALWAYS_STUDIO_APPROVAL)

    def test_generic_execution_approval_arguments_are_exact_and_path_free(self) -> None:
        registry = ToolRegistry.default()
        cases = (
            ("run_local", {"job": "job_abcd"}),
            (
                "submit_hpc",
                {"job": "job_1234abcd", "server": "cluster-a", "execute": True},
            ),
            (
                "execute_chemsmart_command",
                {
                    "command": "chemsmart run gaussian sp water",
                    "test": True,
                    "timeout_s": 30,
                },
            ),
        )

        for name, arguments in cases:
            with self.subTest(name=name):
                self.assertEqual(
                    StudioAgentRuntime._normalized_approval_arguments(
                        registry,
                        tool_request(name, **arguments),
                    ),
                    arguments,
                )

        self.assertEqual(
            StudioAgentRuntime._normalized_approval_arguments(
                registry,
                tool_request(
                    "execute_chemsmart_command",
                    command="chemsmart run xtb -f water.xyz sp",
                ),
            ),
            {
                "command": "chemsmart run xtb -f water.xyz sp",
                "test": False,
                "timeout_s": 3600,
            },
        )

        malformed = (
            ("run_local", {"job": "not-a-handle"}),
            (
                "submit_hpc",
                {"job": "job_abcd", "server": {"name": "cluster-a"}},
            ),
            (
                "execute_chemsmart_command",
                {"command": "chemsmart run /private/input.xyz"},
            ),
        )
        for name, arguments in malformed:
            with self.subTest(name=name, malformed=True):
                self.assertIsNone(
                    StudioAgentRuntime._normalized_approval_arguments(
                        registry,
                        tool_request(name, **arguments),
                    )
                )


if __name__ == "__main__":
    unittest.main()
