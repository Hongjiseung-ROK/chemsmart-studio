import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetMock,
  processMessageMock,
  appGetPathMock,
  beginAgentTurnMock,
  broadcastMock,
  calculationHostRequestMock,
  claimSessionControlMock,
  completeAgentTurnMock,
  denyPendingApprovalsMock,
  ensureDefaultProjectMock,
  failAgentTurnMock,
  forwardMoleculeRequestMock,
  localProcessGetStatusMock,
  localProcessOptions,
  localProcessRequestMock,
  localProcessStartMock,
  localProcessStopMock,
  modelGetByKeyMock,
  projectionAppendTurnEventMock,
  projectionBeginTurnMock,
  projectionTerminalizeMock,
  projectionValidateComposerIntentMock,
  recordAgentToolCompletionMock,
  requestApprovalMock,
  verifyReportedAgentArtifactMock
} = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  processMessageMock: vi.fn(),
  appGetPathMock: vi.fn(),
  beginAgentTurnMock: vi.fn(),
  broadcastMock: vi.fn(),
  calculationHostRequestMock: vi.fn(),
  claimSessionControlMock: vi.fn(),
  completeAgentTurnMock: vi.fn(),
  denyPendingApprovalsMock: vi.fn(),
  ensureDefaultProjectMock: vi.fn(),
  failAgentTurnMock: vi.fn(),
  forwardMoleculeRequestMock: vi.fn(),
  localProcessGetStatusMock: vi.fn(),
  localProcessOptions: [] as Array<{
    args: (socketPath: string) => string[]
    environment?: NodeJS.ProcessEnv
    onStateChanged: (status: { state: string; pid: number | null; lastError: string | null }) => void
  }>,
  localProcessRequestMock: vi.fn(),
  localProcessStartMock: vi.fn(),
  localProcessStopMock: vi.fn(),
  modelGetByKeyMock: vi.fn(),
  projectionAppendTurnEventMock: vi.fn(),
  projectionBeginTurnMock: vi.fn(),
  projectionTerminalizeMock: vi.fn(),
  projectionValidateComposerIntentMock: vi.fn(),
  recordAgentToolCompletionMock: vi.fn(),
  requestApprovalMock: vi.fn(),
  verifyReportedAgentArtifactMock: vi.fn()
}))

vi.mock('@application', () => ({
  application: { get: appGetMock, getPath: appGetPathMock }
}))

vi.mock('@data/services/ModelService', () => ({
  modelService: { getByKey: modelGetByKeyMock }
}))

vi.mock('../LocalRpcProcess', () => ({
  LocalRpcProcess: class {
    constructor(options: (typeof localProcessOptions)[number]) {
      localProcessOptions.push(options)
    }

    getStatus() {
      return localProcessGetStatusMock()
    }

    start() {
      return localProcessStartMock()
    }

    stop() {
      return localProcessStopMock()
    }

    request(method: string, params: unknown, timeoutMs?: number) {
      return localProcessRequestMock(method, params, timeoutMs)
    }
  }
}))

import { ChemSmartAgentService } from '../ChemSmartAgentService'

type ServiceInternals = {
  handleSidecarRequest: (method: string, params: unknown) => Promise<unknown>
}

const commandInspectionResult = {
  schemaVersion: '1' as const,
  inspectionId: 'inspection-1',
  sessionId: 'session-1',
  status: 'ready_for_dry_run' as const,
  commandDigest: '32ad20595f72c605431991921c02936102d878a0a6eae684fa6d636f0122e440',
  parse: {
    accepted: true,
    action: 'run' as const,
    program: 'xtb' as const,
    job: 'opt',
    project: null,
    inputName: 'water.xyz',
    charge: '0',
    multiplicity: '1',
    method: {
      functional: null,
      abInitio: null,
      basis: null,
      auxBasis: null,
      solventModel: null,
      solventId: null
    }
  },
  intent: {
    verdict: 'ok' as const,
    failedRuleIds: [],
    assertions: [{ id: 'intent.kind', status: 'pass' as const }]
  },
  semantic: {
    verdict: 'warn' as const,
    complete: false as const,
    failedRuleIds: ['cmd.semantic.dry_run_required'],
    missingInfo: [],
    issues: [
      {
        ruleId: 'cmd.semantic.dry_run_required',
        severity: 'warn' as const,
        message: 'Dry run is required.'
      }
    ]
  },
  dryRun: { state: 'required' as const, processStarted: false as const },
  executionPerformed: false as const,
  approvalRequiredForExecution: true as const,
  missingInfo: [],
  extensions: {}
}
const commandSynthesisResult = {
  schemaVersion: '1' as const,
  synthesisId: 'synthesis-1',
  sessionId: 'session-1',
  status: 'ready' as const,
  command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt',
  commandDigest: '32ad20595f72c605431991921c02936102d878a0a6eae684fa6d636f0122e440',
  explanation: 'Prepared a bounded xTB optimization command.',
  projectName: null,
  missingInfo: [],
  intent: { verdict: 'ok' as const, failedRuleIds: [], message: 'Intent gate passed.', extensions: {} },
  semantic: { verdict: 'ok' as const, failedRuleIds: [], message: 'Semantic gate passed.', extensions: {} },
  publicEvidence: [
    {
      evidenceId: 'evidence-intent-1',
      kind: 'intentGate' as const,
      verdict: 'ok' as const,
      summary: 'Intent gate passed.',
      ruleIds: [],
      extensions: {}
    }
  ],
  executionPerformed: false as const,
  approvalRequiredForExecution: true as const,
  extensions: {}
}
const projectListResult = {
  schemaVersion: '1' as const,
  programs: [
    { program: 'gaussian' as const, projectRequired: true, projectNames: ['water'], extensions: {} },
    { program: 'orca' as const, projectRequired: true, projectNames: [], extensions: {} },
    { program: 'xtb' as const, projectRequired: false, projectNames: [], extensions: {} }
  ],
  extensions: {}
}
const advisoryTurnResult = {
  terminal_outcome: 'completed',
  advisory_only: true,
  assistant_output: 'Inspection complete.'
}

vi.mock('@main/features/apiGateway/proxyStream', () => ({
  processMessage: processMessageMock
}))

describe('ChemSmartAgentService trusted sidecar boundary', () => {
  let service: ChemSmartAgentService
  let internals: ServiceInternals
  const temporaryRoots: string[] = []

  beforeEach(() => {
    delete process.env.CHEMSMART_STUDIO_TEST_HARNESS
    vi.clearAllMocks()
    localProcessOptions.length = 0
    BaseService.resetInstances()
    appGetPathMock.mockImplementation((name: string) => `/mock/${name}`)
    appGetMock.mockImplementation((name: string) => {
      if (name === 'IpcApiService') return { broadcast: broadcastMock }
      if (name === 'CalculationRuntimeService') {
        return {
          handleHostRequest: calculationHostRequestMock,
          verifyReportedAgentArtifact: verifyReportedAgentArtifactMock
        }
      }
      if (name === 'StudioAgentProjectionService') {
        return {
          appendTurnEvent: projectionAppendTurnEventMock,
          beginTurn: projectionBeginTurnMock,
          terminalize: projectionTerminalizeMock,
          validateComposerIntent: projectionValidateComposerIntentMock
        }
      }
      if (name === 'StudioControlService') {
        return {
          beginAgentTurn: beginAgentTurnMock,
          claimSessionControl: claimSessionControlMock,
          completeAgentTurn: completeAgentTurnMock,
          denyPendingApprovals: denyPendingApprovalsMock,
          failAgentTurn: failAgentTurnMock,
          forwardMoleculeRequest: forwardMoleculeRequestMock,
          recordAgentToolCompletion: recordAgentToolCompletionMock,
          requestApproval: requestApprovalMock
        }
      }
      if (name === 'MoleculeProjectStore') {
        return {
          ensureDefaultProject: ensureDefaultProjectMock,
          getActiveProjectPath: () => '/projects/Untitled.cmsproj'
        }
      }
      if (name === 'MoleculeDocumentService') {
        return {
          getDocument: () => ({
            documentId: 'document-1',
            revision: 0,
            atoms: [],
            bonds: [],
            selections: [],
            frozenAxes: {},
            constraints: [],
            properties: { extensions: {} },
            extensions: {}
          })
        }
      }
      if (name === 'MoleculeWorkspaceService') return { applyTransientFocus: vi.fn() }
      throw new Error(`Unexpected application.get(${name})`)
    })
    ensureDefaultProjectMock.mockResolvedValue({ projectPath: '/projects/Untitled.cmsproj' })
    projectionBeginTurnMock.mockResolvedValue({ turnId: 'turn-1' })
    projectionTerminalizeMock.mockResolvedValue({ eventId: 'event-terminal' })
    projectionValidateComposerIntentMock.mockResolvedValue(undefined)
    localProcessGetStatusMock.mockReturnValue({ state: 'running', pid: 42, lastError: null })
    localProcessStartMock.mockResolvedValue({ state: 'running', pid: 42, lastError: null })
    localProcessStopMock.mockResolvedValue({ state: 'stopped', pid: null, lastError: null })
    modelGetByKeyMock.mockReturnValue({ apiModelId: 'model' })
    service = new ChemSmartAgentService()
    internals = service as unknown as ServiceInternals
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function invokeBoundAgentCallback(method: string, payload: Record<string, unknown>): Promise<unknown> {
    let callbackResult: unknown
    localProcessRequestMock.mockImplementation(async (rpcMethod: string, params: unknown) => {
      if (rpcMethod === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      const operationId = (params as { operationId: string }).operationId
      callbackResult = await internals.handleSidecarRequest(method, { ...payload, operationId })
      return advisoryTurnResult
    })
    await service.runTurn('session-1', 'provider::model', 'Exercise the host callback.', 'window-1')
    return callbackResult
  }

  it('rebinds a running sidecar to a new project after stopping active authority', async () => {
    await service.startAgent()

    await service.rebindProject('/projects/Second.cmsproj')

    expect(localProcessStopMock).toHaveBeenCalledOnce()
    expect(localProcessStartMock).toHaveBeenCalledTimes(2)
    expect(localProcessOptions[0].args('/runtime/agent.sock')).toContain('/projects/Second.cmsproj')
    expect(denyPendingApprovalsMock).toHaveBeenCalled()
  })

  it('prevents the sidecar from writing Python bytecode into the signed app bundle', async () => {
    await service.startAgent()

    expect(localProcessOptions[0].environment).toEqual({ PYTHONDONTWRITEBYTECODE: '1' })
  })

  it('serves an import through bounded opaque chunks without disclosing the path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chemsmart-agent-import-'))
    temporaryRoots.push(root)
    const source = path.join(root, 'water.xyz')
    const xyz = '1\nwater\nH 0 0 0\n'
    await writeFile(source, xyz, 'utf8')
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method !== 'molecule.import') throw new Error(`Unexpected request: ${method}`)
      expect(params).toEqual({
        capabilityId: expect.stringMatching(/^import-/),
        format: 'xyz',
        documentId: 'document-import',
        sizeBytes: Buffer.byteLength(xyz),
        extensions: {}
      })
      expect(JSON.stringify(params)).not.toContain(root)
      const request = params as { capabilityId: string }
      const chunk = (await internals.handleSidecarRequest('molecule.import_chunk', {
        capabilityId: request.capabilityId,
        offset: 0,
        length: 262_144,
        extensions: {}
      })) as { content: string; eof: boolean }
      expect(Buffer.from(chunk.content, 'base64').toString('utf8')).toBe(xyz)
      expect(chunk.eof).toBe(true)
      return {
        document: {
          documentId: 'document-import',
          revision: 0,
          atoms: [{ id: 'atom-1', atomicNumber: 1, position: [0, 0, 0], formalCharge: 0, extensions: {} }],
          bonds: [],
          selections: [],
          frozenAxes: {},
          constraints: [],
          properties: { charge: 0, multiplicity: 1, extensions: {} },
          extensions: {
            'chemsmart.import': {
              format: 'xyz',
              topology: 'inferred',
              algorithm: 'rdkit.DetermineConnectivity',
              algorithmVersion: 'test',
              reviewRequired: true
            }
          }
        },
        extensions: {}
      }
    })

    await expect(service.importMoleculeFile(source, 'document-import')).resolves.toMatchObject({
      documentId: 'document-import',
      revision: 0
    })
  })

  it('delegates an approval request without interpreting or rewriting its payload', async () => {
    const payload = {
      sessionId: 'session-1',
      requestId: 'request-1',
      tool: 'start_molecule_optimization',
      arguments: { engine: 'avogadro', method: 'UFF', settings: { maxSteps: 20, extensions: {} } }
    }
    const response = { decision: 'allow_once' as const }
    requestApprovalMock.mockResolvedValue(response)

    await expect(invokeBoundAgentCallback('approval.request', payload)).resolves.toBe(response)

    expect(requestApprovalMock).toHaveBeenCalledOnce()
    expect(requestApprovalMock.mock.calls[0][0]).toEqual(payload)
    expect(forwardMoleculeRequestMock).not.toHaveBeenCalled()
    expect(broadcastMock).not.toHaveBeenCalled()
  })

  it('publishes bounded public agent phases around a successful turn', async () => {
    localProcessRequestMock.mockImplementation(async (method: string) =>
      method === 'studio_ui.replay' ? { replayed: 0, nextSequence: 0 } : advisoryTurnResult
    )

    await expect(
      service.runTurn('session-1', 'provider::model', 'Inspect the molecule.', 'window-1')
    ).resolves.toBeUndefined()

    expect(claimSessionControlMock).toHaveBeenCalledWith('session-1', 'window-1')
    expect(beginAgentTurnMock).toHaveBeenCalledWith('session-1')
    expect(localProcessRequestMock).toHaveBeenCalledWith(
      'agent.run_turn',
      {
        sessionId: 'session-1',
        modelId: 'provider::model',
        operationId: expect.any(String),
        request: 'Inspect the molecule.',
        capability: 'inspect'
      },
      15 * 60 * 1000
    )
    expect(completeAgentTurnMock).toHaveBeenCalledWith('session-1')
    expect(failAgentTurnMock).not.toHaveBeenCalled()
  })

  it('publishes one schema-validated scientific result and rejects duplicate publication', async () => {
    const report = {
      answer: {
        answerId: 'answer-1',
        heading: 'Molecule inspection',
        summary: 'The visible molecule passed the requested inspection.',
        sections: [
          {
            kind: 'finding',
            heading: 'Finding',
            summary: 'The visible molecule has a valid closed-shell identity.'
          }
        ],
        extensions: {}
      },
      artifacts: [
        {
          artifactId: 'artifact-1',
          kind: 'verification',
          heading: 'Identity verification',
          summary: 'The visible molecule identity was verified.',
          documentId: 'document-1',
          revision: 0,
          geometryHash: `sha256:${'1'.repeat(64)}`,
          charge: 0,
          multiplicity: 1,
          verdict: 'passed',
          extensions: {}
        }
      ]
    }
    let duplicateError: unknown
    localProcessRequestMock.mockImplementation(async (_method: string, params: unknown) => {
      const operationId = (params as { operationId: string }).operationId
      await internals.handleSidecarRequest('agent.report_result', {
        sessionId: 'session-1',
        operationId,
        arguments: report
      })
      try {
        await internals.handleSidecarRequest('agent.report_result', {
          sessionId: 'session-1',
          operationId,
          arguments: report
        })
      } catch (error) {
        duplicateError = error
      }
      return { terminal_outcome: 'completed', advisory_only: false }
    })

    await service.runTurn('session-1', 'provider::model', 'Inspect the molecule.', 'window-1')

    expect(verifyReportedAgentArtifactMock).toHaveBeenCalledWith('session-1', report.artifacts[0])
    expect(projectionAppendTurnEventMock).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'turn-1',
      expect.objectContaining({ kind: 'artifact_published', artifact: report.artifacts[0] })
    )
    expect(projectionAppendTurnEventMock).toHaveBeenNthCalledWith(
      2,
      'session-1',
      'turn-1',
      expect.objectContaining({ kind: 'answer_published', answer: report.answer })
    )
    expect(duplicateError).toMatchObject({ code: -32003 })
  })

  it('rejects a cross-sender turn before starting or contacting the sidecar', async () => {
    claimSessionControlMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('Studio session is controlled by another window'), {
        code: 'FORBIDDEN_SENDER'
      })
    })

    await expect(
      service.runTurn('session-1', 'provider::model', 'Inspect the molecule.', 'window-2')
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })

    expect(beginAgentTurnMock).not.toHaveBeenCalled()
    expect(localProcessStartMock).not.toHaveBeenCalled()
    expect(localProcessRequestMock).not.toHaveBeenCalled()
  })

  it('rejects cross-sender activity replay before starting or contacting the sidecar', async () => {
    claimSessionControlMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('Studio session is controlled by another window'), {
        code: 'FORBIDDEN_SENDER'
      })
    })

    await expect(service.replayStudioUi('session-1', 0, 'window-2')).rejects.toMatchObject({
      code: 'FORBIDDEN_SENDER'
    })

    expect(localProcessStartMock).not.toHaveBeenCalled()
    expect(localProcessRequestMock).not.toHaveBeenCalled()
  })

  it('serializes one active turn per session and releases the guard after success', async () => {
    let releaseFirstTurn!: () => void
    let agentTurnCount = 0
    localProcessRequestMock.mockImplementation((method: string) => {
      if (method === 'studio_ui.replay') return Promise.resolve({ replayed: 0, nextSequence: 0 })
      agentTurnCount += 1
      if (agentTurnCount === 1) {
        return new Promise((resolve) => {
          releaseFirstTurn = () => resolve(advisoryTurnResult)
        })
      }
      return Promise.resolve(advisoryTurnResult)
    })

    const firstTurn = service.runTurn('session-1', 'provider::model', 'First request.', 'window-1')
    await vi.waitFor(() => expect(agentTurnCount).toBe(1))

    await expect(
      service.runTurn('session-1', 'provider::model', 'Duplicate request.', 'window-1')
    ).rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    expect(agentTurnCount).toBe(1)

    releaseFirstTurn()
    await expect(firstTurn).resolves.toBeUndefined()
    await expect(service.runTurn('session-1', 'provider::model', 'Next request.', 'window-1')).resolves.toBeUndefined()
    expect(agentTurnCount).toBe(2)
  })

  it('inspects a command through the non-agent RPC and validates its public result', async () => {
    localProcessRequestMock.mockResolvedValue(commandInspectionResult)

    await expect(
      service.inspectCommand({
        sessionId: 'session-1',
        command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt',
        intentDescription: 'Run a GFN2-xTB geometry optimization.'
      })
    ).resolves.toEqual(commandInspectionResult)

    expect(localProcessStartMock).toHaveBeenCalledOnce()
    expect(localProcessRequestMock).toHaveBeenCalledWith(
      'command.inspect',
      {
        sessionId: 'session-1',
        command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt',
        intentDescription: 'Run a GFN2-xTB geometry optimization.'
      },
      30_000
    )
    expect(beginAgentTurnMock).not.toHaveBeenCalled()
    expect(requestApprovalMock).not.toHaveBeenCalled()
  })

  it('fails closed on an invalid command inspection response', async () => {
    localProcessRequestMock.mockResolvedValue({
      ...commandInspectionResult,
      executionPerformed: true
    })

    await expect(
      service.inspectCommand({
        sessionId: 'session-1',
        command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt'
      })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'Command inspection returned an invalid result'
    })
  })

  it('rejects a command inspection result whose session or digest is not bound to the request', async () => {
    for (const result of [
      { ...commandInspectionResult, sessionId: 'session-other' },
      { ...commandInspectionResult, commandDigest: '0'.repeat(64) }
    ]) {
      localProcessRequestMock.mockResolvedValueOnce(result)
      await expect(
        service.inspectCommand({
          sessionId: 'session-1',
          command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt'
        })
      ).rejects.toMatchObject({
        code: -32603,
        message: 'Command inspection returned an invalid result'
      })
    }
  })

  it('drives the deterministic harness routes without an agent turn', async () => {
    localProcessRequestMock.mockResolvedValue(projectListResult)

    await expect(service.listProjects({ extensions: {} })).resolves.toEqual(projectListResult)

    expect(localProcessRequestMock).toHaveBeenCalledWith('project.list', { extensions: {} }, 120_000)
    // The researcher asked, so no model decided anything and no approval was needed.
    expect(beginAgentTurnMock).not.toHaveBeenCalled()
    expect(requestApprovalMock).not.toHaveBeenCalled()
  })

  it('binds direct synthesis to the managed sender, session, and authorized model', async () => {
    localProcessRequestMock.mockResolvedValue(commandSynthesisResult)
    const request = {
      sessionId: 'session-1',
      modelId: 'provider::model' as const,
      request: 'Optimize water.',
      extensions: {}
    }

    await expect(service.synthesizeCommand(request, 'window-1')).resolves.toEqual(commandSynthesisResult)

    expect(claimSessionControlMock).toHaveBeenCalledWith('session-1', 'window-1')
    const synthesisCall = localProcessRequestMock.mock.calls.find(([method]) => method === 'command.synthesize')
    expect(synthesisCall).toBeDefined()
    expect(synthesisCall![1]).toEqual({ ...request, operationId: expect.any(String) })
    // Python waits 120 seconds for the provider plus 10 seconds for the nested RPC response.
    expect(synthesisCall![2]).toBeGreaterThan(120_000 + 10_000)
    expect(beginAgentTurnMock).not.toHaveBeenCalled()
  })

  it('aborts an in-process live provider request when the sidecar is stopped', async () => {
    let providerSignal: AbortSignal | undefined
    const httpFetch = vi.fn()
    vi.stubGlobal('fetch', httpFetch)
    processMessageMock.mockImplementation((config: { signal?: AbortSignal }) => {
      providerSignal = config.signal
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (providerSignal?.aborted) abort()
        else providerSignal?.addEventListener('abort', abort, { once: true })
      })
    })
    localProcessRequestMock.mockImplementation((method: string, params: unknown) => {
      if (method !== 'command.synthesize') return Promise.resolve({ accepted: true })
      return internals.handleSidecarRequest('model.generate', {
        sessionId: 'session-1',
        modelId: 'provider::model',
        operationId: (params as { operationId: string }).operationId,
        messages: [{ role: 'user', content: 'Optimize water.' }],
        tools: [],
        timeoutMs: 120_000
      })
    })

    const synthesis = service.synthesizeCommand(
      {
        sessionId: 'session-1',
        modelId: 'provider::model',
        request: 'Optimize water.',
        extensions: {}
      },
      'window-1'
    )
    await vi.waitFor(() => expect(processMessageMock).toHaveBeenCalledOnce())
    expect(providerSignal?.aborted).toBe(false)
    // The provider is reached in process: no socket, no self-addressed HTTP request.
    expect(httpFetch).not.toHaveBeenCalled()
    expect(appGetMock).not.toHaveBeenCalledWith('ApiGatewayService')

    await service.stopAgent()

    expect(providerSignal?.aborted).toBe(true)
    await expect(synthesis).rejects.toMatchObject({ code: -32003, message: 'Host model request was cancelled' })
  })

  it('requests high reasoning effort for a DeepSeek Studio agent turn', async () => {
    modelGetByKeyMock.mockReturnValue({ apiModelId: 'deepseek-v4-pro' })
    processMessageMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Ready.' } }] }), { status: 200 })
    )
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      if (method === 'agent.run_turn') {
        await internals.handleSidecarRequest('model.generate', {
          sessionId: 'session-1',
          modelId: 'deepseek::deepseek-v4-pro',
          operationId: (params as { operationId: string }).operationId,
          messages: [{ role: 'user', content: 'Inspect the visible molecule.' }],
          tools: []
        })
      }
      return advisoryTurnResult
    })

    await service.runTurn('session-1', 'deepseek::deepseek-v4-pro', 'Inspect the visible molecule.', 'window-1')

    expect(processMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          model: 'deepseek:deepseek-v4-pro',
          reasoning_effort: 'high',
          stream: false
        })
      })
    )
  })

  it('refuses a project answer that is open-shaped or carries a filesystem path', async () => {
    localProcessRequestMock.mockResolvedValue({
      schemaVersion: '1',
      projectName: 'b3lyp-water',
      program: 'gaussian',
      yamlText: 'gas:\\n  include: /Users/someone/private/method.yaml\\n',
      path: '/Users/someone/.chemsmart/gaussian/b3lyp-water.yaml',
      extensions: {}
    })

    await expect(
      service.readProject({ projectName: 'b3lyp-water', program: 'gaussian', extensions: {} })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'project.read returned an invalid public result'
    })
  })

  it('refuses a schema-shaped answer carrying a root-level absolute path', async () => {
    localProcessRequestMock.mockResolvedValue({
      schemaVersion: '1',
      projectName: 'b3lyp-water',
      program: 'gaussian',
      yamlText: 'scratch: /tmp',
      extensions: {}
    })

    await expect(
      service.readProject({ projectName: 'b3lyp-water', program: 'gaussian', extensions: {} })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'project.read returned an invalid public result'
    })
  })

  it('refuses a filesystem path hidden in a nested public-result object key', async () => {
    localProcessRequestMock.mockResolvedValue({
      schemaVersion: '1',
      projectName: 'b3lyp-water',
      program: 'gaussian',
      yamlText: 'gas:\n  charge: 0\n',
      extensions: {
        'org.chemsmart.audit': {
          '/Users/someone/private/project.yaml': {}
        }
      }
    })

    await expect(
      service.readProject({ projectName: 'b3lyp-water', program: 'gaussian', extensions: {} })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'project.read returned an invalid public result'
    })
  })

  it.each([
    ['a POSIX path after punctuation', 'audit,/Users/alice/private/project.yaml'],
    ['a case-insensitive file URI', 'FILE:///Users/alice/private/project.yaml'],
    ['a UNC path', String.raw`\\server\share\private\project.yaml`]
  ])('refuses %s in a nested public-result value', async (_label, privateReference) => {
    localProcessRequestMock.mockResolvedValue({
      schemaVersion: '1',
      projectName: 'b3lyp-water',
      program: 'gaussian',
      yamlText: 'gas:\n  charge: 0\n',
      extensions: {
        'org.chemsmart.audit': {
          reference: privateReference
        }
      }
    })

    await expect(
      service.readProject({ projectName: 'b3lyp-water', program: 'gaussian', extensions: {} })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'project.read returned an invalid public result'
    })
  })

  it('rejects a project result that changes the requested project identity', async () => {
    localProcessRequestMock.mockResolvedValue({
      schemaVersion: '1',
      projectName: 'other-project',
      program: 'gaussian',
      yamlText: 'gas:\n  charge: 0\n',
      extensions: {}
    })

    await expect(
      service.readProject({ projectName: 'b3lyp-water', program: 'gaussian', extensions: {} })
    ).rejects.toMatchObject({
      code: -32603,
      message: 'project.read returned an invalid public result'
    })
  })

  it('fails closed when command synthesis is not exact-schema green', async () => {
    localProcessRequestMock.mockResolvedValue({
      ...commandSynthesisResult,
      workflowState: { cwd: '/Users/someone/research' }
    })

    await expect(
      service.synthesizeCommand(
        {
          sessionId: 'session-1',
          modelId: 'provider::model',
          request: 'Optimize water.',
          extensions: {}
        },
        'window-1'
      )
    ).rejects.toMatchObject({
      code: -32603,
      message: 'command.synthesize returned an invalid public result'
    })
  })

  it('rejects command synthesis whose session or digest is not bound to the result', async () => {
    const request = {
      sessionId: 'session-1',
      modelId: 'provider::model' as const,
      request: 'Optimize water.',
      extensions: {}
    }
    for (const result of [
      { ...commandSynthesisResult, sessionId: 'session-other' },
      { ...commandSynthesisResult, commandDigest: '0'.repeat(64) }
    ]) {
      localProcessRequestMock.mockResolvedValueOnce(result)
      await expect(service.synthesizeCommand(request, 'window-1')).rejects.toMatchObject({
        code: -32603,
        message: 'command.synthesize returned an invalid public result'
      })
    }
  })

  it('marks the public agent phase failed when a turn fails', async () => {
    localProcessRequestMock.mockImplementation(async (method: string) => {
      if (method === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      throw new Error('sidecar failed')
    })

    await expect(service.runTurn('session-1', 'provider::model', 'Inspect the molecule.', 'window-1')).rejects.toThrow(
      'sidecar failed'
    )

    expect(claimSessionControlMock).toHaveBeenCalledWith('session-1', 'window-1')
    expect(beginAgentTurnMock).toHaveBeenCalledWith('session-1')
    expect(failAgentTurnMock).toHaveBeenCalledWith('session-1')
    expect(completeAgentTurnMock).not.toHaveBeenCalled()

    localProcessRequestMock.mockResolvedValue(advisoryTurnResult)
    await expect(
      service.runTurn('session-1', 'provider::model', 'Retry after failure.', 'window-1')
    ).resolves.toBeUndefined()
    expect(completeAgentTurnMock).toHaveBeenCalledWith('session-1')
  })

  it('releases an active turn on stop and ignores its stale completion', async () => {
    let releaseStoppedTurn!: () => void
    let agentTurnCount = 0
    localProcessRequestMock.mockImplementation((method: string) => {
      if (method === 'studio_ui.replay') return Promise.resolve({ replayed: 0, nextSequence: 0 })
      agentTurnCount += 1
      if (agentTurnCount === 1) {
        return new Promise((resolve) => {
          releaseStoppedTurn = () => resolve(advisoryTurnResult)
        })
      }
      return Promise.resolve(advisoryTurnResult)
    })

    const stoppedTurn = service.runTurn('session-1', 'provider::model', 'Long request.', 'window-1')
    await vi.waitFor(() => expect(agentTurnCount).toBe(1))

    await service.stopAgent()
    expect(failAgentTurnMock).toHaveBeenCalledWith('session-1')

    await expect(
      service.runTurn('session-1', 'provider::model', 'Request after stop.', 'window-1')
    ).resolves.toBeUndefined()
    releaseStoppedTurn()
    await expect(stoppedTurn).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    expect(completeAgentTurnMock).toHaveBeenCalledTimes(1)
  })

  it('uses the explicit deterministic test model without touching the configured provider gateway', async () => {
    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'controlled-calculation'
    let response: {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>
    } | null = null
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      response = (await internals.handleSidecarRequest('model.generate', {
        sessionId: 'session-1',
        modelId: 'deterministic::controlled-calculation',
        operationId: (params as { operationId: string }).operationId,
        messages: [{ role: 'user', content: 'Run the controlled test.' }],
        tools: []
      })) as typeof response
      return advisoryTurnResult
    })

    await service.runTurn('session-1', 'deterministic::controlled-calculation', 'Run the controlled test.', 'window-1')

    expect(response).not.toBeNull()
    expect(response!.choices[0].message.tool_calls[0].function.name).toBe('analyze_current_molecule')
    expect(appGetMock).not.toHaveBeenCalledWith('ApiGatewayService')
  })

  it('rejects a model callback outside an active Studio operation', async () => {
    await expect(
      internals.handleSidecarRequest('model.generate', {
        sessionId: 'session-1',
        modelId: 'provider::model',
        messages: [{ role: 'user', content: 'Inspect.' }],
        tools: []
      })
    ).rejects.toMatchObject({
      code: -32003,
      message: 'Host model request is not bound to an active Studio operation'
    })
    expect(appGetMock).not.toHaveBeenCalledWith('ApiGatewayService')
  })

  it('rejects a timed-out operation token after a same-session retry starts', async () => {
    let staleOperationId = ''
    let turnCount = 0
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      turnCount += 1
      const operationId = (params as { operationId: string }).operationId
      if (turnCount === 1) {
        staleOperationId = operationId
        throw new Error('simulated outer timeout')
      }
      expect(operationId).not.toBe(staleOperationId)
      await expect(
        internals.handleSidecarRequest('model.generate', {
          sessionId: 'session-1',
          modelId: 'provider::model',
          operationId: staleOperationId,
          messages: [{ role: 'user', content: 'Late request from the timed-out handler.' }],
          tools: []
        })
      ).rejects.toMatchObject({
        code: -32003,
        message: 'Host model request is not bound to an active Studio operation'
      })
      return advisoryTurnResult
    })

    await expect(service.runTurn('session-1', 'provider::model', 'First.', 'window-1')).rejects.toThrow(
      'simulated outer timeout'
    )
    await expect(service.runTurn('session-1', 'provider::model', 'Retry.', 'window-1')).resolves.toBeUndefined()
    expect(appGetMock).not.toHaveBeenCalledWith('ApiGatewayService')
  })

  it.each([
    'approval.request',
    'molecule.request',
    'calculation.request',
    'agent.event',
    'agent.trace',
    'studio_ui.event'
  ])('rejects an unbound %s callback before delegation', async (method) => {
    await expect(
      internals.handleSidecarRequest(method, {
        sessionId: 'session-1',
        operationId: 'stale-operation'
      })
    ).rejects.toMatchObject({
      code: -32003,
      message: 'Host model request is not bound to an active Studio operation'
    })
  })

  it('does not authorize agent-only callbacks with a command-synthesis token', async () => {
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method !== 'command.synthesize') return { accepted: true }
      await expect(
        internals.handleSidecarRequest('molecule.request', {
          sessionId: 'session-1',
          operationId: (params as { operationId: string }).operationId,
          method: 'molecule.get_snapshot',
          params: {}
        })
      ).rejects.toMatchObject({ code: -32003 })
      return commandSynthesisResult
    })

    await expect(
      service.synthesizeCommand(
        {
          sessionId: 'session-1',
          modelId: 'provider::model',
          request: 'Optimize water.',
          extensions: {}
        },
        'window-1'
      )
    ).resolves.toEqual(commandSynthesisResult)
    expect(forwardMoleculeRequestMock).not.toHaveBeenCalled()
  })

  it('rejects a model callback that changes the active operation model', async () => {
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      await expect(
        internals.handleSidecarRequest('model.generate', {
          sessionId: 'session-1',
          modelId: 'provider::other-model',
          operationId: (params as { operationId: string }).operationId,
          messages: [{ role: 'user', content: 'Inspect.' }],
          tools: []
        })
      ).rejects.toMatchObject({
        code: -32003,
        message: 'Host model request changed the authorized model'
      })
      return advisoryTurnResult
    })

    await service.runTurn('session-1', 'provider::model', 'Inspect.', 'window-1')
    expect(appGetMock).not.toHaveBeenCalledWith('ApiGatewayService')
  })

  it.each([
    ['e7-xtb', 'deterministic::e7-xtb'],
    ['molecule-preview', 'deterministic::molecule-preview']
  ])('uses the explicit %s model without touching the configured provider gateway', async (harness, modelId) => {
    process.env.CHEMSMART_STUDIO_TEST_HARNESS = harness
    let response: {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>
    } | null = null
    localProcessRequestMock.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'studio_ui.replay') return { replayed: 0, nextSequence: 0 }
      response = (await internals.handleSidecarRequest('model.generate', {
        sessionId: 'session-1',
        modelId,
        operationId: (params as { operationId: string }).operationId,
        messages: [{ role: 'user', content: 'Run the bounded validation.' }],
        tools: []
      })) as typeof response
      return advisoryTurnResult
    })

    await service.runTurn('session-1', modelId as `${string}::${string}`, 'Run the bounded validation.', 'window-1')

    expect(response).not.toBeNull()
    expect(response!.choices[0].message.tool_calls[0].function.name).toBe('analyze_current_molecule')
    expect(appGetMock).not.toHaveBeenCalledWith('ApiGatewayService')
  })

  it('delegates a molecule request without interpreting or rewriting its payload', async () => {
    const payload = {
      sessionId: 'session-1',
      method: 'molecule.get_snapshot',
      params: {}
    }
    const response = { documentId: 'molecule-1', revision: 7 }
    forwardMoleculeRequestMock.mockResolvedValue(response)

    await expect(invokeBoundAgentCallback('molecule.request', payload)).resolves.toBe(response)

    expect(forwardMoleculeRequestMock).toHaveBeenCalledOnce()
    expect(forwardMoleculeRequestMock.mock.calls[0][0]).toEqual(payload)
    expect(requestApprovalMock).not.toHaveBeenCalled()
    expect(broadcastMock).not.toHaveBeenCalled()
  })

  it('delegates a schema-owned calculation request to the Electron-main runtime', async () => {
    const payload = {
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'get_studio_context',
        arguments: {}
      }
    }
    const response = {
      type: 'studio_context',
      sessionId: 'session-1',
      document: null,
      activeRun: null,
      extensions: {}
    }
    calculationHostRequestMock.mockResolvedValue(response)

    await expect(invokeBoundAgentCallback('calculation.request', payload)).resolves.toBe(response)

    expect(calculationHostRequestMock).toHaveBeenCalledOnce()
    expect(calculationHostRequestMock.mock.calls[0][0]).toEqual(payload)
    expect(recordAgentToolCompletionMock).toHaveBeenCalledWith('session-1', 'get_studio_context')
    expect(forwardMoleculeRequestMock).not.toHaveBeenCalled()
    expect(requestApprovalMock).not.toHaveBeenCalled()
  })

  it('acknowledges legacy agent events without exposing their payload to the renderer', async () => {
    const payload = {
      sessionId: 'session-1',
      event: 'tool_result',
      rawPayload: { providerMetadata: 'must-not-cross' }
    }

    await expect(invokeBoundAgentCallback('agent.event', payload)).resolves.toEqual({ accepted: true })

    expect(requestApprovalMock).not.toHaveBeenCalled()
    expect(forwardMoleculeRequestMock).not.toHaveBeenCalled()
    expect(calculationHostRequestMock).not.toHaveBeenCalled()
    expect(broadcastMock).not.toHaveBeenCalled()
  })

  it('rejects unknown sidecar methods', async () => {
    await expect(internals.handleSidecarRequest('molecule.raw_request', { payloadJson: '{}' })).rejects.toMatchObject({
      code: -32601,
      message: 'Method not found: molecule.raw_request'
    })

    expect(requestApprovalMock).not.toHaveBeenCalled()
    expect(forwardMoleculeRequestMock).not.toHaveBeenCalled()
    expect(broadcastMock).not.toHaveBeenCalled()
  })

  it('denies pending approvals when the sidecar stops or reports failure without spawning a process', async () => {
    await expect(service.stopAgent()).resolves.toEqual({ state: 'stopped', pid: null, lastError: null })
    expect(denyPendingApprovalsMock).toHaveBeenCalledOnce()

    denyPendingApprovalsMock.mockClear()
    await service.startAgent()
    expect(localProcessOptions).toHaveLength(1)

    localProcessOptions[0].onStateChanged({ state: 'failed', pid: null, lastError: 'sidecar exited' })

    expect(denyPendingApprovalsMock).toHaveBeenCalledOnce()
    expect(broadcastMock).toHaveBeenCalledWith('chemsmart_studio.agent.state_changed', {
      state: 'failed',
      pid: null,
      lastError: 'sidecar exited'
    })
  })
})
