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
  cancelled: boolean
  kind: 'agent_turn' | 'command_synthesis'
  modelId: UniqueModelId
  operationId: string
}

interface ImportCapability {
  handle: FileHandle
  device: bigint
  inode: bigint
  sizeBytes: number
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

@Injectable('ChemSmartAgentService')
@DependsOn(['MoleculeProjectStore', 'StudioControlService', 'CalculationRuntimeService'])
@ServicePhase(Phase.WhenReady)
export class ChemSmartAgentService extends BaseService {
  private process: LocalRpcProcess | null = null
  private boundProjectPath: string | null = null
  private readonly importCapabilities = new Map<string, ImportCapability>()
  private readonly activeModelOperations = new Map<string, ActiveModelOperation>()
  private readonly studioUiRestores = new Map<string, Promise<void>>()
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

  async runTurn(sessionId: string, modelId: UniqueModelId, request: string, senderId: WindowId): Promise<void> {
    const controls = application.get('StudioControlService')
    controls.claimSessionControl(sessionId, senderId)
    if (this.activeModelOperations.has(sessionId)) {
      logger.warn('Rejected concurrent ChemSmart agent turn', { sessionId })
      throw new IpcError(chemsmartStudioErrorCodes.RUN_ACTIVE, 'A ChemSmart agent turn is already active')
    }

    const turnToken: ActiveModelOperation = {
      abortController: new AbortController(),
      cancelled: false,
      kind: 'agent_turn',
      modelId,
      operationId: randomUUID()
    }
    this.activeModelOperations.set(sessionId, turnToken)
    try {
      controls.beginAgentTurn(sessionId)
      if (!this.process || this.process.getStatus().state !== 'running') await this.startAgent()
      await this.ensureStudioUiSession(sessionId)
      await this.process!.request(
        'agent.run_turn',
        { sessionId, modelId, operationId: turnToken.operationId, request },
        15 * 60 * 1000
      )
      if (turnToken.cancelled) {
        throw new IpcError(chemsmartStudioErrorCodes.AGENT_UNAVAILABLE, 'The ChemSmart agent turn was stopped')
      }
      if (this.activeModelOperations.get(sessionId) === turnToken) controls.completeAgentTurn(sessionId)
    } catch (error) {
      if (this.activeModelOperations.get(sessionId) === turnToken) controls.failAgentTurn(sessionId)
      throw error
    } finally {
      if (this.activeModelOperations.get(sessionId) === turnToken) {
        turnToken.abortController.abort()
        this.activeModelOperations.delete(sessionId)
      }
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
      cancelled: false,
      kind: 'command_synthesis',
      modelId: request.modelId as UniqueModelId,
      operationId: randomUUID()
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
      case 'studio_ui.event':
        return this.studioUiEvents.enqueueLive(this.authorizedCallbackPayload(params, 'agent_turn'))
      case 'studio_ui.replay_event':
        return this.studioUiEvents.enqueueReplay(params)
      default:
        throw new JsonRpcFault(-32601, `Method not found: ${method}`)
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
    if (
      uniqueModelId === controlledCalculationTestModelId &&
      isControlledCalculationTestHarnessEnabled(app.isPackaged)
    ) {
      return controlledCalculationTestModelResponse(
        Array.isArray(value.messages) ? value.messages : [],
        Array.isArray(value.tools) ? value.tools : []
      )
    }
    if (uniqueModelId === e7XtbTestModelId && isE7XtbTestHarnessEnabled(app.isPackaged)) {
      return e7XtbTestModelResponse(
        Array.isArray(value.messages) ? value.messages : [],
        Array.isArray(value.tools) ? value.tools : []
      )
    }
    if (uniqueModelId === moleculePreviewTestModelId && isMoleculePreviewTestHarnessEnabled(app.isPackaged)) {
      return moleculePreviewTestModelResponse(
        Array.isArray(value.messages) ? value.messages : [],
        Array.isArray(value.tools) ? value.tools : []
      )
    }
    const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
    const model = modelService.getByKey(providerId, modelId)
    // The provider already lives in this process. Resolving here rather than over a loopback socket
    // means there is no server to start, no key to mint, and no OpenAI round trip to a route that
    // would have called the very same code.
    const body = await generateStudioModelResponse({
      providerId,
      apiModelId: model.apiModelId ?? modelId,
      messages: Array.isArray(value.messages) ? value.messages : [],
      tools: Array.isArray(value.tools) ? value.tools : undefined,
      timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
      signal: operation.abortController.signal
    })
    if (operation.cancelled || this.activeModelOperations.get(sessionId) !== operation) {
      throw new JsonRpcFault(-32003, 'Host model request was cancelled')
    }
    return body
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

  private async ensureStudioUiSession(sessionId: string): Promise<void> {
    if (this.studioUiEvents.hasLiveSequence(sessionId)) return
    let restore = this.studioUiRestores.get(sessionId)
    if (!restore) {
      restore = this.replayStudioUiInternal(sessionId, -1, true)
        .then(() => undefined)
        .finally(() => this.studioUiRestores.delete(sessionId))
      this.studioUiRestores.set(sessionId, restore)
    }
    await restore
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
      operation.abortController.abort()
    }
    this.activeModelOperations.clear()

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
