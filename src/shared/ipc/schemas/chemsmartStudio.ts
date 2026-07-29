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
  type ProjectWorkspaceCritiqueRequest,
  type ProjectWorkspaceCritiqueResult,
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
  studioControlRuntimeSchema,
  type StudioControlSnapshot,
  studioDraftRuntimeSchema,
  type StudioDraftSnapshot,
  type StudioUiEvent
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
      request: z.string().min(1).max(100_000)
    }),
    output: z.object({ completed: z.literal(true) })
  }),
  'chemsmart_studio.agent.replay_studio_ui': defineRoute({
    input: z.object({
      sessionId: stableIdSchema,
      afterSequence: z.number().int().min(-1)
    }),
    output: z.object({
      replayed: z.number().int().nonnegative(),
      nextSequence: z.number().int().nonnegative()
    })
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
  'chemsmart_studio.project.validate': defineRoute({
    input: projectWorkspaceValidateRequestSchema,
    output: projectWorkspaceValidateResultSchema
  }),
  'chemsmart_studio.project.critic': defineRoute({
    input: projectWorkspaceCritiqueRequestSchema,
    output: projectWorkspaceCritiqueResultSchema
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
    input: z.strictObject({ command: z.string().min(1).max(8192) }),
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
      replaceFrom: z.number().int().nonnegative(),
      completions: z.array(
        z.strictObject({
          value: z.string().min(1),
          kind: z.enum(['subcommand', 'option', 'choice']),
          detail: z.string(),
          expandsTo: z.string().min(1).optional()
        })
      )
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
export type ChemSmartStudioProjectCheckResult = ProjectWorkspaceValidateResult | ProjectWorkspaceCritiqueResult
export type ChemSmartStudioCommandSynthesisResult = CommandSynthesisResult
export type ChemSmartStudioOpenDocuments = z.infer<typeof openDocumentsSchema>
export type ChemSmartStudioConsoleRun = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.console.run']['output']
>
export type ChemSmartStudioConsoleCompletions = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.console.complete']['output']
>
export type ChemSmartStudioWorkspaceRoots = z.infer<
  (typeof chemsmartStudioRequestSchemas)['chemsmart_studio.workspace.roots']['output']
>

export type ChemSmartStudioEventSchemas = {
  'chemsmart_studio.agent.state_changed': ChemSmartStudioProcessStatus
  'chemsmart_studio.studio_ui.event': StudioUiEvent
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
