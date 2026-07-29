import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  ControlledCalculationExecutableIdentity,
  ControlledCalculationExternalFrame,
  ControlledCalculationTerminal,
  MoleculeDocument,
  OptimizationFinalDecisionEvent,
  OptimizationRun
} from '@chemsmart/studio-protocol'
import { BaseService, Phase } from '@main/core/lifecycle'
import { getDependencies, getPhase } from '@main/core/lifecycle/decorators'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock, getPathMock } = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  getPathMock: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: appGetMock, getPath: getPathMock } }))

import { type CalculationExecutionAdapter, CalculationRuntimeService } from '../CalculationRuntimeService'
import { XtbCalculationAdapter } from '../XtbCalculationAdapter'

const timestamp = '2026-07-23T05:30:00.000Z'
const document: MoleculeDocument = {
  documentId: 'ethanol-fixture',
  revision: 7,
  atoms: [
    { id: 'atom-c1', atomicNumber: 6, position: [0, 0, 0], formalCharge: 0, extensions: {} },
    { id: 'atom-o1', atomicNumber: 8, position: [1.4, 0, 0], formalCharge: 0, extensions: {} }
  ],
  bonds: [{ id: 'bond-1', atomIds: ['atom-c1', 'atom-o1'], order: 1, extensions: {} }],
  selections: [],
  frozenAxes: {},
  constraints: [],
  properties: { charge: 0, multiplicity: 1, extensions: {} },
  extensions: {}
}
const documentGeometryHash = `sha256:${createHash('sha256')
  .update(
    JSON.stringify(
      document.atoms
        .map((atom) => [atom.id, atom.atomicNumber, atom.position] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    )
  )
  .digest('hex')}`
const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const executable: ControlledCalculationExecutableIdentity = {
  kind: 'local_executable',
  engine: 'xtb',
  version: 'fake-test-runtime',
  architecture: 'arm64',
  executableDigest: digestA,
  runtimeFingerprint: digestB,
  libraries: [],
  verifiedAt: timestamp
}
describe('CalculationRuntimeService controlled fake execution', () => {
  const editor = {
    getMoleculeDocument: vi.fn(),
    getMoleculeDraft: vi.fn(),
    listOpenDocuments: vi.fn()
  }
  const studioControl = {
    consumePreparedCalculationGrant: vi.fn(),
    commitControlledRunStart: vi.fn(),
    getTrustedRenderBinding: vi.fn()
  }
  const moleculeDocuments = {
    getDocument: vi.fn(),
    acquireMutationLock: vi.fn(),
    releaseMutationLock: vi.fn(),
    getMutationLockOwner: vi.fn(),
    commitFinalGeometry: vi.fn()
  }
  const projectStore = {
    getActiveProjectPath: vi.fn(() => '/tmp/calculation-runtime.cmsproj'),
    inspectProject: vi.fn(),
    compareAndSetActiveRunId: vi.fn(),
    releaseActiveRunId: vi.fn()
  }
  const agent = {
    requestTrajectory: vi.fn()
  }
  let activeRunId: string | null
  let mutationLockOwner: string | null
  let currentDocument: MoleculeDocument
  let trajectoryRuns: Map<
    string,
    {
      run: OptimizationRun
      frames: ControlledCalculationExternalFrame[]
      terminal: ControlledCalculationTerminal | null
      finalEvents: OptimizationFinalDecisionEvent[]
    }
  >
  let calculationsRoot: string
  let service: CalculationRuntimeService

  beforeEach(async () => {
    delete process.env.CHEMSMART_STUDIO_TEST_HARNESS
    vi.useFakeTimers()
    vi.setSystemTime(new Date(timestamp))
    vi.clearAllMocks()
    BaseService.resetInstances()
    calculationsRoot = await mkdtemp(path.join(tmpdir(), 'chemsmart-calculation-runtime-'))
    editor.getMoleculeDocument.mockResolvedValue(structuredClone(document))
    editor.getMoleculeDraft.mockReturnValue(null)
    editor.listOpenDocuments.mockReturnValue({
      activeProjectId: 'project-ethanol',
      documents: [{ projectId: 'project-ethanol', projectName: 'Ethanol' }]
    })
    studioControl.getTrustedRenderBinding.mockReturnValue({
      displayState: 'committed',
      documentId: document.documentId,
      revision: document.revision
    })
    currentDocument = structuredClone(document)
    activeRunId = null
    mutationLockOwner = null
    trajectoryRuns = new Map()
    moleculeDocuments.getDocument.mockImplementation(() => structuredClone(currentDocument))
    moleculeDocuments.acquireMutationLock.mockImplementation((runId: string) => {
      if (mutationLockOwner !== null && mutationLockOwner !== runId) throw new Error('Molecule mutation is locked')
      mutationLockOwner = runId
    })
    moleculeDocuments.releaseMutationLock.mockImplementation((runId: string) => {
      if (mutationLockOwner === runId) mutationLockOwner = null
    })
    moleculeDocuments.getMutationLockOwner.mockImplementation(() => mutationLockOwner)
    moleculeDocuments.commitFinalGeometry.mockImplementation(
      async (runId: string, next: Pick<MoleculeDocument, 'documentId' | 'atoms'>, expectedRevision: number) => {
        if (mutationLockOwner !== runId || currentDocument.revision !== expectedRevision) {
          throw new Error('Final geometry ownership mismatch')
        }
        currentDocument = {
          ...currentDocument,
          atoms: structuredClone(next.atoms),
          revision: expectedRevision + 1,
          selections: []
        }
        return structuredClone(currentDocument)
      }
    )
    projectStore.inspectProject.mockImplementation(async () => ({
      manifest: { activeRunId },
      document: structuredClone(currentDocument)
    }))
    projectStore.compareAndSetActiveRunId.mockImplementation(async (expected: string | null, next: string | null) => {
      if (activeRunId !== expected) throw new Error('Active run compare-and-set failed')
      activeRunId = next
    })
    projectStore.releaseActiveRunId.mockImplementation(async (runId: string) => {
      if (activeRunId === runId) activeRunId = null
    })
    agent.requestTrajectory.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'optimization.open_run') {
        const run = structuredClone(params.run) as OptimizationRun
        trajectoryRuns.set(run.runId, { run, frames: [], terminal: null, finalEvents: [] })
        return { runId: run.runId, extensions: {} }
      }
      if (method === 'optimization.append_run_frame') {
        const frame = structuredClone(params.frame) as ControlledCalculationExternalFrame
        const state = trajectoryRuns.get(frame.runId)
        if (!state) throw new Error('Trajectory run is not open')
        state.frames.push(frame)
        return { accepted: true, runId: frame.runId, frameIndex: frame.frameIndex, extensions: {} }
      }
      if (method === 'optimization.close_run') {
        const terminal = structuredClone(params.terminal) as ControlledCalculationTerminal
        const state = trajectoryRuns.get(terminal.runId)
        if (!state) throw new Error('Trajectory run is not open')
        state.terminal = terminal
        return {
          runId: terminal.runId,
          outcome: terminal.status === 'completed' ? 'awaiting_final_geometry' : terminal.status,
          extensions: {}
        }
      }
      if (method === 'optimization.record_final_event') {
        const event = structuredClone(params.event) as OptimizationFinalDecisionEvent
        const state = trajectoryRuns.get(event.runId)
        if (!state) throw new Error('Trajectory run is not open')
        state.finalEvents.push(event)
        return { accepted: true, event, extensions: {} }
      }
      if (method === 'optimization.run_state') {
        const runId = params.runId as string
        const state = trajectoryRuns.get(runId)
        if (!state) throw new Error('Trajectory run is not open')
        const latestEvent = state.finalEvents.at(-1) ?? null
        const outcome =
          latestEvent?.type === 'optimization_final_accepted'
            ? 'accepted'
            : latestEvent?.type === 'optimization_final_rejected'
              ? 'rejected'
              : state.terminal?.status === 'completed'
                ? 'awaiting_final_geometry'
                : (state.terminal?.status ?? 'running')
        return {
          run: structuredClone(state.run),
          frameCount: state.frames.length,
          latestFrame: structuredClone(state.frames.at(-1) ?? null),
          terminal: structuredClone(state.terminal),
          outcome,
          latestFinalEvent: structuredClone(latestEvent),
          extensions: {}
        }
      }
      throw new Error(`Unexpected trajectory method: ${method}`)
    })
    studioControl.consumePreparedCalculationGrant.mockReset()
    appGetMock.mockImplementation((name: string) => {
      if (name === 'MoleculeWorkspaceService') return editor
      if (name === 'StudioControlService') return studioControl
      if (name === 'MoleculeDocumentService') return moleculeDocuments
      if (name === 'MoleculeProjectStore') return projectStore
      if (name === 'ChemSmartAgentService') return agent
      throw new Error(`Unexpected application.get(${name})`)
    })
    getPathMock.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.calculations') return calculationsRoot
      throw new Error(`Unexpected application.getPath(${key})`)
    })
    service = new CalculationRuntimeService()
    service.configureExecutable(executable)
  })

  async function createCancelledRun(includeOutputArtifact = false) {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    const outputPath = path.join(calculationsRoot, reservation.runId, 'engine', 'result.txt')
    await service.executeReservedCalculation(reservation, {
      kind: 'fake',
      async *execute() {
        if (includeOutputArtifact) {
          await mkdir(path.dirname(outputPath), { mode: 0o700 })
          await writeFile(outputPath, 'deterministic output\n', { mode: 0o600 })
        }
        yield {
          type: 'controlled_calculation_terminal',
          runId: reservation.runId,
          status: 'cancelled',
          frameCount: 0,
          reason: 'Deterministic artifact test',
          terminatedAt: timestamp,
          extensions: {}
        }
      },
      getArtifactSources: includeOutputArtifact
        ? () => [
            {
              key: 'result',
              kind: 'output',
              displayName: 'Deterministic output',
              mediaType: 'text/plain',
              filePath: outputPath
            }
          ]
        : undefined
    })
    return reservation
  }

  async function createCompletedRun() {
    const plan = await service.prepareCalculation({
      sessionId: 'session-final',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    const frame: ControlledCalculationExternalFrame = {
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
      energy: { value: -3.14, unit: 'hartree' },
      forceMetrics: { max: 0.02, rms: 0.01, unit: 'hartree/bohr' },
      structureHash: documentGeometryHash,
      timestamp,
      extensions: {}
    }
    const terminal: ControlledCalculationTerminal = {
      type: 'controlled_calculation_terminal',
      runId: reservation.runId,
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: frame.structureHash,
      completedAt: timestamp,
      extensions: {}
    }
    await service.executeReservedCalculation(reservation, {
      kind: 'fake',
      async *execute() {
        yield frame
        yield terminal
      }
    })
    return { plan, reservation, frame, terminal }
  }

  afterEach(async () => {
    delete process.env.CHEMSMART_STUDIO_TEST_HARNESS
    delete process.env.CHEMSMART_STUDIO_XTB_EXECUTABLE
    delete process.env.CHEMSMART_STUDIO_XTB_PATH
    await service._doStop()
    await rm(calculationsRoot, { recursive: true, force: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is a WhenReady lifecycle service ordered after the molecule, workspace, and project owners', () => {
    expect(getPhase(CalculationRuntimeService)).toBe(Phase.WhenReady)
    expect(getDependencies(CalculationRuntimeService)).toEqual([
      'MoleculeDocumentService',
      'MoleculeWorkspaceService',
      'MoleculeProjectStore'
    ])
  })

  it('enables a development-only deterministic adapter without launching a local process', async () => {
    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'controlled-calculation'
    await (service as unknown as { onInit(): Promise<void> }).onInit()
    studioControl.consumePreparedCalculationGrant.mockImplementation(() => undefined)

    const plan = await service.prepareCalculation({
      sessionId: 'session-harness',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 10,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    const validated = await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-harness',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'start_prepared_optimization',
        arguments: { plan_id: validated.planId, plan_digest: validated.planDigest }
      }
    })
    if (!('type' in reservation) || reservation.type !== 'controlled_calculation_reservation') {
      throw new Error('Expected reservation')
    }

    await vi.waitFor(() => expect(service.getRunSnapshot(reservation.runId).terminal).not.toBeNull())
    expect(service.getRunSnapshot(reservation.runId)).toMatchObject({
      frameCount: 1,
      latestFrame: {
        energy: { value: 0, unit: 'hartree' },
        gradientNorm: { value: 0, unit: 'hartree/bohr' }
      },
      terminal: { status: 'completed', outputGeometryHash: documentGeometryHash }
    })
    expect(studioControl.consumePreparedCalculationGrant).toHaveBeenCalledOnce()
  })

  it('does not substitute the fake adapter for the E7 real xTB harness', async () => {
    process.env.CHEMSMART_STUDIO_TEST_HARNESS = 'e7-xtb'
    delete process.env.CHEMSMART_STUDIO_XTB_EXECUTABLE
    delete process.env.CHEMSMART_STUDIO_XTB_PATH
    await (service as unknown as { onInit(): Promise<void> }).onInit()

    const plan = await service.prepareCalculation({
      sessionId: 'session-e7-xtb',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 100,
        maxRuntimeSeconds: 120,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    const validated = await service.validateCalculation(plan.planId, plan.planDigest)

    expect(() => service.getPreparedPlanForApproval('session-e7-xtb', validated.planId, validated.planDigest)).toThrow(
      'No trusted controlled execution runtime is configured'
    )
  })

  it('binds a plan to trusted geometry and durably records a full fake run before publishing frames', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    expect(plan.binding).toMatchObject({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision
    })
    expect(plan.settingsDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const validated = await service.validateCalculation(plan.planId, plan.planDigest)
    expect(validated.state).toBe('validated')
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)

    const frame: ControlledCalculationExternalFrame = {
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
      energy: { value: -3.14, unit: 'hartree' },
      forceMetrics: { max: 0.02, rms: 0.01, unit: 'hartree/bohr' },
      structureHash: plan.binding.geometryHash,
      timestamp,
      extensions: {}
    }
    const terminal: ControlledCalculationTerminal = {
      type: 'controlled_calculation_terminal',
      runId: reservation.runId,
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: frame.structureHash,
      completedAt: timestamp,
      extensions: {}
    }
    const adapter: CalculationExecutionAdapter = {
      kind: 'fake',
      async *execute() {
        yield frame
        yield terminal
      }
    }
    const observedLedgers: string[] = []
    const lifecycleEvents: string[] = []
    service.onRunStarted((event) => lifecycleEvents.push(`started:${event.reservation.runId}`))
    service.onFrameCommitted(() => {
      lifecycleEvents.push(`frame:${frame.frameIndex}`)
      observedLedgers.push(readFileSync(path.join(calculationsRoot, reservation.runId, 'ledger.jsonl'), 'utf8'))
    })
    service.onTerminalCommitted((event) => lifecycleEvents.push(`terminal:${event.status}`))

    await expect(service.executeReservedCalculation(reservation, adapter)).resolves.toEqual(terminal)
    expect(agent.requestTrajectory).toHaveBeenCalledWith(
      'optimization.open_run',
      expect.objectContaining({ run: expect.objectContaining({ runId: reservation.runId }) })
    )
    expect(agent.requestTrajectory).toHaveBeenCalledWith('optimization.append_run_frame', { frame })
    expect(agent.requestTrajectory).toHaveBeenCalledWith('optimization.close_run', { terminal })
    expect(observedLedgers).toHaveLength(1)
    expect(lifecycleEvents).toEqual([`started:${reservation.runId}`, 'frame:0', 'terminal:completed'])
    expect(observedLedgers[0]).toContain(`"runId":"${reservation.runId}"`)
    expect(observedLedgers[0]).toContain('"type":"controlled_calculation_frame"')

    const ledger = await readFile(path.join(calculationsRoot, reservation.runId, 'ledger.jsonl'), 'utf8')
    const records = ledger
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.map((record) => record.type)).toEqual([
      'controlled_calculation_reservation',
      'controlled_calculation_frame',
      'controlled_calculation_terminal'
    ])
    expect((await stat(calculationsRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(calculationsRoot, 'plans', `${plan.planId}.json`))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(calculationsRoot, reservation.runId))).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(calculationsRoot, reservation.runId, 'ledger.jsonl'))).mode & 0o777).toBe(0o600)
    expect(service.getRunSnapshot(reservation.runId)).toMatchObject({ frameCount: 1, terminal })
  })

  it('keeps a completed run locked until acceptance durably commits the exact final frame', async () => {
    const { reservation, frame } = await createCompletedRun()

    expect(activeRunId).toBe(reservation.runId)
    expect(mutationLockOwner).toBe(reservation.runId)
    await expect(service.acceptFinalGeometry(reservation.runId, document.revision)).resolves.toEqual({
      type: 'optimization_final_commit',
      runId: reservation.runId,
      revision: document.revision + 1,
      timestamp,
      geometryHash: frame.structureHash
    })

    expect(currentDocument).toMatchObject({
      documentId: document.documentId,
      revision: document.revision + 1,
      atoms: frame.positions.map((position, index) => ({
        ...document.atoms[index],
        position
      }))
    })
    expect(trajectoryRuns.get(reservation.runId)?.finalEvents.map((event) => event.type)).toEqual([
      'optimization_final_accept_requested',
      'optimization_final_accepted'
    ])
    expect(activeRunId).toBeNull()
    expect(mutationLockOwner).toBeNull()
  })

  it('recovers a torn acceptance from the sidecar event and exact durable geometry hashes', async () => {
    const candidate = await createCompletedRun()
    await agent.requestTrajectory('optimization.record_final_event', {
      event: {
        type: 'optimization_final_accept_requested',
        runId: candidate.reservation.runId,
        expectedRevision: document.revision,
        geometryHash: candidate.frame.structureHash,
        timestamp
      }
    })
    const trajectoryState = await agent.requestTrajectory('optimization.run_state', {
      runId: candidate.reservation.runId
    })
    expect(trajectoryState).toMatchObject({
      run: {
        runId: candidate.reservation.runId,
        documentId: candidate.plan.binding.documentId,
        inputRevision: candidate.plan.binding.expectedRevision
      },
      frameCount: candidate.terminal.frameCount,
      latestFrame: candidate.frame,
      terminal: candidate.terminal
    })
    expect((trajectoryState as { latestFrame: unknown }).latestFrame).toEqual(candidate.frame)
    expect((trajectoryState as { terminal: unknown }).terminal).toEqual(candidate.terminal)

    await expect(service.recoverFinalDecision({ ...candidate, latestFrame: candidate.frame })).resolves.toBe('accepted')
    expect(currentDocument.revision).toBe(document.revision + 1)
    expect(trajectoryRuns.get(candidate.reservation.runId)?.finalEvents.map((event) => event.type)).toEqual([
      'optimization_final_accept_requested',
      'optimization_final_accepted'
    ])
    expect(activeRunId).toBeNull()
    expect(mutationLockOwner).toBeNull()
  })

  it('rejects a completed run without changing the revision and releases ownership', async () => {
    const { reservation } = await createCompletedRun()

    await expect(service.rejectFinalGeometry(reservation.runId)).resolves.toEqual({
      type: 'optimization_final_rejected',
      runId: reservation.runId,
      revision: document.revision,
      timestamp
    })
    expect(currentDocument).toEqual(document)
    expect(trajectoryRuns.get(reservation.runId)?.finalEvents.map((event) => event.type)).toEqual([
      'optimization_final_reject_requested',
      'optimization_final_rejected'
    ])
    expect(activeRunId).toBeNull()
    expect(mutationLockOwner).toBeNull()
  })

  it('recovers only a fully validated completed run from the main-owned plan and ledger', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-recovery-owner',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    const validated = await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    const frame: ControlledCalculationExternalFrame = {
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
      energy: { value: -3.14, unit: 'hartree' },
      forceMetrics: { max: 0.02, rms: 0.01, unit: 'hartree/bohr' },
      structureHash: documentGeometryHash,
      timestamp,
      extensions: {}
    }
    const terminal: ControlledCalculationTerminal = {
      type: 'controlled_calculation_terminal',
      runId: reservation.runId,
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: frame.structureHash,
      completedAt: timestamp,
      extensions: {}
    }
    await service.executeReservedCalculation(reservation, {
      kind: 'fake',
      async *execute() {
        yield frame
        yield terminal
      }
    })

    await service._doStop()
    BaseService.resetInstances()
    const recoveredService = new CalculationRuntimeService()
    await (recoveredService as unknown as { onInit(): Promise<void> }).onInit()
    service = recoveredService

    expect(service.getRecoverableFinalDecisions()).toEqual([
      {
        plan: validated,
        reservation,
        latestFrame: frame,
        terminal
      }
    ])
    expect(service.getRunSnapshot(reservation.runId)).toMatchObject({ frameCount: 1, latestFrame: frame, terminal })
  })

  it('refuses a durable run whose persisted plan no longer matches its reservation', async () => {
    const reservation = await createCancelledRun()
    const planPath = path.join(calculationsRoot, 'plans', `${reservation.planId}.json`)
    const persistedPlan = JSON.parse(await readFile(planPath, 'utf8'))
    persistedPlan.binding.sessionId = 'session-forged-after-run'
    await writeFile(planPath, `${JSON.stringify(persistedPlan)}\n`)

    await service._doStop()
    BaseService.resetInstances()
    const recoveredService = new CalculationRuntimeService()
    await (recoveredService as unknown as { onInit(): Promise<void> }).onInit()
    service = recoveredService

    expect(service.getRecoverableFinalDecisions()).toEqual([])
    expect(() => service.getRunSnapshot(reservation.runId)).toThrow('Controlled calculation run was not found')
  })

  it('refuses a durable run whose ledger is a symlink inside the owned root', async () => {
    const reservation = await createCancelledRun()
    const ledgerPath = path.join(calculationsRoot, reservation.runId, 'ledger.jsonl')
    const movedLedgerPath = path.join(calculationsRoot, reservation.runId, 'ledger-target.jsonl')
    await rename(ledgerPath, movedLedgerPath)
    await symlink(movedLedgerPath, ledgerPath)

    await service._doStop()
    BaseService.resetInstances()
    const recoveredService = new CalculationRuntimeService()
    await (recoveredService as unknown as { onInit(): Promise<void> }).onInit()
    service = recoveredService

    expect(service.getRecoverableFinalDecisions()).toEqual([])
    expect(() => service.getRunSnapshot(reservation.runId)).toThrow('Controlled calculation run was not found')
  })

  it('refuses an oversized persisted plan before loading it into recovery state', async () => {
    const reservation = await createCancelledRun()
    const planPath = path.join(calculationsRoot, 'plans', `${reservation.planId}.json`)
    const persistedPlan = await readFile(planPath, 'utf8')
    await writeFile(planPath, `${persistedPlan}${' '.repeat(1024 * 1024)}\n`)

    await service._doStop()
    BaseService.resetInstances()
    const recoveredService = new CalculationRuntimeService()
    await (recoveredService as unknown as { onInit(): Promise<void> }).onInit()
    service = recoveredService

    expect(service.getRecoverableFinalDecisions()).toEqual([])
    expect(() => service.getRunSnapshot(reservation.runId)).toThrow('Controlled calculation run was not found')
  })

  it('rejects a stale molecule before validation or reservation', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    editor.getMoleculeDocument.mockResolvedValue({ ...document, revision: document.revision + 1 })

    await expect(service.validateCalculation(plan.planId, plan.planDigest)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT'
    })
  })

  it('rejects unsupported controlled methods or charge and multiplicity that differ from the committed molecule', async () => {
    const input = {
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb' as const,
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1 as const,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    }

    await expect(service.prepareCalculation({ ...input, method: 'GFN1-xTB' })).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })
    await expect(
      service.prepareCalculation({ ...input, settings: { ...input.settings, charge: 1 } })
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(
      service.prepareCalculation({ ...input, settings: { ...input.settings, multiplicity: 3 } })
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(service.prepareCalculation({ ...input, engine: 'avogadro', method: 'MMFF94' })).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })
  })

  it('validates schema-owned host context, analysis, plan, and session binding', async () => {
    const context = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'get_studio_context',
        arguments: {}
      }
    })
    expect(context).toMatchObject({
      type: 'studio_context',
      sessionId: 'session-1',
      project: {
        projectHandleId: 'project-ethanol',
        projectName: 'Ethanol'
      },
      document: {
        documentId: document.documentId,
        revision: document.revision,
        geometryHash: documentGeometryHash
      },
      display: {
        state: 'committed',
        documentId: document.documentId,
        revision: document.revision,
        geometryHash: documentGeometryHash
      },
      draft: null,
      editorMode: 'build',
      panes: ['explorer', 'agent'],
      activeRun: null
    })

    const analysis = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'analyze_current_molecule',
        arguments: {
          expected_revision: document.revision,
          geometry_hash: documentGeometryHash
        }
      }
    })
    expect(analysis).toMatchObject({
      type: 'current_molecule_analysis',
      geometryHash: documentGeometryHash,
      binding: {
        state: 'committed',
        documentId: document.documentId,
        revision: document.revision,
        geometryHash: documentGeometryHash
      },
      atomCount: 2,
      bondCount: 1,
      formula: 'CO'
    })

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: {
          type: 'studio_agent_tool_request',
          tool: 'analyze_current_molecule',
          arguments: {}
        }
      })
    ).resolves.toMatchObject({
      type: 'current_molecule_analysis',
      geometryHash: documentGeometryHash,
      binding: { state: 'committed' },
      atomCount: 2,
      formula: 'CO'
    })

    const prepared = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'prepare_molecule_optimization',
        arguments: {
          document_id: document.documentId,
          expected_revision: document.revision,
          geometry_hash: documentGeometryHash,
          engine: 'xtb',
          method: 'GFN2-xTB',
          settings: {
            maxSteps: 20,
            maxRuntimeSeconds: 30,
            threads: 1,
            charge: 0,
            multiplicity: 1,
            extensions: {}
          }
        }
      }
    })
    expect(prepared).toMatchObject({ type: 'prepared_controlled_calculation', state: 'prepared' })
    if (!('type' in prepared) || prepared.type !== 'prepared_controlled_calculation') {
      throw new Error('Expected a prepared plan')
    }

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'other-session',
        request: {
          type: 'studio_agent_tool_request',
          tool: 'validate_prepared_optimization',
          arguments: {
            plan_id: prepared.planId,
            plan_digest: prepared.planDigest
          }
        }
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: {
          type: 'studio_agent_tool_request',
          tool: 'start_prepared_optimization',
          arguments: {
            plan_id: prepared.planId,
            plan_digest: prepared.planDigest
          }
        }
      })
    ).rejects.toMatchObject({ code: 'EDITOR_UNAVAILABLE' })
  })

  it('grounds context and analysis in the main-owned visible draft', async () => {
    const draftDocument: MoleculeDocument = {
      ...structuredClone(document),
      atoms: [
        { id: 'atom-o1', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
        { id: 'atom-h1', atomicNumber: 1, position: [0.96, 0, 0], formalCharge: 0, extensions: {} },
        { id: 'atom-h2', atomicNumber: 1, position: [-0.24, 0.93, 0], formalCharge: 0, extensions: {} }
      ],
      bonds: [
        { id: 'bond-oh1', atomIds: ['atom-o1', 'atom-h1'], order: 1, extensions: {} },
        { id: 'bond-oh2', atomIds: ['atom-o1', 'atom-h2'], order: 1, extensions: {} }
      ],
      selections: ['atom-o1']
    }
    const draftGeometryHash = `sha256:${createHash('sha256')
      .update(
        JSON.stringify(
          draftDocument.atoms
            .map((atom) => [atom.id, atom.atomicNumber, atom.position] as const)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        )
      )
      .digest('hex')}`
    editor.getMoleculeDraft.mockReturnValue({
      draftId: 'draft-water',
      documentId: document.documentId,
      baseRevision: document.revision,
      document: draftDocument,
      entries: [],
      cursor: 2,
      dirty: true,
      canUndo: true,
      canRedo: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      extensions: {}
    })

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: { type: 'studio_agent_tool_request', tool: 'get_studio_context', arguments: {} }
      })
    ).resolves.toMatchObject({
      display: {
        state: 'draft',
        draftId: 'draft-water',
        geometryHash: draftGeometryHash
      },
      draft: {
        draftId: 'draft-water',
        baseRevision: document.revision,
        geometryHash: draftGeometryHash,
        changeCount: 2,
        dirty: true
      },
      selection: { atomIds: ['atom-o1'], bondIds: [] }
    })

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: {
          type: 'studio_agent_tool_request',
          tool: 'analyze_current_molecule',
          arguments: {
            expected_revision: document.revision,
            geometry_hash: draftGeometryHash
          }
        }
      })
    ).resolves.toMatchObject({
      type: 'current_molecule_analysis',
      atomCount: 3,
      bondCount: 2,
      formula: 'H2O',
      geometryHash: draftGeometryHash,
      binding: {
        state: 'draft',
        draftId: 'draft-water',
        baseRevision: document.revision,
        geometryHash: draftGeometryHash
      }
    })

    const prepared = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'prepare_molecule_optimization',
        arguments: {
          document_id: document.documentId,
          expected_revision: document.revision,
          geometry_hash: draftGeometryHash,
          engine: 'xtb',
          method: 'GFN2-xTB',
          settings: {
            maxSteps: 20,
            maxRuntimeSeconds: 30,
            threads: 1,
            charge: 0,
            multiplicity: 1,
            extensions: {}
          }
        }
      }
    })
    expect(prepared).toMatchObject({
      type: 'prepared_controlled_calculation',
      state: 'prepared',
      binding: {
        source: 'draft',
        draftId: 'draft-water',
        documentId: document.documentId,
        expectedRevision: document.revision,
        geometryHash: draftGeometryHash
      }
    })
    if (prepared.type !== 'prepared_controlled_calculation') throw new Error('Expected a prepared plan')
    const validated = await service.validateCalculation(prepared.planId, prepared.planDigest)
    expect(validated.state).toBe('validated')
    await expect(service.reserveCalculation(validated.planId, validated.planDigest)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
      message: 'Apply the molecule draft before starting this calculation'
    })

    editor.getMoleculeDraft.mockReturnValue({
      ...editor.getMoleculeDraft(),
      draftId: 'draft-replaced'
    })
    await expect(service.validateCalculation(prepared.planId, prepared.planDigest)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT'
    })
  })

  it('does not let renderer view metadata forge the molecule display binding', async () => {
    service.setWorkspaceViewState('session-1', {
      editorMode: 'inspect',
      panes: ['agent'],
      displayState: 'replay'
    } as never)

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: { type: 'studio_agent_tool_request', tool: 'get_studio_context', arguments: {} }
      })
    ).resolves.toMatchObject({
      display: {
        state: 'committed',
        documentId: document.documentId,
        revision: document.revision,
        geometryHash: documentGeometryHash
      },
      editorMode: 'inspect',
      panes: ['agent']
    })
  })

  it('requires and consumes an exact main-owned grant before deterministic controlled execution', async () => {
    const execute = vi.fn(async function* (reservation: { runId: string }) {
      yield {
        type: 'controlled_calculation_terminal' as const,
        runId: reservation.runId,
        status: 'cancelled' as const,
        frameCount: 0,
        reason: 'Deterministic approval test',
        terminatedAt: timestamp,
        extensions: {}
      }
    })
    service.configureFakeExecutionAdapter({ kind: 'fake', execute })
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    studioControl.consumePreparedCalculationGrant.mockImplementationOnce(() => {
      throw new Error('One-shot approval is missing or expired')
    })

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: {
          type: 'studio_agent_tool_request',
          tool: 'start_prepared_optimization',
          arguments: { plan_id: plan.planId, plan_digest: plan.planDigest }
        }
      })
    ).rejects.toThrow('One-shot approval is missing or expired')
    expect(execute).not.toHaveBeenCalled()

    const reservation = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'start_prepared_optimization',
        arguments: { plan_id: plan.planId, plan_digest: plan.planDigest }
      }
    })
    expect(studioControl.consumePreparedCalculationGrant).toHaveBeenLastCalledWith(
      'session-1',
      plan.planId,
      plan.planDigest
    )
    expect(reservation).toMatchObject({ type: 'controlled_calculation_reservation', planId: plan.planId })
    if (!('type' in reservation) || reservation.type !== 'controlled_calculation_reservation') {
      throw new Error('Expected controlled calculation reservation')
    }
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
  })

  it('dispatches local execution only through the main-issued xTB adapter after consuming the exact grant', async () => {
    const assertUnchanged = vi.fn()
    Object.assign(service, {
      xtbRuntime: {
        identity: structuredClone(executable),
        executablePath: '/unreachable/xtb-test-runtime',
        parameterDirectory: '/unreachable/xtb-test-parameters',
        assertUnchanged
      }
    })
    const execute = vi.spyOn(XtbCalculationAdapter.prototype, 'execute').mockImplementation(async function* (
      this: XtbCalculationAdapter,
      reservation
    ) {
      yield {
        type: 'controlled_calculation_terminal',
        runId: reservation.runId,
        status: 'cancelled',
        frameCount: 0,
        reason: 'Local dispatch test intercepted before process launch',
        terminatedAt: timestamp,
        extensions: {}
      }
    })
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)

    const reservation = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'start_prepared_optimization',
        arguments: { plan_id: plan.planId, plan_digest: plan.planDigest }
      }
    })

    expect(studioControl.consumePreparedCalculationGrant).toHaveBeenCalledWith(
      'session-1',
      plan.planId,
      plan.planDigest
    )
    expect(reservation).toMatchObject({ type: 'controlled_calculation_reservation', planId: plan.planId })
    if (!('type' in reservation) || reservation.type !== 'controlled_calculation_reservation') {
      throw new Error('Expected controlled calculation reservation')
    }
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(execute.mock.calls[0][0]).toEqual(reservation)
    expect(assertUnchanged).not.toHaveBeenCalled()
    expect(agent.requestTrajectory).toHaveBeenCalledWith(
      'optimization.open_run',
      expect.objectContaining({ run: expect.objectContaining({ runId: reservation.runId }) })
    )
    expect(studioControl.commitControlledRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: expect.objectContaining({ runId: reservation.runId }) })
    )
    execute.mockRestore()
  })

  it('aborts and awaits the main-owned local adapter before lifecycle shutdown completes', async () => {
    Object.assign(service, {
      xtbRuntime: {
        identity: structuredClone(executable),
        executablePath: '/unreachable/xtb-test-runtime',
        parameterDirectory: '/unreachable/xtb-test-parameters',
        assertUnchanged: vi.fn()
      }
    })
    let observedAbort = false
    const execute = vi.spyOn(XtbCalculationAdapter.prototype, 'execute').mockImplementation(async function* (
      this: XtbCalculationAdapter,
      reservation
    ) {
      const signal = (
        this as unknown as {
          signal: AbortSignal
        }
      ).signal
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = true
            resolve()
          },
          { once: true }
        )
      })
      yield {
        type: 'controlled_calculation_terminal',
        runId: reservation.runId,
        status: 'cancelled',
        frameCount: 0,
        reason: 'Lifecycle shutdown test',
        terminatedAt: timestamp,
        extensions: {}
      }
    })
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'start_prepared_optimization',
        arguments: { plan_id: plan.planId, plan_digest: plan.planDigest }
      }
    })
    if (!('type' in reservation) || reservation.type !== 'controlled_calculation_reservation') {
      throw new Error('Expected a controlled calculation reservation')
    }
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    await service._doStop()

    expect(observedAbort).toBe(true)
    expect(service.getRunSnapshot(reservation.runId).terminal).toEqual({
      type: 'controlled_calculation_terminal',
      runId: reservation.runId,
      status: 'cancelled',
      frameCount: 0,
      reason: 'Lifecycle shutdown test',
      terminatedAt: timestamp,
      extensions: {}
    })
  })

  it('lists and reads a bounded opaque artifact without exposing its filesystem path', async () => {
    const reservation = await createCancelledRun()
    const artifactList = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'list_calculation_artifacts',
        arguments: { run_id: reservation.runId, after_artifact_id: null, limit: 10 }
      }
    })
    if (!('type' in artifactList) || artifactList.type !== 'controlled_calculation_artifact_list') {
      throw new Error('Expected an artifact list')
    }
    expect(artifactList.artifacts).toHaveLength(1)
    expect(artifactList.artifacts[0]).toMatchObject({
      artifactId: `${reservation.runId}:ledger`,
      runId: reservation.runId,
      kind: 'log',
      mediaType: 'application/x-ndjson'
    })
    expect(JSON.stringify(artifactList)).not.toContain(calculationsRoot)

    const chunk = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'read_calculation_artifact',
        arguments: { artifact_id: artifactList.artifacts[0].artifactId, offset: 0, max_bytes: 65536 }
      }
    })
    if (!('artifact' in chunk)) throw new Error('Expected an artifact chunk')
    expect(chunk).toMatchObject({ encoding: 'utf8', eof: true })
    expect(chunk.content).toContain('"type":"controlled_calculation_reservation"')
    expect(chunk.content).toContain('"status":"cancelled"')
    expect(JSON.stringify(chunk)).not.toContain(calculationsRoot)
  })

  it('registers an adapter file as an opaque artifact before recording its terminal', async () => {
    const reservation = await createCancelledRun(true)
    const artifactList = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'list_calculation_artifacts',
        arguments: { run_id: reservation.runId, after_artifact_id: null, limit: 10 }
      }
    })
    if (!('type' in artifactList) || artifactList.type !== 'controlled_calculation_artifact_list') {
      throw new Error('Expected an artifact list')
    }

    expect(artifactList.artifacts.map(({ artifactId }) => artifactId)).toEqual([
      `${reservation.runId}:ledger`,
      `${reservation.runId}:result`
    ])
    expect(artifactList.artifacts[1]).toMatchObject({
      kind: 'output',
      displayName: 'Deterministic output',
      mediaType: 'text/plain',
      sizeBytes: 21
    })
    expect(JSON.stringify(artifactList)).not.toContain(calculationsRoot)

    const chunk = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'read_calculation_artifact',
        arguments: { artifact_id: artifactList.artifacts[1].artifactId, offset: 0, max_bytes: 64 }
      }
    })
    if (!('artifact' in chunk)) throw new Error('Expected an artifact chunk')
    expect(chunk).toMatchObject({ content: 'deterministic output\n', encoding: 'utf8', eof: true })
  })

  it('rejects adapter artifact paths outside the engine root and symlink aliases', async () => {
    for (const mode of ['outside', 'symlink'] as const) {
      const plan = await service.prepareCalculation({
        sessionId: 'session-1',
        documentId: document.documentId,
        expectedRevision: document.revision,
        geometryHash: documentGeometryHash,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: {
          maxSteps: 20,
          maxRuntimeSeconds: 30,
          threads: 1,
          charge: 0,
          multiplicity: 1,
          extensions: {}
        }
      })
      await service.validateCalculation(plan.planId, plan.planDigest)
      const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
      const engineDirectory = path.join(calculationsRoot, reservation.runId, 'engine')
      const outsidePath = path.join(calculationsRoot, `${reservation.runId}-outside.txt`)
      const sourcePath = mode === 'outside' ? outsidePath : path.join(engineDirectory, 'result.txt')

      await expect(
        service.executeReservedCalculation(reservation, {
          kind: 'fake',
          async *execute() {
            await mkdir(engineDirectory, { mode: 0o700 })
            await writeFile(outsidePath, 'must remain outside\n', { mode: 0o600 })
            if (mode === 'symlink') await symlink(outsidePath, sourcePath)
            yield {
              type: 'controlled_calculation_terminal',
              runId: reservation.runId,
              status: 'cancelled',
              frameCount: 0,
              reason: 'Invalid artifact source test',
              terminatedAt: timestamp,
              extensions: {}
            }
          },
          getArtifactSources: () => [
            {
              key: 'result',
              kind: 'output',
              displayName: 'Invalid output',
              mediaType: 'text/plain',
              filePath: sourcePath
            }
          ]
        })
      ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
      expect(service.getRunSnapshot(reservation.runId).terminal).toMatchObject({
        status: 'failed',
        frameCount: 0
      })
    }
  })

  it('rejects an artifact that changes after listing', async () => {
    const reservation = await createCancelledRun(true)
    const artifactList = await service.handleHostRequest({
      type: 'controlled_calculation_host_request',
      sessionId: 'session-1',
      request: {
        type: 'studio_agent_tool_request',
        tool: 'list_calculation_artifacts',
        arguments: { run_id: reservation.runId, after_artifact_id: null, limit: 10 }
      }
    })
    if (!('type' in artifactList) || artifactList.type !== 'controlled_calculation_artifact_list') {
      throw new Error('Expected an artifact list')
    }
    await writeFile(path.join(calculationsRoot, reservation.runId, 'engine', 'result.txt'), 'changed output\n')

    await expect(
      service.handleHostRequest({
        type: 'controlled_calculation_host_request',
        sessionId: 'session-1',
        request: {
          type: 'studio_agent_tool_request',
          tool: 'read_calculation_artifact',
          arguments: { artifact_id: artifactList.artifacts[1].artifactId, offset: 0, max_bytes: 64 }
        }
      })
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('rejects a ledger symlink that escapes the Studio calculation root', async () => {
    const reservation = await createCancelledRun()
    const ledgerPath = path.join(calculationsRoot, reservation.runId, 'ledger.jsonl')
    const outsidePath = `${calculationsRoot}-outside`
    await writeFile(outsidePath, 'outside content must remain private\n', { mode: 0o600 })
    try {
      await rm(ledgerPath)
      await symlink(outsidePath, ledgerPath)
      await expect(
        service.handleHostRequest({
          type: 'controlled_calculation_host_request',
          sessionId: 'session-1',
          request: {
            type: 'studio_agent_tool_request',
            tool: 'list_calculation_artifacts',
            arguments: { run_id: reservation.runId, after_artifact_id: null, limit: 10 }
          }
        })
      ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    } finally {
      await rm(outsidePath, { force: true })
    }
  })

  it('fails closed on reordered atoms and records no untrusted frame', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    const adapter: CalculationExecutionAdapter = {
      kind: 'fake',
      async *execute() {
        yield {
          type: 'controlled_calculation_frame',
          runId: reservation.runId,
          frameIndex: 0,
          engineStepIndex: 0,
          atomIds: ['atom-o1', 'atom-c1'],
          atomicNumbers: [8, 6],
          positions: [document.atoms[1].position, document.atoms[0].position],
          coordinateUnit: 'angstrom',
          provenance: {
            coordinateSource: 'engine',
            atomOrder: 'document_stable_id_order',
            transformation: 'none'
          },
          energy: { value: -5, unit: 'hartree' },
          gradientNorm: { value: 0.01, unit: 'hartree/bohr' },
          structureHash: plan.binding.geometryHash,
          timestamp,
          extensions: {}
        }
      }
    }

    await expect(service.executeReservedCalculation(reservation, adapter)).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })
    const snapshot = service.getRunSnapshot(reservation.runId)
    expect(snapshot.frameCount).toBe(0)
    expect(snapshot.terminal).toMatchObject({ status: 'failed', frameCount: 0 })
    const ledger = await readFile(path.join(calculationsRoot, reservation.runId, 'ledger.jsonl'), 'utf8')
    expect(ledger).not.toContain('"type":"controlled_calculation_frame"')
    expect(ledger).toContain('"status":"failed"')
  })

  it('records no host frame when sidecar durable ingress rejects it', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    const frame: ControlledCalculationExternalFrame = {
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
      energy: { value: -3.14, unit: 'hartree' },
      forceMetrics: { max: 0.02, rms: 0.01, unit: 'hartree/bohr' },
      structureHash: plan.binding.geometryHash,
      timestamp,
      extensions: {}
    }
    const durableTrajectory = agent.requestTrajectory.getMockImplementation()
    if (!durableTrajectory) throw new Error('Expected trajectory request mock')
    agent.requestTrajectory.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'optimization.append_run_frame') throw new Error('sidecar durable append failed')
      return durableTrajectory(method, params)
    })

    await expect(
      service.executeReservedCalculation(reservation, {
        kind: 'fake',
        async *execute() {
          yield frame
        }
      })
    ).rejects.toThrow('sidecar durable append failed')

    expect(service.getRunSnapshot(reservation.runId)).toMatchObject({
      frameCount: 0,
      terminal: { status: 'failed', frameCount: 0 }
    })
    expect(agent.requestTrajectory).toHaveBeenCalledWith(
      'optimization.close_run',
      expect.objectContaining({ terminal: expect.objectContaining({ status: 'failed', frameCount: 0 }) })
    )
    const ledger = await readFile(path.join(calculationsRoot, reservation.runId, 'ledger.jsonl'), 'utf8')
    expect(ledger).not.toContain('"type":"controlled_calculation_frame"')
    expect(ledger).toContain('"status":"failed"')
  })

  it('aborts the mutation lock when opening the sidecar ledger fails before manifest ownership', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-open-failure',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    agent.requestTrajectory.mockRejectedValueOnce(new Error('sidecar open failed'))

    await expect(
      service.executeReservedCalculation(reservation, {
        kind: 'fake',
        async *execute() {
          throw new Error('adapter must not start')
        }
      })
    ).rejects.toThrow('sidecar open failed')

    expect(activeRunId).toBeNull()
    expect(mutationLockOwner).toBeNull()
    expect(studioControl.commitControlledRunStart).not.toHaveBeenCalled()
    expect(service.getRunSnapshot(reservation.runId)).toMatchObject({
      frameCount: 0,
      terminal: { status: 'failed', frameCount: 0 }
    })
  })

  it('does not admit a non-fake adapter before an approved engine runtime exists', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)

    await expect(
      service.executeReservedCalculation(reservation, {
        kind: 'local',
        execute() {
          throw new Error('must not run')
        }
      })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })

  it('admits at most one reservation across an asynchronous binding check', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    let releaseBinding!: (value: MoleculeDocument) => void
    editor.getMoleculeDocument.mockImplementationOnce(
      () => new Promise<MoleculeDocument>((resolve) => (releaseBinding = resolve))
    )

    const first = service.reserveCalculation(plan.planId, plan.planDigest)
    await expect(service.reserveCalculation(plan.planId, plan.planDigest)).rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    releaseBinding(structuredClone(document))
    await expect(first).resolves.toMatchObject({ planId: plan.planId })
  })

  it('admits at most one execution for the same reservation', async () => {
    const plan = await service.prepareCalculation({
      sessionId: 'session-1',
      documentId: document.documentId,
      expectedRevision: document.revision,
      geometryHash: documentGeometryHash,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      }
    })
    await service.validateCalculation(plan.planId, plan.planDigest)
    const reservation = await service.reserveCalculation(plan.planId, plan.planDigest)
    let releaseExecution!: () => void
    const waitForRelease = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    const adapter: CalculationExecutionAdapter = {
      kind: 'fake',
      async *execute() {
        await waitForRelease
        yield {
          type: 'controlled_calculation_terminal',
          runId: reservation.runId,
          status: 'cancelled',
          frameCount: 0,
          reason: 'Deterministic concurrency test complete',
          terminatedAt: timestamp,
          extensions: {}
        }
      }
    }

    const first = service.executeReservedCalculation(reservation, adapter)
    await expect(service.executeReservedCalculation(reservation, adapter)).rejects.toMatchObject({
      code: 'RUN_ACTIVE'
    })
    releaseExecution()
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(agent.requestTrajectory.mock.calls.filter(([method]) => method === 'optimization.open_run')).toHaveLength(1)
  })
})
