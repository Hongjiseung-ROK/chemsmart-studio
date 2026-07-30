import { randomUUID } from 'node:crypto'

import { application } from '@application'
import {
  type ControlledCalculationExternalFrame,
  controlledCalculationRuntimeSchema,
  type ControlledCalculationTerminal,
  type MoleculeCommitReceipt,
  type MoleculeDocument,
  type MoleculeOperation,
  type OptimizationFrameSummary,
  type OptimizationReplayCatalog,
  type OptimizationReplayFrameSummary,
  type OptimizationReplayRecord,
  type OptimizationReplaySelection,
  optimizationRuntimeSchema,
  type PreviewReceipt,
  type StageGestureIntent,
  type StagePlacementIntent,
  type StagePlacementPreview,
  type StudioAgentMoleculeRequest,
  studioAgentMoleculeRequestRuntimeSchema,
  type StudioAgentPhase,
  type StudioAgentWorkspaceState,
  type StudioApprovalRequest,
  studioApprovalRequestRuntimeSchema,
  type StudioControlSnapshot,
  type StudioDraftSnapshot,
  type StudioPendingApproval
} from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { t } from '@main/i18n'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError, IpcErrorCode } from '@shared/ipc/errors/IpcError'
import {
  type ChemSmartStudioMoleculeDisplayChanged,
  type ChemSmartStudioPatchMode,
  type ChemSmartStudioReplayCatalog,
  type ChemSmartStudioReplaySelection,
  type ChemSmartStudioReplayTimeline,
  chemsmartStudioRequestSchemas
} from '@shared/ipc/schemas/chemsmartStudio'
import type { WindowId } from '@shared/ipc/types'
import * as z from 'zod'

import { type AgentMode, approvalReason, defaultAgentMode, isPreAuthorized } from './agentApprovalPolicy'
import type {
  CommandPreflightApprovalBinding,
  ControlledCalculationRecoveryCandidate,
  ControlledCalculationRunStarted
} from './CalculationRuntimeService'
import { moleculeGeometryHash } from './ControlledCalculationIdentity'
import { JsonRpcFault } from './JsonRpcPeer'
import { composeReplayRecords, type ReplayRuntimeState } from './replayComposition'

const logger = loggerService.withContext('StudioControlService')
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_REMEMBERED_REQUESTS = 5_000
const MAX_ACTIVITY_ITEMS = 500

function getAgentPhaseSummary(phase: StudioAgentPhase): string {
  switch (phase) {
    case 'idle':
      return t('chemsmart_studio.agent_state.idle')
    case 'understanding_request':
      return t('chemsmart_studio.agent_state.understanding_request')
    case 'inspecting_molecule':
      return t('chemsmart_studio.agent_state.inspecting_molecule')
    case 'validating_intent':
      return t('chemsmart_studio.agent_state.validating_intent')
    case 'validating_semantics':
      return t('chemsmart_studio.agent_state.validating_semantics')
    case 'preparing_preview':
      return t('chemsmart_studio.agent_state.preparing_preview')
    case 'awaiting_preview_decision':
      return t('chemsmart_studio.agent_state.awaiting_preview_decision')
    case 'preparing_calculation':
      return t('chemsmart_studio.agent_state.preparing_calculation')
    case 'awaiting_calculation_approval':
      return t('chemsmart_studio.agent_state.awaiting_calculation_approval')
    case 'running_calculation':
      return t('chemsmart_studio.agent_state.running_calculation')
    case 'reviewing_trajectory':
      return t('chemsmart_studio.agent_state.reviewing_trajectory')
    case 'awaiting_final_geometry_decision':
      return t('chemsmart_studio.agent_state.awaiting_final_geometry_decision')
    case 'completed':
      return t('chemsmart_studio.agent_state.completed')
    case 'failed':
      return t('chemsmart_studio.agent_state.failed')
    case 'recovering':
      return t('chemsmart_studio.agent_state.recovering')
  }
}

type AgentStateOptions = Partial<
  Pick<
    StudioAgentWorkspaceState,
    | 'activeTool'
    | 'currentObject'
    | 'focus'
    | 'latestGate'
    | 'pendingTrustedAction'
    | 'progress'
    | 'recoverySequence'
    | 'requiresUserInput'
    | 'terminalResult'
  >
>

type ApprovalDecision = 'allow_once' | 'deny'
type ApprovalResponse = { decision: ApprovalDecision }

const fromRuntimeSchema = (schema: object): z.ZodType =>
  z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
const commonDefinitions = studioApprovalRequestRuntimeSchema.$defs.bundled_common_schema_json.$defs
const stableIdSchema = fromRuntimeSchema(commonDefinitions.stableId)
const revisionSchema = fromRuntimeSchema(commonDefinitions.revision)
const optimizationRunProperties = optimizationRuntimeSchema.$defs.run.properties
const engineSchema = fromRuntimeSchema(optimizationRunProperties.engine)
const methodSchema = fromRuntimeSchema(optimizationRunProperties.method)
const settingsSchema = fromRuntimeSchema({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: optimizationRuntimeSchema.$defs,
  ...optimizationRunProperties.settings
})
const startPreparedOptimizationInputSchema = fromRuntimeSchema({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: controlledCalculationRuntimeSchema.$defs,
  $ref: '#/$defs/startPreparedOptimizationInput'
})
const runLocalArgumentsSchema = fromRuntimeSchema(
  studioApprovalRequestRuntimeSchema.$defs.runLocal.properties.arguments
)
const submitHpcArgumentsSchema = fromRuntimeSchema(
  studioApprovalRequestRuntimeSchema.$defs.submitHpc.properties.arguments
)
const executeChemsmartCommandArgumentsSchema = fromRuntimeSchema({
  ...studioApprovalRequestRuntimeSchema.$defs.executeChemsmartCommand.properties.arguments,
  properties: {
    ...studioApprovalRequestRuntimeSchema.$defs.executeChemsmartCommand.properties.arguments.properties,
    command: studioApprovalRequestRuntimeSchema.$defs.bundled_command_synthesis_schema_json.$defs.command
  }
})
const sessionAndRequest = {
  sessionId: stableIdSchema,
  requestId: stableIdSchema
}
const approvalRequestSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('commit_molecule_preview'),
    arguments: z.strictObject({ preview_id: stableIdSchema, expected_revision: revisionSchema })
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('start_molecule_optimization'),
    arguments: z.strictObject({
      engine: engineSchema,
      method: methodSchema,
      settings: settingsSchema,
      expected_revision: revisionSchema
    })
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('start_prepared_optimization'),
    arguments: startPreparedOptimizationInputSchema
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('run_local'),
    arguments: runLocalArgumentsSchema
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('submit_hpc'),
    arguments: submitHpcArgumentsSchema
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('execute_chemsmart_command'),
    arguments: executeChemsmartCommandArgumentsSchema
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('cancel_molecule_optimization'),
    arguments: z.strictObject({ run_id: stableIdSchema })
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('accept_optimization_geometry'),
    arguments: z.strictObject({ run_id: stableIdSchema, expected_revision: revisionSchema })
  }),
  z.strictObject({
    ...sessionAndRequest,
    tool: z.literal('reject_optimization_geometry'),
    arguments: z.strictObject({ run_id: stableIdSchema })
  })
]) as z.ZodType<StudioApprovalRequest>
// The sidecar may inspect or propose agent work, but it cannot mutate the researcher's
// persistent selection. That renderer/native-only action is leased through typed IPC.
const moleculeRequestSchema = fromRuntimeSchema(
  studioAgentMoleculeRequestRuntimeSchema
) as z.ZodType<StudioAgentMoleculeRequest>
const controlSnapshotSchema = chemsmartStudioRequestSchemas['chemsmart_studio.control.snapshot'].output

interface PendingApprovalRecord {
  request: StudioApprovalRequest
  commandBinding?: CommandPreflightApprovalBinding
  approvalId: string
  expiresAt: string
  actionIds: string[]
  resolve: (value: ApprovalResponse) => void
  timeout: NodeJS.Timeout
}

interface ApprovedGrant {
  request: StudioApprovalRequest
  expiresAtMs: number
}

type CapabilityKind =
  | 'approval_allow'
  | 'approval_deny'
  | 'preview_discard'
  | 'human_preview_commit'
  | 'human_preview_discard'
  | 'optimization_cancel'
  | 'optimization_accept'
  | 'optimization_reject'

interface ActionCapability {
  actionId: string
  siblingGroup: string
  sessionId: string
  kind: CapabilityKind
  approvalId?: string
  previewId?: string
  runId?: string
  expectedRevision?: number
  expiresAtMs: number
}

interface ActivePreview {
  sessionId: string
  receipt: PreviewReceipt
}

/**
 * A preview the researcher proposed. It has no agent turn waiting on a decision, so the commit and
 * discard capabilities act on the editor directly instead of resolving an approval promise.
 */
interface HumanPreview {
  approvalId: string
  expectedRevision: number
  previewId: string
  sessionId: string
  timeout: NodeJS.Timeout
}

/** Which patch operations each editing mode may propose, re-checked here and never trusted from the renderer. */
const humanPatchOperations = {
  build: [
    'add_atoms',
    'remove_atoms',
    'add_bonds',
    'remove_bonds',
    'set_positions',
    'set_atomic_numbers',
    'set_bond_orders'
  ],
  inspect: [],
  measure: ['set_positions'],
  constrain: ['set_constraints', 'remove_constraints', 'set_frozen_axes']
} as const satisfies Record<ChemSmartStudioPatchMode, readonly string[]>
const agentDraftOperations = new Set<MoleculeOperation['op']>([
  ...humanPatchOperations.build,
  ...humanPatchOperations.constrain
])
const agentConstraintOperations = new Set<MoleculeOperation['op']>(humanPatchOperations.constrain)

function inferAgentDraftMode(operations: readonly MoleculeOperation[]): ChemSmartStudioPatchMode | null {
  const rejected = operations.find(({ op }) => !agentDraftOperations.has(op))
  if (rejected) return null
  return operations.some(({ op }) => agentConstraintOperations.has(op)) ? 'constrain' : 'build'
}

/**
 * Studio's own account of what the helper is displaying. Deliberately narrower than the
 * helper's render binding: it carries only fields main can vouch for from its own state.
 */
export type TrustedRenderBinding =
  | { displayState: 'committed'; documentId: string; revision: number }
  | { displayState: 'preview'; previewId: string; baseRevision: number }
  | {
      displayState: 'run'
      documentId: string
      inputRevision: number
      runId: string
      /** Null before the first durable frame, when main can vouch for the run but not yet
       *  for which frame is on screen. */
      frameIndex: number | null
      structureHash: string | null
    }
  | { displayState: 'replay'; documentId: string; inputRevision: number; runId: string; frameIndex: number }

interface ReplayLease {
  sessionId: string
  senderId: WindowId
  documentId: string
  revision: number
  /** The exact durable frame main validated and asked Three.js to display. */
  runId: string
  stepIndex: number
  frameCount: number
  displayDocument: MoleculeDocument
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function approvalGrantKey(request: StudioApprovalRequest): string {
  return studioGrantKey(request.sessionId, request.tool, request.arguments)
}

function studioGrantKey(sessionId: string, tool: string, argumentsValue: unknown): string {
  return `${sessionId}:${tool}:${canonicalJson(argumentsValue)}`
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

@Injectable('StudioControlService')
@DependsOn([
  'WindowManager',
  'MoleculeDocumentService',
  'MoleculeWorkspaceService',
  'MoleculeProjectStore',
  'CalculationRuntimeService'
])
@ServicePhase(Phase.WhenReady)
export class StudioControlService extends BaseService {
  private readonly sessions = new Map<string, StudioControlSnapshot>()
  private readonly sessionLeases = new Map<string, WindowId>()
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>()
  private readonly approvedGrants = new Map<string, ApprovedGrant>()
  private readonly actions = new Map<string, ActionCapability>()
  private readonly seenRequestKeys = new Set<string>()
  /** Per-session agent mode. Absent means Allow, so a session starts by deciding every action. */
  private readonly agentModes = new Map<string, AgentMode>()
  private readonly controlledRunIds = new Set<string>()
  private activePreview: ActivePreview | null = null
  private humanPreview: HumanPreview | null = null
  private optimizationOwner: string | null = null
  private activeRunAtomIds: string[] = []
  private replayLease: ReplayLease | null = null
  private replayTransition: Promise<void> = Promise.resolve()
  private replayTransitionCount = 0
  private controlledRecovery: Promise<void> | null = null
  private lastControlledRecoveryKey: string | null = null

  protected onInit(): void {
    const workspace = application.get('MoleculeWorkspaceService')
    const calculationRuntime = application.get('CalculationRuntimeService')
    this.registerDisposable(workspace.onMoleculeChanged((summary) => this.handleMoleculeChanged(summary)))
    this.registerDisposable(calculationRuntime.onFrameCommitted((frame) => this.handleControlledFrame(frame)))
    this.registerDisposable(
      calculationRuntime.onTerminalCommitted((terminal) => this.handleControlledTerminal(terminal))
    )
    this.registerDisposable(
      application.get('WindowManager').onWindowDestroyed(({ id }) => {
        this.releaseWindow(id)
      })
    )
  }

  getSnapshot(sessionId: string, senderId: WindowId): StudioControlSnapshot {
    this.requireSessionLease(sessionId, senderId)
    this.expireApprovals()
    this.ensureDirectOptimizationActions(sessionId)
    return structuredClone(this.ensureSession(sessionId))
  }

  /**
   * What Studio itself believes the helper is displaying right now, built only from
   * main-owned records. The viewport uses it to decide whether a helper-reported GPU
   * frame is showing the state Studio asked for.
   *
   * Never sent to a renderer. Returns null when main holds no trusted answer, which
   * fails the caller closed rather than letting the helper's own claim stand alone.
   */
  getTrustedRenderBinding(sessionId?: string): TrustedRenderBinding | null {
    const replay = this.replayLease
    if (replay && (sessionId === undefined || replay.sessionId === sessionId)) {
      return {
        displayState: 'replay',
        documentId: replay.documentId,
        inputRevision: replay.revision,
        runId: replay.runId,
        frameIndex: replay.stepIndex
      }
    }
    const owner = this.optimizationOwner
    if (owner && (sessionId === undefined || owner === sessionId)) {
      // The session's own optimization state covers native and controlled runs alike, so
      // this needs no engine-specific branch. latestFrame comes from the durable ledger,
      // which is written before the helper is ever notified.
      const optimization = this.ensureSession(owner).optimization
      if (!optimization) return null
      const frame = optimization.latestFrame
      return {
        displayState: 'run',
        documentId: optimization.run.documentId,
        inputRevision: optimization.run.inputRevision,
        runId: optimization.run.runId,
        frameIndex: frame?.stepIndex ?? null,
        structureHash: frame?.structureHash ?? null
      }
    }
    const molecule = application.get('MoleculeWorkspaceService').getCachedMoleculeSummary()
    if (!molecule) return null
    return {
      displayState: 'committed',
      documentId: molecule.documentId,
      revision: molecule.revision
    }
  }

  claimSessionControl(sessionId: string, senderId: WindowId): void {
    this.requireSessionLease(sessionId, senderId)
  }

  beginAgentTurn(sessionId: string): void {
    this.setAgentPhase(sessionId, 'understanding_request', {
      currentObject: 'session',
      latestGate: 'pending'
    })
  }

  completeAgentTurn(sessionId: string): void {
    const phase = this.ensureSession(sessionId).agent?.phase
    if (
      phase === 'awaiting_preview_decision' ||
      phase === 'awaiting_calculation_approval' ||
      phase === 'running_calculation' ||
      phase === 'awaiting_final_geometry_decision'
    ) {
      return
    }
    this.setAgentPhase(sessionId, 'completed', {
      currentObject: 'session',
      latestGate: 'passed',
      terminalResult: 'completed'
    })
  }

  failAgentTurn(sessionId: string): void {
    this.setAgentPhase(sessionId, 'failed', {
      currentObject: 'session',
      latestGate: 'failed',
      terminalResult: 'failed'
    })
  }

  recordAgentToolCompletion(
    sessionId: string,
    tool:
      | 'get_studio_context'
      | 'analyze_current_molecule'
      | 'prepare_molecule_optimization'
      | 'validate_prepared_optimization'
      | 'start_prepared_optimization'
      | 'get_optimization_status'
      | 'list_calculation_artifacts'
      | 'read_calculation_artifact'
      | 'get_optimization_replay'
      | 'compare_optimization_frames'
      | 'import_completed_calculation'
  ): void {
    if (tool === 'get_studio_context' || tool === 'analyze_current_molecule') {
      this.setAgentPhase(sessionId, 'inspecting_molecule', {
        currentObject: 'molecule',
        activeTool: tool,
        latestGate: 'passed'
      })
      return
    }
    if (tool === 'prepare_molecule_optimization') {
      this.setAgentPhase(sessionId, 'preparing_calculation', {
        currentObject: 'calculation_plan',
        activeTool: tool,
        latestGate: 'pending'
      })
      return
    }
    if (tool === 'validate_prepared_optimization' || tool === 'import_completed_calculation') {
      this.setAgentPhase(sessionId, 'validating_semantics', {
        currentObject: tool === 'import_completed_calculation' ? 'trajectory' : 'calculation_plan',
        activeTool: tool,
        latestGate: 'passed'
      })
      return
    }
    if (tool === 'start_prepared_optimization' || tool === 'get_optimization_status') {
      const optimization = this.ensureSession(sessionId).optimization
      if (optimization?.run.status === 'awaiting_final_geometry') return
      this.setAgentPhase(sessionId, optimization ? 'running_calculation' : 'preparing_calculation', {
        currentObject: optimization ? 'trajectory' : 'calculation_plan',
        activeTool: tool,
        latestGate: 'passed',
        ...(optimization ? { pendingTrustedAction: 'calculation_cancel' as const } : {})
      })
      return
    }
    this.setAgentPhase(
      sessionId,
      tool === 'list_calculation_artifacts' || tool === 'read_calculation_artifact'
        ? 'inspecting_molecule'
        : 'reviewing_trajectory',
      {
        currentObject:
          tool === 'list_calculation_artifacts' || tool === 'read_calculation_artifact' ? 'artifact' : 'trajectory',
        activeTool: tool,
        latestGate: 'passed'
      }
    )
  }

  async getReplayCatalog(
    sessionId: string,
    senderId: WindowId,
    afterRunId: string | null,
    limit: number
  ): Promise<ChemSmartStudioReplayCatalog> {
    this.requireSessionLease(sessionId, senderId)
    const workspace = application.get('MoleculeWorkspaceService')
    const ledger = await workspace.getOptimizationReplayCatalog({ afterRunId, limit })
    const runtime = await this.replayRuntimeState()
    return this.rendererCatalog({ ...ledger, runs: composeReplayRecords(ledger.runs, runtime) })
  }

  async getReplayTimeline(
    sessionId: string,
    senderId: WindowId,
    runId: string,
    offset: number,
    limit: number
  ): Promise<ChemSmartStudioReplayTimeline> {
    this.requireSessionLease(sessionId, senderId)
    const timeline = await application
      .get('MoleculeWorkspaceService')
      .getOptimizationReplayTimeline({ runId, offset, limit })
    return { ...timeline, extensions: {} }
  }

  async selectReplayFrame(
    sessionId: string,
    senderId: WindowId,
    runId: string,
    stepIndex: number
  ): Promise<ChemSmartStudioReplaySelection> {
    this.requireSessionLease(sessionId, senderId)
    return this.serializeReplay(async () => {
      const ownedOptimization = this.optimizationOwner ? this.ensureSession(this.optimizationOwner).optimization : null
      const reviewingFinalGeometry =
        this.optimizationOwner === sessionId && ownedOptimization?.run.status === 'awaiting_final_geometry'
      if (this.activePreview || (this.optimizationOwner && !reviewingFinalGeometry)) {
        throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Replay is unavailable while Studio work is active')
      }
      if (this.replayLease && (this.replayLease.sessionId !== sessionId || this.replayLease.senderId !== senderId)) {
        throw new IpcError(IpcErrorCode.FORBIDDEN_SENDER, 'Optimization replay is controlled by another window')
      }
      const workspace = application.get('MoleculeWorkspaceService')
      const document = await workspace.getMoleculeDocument()
      const record = (await this.readCompleteReplayCatalog()).find((candidate) => candidate.run.runId === runId)
      if (
        !record ||
        !record.replayable ||
        record.run.documentId !== document.documentId ||
        record.run.inputRevision !== document.revision
      ) {
        throw new IpcError(
          chemsmartStudioErrorCodes.REVISION_CONFLICT,
          'Optimization replay does not target the current committed molecule'
        )
      }
      const response = await workspace.getOptimizationReplayFrame({
        runId,
        stepIndex,
        documentId: document.documentId,
        expectedRevision: document.revision
      })
      if (
        response.runId !== runId ||
        response.frame.runId !== runId ||
        response.frame.frameIndex !== stepIndex ||
        response.frameCount <= stepIndex ||
        response.frameCount !== record.frameCount
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Optimization replay frame identity changed')
      }
      const displayDocument = this.composeDisplayDocument(document, {
        runId: response.frame.runId,
        frameIndex: response.frame.frameIndex,
        atomIds: response.frame.atomIds,
        atomicNumbers: response.frame.atomicNumbers,
        positions: response.frame.positions,
        structureHash: response.frame.structureHash
      })
      const frame: OptimizationReplayFrameSummary = {
        runId: response.frame.runId,
        stepIndex: response.frame.frameIndex,
        energy: response.frame.energy,
        ...(response.frame.forceMetrics ? { forceMetrics: response.frame.forceMetrics } : {}),
        ...(response.frame.gradientNorm ? { gradientNorm: response.frame.gradientNorm } : {}),
        ...(response.frame.convergence ? { convergence: response.frame.convergence } : {}),
        timestamp: response.frame.timestamp
      }
      const selection: OptimizationReplaySelection = {
        viewing: true,
        runId,
        stepIndex,
        frameCount: response.frameCount,
        documentId: document.documentId,
        revision: document.revision,
        frame,
        extensions: {}
      }
      this.replayLease = {
        sessionId,
        senderId,
        documentId: document.documentId,
        revision: document.revision,
        runId,
        stepIndex,
        frameCount: response.frameCount,
        displayDocument
      }
      const rendererSelection = this.rendererSelection(selection)
      this.setAgentPhase(sessionId, 'reviewing_trajectory', {
        currentObject: 'trajectory',
        activeTool: 'get_optimization_replay'
      })
      this.notifyMoleculeDisplay(sessionId, senderId, displayDocument, {
        state: 'replay',
        runId,
        frameIndex: stepIndex
      })
      this.notifyReplaySelection(sessionId, senderId, rendererSelection)
      return rendererSelection
    })
  }

  async stopReplay(sessionId: string, senderId: WindowId): Promise<ChemSmartStudioReplaySelection> {
    this.requireSessionLease(sessionId, senderId)
    return this.serializeReplay(async () => {
      const lease = this.replayLease
      if (!lease || lease.sessionId !== sessionId || lease.senderId !== senderId) {
        throw new IpcError(IpcErrorCode.FORBIDDEN_SENDER, 'This window does not own optimization replay')
      }
      const document = await application.get('MoleculeWorkspaceService').getMoleculeDocument()
      const selection: OptimizationReplaySelection = {
        viewing: false,
        runId: null,
        stepIndex: null,
        frameCount: lease.frameCount,
        documentId: document.documentId,
        revision: document.revision,
        frame: null,
        extensions: {}
      }
      this.replayLease = null
      const rendererSelection = this.rendererSelection(selection)
      this.setAgentPhase(sessionId, 'completed', {
        currentObject: 'molecule',
        latestGate: 'passed',
        terminalResult: 'completed'
      })
      this.notifyMoleculeDisplay(sessionId, senderId, document, { state: 'committed' })
      this.notifyReplaySelection(sessionId, senderId, rendererSelection)
      return rendererSelection
    })
  }

  async performAction(sessionId: string, actionId: string, senderId: WindowId): Promise<StudioControlSnapshot> {
    this.requireSessionLease(sessionId, senderId)
    this.expireApprovals()
    const action = this.actions.get(actionId)
    if (!action || action.sessionId !== sessionId || action.expiresAtMs <= Date.now()) {
      if (action) this.consumeActionGroup(action.siblingGroup)
      throw new IpcError(
        chemsmartStudioErrorCodes.APPROVAL_REQUIRED,
        'Studio action is missing, expired, or already used'
      )
    }

    if (action.kind === 'approval_allow') {
      try {
        await this.assertApprovalCurrent(action)
      } catch (error) {
        this.consumeActionGroup(action.siblingGroup)
        this.resolveApproval(action, 'deny')
        throw error
      }
    }
    this.consumeActionGroup(action.siblingGroup)
    switch (action.kind) {
      case 'approval_allow':
        this.resolveApproval(action, 'allow_once')
        break
      case 'approval_deny':
        this.resolveApproval(action, 'deny')
        break
      case 'preview_discard':
        await this.discardPreviewAction(action)
        break
      case 'human_preview_commit':
        await this.commitHumanPreviewAction(action)
        break
      case 'human_preview_discard':
        await this.discardHumanPreviewAction(action)
        break
      case 'optimization_cancel':
        await this.cancelOptimizationAction(action)
        break
      case 'optimization_accept':
        await this.acceptOptimizationAction(action)
        break
      case 'optimization_reject':
        await this.rejectOptimizationAction(action)
        break
    }
    return structuredClone(this.ensureSession(sessionId))
  }

  /**
   * Previews a change the researcher made, through the same trusted path the agent uses: preview only,
   * revision guarded, one preview at a time, and a decision card that has to be approved before commit.
   */
  async proposeHumanPatch(
    sessionId: string,
    senderId: WindowId,
    request: { expectedRevision: number; mode: ChemSmartStudioPatchMode; operations: readonly MoleculeOperation[] }
  ): Promise<PreviewReceipt> {
    this.requireSessionLease(sessionId, senderId)
    const allowed: readonly string[] = humanPatchOperations[request.mode]
    const rejected = request.operations.find((operation) => !allowed.includes(operation.op))
    if (rejected) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        `Mode ${request.mode} may not propose ${rejected.op}`
      )
    }

    const snapshot = this.ensureSession(sessionId)
    if (
      !snapshot.molecule ||
      snapshot.molecule.revision !== request.expectedRevision ||
      this.activePreview ||
      this.optimizationOwner ||
      this.replayBlocksStudioWork()
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Preview does not target editable committed state'
      )
    }

    const workspace = application.get('MoleculeWorkspaceService')
    const patch = {
      operationId: `operation-${randomUUID()}`,
      baseRevision: request.expectedRevision,
      actor: 'human' as const,
      previewOnly: true as const,
      operations: [...request.operations],
      extensions: {}
    }
    const receipt = await workspace.previewPatch(patch)
    if (receipt.operationId !== patch.operationId || receipt.baseRevision !== patch.baseRevision) {
      await workspace.discardPreview(receipt.previewId).catch(() => undefined)
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Preview receipt identity is inconsistent')
    }

    this.activePreview = { sessionId, receipt }
    this.registerHumanPreviewApproval(sessionId, receipt, request.expectedRevision)
    return receipt
  }

  /**
   * Human edits are reversible draft operations, so they need no per-edit approval. The exact
   * operations are still mode-checked here and schema-checked at the IPC and document boundaries.
   */
  async applyHumanDraft(
    sessionId: string,
    senderId: WindowId,
    request: {
      expectedRevision: number
      mode: ChemSmartStudioPatchMode
      operations: readonly MoleculeOperation[]
      gesture?: StageGestureIntent
    }
  ): Promise<StudioDraftSnapshot> {
    this.requireSessionLease(sessionId, senderId)
    const allowed: readonly string[] = humanPatchOperations[request.mode]
    const rejected = request.operations.find((operation) => !allowed.includes(operation.op))
    if (rejected) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, `Mode ${request.mode} may not draft ${rejected.op}`)
    }
    const snapshot = this.ensureSession(sessionId)
    if (
      !snapshot.molecule ||
      snapshot.molecule.revision !== request.expectedRevision ||
      this.activePreview ||
      this.optimizationOwner ||
      this.replayBlocksStudioWork()
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Draft does not target editable committed state')
    }
    return application.get('MoleculeWorkspaceService').applyDraftPatch({
      actor: 'human',
      expectedRevision: request.expectedRevision,
      mode: request.mode,
      operations: request.operations,
      ...(request.gesture ? { gesture: request.gesture } : {})
    })
  }

  previewHumanPlacement(
    sessionId: string,
    senderId: WindowId,
    intent: StagePlacementIntent
  ): Promise<StagePlacementPreview> {
    this.requireSessionLease(sessionId, senderId)
    if (this.activePreview || this.optimizationOwner || this.replayBlocksStudioWork()) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Placement is unavailable while another molecule view owns the stage'
      )
    }
    return Promise.resolve(application.get('MoleculeWorkspaceService').previewStagePlacement(intent))
  }

  async applyHumanPlacement(
    sessionId: string,
    senderId: WindowId,
    intent: StagePlacementIntent
  ): Promise<{ snapshot: StudioDraftSnapshot; insertedAtomId: string }> {
    this.requireSessionLease(sessionId, senderId)
    if (this.activePreview || this.optimizationOwner || this.replayBlocksStudioWork()) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Placement is unavailable while another molecule view owns the stage'
      )
    }
    return application.get('MoleculeWorkspaceService').applyStagePlacement(intent)
  }

  getHumanDraft(sessionId: string, senderId: WindowId): StudioDraftSnapshot | null {
    this.requireSessionLease(sessionId, senderId)
    return application.get('MoleculeWorkspaceService').getMoleculeDraft()
  }

  async undoHumanDraft(sessionId: string, senderId: WindowId): Promise<StudioDraftSnapshot | null> {
    this.requireSessionLease(sessionId, senderId)
    if (this.replayBlocksStudioWork()) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Draft history is unavailable during replay')
    }
    return application.get('MoleculeWorkspaceService').undoDraft()
  }

  async redoHumanDraft(sessionId: string, senderId: WindowId): Promise<StudioDraftSnapshot | null> {
    this.requireSessionLease(sessionId, senderId)
    if (this.replayBlocksStudioWork()) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Draft history is unavailable during replay')
    }
    return application.get('MoleculeWorkspaceService').redoDraft()
  }

  async commitHumanDraft(sessionId: string, senderId: WindowId, expectedRevision: number): Promise<MoleculeDocument> {
    this.requireSessionLease(sessionId, senderId)
    if (this.optimizationOwner || this.replayBlocksStudioWork()) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Draft cannot be applied during run or replay')
    }
    return application.get('MoleculeWorkspaceService').commitDraft(expectedRevision)
  }

  async discardHumanDraft(sessionId: string, senderId: WindowId): Promise<MoleculeDocument> {
    this.requireSessionLease(sessionId, senderId)
    if (this.optimizationOwner || this.replayBlocksStudioWork()) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Draft cannot be discarded during run or replay')
    }
    return application.get('MoleculeWorkspaceService').discardDraft()
  }

  async setHumanSelection(
    sessionId: string,
    senderId: WindowId,
    request: { documentId: string; expectedRevision: number; atomIds: readonly string[] }
  ): Promise<MoleculeDocument> {
    this.requireSessionLease(sessionId, senderId)
    return this.applySelection(sessionId, request)
  }

  /**
   * Travels the researcher's own history. Undo and redo publish a new revision rather than rewinding,
   * so the conflict check stays sound. A replay owns the viewport while it runs, so history travel is
   * refused until it clears; an active preview is refused by the document authority itself.
   */
  async undoHuman(sessionId: string, senderId: WindowId): Promise<MoleculeDocument> {
    return this.travelHumanHistory(sessionId, senderId, 'undo')
  }

  async redoHuman(sessionId: string, senderId: WindowId): Promise<MoleculeDocument> {
    return this.travelHumanHistory(sessionId, senderId, 'redo')
  }

  private async travelHumanHistory(
    sessionId: string,
    senderId: WindowId,
    direction: 'undo' | 'redo'
  ): Promise<MoleculeDocument> {
    this.requireSessionLease(sessionId, senderId)
    if (this.replayBlocksStudioWork()) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Molecule history travel is not available during a replay'
      )
    }
    const workspace = application.get('MoleculeWorkspaceService')
    return direction === 'undo' ? workspace.undo() : workspace.redo()
  }

  /** The session's mode. Unknown sessions read as Allow, so the safe mode is also the default. */
  agentMode(sessionId: string): AgentMode {
    return this.agentModes.get(sessionId) ?? defaultAgentMode
  }

  /**
   * Switches the session's mode.
   *
   * Only a window holding the session lease may switch, for the same reason it is the only one that
   * may approve: the mode decides whether approvals are asked for at all.
   */
  setAgentMode(sessionId: string, mode: AgentMode, senderId: WindowId): AgentMode {
    this.requireSessionLease(sessionId, senderId)
    this.agentModes.set(sessionId, mode)
    const activityText =
      mode === 'execute'
        ? {
            title: t('chemsmart_studio.control_activity.mode_execute_title'),
            summary: t('chemsmart_studio.control_activity.mode_execute_summary')
          }
        : {
            title: t('chemsmart_studio.control_activity.mode_allow_title'),
            summary: t('chemsmart_studio.control_activity.mode_allow_summary')
          }
    this.addActivity(sessionId, {
      kind: 'runtime',
      status: 'completed',
      title: activityText.title,
      summary: activityText.summary
    })
    return mode
  }

  requestApproval(params: unknown, commandBinding?: CommandPreflightApprovalBinding): Promise<ApprovalResponse> {
    const parsed = approvalRequestSchema.safeParse(params)
    if (!parsed.success) throw this.schemaFault('approval.request is schema-invalid', parsed.error.issues)
    const request = parsed.data
    const replayKey = `${request.sessionId}:${request.requestId}`
    if (this.seenRequestKeys.has(replayKey)) return Promise.resolve({ decision: 'deny' })
    this.rememberRequest(replayKey)

    if (
      request.tool === 'cancel_molecule_optimization' ||
      request.tool === 'accept_optimization_geometry' ||
      request.tool === 'reject_optimization_geometry'
    ) {
      this.addActivity(request.sessionId, {
        kind: 'semantic_gate',
        status: 'denied',
        title: t('chemsmart_studio.control_activity.trusted_control_required_title'),
        summary: t('chemsmart_studio.control_activity.trusted_control_required_summary', { tool: request.tool }),
        toolName: request.tool
      })
      this.setAgentPhase(request.sessionId, 'completed', {
        currentObject: 'session',
        activeTool: request.tool,
        latestGate: 'denied',
        terminalResult: 'denied'
      })
      return Promise.resolve({ decision: 'deny' })
    }

    // The v1 sidecar still names its draft-append acknowledgement
    // `commit_molecule_preview`. It never publishes a molecule revision in P5.6, so it is edit-safe
    // and must not raise a per-edit decision card. P6 removes this compatibility name.
    if (request.tool === 'commit_molecule_preview') {
      const preview = this.activePreview
      const molecule = this.ensureSession(request.sessionId).molecule
      if (
        !preview ||
        preview.sessionId !== request.sessionId ||
        preview.receipt.previewId !== request.arguments.preview_id ||
        preview.receipt.baseRevision !== request.arguments.expected_revision ||
        molecule?.revision !== request.arguments.expected_revision
      ) {
        this.addDeniedSemanticActivity(request, t('chemsmart_studio.control_activity.request_rejected_preview_summary'))
        return Promise.resolve({ decision: 'deny' })
      }
      return Promise.resolve({ decision: 'allow_once' })
    }

    // Execute mode may stand in for the researcher, but only for what the policy table marks
    // reversible — and the auto-approval is still written into the activity log, so a granted action
    // is as visible after the fact as a card is before it.
    if (isPreAuthorized(this.agentMode(request.sessionId), request.tool)) {
      this.addActivity(request.sessionId, {
        kind: 'tool_call',
        status: 'passed',
        title: t('chemsmart_studio.control_activity.pre_authorized_title'),
        summary: t('chemsmart_studio.control_activity.pre_authorized_summary', {
          reason: approvalReason(request.tool)
        }),
        toolName: request.tool
      })
      return Promise.resolve({ decision: 'allow_once' })
    }

    const card = this.buildApprovalCard(request, commandBinding)
    if (!card) {
      this.setAgentPhase(request.sessionId, 'completed', {
        currentObject: 'calculation_plan',
        activeTool: request.tool,
        latestGate: 'denied',
        terminalResult: 'denied'
      })
      return Promise.resolve({ decision: 'deny' })
    }
    const approvalId = card.approvalId
    const expiresAt = card.expiresAt
    const actionIds =
      card.kind === 'preview_commit'
        ? [card.commitActionId, card.discardActionId]
        : [card.allowActionId, card.denyActionId]
    const siblingGroup = `approval:${approvalId}`
    const expiresAtMs = Date.parse(expiresAt)

    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.expireApproval(approvalId), Math.max(0, expiresAtMs - Date.now()))
      timeout.unref()
      const record: PendingApprovalRecord = {
        request,
        commandBinding: request.tool === 'execute_chemsmart_command' ? commandBinding : undefined,
        approvalId,
        expiresAt,
        actionIds,
        resolve,
        timeout
      }
      const capabilities = this.approvalCapabilities(request.sessionId, card, siblingGroup, expiresAtMs)
      this.pendingApprovals.set(approvalId, record)
      for (const capability of capabilities) this.actions.set(capability.actionId, capability)
      try {
        this.updateSession(request.sessionId, (snapshot) => ({
          ...snapshot,
          pendingApprovals: [...snapshot.pendingApprovals, card],
          activity: this.appendActivity(snapshot.activity, {
            kind: 'tool_call',
            status: 'needs_user',
            title:
              card.kind === 'preview_commit'
                ? t('chemsmart_studio.control_activity.review_preview_title')
                : card.kind === 'execution_tool'
                  ? t('chemsmart_studio.control_activity.approve_execution_title')
                  : t('chemsmart_studio.control_activity.approve_calculation_title'),
            summary:
              card.kind === 'preview_commit'
                ? t('chemsmart_studio.control_activity.review_preview_summary', {
                    previewId: card.receipt.previewId
                  })
                : card.kind === 'execution_tool'
                  ? t('chemsmart_studio.control_activity.approve_execution_summary', {
                      tool: card.tool
                    })
                  : t('chemsmart_studio.control_activity.approve_calculation_summary', {
                      engine: card.engine,
                      method: card.method
                    }),
            toolName: request.tool
          })
        }))
        this.setAgentPhase(
          request.sessionId,
          card.kind === 'preview_commit' ? 'awaiting_preview_decision' : 'awaiting_calculation_approval',
          {
            currentObject: card.kind === 'preview_commit' ? 'preview' : 'calculation_plan',
            activeTool: request.tool,
            latestGate: 'passed',
            pendingTrustedAction: card.kind === 'preview_commit' ? 'preview_commit' : 'calculation_start',
            requiresUserInput: true
          }
        )
      } catch (error) {
        clearTimeout(timeout)
        this.pendingApprovals.delete(approvalId)
        this.consumeActionIds(actionIds)
        throw error
      }
    })
  }

  consumePreparedCalculationGrant(sessionId: string, planId: string, planDigest: string): void {
    this.consumeGrantKey(
      studioGrantKey(sessionId, 'start_prepared_optimization', {
        plan_id: planId,
        plan_digest: planDigest
      })
    )
  }

  async consumeCommandExecutionGrant(sessionId: string, params: unknown): Promise<void> {
    const parsed = executeChemsmartCommandArgumentsSchema.safeParse(params)
    if (!parsed.success) {
      throw this.schemaFault('execute_chemsmart_command grant is schema-invalid', parsed.error.issues)
    }
    const argumentsValue = parsed.data as Extract<
      StudioApprovalRequest,
      { tool: 'execute_chemsmart_command' }
    >['arguments']
    const binding = await application
      .get('CalculationRuntimeService')
      .getCommandPreflightForApproval(sessionId, argumentsValue.command)
    this.consumeGrantKey(studioGrantKey(sessionId, 'execute_chemsmart_command', argumentsValue))
    await application.get('CalculationRuntimeService').assertCommandPreflightApproval(sessionId, binding)
  }

  async forwardMoleculeRequest(params: unknown): Promise<unknown> {
    const parsed = moleculeRequestSchema.safeParse(params)
    if (!parsed.success) throw this.schemaFault('molecule.request is schema-invalid', parsed.error.issues)
    const request = parsed.data
    const workspace = application.get('MoleculeWorkspaceService')

    switch (request.method) {
      case 'molecule.get_snapshot': {
        this.setAgentPhase(request.sessionId, 'inspecting_molecule', {
          currentObject: 'molecule',
          activeTool: 'get_current_molecule'
        })
        const document = await workspace.getMoleculeDocument()
        this.updateMoleculeSummary({ documentId: document.documentId, revision: document.revision })
        return document
      }
      case 'molecule.preview_patch': {
        this.setAgentPhase(request.sessionId, 'preparing_preview', {
          currentObject: 'preview',
          activeTool: 'preview_molecule_patch',
          latestGate: 'pending'
        })
        const snapshot = this.ensureSession(request.sessionId)
        if (
          request.params.patch.actor !== 'agent' ||
          !snapshot.molecule ||
          request.params.patch.baseRevision !== snapshot.molecule.revision ||
          this.activePreview ||
          this.optimizationOwner ||
          this.replayBlocksStudioWork()
        ) {
          throw this.sidecarFault(
            chemsmartStudioErrorCodes.REVISION_CONFLICT,
            'Preview does not target editable committed state'
          )
        }
        const mode = inferAgentDraftMode(request.params.patch.operations)
        if (!mode) {
          throw this.sidecarFault(
            chemsmartStudioErrorCodes.SCHEMA_INVALID,
            'Agent patch contains an operation that cannot enter the molecule draft'
          )
        }
        const draft = await workspace.applyDraftPatch({
          actor: 'agent',
          expectedRevision: request.params.patch.baseRevision,
          mode,
          operations: request.params.patch.operations
        })
        const entry = draft.entries[draft.cursor - 1]
        if (!entry) {
          throw this.sidecarFault(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Agent draft entry is missing')
        }
        const receipt: PreviewReceipt = {
          previewId: entry.entryId,
          operationId: request.params.patch.operationId,
          baseRevision: request.params.patch.baseRevision,
          affectedAtomIds: entry.summary.affectedAtomIds,
          affectedBondIds: entry.summary.affectedBondIds,
          beforeHash: entry.beforeHash,
          afterHash: entry.afterHash,
          diff: {
            operationCount: entry.operations.length,
            addedAtomCount: entry.operations.reduce(
              (count, operation) => count + (operation.op === 'add_atoms' ? operation.atoms.length : 0),
              0
            ),
            removedAtomCount: entry.operations.reduce(
              (count, operation) => count + (operation.op === 'remove_atoms' ? operation.atomIds.length : 0),
              0
            ),
            movedAtomCount: entry.summary.coordinateChangeCount,
            addedBondCount: entry.operations.reduce(
              (count, operation) => count + (operation.op === 'add_bonds' ? operation.bonds.length : 0),
              0
            ),
            removedBondCount: entry.operations.reduce(
              (count, operation) => count + (operation.op === 'remove_bonds' ? operation.bondIds.length : 0),
              0
            ),
            frozenAxesChanged: entry.operations.some(({ op }) => op === 'set_frozen_axes'),
            constraintsChanged: entry.summary.constraintChangeCount > 0
          },
          summary: entry.summary,
          createdAt: entry.createdAt,
          extensions: {}
        }
        this.activePreview = { sessionId: request.sessionId, receipt }
        this.addActivity(request.sessionId, {
          kind: 'tool_result',
          status: 'completed',
          title: t('chemsmart_studio.control_activity.draft_staged_title'),
          summary: t('chemsmart_studio.control_activity.draft_staged_summary', {
            count: draft.cursor
          }),
          toolName: 'preview_molecule_patch'
        })
        return receipt
      }
      case 'molecule.discard_preview': {
        this.requireActivePreview(request.sessionId, request.params.previewId)
        const draft = await workspace.undoDraft()
        this.activePreview = null
        this.removePreviewApproval(request.sessionId, request.params.previewId)
        this.setAgentPhase(request.sessionId, 'completed', {
          currentObject: 'molecule',
          activeTool: 'discard_molecule_preview',
          latestGate: 'denied',
          terminalResult: 'denied'
        })
        return {
          discarded: true,
          previewId: request.params.previewId,
          timestamp: new Date().toISOString(),
          extensions: { remainingDraftEntries: draft?.cursor ?? 0 }
        }
      }
      case 'molecule.commit_preview': {
        const preview = this.requireActivePreview(request.sessionId, request.params.previewId)
        if (request.params.expectedRevision !== preview.receipt.baseRevision) {
          throw this.sidecarFault(
            chemsmartStudioErrorCodes.REVISION_CONFLICT,
            'Preview approval revision no longer matches'
          )
        }
        const draft = workspace.getMoleculeDraft()
        if (!draft) {
          throw this.sidecarFault(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Agent draft is missing')
        }
        const entry = draft.entries[draft.cursor - 1]
        if (
          !entry ||
          entry.entryId !== preview.receipt.previewId ||
          entry.beforeHash !== preview.receipt.beforeHash ||
          entry.afterHash !== preview.receipt.afterHash
        ) {
          throw this.sidecarFault(
            chemsmartStudioErrorCodes.SCHEMA_INVALID,
            'Agent draft entry is inconsistent with the validated preview'
          )
        }
        this.activePreview = null
        const result: MoleculeCommitReceipt = {
          type: 'molecule_commit',
          previewId: preview.receipt.previewId,
          // Compatibility field only: P5.6 deliberately leaves the committed revision unchanged.
          revision: preview.receipt.baseRevision,
          timestamp: new Date().toISOString(),
          geometryHash: entry.afterHash,
          stateHash: entry.afterHash
        }
        this.addActivity(request.sessionId, {
          kind: 'tool_result',
          status: 'completed',
          title: t('chemsmart_studio.control_activity.draft_staged_title'),
          summary: t('chemsmart_studio.control_activity.draft_staged_summary', {
            count: draft.cursor
          }),
          toolName: 'commit_molecule_preview'
        })
        this.setAgentPhase(request.sessionId, 'completed', {
          currentObject: 'preview',
          activeTool: 'commit_molecule_preview',
          latestGate: 'passed',
          terminalResult: 'completed'
        })
        return result
      }
      case 'optimization.start': {
        throw this.sidecarFault(
          chemsmartStudioErrorCodes.SCHEMA_INVALID,
          'Direct v1 optimization starts are retired; prepare and validate a controlled xTB plan'
        )
      }
      case 'optimization.cancel':
      case 'optimization.accept_final':
      case 'optimization.reject_final':
        throw this.sidecarFault(
          chemsmartStudioErrorCodes.APPROVAL_REQUIRED,
          'This operation requires a main-issued Studio control action'
        )
    }
  }

  denyPendingApprovals(sessionId?: string): void {
    for (const [approvalId, record] of [...this.pendingApprovals]) {
      if (sessionId === undefined || record.request.sessionId === sessionId) this.settleApproval(approvalId, 'deny')
    }
    if (sessionId === undefined) {
      this.approvedGrants.clear()
      return
    }
    for (const [key, grant] of this.approvedGrants) {
      if (grant.request.sessionId === sessionId) this.approvedGrants.delete(key)
    }
  }

  private buildApprovalCard(
    request: StudioApprovalRequest,
    commandBinding?: CommandPreflightApprovalBinding
  ): StudioPendingApproval | null {
    const requestedAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString()
    const approvalId = `approval-${randomUUID()}`
    if (request.tool === 'commit_molecule_preview') {
      const preview = this.activePreview
      const molecule = this.ensureSession(request.sessionId).molecule
      if (
        !preview ||
        preview.sessionId !== request.sessionId ||
        preview.receipt.previewId !== request.arguments.preview_id ||
        preview.receipt.baseRevision !== request.arguments.expected_revision ||
        molecule?.revision !== request.arguments.expected_revision
      ) {
        this.addDeniedSemanticActivity(request, t('chemsmart_studio.control_activity.request_rejected_preview_summary'))
        return null
      }
      return {
        kind: 'preview_commit',
        requestId: request.requestId,
        approvalId,
        requestedAt,
        expiresAt,
        risk: 'molecule_mutation',
        receipt: preview.receipt,
        commitActionId: `action-${randomUUID()}`,
        discardActionId: `action-${randomUUID()}`
      }
    }
    if (request.tool === 'run_local' || request.tool === 'submit_hpc' || request.tool === 'execute_chemsmart_command') {
      const executionCard = {
        kind: 'execution_tool',
        requestId: request.requestId,
        approvalId,
        requestedAt,
        expiresAt,
        risk: 'calculation_execution',
        allowActionId: `action-${randomUUID()}`,
        denyActionId: `action-${randomUUID()}`
      } as const
      if (request.tool === 'run_local') {
        return { ...executionCard, tool: request.tool, arguments: request.arguments }
      }
      if (request.tool === 'submit_hpc') {
        return { ...executionCard, tool: request.tool, arguments: request.arguments }
      }
      if (!commandBinding) {
        this.addDeniedSemanticActivity(
          request,
          t('chemsmart_studio.control_activity.request_rejected_calculation_summary')
        )
        return null
      }
      return { ...executionCard, tool: request.tool, arguments: request.arguments, ...commandBinding }
    }
    if (request.tool === 'start_molecule_optimization') {
      this.addDeniedSemanticActivity(
        request,
        t('chemsmart_studio.control_activity.request_rejected_calculation_summary')
      )
      return null
    }
    if (request.tool === 'start_prepared_optimization') {
      let plan
      try {
        plan = application
          .get('CalculationRuntimeService')
          .getPreparedPlanForApproval(request.sessionId, request.arguments.plan_id, request.arguments.plan_digest)
      } catch (error) {
        logger.warn('Rejected controlled calculation approval before trusted plan lookup completed', {
          reason: error instanceof Error ? error.message : 'unknown'
        })
        this.addDeniedSemanticActivity(
          request,
          t('chemsmart_studio.control_activity.request_rejected_calculation_summary')
        )
        return null
      }
      const molecule = this.ensureSession(request.sessionId).molecule
      const supportedControlledMethod = plan.engine === 'xtb' && plan.method === 'GFN2-xTB'
      const rejectionReasons = [
        !molecule && 'molecule_unavailable',
        this.activePreview && 'preview_active',
        this.optimizationOwner && 'optimization_active',
        this.replayBlocksStudioWork() && 'replay_active',
        molecule && plan.binding.documentId !== molecule.documentId && 'document_mismatch',
        molecule && plan.binding.expectedRevision !== molecule.revision && 'revision_mismatch',
        !supportedControlledMethod && 'engine_method_mismatch'
      ].filter((reason): reason is string => typeof reason === 'string')
      if (rejectionReasons.length > 0) {
        logger.warn('Rejected controlled calculation approval against trusted Studio state', {
          reasons: rejectionReasons
        })
        this.addDeniedSemanticActivity(
          request,
          t('chemsmart_studio.control_activity.request_rejected_calculation_summary')
        )
        return null
      }
      return {
        kind: 'controlled_calculation_start',
        requestId: request.requestId,
        approvalId,
        requestedAt,
        expiresAt,
        risk: 'calculation_execution',
        documentId: plan.binding.documentId,
        expectedRevision: plan.binding.expectedRevision,
        engine: plan.engine,
        method: plan.method,
        settings: plan.settings,
        planId: plan.planId,
        planDigest: plan.planDigest,
        runtimeFingerprint: plan.executable.runtimeFingerprint,
        allowActionId: `action-${randomUUID()}`,
        denyActionId: `action-${randomUUID()}`
      }
    }
    return null
  }

  private approvalCapabilities(
    sessionId: string,
    card: StudioPendingApproval,
    siblingGroup: string,
    expiresAtMs: number
  ): ActionCapability[] {
    if (card.kind === 'preview_commit') {
      return [
        {
          actionId: card.commitActionId,
          siblingGroup,
          sessionId,
          kind: 'approval_allow',
          approvalId: card.approvalId,
          expiresAtMs
        },
        {
          actionId: card.discardActionId,
          siblingGroup,
          sessionId,
          kind: 'preview_discard',
          approvalId: card.approvalId,
          previewId: card.receipt.previewId,
          expiresAtMs
        }
      ]
    }
    return [
      {
        actionId: card.allowActionId,
        siblingGroup,
        sessionId,
        kind: 'approval_allow',
        approvalId: card.approvalId,
        expiresAtMs
      },
      {
        actionId: card.denyActionId,
        siblingGroup,
        sessionId,
        kind: 'approval_deny',
        approvalId: card.approvalId,
        expiresAtMs
      }
    ]
  }

  private async assertApprovalCurrent(action: ActionCapability): Promise<void> {
    if (!action.approvalId) return
    const record = this.pendingApprovals.get(action.approvalId)
    if (!record?.commandBinding) return
    await application
      .get('CalculationRuntimeService')
      .assertCommandPreflightApproval(record.request.sessionId, record.commandBinding)
  }

  private resolveApproval(action: ActionCapability, decision: ApprovalDecision): void {
    if (!action.approvalId) throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
    const record = this.pendingApprovals.get(action.approvalId)
    if (!record) throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
    if (decision === 'allow_once') {
      this.approvedGrants.set(approvalGrantKey(record.request), {
        request: record.request,
        expiresAtMs: Date.parse(record.expiresAt)
      })
    }
    this.settleApproval(record.approvalId, decision)
  }

  private registerHumanPreviewApproval(sessionId: string, receipt: PreviewReceipt, expectedRevision: number): void {
    const approvalId = `approval-${randomUUID()}`
    const commitActionId = `action-${randomUUID()}`
    const discardActionId = `action-${randomUUID()}`
    const expiresAtMs = Date.now() + APPROVAL_TIMEOUT_MS
    const card: StudioPendingApproval = {
      kind: 'preview_commit',
      requestId: `request-human-${randomUUID()}`,
      approvalId,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      risk: 'molecule_mutation',
      receipt,
      commitActionId,
      discardActionId
    }
    const siblingGroup = `approval:${approvalId}`
    const timeout = setTimeout(() => void this.expireHumanPreview(approvalId), APPROVAL_TIMEOUT_MS)
    timeout.unref()
    this.humanPreview = { approvalId, expectedRevision, previewId: receipt.previewId, sessionId, timeout }
    this.actions.set(commitActionId, {
      actionId: commitActionId,
      siblingGroup,
      sessionId,
      kind: 'human_preview_commit',
      approvalId,
      previewId: receipt.previewId,
      expectedRevision,
      expiresAtMs
    })
    this.actions.set(discardActionId, {
      actionId: discardActionId,
      siblingGroup,
      sessionId,
      kind: 'human_preview_discard',
      approvalId,
      previewId: receipt.previewId,
      expiresAtMs
    })
    this.updateSession(sessionId, (snapshot) => ({
      ...snapshot,
      pendingApprovals: [...snapshot.pendingApprovals, card],
      activity: this.appendActivity(snapshot.activity, {
        kind: 'tool_call',
        status: 'needs_user',
        title: t('chemsmart_studio.control_activity.review_preview_title'),
        summary: t('chemsmart_studio.control_activity.review_preview_summary', { previewId: receipt.previewId }),
        toolName: 'preview_molecule_patch'
      })
    }))
  }

  private removeHumanPreviewCard(sessionId: string, approvalId: string): void {
    if (this.humanPreview?.approvalId === approvalId) {
      clearTimeout(this.humanPreview.timeout)
      this.humanPreview = null
    }
    this.updateSession(sessionId, (snapshot) => ({
      ...snapshot,
      pendingApprovals: snapshot.pendingApprovals.filter((approval) => approval.approvalId !== approvalId)
    }))
  }

  private async expireHumanPreview(approvalId: string): Promise<void> {
    const preview = this.humanPreview
    if (!preview || preview.approvalId !== approvalId) return
    this.consumeActionGroup(`approval:${approvalId}`)
    this.removeHumanPreviewCard(preview.sessionId, approvalId)
    if (this.activePreview?.receipt.previewId === preview.previewId) {
      await application
        .get('MoleculeWorkspaceService')
        .discardPreview(preview.previewId)
        .catch((error) => logger.warn('Expired human preview could not be discarded', error as Error))
      this.activePreview = null
    }
    this.addActivity(preview.sessionId, {
      kind: 'tool_result',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.preview_discarded_title'),
      summary: t('chemsmart_studio.control_activity.preview_discarded_summary', { previewId: preview.previewId }),
      toolName: 'discard_molecule_preview'
    })
  }

  private async commitHumanPreviewAction(action: ActionCapability): Promise<void> {
    if (!action.approvalId || !action.previewId || action.expectedRevision === undefined) {
      throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
    }
    const preview = this.requireActivePreview(action.sessionId, action.previewId)
    if (preview.receipt.baseRevision !== action.expectedRevision) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Preview approval revision no longer matches')
    }
    const result = await application
      .get('MoleculeWorkspaceService')
      .commitPreview(action.previewId, action.expectedRevision)
    this.activePreview = null
    if (
      result.previewId !== preview.receipt.previewId ||
      result.revision !== preview.receipt.baseRevision + 1 ||
      result.stateHash !== preview.receipt.afterHash
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Commit receipt is inconsistent with the approved preview'
      )
    }
    // The editor publishes the new committed summary itself; mirroring it here could disagree with it.
    this.removeHumanPreviewCard(action.sessionId, action.approvalId)
    this.addActivity(action.sessionId, {
      kind: 'tool_result',
      status: 'completed',
      title: t('chemsmart_studio.control_activity.preview_committed_title'),
      summary: t('chemsmart_studio.control_activity.preview_committed_summary', {
        previewId: action.previewId,
        revision: result.revision
      }),
      toolName: 'commit_molecule_preview'
    })
  }

  private async discardHumanPreviewAction(action: ActionCapability): Promise<void> {
    if (!action.approvalId || !action.previewId) throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
    this.requireActivePreview(action.sessionId, action.previewId)
    await application.get('MoleculeWorkspaceService').discardPreview(action.previewId)
    this.activePreview = null
    this.removeHumanPreviewCard(action.sessionId, action.approvalId)
    this.addActivity(action.sessionId, {
      kind: 'tool_result',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.preview_discarded_title'),
      summary: t('chemsmart_studio.control_activity.preview_discarded_summary', { previewId: action.previewId }),
      toolName: 'discard_molecule_preview'
    })
  }

  private async discardPreviewAction(action: ActionCapability): Promise<void> {
    if (!action.approvalId || !action.previewId) throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
    this.settleApproval(action.approvalId, 'deny')
    this.requireActivePreview(action.sessionId, action.previewId)
    await application.get('MoleculeWorkspaceService').discardPreview(action.previewId)
    this.activePreview = null
    this.addActivity(action.sessionId, {
      kind: 'tool_result',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.preview_discarded_title'),
      summary: t('chemsmart_studio.control_activity.preview_discarded_summary', { previewId: action.previewId }),
      toolName: 'discard_molecule_preview'
    })
  }

  private async cancelOptimizationAction(action: ActionCapability): Promise<void> {
    const optimization = this.requireOptimizationAction(action, 'running')
    this.updateSession(action.sessionId, (snapshot) => ({
      ...snapshot,
      optimization: snapshot.optimization ? { ...snapshot.optimization, cancelActionId: undefined } : null
    }))
    const result = await application.get('CalculationRuntimeService').cancelCalculation(optimization.run.runId)
    this.optimizationOwner = null
    this.activeRunAtomIds = []
    this.updateSession(action.sessionId, (snapshot) => ({ ...snapshot, optimization: null }))
    const resultStepCount = 'stepCount' in result ? result.stepCount : result.frameCount
    if (result.runId !== optimization.run.runId || resultStepCount !== optimization.frameCount) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Cancellation response does not match trusted run state'
      )
    }
    this.controlledRunIds.delete(result.runId)
    this.addActivity(action.sessionId, {
      kind: 'runtime',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.optimization_cancelled_title'),
      summary: t('chemsmart_studio.control_activity.optimization_cancelled_summary', {
        runId: result.runId,
        stepCount: resultStepCount
      }),
      toolName: 'cancel_molecule_optimization'
    })
    this.setAgentPhase(action.sessionId, 'completed', {
      currentObject: 'molecule',
      activeTool: 'cancel_molecule_optimization',
      latestGate: 'denied',
      terminalResult: 'cancelled'
    })
    this.publishCommittedDisplay(action.sessionId)
  }

  private async acceptOptimizationAction(action: ActionCapability): Promise<void> {
    const optimization = this.requireOptimizationAction(action, 'awaiting_final_geometry')
    if (action.expectedRevision !== optimization.run.inputRevision) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Final geometry revision is stale')
    }
    const result = await application
      .get('CalculationRuntimeService')
      .acceptFinalGeometry(optimization.run.runId, action.expectedRevision)
      .catch((error: unknown) => this.reissueFinalActionsAndThrow(action.sessionId, error))
    if (
      result.runId !== optimization.run.runId ||
      result.revision !== optimization.run.inputRevision + 1 ||
      result.geometryHash !== optimization.latestFrame?.structureHash
    ) {
      this.reissueFinalActionsAndThrow(
        action.sessionId,
        new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Final commit response does not match trusted run state')
      )
    }
    this.clearOptimizationAfterFinalAction(action.sessionId)
    this.addActivity(action.sessionId, {
      kind: 'tool_result',
      status: 'completed',
      title: t('chemsmart_studio.control_activity.final_geometry_accepted_title'),
      summary: t('chemsmart_studio.control_activity.final_geometry_accepted_summary', {
        runId: result.runId,
        revision: result.revision
      }),
      toolName: 'accept_optimization_geometry'
    })
    this.setAgentPhase(action.sessionId, 'completed', {
      currentObject: 'molecule',
      activeTool: 'accept_optimization_geometry',
      latestGate: 'passed',
      terminalResult: 'completed'
    })
  }

  private async rejectOptimizationAction(action: ActionCapability): Promise<void> {
    const optimization = this.requireOptimizationAction(action, 'awaiting_final_geometry')
    const result = await application
      .get('CalculationRuntimeService')
      .rejectFinalGeometry(optimization.run.runId)
      .catch((error: unknown) => this.reissueFinalActionsAndThrow(action.sessionId, error))
    if (result.runId !== optimization.run.runId || result.revision !== optimization.run.inputRevision) {
      this.reissueFinalActionsAndThrow(
        action.sessionId,
        new IpcError(
          chemsmartStudioErrorCodes.SCHEMA_INVALID,
          'Final rejection response does not match trusted run state'
        )
      )
    }
    this.clearOptimizationAfterFinalAction(action.sessionId)
    this.addActivity(action.sessionId, {
      kind: 'tool_result',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.final_geometry_rejected_title'),
      summary: t('chemsmart_studio.control_activity.final_geometry_rejected_summary', {
        runId: result.runId,
        revision: result.revision
      }),
      toolName: 'reject_optimization_geometry'
    })
    this.setAgentPhase(action.sessionId, 'completed', {
      currentObject: 'molecule',
      activeTool: 'reject_optimization_geometry',
      latestGate: 'denied',
      terminalResult: 'denied'
    })
  }

  private reissueFinalActionsAndThrow(sessionId: string, error: unknown): never {
    this.ensureDirectOptimizationActions(sessionId)
    throw error
  }

  private clearOptimizationAfterFinalAction(sessionId: string): void {
    const runId = this.ensureSession(sessionId).optimization?.run.runId
    if (runId) this.controlledRunIds.delete(runId)
    this.optimizationOwner = null
    this.activeRunAtomIds = []
    this.updateSession(sessionId, (snapshot) => ({ ...snapshot, optimization: null }))
    this.publishCommittedDisplay(sessionId)
  }

  private requireOptimizationAction(action: ActionCapability, status: 'running' | 'awaiting_final_geometry') {
    const optimization = this.ensureSession(action.sessionId).optimization
    if (
      !optimization ||
      optimization.run.status !== status ||
      optimization.run.runId !== action.runId ||
      this.optimizationOwner !== action.sessionId
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.RUN_NOT_FOUND,
        'Optimization control no longer matches an active run'
      )
    }
    return optimization
  }

  private createDirectAction(
    sessionId: string,
    kind: 'optimization_cancel' | 'optimization_accept' | 'optimization_reject',
    runId: string,
    expectedRevision?: number,
    siblingGroup = `run:${runId}:${kind}`
  ): ActionCapability {
    return {
      actionId: `action-${randomUUID()}`,
      siblingGroup,
      sessionId,
      kind,
      runId,
      expectedRevision,
      expiresAtMs: Number.MAX_SAFE_INTEGER
    }
  }

  private ensureDirectOptimizationActions(sessionId: string): void {
    const snapshot = this.ensureSession(sessionId)
    const optimization = snapshot.optimization
    if (!optimization || this.optimizationOwner !== sessionId) return
    if (optimization.run.status === 'running' && !optimization.cancelActionId) {
      const action = this.createDirectAction(sessionId, 'optimization_cancel', optimization.run.runId)
      this.actions.set(action.actionId, action)
      try {
        this.updateSession(sessionId, (candidate) => ({
          ...candidate,
          optimization: candidate.optimization ? { ...candidate.optimization, cancelActionId: action.actionId } : null
        }))
      } catch (error) {
        this.actions.delete(action.actionId)
        throw error
      }
    }
    if (
      optimization.run.status === 'awaiting_final_geometry' &&
      optimization.finalGeometry &&
      (!this.actions.has(optimization.finalGeometry.acceptActionId) ||
        !this.actions.has(optimization.finalGeometry.rejectActionId))
    ) {
      const siblingGroup = `run:${optimization.run.runId}:final`
      const accept = this.createDirectAction(
        sessionId,
        'optimization_accept',
        optimization.run.runId,
        optimization.run.inputRevision,
        siblingGroup
      )
      const reject = this.createDirectAction(
        sessionId,
        'optimization_reject',
        optimization.run.runId,
        optimization.run.inputRevision,
        siblingGroup
      )
      this.actions.set(accept.actionId, accept)
      this.actions.set(reject.actionId, reject)
      try {
        this.updateSession(sessionId, (candidate) => ({
          ...candidate,
          optimization:
            candidate.optimization?.finalGeometry === null || !candidate.optimization
              ? candidate.optimization
              : {
                  ...candidate.optimization,
                  finalGeometry: {
                    ...candidate.optimization.finalGeometry,
                    acceptActionId: accept.actionId,
                    rejectActionId: reject.actionId
                  }
                }
        }))
      } catch (error) {
        this.actions.delete(accept.actionId)
        this.actions.delete(reject.actionId)
        throw error
      }
    }
  }

  private handleMoleculeChanged(summary: { documentId: string; revision: number }): void {
    this.updateMoleculeSummary(summary)
    this.scheduleControlledFinalRecovery(summary)
    if (!this.activePreview && !this.optimizationOwner && !this.replayLease) {
      for (const sessionId of this.sessionLeases.keys()) this.publishCommittedDisplay(sessionId)
    }
  }

  private updateMoleculeSummary(summary: { documentId: string; revision: number }): void {
    if (this.sessions.size === 0) return
    const candidates = new Map<string, StudioControlSnapshot>()
    for (const [sessionId, snapshot] of this.sessions) {
      const candidate = this.validateSnapshot({
        ...snapshot,
        snapshotRevision: snapshot.snapshotRevision + 1,
        molecule: summary,
        agent:
          snapshot.agent?.phase === 'recovering'
            ? this.nextAgentState(snapshot.agent, 'idle', {
                currentObject: 'molecule',
                latestGate: 'passed'
              })
            : snapshot.agent
      })
      candidates.set(sessionId, candidate)
    }
    for (const [sessionId, candidate] of candidates) {
      this.sessions.set(sessionId, candidate)
      this.notifySession(sessionId, candidate.snapshotRevision)
    }
  }

  private scheduleControlledFinalRecovery(summary: { documentId: string; revision: number }): void {
    if (this.controlledRecovery || this.optimizationOwner || this.activePreview || this.replayBlocksStudioWork()) return
    const candidates = application.get('CalculationRuntimeService').getRecoverableFinalDecisions()
    const recoveryKey = `${summary.documentId}:${summary.revision}:${candidates
      .map((candidate) => candidate.reservation.runId)
      .join(',')}`
    if (this.lastControlledRecoveryKey === recoveryKey) return
    const recovery = this.recoverControlledFinalDecision(summary, candidates)
    this.controlledRecovery = recovery
    void recovery
      .then(() => {
        this.lastControlledRecoveryKey = recoveryKey
      })
      .catch((error) => {
        logger.warn('Failed to recover trusted controlled-calculation state', {
          reason: error instanceof Error ? error.message : 'unknown'
        })
      })
      .finally(() => {
        if (this.controlledRecovery === recovery) this.controlledRecovery = null
      })
  }

  private async recoverControlledFinalDecision(
    summary: { documentId: string; revision: number },
    candidates: ControlledCalculationRecoveryCandidate[]
  ): Promise<void> {
    const runtime = application.get('CalculationRuntimeService')
    for (const candidate of candidates) {
      if (
        candidate.plan.binding.documentId !== summary.documentId ||
        (candidate.plan.binding.expectedRevision !== summary.revision &&
          candidate.plan.binding.expectedRevision + 1 !== summary.revision)
      ) {
        continue
      }
      const result = await runtime.recoverFinalDecision(candidate)
      if (result === 'accepted' || result === 'rejected') return
    }

    const boundCandidates = candidates.filter(
      (candidate) =>
        candidate.plan.binding.documentId === summary.documentId &&
        candidate.plan.binding.expectedRevision === summary.revision &&
        candidate.reservation.binding.sessionId === candidate.plan.binding.sessionId &&
        canonicalJson(candidate.reservation.binding) === canonicalJson(candidate.plan.binding) &&
        candidate.reservation.planId === candidate.plan.planId &&
        candidate.reservation.planDigest === candidate.plan.planDigest &&
        candidate.latestFrame.runId === candidate.reservation.runId &&
        candidate.latestFrame.energy !== undefined &&
        (candidate.latestFrame.forceMetrics !== undefined || candidate.latestFrame.gradientNorm !== undefined) &&
        candidate.terminal.runId === candidate.reservation.runId &&
        candidate.terminal.status === 'completed' &&
        candidate.terminal.frameCount === candidate.latestFrame.frameIndex + 1 &&
        candidate.terminal.outputGeometryHash === candidate.latestFrame.structureHash
    )
    if (boundCandidates.length === 0) return

    const records = await this.readCompleteReplayCatalog()
    const matches = boundCandidates.flatMap((candidate) =>
      records
        .filter((record) => this.matchesControlledRecovery(record, candidate))
        .map((record) => ({ candidate, record }))
    )
    if (matches.length !== 1 || this.optimizationOwner || this.activePreview || this.replayBlocksStudioWork()) {
      if (matches.length > 1) logger.warn('Refused ambiguous controlled-calculation recovery')
      return
    }

    const { candidate, record } = matches[0]
    const energy = candidate.latestFrame.energy
    const forceMetrics = candidate.latestFrame.forceMetrics
    const gradientNorm = candidate.latestFrame.gradientNorm
    if (!energy || (!forceMetrics && !gradientNorm)) return
    const sessionId = candidate.plan.binding.sessionId
    const latestFrame: OptimizationFrameSummary = {
      runId: candidate.latestFrame.runId,
      stepIndex: candidate.latestFrame.frameIndex,
      energy,
      ...(forceMetrics ? { forceMetrics } : {}),
      ...(gradientNorm ? { gradientNorm } : {}),
      structureHash: candidate.latestFrame.structureHash,
      timestamp: candidate.latestFrame.timestamp
    }
    const run = {
      runId: candidate.reservation.runId,
      documentId: candidate.plan.binding.documentId,
      inputRevision: candidate.plan.binding.expectedRevision,
      engine: candidate.plan.engine,
      method: candidate.plan.method,
      settings: {
        maxSteps: candidate.plan.settings.maxSteps,
        charge: candidate.plan.settings.charge,
        multiplicity: candidate.plan.settings.multiplicity,
        ...(candidate.plan.settings.solvent ? { solvent: candidate.plan.settings.solvent } : {}),
        extensions: {}
      },
      frozenAtomIds: record.run.frozenAtomIds,
      constraintIds: record.run.constraintIds,
      status: 'running' as const,
      createdAt: candidate.reservation.reservedAt,
      extensions: {}
    }
    this.optimizationOwner = sessionId
    this.activeRunAtomIds = candidate.latestFrame.atomIds.slice()
    this.controlledRunIds.add(run.runId)
    this.updateSession(sessionId, (snapshot) => ({
      ...snapshot,
      molecule: summary,
      optimization: {
        run,
        frameCount: candidate.terminal.frameCount,
        latestFrame,
        finalGeometry: null,
        extensions: {}
      }
    }))
    this.offerFinalGeometryDecision(sessionId, run.runId, candidate.terminal.frameCount)
  }

  private async replayRuntimeState(): Promise<ReplayRuntimeState> {
    const projects = application.get('MoleculeProjectStore')
    const activeRunId = (await projects.inspectProject(projects.getActiveProjectPath())).manifest.activeRunId
    const recoveredRunIds = new Set<string>()
    for (const runId of this.controlledRunIds) {
      if (runId !== activeRunId) recoveredRunIds.add(runId)
    }
    return { activeRunId, recoveredRunIds }
  }

  private async readCompleteReplayCatalog(): Promise<OptimizationReplayRecord[]> {
    const records: OptimizationReplayRecord[] = []
    const seenCursors = new Set<string>()
    let afterRunId: string | null = null
    const runtime = await this.replayRuntimeState()
    for (let page = 0; page < 20; page += 1) {
      const catalog = await application
        .get('MoleculeWorkspaceService')
        .getOptimizationReplayCatalog({ afterRunId, limit: 50 })
      records.push(...composeReplayRecords(catalog.runs, runtime))
      if (catalog.nextRunId === null) return records
      if (seenCursors.has(catalog.nextRunId)) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Optimization replay catalog cursor repeated')
      }
      seenCursors.add(catalog.nextRunId)
      afterRunId = catalog.nextRunId
    }
    throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Optimization replay catalog is oversized')
  }

  private matchesControlledRecovery(
    record: OptimizationReplayRecord,
    candidate: ControlledCalculationRecoveryCandidate
  ): boolean {
    const extension = record.run.extensions['chemsmart.controlled']
    const controlled =
      extension !== null && typeof extension === 'object' && !Array.isArray(extension) ? extension : null
    const nativeFrame = record.latestFrame
    return (
      record.active &&
      record.replayable &&
      record.outcome === 'awaiting_final_geometry' &&
      record.run.status === 'running' &&
      record.run.runId === candidate.reservation.runId &&
      record.run.documentId === candidate.plan.binding.documentId &&
      record.run.inputRevision === candidate.plan.binding.expectedRevision &&
      record.run.engine === candidate.plan.engine &&
      record.run.method === candidate.plan.method &&
      record.run.createdAt === candidate.reservation.reservedAt &&
      record.frameCount === candidate.terminal.frameCount &&
      nativeFrame?.runId === candidate.latestFrame.runId &&
      nativeFrame.stepIndex === candidate.latestFrame.frameIndex &&
      nativeFrame.timestamp === candidate.latestFrame.timestamp &&
      canonicalJson(nativeFrame.energy) === canonicalJson(candidate.latestFrame.energy) &&
      canonicalJson(nativeFrame.forceMetrics) === canonicalJson(candidate.latestFrame.forceMetrics) &&
      canonicalJson(nativeFrame.gradientNorm) === canonicalJson(candidate.latestFrame.gradientNorm) &&
      canonicalJson(controlled?.plan) === canonicalJson(candidate.plan) &&
      canonicalJson(controlled?.reservation) === canonicalJson(candidate.reservation)
    )
  }

  /**
   * Publishes a controlled run only after its sidecar ledger and manifest ownership are durable.
   * The runtime calls this directly so a rejected visible-state commit can abort the start
   * handshake instead of disappearing inside an error-isolated event listener.
   */
  commitControlledRunStart(event: ControlledCalculationRunStarted): void {
    const sessionId = event.plan.binding.sessionId
    const molecule = this.ensureSession(sessionId).molecule
    if (
      !molecule ||
      this.activePreview ||
      this.optimizationOwner ||
      this.replayBlocksStudioWork() ||
      event.reservation.binding.sessionId !== sessionId ||
      event.reservation.binding.documentId !== molecule.documentId ||
      event.reservation.binding.expectedRevision !== molecule.revision ||
      event.plan.planId !== event.reservation.planId ||
      event.plan.planDigest !== event.reservation.planDigest
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.RUN_ACTIVE,
        'Controlled calculation start no longer matches trusted Studio state'
      )
    }
    const run = {
      runId: event.reservation.runId,
      documentId: event.reservation.binding.documentId,
      inputRevision: event.reservation.binding.expectedRevision,
      engine: event.plan.engine,
      method: event.plan.method,
      settings: {
        maxSteps: event.plan.settings.maxSteps,
        charge: event.plan.settings.charge,
        multiplicity: event.plan.settings.multiplicity,
        ...(event.plan.settings.solvent ? { solvent: event.plan.settings.solvent } : {}),
        extensions: {}
      },
      frozenAtomIds: Object.keys(event.document.frozenAxes),
      constraintIds: event.document.constraints.map((constraint) => constraint.id),
      status: 'running' as const,
      createdAt: event.reservation.reservedAt,
      extensions: {}
    }
    this.optimizationOwner = sessionId
    this.activeRunAtomIds = event.document.atoms.map((atom) => atom.id)
    this.controlledRunIds.add(run.runId)
    this.updateSession(sessionId, (snapshot) => ({
      ...snapshot,
      agent: this.nextAgentState(snapshot.agent, 'running_calculation', {
        currentObject: 'trajectory',
        activeTool: 'start_prepared_optimization',
        latestGate: 'passed',
        pendingTrustedAction: 'calculation_cancel'
      }),
      optimization: {
        run,
        frameCount: 0,
        latestFrame: null,
        finalGeometry: null,
        extensions: {}
      },
      activity: this.appendActivity(snapshot.activity, {
        kind: 'runtime',
        status: 'pending',
        title: t('chemsmart_studio.control_activity.optimization_started_title'),
        summary: t('chemsmart_studio.control_activity.optimization_started_summary', {
          engine: run.engine,
          method: run.method,
          revision: run.inputRevision
        }),
        toolName: 'start_prepared_optimization'
      })
    }))
  }

  private handleControlledFrame(frame: ControlledCalculationExternalFrame): void {
    const sessionId = this.optimizationOwner
    if (!sessionId || !this.controlledRunIds.has(frame.runId)) return
    const optimization = this.ensureSession(sessionId).optimization
    if (
      !optimization ||
      optimization.run.status !== 'running' ||
      optimization.run.runId !== frame.runId ||
      frame.frameIndex !== optimization.frameCount ||
      frame.energy === undefined ||
      (frame.forceMetrics === undefined && frame.gradientNorm === undefined) ||
      !sameStrings(frame.atomIds, this.activeRunAtomIds)
    ) {
      logger.warn('Rejected controlled calculation frame against trusted Studio state', {
        runId: frame.runId,
        frameIndex: frame.frameIndex
      })
      return
    }
    const latestFrame: OptimizationFrameSummary = {
      runId: frame.runId,
      stepIndex: frame.frameIndex,
      energy: frame.energy,
      ...(frame.forceMetrics ? { forceMetrics: frame.forceMetrics } : {}),
      ...(frame.gradientNorm ? { gradientNorm: frame.gradientNorm } : {}),
      ...(frame.convergence ? { convergence: frame.convergence } : {}),
      structureHash: frame.structureHash,
      timestamp: frame.timestamp
    }
    this.updateSession(sessionId, (candidate) => ({
      ...candidate,
      agent: this.nextAgentState(candidate.agent, 'running_calculation', {
        currentObject: 'trajectory',
        activeTool: 'get_optimization_status',
        latestGate: 'passed',
        pendingTrustedAction: 'calculation_cancel',
        progress: Math.min(
          (frame.frameIndex + 1) / Math.max(1, candidate.optimization?.run.settings.maxSteps ?? frame.frameIndex + 1),
          0.99
        )
      }),
      optimization: candidate.optimization
        ? { ...candidate.optimization, frameCount: frame.frameIndex + 1, latestFrame }
        : null
    }))
    this.publishRunFrameDisplay(sessionId, frame.runId, frame.frameIndex, {
      atomIds: frame.atomIds,
      atomicNumbers: frame.atomicNumbers,
      positions: frame.positions,
      structureHash: frame.structureHash
    })
  }

  private handleControlledTerminal(terminal: ControlledCalculationTerminal): void {
    const sessionId = this.optimizationOwner
    if (!sessionId || !this.controlledRunIds.has(terminal.runId)) return
    const optimization = this.ensureSession(sessionId).optimization
    if (
      !optimization ||
      optimization.run.status !== 'running' ||
      optimization.run.runId !== terminal.runId ||
      terminal.frameCount !== optimization.frameCount
    ) {
      logger.warn('Rejected controlled calculation terminal against trusted Studio state', {
        runId: terminal.runId,
        frameCount: terminal.frameCount
      })
      return
    }
    this.consumeRunActions(terminal.runId)
    if (terminal.status !== 'completed') {
      this.controlledRunIds.delete(terminal.runId)
      this.optimizationOwner = null
      this.activeRunAtomIds = []
      this.updateSession(sessionId, (candidate) => ({
        ...candidate,
        agent: this.nextAgentState(candidate.agent, terminal.status === 'cancelled' ? 'completed' : 'failed', {
          currentObject: 'trajectory',
          activeTool: 'get_optimization_status',
          latestGate: terminal.status === 'cancelled' ? 'denied' : 'failed',
          terminalResult: terminal.status === 'cancelled' ? 'cancelled' : 'failed'
        }),
        optimization: null,
        activity: this.appendActivity(candidate.activity, {
          kind: 'runtime',
          status: terminal.status === 'cancelled' ? 'denied' : 'failed',
          title:
            terminal.status === 'cancelled'
              ? t('chemsmart_studio.control_activity.optimization_cancelled_title')
              : t('chemsmart_studio.control_activity.optimization_failed_title'),
          summary:
            terminal.status === 'cancelled'
              ? t('chemsmart_studio.control_activity.optimization_cancelled_summary', {
                  runId: terminal.runId,
                  stepCount: terminal.frameCount
                })
              : t('chemsmart_studio.control_activity.optimization_failed_summary', { runId: terminal.runId }),
          toolName: 'start_prepared_optimization'
        })
      }))
      this.publishCommittedDisplay(sessionId)
      return
    }
    this.offerFinalGeometryDecision(sessionId, terminal.runId, terminal.frameCount)
  }

  private offerFinalGeometryDecision(sessionId: string, runId: string, stepCount: number): void {
    const optimization = this.ensureSession(sessionId).optimization
    if (!optimization?.latestFrame || optimization.run.runId !== runId || optimization.frameCount !== stepCount) {
      logger.warn('Rejected final-geometry status without a validated frame', { runId })
      return
    }
    const siblingGroup = `run:${runId}:final`
    const accept = this.createDirectAction(
      sessionId,
      'optimization_accept',
      runId,
      optimization.run.inputRevision,
      siblingGroup
    )
    const reject = this.createDirectAction(
      sessionId,
      'optimization_reject',
      runId,
      optimization.run.inputRevision,
      siblingGroup
    )
    this.actions.set(accept.actionId, accept)
    this.actions.set(reject.actionId, reject)
    try {
      this.updateSession(sessionId, (candidate) => ({
        ...candidate,
        agent: this.nextAgentState(candidate.agent, 'awaiting_final_geometry_decision', {
          currentObject: 'trajectory',
          activeTool: 'get_optimization_status',
          latestGate: 'passed',
          pendingTrustedAction: 'final_geometry_decision',
          progress: 1,
          requiresUserInput: true
        }),
        optimization: candidate.optimization
          ? {
              ...candidate.optimization,
              run: { ...candidate.optimization.run, status: 'awaiting_final_geometry' },
              cancelActionId: undefined,
              finalGeometry: {
                risk: 'final_geometry_commit',
                expectedRevision: candidate.optimization.run.inputRevision,
                frame: candidate.optimization.latestFrame!,
                acceptActionId: accept.actionId,
                rejectActionId: reject.actionId
              }
            }
          : null,
        activity: this.appendActivity(candidate.activity, {
          kind: 'runtime',
          status: 'needs_user',
          title: t('chemsmart_studio.control_activity.review_final_geometry_title'),
          summary: t('chemsmart_studio.control_activity.review_final_geometry_summary', {
            runId,
            stepCount
          }),
          toolName: 'accept_optimization_geometry'
        })
      }))
    } catch (error) {
      this.actions.delete(accept.actionId)
      this.actions.delete(reject.actionId)
      throw error
    }
  }

  private requireActivePreview(sessionId: string, previewId: string): ActivePreview {
    const preview = this.activePreview
    if (!preview || preview.sessionId !== sessionId || preview.receipt.previewId !== previewId) {
      throw this.sidecarFault(
        chemsmartStudioErrorCodes.APPROVAL_REQUIRED,
        'Preview identity does not match trusted state'
      )
    }
    return preview
  }

  private consumeGrantKey(key: string): void {
    const grant = this.approvedGrants.get(key)
    if (!grant || grant.expiresAtMs <= Date.now()) {
      this.approvedGrants.delete(key)
      throw this.sidecarFault(chemsmartStudioErrorCodes.APPROVAL_REQUIRED, 'One-shot approval is missing or expired')
    }
    this.approvedGrants.delete(key)
  }

  private settleApproval(approvalId: string, decision: ApprovalDecision): void {
    const record = this.pendingApprovals.get(approvalId)
    if (!record) return
    clearTimeout(record.timeout)
    this.pendingApprovals.delete(approvalId)
    for (const actionId of record.actionIds) this.actions.delete(actionId)
    this.updateSession(record.request.sessionId, (snapshot) => ({
      ...snapshot,
      pendingApprovals: snapshot.pendingApprovals.filter((approval) => approval.approvalId !== approvalId),
      agent: this.nextAgentState(
        snapshot.agent,
        decision === 'allow_once'
          ? record.request.tool === 'commit_molecule_preview'
            ? 'validating_semantics'
            : 'preparing_calculation'
          : 'completed',
        {
          currentObject: record.request.tool === 'commit_molecule_preview' ? 'preview' : 'calculation_plan',
          activeTool: record.request.tool,
          latestGate: decision === 'allow_once' ? 'passed' : 'denied',
          terminalResult: decision === 'allow_once' ? null : 'denied'
        }
      ),
      activity: this.appendActivity(snapshot.activity, {
        kind: 'tool_result',
        status: decision === 'allow_once' ? 'passed' : 'denied',
        title:
          decision === 'allow_once'
            ? t('chemsmart_studio.control_activity.one_shot_approved_title')
            : t('chemsmart_studio.control_activity.action_denied_title'),
        summary:
          decision === 'allow_once'
            ? t('chemsmart_studio.control_activity.one_shot_approved_summary', { tool: record.request.tool })
            : t('chemsmart_studio.control_activity.action_denied_summary', { tool: record.request.tool }),
        toolName: record.request.tool
      })
    }))
    record.resolve({ decision })
  }

  private expireApproval(approvalId: string): void {
    const record = this.pendingApprovals.get(approvalId)
    if (!record) return
    this.consumeActionIds(record.actionIds)
    this.settleApproval(approvalId, 'deny')
  }

  private expireApprovals(): void {
    const now = Date.now()
    for (const record of this.pendingApprovals.values()) {
      if (Date.parse(record.expiresAt) <= now) this.expireApproval(record.approvalId)
    }
    for (const [key, grant] of this.approvedGrants) {
      if (grant.expiresAtMs <= now) this.approvedGrants.delete(key)
    }
  }

  private removePreviewApproval(sessionId: string, previewId: string): void {
    for (const record of this.pendingApprovals.values()) {
      if (
        record.request.sessionId === sessionId &&
        record.request.tool === 'commit_molecule_preview' &&
        record.request.arguments.preview_id === previewId
      ) {
        this.settleApproval(record.approvalId, 'deny')
      }
    }
    this.addActivity(sessionId, {
      kind: 'tool_result',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.preview_discarded_title'),
      summary: t('chemsmart_studio.control_activity.preview_discarded_summary', { previewId }),
      toolName: 'discard_molecule_preview'
    })
  }

  private consumeActionGroup(siblingGroup: string): void {
    for (const [actionId, action] of this.actions) {
      if (action.siblingGroup === siblingGroup) this.actions.delete(actionId)
    }
  }

  private consumeActionIds(actionIds: string[]): void {
    for (const actionId of actionIds) this.actions.delete(actionId)
  }

  private consumeRunActions(runId: string): void {
    for (const [actionId, action] of this.actions) {
      if (action.runId === runId) this.actions.delete(actionId)
    }
  }

  private ensureSession(sessionId: string): StudioControlSnapshot {
    let snapshot = this.sessions.get(sessionId)
    if (!snapshot) {
      snapshot = this.validateSnapshot({
        sessionId,
        snapshotRevision: 0,
        molecule: application.get('MoleculeWorkspaceService').getCachedMoleculeSummary(),
        pendingApprovals: [],
        activity: [],
        optimization: null,
        agent: this.nextAgentState(undefined, 'idle'),
        extensions: {}
      })
      this.sessions.set(sessionId, snapshot)
    }
    return snapshot
  }

  private updateSession(
    sessionId: string,
    update: (snapshot: StudioControlSnapshot) => Omit<StudioControlSnapshot, 'snapshotRevision'> & {
      snapshotRevision?: number
    }
  ): StudioControlSnapshot {
    const current = this.ensureSession(sessionId)
    const proposed = update(structuredClone(current))
    const candidate = this.validateSnapshot({ ...proposed, snapshotRevision: current.snapshotRevision + 1 })
    this.sessions.set(sessionId, candidate)
    this.notifySession(sessionId, candidate.snapshotRevision)
    return candidate
  }

  private setAgentPhase(sessionId: string, phase: StudioAgentPhase, options: AgentStateOptions = {}): void {
    this.updateSession(sessionId, (snapshot) => ({
      ...snapshot,
      agent: this.nextAgentState(snapshot.agent, phase, options)
    }))
  }

  private nextAgentState(
    previous: StudioAgentWorkspaceState | undefined,
    phase: StudioAgentPhase,
    options: AgentStateOptions = {}
  ): StudioAgentWorkspaceState {
    return {
      phase,
      currentObject: 'session',
      activeTool: null,
      statusSummary: getAgentPhaseSummary(phase),
      progress: null,
      focus: previous?.focus ?? { atomIds: [], bondIds: [] },
      latestGate: null,
      pendingTrustedAction: null,
      requiresUserInput: false,
      terminalResult: phase === 'failed' ? 'failed' : null,
      recoverySequence: previous?.recoverySequence ?? 0,
      updatedAt: new Date().toISOString(),
      extensions: {},
      ...options
    }
  }

  private validateSnapshot(value: unknown): StudioControlSnapshot {
    const result = controlSnapshotSchema.safeParse(value)
    if (!result.success) {
      logger.error('Refused invalid trusted control snapshot', result.error)
      throw new Error('Trusted Studio control state violated its canonical schema')
    }
    return result.data
  }

  private appendActivity(
    activity: StudioControlSnapshot['activity'],
    item: Omit<StudioControlSnapshot['activity'][number], 'activityId' | 'sequence' | 'timestamp' | 'extensions'>
  ): StudioControlSnapshot['activity'] {
    const sequence = activity.length === 0 ? 0 : activity[activity.length - 1].sequence + 1
    return [
      ...activity,
      {
        ...item,
        activityId: `activity-${randomUUID()}`,
        sequence,
        timestamp: new Date().toISOString(),
        extensions: {}
      }
    ].slice(-MAX_ACTIVITY_ITEMS)
  }

  private addActivity(
    sessionId: string,
    item: Omit<StudioControlSnapshot['activity'][number], 'activityId' | 'sequence' | 'timestamp' | 'extensions'>
  ): void {
    this.updateSession(sessionId, (snapshot) => ({
      ...snapshot,
      activity: this.appendActivity(snapshot.activity, item)
    }))
  }

  private addDeniedSemanticActivity(request: StudioApprovalRequest, summary: string): void {
    this.addActivity(request.sessionId, {
      kind: 'semantic_gate',
      status: 'denied',
      title: t('chemsmart_studio.control_activity.request_rejected_title'),
      summary,
      toolName: request.tool
    })
  }

  private rendererCatalog(catalog: OptimizationReplayCatalog): ChemSmartStudioReplayCatalog {
    return {
      totalRuns: catalog.totalRuns,
      nextRunId: catalog.nextRunId,
      runs: catalog.runs.map((record) => ({
        ...record,
        message: '',
        run: {
          ...record.run,
          settings: { ...record.run.settings, extensions: {} },
          frozenAtomIds: [],
          constraintIds: [],
          extensions: {}
        },
        extensions: {}
      })),
      extensions: {}
    }
  }

  private rendererSelection(selection: OptimizationReplaySelection): ChemSmartStudioReplaySelection {
    return { ...selection, extensions: {} }
  }

  private composeDisplayDocument(
    document: MoleculeDocument,
    frame: {
      runId: string
      frameIndex: number
      atomIds: readonly string[]
      atomicNumbers?: readonly number[]
      positions: readonly (readonly [number, number, number])[]
      structureHash: string
    }
  ): MoleculeDocument {
    const documentAtomIds = document.atoms.map((atom) => atom.id)
    if (
      frame.positions.length !== document.atoms.length ||
      !sameStrings(frame.atomIds, documentAtomIds) ||
      (frame.atomicNumbers !== undefined &&
        (frame.atomicNumbers.length !== document.atoms.length ||
          frame.atomicNumbers.some((atomicNumber, index) => atomicNumber !== document.atoms[index].atomicNumber)))
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Optimization frame atom identity does not match the committed molecule'
      )
    }
    const displayDocument: MoleculeDocument = {
      ...structuredClone(document),
      atoms: document.atoms.map((atom, index) => ({
        ...structuredClone(atom),
        position: [...frame.positions[index]] as [number, number, number]
      }))
    }
    if (moleculeGeometryHash(displayDocument) !== frame.structureHash) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Optimization frame geometry hash does not match its coordinates'
      )
    }
    return displayDocument
  }

  private notifyMoleculeDisplay(
    sessionId: string,
    senderId: WindowId,
    document: MoleculeDocument,
    binding: ChemSmartStudioMoleculeDisplayChanged['binding']
  ): void {
    application.get('IpcApiService').send(senderId, 'chemsmart_studio.molecule.display_changed', {
      sessionId,
      document,
      binding
    })
  }

  private publishRunFrameDisplay(
    sessionId: string,
    runId: string,
    frameIndex: number,
    frame: {
      atomIds: readonly string[]
      atomicNumbers?: readonly number[]
      positions: readonly (readonly [number, number, number])[]
      structureHash: string
    }
  ): void {
    const senderId = this.sessionLeases.get(sessionId)
    const optimization = this.ensureSession(sessionId).optimization
    if (!senderId || !optimization || optimization.run.runId !== runId) return
    try {
      const document = application.get('MoleculeDocumentService').getDocument()
      if (document.documentId !== optimization.run.documentId || document.revision !== optimization.run.inputRevision) {
        throw new IpcError(
          chemsmartStudioErrorCodes.REVISION_CONFLICT,
          'Optimization frame does not target the current committed molecule'
        )
      }
      const displayDocument = this.composeDisplayDocument(document, {
        runId,
        frameIndex,
        ...frame
      })
      this.notifyMoleculeDisplay(sessionId, senderId, displayDocument, {
        state: 'run',
        runId,
        frameIndex
      })
    } catch (error) {
      logger.warn('Rejected optimization frame for the Three.js display', {
        runId,
        frameIndex,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private publishCommittedDisplay(sessionId: string): void {
    const senderId = this.sessionLeases.get(sessionId)
    if (!senderId) return
    try {
      const document = application.get('MoleculeDocumentService').getDocument()
      this.notifyMoleculeDisplay(sessionId, senderId, document, { state: 'committed' })
    } catch (error) {
      logger.warn('Failed to restore the committed Three.js display', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private notifyReplaySelection(
    sessionId: string,
    senderId: WindowId,
    selection: ChemSmartStudioReplaySelection
  ): void {
    application.get('IpcApiService').send(senderId, 'chemsmart_studio.optimization.replay_changed', {
      sessionId,
      selection
    })
  }

  private serializeReplay<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.replayTransitionCount += 1
    const result = this.replayTransition.then(operation, operation)
    this.replayTransition = result.then(
      () => {
        this.replayTransitionCount -= 1
      },
      () => {
        this.replayTransitionCount -= 1
      }
    )
    return result
  }

  private replayBlocksStudioWork(): boolean {
    return this.replayLease !== null || this.replayTransitionCount > 0
  }

  private async applySelection(
    sessionId: string,
    request: { documentId: string; expectedRevision: number; atomIds: readonly string[] }
  ): Promise<MoleculeDocument> {
    const snapshot = this.ensureSession(sessionId)
    if (
      !snapshot.molecule ||
      snapshot.molecule.documentId !== request.documentId ||
      snapshot.molecule.revision !== request.expectedRevision
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Selection does not target the current committed molecule'
      )
    }
    if (this.activePreview || this.replayBlocksStudioWork()) {
      throw new IpcError(
        chemsmartStudioErrorCodes.APPROVAL_REQUIRED,
        'Return to the committed molecule before changing its selection'
      )
    }
    const document = await application
      .get('MoleculeWorkspaceService')
      .setSelection(request.documentId, request.expectedRevision, request.atomIds)
    if (
      document.documentId !== request.documentId ||
      document.revision !== request.expectedRevision ||
      !sameStrings(document.selections, request.atomIds)
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Selection response is inconsistent')
    }
    return document
  }

  private requireSessionLease(sessionId: string, senderId: WindowId): void {
    if (typeof senderId !== 'string' || senderId.length === 0) {
      throw new IpcError(IpcErrorCode.FORBIDDEN_SENDER, 'A managed Studio window is required')
    }
    const existing = this.sessionLeases.get(sessionId)
    if (existing && existing !== senderId) {
      throw new IpcError(IpcErrorCode.FORBIDDEN_SENDER, 'Studio session is controlled by another window')
    }
    this.sessionLeases.set(sessionId, senderId)
  }

  private releaseWindow(senderId: WindowId): void {
    const replayLease = this.replayLease?.senderId === senderId ? this.replayLease : null
    for (const [sessionId, lease] of this.sessionLeases) {
      if (lease !== senderId) continue
      this.sessionLeases.delete(sessionId)
      for (const record of [...this.pendingApprovals.values()]) {
        if (record.request.sessionId === sessionId) this.settleApproval(record.approvalId, 'deny')
      }
      for (const [actionId, action] of this.actions) {
        if (action.sessionId === sessionId) this.actions.delete(actionId)
      }
      const snapshot = this.sessions.get(sessionId)
      if (snapshot?.optimization?.run.status === 'running') {
        this.updateSession(sessionId, (candidate) => ({
          ...candidate,
          optimization: candidate.optimization ? { ...candidate.optimization, cancelActionId: undefined } : null
        }))
      }
      logger.info('Revoked Studio controls after renderer loss', { sessionId })
    }
    if (replayLease) {
      void this.serializeReplay(async () => {
        if (this.replayLease !== replayLease) return
        if (this.replayLease === replayLease) this.replayLease = null
      })
    }
  }

  private notifySession(sessionId: string, snapshotRevision: number): void {
    const senderId = this.sessionLeases.get(sessionId)
    if (senderId) {
      application.get('IpcApiService').send(senderId, 'chemsmart_studio.control.changed', {
        sessionId,
        snapshotRevision
      })
    }
  }

  private rememberRequest(key: string): void {
    this.seenRequestKeys.add(key)
    if (this.seenRequestKeys.size <= MAX_REMEMBERED_REQUESTS) return
    const oldest = this.seenRequestKeys.values().next().value
    if (oldest) this.seenRequestKeys.delete(oldest)
  }

  private schemaFault(message: string, issues: unknown): JsonRpcFault {
    return new JsonRpcFault(-32602, message, { studioCode: chemsmartStudioErrorCodes.SCHEMA_INVALID, issues })
  }

  private sidecarFault(code: string, message: string): JsonRpcFault {
    return new JsonRpcFault(-32602, message, { studioCode: code })
  }

  protected async onStop(): Promise<void> {
    await this.controlledRecovery?.catch(() => undefined)
    await this.replayTransition
    this.replayLease = null
    this.denyPendingApprovals()
    this.actions.clear()
    this.controlledRunIds.clear()
    this.sessionLeases.clear()
  }
}
