from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dev"))
sys.path.insert(0, str(ROOT / "services" / "chemsmart_bridge" / "src"))

from generate_protocol_models import (  # noqa: E402
    bundle_molecule_document_schema,
    bundle_protocol_schema,
    bundle_studio_approval_request_schema,
    bundle_studio_control_schema,
    bundle_studio_molecule_request_schema,
    bundle_studio_ui_event_schema,
    studio_agent_tool_input_schemas,
    studio_ui_update_tool,
)
from chemsmart_studio_bridge.generated_protocol import (  # noqa: E402
    COMMAND_INSPECTION_RUNTIME_SCHEMA,
    CONTROLLED_CALCULATION_RUNTIME_SCHEMA,
    EMIT_STUDIO_UI_UPDATE_TOOL,
    MOLECULE_PATCH_RUNTIME_SCHEMA,
    OPTIMIZATION_REPLAY_RUNTIME_SCHEMA,
    OPTIMIZATION_RUNTIME_SCHEMA,
    PREVIEW_RECEIPT_RUNTIME_SCHEMA,
    STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA,
    STUDIO_APPROVAL_REQUEST_SCHEMA,
    STUDIO_AGENT_TOOL_INPUT_SCHEMAS,
    STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA,
    STUDIO_COMMON_SCHEMA,
    STUDIO_CONTROL_RUNTIME_SCHEMA,
    STUDIO_CONTROL_SCHEMA,
    STUDIO_MOLECULE_REQUEST_RUNTIME_SCHEMA,
    STUDIO_MOLECULE_REQUEST_SCHEMA,
    STUDIO_UI_DELIVERY_SCHEMA,
    STUDIO_UI_EVENT_SCHEMA,
    STUDIO_UI_EVENT_RUNTIME_SCHEMA,
)
from chemsmart.agent.studio import (  # noqa: E402
    STUDIO_TOOL_NAMES,
    StudioToolAdapters,
    build_studio_tool_specs,
)


def contains_ref(value: object) -> bool:
    if isinstance(value, dict):
        return "$ref" in value or any(contains_ref(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_ref(item) for item in value)
    return False


def contains_external_ref(value: object) -> bool:
    if isinstance(value, dict):
        reference = value.get("$ref")
        return (isinstance(reference, str) and not reference.startswith("#")) or any(
            contains_external_ref(item) for item in value.values()
        )
    if isinstance(value, list):
        return any(contains_external_ref(item) for item in value)
    return False


def schema_property_names(value: object) -> set[str]:
    if isinstance(value, dict):
        names = set(value.get("properties", {}))
        for item in value.values():
            names.update(schema_property_names(item))
        return names
    if isinstance(value, list):
        names: set[str] = set()
        for item in value:
            names.update(schema_property_names(item))
        return names
    return set()


class ProtocolCodegenTest(unittest.TestCase):
    @staticmethod
    def _schema_documents() -> dict[str, dict]:
        return {
            path.name: json.loads(path.read_text())
            for path in (ROOT / "schemas/v1").glob("*.schema.json")
        }

    def test_generated_studio_ui_tool_matches_source(self) -> None:
        self.assertEqual(EMIT_STUDIO_UI_UPDATE_TOOL, studio_ui_update_tool())

    def test_generated_studio_ui_input_schema_is_self_contained(self) -> None:
        input_schema = EMIT_STUDIO_UI_UPDATE_TOOL["inputSchema"]
        Draft202012Validator.check_schema(input_schema)
        self.assertFalse(contains_ref(input_schema))

    def test_generated_canonical_event_schema_validates_without_source_files(
        self,
    ) -> None:
        common_resource = Resource.from_contents(STUDIO_COMMON_SCHEMA)
        registry = Registry().with_resource(
            STUDIO_COMMON_SCHEMA["$id"], common_resource
        )
        validator = Draft202012Validator(
            STUDIO_UI_EVENT_SCHEMA,
            registry=registry,
            format_checker=FormatChecker(),
        )
        valid = json.loads(
            (ROOT / "schemas/v1/fixtures/valid/studio-ui-event-status.json").read_text()
        )
        invalid = json.loads(
            (
                ROOT / "schemas/v1/fixtures/invalid/studio-ui-event-approval-kind.json"
            ).read_text()
        )
        self.assertFalse(list(validator.iter_errors(valid)))
        self.assertTrue(list(validator.iter_errors(invalid)))

    def test_generated_runtime_event_schema_is_self_contained(self) -> None:
        self.assertEqual(
            STUDIO_UI_EVENT_RUNTIME_SCHEMA,
            bundle_studio_ui_event_schema(
                STUDIO_UI_EVENT_SCHEMA,
                STUDIO_COMMON_SCHEMA,
            ),
        )
        Draft202012Validator.check_schema(STUDIO_UI_EVENT_RUNTIME_SCHEMA)
        self.assertFalse(contains_external_ref(STUDIO_UI_EVENT_RUNTIME_SCHEMA))

    def test_generated_runtime_molecule_schema_is_canonical_and_self_contained(
        self,
    ) -> None:
        molecule_schema = json.loads(
            (ROOT / "schemas/v1/molecule.schema.json").read_text()
        )
        runtime_schema = bundle_molecule_document_schema(
            molecule_schema, STUDIO_COMMON_SCHEMA
        )
        Draft202012Validator.check_schema(runtime_schema)
        self.assertFalse(contains_external_ref(runtime_schema))
        validator = Draft202012Validator(runtime_schema)
        valid = json.loads(
            (ROOT / "schemas/v1/fixtures/valid/molecule.json").read_text()
        )
        invalid = json.loads(
            (
                ROOT / "schemas/v1/fixtures/invalid/molecule-extra-property.json"
            ).read_text()
        )
        self.assertFalse(list(validator.iter_errors(valid)))
        self.assertTrue(list(validator.iter_errors(invalid)))

    def test_generated_delivery_schema_validates_typed_failure(self) -> None:
        common_resource = Resource.from_contents(STUDIO_COMMON_SCHEMA)
        registry = Registry().with_resource(
            STUDIO_COMMON_SCHEMA["$id"], common_resource
        )
        validator = Draft202012Validator(
            STUDIO_UI_DELIVERY_SCHEMA,
            registry=registry,
        )
        valid = json.loads(
            (
                ROOT
                / "schemas/v1/fixtures/valid/studio-ui-delivery-revision-conflict.json"
            ).read_text()
        )
        invalid = json.loads(
            (
                ROOT
                / "schemas/v1/fixtures/invalid/studio-ui-delivery-missing-identity.json"
            ).read_text()
        )
        self.assertFalse(list(validator.iter_errors(valid)))
        self.assertTrue(list(validator.iter_errors(invalid)))

    def test_generated_runtime_control_schema_is_canonical_and_self_contained(
        self,
    ) -> None:
        schema_documents = self._schema_documents()
        self.assertEqual(
            STUDIO_CONTROL_RUNTIME_SCHEMA,
            bundle_studio_control_schema(
                STUDIO_CONTROL_SCHEMA,
                schema_documents,
            ),
        )
        Draft202012Validator.check_schema(STUDIO_CONTROL_RUNTIME_SCHEMA)
        self.assertFalse(contains_external_ref(STUDIO_CONTROL_RUNTIME_SCHEMA))

    def test_generated_runtime_control_schema_rejects_forged_and_raw_fields(
        self,
    ) -> None:
        validator = Draft202012Validator(
            STUDIO_CONTROL_RUNTIME_SCHEMA,
            format_checker=FormatChecker(),
        )
        valid = json.loads(
            (ROOT / "schemas/v1/fixtures/valid/studio-control.json").read_text()
        )
        final_geometry = json.loads(
            (
                ROOT / "schemas/v1/fixtures/valid/studio-control-final-geometry.json"
            ).read_text()
        )
        invalid_paths = [
            ROOT
            / "schemas/v1/fixtures/invalid/studio-control-awaiting-without-final-geometry.json",
            ROOT
            / "schemas/v1/fixtures/invalid/studio-control-calculation-method-whitespace.json",
            ROOT / "schemas/v1/fixtures/invalid/studio-control-cancel-not-running.json",
            ROOT
            / "schemas/v1/fixtures/invalid/studio-control-final-geometry-running.json",
            ROOT
            / "schemas/v1/fixtures/invalid/studio-control-forged-trusted-fields.json",
            ROOT / "schemas/v1/fixtures/invalid/studio-control-frame-coordinates.json",
            ROOT
            / "schemas/v1/fixtures/invalid/studio-control-frame-count-without-latest.json",
            ROOT
            / "schemas/v1/fixtures/invalid/studio-control-latest-frame-zero-count.json",
            ROOT / "schemas/v1/fixtures/invalid/studio-control-raw-json.json",
        ]
        self.assertFalse(list(validator.iter_errors(valid)))
        self.assertFalse(list(validator.iter_errors(final_geometry)))
        for path in invalid_paths:
            with self.subTest(path=path.name):
                fixture = json.loads(path.read_text())
                self.assertTrue(list(validator.iter_errors(fixture)))
        serialized = json.dumps(STUDIO_CONTROL_RUNTIME_SCHEMA)
        self.assertNotIn('"argumentsJson"', serialized)
        self.assertNotIn('"payloadJson"', serialized)
        self.assertNotIn('"positions"', serialized)

    def test_generated_boundary_runtime_schemas_are_fresh_and_self_contained(
        self,
    ) -> None:
        schema_documents = self._schema_documents()
        runtime_schemas = {
            "molecule-patch.schema.json": MOLECULE_PATCH_RUNTIME_SCHEMA,
            "preview-receipt.schema.json": PREVIEW_RECEIPT_RUNTIME_SCHEMA,
            "optimization.schema.json": OPTIMIZATION_RUNTIME_SCHEMA,
            "optimization-replay.schema.json": OPTIMIZATION_REPLAY_RUNTIME_SCHEMA,
        }
        for source_name, runtime_schema in runtime_schemas.items():
            with self.subTest(source_name=source_name):
                self.assertEqual(
                    runtime_schema,
                    bundle_protocol_schema(
                        schema_documents[source_name],
                        source_name,
                        schema_documents,
                    ),
                )
                Draft202012Validator.check_schema(runtime_schema)
                self.assertFalse(contains_external_ref(runtime_schema))

    def test_generated_command_inspection_schema_is_path_free_and_non_executing(
        self,
    ) -> None:
        schema_documents = self._schema_documents()
        self.assertEqual(
            COMMAND_INSPECTION_RUNTIME_SCHEMA,
            bundle_protocol_schema(
                schema_documents["command-inspection.schema.json"],
                "command-inspection.schema.json",
                schema_documents,
            ),
        )
        Draft202012Validator.check_schema(COMMAND_INSPECTION_RUNTIME_SCHEMA)
        self.assertFalse(
            contains_external_ref(COMMAND_INSPECTION_RUNTIME_SCHEMA)
        )
        validator = Draft202012Validator(COMMAND_INSPECTION_RUNTIME_SCHEMA)
        valid = json.loads(
            (
                ROOT
                / "schemas/v1/fixtures/valid/command-inspection.json"
            ).read_text()
        )
        invalid_paths = sorted(
            (
                ROOT / "schemas/v1/fixtures/invalid"
            ).glob("command-inspection-*.json")
        )
        self.assertFalse(list(validator.iter_errors(valid)))
        for path in invalid_paths:
            with self.subTest(path=path.name):
                self.assertTrue(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        forbidden = {
            "argv",
            "cwd",
            "execute",
            "executablePath",
            "path",
            "pid",
            "stderr",
            "stdout",
            "workspace",
        }
        self.assertTrue(
            schema_property_names(COMMAND_INSPECTION_RUNTIME_SCHEMA).isdisjoint(
                forbidden
            )
        )

    def test_generated_controlled_calculation_schema_is_fresh_and_self_contained(
        self,
    ) -> None:
        schema_documents = self._schema_documents()
        self.assertEqual(
            CONTROLLED_CALCULATION_RUNTIME_SCHEMA,
            bundle_protocol_schema(
                schema_documents["controlled-calculation.schema.json"],
                "controlled-calculation.schema.json",
                schema_documents,
            ),
        )
        Draft202012Validator.check_schema(CONTROLLED_CALCULATION_RUNTIME_SCHEMA)
        self.assertFalse(contains_external_ref(CONTROLLED_CALCULATION_RUNTIME_SCHEMA))
        validator = Draft202012Validator(
            CONTROLLED_CALCULATION_RUNTIME_SCHEMA,
            format_checker=FormatChecker(),
        )
        valid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/valid").glob("controlled-calculation-*.json")
        )
        invalid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/invalid").glob("controlled-calculation-*.json")
        )
        for path in valid_paths:
            with self.subTest(path=path.name, expectation="valid"):
                self.assertFalse(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        for path in invalid_paths:
            with self.subTest(path=path.name, expectation="invalid"):
                self.assertTrue(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )

    def test_generated_studio_agent_tool_inputs_are_exact_bounded_and_path_free(
        self,
    ) -> None:
        expected_names = {
            "get_studio_context",
            "analyze_current_molecule",
            "report_studio_result",
            "prepare_molecule_optimization",
            "validate_prepared_optimization",
            "start_prepared_optimization",
            "get_optimization_status",
            "list_calculation_artifacts",
            "read_calculation_artifact",
            "get_optimization_replay",
            "compare_optimization_frames",
            "import_completed_calculation",
        }
        self.assertEqual(set(STUDIO_AGENT_TOOL_INPUT_SCHEMAS), expected_names)
        self.assertEqual(
            STUDIO_AGENT_TOOL_INPUT_SCHEMAS,
            studio_agent_tool_input_schemas(
                CONTROLLED_CALCULATION_RUNTIME_SCHEMA,
                STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA,
            ),
        )
        self.assertEqual(
            set(STUDIO_AGENT_TOOL_INPUT_SCHEMAS["get_studio_context"]),
            {"$schema", "additionalProperties", "type"},
        )
        for tool_name, input_schema in STUDIO_AGENT_TOOL_INPUT_SCHEMAS.items():
            with self.subTest(tool_name=tool_name, check="minimal-closure"):
                self.assertLess(len(json.dumps(input_schema)), 20_000)
                self.assertNotIn("agentToolRequest", input_schema.get("$defs", {}))
        valid_inputs = {
            "get_studio_context": {},
            "analyze_current_molecule": {
                "expected_revision": 3,
                "geometry_hash": "sha256:" + "1" * 64,
            },
            "report_studio_result": {
                "answer": {
                    "answerId": "answer-1",
                    "heading": "Inspection result",
                    "summary": "The visible molecule passed inspection.",
                    "sections": [
                        {
                            "kind": "finding",
                            "heading": "Finding",
                            "summary": "The molecule identity is internally consistent.",
                        }
                    ],
                    "extensions": {},
                },
                "artifacts": [],
            },
            "prepare_molecule_optimization": {
                "document_id": "ethanol",
                "expected_revision": 3,
                "geometry_hash": "sha256:" + "1" * 64,
                "engine": "xtb",
                "method": "GFN2-xTB",
                "settings": {
                    "maxSteps": 100,
                    "maxRuntimeSeconds": 180,
                    "threads": 1,
                    "charge": 0,
                    "multiplicity": 1,
                    "extensions": {},
                },
            },
            "validate_prepared_optimization": {
                "plan_id": "plan-1",
                "plan_digest": "sha256:" + "2" * 64,
            },
            "start_prepared_optimization": {
                "plan_id": "plan-1",
                "plan_digest": "sha256:" + "2" * 64,
            },
            "get_optimization_status": {"run_id": "run-1"},
            "list_calculation_artifacts": {
                "run_id": "run-1",
                "after_artifact_id": None,
                "limit": 20,
            },
            "read_calculation_artifact": {
                "artifact_id": "artifact-1",
                "offset": 0,
                "max_bytes": 65536,
            },
            "get_optimization_replay": {
                "run_id": "run-1",
                "offset": 0,
                "limit": 500,
            },
            "compare_optimization_frames": {
                "run_id": "run-1",
                "first_step_index": 0,
                "second_step_index": 1,
            },
            "import_completed_calculation": {
                "artifact_id": "artifact-1",
                "document_id": "ethanol",
                "expected_revision": 3,
                "geometry_hash": "sha256:" + "1" * 64,
            },
        }
        forbidden_properties = {
            "path",
            "filePath",
            "file_path",
            "projectPath",
            "project_path",
            "executablePath",
            "executable_path",
        }
        for tool_name, input_schema in STUDIO_AGENT_TOOL_INPUT_SCHEMAS.items():
            with self.subTest(tool_name=tool_name):
                Draft202012Validator.check_schema(input_schema)
                self.assertFalse(contains_external_ref(input_schema))
                self.assertTrue(
                    Draft202012Validator(input_schema).is_valid(valid_inputs[tool_name])
                )
                self.assertTrue(
                    schema_property_names(input_schema).isdisjoint(forbidden_properties)
                )
        self.assertFalse(
            Draft202012Validator(
                STUDIO_AGENT_TOOL_INPUT_SCHEMAS["read_calculation_artifact"]
            ).is_valid(
                {
                    "artifact_id": "artifact-1",
                    "offset": 0,
                    "max_bytes": 1024,
                    "path": "/private/tmp/artifact",
                }
            )
        )

    def test_generated_studio_agent_tool_inputs_bind_to_public_chemsmart_factory(
        self,
    ) -> None:
        class Adapter:
            def __getattr__(self, _name: str):
                return lambda _arguments: {"ok": True}

            def require_approval(
                self,
                _tool_name: str,
                _arguments: dict[str, object],
            ) -> None:
                return None

        adapter = Adapter()
        specs = build_studio_tool_specs(
            StudioToolAdapters(
                host=adapter,
                execution=adapter,
                artifacts=adapter,
                approvals=adapter,
            ),
            STUDIO_AGENT_TOOL_INPUT_SCHEMAS,
        )

        self.assertEqual(tuple(spec.name for spec in specs), STUDIO_TOOL_NAMES)

    def test_generated_approval_request_runtime_is_fresh_and_discriminated(
        self,
    ) -> None:
        schema_documents = self._schema_documents()
        self.assertEqual(
            STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA,
            bundle_studio_approval_request_schema(
                STUDIO_APPROVAL_REQUEST_SCHEMA,
                schema_documents,
            ),
        )
        Draft202012Validator.check_schema(STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA)
        self.assertFalse(contains_external_ref(STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA))
        validator = Draft202012Validator(STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA)
        valid_paths = [
            ROOT / "schemas/v1/fixtures/valid/studio-approval-request-commit.json",
            ROOT / "schemas/v1/fixtures/valid/studio-approval-request-calculation.json",
        ]
        invalid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/invalid").glob(
                "studio-approval-request-*.json"
            )
        )
        for path in valid_paths:
            with self.subTest(path=path.name):
                self.assertFalse(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        for path in invalid_paths:
            with self.subTest(path=path.name):
                self.assertTrue(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )

    def test_generated_molecule_request_runtime_is_fresh_and_session_bound(
        self,
    ) -> None:
        schema_documents = self._schema_documents()
        self.assertEqual(
            STUDIO_MOLECULE_REQUEST_RUNTIME_SCHEMA,
            bundle_studio_molecule_request_schema(
                STUDIO_MOLECULE_REQUEST_SCHEMA,
                schema_documents,
            ),
        )
        Draft202012Validator.check_schema(STUDIO_MOLECULE_REQUEST_RUNTIME_SCHEMA)
        self.assertFalse(contains_external_ref(STUDIO_MOLECULE_REQUEST_RUNTIME_SCHEMA))
        validator = Draft202012Validator(STUDIO_MOLECULE_REQUEST_RUNTIME_SCHEMA)
        valid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/valid").glob("studio-molecule-request-*.json")
        )
        invalid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/invalid").glob(
                "studio-molecule-request-*.json"
            )
        )
        for path in valid_paths:
            with self.subTest(path=path.name):
                self.assertFalse(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        for path in invalid_paths:
            with self.subTest(path=path.name):
                self.assertTrue(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )

    def test_generated_optimization_runtime_validates_native_boundary_variants(
        self,
    ) -> None:
        validator = Draft202012Validator(
            OPTIMIZATION_RUNTIME_SCHEMA,
            format_checker=FormatChecker(),
        )
        valid_paths = sorted(
            path
            for path in (ROOT / "schemas/v1/fixtures/valid").glob("optimization-*.json")
            if not path.name.startswith(("optimization-replay-", "optimization-trajectory-"))
        )
        invalid_paths = sorted(
            path
            for path in (ROOT / "schemas/v1/fixtures/invalid").glob(
                "optimization-*.json"
            )
            if not path.name.startswith(("optimization-replay-", "optimization-trajectory-"))
        )
        for path in valid_paths:
            with self.subTest(path=path.name):
                self.assertFalse(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        for path in invalid_paths:
            with self.subTest(path=path.name):
                self.assertTrue(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )

    def test_generated_replay_runtime_is_coordinate_free(self) -> None:
        validator = Draft202012Validator(
            OPTIMIZATION_REPLAY_RUNTIME_SCHEMA,
            format_checker=FormatChecker(),
        )
        valid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/valid").glob("optimization-replay-*.json")
        )
        invalid_paths = sorted(
            (ROOT / "schemas/v1/fixtures/invalid").glob("optimization-replay-*.json")
        )
        for path in valid_paths:
            with self.subTest(path=path.name):
                self.assertFalse(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        for path in invalid_paths:
            with self.subTest(path=path.name):
                self.assertTrue(
                    list(validator.iter_errors(json.loads(path.read_text())))
                )
        replay_definitions = {
            name: definition
            for name, definition in OPTIMIZATION_REPLAY_RUNTIME_SCHEMA["$defs"].items()
            if not name.startswith("bundled_")
        }
        serialized = json.dumps(replay_definitions)
        for forbidden in (
            '"positions"',
            '"atomIds"',
            '"atomicNumbers"',
            '"structureHash"',
            '"projectPath"',
            '"eventsPath"',
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, serialized)

    def test_generated_replay_queries_are_route_specific_and_bounded(self) -> None:
        def validator(definition: str) -> Draft202012Validator:
            return Draft202012Validator(
                {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "$defs": OPTIMIZATION_REPLAY_RUNTIME_SCHEMA["$defs"],
                    "$ref": f"#/$defs/{definition}",
                },
                format_checker=FormatChecker(),
            )

        cases = {
            "catalogQuery": (
                {"afterRunId": None, "limit": 50},
                [
                    {"afterRunId": None, "limit": 0},
                    {"afterRunId": None, "limit": 51},
                    {"afterRunId": None, "limit": 20, "offset": 0},
                ],
            ),
            "timelineQuery": (
                {"runId": "run-1", "offset": 0, "limit": 500},
                [
                    {"runId": "run-1", "offset": -1, "limit": 1},
                    {"runId": "run-1", "offset": 0, "limit": 501},
                ],
            ),
            "frameQuery": (
                {
                    "runId": "run-1",
                    "stepIndex": 0,
                    "documentId": "mol-1",
                    "expectedRevision": 2,
                },
                [
                    {"runId": "run-1", "stepIndex": 0},
                    {
                        "runId": "run-1",
                        "stepIndex": -1,
                        "documentId": "mol-1",
                        "expectedRevision": 2,
                    },
                ],
            ),
            "stopQuery": (
                {"documentId": "mol-1", "expectedRevision": 2},
                [
                    {"documentId": "mol-1"},
                    {
                        "documentId": "mol-1",
                        "expectedRevision": 2,
                        "runId": "run-1",
                    },
                ],
            ),
        }
        for definition, (valid, invalid_values) in cases.items():
            definition_validator = validator(definition)
            with self.subTest(definition=definition, expectation="valid"):
                self.assertFalse(list(definition_validator.iter_errors(valid)))
            for invalid in invalid_values:
                with self.subTest(
                    definition=definition,
                    expectation="invalid",
                    value=invalid,
                ):
                    self.assertTrue(list(definition_validator.iter_errors(invalid)))


if __name__ == "__main__":
    unittest.main()
