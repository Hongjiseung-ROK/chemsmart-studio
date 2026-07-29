"""Path-free projection of ChemSmart's non-executing command preflight."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from chemsmart.agent.public_visibility import sanitize_public_payload
from chemsmart.agent.tools_command import inspect_chemsmart_command
from jsonschema import Draft202012Validator

from .generated_protocol import COMMAND_INSPECTION_RUNTIME_SCHEMA
from .rpc import RpcFault

_REQUEST_VALIDATOR = Draft202012Validator(
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": COMMAND_INSPECTION_RUNTIME_SCHEMA["$defs"],
        "$ref": "#/$defs/request",
    }
)
_RESULT_VALIDATOR = Draft202012Validator(COMMAND_INSPECTION_RUNTIME_SCHEMA)


class CommandInspectionAdapter:
    """Inspect one command without creating an AgentSession or subprocess."""

    def __init__(
        self,
        workspace: Path,
        *,
        inspection_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._workspace = workspace
        self._inspection_id_factory = inspection_id_factory or (
            lambda: f"inspection-{uuid4()}"
        )

    def inspect(self, params: Any) -> dict[str, Any]:
        if not _REQUEST_VALIDATOR.is_valid(params):
            raise RpcFault(-32602, "Invalid command inspection request")
        request = dict(params)
        raw = inspect_chemsmart_command(
            request["command"],
            request.get("intentDescription", ""),
            cwd=self._workspace,
        )
        public = sanitize_public_payload(raw)
        result = {
            "schemaVersion": public["schema_version"],
            "inspectionId": self._inspection_id_factory(),
            "sessionId": request["sessionId"],
            "status": public["status"],
            "commandDigest": public["command_digest"],
            "parse": {
                "accepted": public["parse"]["accepted"],
                "action": public["parse"]["action"],
                "program": public["parse"]["program"],
                "job": public["parse"]["job"],
                "project": public["parse"]["project"],
                "inputName": public["parse"]["input_name"],
                "charge": public["parse"]["charge"],
                "multiplicity": public["parse"]["multiplicity"],
                "method": {
                    "functional": public["parse"]["method"]["functional"],
                    "abInitio": public["parse"]["method"]["ab_initio"],
                    "basis": public["parse"]["method"]["basis"],
                    "auxBasis": public["parse"]["method"]["aux_basis"],
                    "solventModel": public["parse"]["method"]["solvent_model"],
                    "solventId": public["parse"]["method"]["solvent_id"],
                },
            },
            "intent": {
                "verdict": public["intent"]["verdict"],
                "failedRuleIds": public["intent"]["failed_rule_ids"],
                "assertions": public["intent"]["assertions"],
            },
            "semantic": {
                "verdict": public["semantic"]["verdict"],
                "complete": public["semantic"]["complete"],
                "failedRuleIds": public["semantic"]["failed_rule_ids"],
                "missingInfo": public["semantic"]["missing_info"],
                "issues": [
                    {
                        "ruleId": issue["rule_id"],
                        "severity": issue["severity"],
                        "message": issue["message"],
                    }
                    for issue in public["semantic"]["issues"]
                ],
            },
            "dryRun": {
                "state": public["dry_run"]["state"],
                "processStarted": public["dry_run"]["process_started"],
            },
            "executionPerformed": False,
            "approvalRequiredForExecution": True,
            "missingInfo": public["missing_info"],
            "extensions": {},
        }
        if not _RESULT_VALIDATOR.is_valid(result):
            raise RpcFault(-32603, "Command inspection produced an invalid result")
        return result


__all__ = ["CommandInspectionAdapter"]
