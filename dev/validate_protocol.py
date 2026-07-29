#!/usr/bin/env python3
"""Validate schema documents and pinned valid/invalid cross-language fixtures."""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ROOT = ROOT / "schemas" / "v1"

FIXTURE_SCHEMA = {
    "command-inspection": "command-inspection.schema.json",
    "command-synthesis": "command-synthesis.schema.json",
    "controlled-calculation": "controlled-calculation.schema.json",
    "manifest": "manifest.schema.json",
    "molecule-import": "molecule-import.schema.json",
    "molecule": "molecule.schema.json",
    "molecule-commit-receipt": "molecule-commit-receipt.schema.json",
    "molecule-patch": "molecule-patch.schema.json",
    "native-viewport": "native-viewport.schema.json",
    "preview-receipt": "preview-receipt.schema.json",
    "project-workspace": "project-workspace.schema.json",
    "research-project-session": "research-project-session.schema.json",
    "optimization-frame": "optimization.schema.json",
    "optimization-status": "optimization.schema.json",
    "optimization-cancellation": "optimization.schema.json",
    "optimization-completed-log-replay": "optimization.schema.json",
    "optimization-replay-catalog": "optimization-replay.schema.json",
    "optimization-replay-selection": "optimization-replay.schema.json",
    "optimization-replay-timeline": "optimization-replay.schema.json",
    "optimization-trajectory": "optimization-trajectory.schema.json",
    "optimization-final": "optimization.schema.json",
    "agent-event": "agent-event.schema.json",
    "studio-ui-event": "studio-ui-event.schema.json",
    "studio-agent-trace": "studio-agent-trace-event.schema.json",
    "studio-agent-workbench": "studio-agent-workbench.schema.json",
    "studio-ui-delivery": "studio-ui-delivery.schema.json",
    "studio-ui-update-input": "studio-ui-update-input.schema.json",
    "studio-control": "studio-control.schema.json",
    "studio-approval-request": "studio-approval-request.schema.json",
    "studio-molecule-request": "studio-molecule-request.schema.json",
    "studio-agent-molecule-request": "studio-agent-molecule-request.schema.json",
}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def build_registry(schemas: dict[str, dict]) -> Registry:
    resources = []
    for path_name, schema in schemas.items():
        resource = Resource.from_contents(schema)
        resources.append((schema["$id"], resource))
        resources.append(((SCHEMA_ROOT / path_name).as_uri(), resource))
    return Registry().with_resources(resources)


def fixture_key(path: Path) -> str:
    name = path.stem
    for key in sorted(FIXTURE_SCHEMA, key=len, reverse=True):
        if name == key or name.startswith(f"{key}-"):
            return key
    raise ValueError(f"No schema mapping for fixture {path}")


def main() -> int:
    schema_paths = sorted(SCHEMA_ROOT.glob("*.schema.json"))
    schemas = {path.name: load_json(path) for path in schema_paths}
    registry = build_registry(schemas)

    for path in schema_paths:
        Draft202012Validator.check_schema(schemas[path.name])

    results = []
    failures = []
    for expectation in ("valid", "invalid"):
        for fixture in sorted((SCHEMA_ROOT / "fixtures" / expectation).glob("*.json")):
            schema_name = FIXTURE_SCHEMA[fixture_key(fixture)]
            validator = Draft202012Validator(
                schemas[schema_name], registry=registry, format_checker=FormatChecker()
            )
            errors = sorted(validator.iter_errors(load_json(fixture)), key=lambda error: list(error.path))
            passed = (not errors) if expectation == "valid" else bool(errors)
            result = {
                "fixture": str(fixture.relative_to(ROOT)),
                "expectation": expectation,
                "schema": schema_name,
                "passed": passed,
                "error": errors[0].message if errors else None,
            }
            results.append(result)
            if not passed:
                failures.append(result)

    receipt = {
        "schemaVersion": 1,
        "gate": "protocol-fixtures",
        "passed": not failures,
        "schemaCount": len(schema_paths),
        "fixtureCount": len(results),
        "results": results,
    }
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
