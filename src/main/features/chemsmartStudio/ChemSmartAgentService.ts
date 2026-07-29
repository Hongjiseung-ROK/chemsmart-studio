import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import {
  type CommandInspectionRequest,
  type CommandInspectionResult,
  commandInspectionRuntimeSchema,
  type CommandSynthesisRequest,
  type CommandSynthesisResult,
  commandSynthesisRuntimeSchema,
  type ControlledCalculationHostRequest,
  type MoleculeDocument,
  type MoleculeImportChunkRequest,
  type MoleculeImportChunkResponse,
  type MoleculeImportRequest,
  type MoleculeImportResult,
  moleculeImportRuntimeSchema,
  type ProjectWorkspaceCritiqueRequest,
  type ProjectWorkspaceCritiqueResult,
  type ProjectWorkspaceListRequest,
  type ProjectWorkspaceListResult,
  type ProjectWorkspaceReadRequest,
  type ProjectWorkspaceReadResult,
  projectWorkspaceRuntimeSchema,
  type ProjectWorkspaceValidateRequest,
  type ProjectWorkspaceValidateResult,
  type StudioAgentAnswer,
  type StudioAgentComposerIntent,
  type StudioAgentReportResultInput,
  type StudioAgentTraceEvent,
  type StudioAgentTurnOutcome,
  studioAgentWorkbenchRuntimeSchema,
  type StudioUiEvent
} from '@chemsmart/studio-protocol'
import { modelService } from '@data/services/ModelService'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { parseUniqueModelId, type UniqueModelId } from '@shared/data/types/model'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { ChemSmartStudioProcessStatus } from '@shared/ipc/schemas/chemsmartStudio'
import type { WindowId } from '@shared/ipc/types'
import { app } from 'electron'

import {
  controlledCalculationTestModelId,
  controlledCalculationTestModelResponse,
  e7XtbTestModelId,
  e7XtbTestModelResponse,
  isControlledCalculationTestHarnessEnabled,
  isE7XtbTestHarnessEnabled,
  isMoleculePreviewTestHarnessEnabled,
  moleculePreviewTestModelId,
  moleculePreviewTestModelResponse
} from './controlledCalculationTestHarness'
import { JsonRpcFault } from './JsonRpcPeer'
import { LocalRpcProcess } from './LocalRpcProcess'
import { validateImportFile } from './projectFiles'
import { StudioAgentTraceChannel } from './StudioAgentTraceChannel'
import { generateStudioModelResponse } from './StudioModelAdapter'
import { type StudioUiDelivery, StudioUiEventChannel } from './StudioUiEventChannel'

const logger = loggerService.withContext('ChemSmartAgentService')
const commandInspectionValidator = new CfWorkerJsonSchemaValidator({
  draft: '2020-12',
  shortcircuit: false
}).getValidator<CommandInspectionResult>({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: commandInspectionRuntimeSchema.$defs,
  $ref: '#/$defs/result'
} as JsonSchemaType)
const runtimeValidator = new CfWorkerJsonSchemaValidator({
  draft: '2020-12',
  shortcircuit: false
})
const definitionValidator = <Output>(runtimeSchema: { $defs: object }, definition: string) =>
  runtimeValidator.getValidator<Output>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: runtimeSchema.$defs,
    $ref: `#/$defs/${definition}`
  } as JsonSchemaType)
const commandSynthesisResultValidator = definitionValidator<CommandSynthesisResult>(
  commandSynthesisRuntimeSchema,
  'result'
)
const projectListResultValidator = definitionValidator<ProjectWorkspaceListResult>(
  projectWorkspaceRuntimeSchema,
  'listResult'
)
const projectReadResultValidator = definitionValidator<ProjectWorkspaceReadResult>(
  projectWorkspaceRuntimeSchema,
  'readResult'
)
const projectValidateResultValidator = definitionValidator<ProjectWorkspaceValidateResult>(
  projectWorkspaceRuntimeSchema,
  'validateResult'
)
const projectCritiqueResultValidator = definitionValidator<ProjectWorkspaceCritiqueResult>(
  projectWorkspaceRuntimeSchema,
  'critiqueResult'
)
const moleculeImportRequestValidator = definitionValidator<MoleculeImportRequest>(
  moleculeImportRuntimeSchema,
  'importRequest'
)
const moleculeImportChunkRequestValidator = definitionValidator<MoleculeImportChunkRequest>(
  moleculeImportRuntimeSchema,
  'chunkRequest'
)
const moleculeImportChunkResponseValidator = definitionValidator<MoleculeImportChunkResponse>(
  moleculeImportRuntimeSchema,
  'chunkResponse'
)
const moleculeImportResultValidator = definitionValidator<MoleculeImportResult>(
  moleculeImportRuntimeSchema,
  'importResult'
)
const studioAgentReportResultValidator = definitionValidator<StudioAgentReportResultInput>(
  studioAgentWorkbenchRuntimeSchema,
  'reportStudioResultInput'
)

/** Project reads are local, but retain the existing bounded sidecar envelope. */
const PROJECT_WORKSPACE_TIMEOUT_MS = 120_000
/** The sidecar waits 120 s for the provider and allows 10 s for its nested RPC response. */
const SIDECAR_MODEL_DEADLINE_MS = 120_000 + 10_000
/** The outer request must never expire before the nested provider request can settle. */
const COMMAND_SYNTHESIS_TIMEOUT_MS = SIDECAR_MODEL_DEADLINE_MS + 30_000

/** Deterministic harness calls the researcher drives, with no model deciding what the request means. */
export type ProjectWorkspaceMethod =
  | 'command.synthesize'
  | 'project.critic'
  | 'project.list'
  | 'project.read'
  | 'project.validate'

type ActiveModelOperation = {
  abortController: AbortController
  capability: StudioAgentCapability | null
  cancelled: boolean
  cancellationReason: 'stop' | 'steer' | null
  kind: 'agent_turn' | 'command_synthesis'
  modelId: UniqueModelId
  operationId: string
  resultReported: boolean
  terminalized: boolean
  turnId: string | null
}

interface ImportCapability {
  handle: FileHandle
  device: bigint
  inode: bigint
  sizeBytes: number
}

type StudioAgentCapability = 'inspect' | 'plan' | 'act'

type PendingAgentTurn = {
  intent: StudioAgentComposerIntent | null
  modelId: UniqueModelId
  request: string
  senderId: WindowId
}

export type StudioAgentTurnControl =
  | { sessionId: string; action: 'stop' }
  | {
      sessionId: string
      action: 'steer' | 'queue'
      request: string
      intent?: StudioAgentComposerIntent | null
    }

const FILE_URI = /(?:^|[^A-Za-z0-9+.-])file:(?:\/\/)?(?:\/|[A-Za-z]:[\\/])/i
const POSIX_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~/-])\/(?!\/)[^/\s"'`]+(?:\/[^/\s"'`]+)*/
const WINDOWS_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~:/\\-])[A-Za-z]:[\\/][^\s"'`]+/
const UNC_PATH = /(?:^|[^A-Za-z0-9._~:/\\-])(?:\\\\|\/\/)[^\\/\s"'`]+[\\/][^\\/\s"'`]+/

function containsAbsoluteFilesystemPath(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      FILE_URI.test(value) ||
      POSIX_ABSOLUTE_PATH.test(value) ||
      WINDOWS_ABSOLUTE_PATH.test(value) ||
      UNC_PATH.test(value)
    )
  }
  if (Array.isArray(value)) return value.some(containsAbsoluteFilesystemPath)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, item]) => containsAbsoluteFilesystemPath(key) || containsAbsoluteFilesystemPath(item)
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function capabilityFromIntent(intent: StudioAgentComposerIntent | null): StudioAgentCapability {
  if (intent === null) return 'inspect'
  if (intent.capability === 'navigation') {
    throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Navigation commands do not start an Agent turn')
  }
  return intent.capability
}

function terminalOutcome(value: unknown): StudioAgentTurnOutcome {
  if (
    value === 'completed' ||
    value === 'denied' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'needs_user'
  ) {
    return value
  }
  throw new JsonRpcFault(-32603, 'AgentSession returned an invalid terminal outcome')
}

@Injectable('ChemSmartAgentService')
@DependsOn(['MoleculeProjectStore', 'StudioControlService', 'CalculationRuntimeService'])
@ServicePhase(Phase.WhenReady)
export class ChemSmartAgentService extends BaseService {
  private process: LocalRpcProcess | null = null
  private boundProjectPath: string | null = null
  private readonly importCapabilities = new Map<string, ImportCapability>()
  private readonly activeModelOperations = new Map<string, ActiveModelOperation>()
  private readonly queuedTurns = new Map<string, PendingAgentTurn[]>()
  private readonly pendingSteers = new Map<string, PendingAgentTurn>()
  private readonly agentTrace = new StudioAgentTraceChannel((event) =>
    application.get('IpcApiService').broadcast('chemsmart_studio.agent.trace', event)
  )
  private readonly studioUiEvents = new StudioUiEventChannel(
    (event) => application.get('IpcApiService').broadcast('chemsmart_studio.studio_ui.event', event),
    (event) => this.applyTransientFocus(event)
  )

  getStatus(): ChemSmartStudioProcessStatus {
    return this.process?.getStatus() ?? { state: 'stopped', pid: null, lastError: null }
  }

  private getBoundProjectPath(): string {
    return this.boundProjectPath ?? application.get('MoleculeProjectStore').getActiveProjectPath()
  }

  getDeterministicModelId(): UniqueModelId | null {
    if (isControlledCalculationTestHarnessEnabled(app.isPackaged)) return controlledCalculationTestModelId
    if (isE7XtbTestHarnessEnabled(app.isPackaged)) return e7XtbTestModelId
    if (isMoleculePreviewTestHarnessEnabled(app.isPackaged)) return moleculePreviewTestModelId
    return null
  }

  async startAgent(): Promise<ChemSmartStudioProcessStatus> {
    if (!this.process) {
      // The sidecar writes trajectory ledgers inside the open package, so the package has to be a
      // real one before it is handed the path — otherwise the first run would create `runs/` inside
      // a directory that is not a project.
      const projects = application.get('MoleculeProjectStore')
      await projects.ensureDefaultProject(application.get('MoleculeDocumentService').getDocument())
      this.boundProjectPath ??= projects.getActiveProjectPath()
      const project = application.getPath('feature.chemsmart_studio.bridge.project')
      const command = app.isPackaged ? application.getPath('feature.chemsmart_studio.bridge.python_file') : 'uv'
      this.process = new LocalRpcProcess({
        name: 'agent',
        command,
        args: (socketPath) =>
          app.isPackaged
            ? [
                '-m',
                'chemsmart_studio_bridge',
                '--socket',
                socketPath,
                '--session-root',
                application.getPath('feature.chemsmart_studio.agent_sessions'),
                // The open package, so trajectory ledgers are written where the project keeps them.
                '--project-root',
                this.getBoundProjectPath()
              ]
            : [
                'run',
                '--project',
                project,
                '--frozen',
                'chemsmart-studio-bridge',
                '--socket',
                socketPath,
                '--session-root',
                application.getPath('feature.chemsmart_studio.agent_sessions'),
                '--project-root',
                this.getBoundProjectPath()
              ],
        // chemsmart discovers workspace-scoped method projects and CHEMSMART.md relative to the working
        // directory, so the sidecar runs in a Studio-owned workspace rather than in its own source tree.
        cwd: application.getPath('feature.chemsmart_studio.workspace'),
        runtimeDirectory: application.getPath('feature.chemsmart_studio.runtime'),
        environment: { PYTHONDONTWRITEBYTECODE: '1' },
        incomingHandler: (method, params) => this.handleSidecarRequest(method, params),
        onStateChanged: (status) => {
          application.get('IpcApiService').broadcast('chemsmart_studio.agent.state_changed', status)
          if (status.state === 'failed' || status.state === 'stopped') {
            this.failActiveTurns()
            application.get('StudioControlService').denyPendingApprovals()
          }
        }
      })
    }
    return this.process.start()
  }

  async stopAgent(): Promise<ChemSmartStudioProcessStatus> {
    this.failActiveTurns()
    application.get('StudioControlService').denyPendingApprovals()
    return this.process?.stop() ?? this.getStatus()
  }

  /**
   * Moves the sidecar's project-root capability without ever sending that path through a public
   * renderer or model contract. Active turns and approvals are invalid across a project switch.
   */
  async rebindProject(projectPath: string): Promise<void> {
    const previous = this.boundProjectPath ?? application.get('MoleculeProjectStore').getActiveProjectPath()
    const wasRunning = this.getStatus().state === 'running'
    await this.stopAgent()
    this.boundProjectPath = projectPath
    if (!wasRunning) return
    try {
      await this.startAgent()
    } catch (error) {
      this.boundProjectPath = previous
      try {
        await this.startAgent()
      } catch {
        throw new Error('The ChemSmart sidecar could not restore its previous project binding', { cause: error })
      }
      throw error
    }
  }

  /**
   * Imports a molecule through a one-file opaque capability. Python receives only an id, size,
   * format, and bounded chunks; the real path remains in main.
   */
  async importMoleculeFile(filePath: string, documentId: string): Promise<MoleculeDocument> {
    const resolved = await validateImportFile(filePath)
    const format = path.extname(resolved).slice(1).toLowerCase() as MoleculeImportRequest['format']
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    const capabilityId = `import-${randomUUID()}`
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size <= 0n || stat.size > 134_217_728n) {
        throw new Error('The selected molecule file is empty or too large')
      }
      this.importCapabilities.set(capabilityId, {
        handle,
        device: stat.dev,
        inode: stat.ino,
        sizeBytes: Number(stat.size)
      })
      const request: MoleculeImportRequest = {
        capabilityId,
        format,
        documentId,
        sizeBytes: Number(stat.size),
        extensions: {}
      }
      if (!moleculeImportRequestValidator(request).valid) {
        throw new JsonRpcFault(-32602, 'Molecule import request is schema-invalid')
      }
      if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
      const result = await this.process!.request('molecule.import', request, PROJECT_WORKSPACE_TIMEOUT_MS)
      if (!moleculeImportResultValidator(result).valid) {
        throw new JsonRpcFault(-32603, 'Molecule importer returned a schema-invalid result')
      }
      return (result as MoleculeImportResult).document
    } finally {
      this.importCapabilities.delete(capabilityId)
      await handle.close()
    }
  }

  async runTurn(
    sessionId: string,
    modelId: UniqueModelId,
    request: string,
    intentOrSender: StudioAgentComposerIntent | WindowId | null,
    senderId?: WindowId
  ): Promise<void> {
    const intent = typeof intentOrSender === 'string' ? null : intentOrSender
    const resolvedSenderId = typeof intentOrSender === 'string' ? intentOrSender : senderId
    if (!resolvedSenderId) {
      throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    }
    const controls = application.get('StudioControlService')
    controls.claimSessionControl(sessionId, resolvedSenderId)
    if (this.activeModelOperations.has(sessionId)) {
      logger.warn('Rejected concurrent ChemSmart agent turn', { sessionId })
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'A ChemSmart agent turn is already active')
    }

    const projection = application.get('StudioAgentProjectionService')
    if (intent) await projection.validateComposerIntent(sessionId, sessionId, intent)
    const started = await projection.beginTurn(sessionId, request)
    const capability = capabilityFromIntent(intent)
    const turnToken: ActiveModelOperation = {
      abortController: new AbortController(),
      capability,
      cancelled: false,
      cancellationReason: null,
      kind: 'agent_turn',
      modelId,
      operationId: randomUUID(),
      resultReported: false,
      terminalized: false,
      turnId: started.turnId
    }
    this.activeModelOperations.set(sessionId, turnToken)
    try {
      controls.beginAgentTurn(sessionId)
      if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
      const rawResult = await this.process!.request(
        'agent.run_turn',
        { sessionId, modelId, operationId: turnToken.operationId, request, capability },
        15 * 60 * 1000
      )
      if (turnToken.cancelled) {
        throw new IpcError(chemsmartStudioErrorCodes.AGENT_UNAVAILABLE, 'The ChemSmart agent turn was stopped')
      }
      const result = this.objectParams(rawResult)
      const outcome = terminalOutcome(result.terminal_outcome)
      if (outcome === 'completed' && !turnToken.resultReported) {
        if (result.advisory_only !== true) {
          throw new JsonRpcFault(-32603, 'Agent turn completed without a structured Studio result')
        }
        const answer = this.advisoryAnswer(result.assistant_output)
        await projection.appendTurnEvent(sessionId, started.turnId, {
          kind: 'answer_published',
          status: 'succeeded',
          summary: answer.summary,
          answer
        })
      }
      await projection.terminalize(sessionId, started.turnId, outcome, this.terminalSummary(outcome))
      turnToken.terminalized = true
      if (this.activeModelOperations.get(sessionId) === turnToken) controls.completeAgentTurn(sessionId)
    } catch (error) {
      if (!turnToken.terminalized) {
        const outcome: StudioAgentTurnOutcome = turnToken.cancelled ? 'cancelled' : 'failed'
        try {
          await projection.terminalize(sessionId, started.turnId, outcome, this.terminalSummary(outcome))
          turnToken.terminalized = true
        } catch (terminalError) {
          logger.error('Failed to terminalize a ChemSmart Agent turn', {
            sessionId,
            turnId: started.turnId,
            error: terminalError
          })
        }
      }
      if (this.activeModelOperations.get(sessionId) === turnToken) controls.failAgentTurn(sessionId)
      throw error
    } finally {
      if (this.activeModelOperations.get(sessionId) === turnToken) {
        turnToken.abortController.abort()
        this.activeModelOperations.delete(sessionId)
      }
      this.scheduleNextTurn(sessionId)
    }
  }

  async controlTurn(
    control: StudioAgentTurnControl,
    senderId: WindowId
  ): Promise<{ accepted: true; action: 'stop' | 'steer' | 'queue'; queueDepth: number }> {
    const controls = application.get('StudioControlService')
    controls.claimSessionControl(control.sessionId, senderId)
    const operation = this.activeModelOperations.get(control.sessionId)
    if (!operation || operation.kind !== 'agent_turn') {
      throw new IpcError(chemsmartStudioErrorCodes.AGENT_UNAVAILABLE, 'No ChemSmart Agent turn is active')
    }

    if (control.action === 'stop') {
      operation.cancelled = true
      operation.cancellationReason = 'stop'
      operation.abortController.abort()
      controls.denyPendingApprovals(control.sessionId)
      return {
        accepted: true,
        action: control.action,
        queueDepth: this.queuedTurns.get(control.sessionId)?.length ?? 0
      }
    }

    const intent = control.intent ?? null
    await application
      .get('StudioAgentProjectionService')
      .validateComposerIntent(control.sessionId, control.sessionId, intent ?? this.inspectIntent())
    const pending: PendingAgentTurn = {
      intent,
      modelId: operation.modelId,
      request: control.request,
      senderId
    }
    if (control.action === 'steer') {
      if (this.pendingSteers.has(control.sessionId)) {
        throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'A steering request is already pending')
      }
      this.pendingSteers.set(control.sessionId, pending)
    } else {
      const queue = this.queuedTurns.get(control.sessionId) ?? []
      if (queue.length >= 32) {
        throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'The ChemSmart Agent queue is full')
      }
      queue.push(pending)
      this.queuedTurns.set(control.sessionId, queue)
    }
    return {
      accepted: true,
      action: control.action,
      queueDepth:
        (this.queuedTurns.get(control.sessionId)?.length ?? 0) + (this.pendingSteers.has(control.sessionId) ? 1 : 0)
    }
  }

  async inspectCommand(request: CommandInspectionRequest): Promise<CommandInspectionResult> {
    if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
    const result = await this.process!.request('command.inspect', request, 30_000)
    if (
      !commandInspectionValidator(result).valid ||
      containsAbsoluteFilesystemPath(result) ||
      (result as CommandInspectionResult).sessionId !== request.sessionId ||
      (result as CommandInspectionResult).commandDigest !== sha256(request.command.trim())
    ) {
      throw new JsonRpcFault(-32603, 'Command inspection returned an invalid result')
    }
    return result as CommandInspectionResult
  }

  listProjects(request: ProjectWorkspaceListRequest): Promise<ProjectWorkspaceListResult> {
    return this.requestClosedResult('project.list', request, projectListResultValidator)
  }

  async readProject(request: ProjectWorkspaceReadRequest): Promise<ProjectWorkspaceReadResult> {
    const result = await this.requestClosedResult<ProjectWorkspaceReadResult>(
      'project.read',
      request,
      projectReadResultValidator
    )
    this.assertProjectIdentity('project.read', request, result)
    return result
  }

  async validateProject(request: ProjectWorkspaceValidateRequest): Promise<ProjectWorkspaceValidateResult> {
    const result = await this.requestClosedResult<ProjectWorkspaceValidateResult>(
      'project.validate',
      request,
      projectValidateResultValidator
    )
    this.assertProjectIdentity('project.validate', request, result)
    return result
  }

  async critiqueProject(request: ProjectWorkspaceCritiqueRequest): Promise<ProjectWorkspaceCritiqueResult> {
    const result = await this.requestClosedResult<ProjectWorkspaceCritiqueResult>(
      'project.critic',
      request,
      projectCritiqueResultValidator
    )
    this.assertProjectIdentity('project.critic', request, result)
    return result
  }

  async synthesizeCommand(request: CommandSynthesisRequest, senderId: WindowId): Promise<CommandSynthesisResult> {
    const controls = application.get('StudioControlService')
    controls.claimSessionControl(request.sessionId, senderId)
    if (this.activeModelOperations.has(request.sessionId)) {
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'A ChemSmart model operation is already active')
    }

    const token: ActiveModelOperation = {
      abortController: new AbortController(),
      capability: null,
      cancelled: false,
      cancellationReason: null,
      kind: 'command_synthesis',
      modelId: request.modelId as UniqueModelId,
      operationId: randomUUID(),
      resultReported: false,
      terminalized: false,
      turnId: null
    }
    this.activeModelOperations.set(request.sessionId, token)
    try {
      const result = await this.requestClosedResult<CommandSynthesisResult>(
        'command.synthesize',
        { ...request, operationId: token.operationId },
        commandSynthesisResultValidator,
        COMMAND_SYNTHESIS_TIMEOUT_MS
      )
      if (token.cancelled) {
        throw new IpcError(chemsmartStudioErrorCodes.AGENT_UNAVAILABLE, 'Command synthesis was stopped')
      }
      if (
        result.sessionId !== request.sessionId ||
        (result.commandDigest !== null && result.commandDigest !== sha256(result.command))
      ) {
        throw new JsonRpcFault(-32603, 'command.synthesize returned an invalid public result')
      }
      return result
    } finally {
      if (this.activeModelOperations.get(request.sessionId) === token) {
        token.abortController.abort()
        this.activeModelOperations.delete(request.sessionId)
      }
    }
  }

  private async requestClosedResult<Result>(
    method: ProjectWorkspaceMethod,
    params: unknown,
    validator: (value: unknown) => { valid: boolean },
    timeoutMs = PROJECT_WORKSPACE_TIMEOUT_MS
  ): Promise<Result> {
    if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
    const result = await this.process!.request(method, params, timeoutMs)
    if (!validator(result).valid || containsAbsoluteFilesystemPath(result)) {
      throw new JsonRpcFault(-32603, `${method} returned an invalid public result`)
    }
    return result as Result
  }

  /**
   * Issues a trajectory-store request to the sidecar.
   *
   * Kept apart from `requestClosedResult` on purpose. That path also refuses any result containing
   * an absolute filesystem path, which is right for project-workspace answers the model can see. A
   * run record legitimately carries the executable identity its plan was validated against, so the
   * guard would reject a truthful answer. The caller validates the shape against the same schema
   * the helper's replies were checked with, and the result reaches only the renderer.
   */
  async requestTrajectory(method: string, params: unknown, timeoutMs = PROJECT_WORKSPACE_TIMEOUT_MS): Promise<unknown> {
    if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
    return this.process!.request(method, params, timeoutMs)
  }

  private assertProjectIdentity(
    method: ProjectWorkspaceMethod,
    request: { projectName: string; program: string },
    result: { projectName: string; program: string }
  ): void {
    if (result.projectName !== request.projectName || result.program !== request.program) {
      throw new JsonRpcFault(-32603, `${method} returned an invalid public result`)
    }
  }

  async replayStudioUi(
    sessionId: string,
    afterSequence: number,
    senderId: WindowId,
    restoreLiveSequence = false
  ): Promise<{ replayed: number; nextSequence: number }> {
    application.get('StudioControlService').claimSessionControl(sessionId, senderId)
    return this.replayStudioUiInternal(sessionId, afterSequence, restoreLiveSequence)
  }

  private async replayStudioUiInternal(
    sessionId: string,
    afterSequence: number,
    restoreLiveSequence = false
  ): Promise<{ replayed: number; nextSequence: number }> {
    if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
    const replayId = `replay-${randomUUID()}`
    this.studioUiEvents.startReplay(replayId, sessionId, afterSequence, restoreLiveSequence)
    try {
      const result = await this.process!.request('studio_ui.replay', {
        sessionId,
        replayId,
        afterSequence
      })
      return await this.studioUiEvents.finishReplay(replayId, result)
    } catch (error) {
      this.studioUiEvents.abortReplay(replayId)
      throw error
    }
  }

  private async handleSidecarRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'model.generate':
        return this.generateModel(params)
      case 'approval.request':
        return this.requestApproval(this.authorizedCallbackPayload(params, 'agent_turn'))
      case 'molecule.request':
        return this.forwardMoleculeRequest(this.authorizedCallbackPayload(params, 'agent_turn'))
      case 'calculation.request':
        return this.handleCalculationRequest(this.authorizedCallbackPayload(params, 'agent_turn'))
      case 'molecule.import_chunk':
        return this.readImportChunk(params)
      case 'agent.event':
        this.authorizedCallbackPayload(params, 'agent_turn')
        return { accepted: true }
      case 'agent.report_result':
        return this.reportStudioResult(params)
      case 'agent.trace': {
        const value = this.objectParams(params)
        const operation = this.authorizedOperation(value, 'agent_turn')
        const payload = { ...value }
        delete payload.operationId
        const event = this.agentTrace.emit(operation.turnId ?? operation.operationId, payload)
        await this.appendProjectionTrace(value.sessionId as string, operation, event)
        if (event.kind === 'tool_succeeded' || event.kind === 'tool_failed') {
          this.cancelAtSteeringBoundary(value.sessionId as string, operation)
        }
        return event
      }
      case 'studio_ui.event':
        return this.studioUiEvents.enqueueLive(this.authorizedCallbackPayload(params, 'agent_turn'))
      case 'studio_ui.replay_event':
        return this.studioUiEvents.enqueueReplay(params)
      default:
        throw new JsonRpcFault(-32601, `Method not found: ${method}`)
    }
  }

  private async reportStudioResult(params: unknown): Promise<{ accepted: true }> {
    const value = this.objectParams(params)
    const operation = this.authorizedOperation(value, 'agent_turn')
    if (!operation.turnId || operation.resultReported) {
      throw new JsonRpcFault(-32003, 'The Studio result is not bound to an active unpublished turn')
    }
    const validation = studioAgentReportResultValidator(value.arguments)
    if (!validation.valid || containsAbsoluteFilesystemPath(value.arguments)) {
      throw new JsonRpcFault(-32602, 'The Studio result is schema-invalid or contains a filesystem path')
    }

    const result = value.arguments as StudioAgentReportResultInput
    const sessionId = value.sessionId as string
    const calculation = application.get('CalculationRuntimeService')
    for (const artifact of result.artifacts) {
      await calculation.verifyReportedAgentArtifact(sessionId, artifact)
    }

    const projection = application.get('StudioAgentProjectionService')
    for (const artifact of result.artifacts) {
      await projection.appendTurnEvent(sessionId, operation.turnId, {
        kind: 'artifact_published',
        status: 'succeeded',
        summary: artifact.summary,
        artifact
      })
    }
    await projection.appendTurnEvent(sessionId, operation.turnId, {
      kind: 'answer_published',
      status: 'succeeded',
      summary: result.answer.summary,
      answer: result.answer
    })
    operation.resultReported = true
    return { accepted: true }
  }

  private async appendProjectionTrace(
    sessionId: string,
    operation: ActiveModelOperation,
    event: StudioAgentTraceEvent
  ): Promise<void> {
    if (
      !operation.turnId ||
      event.toolName === 'report_studio_result' ||
      event.kind === 'turn_started' ||
      event.kind === 'turn_completed' ||
      event.kind === 'turn_blocked'
    ) {
      return
    }
    const projection = application.get('StudioAgentProjectionService')
    if (event.kind === 'reasoning_summary') {
      await projection.appendTurnEvent(sessionId, operation.turnId, {
        kind: 'reasoning_summary',
        status: 'running',
        summary: event.summary
      })
      return
    }
    if (!event.toolCallId || !event.toolName) {
      throw new JsonRpcFault(-32603, 'Agent tool trace identity is missing')
    }
    const kind = event.kind
    await projection.appendTurnEvent(sessionId, operation.turnId, {
      kind,
      status: event.status,
      summary: event.summary,
      ...(kind === 'permission_waiting' ? { approvalRef: event.toolCallId } : {}),
      tool: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        purpose: event.title,
        ...(event.detail?.argumentKeys ? { argumentKeys: event.detail.argumentKeys } : {}),
        ...(event.detail?.resultKeys ? { resultKeys: event.detail.resultKeys } : {}),
        ...(event.detail?.ruleIds ? { ruleIds: event.detail.ruleIds } : {}),
        ...(event.detail?.verdict ? { verdict: event.detail.verdict } : {}),
        ...(event.detail?.durationMs !== undefined ? { durationMs: event.detail.durationMs } : {})
      }
    })
  }

  private advisoryAnswer(value: unknown): StudioAgentAnswer {
    if (typeof value !== 'string') {
      throw new JsonRpcFault(-32603, 'Advisory Agent output must be bounded plain text')
    }
    const summary = value.replace(/\s+/g, ' ').trim()
    if (summary.length === 0 || summary.length > 2_048 || containsAbsoluteFilesystemPath(summary)) {
      throw new JsonRpcFault(-32603, 'Advisory Agent output must be bounded path-free plain text')
    }
    return {
      answerId: `answer-${randomUUID()}`,
      heading: 'ChemSmart Agent',
      summary,
      sections: [{ kind: 'finding', heading: 'Finding', summary }],
      extensions: {}
    }
  }

  private terminalSummary(outcome: StudioAgentTurnOutcome): string {
    switch (outcome) {
      case 'completed':
        return 'Agent turn completed'
      case 'denied':
        return 'Agent tool permission was denied'
      case 'failed':
        return 'Agent turn failed'
      case 'cancelled':
        return 'Agent turn cancelled'
      case 'needs_user':
        return 'Agent needs more information'
    }
  }

  private async readImportChunk(params: unknown): Promise<MoleculeImportChunkResponse> {
    const validation = moleculeImportChunkRequestValidator(params)
    if (!validation.valid) throw new JsonRpcFault(-32602, 'Molecule import chunk request is schema-invalid')
    const request = params as MoleculeImportChunkRequest
    const capability = this.importCapabilities.get(request.capabilityId)
    if (!capability) throw new JsonRpcFault(-32003, 'Molecule import capability is unavailable')
    if (request.offset > capability.sizeBytes) {
      throw new JsonRpcFault(-32602, 'Molecule import chunk offset is outside the file')
    }
    const stat = await capability.handle.stat({ bigint: true })
    if (
      !stat.isFile() ||
      stat.dev !== capability.device ||
      stat.ino !== capability.inode ||
      Number(stat.size) !== capability.sizeBytes
    ) {
      throw new JsonRpcFault(-32003, 'Molecule import source identity changed')
    }
    const length = Math.min(request.length, capability.sizeBytes - request.offset)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await capability.handle.read(buffer, 0, length, request.offset)
    const response: MoleculeImportChunkResponse = {
      capabilityId: request.capabilityId,
      offset: request.offset,
      sizeBytes: capability.sizeBytes,
      encoding: 'base64',
      content: buffer.subarray(0, bytesRead).toString('base64'),
      eof: request.offset + bytesRead >= capability.sizeBytes,
      extensions: {}
    }
    if (!moleculeImportChunkResponseValidator(response).valid) {
      throw new JsonRpcFault(-32603, 'Molecule import chunk response is schema-invalid')
    }
    return response
  }

  private async generateModel(params: unknown): Promise<unknown> {
    const value = this.objectParams(params)
    const sessionId = value.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new JsonRpcFault(-32602, 'sessionId is required for a host model request')
    }
    const uniqueModelId = value.modelId as UniqueModelId
    if (typeof uniqueModelId !== 'string' || !uniqueModelId.includes('::')) {
      throw new JsonRpcFault(-32602, 'modelId must be a host UniqueModelId')
    }
    const operation = this.authorizedOperation(value)
    if (operation.modelId !== uniqueModelId) {
      throw new JsonRpcFault(-32003, 'Host model request changed the authorized model')
    }
    if (!Array.isArray(value.messages) || value.messages.length > 256) {
      throw new JsonRpcFault(-32602, 'messages must be a bounded array')
    }
    if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > 64)) {
      throw new JsonRpcFault(-32602, 'tools must be a bounded array')
    }
    let body: unknown
    if (
      uniqueModelId === controlledCalculationTestModelId &&
      isControlledCalculationTestHarnessEnabled(app.isPackaged)
    ) {
      body = controlledCalculationTestModelResponse(
        Array.isArray(value.messages) ? value.messages : [],
        Array.isArray(value.tools) ? value.tools : []
      )
    } else if (uniqueModelId === e7XtbTestModelId && isE7XtbTestHarnessEnabled(app.isPackaged)) {
      body = e7XtbTestModelResponse(
        Array.isArray(value.messages) ? value.messages : [],
        Array.isArray(value.tools) ? value.tools : []
      )
    } else if (uniqueModelId === moleculePreviewTestModelId && isMoleculePreviewTestHarnessEnabled(app.isPackaged)) {
      body = moleculePreviewTestModelResponse(
        Array.isArray(value.messages) ? value.messages : [],
        Array.isArray(value.tools) ? value.tools : []
      )
    } else {
      const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
      const model = modelService.getByKey(providerId, modelId)
      // The provider already lives in this process. Resolving here rather than over a loopback socket
      // means there is no server to start, no key to mint, and no OpenAI round trip to a route that
      // would have called the very same code.
      body = await generateStudioModelResponse({
        providerId,
        apiModelId: model.apiModelId ?? modelId,
        messages: Array.isArray(value.messages) ? value.messages : [],
        tools: Array.isArray(value.tools) ? value.tools : undefined,
        timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
        signal: operation.abortController.signal
      })
    }
    this.cancelAtSteeringBoundary(sessionId, operation)
    if (operation.cancelled || this.activeModelOperations.get(sessionId) !== operation) {
      throw new JsonRpcFault(-32003, 'Host model request was cancelled')
    }
    return body
  }

  private inspectIntent(): StudioAgentComposerIntent {
    return {
      intentId: `intent-${randomUUID()}`,
      kind: 'inspect',
      capability: 'inspect',
      contextRefs: [],
      requiresExecutionApproval: false,
      extensions: {}
    }
  }

  private cancelAtSteeringBoundary(sessionId: string, operation: ActiveModelOperation): void {
    if (operation.kind !== 'agent_turn' || !this.pendingSteers.has(sessionId)) return
    operation.cancelled = true
    operation.cancellationReason = 'steer'
    operation.abortController.abort()
  }

  private scheduleNextTurn(sessionId: string): void {
    if (this.activeModelOperations.has(sessionId)) return
    const steer = this.pendingSteers.get(sessionId)
    if (steer) this.pendingSteers.delete(sessionId)
    const queue = this.queuedTurns.get(sessionId) ?? []
    const next = steer ?? queue.shift()
    if (!next) {
      this.queuedTurns.delete(sessionId)
      return
    }
    if (queue.length === 0) this.queuedTurns.delete(sessionId)
    else this.queuedTurns.set(sessionId, queue)
    queueMicrotask(() => {
      void this.runTurn(sessionId, next.modelId, next.request, next.intent, next.senderId).catch((error) => {
        logger.error('Queued ChemSmart Agent turn failed', { sessionId, error })
      })
    })
  }

  private requestApproval(params: unknown): Promise<{ decision: 'allow_once' | 'deny' }> {
    return application.get('StudioControlService').requestApproval(params)
  }

  private forwardMoleculeRequest(params: unknown): Promise<unknown> {
    return application.get('StudioControlService').forwardMoleculeRequest(params)
  }

  private async handleCalculationRequest(params: unknown): Promise<unknown> {
    const result = await application.get('CalculationRuntimeService').handleHostRequest(params)
    const request = params as ControlledCalculationHostRequest
    application.get('StudioControlService').recordAgentToolCompletion(request.sessionId, request.request.tool)
    return result
  }

  private async applyTransientFocus(event: StudioUiEvent): Promise<StudioUiDelivery> {
    try {
      await application.get('MoleculeWorkspaceService').applyTransientFocus(event)
      return { accepted: true, eventId: event.eventId, sequence: event.sequence }
    } catch (error) {
      const candidate = error as { code?: unknown; message?: unknown; data?: { studioCode?: unknown } }
      const code = candidate.data?.studioCode
      if (code === 'REVISION_CONFLICT') {
        return {
          accepted: false,
          eventId: event.eventId,
          sequence: event.sequence,
          error: {
            code: 'REVISION_CONFLICT',
            message: typeof candidate.message === 'string' ? candidate.message : 'Molecule focus revision is stale'
          }
        }
      }
      return {
        accepted: false,
        eventId: event.eventId,
        sequence: event.sequence,
        error: {
          code: candidate.code === -32002 ? 'RPC_TIMEOUT' : 'EDITOR_UNAVAILABLE',
          message: typeof candidate.message === 'string' ? candidate.message : 'Molecule editor is unavailable'
        }
      }
    }
  }

  private objectParams(params: unknown): Record<string, unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new JsonRpcFault(-32602, 'params must be an object')
    return params as Record<string, unknown>
  }

  private authorizedOperation(
    value: Record<string, unknown>,
    expectedKind?: ActiveModelOperation['kind']
  ): ActiveModelOperation {
    const sessionId = value.sessionId
    const operationId = value.operationId
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof operationId !== 'string') {
      throw new JsonRpcFault(-32003, 'Host model request is not bound to an active Studio operation')
    }
    const operation = this.activeModelOperations.get(sessionId)
    if (
      !operation ||
      operation.cancelled ||
      operation.operationId !== operationId ||
      (expectedKind !== undefined && operation.kind !== expectedKind)
    ) {
      throw new JsonRpcFault(-32003, 'Host model request is not bound to an active Studio operation')
    }
    return operation
  }

  private authorizedCallbackPayload(
    params: unknown,
    expectedKind: ActiveModelOperation['kind']
  ): Record<string, unknown> {
    const value = this.objectParams(params)
    this.authorizedOperation(value, expectedKind)
    const payload = { ...value }
    delete payload.operationId
    return payload
  }

  private failActiveTurns(): void {
    if (this.activeModelOperations.size === 0) return
    const activeOperations = [...this.activeModelOperations]
    for (const [, operation] of activeOperations) {
      operation.cancelled = true
      operation.cancellationReason = 'stop'
      operation.abortController.abort()
    }
    this.activeModelOperations.clear()
    this.pendingSteers.clear()
    this.queuedTurns.clear()

    const controls = application.get('StudioControlService')
    for (const [sessionId, operation] of activeOperations) {
      if (operation.kind !== 'agent_turn') continue
      try {
        controls.failAgentTurn(sessionId)
      } catch (error) {
        logger.error('Failed to publish a stopped ChemSmart agent turn', { sessionId, error })
      }
    }
  }

  protected async onStop(): Promise<void> {
    this.failActiveTurns()
    application.get('StudioControlService').denyPendingApprovals()
    await this.process?.stop()
    const capabilities = [...this.importCapabilities.values()]
    this.importCapabilities.clear()
    await Promise.all(capabilities.map(({ handle }) => handle.close().catch(() => undefined)))
    logger.info('ChemSmart sidecar stopped')
  }
}
