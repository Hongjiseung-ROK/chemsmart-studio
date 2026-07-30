#!/usr/bin/env python3
"""Generate the active cross-language v2 surface from canonical schemas."""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import pprint
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas" / "v2"
COMPATIBILITY_SCHEMAS = ROOT / "schemas" / "v1"
PROTOCOL_VERSION = "2.0.0"

STUDIO_AGENT_TOOL_INPUT_DEFINITIONS = {
    "get_studio_context": "getStudioContextInput",
    "analyze_current_molecule": "analyzeCurrentMoleculeInput",
    "report_studio_result": "reportStudioResultInput",
    "prepare_molecule_optimization": "prepareMoleculeOptimizationInput",
    "validate_prepared_optimization": "validatePreparedOptimizationInput",
    "start_prepared_optimization": "startPreparedOptimizationInput",
    "get_optimization_status": "getOptimizationStatusInput",
    "list_calculation_artifacts": "listCalculationArtifactsInput",
    "read_calculation_artifact": "readCalculationArtifactInput",
    "get_optimization_replay": "getOptimizationReplayInput",
    "compare_optimization_frames": "compareOptimizationFramesInput",
    "import_completed_calculation": "importCompletedCalculationInput",
}


def schema_hash() -> str:
    digest = hashlib.sha256()
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        digest.update(path.name.encode())
        digest.update(
            json.dumps(
                json.loads(path.read_text()), sort_keys=True, separators=(",", ":")
            ).encode()
        )
    return digest.hexdigest()


def chem_smart_commit() -> str:
    lock = json.loads((ROOT / "upstreams.lock.json").read_text())
    commit = lock["upstreams"]["chemSmart"]["commit"]
    if not isinstance(commit, str) or len(commit) != 40:
        raise ValueError("upstreams.lock.json contains an invalid ChemSmart commit")
    return commit


def _bundle_common_references(
    source_schema: dict,
    common_schema: dict,
) -> dict:
    """Inline common-schema references for runtime validators with one input."""

    def resolve_pointer(document: dict, fragment: str) -> object:
        value: object = document
        for token in fragment.removeprefix("#/").split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if not isinstance(value, dict) or token not in value:
                raise ValueError(f"Unresolved JSON Schema pointer: {fragment}")
            value = value[token]
        return deepcopy(value)

    def inline(value: object) -> object:
        if isinstance(value, list):
            return [inline(item) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("common.schema.json#/"):
            resolved = resolve_pointer(
                common_schema,
                reference.removeprefix("common.schema.json"),
            )
            return inline(resolved)
        return {key: inline(item) for key, item in value.items()}

    bundled = inline(source_schema)
    if not isinstance(bundled, dict):
        raise TypeError("Bundled runtime schema must be an object")
    return bundled


def bundle_studio_ui_event_schema(
    event_schema: dict,
    common_schema: dict,
) -> dict:
    return _bundle_common_references(event_schema, common_schema)


def bundle_molecule_document_schema(
    molecule_schema: dict,
    common_schema: dict,
) -> dict:
    """Build the self-contained MoleculeDocument schema used at runtime."""

    return _bundle_common_references(molecule_schema, common_schema)


def _bundle_inline_protocol_schema(
    source_schema: dict,
    source_name: str,
    schema_documents: dict[str, dict],
) -> dict:
    """Inline every canonical reference needed by a runtime validator."""

    def resolve_pointer(document: dict, fragment: str) -> object:
        if not fragment:
            return deepcopy(document)
        value: object = document
        for token in fragment.removeprefix("#/").split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if not isinstance(value, dict) or token not in value:
                raise ValueError(f"Unresolved JSON Schema pointer: {fragment}")
            value = value[token]
        return deepcopy(value)

    def inline(value: object, document_name: str) -> object:
        if isinstance(value, list):
            return [inline(item, document_name) for item in value]
        if not isinstance(value, dict):
            return value

        reference = value.get("$ref")
        if isinstance(reference, str):
            if reference.startswith("#"):
                target_name = document_name
                fragment = reference
            else:
                target_name, _, raw_fragment = reference.partition("#")
                fragment = f"#{raw_fragment}" if raw_fragment else ""
            if target_name not in schema_documents:
                raise ValueError(f"Unresolved JSON Schema document: {target_name}")
            resolved = inline(
                resolve_pointer(schema_documents[target_name], fragment),
                target_name,
            )
            if not isinstance(resolved, dict):
                raise TypeError(
                    f"Referenced JSON Schema must be an object: {reference}"
                )
            siblings = {
                key: inline(item, document_name)
                for key, item in value.items()
                if key != "$ref"
            }
            return {**resolved, **siblings}

        return {key: inline(item, document_name) for key, item in value.items()}

    bundled = inline(source_schema, source_name)
    if not isinstance(bundled, dict):
        raise TypeError(f"Bundled {source_name} schema must be an object")
    return bundled


def bundle_studio_control_schema(
    control_schema: dict,
    schema_documents: dict[str, dict],
) -> dict:
    return _bundle_inline_protocol_schema(
        control_schema,
        "studio-control.schema.json",
        schema_documents,
    )


def bundle_protocol_schema(
    source_schema: dict,
    source_name: str,
    schema_documents: dict[str, dict],
) -> dict:
    """Bundle transitive documents under local definitions and retain local refs."""

    def definition_name(document_name: str) -> str:
        return "bundled_" + "".join(
            character if character.isalnum() else "_" for character in document_name
        )

    bundled_documents: dict[str, dict] = {}

    def local_reference(document_name: str, fragment: str) -> str:
        if document_name == source_name:
            return fragment or "#"
        return f"#/$defs/{definition_name(document_name)}{fragment.removeprefix('#')}"

    def collect(document_name: str) -> None:
        if document_name == source_name or document_name in bundled_documents:
            return
        if document_name not in schema_documents:
            raise ValueError(f"Unresolved JSON Schema document: {document_name}")
        bundled_documents[document_name] = {}
        transformed = rewrite(schema_documents[document_name], document_name)
        if not isinstance(transformed, dict):
            raise TypeError(f"Bundled JSON Schema must be an object: {document_name}")
        transformed.pop("$schema", None)
        transformed.pop("$id", None)
        bundled_documents[document_name] = transformed

    def rewrite(value: object, document_name: str) -> object:
        if isinstance(value, list):
            return [rewrite(item, document_name) for item in value]
        if not isinstance(value, dict):
            return value
        rewritten = {
            key: rewrite(item, document_name)
            for key, item in value.items()
            if key != "$ref"
        }
        reference = value.get("$ref")
        if not isinstance(reference, str):
            return rewritten
        if reference.startswith("#"):
            target_name = document_name
            fragment = reference
        else:
            target_name, separator, raw_fragment = reference.partition("#")
            fragment = f"#{raw_fragment}" if separator else ""
        collect(target_name)
        return {"$ref": local_reference(target_name, fragment), **rewritten}

    bundled = rewrite(source_schema, source_name)
    if not isinstance(bundled, dict):
        raise TypeError(f"Bundled {source_name} schema must be an object")
    definitions = bundled.setdefault("$defs", {})
    if not isinstance(definitions, dict):
        raise TypeError(f"Schema definitions must be an object: {source_name}")
    for document_name, document in sorted(bundled_documents.items()):
        definitions[definition_name(document_name)] = document
    return bundled


def bundle_studio_approval_request_schema(
    approval_schema: dict,
    schema_documents: dict[str, dict],
) -> dict:
    return bundle_protocol_schema(
        approval_schema,
        "studio-approval-request.schema.json",
        schema_documents,
    )


def bundle_studio_molecule_request_schema(
    request_schema: dict,
    schema_documents: dict[str, dict],
) -> dict:
    return bundle_protocol_schema(
        request_schema,
        "studio-molecule-request.schema.json",
        schema_documents,
    )


def bundle_studio_agent_molecule_request_schema(
    agent_request_schema: dict,
    schema_documents: dict[str, dict],
) -> dict:
    """Inline the schema-owned sidecar subset for Zod's non-recursive runtime converter."""

    return _bundle_inline_protocol_schema(
        agent_request_schema,
        "studio-agent-molecule-request.schema.json",
        schema_documents,
    )


def studio_agent_tool_input_schemas(
    controlled_calculation_runtime_schema: dict,
    studio_agent_workbench_runtime_schema: dict,
) -> dict[str, dict]:
    """Project canonical input definitions into self-contained model tool schemas."""

    calculation_definitions = controlled_calculation_runtime_schema.get("$defs")
    workbench_definitions = studio_agent_workbench_runtime_schema.get("$defs")
    if not isinstance(calculation_definitions, dict):
        raise TypeError("Controlled calculation schema definitions must be an object")
    if not isinstance(workbench_definitions, dict):
        raise TypeError("Studio Agent workbench schema definitions must be an object")
    definitions = {**calculation_definitions, **workbench_definitions}
    missing = sorted(
        definition
        for definition in STUDIO_AGENT_TOOL_INPUT_DEFINITIONS.values()
        if definition not in definitions
    )
    if missing:
        raise ValueError(f"Missing Studio agent tool input definitions: {missing!r}")
    return {
        tool_name: _self_contained_definition_schema(definitions, definition)
        for tool_name, definition in STUDIO_AGENT_TOOL_INPUT_DEFINITIONS.items()
    }


def _self_contained_definition_schema(
    definitions: dict[str, dict],
    definition_name: str,
) -> dict:
    root = deepcopy(definitions[definition_name])
    required: dict[str, dict] = {}
    pending = list(_referenced_definition_names(root))
    while pending:
        referenced_name = pending.pop()
        if referenced_name in required:
            continue
        referenced = definitions.get(referenced_name)
        if not isinstance(referenced, dict):
            raise ValueError(
                f"Missing referenced Studio agent tool definition: {referenced_name!r}"
            )
        required[referenced_name] = deepcopy(referenced)
        pending.extend(_referenced_definition_names(referenced))

    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        **root,
    }
    if required:
        schema["$defs"] = {name: required[name] for name in sorted(required)}
    return schema


def _referenced_definition_names(value: object) -> set[str]:
    names: set[str] = set()
    if isinstance(value, dict):
        reference = value.get("$ref")
        prefix = "#/$defs/"
        if isinstance(reference, str) and reference.startswith(prefix):
            encoded = reference[len(prefix) :].split("/", 1)[0]
            names.add(encoded.replace("~1", "/").replace("~0", "~"))
        for child in value.values():
            names.update(_referenced_definition_names(child))
    elif isinstance(value, list):
        for child in value:
            names.update(_referenced_definition_names(child))
    return names


def typescript(
    checksum: str,
    chem_smart_pin: str,
    manifest_runtime_schema: dict,
    molecule_document_runtime_schema: dict,
    molecule_import_runtime_schema: dict,
    molecule_patch_runtime_schema: dict,
    studio_draft_runtime_schema: dict,
    preview_receipt_runtime_schema: dict,
    molecule_commit_receipt_runtime_schema: dict,
    optimization_runtime_schema: dict,
    optimization_replay_runtime_schema: dict,
    optimization_trajectory_runtime_schema: dict,
    studio_agent_trace_event_runtime_schema: dict,
    studio_agent_workbench_runtime_schema: dict,
    studio_control_schema: dict,
    studio_control_runtime_schema: dict,
    studio_approval_request_schema: dict,
    studio_approval_request_runtime_schema: dict,
    studio_molecule_request_schema: dict,
    studio_molecule_request_runtime_schema: dict,
    studio_agent_molecule_request_runtime_schema: dict,
    controlled_calculation_runtime_schema: dict,
    command_inspection_runtime_schema: dict,
    command_synthesis_runtime_schema: dict,
    project_workspace_runtime_schema: dict,
    research_project_session_runtime_schema: dict,
    protocol_hello_runtime_schema: dict,
    studio_agent_live_event_runtime_schema: dict,
    studio_agent_action_cue_runtime_schema: dict,
    stage_placement_intent_runtime_schema: dict,
    studio_console_completion_runtime_schema: dict,
    common_schema: dict,
) -> str:
    manifest_runtime_schema_literal = json.dumps(
        manifest_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    research_project_session_runtime_schema_literal = json.dumps(
        research_project_session_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    protocol_hello_runtime_schema_literal = json.dumps(
        protocol_hello_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    studio_agent_live_event_runtime_schema_literal = json.dumps(
        studio_agent_live_event_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    studio_agent_action_cue_runtime_schema_literal = json.dumps(
        studio_agent_action_cue_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    stage_placement_intent_runtime_schema_literal = json.dumps(
        stage_placement_intent_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    studio_console_completion_runtime_schema_literal = json.dumps(
        studio_console_completion_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    molecule_document_runtime_schema_literal = json.dumps(
        molecule_document_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    molecule_import_runtime_schema_literal = json.dumps(
        molecule_import_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    molecule_patch_runtime_schema_literal = json.dumps(
        molecule_patch_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    studio_draft_runtime_schema_literal = json.dumps(
        studio_draft_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    preview_receipt_runtime_schema_literal = json.dumps(
        preview_receipt_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    molecule_commit_receipt_runtime_schema_literal = json.dumps(
        molecule_commit_receipt_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    optimization_runtime_schema_literal = json.dumps(
        optimization_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    optimization_replay_runtime_schema_literal = json.dumps(
        optimization_replay_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    optimization_trajectory_runtime_schema_literal = json.dumps(
        optimization_trajectory_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    agent_trace_runtime_schema_literal = json.dumps(
        studio_agent_trace_event_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    agent_workbench_runtime_schema_literal = json.dumps(
        studio_agent_workbench_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    control_schema_literal = json.dumps(
        studio_control_schema,
        indent=2,
        ensure_ascii=False,
    )
    control_runtime_schema_literal = json.dumps(
        studio_control_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    approval_request_schema_literal = json.dumps(
        studio_approval_request_schema,
        indent=2,
        ensure_ascii=False,
    )
    approval_request_runtime_schema_literal = json.dumps(
        studio_approval_request_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    molecule_request_schema_literal = json.dumps(
        studio_molecule_request_schema,
        indent=2,
        ensure_ascii=False,
    )
    molecule_request_runtime_schema_literal = json.dumps(
        studio_molecule_request_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    agent_molecule_request_runtime_schema_literal = json.dumps(
        studio_agent_molecule_request_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    controlled_calculation_runtime_schema_literal = json.dumps(
        controlled_calculation_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    command_inspection_runtime_schema_literal = json.dumps(
        command_inspection_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    command_synthesis_runtime_schema_literal = json.dumps(
        command_synthesis_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    project_workspace_runtime_schema_literal = json.dumps(
        project_workspace_runtime_schema,
        indent=2,
        ensure_ascii=False,
    )
    studio_agent_tool_input_schemas_literal = "\n".join(
        f"  {json.dumps(tool_name)}: "
        f"{json.dumps(input_schema, indent=2, ensure_ascii=False)},"
        for tool_name, input_schema in studio_agent_tool_input_schemas(
            controlled_calculation_runtime_schema,
            studio_agent_workbench_runtime_schema,
        ).items()
    )
    common_schema_literal = json.dumps(common_schema, indent=2, ensure_ascii=False)
    return f"""// Generated by dev/generate_protocol_models.py. Do not edit.
// schema-sha256: {checksum}

export type StableId = string
export type Vector3 = readonly [number, number, number]
export type AxisMask = readonly [boolean, boolean, boolean]
export type Extensions = Record<string, Record<string, unknown>>
export const PROTOCOL_VERSION = '{PROTOCOL_VERSION}' as const
export const SCHEMA_SHA256 = '{checksum}' as const
export const CHEMSMART_COMMIT = '{chem_smart_pin}' as const

export interface MoleculeAtom {{ id: StableId; atomicNumber: number; position: Vector3; formalCharge: number; isotope?: number; label?: string; extensions: Extensions }}
export interface MoleculeBond {{ id: StableId; atomIds: readonly [StableId, StableId]; order: 1 | 2 | 3; extensions: Extensions }}
export interface MoleculeConstraint {{ id: StableId; type: 'distance' | 'angle' | 'dihedral'; atomIds: StableId[]; target: number; unit: 'angstrom' | 'degree'; extensions: Extensions }}
export interface MoleculeProperties {{ name?: string; charge?: number; multiplicity?: number; extensions: Extensions }}
export interface MoleculeDocument {{ documentId: StableId; revision: number; atoms: MoleculeAtom[]; bonds: MoleculeBond[]; selections: StableId[]; frozenAxes: Record<StableId, AxisMask>; constraints: MoleculeConstraint[]; properties: MoleculeProperties; extensions: Extensions }}
export interface ProjectManifest {{ schemaVersion: '2.0.0'; protocolVersion: '2.0.0'; documentId: StableId; currentRevision: number; activeRunId: StableId | null; createdAt?: string; updatedAt?: string; extensions: Extensions }}
export interface HistoricalProjectManifestV1 {{ schemaVersion: '1.0.0'; protocolVersion: '1.0.0'; documentId: StableId; currentRevision: number; activeRunId: StableId | null; createdAt?: string; updatedAt?: string; extensions: Extensions }}
export interface StudioProtocolHello {{ protocolVersion: typeof PROTOCOL_VERSION; schemaSha256: string; chemSmartCommit: string }}
export interface StudioAgentLiveEvent {{ threadId: StableId; turnId: StableId; blockId: StableId; sequence: number; kind: 'text_started' | 'text_delta' | 'text_completed' | 'public_summary'; text?: string; transient: true }}
export interface StudioAgentActionCue {{ cueId: StableId; turnId: StableId; documentId: StableId; revision: number; geometryHash: string; kind: 'inspect' | 'place_atom' | 'set_bond' | 'freeze' | 'constrain' | 'move'; phase: 'running' | 'succeeded' | 'failed' | 'cancelled'; atomIds: StableId[]; bondIds: StableId[]; constraintIds: StableId[]; label: string }}
export type CoordinationGeometry = 'linear' | 'trigonal_planar' | 'tetrahedral' | 'trigonal_bipyramidal' | 'square_planar' | 'octahedral'
export interface StagePlacementIntent {{ documentId: StableId; expectedRevision: number; geometryHash: string; anchorAtomId?: StableId; atomicNumber: number; bondOrder: 1 | 2 | 3; coordinationGeometry: CoordinationGeometry; siteIndex?: number }}
export type StudioConsoleCompletionKind = 'command' | 'option' | 'choice' | 'argument' | 'file' | 'project' | 'server'
export interface StudioConsoleCompletionItem {{ id: StableId; label: string; insertText: string; kind: StudioConsoleCompletionKind; detail: string; appendSpace: boolean }}
export interface StudioConsoleCompletionResult {{ commandPath: string[]; replaceRange: {{ start: number; end: number }}; items: StudioConsoleCompletionItem[]; diagnostic?: {{ code: 'unsupported_shell_syntax' | 'invalid_prefix' | 'value_required'; message: string }} }}
export type MoleculeImportFormat = 'cjson' | 'sdf' | 'xyz'
export interface MoleculeImportRequest {{ capabilityId: StableId; format: MoleculeImportFormat; documentId: StableId; sizeBytes: number; extensions: Extensions }}
export interface MoleculeImportChunkRequest {{ capabilityId: StableId; offset: number; length: number; extensions: Extensions }}
export interface MoleculeImportChunkResponse {{ capabilityId: StableId; offset: number; sizeBytes: number; encoding: 'base64'; content: string; eof: boolean; extensions: Extensions }}
export interface MoleculeImportResult {{ document: MoleculeDocument; extensions: Extensions }}

export type MoleculeOperation =
  | {{ op: 'add_atoms'; atoms: MoleculeAtom[] }}
  | {{ op: 'remove_atoms'; atomIds: StableId[] }}
  | {{ op: 'add_bonds'; bonds: MoleculeBond[] }}
  | {{ op: 'remove_bonds'; bondIds: StableId[] }}
  | {{ op: 'set_positions'; positions: Array<{{ atomId: StableId; position: Vector3 }}> }}
  | {{ op: 'set_atomic_numbers'; atoms: Array<{{ atomId: StableId; atomicNumber: number }}> }}
  | {{ op: 'set_bond_orders'; bonds: Array<{{ bondId: StableId; order: 1 | 2 | 3 }}> }}
  | {{ op: 'set_selection'; atomIds: StableId[] }}
  | {{ op: 'set_frozen_axes'; masks: Array<{{ atomId: StableId; axes: AxisMask }}> }}
  | {{ op: 'set_constraints'; constraints: MoleculeConstraint[] }}
  | {{ op: 'remove_constraints'; constraintIds: StableId[] }}

export interface MoleculePatch {{ operationId: StableId; baseRevision: number; actor: 'human' | 'agent' | 'system'; previewOnly: true; operations: MoleculeOperation[]; extensions: Extensions }}
export interface PreviewDiff {{ operationCount?: number; addedAtomCount?: number; removedAtomCount?: number; movedAtomCount?: number; addedBondCount?: number; removedBondCount?: number; selectionChanged?: boolean; frozenAxesChanged?: boolean; constraintsChanged?: boolean }}
export type StudioPreviewOperationKind = MoleculeOperation['op']
export interface StudioPreviewElementChange {{ atomId: StableId; kind: 'added' | 'removed' | 'changed'; beforeAtomicNumber?: number; afterAtomicNumber?: number }}
export interface StudioPreviewSummary {{ operationKinds: StudioPreviewOperationKind[]; elementChanges: StudioPreviewElementChange[]; coordinateChangeCount: number; bondChangeCount: number; constraintChangeCount: number; affectedAtomIds: StableId[]; affectedBondIds: StableId[]; affectedConstraintIds: StableId[] }}
export type StageGestureKind = 'insert_atom' | 'insert_fragment' | 'insert_ring' | 'replace_atom' | 'move_atom' | 'delete_selection' | 'set_bond' | 'set_constraint'
export interface StageGestureIntent {{ gestureId: StableId; kind: StageGestureKind; atomicNumber?: number; fragmentName?: 'water' | 'methane' | 'benzene'; anchorAtomId?: StableId; position?: Vector3; bondOrder?: 1 | 2 | 3; createdAt: string; extensions: Extensions }}
export interface StudioDraftEntry {{ entryId: StableId; actor: 'human' | 'agent'; mode: 'build' | 'inspect' | 'measure' | 'constrain'; operations: MoleculeOperation[]; summary: StudioPreviewSummary; beforeHash: string; afterHash: string; gesture?: StageGestureIntent; createdAt: string; extensions: Extensions }}
export interface StudioDraftSnapshot {{ draftId: StableId; documentId: StableId; baseRevision: number; document: MoleculeDocument; entries: StudioDraftEntry[]; cursor: number; dirty: boolean; canUndo: boolean; canRedo: boolean; createdAt: string; updatedAt: string; extensions: Extensions }}
export type StudioAgentTraceKind = 'turn_started' | 'reasoning_summary' | 'tool_started' | 'permission_waiting' | 'tool_progress' | 'tool_succeeded' | 'tool_failed' | 'turn_completed' | 'turn_blocked'
export type StudioAgentTraceStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'denied'
export interface StudioAgentTraceDetail {{ argumentKeys?: string[]; resultKeys?: string[]; ruleIds?: string[]; verdict?: string; durationMs?: number }}
export interface StudioAgentTraceEvent {{ eventId: StableId; sessionId: StableId; turnId: StableId; sequence: number; timestamp: string; kind: StudioAgentTraceKind; status: StudioAgentTraceStatus; toolCallId?: StableId; toolName?: string; title: string; summary: string; detail?: StudioAgentTraceDetail; extensions: Extensions }}
export type StudioAgentAnswerSectionKind = 'finding' | 'evidence' | 'warning' | 'next_step'
export interface StudioAgentAnswerSection {{ kind: StudioAgentAnswerSectionKind; heading: string; summary: string }}
export interface StudioAgentAnswer {{ answerId: StableId; heading: string; summary: string; sections: StudioAgentAnswerSection[]; extensions: Extensions }}
export type StudioAgentArtifactKind = 'molecule_change' | 'calculation_plan' | 'preflight_receipt' | 'trajectory_result' | 'verification'
export interface StudioAgentArtifact {{ artifactId: StableId; kind: StudioAgentArtifactKind; heading: string; summary: string; documentId: StableId; revision: number; geometryHash: string; charge: number; multiplicity: number; engine?: 'xtb' | 'gaussian' | 'orca'; method?: string; calculationKind?: 'single_point' | 'optimization' | 'frequency' | 'transition_state' | 'scan' | 'other'; planId?: StableId; runId?: StableId; energy?: {{ value: number; unit: 'hartree' | 'eV' | 'kJ/mol' | 'kcal/mol' }}; affectedIds?: StableId[]; ruleIds?: string[]; verdict?: 'passed' | 'warning' | 'failed' | 'denied'; extensions: Extensions }}
export interface StudioAgentToolProjection {{ toolCallId: StableId; toolName: string; purpose: string; argumentKeys?: string[]; resultKeys?: string[]; ruleIds?: string[]; verdict?: string; durationMs?: number }}
export type StudioAgentTurnEventKind = 'user_message' | 'reasoning_summary' | 'tool_started' | 'permission_waiting' | 'tool_progress' | 'tool_succeeded' | 'tool_failed' | 'artifact_published' | 'answer_published' | 'turn_terminal'
export type StudioAgentTurnStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'needs_user'
export type StudioAgentTurnOutcome = 'completed' | 'denied' | 'failed' | 'cancelled' | 'needs_user'
export interface StudioAgentTurnEvent {{ eventId: StableId; threadId: StableId; turnId: StableId; sequence: number; timestamp: string; kind: StudioAgentTurnEventKind; status: StudioAgentTurnStatus; summary: string; tool?: StudioAgentToolProjection; approvalRef?: StableId; artifact?: StudioAgentArtifact; answer?: StudioAgentAnswer; outcome?: StudioAgentTurnOutcome; extensions: Extensions }}
export interface StudioAgentCapability {{ discovery: 'plus' | 'mention' | 'command'; key: string; label: string; description: string; capability: 'inspect' | 'plan' | 'act' | 'navigation'; contextRef?: StableId }}
export interface StudioAgentCapabilityManifest {{ projectId: StableId; threadId: StableId; generatedAt: string; items: StudioAgentCapability[]; extensions: Extensions }}
export interface StudioAgentComposerIntent {{ intentId: StableId; kind: 'inspect' | 'plan' | 'dry_run' | 'run' | 'review' | 'history' | 'new' | 'context'; capability: 'inspect' | 'plan' | 'act' | 'navigation'; contextRefs: StableId[]; prompt?: string; requiresExecutionApproval: boolean; extensions: Extensions }}
export interface StudioAgentReportResultInput {{ answer: StudioAgentAnswer; artifactRefs?: StableId[]; artifacts: StudioAgentArtifact[] }}
export interface StudioAgentTurnPage {{ threadId: StableId; events: StudioAgentTurnEvent[]; nextBeforeSequence: number | null; extensions: Extensions }}
export interface StudioAgentTurnPageRequest {{ threadId: StableId; beforeSequence: number | null; limit: number }}
export interface StudioAgentCapabilityManifestRequest {{ sessionId: StableId; threadId: StableId }}
export interface PreviewReceipt {{ previewId: StableId; operationId: StableId; baseRevision: number; affectedAtomIds: StableId[]; affectedBondIds: StableId[]; beforeHash: string; afterHash: string; diff: PreviewDiff; summary?: StudioPreviewSummary; createdAt: string; extensions: Extensions }}
export interface MoleculeCommitReceipt {{ type: 'molecule_commit'; previewId: StableId; revision: number; timestamp: string; geometryHash: string; stateHash: string }}
export interface OptimizationSettings {{ maxSteps?: number; forceThreshold?: number; charge?: number; multiplicity?: number; solvent?: string; extensions: Extensions }}
export interface OptimizationRun {{ runId: StableId; documentId: StableId; inputRevision: number; engine: 'xtb' | 'gaussian' | 'orca'; method: string; settings: OptimizationSettings; frozenAtomIds: StableId[]; constraintIds: StableId[]; status: 'pending_approval' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'awaiting_final_geometry'; createdAt: string; extensions: Extensions }}
export interface OptimizationConvergence {{ converged: boolean; threshold?: number; energyChange?: number | null; maxDisplacement?: number | null; rmsDisplacement?: number | null }}
export interface OptimizationGradientNorm {{ value: number; unit: 'hartree/bohr' | 'eV/angstrom' | 'kJ/mol/angstrom' }}
export interface OptimizationFrame {{ runId: StableId; stepIndex: number; atomIds: StableId[]; positions: Vector3[]; energy: {{ value: number; unit: 'hartree' | 'eV' | 'kJ/mol' | 'kcal/mol' }}; forceMetrics: {{ max?: number; rms?: number; unit: 'hartree/bohr' | 'eV/angstrom' | 'kJ/mol/angstrom' }}; convergence: OptimizationConvergence; structureHash: string; timestamp: string; extensions: Extensions }}
export interface OptimizationReplayFrameSummary {{ runId: StableId; stepIndex: number; energy: OptimizationFrame['energy']; forceMetrics?: OptimizationFrame['forceMetrics']; gradientNorm?: OptimizationGradientNorm; convergence?: OptimizationConvergence; timestamp: string }}
export type OptimizationReplayOutcome = 'running' | 'awaiting_final_geometry' | 'accepted' | 'rejected' | 'cancelled' | 'failed' | 'interrupted'
export interface OptimizationReplayCatalogQuery {{ afterRunId: StableId | null; limit: number }}
export interface OptimizationReplayTimelineQuery {{ runId: StableId; offset: number; limit: number }}
export interface OptimizationReplayFrameQuery {{ runId: StableId; stepIndex: number; documentId: StableId; expectedRevision: number }}
export interface OptimizationReplayStopQuery {{ documentId: StableId; expectedRevision: number }}
export interface OptimizationReplayRecord {{ run: OptimizationRun; frameCount: number; latestFrame: OptimizationReplayFrameSummary | null; outcome: OptimizationReplayOutcome; message: string; updatedAt: string; active: boolean; recovered: boolean; replayable: boolean; extensions: Extensions }}
export interface OptimizationReplayCatalog {{ totalRuns: number; runs: OptimizationReplayRecord[]; nextRunId: StableId | null; extensions: Extensions }}
export interface OptimizationReplayTimeline {{ runId: StableId; offset: number; limit: number; totalFrames: number; frames: OptimizationReplayFrameSummary[]; extensions: Extensions }}
export interface OptimizationReplayFrameResponse {{ runId: StableId; frame: ControlledCalculationExternalFrame; frameCount: number; extensions: Extensions }}
export interface OptimizationReplaySelection {{ viewing: boolean; runId: StableId | null; stepIndex: number | null; frameCount: number; documentId: StableId; revision: number; frame: OptimizationReplayFrameSummary | null; extensions: Extensions }}
export interface OptimizationTrajectoryOpenRunRequest {{ run: OptimizationRun; timestamp: string; inputSnapshotHash: string; inputTopologyHash: string }}
export interface OptimizationTrajectoryOpenRunResponse {{ runId: StableId; extensions: Extensions }}
export interface OptimizationTrajectoryAppendFrameRequest {{ frame: ControlledCalculationExternalFrame }}
export interface OptimizationTrajectoryAppendFrameResponse {{ accepted: true; runId: StableId; frameIndex: number; extensions: Extensions }}
export interface OptimizationTrajectoryCloseRunRequest {{ terminal: ControlledCalculationTerminal }}
export interface OptimizationTrajectoryCloseRunResponse {{ runId: StableId; outcome: 'awaiting_final_geometry' | 'cancelled' | 'failed'; extensions: Extensions }}
export type OptimizationFinalDecisionEvent =
  | {{ type: 'optimization_final_accept_requested'; runId: StableId; expectedRevision: number; geometryHash: string; timestamp: string }}
  | {{ type: 'optimization_final_reject_requested'; runId: StableId; expectedRevision: number; geometryHash: string; timestamp: string }}
  | {{ type: 'optimization_final_accepted'; runId: StableId; revision: number; geometryHash: string; timestamp: string }}
  | {{ type: 'optimization_final_rejected'; runId: StableId; revision: number; geometryHash: string; timestamp: string }}
  | {{ type: 'optimization_final_accept_failed'; runId: StableId; expectedRevision: number; geometryHash: string; timestamp: string; error: {{ code: string; message: string }} }}
  | {{ type: 'optimization_final_reject_failed'; runId: StableId; expectedRevision: number; geometryHash: string; timestamp: string; error: {{ code: string; message: string }} }}
export interface OptimizationTrajectoryRecordFinalEventRequest {{ event: OptimizationFinalDecisionEvent }}
export interface OptimizationTrajectoryRecordFinalEventResponse {{ accepted: true; event: OptimizationFinalDecisionEvent; extensions: Extensions }}
export interface OptimizationTrajectoryRunStateRequest {{ runId: StableId }}
export interface OptimizationTrajectoryRunState {{ run: OptimizationRun; frameCount: number; latestFrame: ControlledCalculationExternalFrame | null; terminal: ControlledCalculationTerminal | null; outcome: Exclude<OptimizationReplayOutcome, 'interrupted'>; latestFinalEvent: OptimizationFinalDecisionEvent | null; extensions: Extensions }}
export interface CompletedLogFrame {{ stepIndex: number; positions: Vector3[]; coordinateUnit: 'angstrom'; energy: {{ value: number; unit: 'hartree' | 'eV' | 'kJ/mol' | 'kcal/mol' }}; extensions: Extensions }}
export interface CompletedLogReplay {{ type: 'completed_log_replay'; engine: 'xtb' | 'gaussian' | 'orca'; completed: true; atomIds: StableId[]; atomicNumbers: number[]; frames: CompletedLogFrame[]; extensions: Extensions }}
export interface OptimizationStatusNotification {{ runId: StableId; status: 'failed' | 'awaiting_final_geometry'; message: string; stepCount: number }}
export interface OptimizationCancellationResponse {{ runId: StableId; status: 'cancelled'; stepCount: number }}
export interface OptimizationFinalCommit {{ type: 'optimization_final_commit'; runId: StableId; revision: number; timestamp: string; geometryHash: string }}
export interface OptimizationFinalRejected {{ type: 'optimization_final_rejected'; runId: StableId; revision: number; timestamp: string }}
export type OptimizationFinalResponse = OptimizationFinalCommit | OptimizationFinalRejected

export interface ControlledCalculationSettings {{ maxSteps: number; maxRuntimeSeconds: number; threads: 1; charge: number; multiplicity: number; forceThreshold?: {{ value: number; unit: 'hartree/bohr' | 'eV/angstrom' | 'kJ/mol/angstrom' }}; solvent?: string; extensions: Extensions }}
export interface ControlledCalculationBinding {{ sessionId: StableId; documentId: StableId; expectedRevision: number; geometryHash: string; source?: 'committed' | 'draft'; draftId?: StableId }}
export interface ControlledCalculationExecutableIdentity {{ kind: 'local_executable'; engine: 'xtb'; version: string; architecture: string; executableDigest: string; runtimeFingerprint: string; libraries: Array<{{ name: string; digest: string }}>; resources?: Array<{{ name: string; digest: string }}>; verifiedAt: string }}
export interface PreparedControlledCalculation {{ type: 'prepared_controlled_calculation'; planId: StableId; binding: ControlledCalculationBinding; engine: 'xtb'; method: string; settings: ControlledCalculationSettings; settingsDigest: string; planDigest: string; executable: ControlledCalculationExecutableIdentity; state: 'prepared' | 'validated'; createdAt: string; expiresAt: string; extensions: Extensions }}
export interface ControlledCalculationReservation {{ type: 'controlled_calculation_reservation'; runId: StableId; planId: StableId; planDigest: string; binding: ControlledCalculationBinding; executable: ControlledCalculationExecutableIdentity; reservedAt: string; extensions: Extensions }}
export interface ControlledCalculationExternalFrame {{ type: 'controlled_calculation_frame'; runId: StableId; frameIndex: number; engineStepIndex: number; atomIds: StableId[]; atomicNumbers: number[]; positions: Vector3[]; coordinateUnit: 'angstrom'; provenance: {{ coordinateSource: 'engine'; atomOrder: 'document_stable_id_order'; transformation: 'none' }}; energy: {{ value: number; unit: 'hartree' | 'eV' | 'kJ/mol' | 'kcal/mol' }}; forceMetrics?: {{ max?: number; rms?: number; unit: 'hartree/bohr' | 'eV/angstrom' | 'kJ/mol/angstrom' }}; gradientNorm?: OptimizationGradientNorm; convergence?: OptimizationFrame['convergence']; structureHash: string; timestamp: string; extensions: Extensions }}
export type ControlledCalculationTerminal =
  | {{ type: 'controlled_calculation_terminal'; runId: StableId; status: 'completed'; frameCount: number; outputGeometryHash: string; completedAt: string; extensions: Extensions }}
  | {{ type: 'controlled_calculation_terminal'; runId: StableId; status: 'failed'; frameCount: number; error: {{ code: string; message: string }}; terminatedAt: string; extensions: Extensions }}
  | {{ type: 'controlled_calculation_terminal'; runId: StableId; status: 'cancelled'; frameCount: number; reason: string; terminatedAt: string; extensions: Extensions }}
export interface ControlledCalculationFrameSummary {{ frameIndex: number; engineStepIndex: number; energy: ControlledCalculationExternalFrame['energy']; forceMetrics?: ControlledCalculationExternalFrame['forceMetrics']; gradientNorm?: ControlledCalculationExternalFrame['gradientNorm']; convergence?: ControlledCalculationExternalFrame['convergence']; structureHash: string; timestamp: string }}
export interface ControlledCalculationStatus {{ type: 'controlled_calculation_status'; reservation: ControlledCalculationReservation; state: 'reserved' | 'running' | 'completed' | 'failed' | 'cancelled'; frameCount: number; latestFrame: ControlledCalculationFrameSummary | null; terminal: ControlledCalculationTerminal | null; extensions: Extensions }}
export interface ControlledCalculationReplay {{ type: 'controlled_calculation_replay'; runId: StableId; offset: number; limit: number; totalFrames: number; frames: ControlledCalculationExternalFrame[]; extensions: Extensions }}
export interface ControlledCalculationFrameComparison {{ type: 'controlled_calculation_frame_comparison'; runId: StableId; firstFrameIndex: number; secondFrameIndex: number; atomCount: number; rmsDisplacement: number; maxDisplacement: number; unit: 'angstrom'; firstGeometryHash: string; secondGeometryHash: string; extensions: Extensions }}
export interface ControlledCalculationArtifact {{ type: 'opaque_calculation_artifact'; artifactId: StableId; runId: StableId; kind: 'input' | 'output' | 'log' | 'trajectory' | 'metadata'; displayName: string; mediaType: string; sizeBytes: number; sha256: string; createdAt: string; extensions: Extensions }}
export interface ControlledCalculationArtifactList {{ type: 'controlled_calculation_artifact_list'; runId: StableId; artifacts: ControlledCalculationArtifact[]; nextAfterArtifactId: StableId | null; extensions: Extensions }}
export interface ControlledCalculationArtifactChunk {{ artifact: ControlledCalculationArtifact; offset: number; encoding: 'utf8' | 'base64'; content: string; eof: boolean; extensions: Extensions }}
export interface ControlledCalculationImportResult {{ type: 'controlled_calculation_import_result'; artifactId: StableId; runId: StableId; status: 'completed'; frameCount: number; outputGeometryHash: string; extensions: Extensions }}
export type StudioWorkspacePane = 'explorer' | 'properties' | 'agent' | 'decisions' | 'console' | 'jobs' | 'problems'
export type StudioWorkspaceDisplay =
  | {{ state: 'committed'; documentId: StableId; revision: number; geometryHash: string }}
  | {{ state: 'draft'; documentId: StableId; baseRevision: number; draftId: StableId; geometryHash: string }}
  | {{ state: 'run' | 'replay'; documentId: StableId; inputRevision: number; runId: StableId; frameIndex: number | null }}
export interface StudioWorkspaceContext {{ type: 'studio_context'; sessionId: StableId; project: {{ projectHandleId: StableId; projectName: string }}; document: {{ documentId: StableId; revision: number; geometryHash: string }} | null; display: StudioWorkspaceDisplay; draft: {{ draftId: StableId; baseRevision: number; geometryHash: string; changeCount: number; dirty: boolean }} | null; selection: {{ atomIds: StableId[]; bondIds: StableId[] }}; editorMode: 'build' | 'inspect' | 'measure' | 'constrain'; panes: StudioWorkspacePane[]; activeRun: {{ runId: StableId; state: ControlledCalculationStatus['state']; frameCount: number }} | null; extensions: Extensions }}
export type StudioControlledCalculationContext = StudioWorkspaceContext
export type CurrentMoleculeBinding =
  | {{ state: 'committed'; documentId: StableId; revision: number; geometryHash: string }}
  | {{ state: 'draft'; documentId: StableId; baseRevision: number; draftId: StableId; geometryHash: string }}
export interface CurrentMoleculeAnalysis {{ type: 'current_molecule_analysis'; molecule: MoleculeDocument; geometryHash: string; binding: CurrentMoleculeBinding; atomCount: number; bondCount: number; elementCounts: Array<{{ atomicNumber: number; count: number }}>; formula: string; charge: number; multiplicity: number; extensions: Extensions }}
export interface ControlledCalculationAgentToolRequest {{ type: 'studio_agent_tool_request'; tool: 'get_studio_context' | 'analyze_current_molecule' | 'prepare_molecule_optimization' | 'validate_prepared_optimization' | 'start_prepared_optimization' | 'get_optimization_status' | 'list_calculation_artifacts' | 'read_calculation_artifact' | 'get_optimization_replay' | 'compare_optimization_frames' | 'import_completed_calculation'; arguments: Record<string, unknown> }}
export interface ControlledCalculationHostRequest {{ type: 'controlled_calculation_host_request'; sessionId: StableId; request: ControlledCalculationAgentToolRequest }}
export type ControlledCalculationHostResponse = StudioControlledCalculationContext | CurrentMoleculeAnalysis | PreparedControlledCalculation | ControlledCalculationReservation | ControlledCalculationStatus | ControlledCalculationArtifactList | ControlledCalculationArtifactChunk | ControlledCalculationReplay | ControlledCalculationFrameComparison | ControlledCalculationImportResult

export interface AgentEventPayload {{ gate?: 'intent' | 'semantic'; outcome?: 'passed' | 'failed' | 'needs_user' | 'denied'; reason?: string; tool?: string; requestId?: StableId; decision?: 'allow_once' | 'allow_session' | 'deny'; previewId?: StableId; receiptId?: StableId; revision?: number; frame?: OptimizationFrame; error?: {{ code: string; message: string }}; extensions: Extensions }}
export interface AgentEvent {{ eventId: StableId; sessionId: StableId; sequence: number; type: 'intent_gate' | 'semantic_gate' | 'tool_call' | 'approval_request' | 'approval_decision' | 'preview' | 'commit' | 'optimization_frame' | 'failure' | 'turn_completed'; timestamp: string; payload: AgentEventPayload; extensions: Extensions }}

export interface CommandInspectionRequest {{ sessionId: StableId; command: string; intentDescription?: string }}
export interface CommandInspectionMethod {{ functional: string | null; abInitio: string | null; basis: string | null; auxBasis: string | null; solventModel: string | null; solventId: string | null }}
export interface CommandInspectionParse {{ accepted: boolean; action: 'run' | 'sub' | null; program: 'gaussian' | 'orca' | 'xtb' | null; job: string | null; project: string | null; inputName: string | null; charge: string | null; multiplicity: string | null; method: CommandInspectionMethod }}
export interface CommandInspectionIntentAssertion {{ id: string; status: 'pass' | 'fail' }}
export interface CommandInspectionIntent {{ verdict: 'ok' | 'reject' | 'unavailable'; failedRuleIds: string[]; assertions: CommandInspectionIntentAssertion[] }}
export interface CommandInspectionSemanticIssue {{ ruleId: string; severity: 'warn' | 'reject'; message: string }}
export interface CommandInspectionSemantic {{ verdict: 'ok' | 'warn' | 'reject'; complete: false; failedRuleIds: string[]; missingInfo: string[]; issues: CommandInspectionSemanticIssue[] }}
export interface CommandInspectionResult {{ schemaVersion: '1'; inspectionId: StableId; sessionId: StableId; status: 'ready_for_dry_run' | 'needs_clarification' | 'intent_reject' | 'rejected'; commandDigest: string; parse: CommandInspectionParse; intent: CommandInspectionIntent; semantic: CommandInspectionSemantic; dryRun: {{ state: 'required'; processStarted: false }}; executionPerformed: false; approvalRequiredForExecution: true; missingInfo: string[]; extensions: Extensions }}

export type CommandSynthesisStatus = 'ready' | 'needsClarification' | 'intentRejected' | 'semanticRejected' | 'infeasible' | 'informational'
export type CommandSynthesisGateVerdict = 'ok' | 'warn' | 'reject' | 'unavailable'
export interface CommandSynthesisRequest {{ sessionId: StableId; modelId: string; request: string; extensions: Extensions }}
export interface CommandSynthesisIntentSummary {{ verdict: CommandSynthesisGateVerdict; failedRuleIds: string[]; message: string; extensions: Extensions }}
export interface CommandSynthesisSemanticSummary {{ verdict: CommandSynthesisGateVerdict; failedRuleIds: string[]; message: string; extensions: Extensions }}
export interface CommandSynthesisPublicEvidence {{ evidenceId: StableId; kind: 'intentGate' | 'semanticGate' | 'projectResolution' | 'commandValidation'; verdict: CommandSynthesisGateVerdict; summary: string; ruleIds: string[]; extensions: Extensions }}
export interface CommandSynthesisResult {{ schemaVersion: '1'; synthesisId: StableId; sessionId: StableId; status: CommandSynthesisStatus; command: string; commandDigest: string | null; explanation: string; projectName: string | null; missingInfo: string[]; intent: CommandSynthesisIntentSummary; semantic: CommandSynthesisSemanticSummary; publicEvidence: CommandSynthesisPublicEvidence[]; executionPerformed: false; approvalRequiredForExecution: true; extensions: Extensions }}

export type ProjectWorkspaceProgram = 'gaussian' | 'orca'
export type ProjectWorkspaceListedProgram = ProjectWorkspaceProgram | 'xtb'
export type ProjectWorkspaceVerdict = 'ok' | 'warn' | 'reject'
export interface ProjectWorkspaceIssue {{ ruleId: string; severity: 'info' | 'warn' | 'reject'; message: string; extensions: Extensions }}
export interface ProjectWorkspaceProgramListing {{ program: ProjectWorkspaceListedProgram; projectRequired: boolean; projectNames: string[]; extensions: Extensions }}
export interface ProjectWorkspaceListRequest {{ extensions: Extensions }}
export interface ProjectWorkspaceListResult {{ schemaVersion: '1'; programs: ProjectWorkspaceProgramListing[]; extensions: Extensions }}
export interface ProjectWorkspaceReadRequest {{ projectName: string; program: ProjectWorkspaceProgram; extensions: Extensions }}
export interface ProjectWorkspaceReadResult {{ schemaVersion: '1'; projectName: string; program: ProjectWorkspaceProgram; yamlText: string; extensions: Extensions }}
export interface ProjectWorkspaceValidateRequest {{ projectName: string; program: ProjectWorkspaceProgram; yamlText: string; extensions: Extensions }}
export interface ProjectWorkspaceValidateResult {{ schemaVersion: '1'; projectName: string; program: ProjectWorkspaceProgram; verdict: ProjectWorkspaceVerdict; issues: ProjectWorkspaceIssue[]; message: string; extensions: Extensions }}
export interface ProjectWorkspaceCritiqueRequest {{ projectName: string; program: ProjectWorkspaceProgram; yamlText: string; extensions: Extensions }}
export interface ProjectWorkspaceCritiqueResult {{ schemaVersion: '1'; projectName: string; program: ProjectWorkspaceProgram; verdict: ProjectWorkspaceVerdict; issues: ProjectWorkspaceIssue[]; summary: string; unsupportedFeatures: string[]; extensions: Extensions }}
export type ProjectWorkspaceRequest = ProjectWorkspaceListRequest | ProjectWorkspaceReadRequest | ProjectWorkspaceValidateRequest | ProjectWorkspaceCritiqueRequest
export type ProjectWorkspaceResult = ProjectWorkspaceListResult | ProjectWorkspaceReadResult | ProjectWorkspaceValidateResult | ProjectWorkspaceCritiqueResult

export interface StudioControlMoleculeSummary {{ documentId: StableId; revision: number }}
export interface PreviewCommitApproval {{ kind: 'preview_commit'; requestId: StableId; approvalId: StableId; requestedAt: string; expiresAt: string; risk: 'molecule_mutation'; receipt: PreviewReceipt; commitActionId: StableId; discardActionId: StableId }}
export interface CalculationStartApproval {{ kind: 'calculation_start'; requestId: StableId; approvalId: StableId; requestedAt: string; expiresAt: string; risk: 'calculation_execution'; documentId: StableId; expectedRevision: number; engine: OptimizationRun['engine']; method: string; settings: OptimizationSettings; allowActionId: StableId; denyActionId: StableId }}
export interface ControlledCalculationStartApproval {{ kind: 'controlled_calculation_start'; requestId: StableId; approvalId: StableId; requestedAt: string; expiresAt: string; risk: 'calculation_execution'; documentId: StableId; expectedRevision: number; engine: 'xtb'; method: 'GFN2-xTB'; settings: ControlledCalculationSettings; planId: StableId; planDigest: string; runtimeFingerprint: string; allowActionId: StableId; denyActionId: StableId }}
export type ExecutionToolApproval =
  | {{ kind: 'execution_tool'; requestId: StableId; approvalId: StableId; requestedAt: string; expiresAt: string; risk: 'calculation_execution'; tool: 'run_local'; arguments: {{ job: string }}; allowActionId: StableId; denyActionId: StableId }}
  | {{ kind: 'execution_tool'; requestId: StableId; approvalId: StableId; requestedAt: string; expiresAt: string; risk: 'calculation_execution'; tool: 'submit_hpc'; arguments: {{ job: string; server?: string | null; execute?: boolean }}; allowActionId: StableId; denyActionId: StableId }}
  | {{ kind: 'execution_tool'; requestId: StableId; approvalId: StableId; requestedAt: string; expiresAt: string; risk: 'calculation_execution'; tool: 'execute_chemsmart_command'; arguments: {{ command: string; test?: boolean; timeout_s?: number }}; documentId: StableId; expectedRevision: number; geometryHash: string; engine: 'xtb' | 'gaussian' | 'orca'; method: string; calculationKind: 'single_point' | 'optimization' | 'frequency' | 'transition_state' | 'scan' | 'other'; planId: StableId; commandDigest: string; allowActionId: StableId; denyActionId: StableId }}
export type StudioPendingApproval = PreviewCommitApproval | CalculationStartApproval | ControlledCalculationStartApproval | ExecutionToolApproval
export interface TrustedToolActivity {{ activityId: StableId; sequence: number; timestamp: string; kind: 'intent_gate' | 'semantic_gate' | 'tool_call' | 'tool_result' | 'runtime'; status: 'pending' | 'passed' | 'failed' | 'needs_user' | 'denied' | 'completed'; title: string; summary: string; toolName?: string; extensions: Extensions }}
export type StudioAgentPhase = 'idle' | 'understanding_request' | 'inspecting_molecule' | 'validating_intent' | 'validating_semantics' | 'preparing_preview' | 'awaiting_preview_decision' | 'preparing_calculation' | 'awaiting_calculation_approval' | 'running_calculation' | 'reviewing_trajectory' | 'awaiting_final_geometry_decision' | 'completed' | 'failed' | 'recovering'
export interface StudioAgentWorkspaceState {{ phase: StudioAgentPhase; currentObject: 'session' | 'molecule' | 'selection' | 'preview' | 'calculation_plan' | 'trajectory' | 'artifact'; activeTool: string | null; statusSummary: string; progress: number | null; focus: {{ atomIds: StableId[]; bondIds: StableId[] }}; latestGate: 'pending' | 'passed' | 'failed' | 'denied' | null; pendingTrustedAction: 'preview_commit' | 'calculation_start' | 'calculation_cancel' | 'final_geometry_decision' | null; requiresUserInput: boolean; terminalResult: 'completed' | 'failed' | 'cancelled' | 'denied' | null; recoverySequence: number; updatedAt: string; extensions: Extensions }}
export interface OptimizationFrameSummary {{ runId: StableId; stepIndex: number; energy: OptimizationFrame['energy']; forceMetrics?: OptimizationFrame['forceMetrics']; gradientNorm?: OptimizationGradientNorm; convergence?: OptimizationConvergence; structureHash: string; timestamp: string }}
export interface FinalGeometryControl {{ risk: 'final_geometry_commit'; expectedRevision: number; frame: OptimizationFrameSummary; acceptActionId: StableId; rejectActionId: StableId }}
export interface StudioOptimizationStatus {{ run: OptimizationRun; frameCount: number; latestFrame: OptimizationFrameSummary | null; cancelActionId?: StableId; finalGeometry: FinalGeometryControl | null; extensions: Extensions }}
export interface StudioControlSnapshot {{ sessionId: StableId; snapshotRevision: number; molecule: StudioControlMoleculeSummary | null; pendingApprovals: StudioPendingApproval[]; activity: TrustedToolActivity[]; optimization: StudioOptimizationStatus | null; agent?: StudioAgentWorkspaceState; extensions: Extensions }}

export type StudioApprovalRequest =
  | {{ sessionId: StableId; requestId: StableId; tool: 'commit_molecule_preview'; arguments: {{ preview_id: StableId; expected_revision: number }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'start_molecule_optimization'; arguments: {{ engine: OptimizationRun['engine']; method: string; settings: OptimizationSettings; expected_revision: number }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'start_prepared_optimization'; arguments: {{ plan_id: StableId; plan_digest: string }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'run_local'; arguments: {{ job: string }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'submit_hpc'; arguments: {{ job: string; server?: string | null; execute?: boolean }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'execute_chemsmart_command'; arguments: {{ command: string; test?: boolean; timeout_s?: number }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'cancel_molecule_optimization'; arguments: {{ run_id: StableId }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'accept_optimization_geometry'; arguments: {{ run_id: StableId; expected_revision: number }} }}
  | {{ sessionId: StableId; requestId: StableId; tool: 'reject_optimization_geometry'; arguments: {{ run_id: StableId }} }}

export type StudioMoleculeRequest =
  | {{ sessionId: StableId; method: 'molecule.get_snapshot'; params: Record<string, never> }}
  | {{ sessionId: StableId; method: 'molecule.set_selection'; params: {{ documentId: StableId; expectedRevision: number; atomIds: StableId[] }} }}
  | {{ sessionId: StableId; method: 'molecule.preview_patch'; params: {{ patch: MoleculePatch }} }}
  | {{ sessionId: StableId; method: 'molecule.commit_preview'; params: {{ previewId: StableId; expectedRevision: number }} }}
  | {{ sessionId: StableId; method: 'molecule.discard_preview'; params: {{ previewId: StableId }} }}
  | {{ sessionId: StableId; method: 'optimization.start'; params: {{ engine: OptimizationRun['engine']; method: string; settings: OptimizationSettings; expectedRevision: number }} }}
  | {{ sessionId: StableId; method: 'optimization.cancel'; params: {{ runId: StableId }} }}
  | {{ sessionId: StableId; method: 'optimization.accept_final'; params: {{ runId: StableId; expectedRevision: number }} }}
  | {{ sessionId: StableId; method: 'optimization.reject_final'; params: {{ runId: StableId }} }}

export type StudioAgentMoleculeRequest = Exclude<StudioMoleculeRequest, {{ method: 'molecule.set_selection' }}>

export interface ResearchThreadSummary {{ threadId: StableId; title: string; createdAt: string; updatedAt: string; activityCount: number; agentBound: boolean; imported: boolean }}
export interface ResearchProjectContext {{ projectId: StableId; projectName: string; activeThreadId: StableId | null; threads: ResearchThreadSummary[] }}
export interface ResearchThreadIndex {{ schemaVersion: 1; activeThreadId: StableId | null; threads: ResearchThreadSummary[] }}
export interface ResearchCreateThreadRequest {{ title: string }}
export interface ResearchRenameThreadRequest {{ threadId: StableId; title: string }}
export interface ResearchSelectThreadRequest {{ threadId: StableId }}

export const manifestRuntimeSchema = {manifest_runtime_schema_literal} as const
export const moleculeDocumentRuntimeSchema = {molecule_document_runtime_schema_literal} as const
export const moleculeImportRuntimeSchema = {molecule_import_runtime_schema_literal} as const
export const moleculePatchRuntimeSchema = {molecule_patch_runtime_schema_literal} as const
export const studioDraftRuntimeSchema = {studio_draft_runtime_schema_literal} as const
export const previewReceiptRuntimeSchema = {preview_receipt_runtime_schema_literal} as const
export const moleculeCommitReceiptRuntimeSchema = {molecule_commit_receipt_runtime_schema_literal} as const
export const optimizationRuntimeSchema = {optimization_runtime_schema_literal} as const
export const optimizationReplayRuntimeSchema = {optimization_replay_runtime_schema_literal} as const
export const optimizationTrajectoryRuntimeSchema = {optimization_trajectory_runtime_schema_literal} as const
export const studioAgentTraceEventRuntimeSchema = {agent_trace_runtime_schema_literal} as const
export const studioAgentWorkbenchRuntimeSchema = {agent_workbench_runtime_schema_literal} as const
export const studioControlSchema = {control_schema_literal} as const
export const studioControlRuntimeSchema = {control_runtime_schema_literal} as const
export const studioApprovalRequestSchema = {approval_request_schema_literal} as const
export const studioApprovalRequestRuntimeSchema = {approval_request_runtime_schema_literal} as const
export const studioMoleculeRequestSchema = {molecule_request_schema_literal} as const
export const studioMoleculeRequestRuntimeSchema = {molecule_request_runtime_schema_literal} as const
export const studioAgentMoleculeRequestRuntimeSchema = {agent_molecule_request_runtime_schema_literal} as const
export const controlledCalculationRuntimeSchema = {controlled_calculation_runtime_schema_literal} as const
export const commandInspectionRuntimeSchema = {command_inspection_runtime_schema_literal} as const
export const commandSynthesisRuntimeSchema = {command_synthesis_runtime_schema_literal} as const
export const projectWorkspaceRuntimeSchema = {project_workspace_runtime_schema_literal} as const
export const researchProjectSessionRuntimeSchema = {research_project_session_runtime_schema_literal} as const
export const protocolHelloRuntimeSchema = {protocol_hello_runtime_schema_literal} as const
export const studioAgentLiveEventRuntimeSchema = {studio_agent_live_event_runtime_schema_literal} as const
export const studioAgentActionCueRuntimeSchema = {studio_agent_action_cue_runtime_schema_literal} as const
export const stagePlacementIntentRuntimeSchema = {stage_placement_intent_runtime_schema_literal} as const
export const studioConsoleCompletionRuntimeSchema = {studio_console_completion_runtime_schema_literal} as const
export const studioAgentToolInputSchemas = {{
{studio_agent_tool_input_schemas_literal}
}} as const
export const studioCommonSchema = {common_schema_literal} as const
"""


def python_types(
    checksum: str,
    chem_smart_pin: str,
    manifest_runtime_schema: dict,
    molecule_document_runtime_schema: dict,
    molecule_import_runtime_schema: dict,
    molecule_patch_runtime_schema: dict,
    studio_draft_runtime_schema: dict,
    preview_receipt_runtime_schema: dict,
    molecule_commit_receipt_runtime_schema: dict,
    optimization_runtime_schema: dict,
    optimization_replay_runtime_schema: dict,
    optimization_trajectory_runtime_schema: dict,
    studio_agent_trace_event_runtime_schema: dict,
    studio_agent_workbench_runtime_schema: dict,
    studio_control_schema: dict,
    studio_control_runtime_schema: dict,
    studio_approval_request_schema: dict,
    studio_approval_request_runtime_schema: dict,
    studio_molecule_request_schema: dict,
    studio_molecule_request_runtime_schema: dict,
    studio_agent_molecule_request_runtime_schema: dict,
    controlled_calculation_runtime_schema: dict,
    command_inspection_runtime_schema: dict,
    command_synthesis_runtime_schema: dict,
    project_workspace_runtime_schema: dict,
    protocol_hello_runtime_schema: dict,
    studio_agent_live_event_runtime_schema: dict,
    studio_agent_action_cue_runtime_schema: dict,
    stage_placement_intent_runtime_schema: dict,
    studio_console_completion_runtime_schema: dict,
    common_schema: dict,
) -> str:
    manifest_runtime_schema_literal = pprint.pformat(
        manifest_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    molecule_document_runtime_schema_literal = pprint.pformat(
        molecule_document_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    molecule_import_runtime_schema_literal = pprint.pformat(
        molecule_import_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    molecule_patch_runtime_schema_literal = pprint.pformat(
        molecule_patch_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    studio_draft_runtime_schema_literal = pprint.pformat(
        studio_draft_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    preview_receipt_runtime_schema_literal = pprint.pformat(
        preview_receipt_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    molecule_commit_receipt_runtime_schema_literal = pprint.pformat(
        molecule_commit_receipt_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    optimization_runtime_schema_literal = pprint.pformat(
        optimization_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    optimization_replay_runtime_schema_literal = pprint.pformat(
        optimization_replay_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    optimization_trajectory_runtime_schema_literal = pprint.pformat(
        optimization_trajectory_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    agent_trace_runtime_schema_literal = pprint.pformat(
        studio_agent_trace_event_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    agent_workbench_runtime_schema_literal = pprint.pformat(
        studio_agent_workbench_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    control_schema_literal = pprint.pformat(
        studio_control_schema,
        sort_dicts=False,
        width=100,
    )
    control_runtime_schema_literal = pprint.pformat(
        studio_control_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    approval_request_schema_literal = pprint.pformat(
        studio_approval_request_schema,
        sort_dicts=False,
        width=100,
    )
    approval_request_runtime_schema_literal = pprint.pformat(
        studio_approval_request_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    molecule_request_schema_literal = pprint.pformat(
        studio_molecule_request_schema,
        sort_dicts=False,
        width=100,
    )
    molecule_request_runtime_schema_literal = pprint.pformat(
        studio_molecule_request_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    agent_molecule_request_runtime_schema_literal = pprint.pformat(
        studio_agent_molecule_request_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    controlled_calculation_runtime_schema_literal = pprint.pformat(
        controlled_calculation_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    command_inspection_runtime_schema_literal = pprint.pformat(
        command_inspection_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    command_synthesis_runtime_schema_literal = pprint.pformat(
        command_synthesis_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    project_workspace_runtime_schema_literal = pprint.pformat(
        project_workspace_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    protocol_hello_runtime_schema_literal = pprint.pformat(
        protocol_hello_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    studio_agent_live_event_runtime_schema_literal = pprint.pformat(
        studio_agent_live_event_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    studio_agent_action_cue_runtime_schema_literal = pprint.pformat(
        studio_agent_action_cue_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    stage_placement_intent_runtime_schema_literal = pprint.pformat(
        stage_placement_intent_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    studio_console_completion_runtime_schema_literal = pprint.pformat(
        studio_console_completion_runtime_schema,
        sort_dicts=False,
        width=100,
    )
    studio_agent_tool_input_schemas_literal = pprint.pformat(
        studio_agent_tool_input_schemas(
            controlled_calculation_runtime_schema,
            studio_agent_workbench_runtime_schema,
        ),
        sort_dicts=False,
        width=100,
    )
    common_schema_literal = pprint.pformat(common_schema, sort_dicts=False, width=100)
    return f"""# Generated by dev/generate_protocol_models.py. Do not edit.
# schema-sha256: {checksum}
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypedDict

Vector3 = tuple[float, float, float]
AxisMask = tuple[bool, bool, bool]
Extensions = dict[str, dict[str, Any]]
PROTOCOL_VERSION = "{PROTOCOL_VERSION}"
SCHEMA_SHA256 = "{checksum}"
CHEMSMART_COMMIT = "{chem_smart_pin}"

class StudioProtocolHello(TypedDict):
    protocolVersion: Literal["2.0.0"]
    schemaSha256: str
    chemSmartCommit: str

class StudioAgentLiveEvent(TypedDict):
    threadId: str
    turnId: str
    blockId: str
    sequence: int
    kind: Literal["text_started", "text_delta", "text_completed", "public_summary"]
    text: NotRequired[str]
    transient: Literal[True]

class StudioAgentActionCue(TypedDict):
    cueId: str
    turnId: str
    documentId: str
    revision: int
    geometryHash: str
    kind: Literal["inspect", "place_atom", "set_bond", "freeze", "constrain", "move"]
    phase: Literal["running", "succeeded", "failed", "cancelled"]
    atomIds: list[str]
    bondIds: list[str]
    constraintIds: list[str]
    label: str

class StagePlacementIntent(TypedDict):
    documentId: str
    expectedRevision: int
    geometryHash: str
    anchorAtomId: NotRequired[str]
    atomicNumber: int
    bondOrder: Literal[1, 2, 3]
    coordinationGeometry: Literal[
        "linear",
        "trigonal_planar",
        "tetrahedral",
        "trigonal_bipyramidal",
        "square_planar",
        "octahedral",
    ]
    siteIndex: NotRequired[int]

class StudioConsoleCompletionItem(TypedDict):
    id: str
    label: str
    insertText: str
    kind: Literal["command", "option", "choice", "argument", "file", "project", "server"]
    detail: str
    appendSpace: bool

class StudioConsoleCompletionDiagnostic(TypedDict):
    code: Literal["unsupported_shell_syntax", "invalid_prefix", "value_required"]
    message: str

class StudioConsoleCompletionResult(TypedDict):
    commandPath: list[str]
    replaceRange: dict[str, int]
    items: list[StudioConsoleCompletionItem]
    diagnostic: NotRequired[StudioConsoleCompletionDiagnostic]

class MoleculeAtom(TypedDict):
    id: str
    atomicNumber: int
    position: Vector3
    formalCharge: int
    isotope: NotRequired[int]
    label: NotRequired[str]
    extensions: Extensions

class MoleculeBond(TypedDict):
    id: str
    atomIds: tuple[str, str]
    order: Literal[1, 2, 3]
    extensions: Extensions

class MoleculeConstraint(TypedDict):
    id: str
    type: Literal["distance", "angle", "dihedral"]
    atomIds: list[str]
    target: float
    unit: Literal["angstrom", "degree"]
    extensions: Extensions

class MoleculeProperties(TypedDict):
    name: NotRequired[str]
    charge: NotRequired[int]
    multiplicity: NotRequired[int]
    extensions: Extensions

class MoleculeDocument(TypedDict):
    documentId: str
    revision: int
    atoms: list[MoleculeAtom]
    bonds: list[MoleculeBond]
    selections: list[str]
    frozenAxes: dict[str, AxisMask]
    constraints: list[MoleculeConstraint]
    properties: MoleculeProperties
    extensions: Extensions

class OptimizationSettings(TypedDict):
    maxSteps: NotRequired[int]
    forceThreshold: NotRequired[float]
    charge: NotRequired[int]
    multiplicity: NotRequired[int]
    solvent: NotRequired[str]
    extensions: Extensions

class MoleculePatch(TypedDict):
    operationId: str
    baseRevision: int
    actor: Literal["human", "agent", "system"]
    previewOnly: Literal[True]
    operations: list[dict[str, Any]]
    extensions: Extensions

class PreviewDiff(TypedDict):
    operationCount: NotRequired[int]
    addedAtomCount: NotRequired[int]
    removedAtomCount: NotRequired[int]
    movedAtomCount: NotRequired[int]
    addedBondCount: NotRequired[int]
    removedBondCount: NotRequired[int]
    selectionChanged: NotRequired[bool]
    frozenAxesChanged: NotRequired[bool]
    constraintsChanged: NotRequired[bool]

StudioPreviewOperationKind = Literal[
    "add_atoms",
    "remove_atoms",
    "add_bonds",
    "remove_bonds",
    "set_positions",
    "set_atomic_numbers",
    "set_bond_orders",
    "set_selection",
    "set_frozen_axes",
    "set_constraints",
    "remove_constraints",
]

class StudioPreviewElementChange(TypedDict):
    atomId: str
    kind: Literal["added", "removed", "changed"]
    beforeAtomicNumber: NotRequired[int]
    afterAtomicNumber: NotRequired[int]

class StudioPreviewSummary(TypedDict):
    operationKinds: list[StudioPreviewOperationKind]
    elementChanges: list[StudioPreviewElementChange]
    coordinateChangeCount: int
    bondChangeCount: int
    constraintChangeCount: int
    affectedAtomIds: list[str]
    affectedBondIds: list[str]
    affectedConstraintIds: list[str]

StageGestureKind = Literal[
    "insert_atom",
    "insert_fragment",
    "insert_ring",
    "replace_atom",
    "move_atom",
    "delete_selection",
    "set_bond",
    "set_constraint",
]

class StageGestureIntent(TypedDict):
    gestureId: str
    kind: StageGestureKind
    atomicNumber: NotRequired[int]
    fragmentName: NotRequired[Literal["water", "methane", "benzene"]]
    anchorAtomId: NotRequired[str]
    position: NotRequired[Vector3]
    bondOrder: NotRequired[Literal[1, 2, 3]]
    createdAt: str
    extensions: Extensions

class StudioDraftEntry(TypedDict):
    entryId: str
    actor: Literal["human", "agent"]
    mode: Literal["build", "inspect", "measure", "constrain"]
    operations: list[dict[str, Any]]
    summary: StudioPreviewSummary
    beforeHash: str
    afterHash: str
    gesture: NotRequired[StageGestureIntent]
    createdAt: str
    extensions: Extensions

class StudioDraftSnapshot(TypedDict):
    draftId: str
    documentId: str
    baseRevision: int
    document: MoleculeDocument
    entries: list[StudioDraftEntry]
    cursor: int
    dirty: bool
    canUndo: bool
    canRedo: bool
    createdAt: str
    updatedAt: str
    extensions: Extensions

StudioAgentTraceKind = Literal[
    "turn_started",
    "reasoning_summary",
    "tool_started",
    "permission_waiting",
    "tool_progress",
    "tool_succeeded",
    "tool_failed",
    "turn_completed",
    "turn_blocked",
]
StudioAgentTraceStatus = Literal[
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "denied",
]

class StudioAgentTraceDetail(TypedDict):
    argumentKeys: NotRequired[list[str]]
    resultKeys: NotRequired[list[str]]
    ruleIds: NotRequired[list[str]]
    verdict: NotRequired[str]
    durationMs: NotRequired[int]

class StudioAgentTraceEvent(TypedDict):
    eventId: str
    sessionId: str
    turnId: str
    sequence: int
    timestamp: str
    kind: StudioAgentTraceKind
    status: StudioAgentTraceStatus
    toolCallId: NotRequired[str]
    toolName: NotRequired[str]
    title: str
    summary: str
    detail: NotRequired[StudioAgentTraceDetail]
    extensions: Extensions

StudioAgentAnswerSectionKind = Literal["finding", "evidence", "warning", "next_step"]

class StudioAgentAnswerSection(TypedDict):
    kind: StudioAgentAnswerSectionKind
    heading: str
    summary: str

class StudioAgentAnswer(TypedDict):
    answerId: str
    heading: str
    summary: str
    sections: list[StudioAgentAnswerSection]
    extensions: Extensions

StudioAgentArtifactKind = Literal[
    "molecule_change",
    "calculation_plan",
    "preflight_receipt",
    "trajectory_result",
    "verification",
]

class StudioAgentArtifact(TypedDict):
    artifactId: str
    kind: StudioAgentArtifactKind
    heading: str
    summary: str
    documentId: str
    revision: int
    geometryHash: str
    charge: int
    multiplicity: int
    engine: NotRequired[Literal["xtb", "gaussian", "orca"]]
    method: NotRequired[str]
    calculationKind: NotRequired[
        Literal["single_point", "optimization", "frequency", "transition_state", "scan", "other"]
    ]
    planId: NotRequired[str]
    runId: NotRequired[str]
    energy: NotRequired[dict[str, Any]]
    affectedIds: NotRequired[list[str]]
    ruleIds: NotRequired[list[str]]
    verdict: NotRequired[Literal["passed", "warning", "failed", "denied"]]
    extensions: Extensions

class StudioAgentToolProjection(TypedDict):
    toolCallId: str
    toolName: str
    purpose: str
    argumentKeys: NotRequired[list[str]]
    resultKeys: NotRequired[list[str]]
    ruleIds: NotRequired[list[str]]
    verdict: NotRequired[str]
    durationMs: NotRequired[int]

StudioAgentTurnEventKind = Literal[
    "user_message",
    "reasoning_summary",
    "tool_started",
    "permission_waiting",
    "tool_progress",
    "tool_succeeded",
    "tool_failed",
    "artifact_published",
    "answer_published",
    "turn_terminal",
]
StudioAgentTurnStatus = Literal[
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "denied",
    "cancelled",
    "needs_user",
]
StudioAgentTurnOutcome = Literal["completed", "denied", "failed", "cancelled", "needs_user"]

class StudioAgentTurnEvent(TypedDict):
    eventId: str
    threadId: str
    turnId: str
    sequence: int
    timestamp: str
    kind: StudioAgentTurnEventKind
    status: StudioAgentTurnStatus
    summary: str
    tool: NotRequired[StudioAgentToolProjection]
    approvalRef: NotRequired[str]
    artifact: NotRequired[StudioAgentArtifact]
    answer: NotRequired[StudioAgentAnswer]
    outcome: NotRequired[StudioAgentTurnOutcome]
    extensions: Extensions

class StudioAgentCapability(TypedDict):
    discovery: Literal["plus", "mention", "command"]
    key: str
    label: str
    description: str
    capability: Literal["inspect", "plan", "act", "navigation"]
    contextRef: NotRequired[str]

class StudioAgentCapabilityManifest(TypedDict):
    projectId: str
    threadId: str
    generatedAt: str
    items: list[StudioAgentCapability]
    extensions: Extensions

class StudioAgentComposerIntent(TypedDict):
    intentId: str
    kind: Literal["inspect", "plan", "dry_run", "run", "review", "history", "new", "context"]
    capability: Literal["inspect", "plan", "act", "navigation"]
    contextRefs: list[str]
    prompt: NotRequired[str]
    requiresExecutionApproval: bool
    extensions: Extensions

class StudioAgentReportResultInput(TypedDict):
    answer: StudioAgentAnswer
    artifactRefs: NotRequired[list[str]]
    artifacts: list[StudioAgentArtifact]

class StudioAgentTurnPage(TypedDict):
    threadId: str
    events: list[StudioAgentTurnEvent]
    nextBeforeSequence: int | None
    extensions: Extensions

class StudioAgentTurnPageRequest(TypedDict):
    threadId: str
    beforeSequence: int | None
    limit: int

class StudioAgentCapabilityManifestRequest(TypedDict):
    sessionId: str
    threadId: str

class PreviewReceipt(TypedDict):
    previewId: str
    operationId: str
    baseRevision: int
    affectedAtomIds: list[str]
    affectedBondIds: list[str]
    beforeHash: str
    afterHash: str
    diff: PreviewDiff
    summary: NotRequired[StudioPreviewSummary]
    createdAt: str
    extensions: Extensions

class MoleculeCommitReceipt(TypedDict):
    type: Literal["molecule_commit"]
    previewId: str
    revision: int
    timestamp: str
    geometryHash: str
    stateHash: str

class OptimizationRun(TypedDict):
    runId: str
    documentId: str
    inputRevision: int
    engine: Literal["xtb", "gaussian", "orca"]
    method: str
    settings: OptimizationSettings
    frozenAtomIds: list[str]
    constraintIds: list[str]
    status: Literal["pending_approval", "queued", "running", "completed", "cancelled", "failed", "awaiting_final_geometry"]
    createdAt: str
    extensions: Extensions

class EnergyValue(TypedDict):
    value: float
    unit: Literal["hartree", "eV", "kJ/mol", "kcal/mol"]

class ForceMetrics(TypedDict):
    max: NotRequired[float]
    rms: NotRequired[float]
    unit: Literal["hartree/bohr", "eV/angstrom", "kJ/mol/angstrom"]

class OptimizationGradientNorm(TypedDict):
    value: float
    unit: Literal["hartree/bohr", "eV/angstrom", "kJ/mol/angstrom"]

class OptimizationConvergence(TypedDict):
    converged: bool
    threshold: NotRequired[float]
    energyChange: NotRequired[float | None]
    maxDisplacement: NotRequired[float | None]
    rmsDisplacement: NotRequired[float | None]

class OptimizationFrame(TypedDict):
    runId: str
    stepIndex: int
    atomIds: list[str]
    positions: list[Vector3]
    energy: EnergyValue
    forceMetrics: ForceMetrics
    convergence: OptimizationConvergence
    structureHash: str
    timestamp: str
    extensions: Extensions

class ControlledCalculationSettings(TypedDict):
    maxSteps: int
    maxRuntimeSeconds: int
    threads: Literal[1]
    charge: int
    multiplicity: int
    forceThreshold: NotRequired[dict[str, Any]]
    solvent: NotRequired[str]
    extensions: Extensions

class ControlledCalculationBinding(TypedDict):
    sessionId: str
    documentId: str
    expectedRevision: int
    geometryHash: str
    source: NotRequired[Literal["committed", "draft"]]
    draftId: NotRequired[str]

class ControlledCalculationExecutableIdentity(TypedDict):
    kind: Literal["local_executable"]
    engine: Literal["xtb"]
    version: str
    architecture: str
    executableDigest: str
    runtimeFingerprint: str
    libraries: list[dict[str, str]]
    resources: NotRequired[list[dict[str, str]]]
    verifiedAt: str

class PreparedControlledCalculation(TypedDict):
    type: Literal["prepared_controlled_calculation"]
    planId: str
    binding: ControlledCalculationBinding
    engine: Literal["xtb"]
    method: str
    settings: ControlledCalculationSettings
    settingsDigest: str
    planDigest: str
    executable: ControlledCalculationExecutableIdentity
    state: Literal["prepared", "validated"]
    createdAt: str
    expiresAt: str
    extensions: Extensions

class ControlledCalculationReservation(TypedDict):
    type: Literal["controlled_calculation_reservation"]
    runId: str
    planId: str
    planDigest: str
    binding: ControlledCalculationBinding
    executable: ControlledCalculationExecutableIdentity
    reservedAt: str
    extensions: Extensions

class ControlledCalculationExternalFrame(TypedDict):
    type: Literal["controlled_calculation_frame"]
    runId: str
    frameIndex: int
    engineStepIndex: int
    atomIds: list[str]
    atomicNumbers: list[int]
    positions: list[Vector3]
    coordinateUnit: Literal["angstrom"]
    provenance: dict[str, str]
    energy: EnergyValue
    forceMetrics: NotRequired[ForceMetrics]
    gradientNorm: NotRequired[OptimizationGradientNorm]
    structureHash: str
    timestamp: str
    extensions: Extensions

class ControlledCalculationTerminal(TypedDict):
    type: Literal["controlled_calculation_terminal"]
    runId: str
    status: Literal["completed", "failed", "cancelled"]
    frameCount: int
    outputGeometryHash: NotRequired[str]
    completedAt: NotRequired[str]
    error: NotRequired[dict[str, str]]
    reason: NotRequired[str]
    terminatedAt: NotRequired[str]
    extensions: Extensions

class ControlledCalculationHostRequest(TypedDict):
    type: Literal["controlled_calculation_host_request"]
    sessionId: str
    request: dict[str, Any]

ControlledCalculationHostResponse = dict[str, Any]

class OptimizationFrameSummary(TypedDict):
    runId: str
    stepIndex: int
    energy: EnergyValue
    forceMetrics: NotRequired[ForceMetrics]
    gradientNorm: NotRequired[OptimizationGradientNorm]
    convergence: NotRequired[OptimizationConvergence]
    structureHash: str
    timestamp: str

class OptimizationReplayFrameSummary(TypedDict):
    runId: str
    stepIndex: int
    energy: EnergyValue
    forceMetrics: NotRequired[ForceMetrics]
    gradientNorm: NotRequired[OptimizationGradientNorm]
    convergence: NotRequired[OptimizationConvergence]
    timestamp: str

OptimizationReplayOutcome = Literal["running", "awaiting_final_geometry", "accepted", "rejected", "cancelled", "failed", "interrupted"]

class OptimizationReplayCatalogQuery(TypedDict):
    afterRunId: str | None
    limit: int

class OptimizationReplayTimelineQuery(TypedDict):
    runId: str
    offset: int
    limit: int

class OptimizationReplayFrameQuery(TypedDict):
    runId: str
    stepIndex: int
    documentId: str
    expectedRevision: int

class OptimizationReplayStopQuery(TypedDict):
    documentId: str
    expectedRevision: int

class OptimizationReplayRecord(TypedDict):
    run: OptimizationRun
    frameCount: int
    latestFrame: OptimizationReplayFrameSummary | None
    outcome: OptimizationReplayOutcome
    message: str
    updatedAt: str
    active: bool
    recovered: bool
    replayable: bool
    extensions: Extensions

class OptimizationReplayCatalog(TypedDict):
    totalRuns: int
    runs: list[OptimizationReplayRecord]
    nextRunId: str | None
    extensions: Extensions

class OptimizationReplayTimeline(TypedDict):
    runId: str
    offset: int
    limit: int
    totalFrames: int
    frames: list[OptimizationReplayFrameSummary]
    extensions: Extensions

class OptimizationReplayFrameResponse(TypedDict):
    runId: str
    frame: ControlledCalculationExternalFrame
    frameCount: int
    extensions: Extensions

class OptimizationReplaySelection(TypedDict):
    viewing: bool
    runId: str | None
    stepIndex: int | None
    frameCount: int
    documentId: str
    revision: int
    frame: OptimizationReplayFrameSummary | None
    extensions: Extensions

class CompletedLogFrame(TypedDict):
    stepIndex: int
    positions: list[Vector3]
    coordinateUnit: Literal["angstrom"]
    energy: EnergyValue
    extensions: Extensions

class CompletedLogReplay(TypedDict):
    type: Literal["completed_log_replay"]
    engine: Literal["xtb", "gaussian", "orca"]
    completed: Literal[True]
    atomIds: list[str]
    atomicNumbers: list[int]
    frames: list[CompletedLogFrame]
    extensions: Extensions

class OptimizationStatusNotification(TypedDict):
    runId: str
    status: Literal["failed", "awaiting_final_geometry"]
    message: str
    stepCount: int

class OptimizationCancellationResponse(TypedDict):
    runId: str
    status: Literal["cancelled"]
    stepCount: int

class OptimizationFinalCommit(TypedDict):
    type: Literal["optimization_final_commit"]
    runId: str
    revision: int
    timestamp: str
    geometryHash: str

class OptimizationFinalRejected(TypedDict):
    type: Literal["optimization_final_rejected"]
    runId: str
    revision: int
    timestamp: str

OptimizationFinalResponse = OptimizationFinalCommit | OptimizationFinalRejected

class AgentEventError(TypedDict):
    code: str
    message: str

class AgentEventPayload(TypedDict):
    gate: NotRequired[Literal["intent", "semantic"]]
    outcome: NotRequired[Literal["passed", "failed", "needs_user", "denied"]]
    reason: NotRequired[str]
    tool: NotRequired[str]
    requestId: NotRequired[str]
    decision: NotRequired[Literal["allow_once", "allow_session", "deny"]]
    previewId: NotRequired[str]
    receiptId: NotRequired[str]
    revision: NotRequired[int]
    frame: NotRequired[OptimizationFrame]
    error: NotRequired[AgentEventError]
    extensions: Extensions

class AgentEvent(TypedDict):
    eventId: str
    sessionId: str
    sequence: int
    type: Literal["intent_gate", "semantic_gate", "tool_call", "approval_request", "approval_decision", "preview", "commit", "optimization_frame", "failure", "turn_completed"]
    timestamp: str
    payload: AgentEventPayload
    extensions: Extensions

class CommandInspectionRequest(TypedDict):
    sessionId: str
    command: str
    intentDescription: NotRequired[str]

class CommandInspectionMethod(TypedDict):
    functional: str | None
    abInitio: str | None
    basis: str | None
    auxBasis: str | None
    solventModel: str | None
    solventId: str | None

class CommandInspectionParse(TypedDict):
    accepted: bool
    action: Literal["run", "sub"] | None
    program: Literal["gaussian", "orca", "xtb"] | None
    job: str | None
    project: str | None
    inputName: str | None
    charge: str | None
    multiplicity: str | None
    method: CommandInspectionMethod

class CommandInspectionIntentAssertion(TypedDict):
    id: str
    status: Literal["pass", "fail"]

class CommandInspectionIntent(TypedDict):
    verdict: Literal["ok", "reject", "unavailable"]
    failedRuleIds: list[str]
    assertions: list[CommandInspectionIntentAssertion]

class CommandInspectionSemanticIssue(TypedDict):
    ruleId: str
    severity: Literal["warn", "reject"]
    message: str

class CommandInspectionSemantic(TypedDict):
    verdict: Literal["ok", "warn", "reject"]
    complete: Literal[False]
    failedRuleIds: list[str]
    missingInfo: list[str]
    issues: list[CommandInspectionSemanticIssue]

class CommandInspectionDryRun(TypedDict):
    state: Literal["required"]
    processStarted: Literal[False]

class CommandInspectionResult(TypedDict):
    schemaVersion: Literal["1"]
    inspectionId: str
    sessionId: str
    status: Literal["ready_for_dry_run", "needs_clarification", "intent_reject", "rejected"]
    commandDigest: str
    parse: CommandInspectionParse
    intent: CommandInspectionIntent
    semantic: CommandInspectionSemantic
    dryRun: CommandInspectionDryRun
    executionPerformed: Literal[False]
    approvalRequiredForExecution: Literal[True]
    missingInfo: list[str]
    extensions: Extensions

CommandSynthesisStatus = Literal[
    "ready",
    "needsClarification",
    "intentRejected",
    "semanticRejected",
    "infeasible",
    "informational",
]
CommandSynthesisGateVerdict = Literal["ok", "warn", "reject", "unavailable"]

class CommandSynthesisRequest(TypedDict):
    sessionId: str
    modelId: str
    request: str
    extensions: Extensions

class CommandSynthesisIntentSummary(TypedDict):
    verdict: CommandSynthesisGateVerdict
    failedRuleIds: list[str]
    message: str
    extensions: Extensions

class CommandSynthesisSemanticSummary(TypedDict):
    verdict: CommandSynthesisGateVerdict
    failedRuleIds: list[str]
    message: str
    extensions: Extensions

class CommandSynthesisPublicEvidence(TypedDict):
    evidenceId: str
    kind: Literal["intentGate", "semanticGate", "projectResolution", "commandValidation"]
    verdict: CommandSynthesisGateVerdict
    summary: str
    ruleIds: list[str]
    extensions: Extensions

class CommandSynthesisResult(TypedDict):
    schemaVersion: Literal["1"]
    synthesisId: str
    sessionId: str
    status: CommandSynthesisStatus
    command: str
    commandDigest: str | None
    explanation: str
    projectName: str | None
    missingInfo: list[str]
    intent: CommandSynthesisIntentSummary
    semantic: CommandSynthesisSemanticSummary
    publicEvidence: list[CommandSynthesisPublicEvidence]
    executionPerformed: Literal[False]
    approvalRequiredForExecution: Literal[True]
    extensions: Extensions

ProjectWorkspaceProgram = Literal["gaussian", "orca"]
ProjectWorkspaceListedProgram = Literal["gaussian", "orca", "xtb"]
ProjectWorkspaceVerdict = Literal["ok", "warn", "reject"]

class ProjectWorkspaceIssue(TypedDict):
    ruleId: str
    severity: Literal["info", "warn", "reject"]
    message: str
    extensions: Extensions

class ProjectWorkspaceProgramListing(TypedDict):
    program: ProjectWorkspaceListedProgram
    projectRequired: bool
    projectNames: list[str]
    extensions: Extensions

class ProjectWorkspaceListRequest(TypedDict):
    extensions: Extensions

class ProjectWorkspaceListResult(TypedDict):
    schemaVersion: Literal["1"]
    programs: list[ProjectWorkspaceProgramListing]
    extensions: Extensions

class ProjectWorkspaceReadRequest(TypedDict):
    projectName: str
    program: ProjectWorkspaceProgram
    extensions: Extensions

class ProjectWorkspaceReadResult(TypedDict):
    schemaVersion: Literal["1"]
    projectName: str
    program: ProjectWorkspaceProgram
    yamlText: str
    extensions: Extensions

class ProjectWorkspaceValidateRequest(TypedDict):
    projectName: str
    program: ProjectWorkspaceProgram
    yamlText: str
    extensions: Extensions

class ProjectWorkspaceValidateResult(TypedDict):
    schemaVersion: Literal["1"]
    projectName: str
    program: ProjectWorkspaceProgram
    verdict: ProjectWorkspaceVerdict
    issues: list[ProjectWorkspaceIssue]
    message: str
    extensions: Extensions

class ProjectWorkspaceCritiqueRequest(TypedDict):
    projectName: str
    program: ProjectWorkspaceProgram
    yamlText: str
    extensions: Extensions

class ProjectWorkspaceCritiqueResult(TypedDict):
    schemaVersion: Literal["1"]
    projectName: str
    program: ProjectWorkspaceProgram
    verdict: ProjectWorkspaceVerdict
    issues: list[ProjectWorkspaceIssue]
    summary: str
    unsupportedFeatures: list[str]
    extensions: Extensions

ProjectWorkspaceRequest = (
    ProjectWorkspaceListRequest
    | ProjectWorkspaceReadRequest
    | ProjectWorkspaceValidateRequest
    | ProjectWorkspaceCritiqueRequest
)
ProjectWorkspaceResult = (
    ProjectWorkspaceListResult
    | ProjectWorkspaceReadResult
    | ProjectWorkspaceValidateResult
    | ProjectWorkspaceCritiqueResult
)

class StudioControlMoleculeSummary(TypedDict):
    documentId: str
    revision: int

class PreviewCommitApproval(TypedDict):
    kind: Literal["preview_commit"]
    requestId: str
    approvalId: str
    requestedAt: str
    expiresAt: str
    risk: Literal["molecule_mutation"]
    receipt: PreviewReceipt
    commitActionId: str
    discardActionId: str

class CalculationStartApproval(TypedDict):
    kind: Literal["calculation_start"]
    requestId: str
    approvalId: str
    requestedAt: str
    expiresAt: str
    risk: Literal["calculation_execution"]
    documentId: str
    expectedRevision: int
    engine: Literal["xtb", "gaussian", "orca"]
    method: str
    settings: OptimizationSettings
    allowActionId: str
    denyActionId: str

class ControlledCalculationStartApproval(TypedDict):
    kind: Literal["controlled_calculation_start"]
    requestId: str
    approvalId: str
    requestedAt: str
    expiresAt: str
    risk: Literal["calculation_execution"]
    documentId: str
    expectedRevision: int
    engine: Literal["xtb"]
    method: Literal["GFN2-xTB"]
    settings: ControlledCalculationSettings
    planId: str
    planDigest: str
    runtimeFingerprint: str
    allowActionId: str
    denyActionId: str

class RunLocalExecutionApproval(TypedDict):
    kind: Literal["execution_tool"]
    requestId: str
    approvalId: str
    requestedAt: str
    expiresAt: str
    risk: Literal["calculation_execution"]
    tool: Literal["run_local"]
    arguments: RunLocalArguments
    allowActionId: str
    denyActionId: str

class SubmitHpcExecutionApproval(TypedDict):
    kind: Literal["execution_tool"]
    requestId: str
    approvalId: str
    requestedAt: str
    expiresAt: str
    risk: Literal["calculation_execution"]
    tool: Literal["submit_hpc"]
    arguments: SubmitHpcArguments
    allowActionId: str
    denyActionId: str

class ExecuteChemsmartCommandApproval(TypedDict):
    kind: Literal["execution_tool"]
    requestId: str
    approvalId: str
    requestedAt: str
    expiresAt: str
    risk: Literal["calculation_execution"]
    tool: Literal["execute_chemsmart_command"]
    arguments: ExecuteChemsmartCommandArguments
    documentId: str
    expectedRevision: int
    geometryHash: str
    engine: Literal["xtb", "gaussian", "orca"]
    method: str
    calculationKind: Literal[
        "single_point",
        "optimization",
        "frequency",
        "transition_state",
        "scan",
        "other",
    ]
    planId: str
    commandDigest: str
    allowActionId: str
    denyActionId: str

class TrustedToolActivity(TypedDict):
    activityId: str
    sequence: int
    timestamp: str
    kind: Literal["intent_gate", "semantic_gate", "tool_call", "tool_result", "runtime"]
    status: Literal["pending", "passed", "failed", "needs_user", "denied", "completed"]
    title: str
    summary: str
    toolName: NotRequired[str]
    extensions: Extensions

StudioAgentPhase = Literal[
    "idle",
    "understanding_request",
    "inspecting_molecule",
    "validating_intent",
    "validating_semantics",
    "preparing_preview",
    "awaiting_preview_decision",
    "preparing_calculation",
    "awaiting_calculation_approval",
    "running_calculation",
    "reviewing_trajectory",
    "awaiting_final_geometry_decision",
    "completed",
    "failed",
    "recovering",
]

class StudioAgentFocus(TypedDict):
    atomIds: list[str]
    bondIds: list[str]

class StudioAgentWorkspaceState(TypedDict):
    phase: StudioAgentPhase
    currentObject: Literal["session", "molecule", "selection", "preview", "calculation_plan", "trajectory", "artifact"]
    activeTool: str | None
    statusSummary: str
    progress: float | None
    focus: StudioAgentFocus
    latestGate: Literal["pending", "passed", "failed", "denied"] | None
    pendingTrustedAction: Literal["preview_commit", "calculation_start", "calculation_cancel", "final_geometry_decision"] | None
    requiresUserInput: bool
    terminalResult: Literal["completed", "failed", "cancelled", "denied"] | None
    recoverySequence: int
    updatedAt: str
    extensions: Extensions

class FinalGeometryControl(TypedDict):
    risk: Literal["final_geometry_commit"]
    expectedRevision: int
    frame: OptimizationFrameSummary
    acceptActionId: str
    rejectActionId: str

class StudioOptimizationStatus(TypedDict):
    run: OptimizationRun
    frameCount: int
    latestFrame: OptimizationFrameSummary | None
    cancelActionId: NotRequired[str]
    finalGeometry: FinalGeometryControl | None
    extensions: Extensions

class StudioControlSnapshot(TypedDict):
    sessionId: str
    snapshotRevision: int
    molecule: StudioControlMoleculeSummary | None
    pendingApprovals: list[PreviewCommitApproval | CalculationStartApproval | ControlledCalculationStartApproval | RunLocalExecutionApproval | SubmitHpcExecutionApproval | ExecuteChemsmartCommandApproval]
    activity: list[TrustedToolActivity]
    optimization: StudioOptimizationStatus | None
    agent: NotRequired[StudioAgentWorkspaceState]
    extensions: Extensions

class CommitMoleculePreviewArguments(TypedDict):
    preview_id: str
    expected_revision: int

class StartMoleculeOptimizationArguments(TypedDict):
    engine: Literal["xtb", "gaussian", "orca"]
    method: str
    settings: OptimizationSettings
    expected_revision: int

class StartPreparedOptimizationArguments(TypedDict):
    plan_id: str
    plan_digest: str

class RunLocalArguments(TypedDict):
    job: str

class SubmitHpcArguments(TypedDict, total=False):
    job: Required[str]
    server: str | None
    execute: bool

class ExecuteChemsmartCommandArguments(TypedDict, total=False):
    command: Required[str]
    test: bool
    timeout_s: int

class RunIdArguments(TypedDict):
    run_id: str

class RunIdRevisionArguments(TypedDict):
    run_id: str
    expected_revision: int

class CommitMoleculePreviewApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["commit_molecule_preview"]
    arguments: CommitMoleculePreviewArguments

class StartMoleculeOptimizationApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["start_molecule_optimization"]
    arguments: StartMoleculeOptimizationArguments

class StartPreparedOptimizationApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["start_prepared_optimization"]
    arguments: StartPreparedOptimizationArguments

class RunLocalApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["run_local"]
    arguments: RunLocalArguments

class SubmitHpcApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["submit_hpc"]
    arguments: SubmitHpcArguments

class ExecuteChemsmartCommandApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["execute_chemsmart_command"]
    arguments: ExecuteChemsmartCommandArguments

class CancelMoleculeOptimizationApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["cancel_molecule_optimization"]
    arguments: RunIdArguments

class AcceptOptimizationGeometryApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["accept_optimization_geometry"]
    arguments: RunIdRevisionArguments

class RejectOptimizationGeometryApprovalRequest(TypedDict):
    sessionId: str
    requestId: str
    tool: Literal["reject_optimization_geometry"]
    arguments: RunIdArguments

StudioApprovalRequest = (
    CommitMoleculePreviewApprovalRequest
    | StartMoleculeOptimizationApprovalRequest
    | StartPreparedOptimizationApprovalRequest
    | RunLocalApprovalRequest
    | SubmitHpcApprovalRequest
    | ExecuteChemsmartCommandApprovalRequest
    | CancelMoleculeOptimizationApprovalRequest
    | AcceptOptimizationGeometryApprovalRequest
    | RejectOptimizationGeometryApprovalRequest
)

class EmptyMoleculeRequestParams(TypedDict):
    pass

class PreviewPatchParams(TypedDict):
    patch: MoleculePatch

class SelectionParams(TypedDict):
    documentId: str
    expectedRevision: int
    atomIds: list[str]

class PreviewIdParams(TypedDict):
    previewId: str

class PreviewIdRevisionParams(TypedDict):
    previewId: str
    expectedRevision: int

class StartOptimizationParams(TypedDict):
    engine: Literal["xtb", "gaussian", "orca"]
    method: str
    settings: OptimizationSettings
    expectedRevision: int

class RunIdParams(TypedDict):
    runId: str

class RunIdRevisionParams(TypedDict):
    runId: str
    expectedRevision: int

class GetMoleculeSnapshotRequest(TypedDict):
    sessionId: str
    method: Literal["molecule.get_snapshot"]
    params: EmptyMoleculeRequestParams

class SetMoleculeSelectionRequest(TypedDict):
    sessionId: str
    method: Literal["molecule.set_selection"]
    params: SelectionParams

class PreviewMoleculePatchRequest(TypedDict):
    sessionId: str
    method: Literal["molecule.preview_patch"]
    params: PreviewPatchParams

class CommitMoleculePreviewRequest(TypedDict):
    sessionId: str
    method: Literal["molecule.commit_preview"]
    params: PreviewIdRevisionParams

class DiscardMoleculePreviewRequest(TypedDict):
    sessionId: str
    method: Literal["molecule.discard_preview"]
    params: PreviewIdParams

class StartOptimizationRequest(TypedDict):
    sessionId: str
    method: Literal["optimization.start"]
    params: StartOptimizationParams

class CancelOptimizationRequest(TypedDict):
    sessionId: str
    method: Literal["optimization.cancel"]
    params: RunIdParams

class AcceptFinalGeometryRequest(TypedDict):
    sessionId: str
    method: Literal["optimization.accept_final"]
    params: RunIdRevisionParams

class RejectFinalGeometryRequest(TypedDict):
    sessionId: str
    method: Literal["optimization.reject_final"]
    params: RunIdParams

StudioMoleculeRequest = (
    GetMoleculeSnapshotRequest
    | SetMoleculeSelectionRequest
    | PreviewMoleculePatchRequest
    | CommitMoleculePreviewRequest
    | DiscardMoleculePreviewRequest
    | StartOptimizationRequest
    | CancelOptimizationRequest
    | AcceptFinalGeometryRequest
    | RejectFinalGeometryRequest
)

StudioAgentMoleculeRequest = (
    GetMoleculeSnapshotRequest
    | PreviewMoleculePatchRequest
    | CommitMoleculePreviewRequest
    | DiscardMoleculePreviewRequest
    | StartOptimizationRequest
    | CancelOptimizationRequest
    | AcceptFinalGeometryRequest
    | RejectFinalGeometryRequest
)

MOLECULE_PATCH_RUNTIME_SCHEMA = {molecule_patch_runtime_schema_literal}
STUDIO_DRAFT_RUNTIME_SCHEMA = {studio_draft_runtime_schema_literal}
MANIFEST_RUNTIME_SCHEMA = {manifest_runtime_schema_literal}
MOLECULE_DOCUMENT_RUNTIME_SCHEMA = {molecule_document_runtime_schema_literal}
MOLECULE_IMPORT_RUNTIME_SCHEMA = {molecule_import_runtime_schema_literal}
PREVIEW_RECEIPT_RUNTIME_SCHEMA = {preview_receipt_runtime_schema_literal}
MOLECULE_COMMIT_RECEIPT_RUNTIME_SCHEMA = {molecule_commit_receipt_runtime_schema_literal}
OPTIMIZATION_RUNTIME_SCHEMA = {optimization_runtime_schema_literal}
OPTIMIZATION_REPLAY_RUNTIME_SCHEMA = {optimization_replay_runtime_schema_literal}
OPTIMIZATION_TRAJECTORY_RUNTIME_SCHEMA = {optimization_trajectory_runtime_schema_literal}
STUDIO_AGENT_TRACE_EVENT_RUNTIME_SCHEMA = {agent_trace_runtime_schema_literal}
STUDIO_AGENT_WORKBENCH_RUNTIME_SCHEMA = {agent_workbench_runtime_schema_literal}
STUDIO_CONTROL_SCHEMA = {control_schema_literal}
STUDIO_CONTROL_RUNTIME_SCHEMA = {control_runtime_schema_literal}
STUDIO_APPROVAL_REQUEST_SCHEMA = {approval_request_schema_literal}
STUDIO_APPROVAL_REQUEST_RUNTIME_SCHEMA = {approval_request_runtime_schema_literal}
STUDIO_MOLECULE_REQUEST_SCHEMA = {molecule_request_schema_literal}
STUDIO_MOLECULE_REQUEST_RUNTIME_SCHEMA = {molecule_request_runtime_schema_literal}
STUDIO_AGENT_MOLECULE_REQUEST_RUNTIME_SCHEMA = {agent_molecule_request_runtime_schema_literal}
CONTROLLED_CALCULATION_RUNTIME_SCHEMA = {controlled_calculation_runtime_schema_literal}
COMMAND_INSPECTION_RUNTIME_SCHEMA = {command_inspection_runtime_schema_literal}
COMMAND_SYNTHESIS_RUNTIME_SCHEMA = {command_synthesis_runtime_schema_literal}
PROJECT_WORKSPACE_RUNTIME_SCHEMA = {project_workspace_runtime_schema_literal}
PROTOCOL_HELLO_RUNTIME_SCHEMA = {protocol_hello_runtime_schema_literal}
STUDIO_AGENT_LIVE_EVENT_RUNTIME_SCHEMA = {studio_agent_live_event_runtime_schema_literal}
STUDIO_AGENT_ACTION_CUE_RUNTIME_SCHEMA = {studio_agent_action_cue_runtime_schema_literal}
STAGE_PLACEMENT_INTENT_RUNTIME_SCHEMA = {stage_placement_intent_runtime_schema_literal}
STUDIO_CONSOLE_COMPLETION_RUNTIME_SCHEMA = {studio_console_completion_runtime_schema_literal}
STUDIO_AGENT_TOOL_INPUT_SCHEMAS = {studio_agent_tool_input_schemas_literal}
STUDIO_COMMON_SCHEMA = {common_schema_literal}
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    checksum = schema_hash()
    chem_smart_pin = chem_smart_commit()
    studio_agent_trace_event_schema = json.loads(
        (SCHEMAS / "studio-agent-trace-event.schema.json").read_text()
    )
    studio_agent_workbench_schema = json.loads(
        (SCHEMAS / "studio-agent-workbench.schema.json").read_text()
    )
    studio_control_schema = json.loads(
        (SCHEMAS / "studio-control.schema.json").read_text()
    )
    studio_approval_request_schema = json.loads(
        (SCHEMAS / "studio-approval-request.schema.json").read_text()
    )
    studio_molecule_request_schema = json.loads(
        (SCHEMAS / "studio-molecule-request.schema.json").read_text()
    )
    manifest_schema = json.loads((SCHEMAS / "manifest.schema.json").read_text())
    molecule_schema = json.loads((SCHEMAS / "molecule.schema.json").read_text())
    molecule_import_schema = json.loads(
        (SCHEMAS / "molecule-import.schema.json").read_text()
    )
    molecule_patch_schema = json.loads(
        (SCHEMAS / "molecule-patch.schema.json").read_text()
    )
    studio_draft_schema = json.loads((SCHEMAS / "studio-draft.schema.json").read_text())
    preview_receipt_schema = json.loads(
        (SCHEMAS / "preview-receipt.schema.json").read_text()
    )
    molecule_commit_receipt_schema = json.loads(
        (SCHEMAS / "molecule-commit-receipt.schema.json").read_text()
    )
    optimization_schema = json.loads((SCHEMAS / "optimization.schema.json").read_text())
    optimization_replay_schema = json.loads(
        (SCHEMAS / "optimization-replay.schema.json").read_text()
    )
    optimization_trajectory_schema = json.loads(
        (SCHEMAS / "optimization-trajectory.schema.json").read_text()
    )
    controlled_calculation_schema = json.loads(
        (SCHEMAS / "controlled-calculation.schema.json").read_text()
    )
    command_inspection_schema = json.loads(
        (SCHEMAS / "command-inspection.schema.json").read_text()
    )
    command_synthesis_schema = json.loads(
        (SCHEMAS / "command-synthesis.schema.json").read_text()
    )
    project_workspace_schema = json.loads(
        (SCHEMAS / "project-workspace.schema.json").read_text()
    )
    research_project_session_schema = json.loads(
        (SCHEMAS / "research-project-session.schema.json").read_text()
    )
    studio_agent_molecule_request_schema = json.loads(
        (SCHEMAS / "studio-agent-molecule-request.schema.json").read_text()
    )
    common_schema = json.loads((SCHEMAS / "common.schema.json").read_text())
    protocol_hello_schema = json.loads(
        (SCHEMAS / "protocol-hello.schema.json").read_text()
    )
    studio_agent_live_event_schema = json.loads(
        (SCHEMAS / "studio-agent-live-event.schema.json").read_text()
    )
    studio_agent_action_cue_schema = json.loads(
        (SCHEMAS / "studio-agent-action-cue.schema.json").read_text()
    )
    stage_placement_intent_schema = json.loads(
        (SCHEMAS / "stage-placement-intent.schema.json").read_text()
    )
    studio_console_completion_schema = json.loads(
        (SCHEMAS / "studio-console-completion.schema.json").read_text()
    )
    schema_documents = {
        path.name: json.loads(path.read_text())
        for path in SCHEMAS.glob("*.schema.json")
    }
    molecule_document_runtime_schema = bundle_molecule_document_schema(
        molecule_schema,
        common_schema,
    )
    manifest_runtime_schema = bundle_protocol_schema(
        manifest_schema,
        "manifest.schema.json",
        schema_documents,
    )
    molecule_import_runtime_schema = bundle_protocol_schema(
        molecule_import_schema,
        "molecule-import.schema.json",
        schema_documents,
    )
    studio_agent_trace_event_runtime_schema = bundle_studio_ui_event_schema(
        studio_agent_trace_event_schema,
        common_schema,
    )
    studio_agent_workbench_runtime_schema = bundle_protocol_schema(
        studio_agent_workbench_schema,
        "studio-agent-workbench.schema.json",
        schema_documents,
    )
    studio_control_runtime_schema = bundle_studio_control_schema(
        studio_control_schema,
        schema_documents,
    )
    molecule_patch_runtime_schema = bundle_protocol_schema(
        molecule_patch_schema,
        "molecule-patch.schema.json",
        schema_documents,
    )
    studio_draft_runtime_schema = bundle_protocol_schema(
        studio_draft_schema,
        "studio-draft.schema.json",
        schema_documents,
    )
    preview_receipt_runtime_schema = bundle_protocol_schema(
        preview_receipt_schema,
        "preview-receipt.schema.json",
        schema_documents,
    )
    molecule_commit_receipt_runtime_schema = bundle_protocol_schema(
        molecule_commit_receipt_schema,
        "molecule-commit-receipt.schema.json",
        schema_documents,
    )
    optimization_runtime_schema = bundle_protocol_schema(
        optimization_schema,
        "optimization.schema.json",
        schema_documents,
    )
    optimization_replay_runtime_schema = bundle_protocol_schema(
        optimization_replay_schema,
        "optimization-replay.schema.json",
        schema_documents,
    )
    optimization_trajectory_runtime_schema = bundle_protocol_schema(
        optimization_trajectory_schema,
        "optimization-trajectory.schema.json",
        schema_documents,
    )
    controlled_calculation_runtime_schema = bundle_protocol_schema(
        controlled_calculation_schema,
        "controlled-calculation.schema.json",
        schema_documents,
    )
    command_inspection_runtime_schema = bundle_protocol_schema(
        command_inspection_schema,
        "command-inspection.schema.json",
        schema_documents,
    )
    command_synthesis_runtime_schema = bundle_protocol_schema(
        command_synthesis_schema,
        "command-synthesis.schema.json",
        schema_documents,
    )
    project_workspace_runtime_schema = bundle_protocol_schema(
        project_workspace_schema,
        "project-workspace.schema.json",
        schema_documents,
    )
    research_project_session_runtime_schema = bundle_protocol_schema(
        research_project_session_schema,
        "research-project-session.schema.json",
        schema_documents,
    )
    protocol_hello_runtime_schema = bundle_protocol_schema(
        protocol_hello_schema,
        "protocol-hello.schema.json",
        schema_documents,
    )
    studio_agent_live_event_runtime_schema = bundle_protocol_schema(
        studio_agent_live_event_schema,
        "studio-agent-live-event.schema.json",
        schema_documents,
    )
    studio_agent_action_cue_runtime_schema = bundle_protocol_schema(
        studio_agent_action_cue_schema,
        "studio-agent-action-cue.schema.json",
        schema_documents,
    )
    stage_placement_intent_runtime_schema = bundle_protocol_schema(
        stage_placement_intent_schema,
        "stage-placement-intent.schema.json",
        schema_documents,
    )
    studio_console_completion_runtime_schema = bundle_protocol_schema(
        studio_console_completion_schema,
        "studio-console-completion.schema.json",
        schema_documents,
    )
    studio_agent_tool_input_schemas(
        controlled_calculation_runtime_schema,
        studio_agent_workbench_runtime_schema,
    )
    studio_approval_request_runtime_schema = bundle_studio_approval_request_schema(
        studio_approval_request_schema,
        schema_documents,
    )
    studio_molecule_request_runtime_schema = bundle_studio_molecule_request_schema(
        studio_molecule_request_schema,
        schema_documents,
    )
    studio_agent_molecule_request_runtime_schema = (
        bundle_studio_agent_molecule_request_schema(
            studio_agent_molecule_request_schema,
            schema_documents,
        )
    )
    outputs = {
        ROOT / "packages" / "studio-protocol" / "src" / "generated.ts": typescript(
            checksum,
            chem_smart_pin,
            manifest_runtime_schema,
            molecule_document_runtime_schema,
            molecule_import_runtime_schema,
            molecule_patch_runtime_schema,
            studio_draft_runtime_schema,
            preview_receipt_runtime_schema,
            molecule_commit_receipt_runtime_schema,
            optimization_runtime_schema,
            optimization_replay_runtime_schema,
            optimization_trajectory_runtime_schema,
            studio_agent_trace_event_runtime_schema,
            studio_agent_workbench_runtime_schema,
            studio_control_schema,
            studio_control_runtime_schema,
            studio_approval_request_schema,
            studio_approval_request_runtime_schema,
            studio_molecule_request_schema,
            studio_molecule_request_runtime_schema,
            studio_agent_molecule_request_runtime_schema,
            controlled_calculation_runtime_schema,
            command_inspection_runtime_schema,
            command_synthesis_runtime_schema,
            project_workspace_runtime_schema,
            research_project_session_runtime_schema,
            protocol_hello_runtime_schema,
            studio_agent_live_event_runtime_schema,
            studio_agent_action_cue_runtime_schema,
            stage_placement_intent_runtime_schema,
            studio_console_completion_runtime_schema,
            common_schema,
        ),
        ROOT
        / "services"
        / "chemsmart_bridge"
        / "src"
        / "chemsmart_studio_bridge"
        / "generated_protocol.py": python_types(
            checksum,
            chem_smart_pin,
            manifest_runtime_schema,
            molecule_document_runtime_schema,
            molecule_import_runtime_schema,
            molecule_patch_runtime_schema,
            studio_draft_runtime_schema,
            preview_receipt_runtime_schema,
            molecule_commit_receipt_runtime_schema,
            optimization_runtime_schema,
            optimization_replay_runtime_schema,
            optimization_trajectory_runtime_schema,
            studio_agent_trace_event_runtime_schema,
            studio_agent_workbench_runtime_schema,
            studio_control_schema,
            studio_control_runtime_schema,
            studio_approval_request_schema,
            studio_approval_request_runtime_schema,
            studio_molecule_request_schema,
            studio_molecule_request_runtime_schema,
            studio_agent_molecule_request_runtime_schema,
            controlled_calculation_runtime_schema,
            command_inspection_runtime_schema,
            command_synthesis_runtime_schema,
            project_workspace_runtime_schema,
            protocol_hello_runtime_schema,
            studio_agent_live_event_runtime_schema,
            studio_agent_action_cue_runtime_schema,
            stage_placement_intent_runtime_schema,
            studio_console_completion_runtime_schema,
            common_schema,
        ),
    }
    stale = []
    for path, content in outputs.items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if stale:
        print("Generated protocol models are stale: " + ", ".join(stale))
        return 1
    print(
        f"protocol schema sha256={checksum} ({'checked' if args.check else 'generated'})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
