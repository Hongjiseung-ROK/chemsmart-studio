import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import {
  type ControlledCalculationAgentToolRequest,
  type ControlledCalculationArtifact,
  type ControlledCalculationArtifactChunk,
  type ControlledCalculationArtifactList,
  type ControlledCalculationExecutableIdentity,
  type ControlledCalculationExternalFrame,
  type ControlledCalculationFrameComparison,
  type ControlledCalculationHostRequest,
  type ControlledCalculationHostResponse,
  type ControlledCalculationReplay,
  type ControlledCalculationReservation,
  controlledCalculationRuntimeSchema,
  type ControlledCalculationSettings,
  type ControlledCalculationStatus,
  type ControlledCalculationTerminal,
  type CurrentMoleculeAnalysis,
  type MoleculeDocument,
  type OptimizationFinalCommit,
  type OptimizationFinalDecisionEvent,
  type OptimizationFinalRejected,
  type OptimizationRun,
  type OptimizationTrajectoryAppendFrameRequest,
  type OptimizationTrajectoryAppendFrameResponse,
  type OptimizationTrajectoryCloseRunRequest,
  type OptimizationTrajectoryCloseRunResponse,
  type OptimizationTrajectoryOpenRunRequest,
  type OptimizationTrajectoryOpenRunResponse,
  type OptimizationTrajectoryRecordFinalEventRequest,
  type OptimizationTrajectoryRecordFinalEventResponse,
  type OptimizationTrajectoryRunState,
  type OptimizationTrajectoryRunStateRequest,
  optimizationTrajectoryRuntimeSchema,
  type PreparedControlledCalculation,
  type StudioControlledCalculationContext
} from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Emitter, type Event, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { app } from 'electron'

import {
  canonicalJson,
  digestJson,
  elementSymbolForAtomicNumber,
  moleculeGeometryHash,
  preparedPlanDigestPayload
} from './ControlledCalculationIdentity'
import { isControlledCalculationTestHarnessEnabled } from './controlledCalculationTestHarness'
import { XtbCalculationAdapter } from './XtbCalculationAdapter'
import { discoverXtbRuntime, type XtbRuntime } from './XtbRuntime'

const PLAN_LIFETIME_MS = 10 * 60 * 1000
const MAX_ARTIFACT_SIZE_BYTES = 100 * 1024 * 1024
const MAX_RECOVERED_RUNS = 1_000
const MAX_RECOVERED_FRAMES = 10_000
const MAX_RECOVERY_PLAN_FILE_BYTES = 1 * 1024 * 1024
const MAX_RECOVERY_LEDGER_FILE_BYTES = 16 * 1024 * 1024
const MAX_RECOVERY_TOTAL_BYTES = 64 * 1024 * 1024
const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const logger = loggerService.withContext('CalculationRuntimeService')
interface PrepareCalculationInput {
  sessionId: string
  documentId: string
  expectedRevision: number
  geometryHash: string
  engine: PreparedControlledCalculation['engine']
  method: string
  settings: ControlledCalculationSettings
}

interface ControlledRunState {
  reservation: ControlledCalculationReservation
  document: MoleculeDocument | null
  atomIds: string[]
  atomicNumbers: number[]
  frames: ControlledCalculationExternalFrame[]
  terminal: ControlledCalculationTerminal | null
  executionPending: boolean
  executionPromise: Promise<ControlledCalculationTerminal> | null
  abortController: AbortController | null
  started: boolean
  trajectoryOpened: boolean
  trajectoryClosed: boolean
  trajectoryFrameCount: number
  hostTerminalPersisted: boolean
  manifestClaimed: boolean
  mutationLocked: boolean
  ledgerIdentity: FileIdentity
  recoveredFromDisk: boolean
}

interface FileIdentity {
  device: number
  inode: number
}

interface RegisteredArtifact {
  artifact: ControlledCalculationArtifact
  filePath: string
  identity: FileIdentity
}

export interface ControlledCalculationRunSnapshot {
  reservation: ControlledCalculationReservation
  frameCount: number
  latestFrame: ControlledCalculationExternalFrame | null
  terminal: ControlledCalculationTerminal | null
}

export interface ControlledCalculationRunStarted {
  plan: PreparedControlledCalculation
  reservation: ControlledCalculationReservation
  document: MoleculeDocument
}

export interface ControlledCalculationRecoveryCandidate {
  plan: PreparedControlledCalculation
  reservation: ControlledCalculationReservation
  latestFrame: ControlledCalculationExternalFrame
  terminal: ControlledCalculationTerminal
}

export interface CalculationArtifactSource {
  key: string
  kind: ControlledCalculationArtifact['kind']
  displayName: string
  mediaType: string
  filePath: string
}

export interface CalculationExecutionAdapter {
  readonly kind: 'fake' | 'local'
  execute(
    reservation: ControlledCalculationReservation
  ): AsyncIterable<ControlledCalculationExternalFrame | ControlledCalculationTerminal>
  getArtifactSources?(): CalculationArtifactSource[]
}

function definitionValidator<Output>(definition: string): (value: unknown) => value is Output {
  const validate = runtimeValidator.getValidator<Output>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: controlledCalculationRuntimeSchema.$defs,
    $ref: `#/$defs/${definition}`
  } as JsonSchemaType)
  return (value): value is Output => validate(value).valid
}

function trajectoryDefinitionValidator<Output>(definition: string): (value: unknown) => value is Output {
  const validate = runtimeValidator.getValidator<Output>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: optimizationTrajectoryRuntimeSchema.$defs,
    $ref: `#/$defs/${definition}`
  } as JsonSchemaType)
  return (value): value is Output => validate(value).valid
}

const isExecutableIdentity = definitionValidator<ControlledCalculationExecutableIdentity>('executableIdentity')
const isPreparedPlan = definitionValidator<PreparedControlledCalculation>('preparedPlan')
const isReservation = definitionValidator<ControlledCalculationReservation>('reservation')
const isExternalFrame = definitionValidator<ControlledCalculationExternalFrame>('externalFrame')
const isTerminal = definitionValidator<ControlledCalculationTerminal>('terminal')
const isOpaqueArtifact = definitionValidator<ControlledCalculationArtifact>('opaqueArtifact')
const isHostRequest = definitionValidator<ControlledCalculationHostRequest>('hostRequest')
const isHostResponse = definitionValidator<ControlledCalculationHostResponse>('hostResponse')
const isTrajectoryOpenRunRequest = trajectoryDefinitionValidator<OptimizationTrajectoryOpenRunRequest>('openRunRequest')
const isTrajectoryOpenRunResponse =
  trajectoryDefinitionValidator<OptimizationTrajectoryOpenRunResponse>('openRunResponse')
const isTrajectoryAppendFrameRequest =
  trajectoryDefinitionValidator<OptimizationTrajectoryAppendFrameRequest>('appendFrameRequest')
const isTrajectoryAppendFrameResponse =
  trajectoryDefinitionValidator<OptimizationTrajectoryAppendFrameResponse>('appendFrameResponse')
const isTrajectoryCloseRunRequest =
  trajectoryDefinitionValidator<OptimizationTrajectoryCloseRunRequest>('closeRunRequest')
const isTrajectoryCloseRunResponse =
  trajectoryDefinitionValidator<OptimizationTrajectoryCloseRunResponse>('closeRunResponse')
const isTrajectoryFinalEventRequest =
  trajectoryDefinitionValidator<OptimizationTrajectoryRecordFinalEventRequest>('recordFinalEventRequest')
const isTrajectoryFinalEventResponse =
  trajectoryDefinitionValidator<OptimizationTrajectoryRecordFinalEventResponse>('recordFinalEventResponse')
const isTrajectoryRunStateRequest =
  trajectoryDefinitionValidator<OptimizationTrajectoryRunStateRequest>('runStateRequest')
const isTrajectoryRunState = trajectoryDefinitionValidator<OptimizationTrajectoryRunState>('runStateResponse')

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isOwnedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function frameGeometryHash(frame: ControlledCalculationExternalFrame): string {
  return digestJson(
    frame.atomIds
      .map((atomId, index) => [atomId, frame.atomicNumbers[index], frame.positions[index]] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  )
}

function currentMoleculeAnalysis(document: MoleculeDocument): CurrentMoleculeAnalysis {
  const counts = new Map<number, number>()
  for (const atom of document.atoms) counts.set(atom.atomicNumber, (counts.get(atom.atomicNumber) ?? 0) + 1)
  const elementCounts = [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([atomicNumber, count]) => ({ atomicNumber, count }))
  const formulaOrder = [...elementCounts].sort((left, right) => {
    if (left.atomicNumber === 6) return -1
    if (right.atomicNumber === 6) return 1
    if (left.atomicNumber === 1) return -1
    if (right.atomicNumber === 1) return 1
    const leftSymbol = elementSymbolForAtomicNumber(left.atomicNumber)
    const rightSymbol = elementSymbolForAtomicNumber(right.atomicNumber)
    return leftSymbol < rightSymbol ? -1 : leftSymbol > rightSymbol ? 1 : 0
  })
  const formula = formulaOrder
    .map(({ atomicNumber, count }) => `${elementSymbolForAtomicNumber(atomicNumber)}${count === 1 ? '' : count}`)
    .join('')
  return {
    type: 'current_molecule_analysis',
    molecule: structuredClone(document),
    geometryHash: moleculeGeometryHash(document),
    atomCount: document.atoms.length,
    bondCount: document.bonds.length,
    elementCounts,
    formula,
    charge: document.properties.charge ?? 0,
    multiplicity: document.properties.multiplicity ?? 1,
    extensions: {}
  }
}

@Injectable('CalculationRuntimeService')
@DependsOn(['MoleculeDocumentService', 'MoleculeWorkspaceService', 'MoleculeProjectStore'])
@ServicePhase(Phase.WhenReady)
export class CalculationRuntimeService extends BaseService {
  private readonly executables = new Map<
    PreparedControlledCalculation['engine'],
    ControlledCalculationExecutableIdentity
  >()
  private readonly plans = new Map<string, PreparedControlledCalculation>()
  private readonly runs = new Map<string, ControlledRunState>()
  private readonly artifacts = new Map<string, RegisteredArtifact>()
  private readonly trustedLocalAdapters = new WeakSet<CalculationExecutionAdapter>()
  private readonly runStartedEmitter: Emitter<ControlledCalculationRunStarted>
  private readonly frameCommittedEmitter: Emitter<ControlledCalculationExternalFrame>
  private readonly terminalCommittedEmitter: Emitter<ControlledCalculationTerminal>
  private reservationPending = false
  private fakeExecutionAdapter: CalculationExecutionAdapter | null = null
  private xtbRuntime: XtbRuntime | null = null

  public readonly onRunStarted: Event<ControlledCalculationRunStarted>
  public readonly onFrameCommitted: Event<ControlledCalculationExternalFrame>
  public readonly onTerminalCommitted: Event<ControlledCalculationTerminal>

  constructor() {
    super()
    this.runStartedEmitter = this.registerDisposable(new Emitter<ControlledCalculationRunStarted>())
    this.frameCommittedEmitter = this.registerDisposable(new Emitter<ControlledCalculationExternalFrame>())
    this.terminalCommittedEmitter = this.registerDisposable(new Emitter<ControlledCalculationTerminal>())
    this.onRunStarted = this.runStartedEmitter.event
    this.onFrameCommitted = this.frameCommittedEmitter.event
    this.onTerminalCommitted = this.terminalCommittedEmitter.event
  }

  configureExecutable(identity: ControlledCalculationExecutableIdentity): void {
    if (!isExecutableIdentity(identity) || identity.engine !== 'xtb' || identity.kind !== 'local_executable') {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Executable identity is schema-invalid')
    }
    if (this.reservationPending || [...this.runs.values()].some((run) => run.terminal === null)) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Executable identity cannot change during a run')
    }
    this.executables.set(identity.engine, structuredClone(identity))
  }

  configureFakeExecutionAdapter(adapter: CalculationExecutionAdapter): void {
    if (adapter.kind !== 'fake') {
      throw new IpcError(
        chemsmartStudioErrorCodes.APPROVAL_REQUIRED,
        'Only a deterministic fake adapter may be configured'
      )
    }
    if (this.reservationPending || [...this.runs.values()].some((run) => run.terminal === null)) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Execution adapter cannot change during a run')
    }
    this.fakeExecutionAdapter = adapter
  }

  async configureLocalXtbRuntime(
    executablePath: string,
    parameterDirectory?: string
  ): Promise<ControlledCalculationExecutableIdentity> {
    if (this.reservationPending || [...this.runs.values()].some((run) => run.terminal === null)) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'xTB runtime cannot change during a run')
    }
    const runtime = await discoverXtbRuntime(executablePath, undefined, parameterDirectory)
    this.configureExecutable(runtime.identity)
    this.xtbRuntime = runtime
    return structuredClone(runtime.identity)
  }

  getLocalXtbRuntimeIdentity(): ControlledCalculationExecutableIdentity | null {
    return this.xtbRuntime ? structuredClone(this.xtbRuntime.identity) : null
  }

  getPreparedPlanForApproval(sessionId: string, planId: string, planDigest: string): PreparedControlledCalculation {
    const plan = this.requirePlan(planId, planDigest)
    this.assertSessionBinding(sessionId, plan.binding.sessionId)
    if (plan.state !== 'validated') {
      throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED, 'Controlled calculation plan is not validated')
    }
    const runtimeAvailable = this.fakeExecutionAdapter !== null || (plan.engine === 'xtb' && this.xtbRuntime !== null)
    if (!runtimeAvailable) {
      throw new IpcError(
        chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE,
        'No trusted controlled execution runtime is configured'
      )
    }
    return structuredClone(plan)
  }

  async handleHostRequest(value: unknown): Promise<ControlledCalculationHostResponse> {
    if (!isHostRequest(value)) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Controlled calculation host request is schema-invalid'
      )
    }
    const request = value.request
    let response: ControlledCalculationHostResponse
    switch (request.tool) {
      case 'get_studio_context':
        response = await this.getStudioContext(value.sessionId)
        break
      case 'analyze_current_molecule':
        response = await this.analyzeCurrentMolecule(value.sessionId, request)
        break
      case 'prepare_molecule_optimization':
        response = await this.prepareFromHostRequest(value.sessionId, request)
        break
      case 'validate_prepared_optimization':
        response = await this.validateFromHostRequest(value.sessionId, request)
        break
      case 'start_prepared_optimization':
        response = await this.startFromHostRequest(value.sessionId, request)
        break
      case 'get_optimization_status':
        response = this.statusFromHostRequest(value.sessionId, request)
        break
      case 'list_calculation_artifacts':
        response = await this.listArtifactsFromHostRequest(value.sessionId, request)
        break
      case 'read_calculation_artifact':
        response = await this.readArtifactFromHostRequest(value.sessionId, request)
        break
      case 'import_completed_calculation':
        throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'The requested calculation artifact was not found')
      case 'get_optimization_replay':
        response = this.replayFromHostRequest(value.sessionId, request)
        break
      case 'compare_optimization_frames':
        response = this.compareFromHostRequest(value.sessionId, request)
        break
    }
    if (!isHostResponse(response)) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Controlled calculation host response is schema-invalid'
      )
    }
    return structuredClone(response)
  }

  async prepareCalculation(input: PrepareCalculationInput): Promise<PreparedControlledCalculation> {
    if (input.engine !== 'xtb' || input.method !== 'GFN2-xTB') {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Historical native optimization plans are inspectable but cannot be prepared or executed'
      )
    }
    const executable = this.executables.get(input.engine)
    if (!executable) {
      throw new IpcError(chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE, `${input.engine} runtime is not configured`)
    }
    const document = await application.get('MoleculeWorkspaceService').getMoleculeDocument()
    if (
      document.documentId !== input.documentId ||
      document.revision !== input.expectedRevision ||
      moleculeGeometryHash(document) !== input.geometryHash
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Prepared calculation input does not match the committed molecule'
      )
    }
    const settings = structuredClone(input.settings)
    if (settings.solvent) settings.solvent = settings.solvent.trim().toLowerCase()
    if (
      settings.charge !== (document.properties.charge ?? 0) ||
      settings.multiplicity !== (document.properties.multiplicity ?? 1)
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'The controlled method, charge, and multiplicity must match the committed molecule'
      )
    }
    const createdAt = new Date().toISOString()
    const planWithoutDigest = {
      type: 'prepared_controlled_calculation' as const,
      planId: `plan-${randomUUID()}`,
      binding: {
        sessionId: input.sessionId,
        documentId: document.documentId,
        expectedRevision: document.revision,
        geometryHash: moleculeGeometryHash(document)
      },
      engine: input.engine,
      method: input.method,
      settings,
      settingsDigest: digestJson(settings),
      executable: structuredClone(executable),
      createdAt,
      expiresAt: new Date(Date.now() + PLAN_LIFETIME_MS).toISOString(),
      extensions: {}
    }
    const plan: PreparedControlledCalculation = {
      ...planWithoutDigest,
      planDigest: digestJson(preparedPlanDigestPayload(planWithoutDigest)),
      state: 'prepared'
    }
    this.assertPreparedPlan(plan)
    await this.writePlan(plan)
    this.plans.set(plan.planId, plan)
    return structuredClone(plan)
  }

  async validateCalculation(planId: string, planDigest: string): Promise<PreparedControlledCalculation> {
    const plan = this.requirePlan(planId, planDigest)
    await this.assertCurrentBinding(plan)
    const validated: PreparedControlledCalculation = { ...plan, state: 'validated' }
    this.assertPreparedPlan(validated)
    await this.writePlan(validated)
    this.plans.set(planId, validated)
    return structuredClone(validated)
  }

  async reserveCalculation(planId: string, planDigest: string): Promise<ControlledCalculationReservation> {
    const plan = this.requirePlan(planId, planDigest)
    if (plan.state !== 'validated') {
      throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED, 'Calculation plan has not been validated')
    }
    if (this.reservationPending || [...this.runs.values()].some((run) => run.terminal === null)) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Another controlled calculation is active')
    }
    this.reservationPending = true
    try {
      const document = await this.assertCurrentBinding(plan)
      const reservation: ControlledCalculationReservation = {
        type: 'controlled_calculation_reservation',
        runId: `run-${randomUUID()}`,
        planId: plan.planId,
        planDigest: plan.planDigest,
        binding: structuredClone(plan.binding),
        executable: structuredClone(plan.executable),
        reservedAt: new Date().toISOString(),
        extensions: {}
      }
      if (!isReservation(reservation)) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation reservation is schema-invalid')
      }
      const run: ControlledRunState = {
        reservation,
        document: structuredClone(document),
        atomIds: document.atoms.map((atom) => atom.id),
        atomicNumbers: document.atoms.map((atom) => atom.atomicNumber),
        frames: [],
        terminal: null,
        executionPending: false,
        executionPromise: null,
        abortController: null,
        started: false,
        trajectoryOpened: false,
        trajectoryClosed: false,
        trajectoryFrameCount: 0,
        hostTerminalPersisted: false,
        manifestClaimed: false,
        mutationLocked: false,
        ledgerIdentity: await this.appendLedgerRecord(reservation.runId, reservation),
        recoveredFromDisk: false
      }
      this.runs.set(reservation.runId, run)
      return structuredClone(reservation)
    } finally {
      this.reservationPending = false
    }
  }

  async executeReservedCalculation(
    reservation: ControlledCalculationReservation,
    adapter: CalculationExecutionAdapter
  ): Promise<ControlledCalculationTerminal> {
    const run = this.requireRun(reservation.runId)
    if (canonicalJson(run.reservation) !== canonicalJson(reservation)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation reservation identity is inconsistent')
    }
    if (adapter.kind !== 'fake' && !this.trustedLocalAdapters.has(adapter)) {
      throw new IpcError(
        chemsmartStudioErrorCodes.APPROVAL_REQUIRED,
        'The local execution adapter was not issued by the trusted calculation runtime'
      )
    }
    if (run.executionPending || run.started || run.terminal) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Controlled calculation execution already started')
    }
    run.executionPending = true

    try {
      const plan = this.requirePlan(reservation.planId, reservation.planDigest)
      if (!run.document) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation cannot execute again')
      }
      const runDocument = run.document
      if (plan.state !== 'validated') {
        throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED, 'Controlled calculation plan is not validated')
      }
      await this.prepareSidecarRun(plan, run, runDocument)
      run.started = true
      const startedEvent = {
        plan: structuredClone(plan),
        reservation: structuredClone(reservation),
        document: structuredClone(runDocument)
      }
      application.get('StudioControlService').commitControlledRunStart(startedEvent)
      this.runStartedEmitter.fire(startedEvent)
      let terminal: ControlledCalculationTerminal | null = null
      for await (const event of adapter.execute(structuredClone(reservation))) {
        if (terminal) {
          throw new IpcError(
            chemsmartStudioErrorCodes.SCHEMA_INVALID,
            'Calculation adapter emitted data after its terminal record'
          )
        }
        if (event.type === 'controlled_calculation_frame') await this.appendFrame(event)
        else terminal = event
      }
      if (!terminal) {
        throw new IpcError(
          chemsmartStudioErrorCodes.SCHEMA_INVALID,
          'Calculation adapter ended without a terminal record'
        )
      }
      if (adapter.getArtifactSources) {
        await this.registerExecutionArtifacts(run, adapter.getArtifactSources())
      }
      await this.recordTerminal(terminal)
      return structuredClone(terminal)
    } catch (error) {
      if (!run.terminal) {
        const code = error instanceof IpcError ? error.code : 'ADAPTER_FAILED'
        const terminal: ControlledCalculationTerminal = {
          type: 'controlled_calculation_terminal',
          runId: reservation.runId,
          status: 'failed',
          frameCount: run.frames.length,
          error: {
            code: /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'ADAPTER_FAILED',
            message: error instanceof Error ? error.message.slice(0, 1024) : 'Calculation adapter failed'
          },
          terminatedAt: new Date().toISOString(),
          extensions: {}
        }
        await this.recordTerminal(terminal)
      }
      throw error
    } finally {
      run.executionPending = false
    }
  }

  getRunSnapshot(runId: string): ControlledCalculationRunSnapshot {
    const run = this.requireRun(runId)
    return structuredClone({
      reservation: run.reservation,
      frameCount: run.frames.length,
      latestFrame: run.frames.at(-1) ?? null,
      terminal: run.terminal
    })
  }

  getRecoverableFinalDecisions(): ControlledCalculationRecoveryCandidate[] {
    const candidates: ControlledCalculationRecoveryCandidate[] = []
    for (const run of this.runs.values()) {
      const latestFrame = run.frames.at(-1)
      const terminal = run.terminal
      const plan = this.plans.get(run.reservation.planId)
      if (
        !run.recoveredFromDisk ||
        !plan ||
        !latestFrame ||
        terminal?.status !== 'completed' ||
        terminal.outputGeometryHash !== latestFrame.structureHash
      ) {
        continue
      }
      candidates.push({
        plan: structuredClone(plan),
        reservation: structuredClone(run.reservation),
        latestFrame: structuredClone(latestFrame),
        terminal: structuredClone(terminal)
      })
    }
    return candidates.sort((left, right) =>
      left.reservation.runId < right.reservation.runId ? -1 : left.reservation.runId > right.reservation.runId ? 1 : 0
    )
  }

  async cancelCalculation(runId: string): Promise<ControlledCalculationTerminal> {
    const run = this.requireRun(runId)
    if (run.terminal) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'Controlled calculation is already terminal')
    }
    if (!run.abortController || !run.executionPromise) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Controlled calculation cannot be cancelled yet')
    }
    run.abortController.abort()
    await run.executionPromise.catch(() => undefined)
    const terminal = this.requireRun(runId).terminal
    if (terminal?.status !== 'cancelled') {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Controlled calculation did not cancel cleanly')
    }
    return structuredClone(terminal)
  }

  async acceptFinalGeometry(runId: string, expectedRevision: number): Promise<OptimizationFinalCommit> {
    const { run, latestFrame } = await this.requireAwaitingFinalGeometry(runId, expectedRevision)
    const requested: OptimizationFinalDecisionEvent = {
      type: 'optimization_final_accept_requested',
      runId,
      expectedRevision,
      geometryHash: latestFrame.structureHash,
      timestamp: new Date().toISOString()
    }
    await this.recordFinalDecisionEvent(requested)

    let document: MoleculeDocument
    try {
      const current = application.get('MoleculeDocumentService').getDocument()
      document = await application.get('MoleculeDocumentService').commitFinalGeometry(
        runId,
        {
          documentId: current.documentId,
          atoms: current.atoms.map((atom, index) => ({
            ...atom,
            position: latestFrame.positions[index]
          }))
        },
        expectedRevision
      )
    } catch (error) {
      await this.recordFinalDecisionFailure('accept', requested, error)
      throw error
    }

    if (document.revision !== expectedRevision + 1 || moleculeGeometryHash(document) !== latestFrame.structureHash) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Committed final geometry does not match the durable trajectory frame'
      )
    }
    const accepted: OptimizationFinalDecisionEvent = {
      type: 'optimization_final_accepted',
      runId,
      revision: document.revision,
      geometryHash: latestFrame.structureHash,
      timestamp: new Date().toISOString()
    }
    await this.recordFinalDecisionEvent(accepted)
    await this.releaseFinalDecisionOwnership(run)
    return {
      type: 'optimization_final_commit',
      runId,
      revision: document.revision,
      timestamp: accepted.timestamp,
      geometryHash: latestFrame.structureHash
    }
  }

  async rejectFinalGeometry(runId: string): Promise<OptimizationFinalRejected> {
    const run = this.requireRun(runId)
    const expectedRevision = run.reservation.binding.expectedRevision
    const { latestFrame } = await this.requireAwaitingFinalGeometry(runId, expectedRevision)
    const requested: OptimizationFinalDecisionEvent = {
      type: 'optimization_final_reject_requested',
      runId,
      expectedRevision,
      geometryHash: latestFrame.structureHash,
      timestamp: new Date().toISOString()
    }
    await this.recordFinalDecisionEvent(requested)
    const rejected: OptimizationFinalDecisionEvent = {
      type: 'optimization_final_rejected',
      runId,
      revision: expectedRevision,
      geometryHash: latestFrame.structureHash,
      timestamp: new Date().toISOString()
    }
    try {
      await this.recordFinalDecisionEvent(rejected)
      await this.releaseFinalDecisionOwnership(run)
    } catch (error) {
      await this.recordFinalDecisionFailure('reject', requested, error).catch(() => undefined)
      throw error
    }
    return {
      type: 'optimization_final_rejected',
      runId,
      revision: expectedRevision,
      timestamp: rejected.timestamp
    }
  }

  async recoverFinalDecision(
    candidate: ControlledCalculationRecoveryCandidate
  ): Promise<'not_active' | 'awaiting' | 'accepted' | 'rejected'> {
    const runId = candidate.reservation.runId
    const run = this.requireRun(runId)
    const projects = application.get('MoleculeProjectStore')
    const project = await projects.inspectProject(projects.getActiveProjectPath())
    if (project.manifest.activeRunId !== runId) return 'not_active'

    const request: OptimizationTrajectoryRunStateRequest = { runId }
    if (!isTrajectoryRunStateRequest(request)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory recovery request is schema-invalid')
    }
    const rawState = await application.get('ChemSmartAgentService').requestTrajectory('optimization.run_state', request)
    if (!isTrajectoryRunState(rawState)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory recovery state is schema-invalid')
    }
    const state = rawState
    if (
      state.run.runId !== runId ||
      state.run.documentId !== candidate.plan.binding.documentId ||
      state.run.inputRevision !== candidate.plan.binding.expectedRevision ||
      state.frameCount !== candidate.terminal.frameCount ||
      canonicalJson(state.latestFrame) !== canonicalJson(candidate.latestFrame) ||
      canonicalJson(state.terminal) !== canonicalJson(candidate.terminal)
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Trajectory recovery state disagrees with the execution ledger'
      )
    }

    const documents = application.get('MoleculeDocumentService')
    let current = documents.getDocument()
    const expectedRevision = candidate.plan.binding.expectedRevision
    const inputMatches =
      current.documentId === candidate.plan.binding.documentId &&
      current.revision === expectedRevision &&
      moleculeGeometryHash(current) === candidate.plan.binding.geometryHash
    const acceptedMatches =
      current.documentId === candidate.plan.binding.documentId &&
      current.revision === expectedRevision + 1 &&
      moleculeGeometryHash(current) === candidate.latestFrame.structureHash
    const event = state.latestFinalEvent
    if (!event || event.type.endsWith('_failed')) {
      if (!inputMatches || state.outcome !== 'awaiting_final_geometry') {
        throw new IpcError(
          chemsmartStudioErrorCodes.REVISION_CONFLICT,
          'Awaiting final geometry no longer matches the canonical molecule'
        )
      }
      this.ensureRecoveredMutationLock(run, current)
      return 'awaiting'
    }

    if (event.type === 'optimization_final_accept_requested') {
      if (inputMatches) {
        this.ensureRecoveredMutationLock(run, current)
        current = await documents.commitFinalGeometry(
          runId,
          {
            documentId: current.documentId,
            atoms: current.atoms.map((atom, index) => ({
              ...atom,
              position: candidate.latestFrame.positions[index]
            }))
          },
          expectedRevision
        )
      } else if (acceptedMatches) {
        this.ensureRecoveredMutationLock(run, current)
      } else {
        throw new IpcError(
          chemsmartStudioErrorCodes.REVISION_CONFLICT,
          'Torn final acceptance does not match either durable geometry'
        )
      }
      await this.recordFinalDecisionEvent({
        type: 'optimization_final_accepted',
        runId,
        revision: expectedRevision + 1,
        geometryHash: candidate.latestFrame.structureHash,
        timestamp: new Date().toISOString()
      })
      await this.releaseFinalDecisionOwnership(run)
      return 'accepted'
    }

    if (event.type === 'optimization_final_reject_requested') {
      if (!inputMatches) {
        throw new IpcError(
          chemsmartStudioErrorCodes.REVISION_CONFLICT,
          'Torn final rejection no longer matches the input geometry'
        )
      }
      this.ensureRecoveredMutationLock(run, current)
      await this.recordFinalDecisionEvent({
        type: 'optimization_final_rejected',
        runId,
        revision: expectedRevision,
        geometryHash: candidate.latestFrame.structureHash,
        timestamp: new Date().toISOString()
      })
      await this.releaseFinalDecisionOwnership(run)
      return 'rejected'
    }

    if (event.type === 'optimization_final_accepted') {
      if (!acceptedMatches || state.outcome !== 'accepted') {
        throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Recovered final acceptance is inconsistent')
      }
      this.ensureRecoveredMutationLock(run, current)
      await this.releaseFinalDecisionOwnership(run)
      return 'accepted'
    }

    if (event.type === 'optimization_final_rejected') {
      if (!inputMatches || state.outcome !== 'rejected') {
        throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Recovered final rejection is inconsistent')
      }
      this.ensureRecoveredMutationLock(run, current)
      await this.releaseFinalDecisionOwnership(run)
      return 'rejected'
    }

    throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Final decision recovery event is unsupported')
  }

  private ensureRecoveredMutationLock(run: ControlledRunState, current: MoleculeDocument): void {
    const documents = application.get('MoleculeDocumentService')
    const owner = documents.getMutationLockOwner()
    if (owner !== null && owner !== run.reservation.runId) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Another run owns molecule mutation recovery')
    }
    if (owner === null) {
      documents.acquireMutationLock(run.reservation.runId, current.documentId, current.revision)
    }
    run.mutationLocked = true
  }

  private async requireAwaitingFinalGeometry(
    runId: string,
    expectedRevision: number
  ): Promise<{ run: ControlledRunState; latestFrame: ControlledCalculationExternalFrame }> {
    const run = this.requireRun(runId)
    const latestFrame = run.frames.at(-1)
    if (
      run.terminal?.status !== 'completed' ||
      !latestFrame ||
      run.terminal.outputGeometryHash !== latestFrame.structureHash ||
      run.reservation.binding.expectedRevision !== expectedRevision ||
      run.trajectoryOpened === false ||
      run.trajectoryClosed === false
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'Final optimization geometry is unavailable')
    }
    const current = application.get('MoleculeDocumentService').getDocument()
    const project = await application
      .get('MoleculeProjectStore')
      .inspectProject(application.get('MoleculeProjectStore').getActiveProjectPath())
    if (
      project.manifest.activeRunId !== runId ||
      current.documentId !== run.reservation.binding.documentId ||
      current.revision !== expectedRevision ||
      moleculeGeometryHash(current) !== run.reservation.binding.geometryHash ||
      application.get('MoleculeDocumentService').getMutationLockOwner() !== runId
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Final optimization geometry no longer matches the active molecule project'
      )
    }
    return { run, latestFrame }
  }

  private async recordFinalDecisionEvent(event: OptimizationFinalDecisionEvent): Promise<void> {
    const request: OptimizationTrajectoryRecordFinalEventRequest = { event: structuredClone(event) }
    if (!isTrajectoryFinalEventRequest(request)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Final decision event is schema-invalid')
    }
    const rawResponse = await application
      .get('ChemSmartAgentService')
      .requestTrajectory('optimization.record_final_event', request)
    if (!isTrajectoryFinalEventResponse(rawResponse) || canonicalJson(rawResponse.event) !== canonicalJson(event)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Final decision response is schema-invalid')
    }
  }

  private async recordFinalDecisionFailure(
    decision: 'accept' | 'reject',
    requested: Extract<
      OptimizationFinalDecisionEvent,
      { type: 'optimization_final_accept_requested' | 'optimization_final_reject_requested' }
    >,
    error: unknown
  ): Promise<void> {
    const candidateCode = error instanceof IpcError ? error.code : 'FINAL_DECISION_FAILED'
    await this.recordFinalDecisionEvent({
      type: decision === 'accept' ? 'optimization_final_accept_failed' : 'optimization_final_reject_failed',
      runId: requested.runId,
      expectedRevision: requested.expectedRevision,
      geometryHash: requested.geometryHash,
      timestamp: new Date().toISOString(),
      error: {
        code: /^[A-Z][A-Z0-9_]*$/.test(candidateCode) ? candidateCode : 'FINAL_DECISION_FAILED',
        message: error instanceof Error ? error.message.slice(0, 1024) : 'Final decision failed'
      }
    })
  }

  private async releaseFinalDecisionOwnership(run: ControlledRunState): Promise<void> {
    if (run.manifestClaimed) {
      await application.get('MoleculeProjectStore').releaseActiveRunId(run.reservation.runId)
      run.manifestClaimed = false
    }
    if (run.mutationLocked) {
      application.get('MoleculeDocumentService').releaseMutationLock(run.reservation.runId)
      run.mutationLocked = false
    }
  }

  private async getStudioContext(sessionId: string): Promise<StudioControlledCalculationContext> {
    const document = await application.get('MoleculeWorkspaceService').getMoleculeDocument()
    const active = [...this.runs.values()].find(
      (run) => run.reservation.binding.sessionId === sessionId && run.terminal === null
    )
    return {
      type: 'studio_context',
      sessionId,
      document: {
        documentId: document.documentId,
        revision: document.revision,
        geometryHash: moleculeGeometryHash(document)
      },
      activeRun: active
        ? {
            runId: active.reservation.runId,
            state: active.started ? 'running' : 'reserved',
            frameCount: active.frames.length
          }
        : null,
      extensions: {}
    }
  }

  private async analyzeCurrentMolecule(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): Promise<CurrentMoleculeAnalysis> {
    const argumentsValue = request.arguments as { expected_revision?: number; geometry_hash?: string }
    const document = await application.get('MoleculeWorkspaceService').getMoleculeDocument()
    if (
      argumentsValue.expected_revision !== undefined &&
      (document.revision !== argumentsValue.expected_revision ||
        moleculeGeometryHash(document) !== argumentsValue.geometry_hash)
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Molecule analysis binding is stale')
    }
    if (!sessionId) throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Session identity is missing')
    return currentMoleculeAnalysis(document)
  }

  private prepareFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): Promise<PreparedControlledCalculation> {
    const argumentsValue = request.arguments as {
      document_id: string
      expected_revision: number
      geometry_hash: string
      engine: PreparedControlledCalculation['engine']
      method: string
      settings: ControlledCalculationSettings
    }
    return this.prepareCalculation({
      sessionId,
      documentId: argumentsValue.document_id,
      expectedRevision: argumentsValue.expected_revision,
      geometryHash: argumentsValue.geometry_hash,
      engine: argumentsValue.engine,
      method: argumentsValue.method,
      settings: argumentsValue.settings
    })
  }

  private async validateFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): Promise<PreparedControlledCalculation> {
    const argumentsValue = request.arguments as { plan_id: string; plan_digest: string }
    const existing = this.requirePlan(argumentsValue.plan_id, argumentsValue.plan_digest)
    this.assertSessionBinding(sessionId, existing.binding.sessionId)
    const plan = await this.validateCalculation(argumentsValue.plan_id, argumentsValue.plan_digest)
    this.assertSessionBinding(sessionId, plan.binding.sessionId)
    return plan
  }

  private async startFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): Promise<ControlledCalculationReservation> {
    const argumentsValue = request.arguments as { plan_id: string; plan_digest: string }
    const plan = this.requirePlan(argumentsValue.plan_id, argumentsValue.plan_digest)
    this.assertSessionBinding(sessionId, plan.binding.sessionId)
    if (plan.engine !== 'xtb' || plan.method !== 'GFN2-xTB') {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Historical native optimization plans are unsupported for execution'
      )
    }
    const localRuntime = this.xtbRuntime
    if (!this.fakeExecutionAdapter && !localRuntime) {
      throw new IpcError(
        chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE,
        'No trusted controlled execution runtime is configured'
      )
    }
    application
      .get('StudioControlService')
      .consumePreparedCalculationGrant(sessionId, argumentsValue.plan_id, argumentsValue.plan_digest)
    const reservation = await this.reserveCalculation(argumentsValue.plan_id, argumentsValue.plan_digest)
    const run = this.requireRun(reservation.runId)
    const abortController = this.fakeExecutionAdapter ? null : new AbortController()
    const adapter =
      this.fakeExecutionAdapter ??
      new XtbCalculationAdapter({
        calculationsRoot: application.getPath('feature.chemsmart_studio.calculations'),
        document: run.document!,
        plan,
        reservation,
        runtime: localRuntime!,
        signal: abortController!.signal
      })
    if (adapter.kind !== 'fake') this.trustedLocalAdapters.add(adapter)
    run.abortController = abortController
    const execution = this.executeReservedCalculation(reservation, adapter)
    run.executionPromise = execution
    void execution
      .catch((error) => {
        logger.warn('Controlled calculation ended with a recorded failure', {
          runId: reservation.runId,
          error: error instanceof Error ? error.message : 'unknown failure'
        })
      })
      .finally(() => {
        run.executionPromise = null
        run.abortController = null
      })
    return reservation
  }

  private statusFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): ControlledCalculationStatus {
    const { run_id: runId } = request.arguments as { run_id: string }
    const run = this.requireSessionRun(sessionId, runId)
    const latest = run.frames.at(-1)
    const state = run.terminal?.status ?? (run.started ? 'running' : 'reserved')
    return {
      type: 'controlled_calculation_status',
      reservation: structuredClone(run.reservation),
      state,
      frameCount: run.frames.length,
      latestFrame: latest
        ? {
            frameIndex: latest.frameIndex,
            engineStepIndex: latest.engineStepIndex,
            energy: latest.energy,
            ...(latest.forceMetrics ? { forceMetrics: latest.forceMetrics } : {}),
            ...(latest.gradientNorm ? { gradientNorm: latest.gradientNorm } : {}),
            structureHash: latest.structureHash,
            timestamp: latest.timestamp
          }
        : null,
      terminal: structuredClone(run.terminal),
      extensions: {}
    }
  }

  private async listArtifactsFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): Promise<ControlledCalculationArtifactList> {
    const {
      run_id: runId,
      after_artifact_id: afterArtifactId,
      limit
    } = request.arguments as {
      run_id: string
      after_artifact_id: string | null
      limit: number
    }
    const run = this.requireSessionRun(sessionId, runId)
    const ledgerArtifactId = `${runId}:ledger`
    const filePath = this.ledgerPath(runId)
    const { data } = await this.readOwnedFile(filePath, run.ledgerIdentity)
    const ledgerArtifact: ControlledCalculationArtifact = {
      type: 'opaque_calculation_artifact',
      artifactId: ledgerArtifactId,
      runId,
      kind: 'log',
      displayName: 'Calculation ledger',
      mediaType: 'application/x-ndjson',
      sizeBytes: data.byteLength,
      sha256: `sha256:${createHash('sha256').update(data).digest('hex')}`,
      createdAt: run.reservation.reservedAt,
      extensions: {}
    }
    this.artifacts.set(ledgerArtifactId, { artifact: ledgerArtifact, filePath, identity: run.ledgerIdentity })

    const available = [...this.artifacts.values()]
      .filter(({ artifact }) => artifact.runId === runId)
      .sort((left, right) => {
        if (left.artifact.artifactId === ledgerArtifactId) return -1
        if (right.artifact.artifactId === ledgerArtifactId) return 1
        return left.artifact.artifactId < right.artifact.artifactId ? -1 : 1
      })
    const cursorIndex =
      afterArtifactId === null ? -1 : available.findIndex(({ artifact }) => artifact.artifactId === afterArtifactId)
    if (afterArtifactId !== null && cursorIndex < 0) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'The artifact cursor was not found')
    }
    const page = available.slice(cursorIndex + 1, cursorIndex + 1 + limit)
    const hasMore = cursorIndex + 1 + page.length < available.length
    return {
      type: 'controlled_calculation_artifact_list',
      runId,
      artifacts: page.map(({ artifact }) => structuredClone(artifact)),
      nextAfterArtifactId: hasMore ? page.at(-1)!.artifact.artifactId : null,
      extensions: {}
    }
  }

  private async readArtifactFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): Promise<ControlledCalculationArtifactChunk> {
    const {
      artifact_id: artifactId,
      offset,
      max_bytes: maxBytes
    } = request.arguments as {
      artifact_id: string
      offset: number
      max_bytes: number
    }
    const registered = this.artifacts.get(artifactId)
    if (!registered) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'The requested calculation artifact was not found')
    }
    this.requireSessionRun(sessionId, registered.artifact.runId)
    const { data } = await this.readOwnedFile(registered.filePath, registered.identity)
    const currentDigest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (data.byteLength !== registered.artifact.sizeBytes || currentDigest !== registered.artifact.sha256) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'The calculation artifact changed after it was listed'
      )
    }
    const chunk = data.subarray(Math.min(offset, data.byteLength), Math.min(offset + maxBytes, data.byteLength))
    const utf8 = chunk.toString('utf8')
    const canRepresentAsUtf8 = Buffer.from(utf8, 'utf8').equals(chunk)
    return {
      artifact: structuredClone(registered.artifact),
      offset,
      encoding: canRepresentAsUtf8 ? 'utf8' : 'base64',
      content: canRepresentAsUtf8 ? utf8 : chunk.toString('base64'),
      eof: offset + chunk.byteLength >= data.byteLength,
      extensions: {}
    }
  }

  private replayFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): ControlledCalculationReplay {
    const { run_id: runId, offset, limit } = request.arguments as { run_id: string; offset: number; limit: number }
    const run = this.requireSessionRun(sessionId, runId)
    return {
      type: 'controlled_calculation_replay',
      runId,
      offset,
      limit,
      totalFrames: run.frames.length,
      frames: structuredClone(run.frames.slice(offset, offset + limit)),
      extensions: {}
    }
  }

  private compareFromHostRequest(
    sessionId: string,
    request: ControlledCalculationAgentToolRequest
  ): ControlledCalculationFrameComparison {
    const {
      run_id: runId,
      first_step_index: firstIndex,
      second_step_index: secondIndex
    } = request.arguments as {
      run_id: string
      first_step_index: number
      second_step_index: number
    }
    const run = this.requireSessionRun(sessionId, runId)
    const first = run.frames[firstIndex]
    const second = run.frames[secondIndex]
    if (!first || !second) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'Calculation frame was not found')
    }
    const squared = first.positions.map((position, index) => {
      const other = second.positions[index]
      return (position[0] - other[0]) ** 2 + (position[1] - other[1]) ** 2 + (position[2] - other[2]) ** 2
    })
    return {
      type: 'controlled_calculation_frame_comparison',
      runId,
      firstFrameIndex: firstIndex,
      secondFrameIndex: secondIndex,
      atomCount: squared.length,
      rmsDisplacement: Math.sqrt(squared.reduce((sum, value) => sum + value, 0) / squared.length),
      maxDisplacement: Math.sqrt(Math.max(...squared)),
      unit: 'angstrom',
      firstGeometryHash: first.structureHash,
      secondGeometryHash: second.structureHash,
      extensions: {}
    }
  }

  private requireSessionRun(sessionId: string, runId: string): ControlledRunState {
    const run = this.requireRun(runId)
    this.assertSessionBinding(sessionId, run.reservation.binding.sessionId)
    return run
  }

  private assertSessionBinding(actual: string, expected: string): void {
    if (actual !== expected) {
      throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Controlled calculation session binding differs')
    }
  }

  private optimizationRun(
    plan: PreparedControlledCalculation,
    reservation: ControlledCalculationReservation,
    document: MoleculeDocument
  ): OptimizationRun {
    return {
      runId: reservation.runId,
      documentId: reservation.binding.documentId,
      inputRevision: reservation.binding.expectedRevision,
      engine: plan.engine,
      method: plan.method,
      settings: {
        maxSteps: plan.settings.maxSteps,
        charge: plan.settings.charge,
        multiplicity: plan.settings.multiplicity,
        ...(plan.settings.solvent ? { solvent: plan.settings.solvent } : {}),
        extensions: {}
      },
      frozenAtomIds: Object.keys(document.frozenAxes),
      constraintIds: document.constraints.map((constraint) => constraint.id),
      status: 'running',
      createdAt: reservation.reservedAt,
      extensions: {
        'chemsmart.controlled': {
          plan: structuredClone(plan),
          reservation: structuredClone(reservation)
        }
      }
    }
  }

  private async prepareSidecarRun(
    plan: PreparedControlledCalculation,
    run: ControlledRunState,
    document: MoleculeDocument
  ): Promise<void> {
    const reservation = run.reservation
    const documents = application.get('MoleculeDocumentService')
    documents.acquireMutationLock(
      reservation.runId,
      reservation.binding.documentId,
      reservation.binding.expectedRevision
    )
    run.mutationLocked = true

    const persistedSnapshot = { ...document, selections: [] }
    const request: OptimizationTrajectoryOpenRunRequest = {
      run: this.optimizationRun(plan, reservation, document),
      timestamp: reservation.reservedAt,
      inputSnapshotHash: digestJson(persistedSnapshot),
      inputTopologyHash: digestJson({
        documentId: document.documentId,
        atoms: document.atoms.map(({ id, atomicNumber }) => ({ id, atomicNumber })),
        bonds: document.bonds,
        frozenAxes: document.frozenAxes,
        constraints: document.constraints
      })
    }
    if (!isTrajectoryOpenRunRequest(request)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory run open request is schema-invalid')
    }
    const rawResponse = await application
      .get('ChemSmartAgentService')
      .requestTrajectory('optimization.open_run', request)
    run.trajectoryOpened = true
    if (!isTrajectoryOpenRunResponse(rawResponse) || rawResponse.runId !== reservation.runId) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory run open response is schema-invalid')
    }
    await application.get('MoleculeProjectStore').compareAndSetActiveRunId(null, reservation.runId)
    run.manifestClaimed = true
  }

  private async appendFrame(frame: ControlledCalculationExternalFrame): Promise<void> {
    if (!isExternalFrame(frame)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation frame is schema-invalid')
    }
    const run = this.requireRun(frame.runId)
    if (run.terminal) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Calculation run is already terminal')
    }
    const document = await this.assertCurrentReservationBinding(run.reservation)
    const expectedFrameIndex = run.frames.length
    const plan = this.requirePlan(run.reservation.planId, run.reservation.planDigest)
    const documentAtomIds = document.atoms.map((atom) => atom.id)
    const documentAtomicNumbers = document.atoms.map((atom) => atom.atomicNumber)
    if (
      frame.frameIndex !== expectedFrameIndex ||
      frame.engineStepIndex !== expectedFrameIndex ||
      expectedFrameIndex >= plan.settings.maxSteps ||
      !sameValues(frame.atomIds, run.atomIds) ||
      !sameValues(frame.atomicNumbers, run.atomicNumbers) ||
      !sameValues(frame.atomIds, documentAtomIds) ||
      !sameValues(frame.atomicNumbers, documentAtomicNumbers) ||
      frame.positions.length !== run.atomIds.length ||
      moleculeGeometryHash({
        ...document,
        atoms: document.atoms.map((atom, index) => ({ ...atom, position: frame.positions[index] }))
      }) !== frame.structureHash
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Calculation frame violates step, topology, coordinate, or geometry-hash invariants'
      )
    }
    if (!run.trajectoryOpened || run.trajectoryClosed) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory run is not open for frame writes')
    }
    const request: OptimizationTrajectoryAppendFrameRequest = { frame: structuredClone(frame) }
    if (!isTrajectoryAppendFrameRequest(request)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory frame request is schema-invalid')
    }
    const rawResponse = await application
      .get('ChemSmartAgentService')
      .requestTrajectory('optimization.append_run_frame', request)
    if (
      !isTrajectoryAppendFrameResponse(rawResponse) ||
      rawResponse.runId !== frame.runId ||
      rawResponse.frameIndex !== frame.frameIndex
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory frame response is schema-invalid')
    }
    run.trajectoryFrameCount += 1
    run.frames.push(structuredClone(frame))
    await this.appendLedgerRecord(frame.runId, frame, run.ledgerIdentity)
    this.frameCommittedEmitter.fire(structuredClone(frame))
  }

  private async recordTerminal(terminal: ControlledCalculationTerminal): Promise<void> {
    if (!isTerminal(terminal)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation terminal record is schema-invalid')
    }
    const run = this.requireRun(terminal.runId)
    if (run.terminal) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'Calculation run is already terminal')
    }
    const latestFrame = run.frames.at(-1)
    if (
      terminal.frameCount !== run.frames.length ||
      (terminal.status === 'completed' && terminal.outputGeometryHash !== latestFrame?.structureHash)
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.SCHEMA_INVALID,
        'Calculation terminal record disagrees with durable frames'
      )
    }
    if (run.trajectoryOpened && !run.trajectoryClosed) {
      if (terminal.frameCount !== run.trajectoryFrameCount) {
        throw new IpcError(
          chemsmartStudioErrorCodes.SCHEMA_INVALID,
          'Trajectory and host durable frame counts disagreed'
        )
      }
      const request: OptimizationTrajectoryCloseRunRequest = { terminal: structuredClone(terminal) }
      if (!isTrajectoryCloseRunRequest(request)) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory close request is schema-invalid')
      }
      const rawResponse = await application
        .get('ChemSmartAgentService')
        .requestTrajectory('optimization.close_run', request)
      const expectedOutcome = terminal.status === 'completed' ? 'awaiting_final_geometry' : terminal.status
      if (
        !isTrajectoryCloseRunResponse(rawResponse) ||
        rawResponse.runId !== terminal.runId ||
        rawResponse.outcome !== expectedOutcome
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Trajectory close response is schema-invalid')
      }
      run.trajectoryClosed = true
    }
    if (!run.hostTerminalPersisted) {
      await this.appendLedgerRecord(terminal.runId, terminal, run.ledgerIdentity)
      run.hostTerminalPersisted = true
    }
    run.terminal = structuredClone(terminal)
    if (terminal.status !== 'completed') {
      if (run.manifestClaimed) {
        await application.get('MoleculeProjectStore').releaseActiveRunId(terminal.runId)
        run.manifestClaimed = false
      }
      if (run.mutationLocked) {
        application.get('MoleculeDocumentService').releaseMutationLock(terminal.runId)
        run.mutationLocked = false
      }
    }
    this.terminalCommittedEmitter.fire(structuredClone(terminal))
  }

  private requirePlan(planId: string, planDigest: string): PreparedControlledCalculation {
    const plan = this.plans.get(planId)
    if (!plan) throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'Calculation plan was not found')
    if (plan.planDigest !== planDigest || plan.settingsDigest !== digestJson(plan.settings)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation plan digest is inconsistent')
    }
    if (digestJson(preparedPlanDigestPayload(plan)) !== plan.planDigest) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation plan content has changed')
    }
    return plan
  }

  private requireRun(runId: string): ControlledRunState {
    const run = this.runs.get(runId)
    if (!run) throw new IpcError(chemsmartStudioErrorCodes.RUN_NOT_FOUND, 'Controlled calculation run was not found')
    return run
  }

  private async assertCurrentBinding(plan: PreparedControlledCalculation): Promise<MoleculeDocument> {
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      throw new IpcError(chemsmartStudioErrorCodes.APPROVAL_REQUIRED, 'Calculation plan has expired')
    }
    const configured = this.executables.get(plan.engine)
    if (!configured || canonicalJson(configured) !== canonicalJson(plan.executable)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation executable identity has changed')
    }
    return this.assertCurrentReservationBinding({ binding: plan.binding })
  }

  private async assertCurrentReservationBinding(
    reservation: Pick<ControlledCalculationReservation, 'binding'>
  ): Promise<MoleculeDocument> {
    const document = await application.get('MoleculeWorkspaceService').getMoleculeDocument()
    if (
      document.documentId !== reservation.binding.documentId ||
      document.revision !== reservation.binding.expectedRevision ||
      moleculeGeometryHash(document) !== reservation.binding.geometryHash
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Committed molecule no longer matches the controlled calculation binding'
      )
    }
    return document
  }

  private assertPreparedPlan(plan: PreparedControlledCalculation): void {
    if (!isPreparedPlan(plan)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Prepared calculation plan is schema-invalid')
    }
  }

  private planPath(planId: string): string {
    return path.join(application.getPath('feature.chemsmart_studio.calculations'), 'plans', `${planId}.json`)
  }

  private ledgerPath(runId: string): string {
    return path.join(application.getPath('feature.chemsmart_studio.calculations'), runId, 'ledger.jsonl')
  }

  private async writePlan(plan: PreparedControlledCalculation): Promise<void> {
    const filePath = this.planPath(plan.planId)
    const calculationsRoot = application.getPath('feature.chemsmart_studio.calculations')
    await mkdir(calculationsRoot, { recursive: true, mode: 0o700 })
    await chmod(calculationsRoot, 0o700)
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    await chmod(path.dirname(filePath), 0o700)
    const file = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    )
    try {
      const fileStat = await file.stat()
      if (!fileStat.isFile()) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation plan is not a regular file')
      }
      await file.chmod(0o600)
      await file.writeFile(`${canonicalJson(plan)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
  }

  private async readRecoveryFile(
    filePath: string,
    maxSizeBytes: number
  ): Promise<{ data: string; identity: FileIdentity; sizeBytes: number }> {
    const calculationsRoot = await realpath(application.getPath('feature.chemsmart_studio.calculations'))
    const original = await lstat(filePath)
    if (!original.isFile() || original.isSymbolicLink()) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation file is unsafe')
    }
    const resolvedFile = await realpath(filePath)
    if (!isPathWithin(calculationsRoot, resolvedFile)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation file escaped ownership')
    }
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      const identity = { device: before.dev, inode: before.ino }
      if (
        before.dev !== original.dev ||
        before.ino !== original.ino ||
        !before.isFile() ||
        !isOwnedByCurrentUser(before.uid) ||
        (before.mode & 0o077) !== 0 ||
        before.size > maxSizeBytes
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation file is unsafe')
      }
      const buffer = Buffer.allocUnsafe(before.size + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      const after = await file.stat()
      if (
        after.dev !== identity.device ||
        after.ino !== identity.inode ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        bytesRead !== before.size
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation file changed while reading')
      }
      const data = buffer.subarray(0, bytesRead).toString('utf8')
      return { data, identity, sizeBytes: before.size }
    } finally {
      await file.close()
    }
  }

  private async recoverDurableRuns(): Promise<void> {
    const calculationsRoot = application.getPath('feature.chemsmart_studio.calculations')
    let rootStat
    try {
      rootStat = await lstat(calculationsRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !isOwnedByCurrentUser(rootStat.uid) ||
      (rootStat.mode & 0o077) !== 0
    ) {
      logger.warn('Skipped controlled-calculation recovery because the owned root is unsafe')
      return
    }
    const entries = await readdir(calculationsRoot, { withFileTypes: true })
    const runEntries = entries.filter((entry) => entry.name !== 'plans')
    if (runEntries.length > MAX_RECOVERED_RUNS) {
      logger.warn('Skipped controlled-calculation recovery because the run catalog is oversized')
      return
    }
    if (runEntries.length > 0) {
      const plansStat = await lstat(path.join(calculationsRoot, 'plans')).catch(() => null)
      if (
        !plansStat?.isDirectory() ||
        plansStat.isSymbolicLink() ||
        !isOwnedByCurrentUser(plansStat.uid) ||
        (plansStat.mode & 0o077) !== 0
      ) {
        logger.warn('Skipped controlled-calculation recovery because the plan catalog is unsafe')
        return
      }
    }
    let recoveredFrameCount = 0
    let recoveredBytes = 0
    for (const entry of runEntries) {
      if (recoveredFrameCount >= MAX_RECOVERED_FRAMES || recoveredBytes >= MAX_RECOVERY_TOTAL_BYTES) {
        logger.warn('Stopped controlled-calculation recovery at the aggregate memory bound')
        break
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.name)) {
        logger.warn('Skipped an unsafe controlled-calculation recovery entry')
        continue
      }
      try {
        const runStat = await lstat(path.join(calculationsRoot, entry.name))
        if (
          !runStat.isDirectory() ||
          runStat.isSymbolicLink() ||
          !isOwnedByCurrentUser(runStat.uid) ||
          (runStat.mode & 0o077) !== 0
        ) {
          throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation directory is unsafe')
        }
        const recovered = await this.recoverDurableRun(entry.name, {
          remainingBytes: MAX_RECOVERY_TOTAL_BYTES - recoveredBytes,
          remainingFrames: MAX_RECOVERED_FRAMES - recoveredFrameCount
        })
        recoveredBytes += recovered.bytesRead
        recoveredFrameCount += recovered.frameCount
      } catch (error) {
        logger.warn('Skipped an invalid controlled-calculation recovery record', {
          runId: entry.name,
          reason: error instanceof Error ? error.message : 'unknown'
        })
      }
    }
  }

  private async recoverDurableRun(
    runId: string,
    budget: { remainingBytes: number; remainingFrames: number }
  ): Promise<{ bytesRead: number; frameCount: number }> {
    const {
      data: ledgerData,
      identity: ledgerIdentity,
      sizeBytes: ledgerSizeBytes
    } = await this.readRecoveryFile(
      this.ledgerPath(runId),
      Math.min(MAX_RECOVERY_LEDGER_FILE_BYTES, budget.remainingBytes)
    )
    if (!ledgerData.endsWith('\n')) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation ledger is not durable')
    }
    const lines = ledgerData.slice(0, -1).split('\n')
    if (lines.length < 2 || lines.length > budget.remainingFrames + 2) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation ledger length is invalid')
    }
    const records = lines.map((line) => JSON.parse(line) as unknown)
    const reservation = records[0]
    const terminal = records.at(-1)
    const frames = records.slice(1, -1)
    if (!isReservation(reservation) || reservation.runId !== runId || !isTerminal(terminal)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation ledger envelope is invalid')
    }
    if (terminal.runId !== runId || terminal.frameCount !== frames.length) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation terminal identity is invalid')
    }
    const { data: planData, sizeBytes: planSizeBytes } = await this.readRecoveryFile(
      this.planPath(reservation.planId),
      Math.min(MAX_RECOVERY_PLAN_FILE_BYTES, budget.remainingBytes - ledgerSizeBytes)
    )
    const plan = JSON.parse(planData.trim()) as unknown
    if (
      !isPreparedPlan(plan) ||
      plan.state !== 'validated' ||
      plan.planId !== reservation.planId ||
      plan.planDigest !== reservation.planDigest ||
      plan.settingsDigest !== digestJson(plan.settings) ||
      plan.planDigest !== digestJson(preparedPlanDigestPayload(plan)) ||
      canonicalJson(plan.binding) !== canonicalJson(reservation.binding) ||
      canonicalJson(plan.executable) !== canonicalJson(reservation.executable)
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation plan binding is invalid')
    }
    const verifiedFrames: ControlledCalculationExternalFrame[] = []
    for (const [index, value] of frames.entries()) {
      if (
        !isExternalFrame(value) ||
        value.runId !== runId ||
        value.frameIndex !== index ||
        value.engineStepIndex !== index ||
        value.positions.length !== value.atomIds.length ||
        value.atomicNumbers.length !== value.atomIds.length ||
        value.structureHash !== frameGeometryHash(value) ||
        (verifiedFrames.length > 0 &&
          (!sameValues(value.atomIds, verifiedFrames[0].atomIds) ||
            !sameValues(value.atomicNumbers, verifiedFrames[0].atomicNumbers)))
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation frame is invalid')
      }
      verifiedFrames.push(structuredClone(value))
    }
    const latestFrame = verifiedFrames.at(-1)
    if (
      verifiedFrames.length > plan.settings.maxSteps ||
      (terminal.status === 'completed' && terminal.outputGeometryHash !== latestFrame?.structureHash)
    ) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation frame parity is invalid')
    }
    const existingPlan = this.plans.get(plan.planId)
    if (existingPlan && canonicalJson(existingPlan) !== canonicalJson(plan)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Recovered calculation plan identity is ambiguous')
    }
    this.plans.set(plan.planId, structuredClone(plan))
    this.runs.set(runId, {
      reservation: structuredClone(reservation),
      document: null,
      atomIds: latestFrame?.atomIds.slice() ?? [],
      atomicNumbers: latestFrame?.atomicNumbers.slice() ?? [],
      frames: verifiedFrames,
      terminal: structuredClone(terminal),
      executionPending: false,
      executionPromise: null,
      abortController: null,
      started: true,
      trajectoryOpened: true,
      trajectoryClosed: true,
      trajectoryFrameCount: verifiedFrames.length,
      hostTerminalPersisted: true,
      manifestClaimed: true,
      mutationLocked: false,
      ledgerIdentity,
      recoveredFromDisk: true
    })
    return { bytesRead: ledgerSizeBytes + planSizeBytes, frameCount: verifiedFrames.length }
  }

  private async appendLedgerRecord(
    runId: string,
    record: unknown,
    expectedIdentity?: FileIdentity
  ): Promise<FileIdentity> {
    const filePath = this.ledgerPath(runId)
    const calculationsRoot = application.getPath('feature.chemsmart_studio.calculations')
    await mkdir(calculationsRoot, { recursive: true, mode: 0o700 })
    await chmod(calculationsRoot, 0o700)
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    await chmod(path.dirname(filePath), 0o700)
    const flags =
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      (expectedIdentity ? 0 : constants.O_CREAT | constants.O_EXCL)
    const file = await open(filePath, flags, 0o600)
    try {
      const fileStat = await file.stat()
      const identity = { device: fileStat.dev, inode: fileStat.ino }
      if (
        !fileStat.isFile() ||
        (expectedIdentity && (identity.device !== expectedIdentity.device || identity.inode !== expectedIdentity.inode))
      ) {
        throw new IpcError(
          chemsmartStudioErrorCodes.SCHEMA_INVALID,
          'Calculation ledger ownership changed unexpectedly'
        )
      }
      await file.chmod(0o600)
      await file.writeFile(`${canonicalJson(record)}\n`, 'utf8')
      await file.sync()
      return identity
    } finally {
      await file.close()
    }
  }

  private async readOwnedFile(
    filePath: string,
    expectedIdentity: FileIdentity
  ): Promise<{ data: Buffer; identity: FileIdentity }> {
    const calculationsRoot = await realpath(application.getPath('feature.chemsmart_studio.calculations'))
    const resolvedFile = await realpath(filePath)
    const relativePath = path.relative(calculationsRoot, resolvedFile)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact escaped its owned root')
    }
    const file = await open(resolvedFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      const identity = { device: before.dev, inode: before.ino }
      if (
        !before.isFile() ||
        identity.device !== expectedIdentity.device ||
        identity.inode !== expectedIdentity.inode ||
        before.size > MAX_ARTIFACT_SIZE_BYTES
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact identity is invalid')
      }
      const data = await file.readFile()
      const after = await file.stat()
      if (
        after.dev !== identity.device ||
        after.ino !== identity.inode ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        data.byteLength !== before.size
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact changed while reading')
      }
      return { data, identity }
    } finally {
      await file.close()
    }
  }

  private async registerExecutionArtifacts(
    run: ControlledRunState,
    sources: CalculationArtifactSource[]
  ): Promise<void> {
    if (sources.length === 0) return
    if (sources.length > 32) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation produced too many artifacts')
    }
    const calculationsRoot = await realpath(application.getPath('feature.chemsmart_studio.calculations'))
    const enginePath = path.join(calculationsRoot, run.reservation.runId, 'engine')
    const engineStat = await lstat(enginePath)
    if (!engineStat.isDirectory() || engineStat.isSymbolicLink()) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact root is invalid')
    }
    const engineRoot = await realpath(enginePath)
    if (!isPathWithin(calculationsRoot, engineRoot)) {
      throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact root escaped ownership')
    }
    const pending: RegisteredArtifact[] = []
    const artifactIds = new Set<string>()
    for (const source of sources) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(source.key) ||
        !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(source.displayName) ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(source.mediaType)
      ) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact metadata is invalid')
      }
      const sourceStat = await lstat(source.filePath)
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact is not an owned file')
      }
      const resolvedFile = await realpath(source.filePath)
      if (!isPathWithin(engineRoot, resolvedFile)) {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact escaped its engine root')
      }
      const file = await open(resolvedFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await file.stat()
        if (!before.isFile() || before.size > MAX_ARTIFACT_SIZE_BYTES) {
          throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact is invalid')
        }
        const data = await file.readFile()
        const after = await file.stat()
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          data.byteLength !== before.size
        ) {
          throw new IpcError(
            chemsmartStudioErrorCodes.SCHEMA_INVALID,
            'Calculation artifact changed during registration'
          )
        }
        const artifactId = `${run.reservation.runId}:${source.key}`
        if (artifactIds.has(artifactId) || this.artifacts.has(artifactId)) {
          throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact identity is duplicated')
        }
        const artifact: ControlledCalculationArtifact = {
          type: 'opaque_calculation_artifact',
          artifactId,
          runId: run.reservation.runId,
          kind: source.kind,
          displayName: source.displayName,
          mediaType: source.mediaType,
          sizeBytes: data.byteLength,
          sha256: `sha256:${createHash('sha256').update(data).digest('hex')}`,
          createdAt: new Date().toISOString(),
          extensions: {}
        }
        if (!isOpaqueArtifact(artifact)) {
          throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Calculation artifact is schema-invalid')
        }
        artifactIds.add(artifactId)
        pending.push({
          artifact,
          filePath: resolvedFile,
          identity: { device: before.dev, inode: before.ino }
        })
      } finally {
        await file.close()
      }
    }
    for (const registered of pending) this.artifacts.set(registered.artifact.artifactId, registered)
  }

  protected async onInit(): Promise<void> {
    await this.recoverDurableRuns()
    if (isControlledCalculationTestHarnessEnabled(app.isPackaged)) {
      this.configureExecutable({
        kind: 'local_executable',
        engine: 'xtb',
        version: 'deterministic-test-harness',
        architecture: process.arch,
        executableDigest: `sha256:${'0'.repeat(64)}`,
        runtimeFingerprint: `sha256:${'1'.repeat(64)}`,
        libraries: [],
        verifiedAt: new Date().toISOString()
      })
      this.configureFakeExecutionAdapter({
        kind: 'fake',
        execute: (reservation) => this.executeControlledCalculationTestHarness(reservation)
      })
      logger.info('Configured deterministic controlled-calculation test harness')
      return
    }
    const executablePath = process.env.CHEMSMART_STUDIO_XTB_EXECUTABLE?.trim()
    const parameterDirectory = process.env.CHEMSMART_STUDIO_XTB_PATH?.trim()
    if (!executablePath) return
    try {
      const identity = await this.configureLocalXtbRuntime(executablePath, parameterDirectory || undefined)
      logger.info('Configured local xTB runtime', {
        architecture: identity.architecture,
        resourceCount: identity.resources?.length ?? 0,
        runtimeFingerprint: identity.runtimeFingerprint,
        version: identity.version
      })
    } catch {
      logger.warn('Configured local xTB runtime is unavailable')
    }
  }

  private async *executeControlledCalculationTestHarness(
    reservation: ControlledCalculationReservation
  ): AsyncIterable<ControlledCalculationExternalFrame | ControlledCalculationTerminal> {
    const document = await application.get('MoleculeWorkspaceService').getMoleculeDocument()
    if (
      document.documentId !== reservation.binding.documentId ||
      document.revision !== reservation.binding.expectedRevision ||
      moleculeGeometryHash(document) !== reservation.binding.geometryHash
    ) {
      throw new IpcError(
        chemsmartStudioErrorCodes.REVISION_CONFLICT,
        'Deterministic test harness molecule binding is stale'
      )
    }
    const timestamp = new Date().toISOString()
    yield {
      type: 'controlled_calculation_frame',
      runId: reservation.runId,
      frameIndex: 0,
      engineStepIndex: 0,
      atomIds: document.atoms.map((atom) => atom.id),
      atomicNumbers: document.atoms.map((atom) => atom.atomicNumber),
      positions: document.atoms.map((atom) => atom.position),
      coordinateUnit: 'angstrom',
      provenance: {
        coordinateSource: 'engine',
        atomOrder: 'document_stable_id_order',
        transformation: 'none'
      },
      energy: { value: 0, unit: 'hartree' },
      gradientNorm: { value: 0, unit: 'hartree/bohr' },
      structureHash: reservation.binding.geometryHash,
      timestamp,
      extensions: {}
    }
    yield {
      type: 'controlled_calculation_terminal',
      runId: reservation.runId,
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: reservation.binding.geometryHash,
      completedAt: timestamp,
      extensions: {}
    }
  }

  protected async onStop(): Promise<void> {
    for (const run of this.runs.values()) run.abortController?.abort()
    await Promise.all(
      [...this.runs.values()]
        .map((run) => run.executionPromise)
        .filter((execution): execution is Promise<ControlledCalculationTerminal> => execution !== null)
        .map((execution) => execution.catch(() => undefined))
    )
    for (const run of this.runs.values()) {
      if (run.terminal) continue
      await this.recordTerminal({
        type: 'controlled_calculation_terminal',
        runId: run.reservation.runId,
        status: 'cancelled',
        frameCount: run.frames.length,
        reason: 'Studio calculation runtime stopped',
        terminatedAt: new Date().toISOString(),
        extensions: {}
      })
    }
  }
}
