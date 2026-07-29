import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import type {
  ControlledCalculationExternalFrame,
  ControlledCalculationTerminal,
  MoleculeDocument
} from '@chemsmart/studio-protocol'
import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock, getPathMock } = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  getPathMock: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: appGetMock, getPath: getPathMock } }))

import { type CalculationExecutionAdapter, CalculationRuntimeService } from '../CalculationRuntimeService'
import { e7XtbTestModelId, e7XtbTestModelResponse } from '../controlledCalculationTestHarness'
import { LocalRpcProcess } from '../LocalRpcProcess'

const timestamp = '2026-07-23T11:45:00.000Z'
const document: MoleculeDocument = {
  documentId: 'water-sidecar-fixture',
  revision: 4,
  atoms: [
    { id: 'atom-o1', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
    { id: 'atom-h1', atomicNumber: 1, position: [0.75716, 0, 0.58626], formalCharge: 0, extensions: {} },
    { id: 'atom-h2', atomicNumber: 1, position: [-0.75716, 0, 0.58626], formalCharge: 0, extensions: {} }
  ],
  bonds: [
    { id: 'bond-1', atomIds: ['atom-o1', 'atom-h1'], order: 1, extensions: {} },
    { id: 'bond-2', atomIds: ['atom-o1', 'atom-h2'], order: 1, extensions: {} }
  ],
  selections: [],
  frozenAxes: {},
  constraints: [],
  properties: { charge: 0, multiplicity: 1, extensions: {} },
  extensions: {}
}
const geometryHash = `sha256:${createHash('sha256')
  .update(
    JSON.stringify(
      document.atoms
        .map((atom) => [atom.id, atom.atomicNumber, atom.position] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    )
  )
  .digest('hex')}`

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for deterministic calculation completion')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('controlled calculation sidecar integration', () => {
  let calculationsRoot: string
  let projectRoot: string
  let runtimeRoot: string
  let sessionRoot: string
  let calculationService: CalculationRuntimeService
  let sidecar: LocalRpcProcess
  const studioControl = { consumePreparedCalculationGrant: vi.fn(), commitControlledRunStart: vi.fn() }

  beforeEach(async () => {
    BaseService.resetInstances()
    vi.clearAllMocks()
    calculationsRoot = await mkdtemp('/tmp/chemsmart-sidecar-calculations-')
    projectRoot = await mkdtemp('/tmp/chemsmart-sidecar-project-')
    runtimeRoot = await mkdtemp('/tmp/chemsmart-sidecar-runtime-')
    sessionRoot = await mkdtemp('/tmp/chemsmart-sidecar-sessions-')
    let activeRunId: string | null = null
    let mutationLockOwner: string | null = null
    const editor = {
      getMoleculeDocument: vi.fn().mockResolvedValue(structuredClone(document)),
      getMoleculeDraft: vi.fn(() => null),
      listOpenDocuments: vi.fn(() => ({
        activeProjectId: 'project-sidecar-fixture',
        documents: [{ projectId: 'project-sidecar-fixture', projectName: 'Water fixture' }]
      }))
    }
    const moleculeDocuments = {
      getDocument: vi.fn(() => structuredClone(document)),
      acquireMutationLock: vi.fn((runId: string) => {
        if (mutationLockOwner !== null && mutationLockOwner !== runId) throw new Error('Molecule mutation is locked')
        mutationLockOwner = runId
      }),
      releaseMutationLock: vi.fn((runId: string) => {
        if (mutationLockOwner === runId) mutationLockOwner = null
      }),
      getMutationLockOwner: vi.fn(() => mutationLockOwner)
    }
    const projectStore = {
      getActiveProjectPath: vi.fn(() => projectRoot),
      inspectProject: vi.fn(async () => ({ manifest: { activeRunId }, document: structuredClone(document) })),
      compareAndSetActiveRunId: vi.fn(async (expected: string | null, next: string | null) => {
        if (activeRunId !== expected) throw new Error('Active run compare-and-set failed')
        activeRunId = next
      }),
      releaseActiveRunId: vi.fn(async (runId: string) => {
        if (activeRunId === runId) activeRunId = null
      })
    }
    const agent = {
      requestTrajectory: vi.fn((method: string, params: unknown) => sidecar.request(method, params, 30_000))
    }
    studioControl.consumePreparedCalculationGrant.mockReset()
    appGetMock.mockImplementation((name: string) => {
      if (name === 'MoleculeWorkspaceService') {
        return editor
      }
      if (name === 'StudioControlService') {
        return studioControl
      }
      if (name === 'MoleculeDocumentService') return moleculeDocuments
      if (name === 'MoleculeProjectStore') return projectStore
      if (name === 'ChemSmartAgentService') return agent
      throw new Error(`Unexpected application.get(${name})`)
    })
    getPathMock.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.calculations') return calculationsRoot
      throw new Error(`Unexpected application.getPath(${key})`)
    })
    calculationService = new CalculationRuntimeService()
    calculationService.configureExecutable({
      kind: 'local_executable',
      engine: 'xtb',
      version: 'deterministic-sidecar-test',
      architecture: 'arm64',
      executableDigest: `sha256:${'a'.repeat(64)}`,
      runtimeFingerprint: `sha256:${'b'.repeat(64)}`,
      libraries: [],
      verifiedAt: timestamp
    })
  })

  afterEach(async () => {
    await sidecar?.stop()
    await calculationService?._doStop()
    await Promise.all(
      [calculationsRoot, projectRoot, runtimeRoot, sessionRoot]
        .filter(Boolean)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  it('routes the bounded E7 xTB harness through real AgentSession and deterministic host execution', async () => {
    const frame: ControlledCalculationExternalFrame = {
      type: 'controlled_calculation_frame',
      runId: 'replaced-after-reservation',
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
      energy: { value: -3.14, unit: 'hartree' },
      forceMetrics: { max: 0.02, rms: 0.01, unit: 'hartree/bohr' },
      structureHash: geometryHash,
      timestamp,
      extensions: {}
    }
    const fakeAdapter: CalculationExecutionAdapter = {
      kind: 'fake',
      async *execute(reservation) {
        const boundFrame = { ...frame, runId: reservation.runId }
        const terminal: ControlledCalculationTerminal = {
          type: 'controlled_calculation_terminal',
          runId: reservation.runId,
          status: 'completed',
          frameCount: 1,
          outputGeometryHash: geometryHash,
          completedAt: timestamp,
          extensions: {}
        }
        yield boundFrame
        yield terminal
      }
    }
    calculationService.configureFakeExecutionAdapter(fakeAdapter)

    let runId: string | null = null
    let approvalCount = 0
    const validatedPlan: { value: { planId: string; planDigest: string } | null } = { value: null }
    const calculationRequests: unknown[] = []
    const calculationResponses: unknown[] = []
    const agentTraceEvents: unknown[] = []
    const modelMessages: unknown[][] = []
    sidecar = new LocalRpcProcess({
      name: 'controlled-sidecar-test',
      command: 'uv',
      args: (socketPath) => [
        'run',
        '--project',
        path.join(process.cwd(), 'services/chemsmart_bridge'),
        '--frozen',
        'chemsmart-studio-bridge',
        '--socket',
        socketPath,
        '--session-root',
        sessionRoot,
        '--project-root',
        projectRoot
      ],
      cwd: path.join(process.cwd(), 'services/chemsmart_bridge'),
      runtimeDirectory: runtimeRoot,
      incomingHandler: async (method, params) => {
        if (method === 'model.generate') {
          const messages =
            params !== null && typeof params === 'object' && 'messages' in params && Array.isArray(params.messages)
              ? params.messages
              : []
          const tools =
            params !== null && typeof params === 'object' && 'tools' in params && Array.isArray(params.tools)
              ? params.tools
              : []
          modelMessages.push(structuredClone(messages))
          return e7XtbTestModelResponse(messages, tools)
        }
        if (method === 'approval.request') {
          approvalCount += 1
          return { decision: 'allow_once' }
        }
        if (method === 'calculation.request') {
          calculationRequests.push(structuredClone(params))
          const response = await calculationService.handleHostRequest(params)
          calculationResponses.push(structuredClone(response))
          if ('type' in response && response.type === 'controlled_calculation_reservation') runId = response.runId
          if ('state' in response && response.state === 'validated') {
            validatedPlan.value = { planId: response.planId, planDigest: response.planDigest }
          }
          return response
        }
        if (method === 'agent.trace') {
          agentTraceEvents.push(structuredClone(params))
          return { accepted: true }
        }
        if (method === 'agent.event') return { accepted: true }
        throw new Error(`Unexpected sidecar callback: ${method}`)
      },
      onStateChanged: () => {}
    })

    await expect(sidecar.start()).resolves.toMatchObject({ state: 'running' })
    const prepared = (await sidecar.request(
      'agent.run_turn',
      {
        sessionId: 'session-sidecar-integration',
        modelId: e7XtbTestModelId,
        request: 'Prepare and validate the bounded GFN2-xTB plan.',
        capability: 'plan'
      },
      30_000
    )) as {
      assistant_output: string
      tool_outcomes: Array<{ status: string }>
    }
    const currentMoleculeAnalysis = calculationResponses.find(
      (response) =>
        response !== null &&
        typeof response === 'object' &&
        'type' in response &&
        response.type === 'current_molecule_analysis'
    )
    expect(currentMoleculeAnalysis).toMatchObject({
      type: 'current_molecule_analysis',
      atomCount: 3,
      bondCount: 2,
      elementCounts: [
        { atomicNumber: 1, count: 2 },
        { atomicNumber: 8, count: 1 }
      ],
      formula: 'H2O',
      charge: 0,
      multiplicity: 1
    })

    expect(prepared.assistant_output).toBe(
      'The bounded GFN2-xTB validation plan is validated and awaiting separate start approval.'
    )
    expect(prepared.tool_outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok', 'ok'])
    expect(calculationRequests).toMatchObject([
      { request: { tool: 'analyze_current_molecule', arguments: {} } },
      { request: { tool: 'prepare_molecule_optimization' } },
      { request: { tool: 'validate_prepared_optimization' } }
    ])
    expect(approvalCount).toBe(0)
    expect(agentTraceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'turn_started' }),
        expect.objectContaining({ kind: 'reasoning_summary' }),
        expect.objectContaining({ kind: 'tool_started' }),
        expect.objectContaining({ kind: 'tool_succeeded' }),
        expect.objectContaining({ kind: 'turn_completed' })
      ])
    )
    const xTBPlan = validatedPlan.value
    if (!xTBPlan) throw new Error('The deterministic xTB plan was not validated')

    const started = (await sidecar.request(
      'agent.run_turn',
      {
        sessionId: 'session-sidecar-integration',
        modelId: e7XtbTestModelId,
        request: `Start the validated controlled plan ${xTBPlan.planId} ${xTBPlan.planDigest}.`,
        capability: 'act'
      },
      30_000
    )) as {
      assistant_output: string
      tool_outcomes: Array<{ status: string }>
    }

    expect(modelMessages.at(-1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: `Start the validated controlled plan ${xTBPlan.planId} ${xTBPlan.planDigest}.`
        })
      ])
    )
    expect(started.assistant_output).toBe('The bounded GFN2-xTB validation calculation was approved and started.')
    expect(started.tool_outcomes.map((outcome) => outcome.status)).toEqual(['ok'])
    expect(calculationRequests).toHaveLength(4)
    expect(approvalCount).toBe(1)
    expect(studioControl.consumePreparedCalculationGrant).toHaveBeenCalledWith(
      'session-sidecar-integration',
      expect.stringMatching(/^plan-/),
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    )
    expect(runId).toEqual(expect.any(String))
    await waitFor(() => runId !== null && calculationService.getRunSnapshot(runId).terminal !== null)
    expect(calculationService.getRunSnapshot(runId!)).toMatchObject({
      frameCount: 1,
      terminal: { status: 'completed', outputGeometryHash: geometryHash }
    })
  }, 30_000)
})
