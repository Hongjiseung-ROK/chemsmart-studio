import type {
  ControlledCalculationExternalFrame,
  ControlledCalculationTerminal,
  MoleculeDocument,
  MoleculePatch,
  PreviewReceipt,
  StudioApprovalRequest,
  StudioControlSnapshot,
  StudioDraftSnapshot
} from '@chemsmart/studio-protocol'
import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock, ipcSendMock } = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  ipcSendMock: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: appGetMock } }))

import { moleculeGeometryHash } from '../ControlledCalculationIdentity'
import { StudioControlService } from '../StudioControlService'

const timestamp = '2026-07-22T01:23:45.000Z'
const geometryHash = `sha256:${'a'.repeat(64)}`
const afterHash = `sha256:${'b'.repeat(64)}`
const sessionId = 'session-1'
const senderId = 'window-1'
const commandBinding = {
  calculationKind: 'single_point' as const,
  commandDigest: 'd'.repeat(64),
  documentId: 'molecule-1',
  engine: 'xtb' as const,
  expectedRevision: 7,
  geometryHash: `sha256:${'a'.repeat(64)}`,
  method: 'GFN2-xTB',
  planId: 'synthesis-water-sp'
}

const document: MoleculeDocument = {
  documentId: 'molecule-1',
  revision: 7,
  atoms: [
    {
      id: 'atom-1',
      atomicNumber: 6,
      position: [0, 0, 0],
      formalCharge: 0,
      extensions: {}
    }
  ],
  bonds: [],
  selections: [],
  frozenAxes: {},
  constraints: [],
  properties: { extensions: {} },
  extensions: {}
}
const documentGeometryHash = moleculeGeometryHash(document)
const replayExternalFrame: ControlledCalculationExternalFrame = {
  type: 'controlled_calculation_frame',
  runId: 'run-1',
  frameIndex: 0,
  engineStepIndex: 0,
  atomIds: ['atom-1'],
  atomicNumbers: [6],
  positions: [[0, 0, 0]],
  coordinateUnit: 'angstrom',
  provenance: {
    coordinateSource: 'engine',
    atomOrder: 'document_stable_id_order',
    transformation: 'none'
  },
  energy: { value: -1, unit: 'kJ/mol' },
  forceMetrics: { max: 0.1, unit: 'kJ/mol/angstrom' },
  convergence: { converged: false },
  structureHash: documentGeometryHash,
  timestamp,
  extensions: {}
}
const controlledFinalFrame: ControlledCalculationExternalFrame = {
  ...replayExternalFrame,
  positions: [[1.23456789, 0, 0]],
  convergence: { converged: true },
  structureHash: afterHash
}
const defaultReplayCatalog = {
  totalRuns: 1,
  runs: [
    {
      run: {
        runId: 'run-1',
        documentId: document.documentId,
        inputRevision: document.revision,
        engine: 'avogadro' as const,
        method: 'UFF',
        settings: { maxSteps: 20, extensions: {} },
        frozenAtomIds: [],
        constraintIds: [],
        status: 'running' as const,
        createdAt: timestamp,
        extensions: {}
      },
      frameCount: 1,
      latestFrame: {
        runId: 'run-1',
        stepIndex: 0,
        energy: replayExternalFrame.energy,
        forceMetrics: replayExternalFrame.forceMetrics,
        convergence: replayExternalFrame.convergence,
        timestamp
      },
      outcome: 'running' as const,
      message: '',
      updatedAt: timestamp,
      replayable: true,
      extensions: {}
    }
  ],
  nextRunId: null,
  extensions: {}
}

const patch: MoleculePatch = {
  operationId: 'operation-1',
  baseRevision: 7,
  actor: 'agent',
  previewOnly: true,
  operations: [{ op: 'set_positions', positions: [{ atomId: 'atom-1', position: [9.87654321, 0, 0] }] }],
  extensions: {}
}

const preview: PreviewReceipt = {
  previewId: 'preview-1',
  operationId: 'operation-1',
  baseRevision: 7,
  affectedAtomIds: ['atom-1'],
  affectedBondIds: [],
  beforeHash: geometryHash,
  afterHash,
  diff: { operationCount: 1, movedAtomCount: 1 },
  createdAt: timestamp,
  extensions: {}
}

const agentDraft: StudioDraftSnapshot = {
  draftId: 'draft-1',
  documentId: document.documentId,
  baseRevision: document.revision,
  document: {
    ...document,
    atoms: document.atoms.map((atom) =>
      atom.id === 'atom-1' ? { ...atom, position: [9.87654321, 0, 0] as [number, number, number] } : atom
    )
  },
  entries: [
    {
      entryId: preview.previewId,
      actor: 'agent',
      mode: 'build',
      operations: patch.operations,
      summary: {
        operationKinds: ['set_positions'],
        elementChanges: [],
        coordinateChangeCount: 1,
        bondChangeCount: 0,
        constraintChangeCount: 0,
        affectedAtomIds: ['atom-1'],
        affectedBondIds: [],
        affectedConstraintIds: []
      },
      beforeHash: geometryHash,
      afterHash,
      createdAt: timestamp,
      extensions: {}
    }
  ],
  cursor: 1,
  dirty: true,
  canUndo: true,
  canRedo: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  extensions: {}
}

type MoleculeChangedListener = (summary: { documentId: string; revision: number }) => void
type WindowDestroyedListener = (event: { id: string }) => void
type ControlledFrameListener = (event: ControlledCalculationExternalFrame) => void
type ControlledTerminalListener = (event: ControlledCalculationTerminal) => void

describe('StudioControlService trusted controls', () => {
  const editor = {
    getCachedMoleculeSummary: vi.fn(),
    getMoleculeDocument: vi.fn(),
    setSelection: vi.fn(),
    applyDraftPatch: vi.fn(),
    getMoleculeDraft: vi.fn(),
    undoDraft: vi.fn(),
    previewPatch: vi.fn(),
    commitPreview: vi.fn(),
    discardPreview: vi.fn(),
    getRunningMoleculeSummary: vi.fn(),
    getOptimizationReplayCatalog: vi.fn(),
    getPersistedActiveRunId: vi.fn(),
    getOptimizationReplayTimeline: vi.fn(),
    getOptimizationReplayFrame: vi.fn(),
    onMoleculeChanged: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn()
  }
  const windowManager = { onWindowDestroyed: vi.fn() }
  const calculationRuntime = {
    assertCommandPreflightApproval: vi.fn(),
    getCommandPreflightForApproval: vi.fn(),
    getPreparedPlanForApproval: vi.fn(),
    getRecoverableFinalDecisions: vi.fn(),
    recoverFinalDecision: vi.fn(),
    acceptFinalGeometry: vi.fn(),
    rejectFinalGeometry: vi.fn(),
    cancelCalculation: vi.fn(),
    onRunStarted: vi.fn(),
    onFrameCommitted: vi.fn(),
    onTerminalCommitted: vi.fn()
  }
  const projectStore = {
    getActiveProjectPath: vi.fn(() => '/tmp/studio-control.cmsproj'),
    inspectProject: vi.fn()
  }
  let moleculeChangedListener: MoleculeChangedListener
  let windowDestroyedListener: WindowDestroyedListener
  let controlledFrameListener: ControlledFrameListener
  let controlledTerminalListener: ControlledTerminalListener
  let service: StudioControlService

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(timestamp))
    vi.clearAllMocks()
    BaseService.resetInstances()

    editor.getCachedMoleculeSummary.mockReturnValue({ documentId: document.documentId, revision: document.revision })
    editor.getMoleculeDocument.mockResolvedValue(document)
    editor.setSelection.mockResolvedValue({ ...document, selections: ['atom-1'] })
    editor.applyDraftPatch.mockResolvedValue(agentDraft)
    editor.getMoleculeDraft.mockReturnValue(agentDraft)
    editor.undoDraft.mockResolvedValue(null)
    // The real editor echoes the patch identity back in its receipt; the service checks that it matches.
    editor.previewPatch.mockImplementation(async (incoming: MoleculePatch) => ({
      ...preview,
      operationId: incoming.operationId,
      baseRevision: incoming.baseRevision
    }))
    editor.commitPreview.mockResolvedValue({
      type: 'molecule_commit',
      previewId: preview.previewId,
      revision: 8,
      timestamp,
      geometryHash,
      stateHash: afterHash
    })
    editor.discardPreview.mockResolvedValue({ discarded: true, previewId: preview.previewId })
    editor.getRunningMoleculeSummary.mockResolvedValue({ documentId: document.documentId, revision: document.revision })
    editor.getOptimizationReplayCatalog.mockResolvedValue(defaultReplayCatalog)
    editor.getPersistedActiveRunId.mockResolvedValue(null)
    editor.getOptimizationReplayFrame.mockResolvedValue({
      runId: 'run-1',
      frame: replayExternalFrame,
      frameCount: 1,
      extensions: {}
    })
    editor.onMoleculeChanged.mockImplementation((listener: MoleculeChangedListener) => {
      moleculeChangedListener = listener
      return { dispose: vi.fn() }
    })
    windowManager.onWindowDestroyed.mockImplementation((listener: WindowDestroyedListener) => {
      windowDestroyedListener = listener
      return { dispose: vi.fn() }
    })
    calculationRuntime.onFrameCommitted.mockImplementation((listener: ControlledFrameListener) => {
      controlledFrameListener = listener
      return { dispose: vi.fn() }
    })
    calculationRuntime.onTerminalCommitted.mockImplementation((listener: ControlledTerminalListener) => {
      controlledTerminalListener = listener
      return { dispose: vi.fn() }
    })
    calculationRuntime.getPreparedPlanForApproval.mockReturnValue({
      type: 'prepared_controlled_calculation',
      planId: 'plan-xtb-1',
      planDigest: `sha256:${'c'.repeat(64)}`,
      binding: {
        sessionId,
        documentId: document.documentId,
        expectedRevision: document.revision,
        geometryHash
      },
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1,
        extensions: {}
      },
      settingsDigest: `sha256:${'d'.repeat(64)}`,
      executable: {
        kind: 'local_executable',
        engine: 'xtb',
        version: '6.7.1',
        architecture: 'arm64',
        executableDigest: `sha256:${'e'.repeat(64)}`,
        runtimeFingerprint: `sha256:${'f'.repeat(64)}`,
        libraries: [],
        verifiedAt: timestamp
      },
      createdAt: timestamp,
      expiresAt: '2026-07-22T01:33:45.000Z',
      state: 'validated',
      extensions: {}
    })
    calculationRuntime.getCommandPreflightForApproval.mockResolvedValue(commandBinding)
    calculationRuntime.assertCommandPreflightApproval.mockResolvedValue(undefined)
    calculationRuntime.getRecoverableFinalDecisions.mockReturnValue([])
    calculationRuntime.recoverFinalDecision.mockResolvedValue('awaiting')
    calculationRuntime.cancelCalculation.mockResolvedValue({
      type: 'controlled_calculation_terminal',
      runId: 'run-1',
      status: 'cancelled',
      frameCount: 0,
      reason: 'User cancelled',
      terminatedAt: timestamp,
      extensions: {}
    })
    calculationRuntime.acceptFinalGeometry.mockResolvedValue({
      type: 'optimization_final_commit',
      runId: 'run-1',
      revision: 8,
      timestamp,
      geometryHash: afterHash
    })
    calculationRuntime.rejectFinalGeometry.mockImplementation(async (runId: string) => ({
      type: 'optimization_final_rejected',
      runId,
      revision: document.revision,
      timestamp
    }))
    projectStore.inspectProject.mockImplementation(async () => ({
      manifest: { activeRunId: await editor.getPersistedActiveRunId() },
      document: structuredClone(document)
    }))
    appGetMock.mockImplementation((name: string) => {
      if (name === 'MoleculeWorkspaceService') return editor
      if (name === 'WindowManager') return windowManager
      if (name === 'CalculationRuntimeService') return calculationRuntime
      if (name === 'MoleculeDocumentService') return { getDocument: () => structuredClone(document) }
      if (name === 'MoleculeProjectStore') return projectStore
      if (name === 'IpcApiService') return { send: ipcSendMock }
      if (name === 'PreferenceService') return { get: vi.fn(() => 'en-US') }
      throw new Error(`Unexpected application.get(${name})`)
    })

    service = new StudioControlService()
    await service._doInit()
  })

  afterEach(async () => {
    await service._doStop()
    vi.useRealTimers()
  })

  function previewApproval(overrides: Partial<StudioApprovalRequest> = {}): StudioApprovalRequest {
    return {
      sessionId,
      requestId: 'request-preview-1',
      tool: 'commit_molecule_preview',
      arguments: { preview_id: preview.previewId, expected_revision: preview.baseRevision },
      ...overrides
    } as StudioApprovalRequest
  }

  function preparedCalculationApproval(overrides: Partial<StudioApprovalRequest> = {}): StudioApprovalRequest {
    return {
      sessionId,
      requestId: 'request-prepared-calculation-1',
      tool: 'start_prepared_optimization',
      arguments: {
        plan_id: 'plan-xtb-1',
        plan_digest: `sha256:${'c'.repeat(64)}`
      },
      ...overrides
    } as StudioApprovalRequest
  }

  function executionApproval(
    tool: 'run_local' | 'submit_hpc' | 'execute_chemsmart_command',
    toolArguments: Record<string, unknown>,
    requestId: string
  ): StudioApprovalRequest {
    return {
      sessionId,
      requestId,
      tool,
      arguments: toolArguments
    } as StudioApprovalRequest
  }

  async function preparePreview(): Promise<void> {
    service.getSnapshot(sessionId, senderId)
    await service.forwardMoleculeRequest({
      sessionId,
      method: 'molecule.preview_patch',
      params: { patch }
    })
  }

  it('reports the committed molecule as the trusted render binding when nothing else is displayed', () => {
    service.getSnapshot(sessionId, senderId)

    expect(service.getTrustedRenderBinding()).toEqual({
      displayState: 'committed',
      documentId: document.documentId,
      revision: document.revision
    })
  })

  it('keeps the trusted committed binding while an agent edit is staged in the visible draft', async () => {
    await preparePreview()

    expect(service.getTrustedRenderBinding()).toEqual({
      displayState: 'committed',
      documentId: document.documentId,
      revision: document.revision
    })
  })

  it('reports the exact replay frame Studio asked the helper to display', async () => {
    service.getSnapshot(sessionId, senderId)
    await service.selectReplayFrame(sessionId, senderId, 'run-1', 0)

    expect(service.getTrustedRenderBinding()).toEqual({
      displayState: 'replay',
      documentId: document.documentId,
      inputRevision: document.revision,
      runId: 'run-1',
      frameIndex: 0
    })
  })

  it('fails closed before display when replay frame identity, atoms, or geometry are forged', async () => {
    service.getSnapshot(sessionId, senderId)
    editor.getOptimizationReplayFrame.mockResolvedValueOnce({
      runId: 'run-forged',
      frame: { ...replayExternalFrame, runId: 'run-forged' },
      frameCount: 1,
      extensions: {}
    })

    await expect(service.selectReplayFrame(sessionId, senderId, 'run-1', 0)).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })

    editor.getOptimizationReplayFrame.mockResolvedValueOnce({
      runId: 'run-1',
      frame: { ...replayExternalFrame, atomIds: ['atom-forged'] },
      frameCount: 1,
      extensions: {}
    })
    await expect(service.selectReplayFrame(sessionId, senderId, 'run-1', 0)).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })

    editor.getOptimizationReplayFrame.mockResolvedValueOnce({
      runId: 'run-1',
      frame: { ...replayExternalFrame, structureHash: `sha256:${'0'.repeat(64)}` },
      frameCount: 1,
      extensions: {}
    })
    await expect(service.selectReplayFrame(sessionId, senderId, 'run-1', 0)).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })
    expect(service.getTrustedRenderBinding()).toEqual({
      displayState: 'committed',
      documentId: document.documentId,
      revision: document.revision
    })
    expect(ipcSendMock).not.toHaveBeenCalledWith(
      senderId,
      'chemsmart_studio.molecule.display_changed',
      expect.anything()
    )
  })

  async function approveCalculation(): Promise<StudioControlSnapshot> {
    service.getSnapshot(sessionId, senderId)
    const plan = calculationRuntime.getPreparedPlanForApproval()
    service.commitControlledRunStart({
      plan,
      document,
      reservation: {
        type: 'controlled_calculation_reservation',
        runId: 'run-1',
        planId: plan.planId,
        planDigest: plan.planDigest,
        binding: plan.binding,
        executable: plan.executable,
        reservedAt: timestamp,
        extensions: {}
      }
    })
    return service.getSnapshot(sessionId, senderId)
  }

  function completeControlledCalculation(): void {
    controlledFrameListener(controlledFinalFrame)
    controlledTerminalListener({
      type: 'controlled_calculation_terminal',
      runId: 'run-1',
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: afterHash,
      completedAt: timestamp,
      extensions: {}
    })
  }

  it('publishes a schema-valid public Agent state without private reasoning', () => {
    const initial = service.getSnapshot(sessionId, senderId)
    expect(initial.agent).toMatchObject({
      phase: 'idle',
      currentObject: 'session',
      requiresUserInput: false,
      terminalResult: null
    })

    service.beginAgentTurn(sessionId)

    expect(service.getSnapshot(sessionId, senderId).agent).toMatchObject({
      phase: 'understanding_request',
      latestGate: 'pending',
      statusSummary: expect.any(String)
    })
    service.recordAgentToolCompletion(sessionId, 'get_studio_context')
    expect(service.getSnapshot(sessionId, senderId).agent).toMatchObject({
      phase: 'inspecting_molecule',
      currentObject: 'molecule',
      activeTool: 'get_studio_context',
      latestGate: 'passed'
    })
    expect(JSON.stringify(service.getSnapshot(sessionId, senderId).agent)).not.toContain('reasoning')
  })

  it.each([
    ['completed', 'completed', 'completed', false],
    ['failed', 'failed', 'failed', false],
    ['denied', 'idle', 'denied', false],
    ['cancelled', 'idle', 'cancelled', false],
    ['needs_user', 'understanding_request', null, true]
  ] as const)(
    'settles the %s outcome without completing a negative turn',
    (outcome, phase, terminalResult, requiresUserInput) => {
      service.getSnapshot(sessionId, senderId)
      service.beginAgentTurn(sessionId)

      service.settleAgentTurn(sessionId, outcome)

      expect(service.getSnapshot(sessionId, senderId).agent).toMatchObject({
        phase,
        terminalResult,
        requiresUserInput
      })
    }
  )

  it('marks calculation approval as a trusted user wait and records denial', async () => {
    service.getSnapshot(sessionId, senderId)
    const approval = service.requestApproval(preparedCalculationApproval())
    const pending = service.getSnapshot(sessionId, senderId)
    const card = pending.pendingApprovals[0]

    expect(pending.agent).toMatchObject({
      phase: 'awaiting_calculation_approval',
      currentObject: 'calculation_plan',
      pendingTrustedAction: 'calculation_start',
      requiresUserInput: true
    })
    expect(card.kind).toBe('controlled_calculation_start')
    await service.performAction(
      sessionId,
      card.kind === 'controlled_calculation_start' ? card.denyActionId : '',
      senderId
    )
    await expect(approval).resolves.toEqual({ decision: 'deny' })
    expect(service.getSnapshot(sessionId, senderId).agent).toMatchObject({
      phase: 'completed',
      latestGate: 'denied',
      terminalResult: 'denied',
      requiresUserInput: false
    })
  })

  it('builds exact one-shot cards for every generic execution tool', async () => {
    service.getSnapshot(sessionId, senderId)
    const cases = [
      {
        tool: 'run_local' as const,
        requestId: 'request-run-local-1',
        arguments: { job: 'job_abcd' }
      },
      {
        tool: 'submit_hpc' as const,
        requestId: 'request-submit-hpc-1',
        arguments: { job: 'job_1234abcd', server: 'cluster-a', execute: true }
      },
      {
        tool: 'execute_chemsmart_command' as const,
        requestId: 'request-execute-command-1',
        arguments: { command: 'chemsmart run gaussian sp water', test: true, timeout_s: 30 }
      }
    ]

    for (const entry of cases) {
      const approval = service.requestApproval(
        executionApproval(entry.tool, entry.arguments, entry.requestId),
        entry.tool === 'execute_chemsmart_command' ? commandBinding : undefined
      )
      const card = service.getSnapshot(sessionId, senderId).pendingApprovals.at(-1)

      expect(card).toMatchObject({
        kind: 'execution_tool',
        requestId: entry.requestId,
        risk: 'calculation_execution',
        tool: entry.tool,
        arguments: entry.arguments
      })
      expect(card && JSON.stringify(card)).not.toContain('allow_session')
      if (entry.tool === 'execute_chemsmart_command') {
        expect(card).toMatchObject(commandBinding)
      }
      const denyActionId = card?.kind === 'execution_tool' ? card.denyActionId : ''
      await service.performAction(sessionId, denyActionId, senderId)
      await expect(approval).resolves.toEqual({ decision: 'deny' })
      expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
    }
  })

  it('requires and consumes the current-molecule command binding exactly once', async () => {
    service.getSnapshot(sessionId, senderId)
    const argumentsValue = {
      command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 -g gfn2 sp',
      test: false,
      timeout_s: 3600
    }
    const approval = service.requestApproval(
      executionApproval('execute_chemsmart_command', argumentsValue, 'request-command-bound'),
      commandBinding
    )
    const card = service.getSnapshot(sessionId, senderId).pendingApprovals.at(-1)
    const allowActionId = card?.kind === 'execution_tool' ? card.allowActionId : ''

    await service.performAction(sessionId, allowActionId, senderId)
    await expect(approval).resolves.toEqual({ decision: 'allow_once' })
    expect(calculationRuntime.assertCommandPreflightApproval).toHaveBeenCalledWith(sessionId, commandBinding)

    await expect(service.consumeCommandExecutionGrant(sessionId, argumentsValue)).resolves.toBeUndefined()
    await expect(service.consumeCommandExecutionGrant(sessionId, argumentsValue)).rejects.toMatchObject({
      code: -32602,
      data: { studioCode: 'APPROVAL_REQUIRED' }
    })
  })

  it('fails closed when an execute command has no main-owned preflight binding', async () => {
    service.getSnapshot(sessionId, senderId)

    await expect(
      service.requestApproval(
        executionApproval(
          'execute_chemsmart_command',
          { command: 'chemsmart run xtb -f water.xyz sp' },
          'request-command-unbound'
        )
      )
    ).resolves.toEqual({ decision: 'deny' })
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
  })

  it('rejects malformed generic execution arguments before creating a card', () => {
    service.getSnapshot(sessionId, senderId)

    expect(() =>
      service.requestApproval({
        sessionId,
        requestId: 'request-malformed-submit',
        tool: 'submit_hpc',
        arguments: { job: 'job_abcd', server: { name: 'cluster-a' } }
      })
    ).toThrowError(expect.objectContaining({ code: -32602 }))
    expect(() =>
      service.requestApproval({
        sessionId,
        requestId: 'request-malformed-command',
        tool: 'execute_chemsmart_command',
        arguments: { command: 'chemsmart run /private/input.xyz' }
      })
    ).toThrowError(expect.objectContaining({ code: -32602 }))
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
  })

  it('rejects malformed approval and molecule envelopes before any editor call', async () => {
    expect(() =>
      service.requestApproval({
        ...preparedCalculationApproval(),
        providerMetadata: { raw: 'must-not-cross' }
      })
    ).toThrowError(
      expect.objectContaining({ code: -32602, data: { studioCode: 'SCHEMA_INVALID', issues: expect.anything() } })
    )

    await expect(
      service.forwardMoleculeRequest({
        method: 'molecule.get_snapshot',
        params: {},
        rawJson: '{}'
      })
    ).rejects.toMatchObject({ code: -32602, data: { studioCode: 'SCHEMA_INVALID' } })
    await expect(
      service.forwardMoleculeRequest({
        sessionId,
        method: 'molecule.commit_preview',
        params: { runId: 'run-1' }
      })
    ).rejects.toMatchObject({ code: -32602, data: { studioCode: 'SCHEMA_INVALID' } })
    await expect(
      service.forwardMoleculeRequest({
        sessionId,
        method: 'molecule.set_selection',
        params: { documentId: 'molecule-1', expectedRevision: 7, atomIds: ['atom-1'] }
      })
    ).rejects.toMatchObject({ code: -32602, data: { studioCode: 'SCHEMA_INVALID' } })

    expect(editor.getMoleculeDocument).not.toHaveBeenCalled()
    expect(editor.setSelection).not.toHaveBeenCalled()
    expect(editor.previewPatch).not.toHaveBeenCalled()
    expect(editor.commitPreview).not.toHaveBeenCalled()
  })

  it('leases a session to one managed renderer and rejects wrong or absent senders', async () => {
    service.getSnapshot(sessionId, senderId)

    expect(() => service.claimSessionControl(sessionId, senderId)).not.toThrow()
    expect(() => service.claimSessionControl(sessionId, 'window-2')).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN_SENDER' })
    )
    expect(() => service.getSnapshot(sessionId, 'window-2')).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN_SENDER' })
    )
    await expect(service.performAction(sessionId, 'action-forged', 'window-2')).rejects.toMatchObject({
      code: 'FORBIDDEN_SENDER'
    })

    const unleasedSession = 'session-null-sender'
    expect(() => service.getSnapshot(unleasedSession, null as unknown as string)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN_SENDER' })
    )
  })

  it('owns replay per managed session, binds sidecar frames to current identity, redacts internals, and releases on window loss', async () => {
    const replayFrame = {
      runId: 'run-1',
      stepIndex: 0,
      energy: { value: -1, unit: 'kJ/mol' },
      forceMetrics: { max: 0.1, unit: 'kJ/mol/angstrom' },
      convergence: { converged: false },
      timestamp
    }
    editor.getOptimizationReplayCatalog.mockResolvedValue({
      totalRuns: 1,
      runs: [
        {
          run: {
            runId: 'run-1',
            documentId: document.documentId,
            inputRevision: document.revision,
            engine: 'avogadro',
            method: 'UFF',
            settings: { maxSteps: 20, extensions: { private: { projectPath: '/private/project' } } },
            frozenAtomIds: ['atom-secret'],
            constraintIds: ['constraint-secret'],
            status: 'running',
            createdAt: timestamp,
            extensions: { private: { rawLog: 'hidden' } }
          },
          frameCount: 1,
          latestFrame: replayFrame,
          outcome: 'running',
          message: '/private/project/raw.log',
          updatedAt: timestamp,
          replayable: true,
          extensions: { private: { coordinates: [[0, 0, 0]] } }
        }
      ],
      nextRunId: null,
      extensions: { private: { rawLog: 'hidden' } }
    })
    editor.getPersistedActiveRunId.mockResolvedValue('run-1')
    editor.getOptimizationReplayFrame.mockResolvedValue({
      runId: 'run-1',
      frame: replayExternalFrame,
      frameCount: 1,
      extensions: { private: { coordinates: [[0, 0, 0]] } }
    })

    service.getSnapshot(sessionId, senderId)
    const catalog = await service.getReplayCatalog(sessionId, senderId, null, 50)
    expect(catalog.runs[0]).toMatchObject({
      message: '',
      extensions: {},
      run: { frozenAtomIds: [], constraintIds: [], extensions: {} }
    })
    expect(JSON.stringify(catalog)).not.toMatch(/atom-secret|rawLog|projectPath|coordinates|\/private/)

    await service.selectReplayFrame(sessionId, senderId, 'run-1', 0)
    expect(editor.getOptimizationReplayFrame).toHaveBeenCalledWith({
      runId: 'run-1',
      stepIndex: 0,
      documentId: document.documentId,
      expectedRevision: document.revision
    })
    expect(ipcSendMock).toHaveBeenCalledWith(
      senderId,
      'chemsmart_studio.molecule.display_changed',
      expect.objectContaining({
        sessionId,
        binding: { state: 'replay', runId: 'run-1', frameIndex: 0 },
        document: expect.objectContaining({ documentId: document.documentId, revision: document.revision })
      })
    )
    await expect(service.stopReplay(sessionId, senderId)).resolves.toMatchObject({
      viewing: false,
      documentId: document.documentId,
      revision: document.revision
    })
    expect(ipcSendMock).toHaveBeenCalledWith(senderId, 'chemsmart_studio.molecule.display_changed', {
      sessionId,
      document,
      binding: { state: 'committed' }
    })

    await service.selectReplayFrame(sessionId, senderId, 'run-1', 0)
    windowDestroyedListener({ id: senderId })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

  it('composes replay liveness from the persisted active run, not from session state', async () => {
    editor.getOptimizationReplayCatalog.mockResolvedValue({
      totalRuns: 1,
      runs: [
        {
          run: {
            runId: 'run-active-1',
            documentId: document.documentId,
            inputRevision: document.revision,
            engine: 'xtb',
            method: 'GFN2-xTB',
            settings: { maxSteps: 20, extensions: {} },
            frozenAtomIds: [],
            constraintIds: [],
            status: 'running',
            createdAt: timestamp,
            extensions: {}
          },
          frameCount: 1,
          latestFrame: {
            runId: 'run-active-1',
            stepIndex: 0,
            energy: { value: -1, unit: 'hartree' },
            timestamp
          },
          outcome: 'running',
          message: '',
          updatedAt: timestamp,
          replayable: true,
          extensions: {}
        }
      ],
      nextRunId: null,
      extensions: {}
    })
    service.getSnapshot(sessionId, senderId)

    // The manifest records this run as active: main is driving it, so it is live.
    editor.getPersistedActiveRunId.mockResolvedValue('run-active-1')
    const active = await service.getReplayCatalog(sessionId, senderId, null, 50)
    expect(active.runs[0]).toMatchObject({ active: true, recovered: false, outcome: 'running' })

    // Nothing is persisted as active: an open ledger is a run that was interrupted, not one still
    // going. Inferring liveness from the missing terminal event would show it as running forever.
    editor.getPersistedActiveRunId.mockResolvedValue(null)
    const interrupted = await service.getReplayCatalog(sessionId, senderId, null, 50)
    expect(interrupted.runs[0]).toMatchObject({ active: false, recovered: true, outcome: 'interrupted' })
  })

  it('blocks new previews and calculation approvals during replay selection and while replay is leased', async () => {
    let resolveSelection: ((selection: unknown) => void) | undefined
    editor.getOptimizationReplayFrame.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve
        })
    )
    service.getSnapshot(sessionId, senderId)

    const selecting = service.selectReplayFrame(sessionId, senderId, 'run-1', 0)
    await expect(
      service.forwardMoleculeRequest({ sessionId, method: 'molecule.preview_patch', params: { patch } })
    ).rejects.toMatchObject({ data: { studioCode: 'REVISION_CONFLICT' } })
    await expect(service.requestApproval(preparedCalculationApproval())).resolves.toEqual({ decision: 'deny' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(resolveSelection).toBeTypeOf('function')
    resolveSelection?.({
      runId: 'run-1',
      frame: replayExternalFrame,
      frameCount: 1,
      extensions: {}
    })
    await selecting

    await expect(
      service.forwardMoleculeRequest({ sessionId, method: 'molecule.preview_patch', params: { patch } })
    ).rejects.toMatchObject({ data: { studioCode: 'REVISION_CONFLICT' } })
    await expect(service.requestApproval(preparedCalculationApproval())).resolves.toEqual({ decision: 'deny' })

    await service.stopReplay(sessionId, senderId)
    await expect(
      service.forwardMoleculeRequest({ sessionId, method: 'molecule.preview_patch', params: { patch } })
    ).resolves.toMatchObject({ previewId: preview.previewId })
  })

  it('stages an agent edit without a card and binds its legacy acknowledgement to exact identity', async () => {
    await preparePreview()

    await expect(
      service.requestApproval(
        previewApproval({
          requestId: 'request-preview-wrong-revision',
          arguments: { preview_id: preview.previewId, expected_revision: 6 }
        })
      )
    ).resolves.toEqual({ decision: 'deny' })
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)

    await expect(service.requestApproval(previewApproval())).resolves.toEqual({ decision: 'allow_once' })
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
    await expect(
      service.forwardMoleculeRequest({
        sessionId: 'session-2',
        method: 'molecule.commit_preview',
        params: { previewId: preview.previewId, expectedRevision: 7 }
      })
    ).rejects.toMatchObject({ data: { studioCode: 'APPROVAL_REQUIRED' } })
    await expect(
      service.forwardMoleculeRequest({
        sessionId,
        method: 'molecule.commit_preview',
        params: { previewId: preview.previewId, expectedRevision: 6 }
      })
    ).rejects.toMatchObject({ data: { studioCode: 'REVISION_CONFLICT' } })

    await expect(
      service.forwardMoleculeRequest({
        sessionId,
        method: 'molecule.commit_preview',
        params: { previewId: preview.previewId, expectedRevision: 7 }
      })
    ).resolves.toMatchObject({ previewId: preview.previewId, revision: 7 })
    await expect(
      service.forwardMoleculeRequest({
        sessionId,
        method: 'molecule.commit_preview',
        params: { previewId: preview.previewId, expectedRevision: 7 }
      })
    ).rejects.toMatchObject({ data: { studioCode: 'APPROVAL_REQUIRED' } })
    await expect(service.requestApproval(previewApproval())).resolves.toEqual({ decision: 'deny' })
    expect(editor.applyDraftPatch).toHaveBeenCalledTimes(1)
    expect(editor.commitPreview).not.toHaveBeenCalled()
  })

  it('previews a researcher edit through the trusted path and commits it only after approval', async () => {
    service.getSnapshot(sessionId, senderId)

    const receipt = await service.proposeHumanPatch(sessionId, senderId, {
      expectedRevision: 7,
      mode: 'measure',
      operations: [{ op: 'set_positions', positions: [{ atomId: 'atom-1', position: [1, 0, 0] }] }]
    })

    expect(receipt.previewId).toBe(preview.previewId)
    // The patch reaches the editor as a preview-only, human-attributed change on the committed revision.
    expect(editor.previewPatch).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'human', baseRevision: 7, previewOnly: true })
    )
    expect(editor.commitPreview).not.toHaveBeenCalled()

    const card = service.getSnapshot(sessionId, senderId).pendingApprovals[0]
    expect(card).toMatchObject({ kind: 'preview_commit', receipt: { previewId: preview.previewId } })
    const commitActionId = card.kind === 'preview_commit' ? card.commitActionId : ''
    const discardActionId = card.kind === 'preview_commit' ? card.discardActionId : ''

    const snapshot = await service.performAction(sessionId, commitActionId, senderId)
    expect(editor.commitPreview).toHaveBeenCalledWith(preview.previewId, 7)
    expect(snapshot.pendingApprovals).toHaveLength(0)
    // One approval authorises exactly one commit; the sibling action is spent with it.
    await expect(service.performAction(sessionId, discardActionId, senderId)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED'
    })
    expect(editor.commitPreview).toHaveBeenCalledTimes(1)
  })

  it('synchronizes a researcher selection without a revision, preview, or approval', async () => {
    service.getSnapshot(sessionId, senderId)

    await expect(
      service.setHumanSelection(sessionId, senderId, {
        documentId: 'molecule-1',
        expectedRevision: 7,
        atomIds: ['atom-1']
      })
    ).resolves.toMatchObject({ revision: 7, selections: ['atom-1'] })

    expect(editor.setSelection).toHaveBeenCalledWith('molecule-1', 7, ['atom-1'])
    expect(editor.previewPatch).not.toHaveBeenCalled()
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)

    await expect(
      service.setHumanSelection(sessionId, senderId, {
        documentId: 'molecule-1',
        expectedRevision: 6,
        atomIds: ['atom-1']
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(
      service.setHumanSelection(sessionId, 'window-2', {
        documentId: 'molecule-1',
        expectedRevision: 7,
        atomIds: ['atom-1']
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })

    const plan = calculationRuntime.getPreparedPlanForApproval()
    service.commitControlledRunStart({
      plan,
      reservation: {
        type: 'controlled_calculation_reservation',
        runId: 'run-selection',
        planId: plan.planId,
        planDigest: plan.planDigest,
        binding: plan.binding,
        executable: plan.executable,
        reservedAt: timestamp,
        extensions: {}
      },
      document
    })
    await expect(
      service.setHumanSelection(sessionId, senderId, {
        documentId: 'molecule-1',
        expectedRevision: 7,
        atomIds: ['atom-1']
      })
    ).resolves.toMatchObject({ revision: 7, selections: ['atom-1'] })
    expect(service.getSnapshot(sessionId, senderId).optimization?.run).toMatchObject({
      runId: 'run-selection',
      status: 'running'
    })
  })

  it('travels the researcher history through the editor without an approval', async () => {
    service.getSnapshot(sessionId, senderId)
    editor.undo.mockResolvedValueOnce({ ...document, revision: 8 })
    editor.redo.mockResolvedValueOnce({ ...document, revision: 9 })

    await expect(service.undoHuman(sessionId, senderId)).resolves.toMatchObject({ revision: 8 })
    expect(editor.undo).toHaveBeenCalledOnce()
    await expect(service.redoHuman(sessionId, senderId)).resolves.toMatchObject({ revision: 9 })
    expect(editor.redo).toHaveBeenCalledOnce()
    // History travel acts on the committed view: it never opens a preview or an approval card.
    expect(editor.previewPatch).not.toHaveBeenCalled()
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
  })

  it('refuses history travel from a window that does not own the session', async () => {
    service.getSnapshot(sessionId, senderId)
    // A lease is per session, held by one window. A second window is refused both directions; a fresh
    // session id from the owning window is not a breach, so it is not what this asserts.
    await expect(service.undoHuman(sessionId, 'window-2')).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
    await expect(service.redoHuman(sessionId, 'window-2')).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
    expect(editor.undo).not.toHaveBeenCalled()
    expect(editor.redo).not.toHaveBeenCalled()
  })

  it('refuses history travel while a replay owns the viewport', async () => {
    // `beforeEach` clears call history but not implementations, so a replay selection must be stated
    // here rather than inherited from whichever earlier test happened to install one.
    editor.getOptimizationReplayFrame.mockResolvedValue({
      runId: 'run-1',
      frame: replayExternalFrame,
      frameCount: 1,
      extensions: {}
    })
    service.getSnapshot(sessionId, senderId)
    await service.selectReplayFrame(sessionId, senderId, 'run-1', 0)
    await expect(service.undoHuman(sessionId, senderId)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(service.redoHuman(sessionId, senderId)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(editor.undo).not.toHaveBeenCalled()
    expect(editor.redo).not.toHaveBeenCalled()
  })

  it('allows stable-ID element and bond-order changes only as build previews', async () => {
    service.getSnapshot(sessionId, senderId)

    await service.proposeHumanPatch(sessionId, senderId, {
      expectedRevision: 7,
      mode: 'build',
      operations: [
        { op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-1', atomicNumber: 8 }] },
        { op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 2 }] }
      ]
    })

    expect(editor.previewPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'human',
        operations: [
          { op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-1', atomicNumber: 8 }] },
          { op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 2 }] }
        ],
        previewOnly: true
      })
    )
    expect(editor.commitPreview).not.toHaveBeenCalled()
  })

  it('refuses a researcher edit that a mode does not own, targets a stale revision, or arrives from another window', async () => {
    service.getSnapshot(sessionId, senderId)

    await expect(
      service.proposeHumanPatch(sessionId, senderId, {
        expectedRevision: 7,
        mode: 'measure',
        operations: [{ op: 'add_atoms', atoms: [] }]
      })
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })

    await expect(
      service.proposeHumanPatch(sessionId, senderId, {
        expectedRevision: 6,
        mode: 'build',
        operations: [{ op: 'remove_atoms', atomIds: ['atom-1'] }]
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

    await expect(
      service.proposeHumanPatch(sessionId, 'window-2', {
        expectedRevision: 7,
        mode: 'build',
        operations: [{ op: 'remove_atoms', atomIds: ['atom-1'] }]
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })

    expect(editor.previewPatch).not.toHaveBeenCalled()
  })

  it('keeps one preview at a time across the researcher and the agent', async () => {
    service.getSnapshot(sessionId, senderId)
    await service.proposeHumanPatch(sessionId, senderId, {
      expectedRevision: 7,
      mode: 'build',
      operations: [{ op: 'remove_atoms', atomIds: ['atom-1'] }]
    })

    await expect(
      service.proposeHumanPatch(sessionId, senderId, {
        expectedRevision: 7,
        mode: 'build',
        operations: [{ op: 'remove_atoms', atomIds: ['atom-1'] }]
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(
      service.forwardMoleculeRequest({ sessionId, method: 'molecule.preview_patch', params: { patch } })
    ).rejects.toMatchObject({ data: { studioCode: 'REVISION_CONFLICT' } })
    expect(editor.previewPatch).toHaveBeenCalledTimes(1)
  })

  it('discards a researcher preview and leaves the committed molecule untouched', async () => {
    service.getSnapshot(sessionId, senderId)
    await service.proposeHumanPatch(sessionId, senderId, {
      expectedRevision: 7,
      mode: 'constrain',
      operations: [{ op: 'set_frozen_axes', masks: [{ atomId: 'atom-1', axes: [true, false, false] }] }]
    })

    const card = service.getSnapshot(sessionId, senderId).pendingApprovals[0]
    const discardActionId = card.kind === 'preview_commit' ? card.discardActionId : ''
    const snapshot = await service.performAction(sessionId, discardActionId, senderId)

    expect(editor.discardPreview).toHaveBeenCalledWith(preview.previewId)
    expect(editor.commitPreview).not.toHaveBeenCalled()
    expect(snapshot.pendingApprovals).toHaveLength(0)
  })

  it('binds a prepared calculation approval to trusted plan details and consumes it exactly once', async () => {
    service.getSnapshot(sessionId, senderId)
    const approval = service.requestApproval(preparedCalculationApproval())
    const card = service.getSnapshot(sessionId, senderId).pendingApprovals[0]

    expect(calculationRuntime.getPreparedPlanForApproval).toHaveBeenCalledWith(
      sessionId,
      'plan-xtb-1',
      `sha256:${'c'.repeat(64)}`
    )
    expect(card).toMatchObject({
      kind: 'controlled_calculation_start',
      documentId: document.documentId,
      expectedRevision: document.revision,
      engine: 'xtb',
      method: 'GFN2-xTB',
      settings: {
        maxSteps: 20,
        maxRuntimeSeconds: 30,
        threads: 1,
        charge: 0,
        multiplicity: 1
      },
      planId: 'plan-xtb-1',
      planDigest: `sha256:${'c'.repeat(64)}`,
      runtimeFingerprint: `sha256:${'f'.repeat(64)}`
    })

    const allowActionId = card.kind === 'controlled_calculation_start' ? card.allowActionId : ''
    await service.performAction(sessionId, allowActionId, senderId)
    await expect(approval).resolves.toEqual({ decision: 'allow_once' })

    expect(() => service.consumePreparedCalculationGrant(sessionId, 'plan-xtb-1', `sha256:${'0'.repeat(64)}`)).toThrow(
      'One-shot approval is missing or expired'
    )
    expect(() =>
      service.consumePreparedCalculationGrant(sessionId, 'plan-xtb-1', `sha256:${'c'.repeat(64)}`)
    ).not.toThrow()
    expect(() => service.consumePreparedCalculationGrant(sessionId, 'plan-xtb-1', `sha256:${'c'.repeat(64)}`)).toThrow(
      'One-shot approval is missing or expired'
    )
  })

  it('rejects a historical native UFF plan instead of creating an execution card', async () => {
    const xtbPlan = calculationRuntime.getPreparedPlanForApproval()
    calculationRuntime.getPreparedPlanForApproval.mockReturnValue({
      ...xtbPlan,
      planId: 'plan-uff-1',
      planDigest: `sha256:${'1'.repeat(64)}`,
      settingsDigest: `sha256:${'2'.repeat(64)}`,
      engine: 'avogadro',
      method: 'UFF',
      executable: {
        kind: 'native_editor',
        engine: 'avogadro',
        version: 'avogadro-studio@5886a401dec4bf6be1c3d85350ef85f304eab5db',
        architecture: 'arm64',
        executableDigest: `sha256:${'3'.repeat(64)}`,
        runtimeFingerprint: `sha256:${'4'.repeat(64)}`,
        libraries: [],
        verifiedAt: timestamp
      }
    })
    service.getSnapshot(sessionId, senderId)
    const approval = service.requestApproval(
      preparedCalculationApproval({
        arguments: {
          plan_id: 'plan-uff-1',
          plan_digest: `sha256:${'1'.repeat(64)}`
        }
      } as Partial<StudioApprovalRequest>)
    )
    await expect(approval).resolves.toEqual({ decision: 'deny' })
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
    expect(() => service.consumePreparedCalculationGrant(sessionId, 'plan-uff-1', `sha256:${'1'.repeat(64)}`)).toThrow(
      'One-shot approval is missing or expired'
    )
  })

  it('projects controlled runtime frames into a separate final-geometry decision', async () => {
    service.getSnapshot(sessionId, senderId)
    const plan = calculationRuntime.getPreparedPlanForApproval()
    const reservation = {
      type: 'controlled_calculation_reservation' as const,
      runId: 'run-1',
      planId: plan.planId,
      planDigest: plan.planDigest,
      binding: plan.binding,
      executable: plan.executable,
      reservedAt: timestamp,
      extensions: {}
    }

    service.commitControlledRunStart({ plan, reservation, document })
    expect(service.getSnapshot(sessionId, senderId).optimization).toMatchObject({
      run: { runId: 'run-1', engine: 'xtb', method: 'GFN2-xTB', status: 'running' },
      frameCount: 0,
      latestFrame: null
    })

    controlledFrameListener({
      type: 'controlled_calculation_frame',
      runId: 'run-1',
      frameIndex: 0,
      engineStepIndex: 0,
      atomIds: ['atom-1'],
      atomicNumbers: [6],
      positions: [[1.23456789, 0, 0]],
      coordinateUnit: 'angstrom',
      provenance: { coordinateSource: 'engine', atomOrder: 'document_stable_id_order', transformation: 'none' },
      energy: { value: -1, unit: 'hartree' },
      gradientNorm: { value: 0.000158527152, unit: 'hartree/bohr' },
      structureHash: afterHash,
      timestamp,
      extensions: {}
    } as unknown as ControlledCalculationExternalFrame)
    controlledTerminalListener({
      type: 'controlled_calculation_terminal',
      runId: 'run-1',
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: afterHash,
      completedAt: timestamp,
      extensions: {}
    })

    const finalState = service.getSnapshot(sessionId, senderId).optimization
    expect(finalState).toMatchObject({
      run: { runId: 'run-1', status: 'awaiting_final_geometry' },
      frameCount: 1,
      latestFrame: {
        stepIndex: 0,
        structureHash: afterHash,
        gradientNorm: { value: 0.000158527152, unit: 'hartree/bohr' }
      },
      finalGeometry: { risk: 'final_geometry_commit', expectedRevision: 7 }
    })
    expect(finalState?.latestFrame).not.toHaveProperty('convergence')

    editor.getOptimizationReplayFrame.mockResolvedValue({
      runId: 'run-1',
      frame: replayExternalFrame,
      frameCount: 1,
      extensions: {}
    })
    await expect(service.selectReplayFrame(sessionId, senderId, 'run-1', 0)).resolves.toMatchObject({
      viewing: true,
      runId: 'run-1',
      stepIndex: 0
    })
    await service.stopReplay(sessionId, senderId)

    await service.performAction(sessionId, finalState!.finalGeometry!.rejectActionId, senderId)
    expect(calculationRuntime.rejectFinalGeometry).toHaveBeenCalledWith('run-1')
    expect(service.getSnapshot(sessionId, senderId).optimization).toBeNull()
  })

  it('recovers an awaiting-final controlled run only into its exact owning session', async () => {
    const plan = calculationRuntime.getPreparedPlanForApproval()
    const reservation = {
      type: 'controlled_calculation_reservation' as const,
      runId: 'run-recovered-1',
      planId: plan.planId,
      planDigest: plan.planDigest,
      binding: plan.binding,
      executable: plan.executable,
      reservedAt: timestamp,
      extensions: {}
    }
    const latestFrame: ControlledCalculationExternalFrame = {
      type: 'controlled_calculation_frame',
      runId: reservation.runId,
      frameIndex: 0,
      engineStepIndex: 0,
      atomIds: ['atom-1'],
      atomicNumbers: [6],
      positions: [[1.23456789, 0, 0]],
      coordinateUnit: 'angstrom',
      provenance: { coordinateSource: 'engine', atomOrder: 'document_stable_id_order', transformation: 'none' },
      energy: { value: -1, unit: 'hartree' },
      forceMetrics: { max: 0.01, rms: 0.005, unit: 'hartree/bohr' },
      structureHash: afterHash,
      timestamp,
      extensions: {}
    }
    const terminal: ControlledCalculationTerminal = {
      type: 'controlled_calculation_terminal',
      runId: reservation.runId,
      status: 'completed',
      frameCount: 1,
      outputGeometryHash: afterHash,
      completedAt: timestamp,
      extensions: {}
    }
    calculationRuntime.getRecoverableFinalDecisions.mockReturnValue([{ plan, reservation, latestFrame, terminal }])
    editor.getOptimizationReplayCatalog.mockResolvedValue({
      totalRuns: 1,
      runs: [
        {
          run: {
            runId: reservation.runId,
            documentId: document.documentId,
            inputRevision: document.revision,
            engine: 'xtb',
            method: 'GFN2-xTB',
            settings: {
              maxSteps: 20,
              charge: 0,
              multiplicity: 1,
              extensions: {}
            },
            frozenAtomIds: [],
            constraintIds: [],
            status: 'running',
            createdAt: timestamp,
            extensions: { 'chemsmart.controlled': { plan, reservation } }
          },
          frameCount: 1,
          latestFrame: {
            runId: reservation.runId,
            stepIndex: 0,
            energy: latestFrame.energy,
            forceMetrics: latestFrame.forceMetrics,
            timestamp
          },
          outcome: 'awaiting_final_geometry',
          message: '',
          updatedAt: timestamp,
          replayable: true,
          extensions: {}
        }
      ],
      nextRunId: null,
      extensions: {}
    })
    editor.getPersistedActiveRunId.mockResolvedValue(reservation.runId)

    moleculeChangedListener({ documentId: document.documentId, revision: document.revision })

    await vi.waitFor(() => {
      expect(service.getSnapshot(sessionId, senderId).optimization).toMatchObject({
        run: { runId: reservation.runId, status: 'awaiting_final_geometry' },
        frameCount: 1,
        latestFrame: { structureHash: afterHash },
        finalGeometry: { expectedRevision: document.revision }
      })
    })
    expect(service.getSnapshot('session-other', 'window-2').optimization).toBeNull()

    calculationRuntime.rejectFinalGeometry.mockResolvedValueOnce({
      type: 'optimization_final_rejected',
      runId: reservation.runId,
      revision: document.revision,
      timestamp
    })
    const rejectActionId = service.getSnapshot(sessionId, senderId).optimization?.finalGeometry?.rejectActionId ?? ''
    await service.performAction(sessionId, rejectActionId, senderId)
    expect(calculationRuntime.rejectFinalGeometry).toHaveBeenCalledWith(reservation.runId)
  })

  it('expires pending approvals and their action capabilities', async () => {
    service.getSnapshot(sessionId, senderId)
    const approval = service.requestApproval(preparedCalculationApproval())
    const card = service.getSnapshot(sessionId, senderId).pendingApprovals[0]
    const actionId = card.kind === 'controlled_calculation_start' ? card.allowActionId : ''

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)

    await expect(approval).resolves.toEqual({ decision: 'deny' })
    await expect(service.performAction(sessionId, actionId, senderId)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED'
    })
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
  })

  it('denies pending approvals and revokes their actions when the renderer window is destroyed', async () => {
    service.getSnapshot(sessionId, senderId)
    const approval = service.requestApproval(preparedCalculationApproval())
    const card = service.getSnapshot(sessionId, senderId).pendingApprovals[0]
    const actionId = card.kind === 'controlled_calculation_start' ? card.allowActionId : ''

    windowDestroyedListener({ id: senderId })

    await expect(approval).resolves.toEqual({ decision: 'deny' })
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
    await expect(service.performAction(sessionId, actionId, senderId)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED'
    })
  })

  it('allows cancellation only through a one-shot main-issued action', async () => {
    const running = await approveCalculation()
    expect(running.optimization).toMatchObject({ run: { runId: 'run-1', status: 'running' }, frameCount: 0 })
    const cancelActionId = running.optimization?.cancelActionId ?? ''

    await expect(
      service.forwardMoleculeRequest({ sessionId, method: 'optimization.cancel', params: { runId: 'run-1' } })
    ).rejects.toMatchObject({ data: { studioCode: 'APPROVAL_REQUIRED' } })
    expect(calculationRuntime.cancelCalculation).not.toHaveBeenCalled()

    await expect(service.performAction(sessionId, cancelActionId, senderId)).resolves.toMatchObject({
      optimization: null
    })
    await expect(service.performAction(sessionId, cancelActionId, senderId)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED'
    })
    expect(calculationRuntime.cancelCalculation).toHaveBeenCalledTimes(1)
    expect(calculationRuntime.cancelCalculation).toHaveBeenCalledWith('run-1')
  })

  it('routes a controlled-run cancellation to the calculation runtime', async () => {
    service.getSnapshot(sessionId, senderId)
    const plan = calculationRuntime.getPreparedPlanForApproval()
    service.commitControlledRunStart({
      plan,
      document,
      reservation: {
        type: 'controlled_calculation_reservation',
        runId: 'run-1',
        planId: plan.planId,
        planDigest: plan.planDigest,
        binding: plan.binding,
        executable: plan.executable,
        reservedAt: timestamp,
        extensions: {}
      }
    })
    calculationRuntime.cancelCalculation.mockResolvedValue({
      type: 'controlled_calculation_terminal',
      runId: 'run-1',
      status: 'cancelled',
      frameCount: 0,
      reason: 'User cancelled',
      terminatedAt: timestamp,
      extensions: {}
    })

    const cancelActionId = service.getSnapshot(sessionId, senderId).optimization?.cancelActionId ?? ''
    await expect(service.performAction(sessionId, cancelActionId, senderId)).resolves.toMatchObject({
      optimization: null
    })

    expect(calculationRuntime.cancelCalculation).toHaveBeenCalledWith('run-1')
  })

  it('offers sibling final-geometry actions after a trusted frame and consumes both when accepting', async () => {
    await approveCalculation()
    completeControlledCalculation()
    const awaiting = service.getSnapshot(sessionId, senderId)
    const finalGeometry = awaiting.optimization?.finalGeometry
    expect(finalGeometry).toMatchObject({
      risk: 'final_geometry_commit',
      expectedRevision: 7,
      frame: { runId: 'run-1', stepIndex: 0, structureHash: afterHash }
    })

    await expect(
      service.forwardMoleculeRequest({
        sessionId,
        method: 'optimization.accept_final',
        params: { runId: 'run-1', expectedRevision: 7 }
      })
    ).rejects.toMatchObject({ data: { studioCode: 'APPROVAL_REQUIRED' } })
    expect(calculationRuntime.acceptFinalGeometry).not.toHaveBeenCalled()

    await expect(
      service.performAction(sessionId, finalGeometry?.acceptActionId ?? '', senderId)
    ).resolves.toMatchObject({
      optimization: null
    })
    await expect(service.performAction(sessionId, finalGeometry?.rejectActionId ?? '', senderId)).rejects.toMatchObject(
      {
        code: 'APPROVAL_REQUIRED'
      }
    )
    expect(calculationRuntime.acceptFinalGeometry).toHaveBeenCalledTimes(1)
    expect(calculationRuntime.acceptFinalGeometry).toHaveBeenCalledWith('run-1', 7)
    expect(calculationRuntime.rejectFinalGeometry).not.toHaveBeenCalled()
  })

  it('preserves awaiting-final state and issues fresh actions when final acceptance fails', async () => {
    await approveCalculation()
    completeControlledCalculation()
    const before = service.getSnapshot(sessionId, senderId)
    const failedActions = before.optimization?.finalGeometry
    const notificationCount = ipcSendMock.mock.calls.length
    calculationRuntime.acceptFinalGeometry.mockRejectedValueOnce(new Error('sidecar final decision unavailable'))

    await expect(service.performAction(sessionId, failedActions?.acceptActionId ?? '', senderId)).rejects.toThrowError(
      'sidecar final decision unavailable'
    )
    await expect(service.performAction(sessionId, failedActions?.rejectActionId ?? '', senderId)).rejects.toMatchObject(
      { code: 'APPROVAL_REQUIRED' }
    )
    expect(ipcSendMock).toHaveBeenCalledTimes(notificationCount + 1)

    const retry = service.getSnapshot(sessionId, senderId)
    expect(ipcSendMock).toHaveBeenCalledTimes(notificationCount + 1)
    expect(retry.snapshotRevision).toBe(before.snapshotRevision + 1)
    expect(retry.molecule).toEqual(before.molecule)
    expect(retry.activity).toEqual(before.activity)
    expect(retry.optimization).toMatchObject({
      run: { runId: 'run-1', status: 'awaiting_final_geometry' },
      frameCount: 1,
      latestFrame: before.optimization?.latestFrame
    })
    expect(retry.optimization?.finalGeometry?.acceptActionId).not.toBe(failedActions?.acceptActionId)
    expect(retry.optimization?.finalGeometry?.rejectActionId).not.toBe(failedActions?.rejectActionId)

    await expect(
      service.performAction(sessionId, retry.optimization?.finalGeometry?.acceptActionId ?? '', senderId)
    ).resolves.toMatchObject({ optimization: null })
    expect(calculationRuntime.acceptFinalGeometry).toHaveBeenCalledTimes(2)
    expect(calculationRuntime.rejectFinalGeometry).not.toHaveBeenCalled()
  })

  it('preserves awaiting-final state and issues fresh actions for a contradictory rejection receipt', async () => {
    await approveCalculation()
    completeControlledCalculation()
    const before = service.getSnapshot(sessionId, senderId)
    const failedActions = before.optimization?.finalGeometry
    const notificationCount = ipcSendMock.mock.calls.length
    calculationRuntime.rejectFinalGeometry.mockResolvedValueOnce({
      type: 'optimization_final_rejected',
      runId: 'run-forged',
      revision: 7,
      timestamp
    })

    await expect(service.performAction(sessionId, failedActions?.rejectActionId ?? '', senderId)).rejects.toMatchObject(
      { code: 'SCHEMA_INVALID' }
    )
    await expect(service.performAction(sessionId, failedActions?.acceptActionId ?? '', senderId)).rejects.toMatchObject(
      { code: 'APPROVAL_REQUIRED' }
    )
    expect(ipcSendMock).toHaveBeenCalledTimes(notificationCount + 1)

    const retry = service.getSnapshot(sessionId, senderId)
    expect(ipcSendMock).toHaveBeenCalledTimes(notificationCount + 1)
    expect(retry.snapshotRevision).toBe(before.snapshotRevision + 1)
    expect(retry.molecule).toEqual(before.molecule)
    expect(retry.activity).toEqual(before.activity)
    expect(retry.optimization).toMatchObject({
      run: { runId: 'run-1', status: 'awaiting_final_geometry' },
      frameCount: 1,
      latestFrame: before.optimization?.latestFrame
    })
    expect(retry.optimization?.finalGeometry?.acceptActionId).not.toBe(failedActions?.acceptActionId)
    expect(retry.optimization?.finalGeometry?.rejectActionId).not.toBe(failedActions?.rejectActionId)

    await expect(
      service.performAction(sessionId, retry.optimization?.finalGeometry?.rejectActionId ?? '', senderId)
    ).resolves.toMatchObject({ optimization: null })
    expect(calculationRuntime.rejectFinalGeometry).toHaveBeenCalledTimes(2)
    expect(calculationRuntime.acceptFinalGeometry).not.toHaveBeenCalled()
  })

  it('rejects final geometry through its one-shot control without mutating the molecule', async () => {
    await approveCalculation()
    completeControlledCalculation()
    const rejectActionId = service.getSnapshot(sessionId, senderId).optimization?.finalGeometry?.rejectActionId ?? ''

    await expect(service.performAction(sessionId, rejectActionId, senderId)).resolves.toMatchObject({
      optimization: null
    })
    await expect(service.performAction(sessionId, rejectActionId, senderId)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED'
    })
    expect(calculationRuntime.rejectFinalGeometry).toHaveBeenCalledTimes(1)
    expect(calculationRuntime.acceptFinalGeometry).not.toHaveBeenCalled()
    expect(editor.commitPreview).not.toHaveBeenCalled()
  })

  it('updates only the trusted molecule summary when the editor reports a committed change', () => {
    service.getSnapshot(sessionId, senderId)
    moleculeChangedListener({ documentId: document.documentId, revision: 8 })

    const snapshot = service.getSnapshot(sessionId, senderId)
    expect(snapshot.molecule).toEqual({ documentId: document.documentId, revision: 8 })
    expect(JSON.stringify(snapshot)).not.toContain('position')
  })
  it('does not ask for draft appends in Allow mode', async () => {
    await preparePreview()
    expect(service.agentMode(sessionId)).toBe('allow')

    await expect(service.requestApproval(previewApproval())).resolves.toEqual({ decision: 'allow_once' })

    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(0)
  })

  it('keeps draft append behavior independent of Agent mode', async () => {
    await preparePreview()
    service.getSnapshot(sessionId, senderId)
    service.setAgentMode(sessionId, 'execute', senderId)

    await expect(service.requestApproval(previewApproval())).resolves.toEqual({ decision: 'allow_once' })

    const snapshot = service.getSnapshot(sessionId, senderId)
    expect(snapshot.pendingApprovals).toHaveLength(0)
    expect(editor.applyDraftPatch).toHaveBeenCalledTimes(1)
  })

  it('still raises a card for a calculation in Execute mode', async () => {
    service.getSnapshot(sessionId, senderId)
    service.setAgentMode(sessionId, 'execute', senderId)

    void service.requestApproval(preparedCalculationApproval())

    // Compute spent is not undone by a revision, so no mode grants it.
    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toHaveLength(1)
  })

  it('still raises exact execution cards in Execute mode', async () => {
    service.getSnapshot(sessionId, senderId)
    service.setAgentMode(sessionId, 'execute', senderId)

    void service.requestApproval(executionApproval('run_local', { job: 'job_abcd' }, 'request-run-local-execute-mode'))

    expect(service.getSnapshot(sessionId, senderId).pendingApprovals).toMatchObject([
      { kind: 'execution_tool', tool: 'run_local', arguments: { job: 'job_abcd' } }
    ])
  })

  it('refuses a mode switch from a window that does not hold the session', async () => {
    service.getSnapshot(sessionId, senderId)

    expect(() => service.setAgentMode(sessionId, 'execute', 'window-2')).toThrow()
    expect(service.agentMode(sessionId)).toBe('allow')
  })

  it('records the mode switch where the researcher can see it', async () => {
    service.getSnapshot(sessionId, senderId)

    service.setAgentMode(sessionId, 'execute', senderId)

    const entry = service.getSnapshot(sessionId, senderId).activity.at(-1)
    expect(entry).toMatchObject({ kind: 'runtime', status: 'completed' })
  })
})
