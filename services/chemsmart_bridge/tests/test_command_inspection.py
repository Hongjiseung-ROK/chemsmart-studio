from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from jsonschema import Draft202012Validator

from chemsmart_studio_bridge.command_inspection import CommandInspectionAdapter
from chemsmart_studio_bridge.generated_protocol import (
    COMMAND_INSPECTION_RUNTIME_SCHEMA,
)
from chemsmart_studio_bridge.rpc import RpcFault
from chemsmart_studio_bridge.runtime import StudioAgentRuntime


class CommandInspectionAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.workspace = Path(self.temporary_directory.name)
        self.adapter = CommandInspectionAdapter(
            self.workspace,
            inspection_id_factory=lambda: "inspection-fixed",
        )

    @patch(
        "chemsmart.agent.harness.command_semantics.subprocess.run",
        side_effect=AssertionError("static inspection must not start a process"),
    )
    def test_projects_path_free_static_evidence(self, _run) -> None:
        result = self.adapter.inspect(
            {
                "sessionId": "session-1",
                "command": (
                    "chemsmart run xtb -f /private/research/water.xyz "
                    "-c 0 -m 1 -g gfn2 opt"
                ),
                "intentDescription": (
                    "Run a local neutral singlet GFN2-xTB geometry optimization."
                ),
            }
        )

        self.assertTrue(
            Draft202012Validator(COMMAND_INSPECTION_RUNTIME_SCHEMA).is_valid(result)
        )
        self.assertEqual(result["inspectionId"], "inspection-fixed")
        self.assertEqual(result["status"], "ready_for_dry_run")
        self.assertEqual(result["parse"]["inputName"], "water.xyz")
        self.assertEqual(result["intent"]["verdict"], "ok")
        self.assertFalse(result["semantic"]["complete"])
        self.assertFalse(result["dryRun"]["processStarted"])
        self.assertFalse(result["executionPerformed"])
        self.assertTrue(result["approvalRequiredForExecution"])
        self.assertNotIn("/private/research", repr(result))
        self.assertNotIn("argv", repr(result))
        self.assertNotIn("stdout", repr(result))

    @patch(
        "chemsmart.agent.harness.command_semantics.subprocess.run",
        side_effect=AssertionError("static inspection must not start a process"),
    )
    def test_accepts_program_agnostic_natural_research_intent(self, _run) -> None:
        result = self.adapter.inspect(
            {
                "sessionId": "session-1",
                "command": ("chemsmart run xtb -f water.xyz -c 0 -m 1 -g gfn2 opt"),
                "intentDescription": (
                    "Inspect a neutral singlet water geometry optimization "
                    "without executing it."
                ),
            }
        )

        self.assertTrue(
            Draft202012Validator(COMMAND_INSPECTION_RUNTIME_SCHEMA).is_valid(result)
        )
        self.assertEqual(result["status"], "ready_for_dry_run")
        self.assertEqual(
            result["intent"]["assertions"],
            [
                {"id": "intent.kind", "status": "pass"},
                {"id": "intent.charge", "status": "pass"},
                {"id": "intent.multiplicity", "status": "pass"},
            ],
        )
        self.assertFalse(result["dryRun"]["processStarted"])
        self.assertFalse(result["executionPerformed"])

    def test_marks_absent_independent_intent_unavailable(self) -> None:
        result = self.adapter.inspect(
            {
                "sessionId": "session-1",
                "command": "chemsmart run xtb -f water.xyz -c 0 -m 1 opt",
            }
        )

        self.assertEqual(result["status"], "needs_clarification")
        self.assertEqual(result["intent"]["verdict"], "unavailable")
        self.assertEqual(result["intent"]["assertions"], [])
        self.assertEqual(result["missingInfo"], ["explicit research intent"])

    def test_detects_independent_intent_drift(self) -> None:
        result = self.adapter.inspect(
            {
                "sessionId": "session-1",
                "command": "chemsmart run xtb -f water.xyz -c 0 -m 1 sp",
                "intentDescription": "Run a GFN2-xTB geometry optimization.",
            }
        )

        self.assertEqual(result["status"], "intent_reject")
        self.assertEqual(result["intent"]["failedRuleIds"], ["intent.kind"])

    def test_rejects_extra_host_control_fields(self) -> None:
        with self.assertRaisesRegex(
            RpcFault,
            "Invalid command inspection request",
        ):
            self.adapter.inspect(
                {
                    "sessionId": "session-1",
                    "command": "chemsmart run xtb -f water.xyz opt",
                    "execute": True,
                }
            )

    @patch.object(
        StudioAgentRuntime,
        "_run_turn",
        side_effect=AssertionError("inspection must not enter AgentSession"),
    )
    @patch.object(
        subprocess,
        "run",
        side_effect=AssertionError("inspection must not start a process"),
    )
    def test_runtime_routes_inspection_outside_agent_loop(
        self,
        _subprocess_run,
        _run_turn,
    ) -> None:
        runtime = StudioAgentRuntime(self.workspace)

        result = runtime(
            "command.inspect",
            {
                "sessionId": "session-1",
                "command": "chemsmart run xtb -f water.xyz -c 0 -m 1 opt",
                "intentDescription": "Run a GFN2-xTB geometry optimization.",
            },
        )

        self.assertEqual(result["status"], "ready_for_dry_run")


if __name__ == "__main__":
    unittest.main()
