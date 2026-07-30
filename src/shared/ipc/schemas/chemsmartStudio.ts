import {
  type CommandInspectionRequest,
  type CommandInspectionResult,
  commandInspectionRuntimeSchema,
  type CommandSynthesisRequest,
  type CommandSynthesisResult,
  commandSynthesisRuntimeSchema,
  type MoleculeDocument,
  moleculeDocumentRuntimeSchema,
  type MoleculeOperation,
  moleculePatchRuntimeSchema,
  type OptimizationReplayCatalog,
  type OptimizationReplayCatalogQuery,
  optimizationReplayRuntimeSchema,
  type OptimizationReplaySelection,
  type OptimizationReplayTimeline,
  type OptimizationReplayTimelineQuery,
  type PreviewReceipt,
  previewReceiptRuntimeSchema,
  type ProjectWorkspaceCandidateDecisionRequest,
  type ProjectWorkspaceCandidateDecisionResult,
  type ProjectWorkspaceCandidateQueryRequest,
  type ProjectWorkspaceCandidateResult,
  type ProjectWorkspaceCritiqueRequest,
  type ProjectWorkspaceCritiqueResult,
  type ProjectWorkspaceDocumentRequest,
  type ProjectWorkspaceDocumentResult,
  type ProjectWorkspaceListRequest,
  type ProjectWorkspaceListResult,
  type ProjectWorkspaceProgram,
  type ProjectWorkspaceReadRequest,
  type ProjectWorkspaceReadResult,
  projectWorkspaceRuntimeSchema,
  type ProjectWorkspaceValidateRequest,
  type ProjectWorkspaceValidateResult,
  type ResearchCreateThreadRequest,
  type ResearchProjectContext,
  researchProjectSessionRuntimeSchema,
  type ResearchRenameThreadRequest,
  type ResearchSelectThreadRequest,
  type StageGestureIntent,
  type StagePlacementIntent,
  stagePlacementIntentRuntimeSchema,
  type StagePlacementPreview,
  type StudioAgentActionCue,
  type StudioAgentCapabilityManifest,
  type StudioAgentCapabilityManifestRequest,
  type StudioAgentComposerIntent,
  type StudioAgentLiveEvent,
  type StudioAgentTraceEvent,
  type StudioAgentTurnEvent,
  type StudioAgentTurnPage,
  type StudioAgentTurnPageRequest,
  studioAgentWorkbenchRuntimeSchema,
  studioControlRuntimeSchema,
  type StudioControlSnapshot,
  studioDraftRuntimeSchema,
  type StudioDraftSnapshot
} from '@chemsmart/studio-protocol'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { UniqueModelIdSchema } from '@shared/data/types/model'
import * as z from 'zod'

import { defineRoute } from '../define'

const processStateSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'failed'])
const processStatusSchema = z.object({
  state: processStateSchema,
  pid: z.number().int().positive().nullable(),
  lastError: z.string().nullable()
})
const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const studioWorkspacePaneSchema = z.enum([
  'explorer',
  'properties',
  'agent',
  'decisions',
  'console',
  'jobs',
  'problems'
])
const studioWorkspaceViewStateSchema = z.strictObject({
  editorMode: z.enum(['build', 'inspect', 'measure', 'constrain']),
  panes: z
    .array(studioWorkspacePaneSchema)
    .max(7)
    .refine((panes) => new Set(panes).size === panes.length)
})
const moleculeSummarySchema = z.object({
  documentId: stableIdSchema,
  revision: z.number().int().nonnegative()
})
const workspaceProjectResultSchema = z.strictObject({
  canceled: z.boolean(),
  molecule: moleculeSummarySchema.nullable(),
  documentName: z.string().min(1).max(255).nullable()
})
/**
 * One tab. `projectId` is an opaque handle main derives from the project path — the renderer names a
 * project to switch to without ever holding, or being able to reconstruct, where it lives.
 */
const openDocumentSchema = z.strictObject({
  projectId: stableIdSchema,
  projectName: z.string().min(1).max(255)
})
const openDocumentsSchema = z.strictObject({
  activeProjectId: stableIdSchema,
  documents: z.array(openDocumentSchema).min(1)
})
const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const runtimeDefinitionSchema = <Output>(runtimeSchema: { $defs: object }, definition: string): z.ZodType<Output> => {
  const validate = runtimeValidator.getValidator<Output>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: runtimeSchema.$defs,
    $ref: `#/$defs/${definition}`
  } as JsonSchemaType)
  return z.custom<Output>((value) => validate(value).valid)
}
/** Validates against a whole generated document schema rather than one of its named definitions. */
const runtimeRootSchema = <Output>(runtimeSchema: object): z.ZodType<Output> => {
  const isolated = JSON.parse(JSON.stringify(runtimeSchema)) as JsonSchemaType & { $id?: string }
  // CfWorker registers its validation root under an internal URI. Keeping the generated canonical
  // $id makes fragment-only references resolve against a different document and fail at runtime.
  delete isolated.$id
  const validate = runtimeValidator.getValidator<Output>(isolated)
  return z.custom<Output>((value) => validate(value).valid)
}
const moleculeDocumentSchema = runtimeRootSchema<MoleculeDocument>(moleculeDocumentRuntimeSchema)
const studioDraftSnapshotSchema = runtimeRootSchema<StudioDraftSnapshot>(studioDraftRuntimeSchema)
const stageGestureIntentSchema = runtimeDefinitionSchema<StageGestureIntent>(
  studioDraftRuntimeSchema,
  'stageGestureIntent'
)
const stagePlacementIntentSchema = runtimeRootSchema<StagePlacementIntent>(stagePlacementIntentRuntimeSchema)
const stagePlacementPreviewSchema = runtimeDefinitionSchema<StagePlacementPreview>(
  stagePlacementIntentRuntimeSchema,
  'placementPreview'
)
const moleculeDisplayBindingSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('committed') }),
  z.strictObject({
    state: z.literal('run'),
    runId: stableIdSchema,
    frameIndex: z.number().int().nonnegative()
  }),
  z.strictObject({
    state: z.literal('replay'),
    runId: stableIdSchema,
    frameIndex: z.number().int().nonnegative()
  })
])
const moleculeDisplayChangedSchema = z.strictObject({
  sessionId: stableIdSchema,
  document: moleculeDocumentSchema,
  binding: moleculeDisplayBindingSchema
})
const previewReceiptSchema = runtimeRootSchema<PreviewReceipt>(previewReceiptRuntimeSchema)
const moleculePatchOperationSchema = runtimeDefinitionSchema<MoleculeOperation>(moleculePatchRuntimeSchema, 'operation')
/**
 * Modes that may propose a molecule change. The renderer only offers a mode's own operations and main
 * re-checks the pairing, so a renderer cannot widen what a mode is allowed to do.
 */
const patchModeSchema = z.enum(['build', 'inspect', 'measure', 'constrain'])
const researchProjectContextSchema = runtimeDefinitionSchema<ResearchProjectContext>(
  researchProjectSessionRuntimeSchema,
  'researchProjectContext'
)
const researchCreateThreadRequestSchema = runtimeDefinitionSchema<ResearchCreateThreadRequest>(
  researchProjectSessionRuntimeSchema,
  'createThreadRequest'
)
const researchRenameThreadRequestSchema = runtimeDefinitionSchema<ResearchRenameThreadRequest>(
  researchProjectSessionRuntimeSchema,
  'renameThreadRequest'
)
const researchSelectThreadRequestSchema = runtimeDefinitionSchema<ResearchSelectThreadRequest>(
  researchProjectSessionRuntimeSchema,
  'selectThreadRequest'
)
const studioAgentTurnPageRequestSchema = runtimeDefinitionSchema<StudioAgentTurnPageRequest>(
  studioAgentWorkbenchRuntimeSchema,
  'turnPageRequest'
)
const studioAgentTurnPageSchema = runtimeDefinitionSchema<StudioAgentTurnPage>(
  studioAgentWorkbenchRuntimeSchema,
  'turnPage'
)
const studioAgentCapabilityManifestRequestSchema = runtimeDefinitionSchema<StudioAgentCapabilityManifestRequest>(
  studioAgentWorkbenchRuntimeSchema,
  'capabilityManifestRequest'
)
const studioAgentCapabilityManifestSchema = runtimeDefinitionSchema<StudioAgentCapabilityManifest>(
  studioAgentWorkbenchRuntimeSchema,
  'studioAgentCapabilityManifest'
)
const studioAgentComposerIntentSchema = runtimeDefinitionSchema<StudioAgentComposerIntent>(
  studioAgentWorkbenchRuntimeSchema,
  'studioAgentComposerIntent'
)
const replayCatalogQuerySchema = runtimeDefinitionSchema<OptimizationReplayCatalogQuery>(
  optimizationReplayRuntimeSchema,
  'catalogQuery'
)
const replayTimelineQuerySchema = runtimeDefinitionSchema<OptimizationReplayTimelineQuery>(
  optimizationReplayRuntimeSchema,
  'timelineQuery'
)
const replayCatalogSchema = runtimeDefinitionSchema<OptimizationReplayCatalog>(
  optimizationReplayRuntimeSchema,
  'catalogResponse'
)
const replayTimelineSchema = runtimeDefinitionSchema<OptimizationReplayTimeline>(
  optimizationReplayRuntimeSchema,
  'timelineResponse'
)
const replaySelectionSchema = runtimeDefinitionSchema<OptimizationReplaySelection>(
  optimizationReplayRuntimeSchema,
  'selectionResponse'
)
const commandInspectionRequestSchema = runtimeDefinitionSchema<CommandInspectionRequest>(
  commandInspectionRuntimeSchema,
  'request'
)
const commandInspectionResultSchema = runtimeDefinitionSchema<CommandInspectionResult>(
  commandInspectionRuntimeSchema,
  'result'
)
const commandSynthesisRequestSchema = runtimeDefinitionSchema<CommandSynthesisRequest>(
  commandSynthesisRuntimeSchema,
  'request'
)
const commandSynthesisResultSchema = runtimeDefinitionSchema<CommandSynthesisResult>(
  commandSynthesisRuntimeSchema,
  'result'
)
const projectWorkspaceListRequestSchema = runtimeDefinitionSchema<ProjectWorkspaceListRequest>(
  projectWorkspaceRuntimeSchema,
  'listRequest'
)
const projectWorkspaceListResultSchema = runtimeDefinitionSchema<ProjectWorkspaceListResult>(
  projectWorkspaceRuntimeSchema,
  'listResult'
)
const projectWorkspaceReadRequestSchema = runtimeDefinitionSchema<ProjectWorkspaceReadRequest>(
  projectWorkspaceRuntimeSchema,
  'readRequest'
)
const projectWorkspaceReadResultSchema = runtimeDefinitionSchema<ProjectWorkspaceReadResult>(
  projectWorkspaceRuntimeSchema,
  'readResult'
)
const projectWorkspaceDocumentRequestSchema = runtimeDefinitionSchema<ProjectWorkspaceDocumentRequest>(
  projectWorkspaceRuntimeSchema,
  'documentRequest'
)
const projectWorkspaceDocumentResultSchema = runtimeDefinitionSchema<ProjectWorkspaceDocumentResult>(
  projectWorkspaceRuntimeSchema,
  'documentResult'
)
const projectWorkspaceValidateRequestSchema = runtimeDefinitionSchema<ProjectWorkspaceValidateRequest>(
  projectWorkspaceRuntimeSchema,
  'validateRequest'
)
const projectWorkspaceValidateResultSchema = runtimeDefinitionSchema<ProjectWorkspaceValidateResult>(
  projectWorkspaceRuntimeSchema,
  'validateResult'
)
const projectWorkspaceCritiqueRequestSchema = runtimeDefinitionSchema<ProjectWorkspaceCritiqueRequest>(
  projectWorkspaceRuntimeSchema,
  'critiqueRequest'
)
const projectWorkspaceCritiqueResultSchema = runtimeDefinitionSchema<ProjectWorkspaceCritiqueResult>(
  projectWorkspaceRuntimeSchema,
  'critiqueResult'
)
const projectWorkspaceCandidateQueryRequestSchema = runtimeDefinitionSchema<ProjectWorkspaceCandidateQueryRequest>(
  projectWorkspaceRuntimeSchema,
  'candidateQueryRequest'
)
const projectWorkspaceCandidateResultSchema = runtimeDefinitionSchema<ProjectWorkspaceCandidateResult>(
  projectWorkspaceRuntimeSchema,
  'candidateResult'
)
const projectWorkspaceCandidateDecisionRequestSchema =
  runtimeDefinitionSchema<ProjectWorkspaceCandidateDecisionRequest>(
    projectWorkspaceRuntimeSchema,
    'candidateDecisionRequest'
  )
const projectWorkspaceCandidateDecisionResultSchema = runtimeDefinitionSchema<ProjectWorkspaceCandidateDecisionResult>(
  projectWorkspaceRuntimeSchema,
  'candidateDecisionResult'
)
const withSession = <Output extends object>(schema: z.ZodType<Output>): z.ZodType<Output & { sessionId: string }> =>
  z.custom<Output & { sessionId: string }>((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const { sessionId, ...query } = value as Record<string, unknown>
    return stableIdSchema.safeParse(sessionId).success && schema.safeParse(query).success
  })
const replayFrameRendererQuerySchema = z.strictObject({
  sessionId: stableIdSchema,
  runId: stableIdSchema,
  stepIndex: z.number().int().nonnegative()
})
const replayStopRendererQuerySchema = z.strictObject({ sessionId: stableIdSchema })
const withoutJsonSchemaConditionals = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutJsonSchemaConditionals)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'if' && key !== 'then' && key !== 'else')
      .map(([key, child]) => [key, withoutJsonSchemaConditionals(child)])
  )
}

const studioControlBaseSchema = z.fromJSONSchema(
  withoutJsonSchemaConditionals(studioControlRuntimeSchema) as Parameters<typeof z.fromJSONSchema>[0]
)
const studioControlSnapshotSchema = studioControlBaseSchema.superRefine((value, context) => {
  const snapshot = value as StudioControlSnapshot
  const optimization = snapshot.optimization
  if (!optimization) return

  const awaitsFinalGeometry = optimization.run.status === 'awaiting_final_geometry'
  if (awaitsFinalGeometry !== (optimization.finalGeometry !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'Final geometry must be present only while awaiting its decision',
      path: ['optimization', 'finalGeometry']
    })
  }
  if (optimization.cancelActionId !== undefined && optimization.run.status !== 'running') {
    context.addIssue({
      code: 'custom',
      message: 'A cancel action is valid only for a running optimization',
      path: ['optimization', 'cancelActionId']
    })
  }
  if ((optimization.frameCount === 0) !== (optimization.latestFrame === null)) {
    context.addIssue({
      code: 'custom',
      message: 'Latest frame presence must agree with the frame count',
      path: ['optimization', 'latestFrame']
    })
  }
}) as z.ZodType<StudioControlSnapshot>

export const chemsmartStudioRequestSchemas = {
  'chemsmart_studio.status': defineRoute({
    input: z.void(),
    output: z.object({ agent: processStatusSchema })
  }),
  'chemsmart_studio.editor.open_project': defineRoute({ input: z.void(), output: workspaceProjectResultSchema }),
  'chemsmart_studio.editor.import_molecule': defineRoute({ input: z.void(), output: workspaceProjectResultSchema }),
  'chemsmart_studio.editor.save_as': defineRoute({ input: z.void(), output: workspaceProjectResultSchema }),
  'chemsmart_studio.editor.open_documents': defineRoute({ input: z.void(), output: openDocumentsSchema }),
  'chemsmart_studio.editor.activate_document': defineRoute({
    input: z.strictObject({ projectId: stableIdSchema }),
    output: workspaceProjectResultSchema
  }),
  'chemsmart_studio.molecule.summary': defineRoute({ input: z.void(), output: moleculeSummarySchema }),
  'chemsmart_studio.agent.runtime_context': defineRoute({
    input: z.void(),
    output: z.strictObject({ deterministicModelId: UniqueModelIdSchema.nullable() })
  }),
  'chemsmart_studio.agent.run_turn': defineRoute({
    input: z.object({
      sessionId: stableIdSchema,
      modelId: UniqueModelIdSchema,
      request: z.string().min(1).max(100_000),
      intent: studioAgentComposerIntentSchema.nullable().optional()
    }),
    output: z.object({ completed: z.literal(true) })
  }),
  'chemsmart_studio.agent.control_turn': defineRoute({
    input: z.discriminatedUnion('action', [
      z.strictObject({
        sessionId: stableIdSchema,
        action: z.literal('stop')
      }),
      z.strictObject({
        sessionId: stableIdSchema,
        action: z.enum(['steer', 'queue']),
        request: z.string().min(1).max(100_000),
        intent: studioAgentComposerIntentSchema.nullable().optional()
      })
    ]),
    output: z.strictObject({
      accepted: z.literal(true),
      action: z.enum(['stop', 'steer', 'queue']),
      queueDepth: z.number().int().nonnegative()
    })
  }),
  'chemsmart_studio.agent.turns': defineRoute({
    input: studioAgentTurnPageRequestSchema,
    output: studioAgentTurnPageSchema
  }),
  'chemsmart_studio.agent.capabilities': defineRoute({
    input: studioAgentCapabilityManifestRequestSchema,
    output: studioAgentCapabilityManifestSchema
  }),
  'chemsmart_studio.agent.update_workspace_view': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      view: studioWorkspaceViewStateSchema
    }),
    output: z.strictObject({ accepted: z.literal(true) })
  }),
  'chemsmart_studio.molecule.document': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: moleculeDocumentSchema
  }),
  'chemsmart_studio.molecule.set_selection': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      documentId: stableIdSchema,
      expectedRevision: z.number().int().nonnegative(),
      atomIds: z
        .array(stableIdSchema)
        .max(4096)
        .refine((atomIds) => new Set(atomIds).size === atomIds.length)
    }),
    output: moleculeDocumentSchema
  }),
  'chemsmart_studio.molecule.propose_patch': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      expectedRevision: z.number().int().nonnegative(),
      mode: patchModeSchema,
      operations: z.array(moleculePatchOperationSchema).min(1).max(64)
    }),
    output: previewReceiptSchema
  }),
  'chemsmart_studio.molecule.draft_snapshot': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: studioDraftSnapshotSchema.nullable()
  }),
  'chemsmart_studio.molecule.draft_apply': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      expectedRevision: z.number().int().nonnegative(),
      mode: patchModeSchema,
      operations: z.array(moleculePatchOperationSchema).min(1).max(64),
      gesture: stageGestureIntentSchema.optional()
    }),
    output: studioDraftSnapshotSchema
  }),
  'chemsmart_studio.molecule.placement_preview': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      intent: stagePlacementIntentSchema
    }),
    output: stagePlacementPreviewSchema
  }),
  'chemsmart_studio.molecule.placement_apply': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      intent: stagePlacementIntentSchema
    }),
    output: z.strictObject({
      snapshot: studioDraftSnapshotSchema,
      insertedAtomId: stableIdSchema
    })
  }),
  'chemsmart_studio.molecule.draft_undo': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: studioDraftSnapshotSchema.nullable()
  }),
  'chemsmart_studio.molecule.draft_redo': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: studioDraftSnapshotSchema.nullable()
  }),
  'chemsmart_studio.molecule.draft_commit': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema, expectedRevision: z.number().int().nonnegative() }),
    output: moleculeDocumentSchema
  }),
  'chemsmart_studio.molecule.draft_discard': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: moleculeDocumentSchema
  }),
  'chemsmart_studio.molecule.undo': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: moleculeDocumentSchema
  }),
  'chemsmart_studio.molecule.redo': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: moleculeDocumentSchema
  }),
  'chemsmart_studio.research_session.context': defineRoute({
    input: z.void(),
    output: researchProjectContextSchema
  }),
  'chemsmart_studio.research_session.create_thread': defineRoute({
    input: researchCreateThreadRequestSchema,
    output: researchProjectContextSchema
  }),
  'chemsmart_studio.research_session.rename_thread': defineRoute({
    input: researchRenameThreadRequestSchema,
    output: researchProjectContextSchema
  }),
  'chemsmart_studio.research_session.select_thread': defineRoute({
    input: researchSelectThreadRequestSchema,
    output: researchProjectContextSchema
  }),
  'chemsmart_studio.project.list': defineRoute({
    input: projectWorkspaceListRequestSchema,
    output: projectWorkspaceListResultSchema
  }),
  'chemsmart_studio.project.read': defineRoute({
    input: projectWorkspaceReadRequestSchema,
    output: projectWorkspaceReadResultSchema
  }),
  'chemsmart_studio.project.document': defineRoute({
    input: projectWorkspaceDocumentRequestSchema,
    output: projectWorkspaceDocumentResultSchema
  }),
  'chemsmart_studio.project.validate': defineRoute({
    input: projectWorkspaceValidateRequestSchema,
    output: projectWorkspaceValidateResultSchema
  }),
  'chemsmart_studio.project.critic': defineRoute({
    input: projectWorkspaceCritiqueRequestSchema,
    output: projectWorkspaceCritiqueResultSchema
  }),
  'chemsmart_studio.project.candidate': defineRoute({
    input: projectWorkspaceCandidateQueryRequestSchema,
    output: projectWorkspaceCandidateResultSchema
  }),
  'chemsmart_studio.project.candidate_decide': defineRoute({
    input: projectWorkspaceCandidateDecisionRequestSchema,
    output: projectWorkspaceCandidateDecisionResultSchema
  }),
  'chemsmart_studio.command.synthesize': defineRoute({
    input: commandSynthesisRequestSchema,
    output: commandSynthesisResultSchema
  }),
  'chemsmart_studio.command.inspect': defineRoute({
    input: commandInspectionRequestSchema,
    output: commandInspectionResultSchema
  }),
  'chemsmart_studio.control.snapshot': defineRoute({
    input: z.strictObject({ sessionId: stableIdSchema }),
    output: studioControlSnapshotSchema
  }),
  'chemsmart_studio.control.perform_action': defineRoute({
    input: z.strictObject({
      sessionId: stableIdSchema,
      actionId: stableIdSchema
    }),
    output: studioControlSnapshotSchema
  }),
  'chemsmart_studio.optimization.replay_catalog': defineRoute({
    input: withSession(replayCatalogQuerySchema),
    output: replayCatalogSchema
  }),
  'chemsmart_studio.optimization.replay_timeline': defineRoute({
    input: withSession(replayTimelineQuerySchema),
    output: replayTimelineSchema
  }),
  'chemsmart_studio.optimization.replay_frame': defineRoute({
    input: replayFrameRendererQuerySchema,
    output: replaySelectionSchema
  }),
  'chemsmart_studio.optimization.stop_replay': defineRoute({
    input: replayStopRendererQuerySchema,
    output: replaySelectionSchema
  }),
  /**
   * How much the agent may do without asking. Allow decides every action; Execute pre-authorizes the
   * reversible ones for this session. What each mode covers is the policy table in main, not this
   * route — the renderer only names the mode.
   */
  'chemsmart_studio.agent.set_mode': defineRoute({
    input: withSession(z.strictObject({ mode: z.enum(['allow', 'execute']) })),
    output: z.strictObject({ mode: z.enum(['allow', 'execute']) })
  }),
  /**
   * The command console. A human surface: the researcher runs commands on their own machine, so
   * these need no approval — and for the same reason the agent never reaches them, since agent
   * execution goes through the approval-gated tool path instead.
   */
  'chemsmart_studio.console.run': defineRoute({
    input: z.strictObject({
      command: z.string().min(1).max(8192),
      preflightDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
    }),
    output: z.strictObject({ runId: z.uuid() })
  }),
  'chemsmart_studio.console.cancel': defineRoute({
    input: z.strictObject({ runId: z.uuid() }),
    output: z.strictObject({ cancelled: z.literal(true) })
  }),
  /** Pure: resolves completions against the parsed command path. Starts no process. */
  'chemsmart_studio.console.complete': defineRoute({
    input: z.strictObject({ line: z.string().max(8192), cursor: z.number().int().nonnegative().max(8192) }),
    output: z.strictObject({
      commandPath: z.array(z.string().min(1)),
      replaceRange: z.strictObject({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative()
      }),
      items: z.array(
        z.strictObject({
          id: z.string().min(1),
          label: z.string().min(1),
          insertText: z.string().min(1),
          kind: z.enum(['command', 'option', 'choice', 'argument', 'file', 'project', 'server']),
          group: z.enum(['commands', 'options', 'values', 'files', 'projects', 'servers']),
          detail: z.string(),
          valueHint: z.string().min(1).optional(),
          contextRef: stableIdSchema.optional(),
          openAction: z.enum(['molecule', 'project_yaml']).optional(),
          appendSpace: z.boolean()
        })
      ),
      semantic: z.strictObject({
        breadcrumb: z.array(z.string().min(1).max(128)).max(16),
        slots: z.array(
          z.strictObject({
            id: stableIdSchema,
            label: z.string().min(1).max(512),
            insertText: z.string().max(256),
            valueHint: z.string().min(1).max(256),
            kind: z.enum(['leaf', 'option']),
            required: z.boolean(),
            consumed: z.boolean(),
            insertAt: z.number().int().nonnegative().max(8192)
          })
        ),
        ghostSuffix: z.string().max(2048),
        complete: z.boolean()
      }),
      diagnostic: z
        .strictObject({
          code: z.enum(['unsupported_shell_syntax', 'invalid_prefix', 'value_required']),
          message: z.string().min(1)
        })
        .optional()
    })
  }),
  /** Submit-time deterministic inspection. It never starts a chemistry executable. */
  'chemsmart_studio.console.preflight': defineRoute({
    input: z.strictObject({ command: z.string().min(1).max(8192) }),
    output: z.strictObject({
      commandDigest: z.string().regex(/^[0-9a-f]{64}$/),
      verdict: z.enum(['green', 'warning', 'rejected']),
      summary: z.strictObject({
        kind: z.enum(['shell', 'chemsmart']),
        program: z.string().min(1).max(128).nullable(),
        job: z.string().min(1).max(128).nullable(),
        inputName: z.string().min(1).max(255).nullable(),
        charge: z.string().min(1).max(128).nullable(),
        multiplicity: z.string().min(1).max(128).nullable()
      }),
      failedRuleIds: z.array(z.string().min(1).max(256)).max(128),
      issues: z
        .array(
          z.strictObject({
            ruleId: z.string().min(1).max(256),
            severity: z.enum(['warn', 'reject']),
            message: z.string().min(1).max(2048)
          })
        )
        .max(128),
      processStarted: z.literal(false)
    })
  }),
  /** Resolve only a main-issued candidate handle into a path-free workspace selection. */
  'chemsmart_studio.console.accept_completion': defineRoute({
    input: z.strictObject({ contextRef: stableIdSchema }),
    output: z.strictObject({
      contextRef: stableIdSchema,
      action: z.enum(['molecule', 'project_yaml']),
      displayName: z.string().min(1).max(512),
      program: z.enum(['gaussian', 'orca']).optional(),
      projectName: z.string().min(1).max(128).optional()
    })
  }),
  /**
   * The explorer's filesystem roots. This is the one deliberate path egress in the app and it is a
   * human surface only — agent-facing contracts stay path-free.
   */
  'chemsmart_studio.workspace.roots': defineRoute({
    input: z.void(),
    output: z.strictObject({
      /** The folder holding every `.cmsproj` bundle — the tree root. */
      projectsRoot: z.string().min(1),
      /** Which bundle inside `projectsRoot` is open, so the tree can expand and mark it. */
      activeProjectPath: z.string().min(1)
    })
  })
}

export type ChemSmartStudioProcessState = z.infer<typeof processStateSchema>
export type ChemSmartStudioProcessStatus = z.infer<typeof processStatusSchema>
export type ChemSmartStudioMoleculeSummary = z.infer<typeof moleculeSummarySchema>
export type ChemSmartStudioWorkspaceProjectResult = z.infer<typeof workspaceProjectResultSchema>
export type ChemSmartStudioCommandInspectionResult = CommandInspectionResult
export type ChemSmartStudioControlSnapshot = StudioControlSnapshot
export type ChemSmartStudioReplayCatalog = z.infer<typeof replayCatalogSchema>
export type ChemSmartStudioReplayTimeline = z.infer<typeof replayTimelineSchema>
export type ChemSmartStudioReplaySelection = z.infer<typeof replaySelectionSchema>
export type ChemSmartStudioMoleculeDocument = MoleculeDocument
export type ChemSmartStudioMoleculeDisplayChanged = z.infer<typeof moleculeDisplayChangedSchema>
export type ChemSmartStudioPreviewReceipt = PreviewReceipt
export type ChemSmartStudioDraftSnapshot = StudioDraftSnapshot
export type ChemSmartStudioPatchMode = z.infer<typeof patchModeSchema>
export type ChemSmartStudioProjectProgram = ProjectWorkspaceProgram
export type ChemSmartStudioProjectList = ProjectWorkspaceListResult
export type ChemSmartStudioProjectReadResult = ProjectWorkspaceReadResult
export type ChemSmartStudioProjectDocumentResult = ProjectWorkspaceDocumentResult
export type ChemSmartStudioProjectCheckResult = ProjectWorkspaceValidateResult | ProjectWorkspaceCritiqueResult
export type ChemSmartStudioCommandSynthesisResult = CommandSynthesisResult
export type ChemSmartStudioOpenDocuments = z.infer<typeof openDocumentsSchema>
export type ChemSmartStudioConsoleRun = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.console.run']['output']
>
export type ChemSmartStudioConsoleCompletions = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.console.complete']['output']
>
export type ChemSmartStudioConsolePreflight = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.console.preflight']['output']
>
export type ChemSmartStudioConsoleCompletionSelection = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.console.accept_completion']['output']
>
export type ChemSmartStudioWorkspaceRoots = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.workspace.roots']['output']
>

/**
 * Transient v2 Agent prose. Protocol generation replaces this narrow alias with
 * `StudioAgentLiveEvent`; it never participates in replay or durable transcript storage.
 */
export type ChemSmartStudioAgentLiveEvent = StudioAgentLiveEvent

export type ChemSmartStudioEventSchemas = {
  'chemsmart_studio.agent.state_changed': ChemSmartStudioProcessStatus
  'chemsmart_studio.agent.trace': StudioAgentTraceEvent
  'chemsmart_studio.agent.turn_event': StudioAgentTurnEvent
  'chemsmart_studio.agent.live_event': ChemSmartStudioAgentLiveEvent
  'chemsmart_studio.agent.action_cue': StudioAgentActionCue
  'chemsmart_studio.control.changed': {
    sessionId: string
    snapshotRevision: number
  }
  'chemsmart_studio.molecule.changed': ChemSmartStudioMoleculeSummary
  'chemsmart_studio.molecule.draft_changed': {
    sessionId: string
    snapshot: StudioDraftSnapshot | null
  }
  /**
   * Human-renderer-only display state. This full document is never part of the model
   * or agent contracts; main composes it from trusted committed state and a verified frame.
   */
  'chemsmart_studio.molecule.display_changed': ChemSmartStudioMoleculeDisplayChanged
  'chemsmart_studio.optimization.replay_changed': {
    sessionId: string
    selection: ChemSmartStudioReplaySelection
  }
  /** Coalesced console output; the renderer keeps only the run it started. */
  'chemsmart_studio.console.output': {
    runId: string
    stream: 'stdout' | 'stderr'
    chunk: string
  }
  'chemsmart_studio.console.exited': {
    runId: string
    code: number | null
    signal: string | null
  }
}
