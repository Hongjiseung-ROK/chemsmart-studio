import { IpcError } from '@shared/ipc/errors/IpcError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock } = vi.hoisted(() => ({ appGetMock: vi.fn() }))
vi.mock('@application', () => ({ application: { get: appGetMock } }))

import { chemsmartStudioHandlers } from '../chemsmartStudio'

const editor = {
  getCachedMoleculeSummary: vi.fn(),
  getMoleculeDocument: vi.fn(),
  focus: vi.fn(),
  openProject: vi.fn(),
  importMolecule: vi.fn(),
  saveProjectAs: vi.fn()
}
const agent = {
  getDeterministicModelId: vi.fn<() => 'deterministic::controlled-calculation' | null>(() => null),
  getStatus: vi.fn(() => ({ state: 'running', pid: 42, lastError: null })),
  listProjects: vi.fn(),
  readProject: vi.fn(),
  validateProject: vi.fn(),
  critiqueProject: vi.fn(),
  synthesizeCommand: vi.fn(),
  inspectCommand: vi.fn(),
  runTurn: vi.fn(),
  controlTurn: vi.fn()
}
const control = {
  getSnapshot: vi.fn(),
  performAction: vi.fn(),
  setHumanSelection: vi.fn(),
  undoHuman: vi.fn(),
  redoHuman: vi.fn()
}
const viewport = {
  activateFrame: vi.fn(),
  captureFrame: vi.fn(),
  getToolState: vi.fn(),
  getTransportState: vi.fn(),
  negotiateTransport: vi.fn(),
  sendInput: vi.fn(),
  setTool: vi.fn()
}
const sharedTexture = {
  acknowledgeFramePresented: vi.fn(),
  declareRendererReady: vi.fn()
}
const ctx = { senderId: 'main-window' }

beforeEach(() => {
  vi.clearAllMocks()
  appGetMock.mockImplementation((name: string) => {
    if (name === 'MoleculeWorkspaceService') return editor
    if (name === 'ChemSmartAgentService') return agent
    if (name === 'StudioControlService') return control
    if (name === 'NativeViewportHost') return viewport
    if (name === 'NativeViewportSharedTextureService') return sharedTexture
    throw new Error(`Unexpected application.get(${name})`)
  })
})

describe('chemsmartStudioHandlers', () => {
  it('reports only the supervised Python sidecar state', async () => {
    await expect(chemsmartStudioHandlers['chemsmart_studio.status'](undefined, ctx)).resolves.toEqual({
      agent: { state: 'running', pid: 42, lastError: null }
    })
  })

  it('exposes only the active non-production deterministic model identity', async () => {
    agent.getDeterministicModelId.mockReturnValueOnce('deterministic::controlled-calculation')

    await expect(chemsmartStudioHandlers['chemsmart_studio.agent.runtime_context'](undefined, ctx)).resolves.toEqual({
      deterministicModelId: 'deterministic::controlled-calculation'
    })
  })

  it('does not expose a generic renderer-to-native molecule request route', () => {
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.molecule.request')
  })

  it('forwards only a revision-bound selection through the managed Studio session', async () => {
    control.setHumanSelection.mockResolvedValueOnce({
      documentId: 'molecule-1',
      revision: 3,
      atoms: [],
      bonds: [],
      selections: [],
      frozenAxes: {},
      constraints: [],
      properties: { extensions: {} },
      extensions: {}
    })

    await expect(
      chemsmartStudioHandlers['chemsmart_studio.molecule.set_selection'](
        {
          sessionId: 'session-1',
          documentId: 'molecule-1',
          expectedRevision: 3,
          atomIds: []
        },
        ctx
      )
    ).resolves.toMatchObject({ documentId: 'molecule-1', revision: 3 })
    expect(control.setHumanSelection).toHaveBeenCalledWith('session-1', 'main-window', {
      documentId: 'molecule-1',
      expectedRevision: 3,
      atomIds: []
    })

    control.setHumanSelection.mockRejectedValueOnce(new IpcError('REVISION_CONFLICT', 'stale selection'))
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.molecule.set_selection'](
        {
          sessionId: 'session-1',
          documentId: 'molecule-1',
          expectedRevision: 2,
          atomIds: []
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('forwards researcher undo and redo through the managed Studio session', async () => {
    control.undoHuman.mockResolvedValueOnce({ documentId: 'molecule-1', revision: 9 })
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.molecule.undo']({ sessionId: 'session-1' }, ctx)
    ).resolves.toMatchObject({ documentId: 'molecule-1', revision: 9 })
    expect(control.undoHuman).toHaveBeenCalledWith('session-1', 'main-window')

    control.redoHuman.mockResolvedValueOnce({ documentId: 'molecule-1', revision: 10 })
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.molecule.redo']({ sessionId: 'session-1' }, ctx)
    ).resolves.toMatchObject({ documentId: 'molecule-1', revision: 10 })
    expect(control.redoHuman).toHaveBeenCalledWith('session-1', 'main-window')
  })

  it('rejects unmanaged history-travel callers before touching the control service', async () => {
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.molecule.undo']({ sessionId: 'session-1' }, { senderId: null })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.molecule.redo']({ sessionId: 'session-1' }, { senderId: null })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
    expect(control.undoHuman).not.toHaveBeenCalled()
    expect(control.redoHuman).not.toHaveBeenCalled()
  })

  it('exposes only the validated molecule summary', async () => {
    editor.getCachedMoleculeSummary.mockReturnValueOnce({ documentId: 'molecule-1', revision: 3 })

    await expect(chemsmartStudioHandlers['chemsmart_studio.molecule.summary'](undefined, ctx)).resolves.toEqual({
      documentId: 'molecule-1',
      revision: 3
    })
  })

  it.each([
    ['chemsmart_studio.editor.open_project', 'openProject'],
    ['chemsmart_studio.editor.import_molecule', 'importMolecule'],
    ['chemsmart_studio.editor.save_as', 'saveProjectAs']
  ] as const)('keeps project paths in main for %s', async (route, method) => {
    editor[method].mockResolvedValueOnce({
      canceled: false,
      molecule: { documentId: 'molecule-1', revision: 3 },
      documentName: 'Ethanol'
    })

    await expect(chemsmartStudioHandlers[route](undefined, ctx)).resolves.toEqual({
      canceled: false,
      molecule: { documentId: 'molecule-1', revision: 3 },
      documentName: 'Ethanol'
    })
    expect(editor[method]).toHaveBeenCalledOnce()
    expect(JSON.stringify(editor[method].mock.results[0].value)).not.toContain('/private/')
  })

  it('does not synthesize molecule state when no cached summary exists', async () => {
    editor.getCachedMoleculeSummary.mockReturnValueOnce(null)

    await expect(chemsmartStudioHandlers['chemsmart_studio.molecule.summary'](undefined, ctx)).rejects.toMatchObject({
      code: 'EDITOR_UNAVAILABLE'
    })
    expect(editor.getMoleculeDocument).not.toHaveBeenCalled()
  })

  it('never exposes the removed renderer approval response route', () => {
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.agent.respond_approval')
  })

  it('keeps sidecar turn details and filesystem paths in Electron main', async () => {
    agent.runTurn.mockResolvedValueOnce({
      session_dir: '/private/main-only/session',
      tool_outcomes: [{ result: { artifact_path: '/private/main-only/result.xyz' } }]
    })

    await expect(
      chemsmartStudioHandlers['chemsmart_studio.agent.run_turn'](
        {
          sessionId: 'session-1',
          modelId: 'deterministic::controlled-calculation',
          request: 'Run the controlled test.'
        },
        ctx
      )
    ).resolves.toEqual({ completed: true })
    expect(agent.runTurn).toHaveBeenCalledWith(
      'session-1',
      'deterministic::controlled-calculation',
      'Run the controlled test.',
      null,
      'main-window'
    )
  })

  it('binds Stop, Steer, and Queue controls to the managed Studio window', async () => {
    agent.controlTurn.mockResolvedValue({ accepted: true, action: 'stop', queueDepth: 0 })

    await expect(
      chemsmartStudioHandlers['chemsmart_studio.agent.control_turn']({ sessionId: 'session-1', action: 'stop' }, ctx)
    ).resolves.toEqual({ accepted: true, action: 'stop', queueDepth: 0 })
    expect(agent.controlTurn).toHaveBeenCalledWith({ sessionId: 'session-1', action: 'stop' }, 'main-window')

    await expect(
      chemsmartStudioHandlers['chemsmart_studio.agent.control_turn'](
        { sessionId: 'session-1', action: 'queue', request: 'Inspect the next frame.' },
        { senderId: null }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
  })

  it('binds turns to a managed sender without exposing process lifecycle or legacy UI replay routes', async () => {
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.agent.start')
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.agent.stop')
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.agent.replay_studio_ui')
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.agent.run_turn'](
        { sessionId: 'session-1', modelId: 'provider::model', request: 'Inspect.' },
        { senderId: null }
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_SENDER'
    })
  })

  it('preserves a cross-sender session-owner denial from the agent service', async () => {
    agent.runTurn.mockRejectedValueOnce(
      new IpcError('FORBIDDEN_SENDER', 'Studio session is controlled by another window')
    )

    await expect(
      chemsmartStudioHandlers['chemsmart_studio.agent.run_turn'](
        { sessionId: 'session-1', modelId: 'provider::model', request: 'Inspect.' },
        { senderId: 'window-2' }
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_SENDER'
    })
  })

  it('passes only closed project and synthesis contracts to the agent service', async () => {
    const listRequest = { extensions: {} }
    const synthesisRequest = {
      sessionId: 'session-1',
      modelId: 'provider::model' as const,
      request: 'Prepare an xTB optimization command.',
      extensions: {}
    }
    agent.listProjects.mockResolvedValueOnce({ schemaVersion: '1', programs: [], extensions: {} })
    agent.synthesizeCommand.mockResolvedValueOnce({ schemaVersion: '1', synthesisId: 'synthesis-1' })

    await chemsmartStudioHandlers['chemsmart_studio.project.list'](listRequest, ctx)
    await chemsmartStudioHandlers['chemsmart_studio.command.synthesize'](synthesisRequest, ctx)

    expect(agent.listProjects).toHaveBeenCalledWith(listRequest)
    expect(agent.synthesizeCommand).toHaveBeenCalledWith(synthesisRequest, 'main-window')
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.project.render')
    expect(chemsmartStudioHandlers).not.toHaveProperty('chemsmart_studio.project.write')
  })

  it('binds command inspection to a managed sender and returns only the schema result', async () => {
    const result = {
      schemaVersion: '1',
      inspectionId: 'inspection-1',
      sessionId: 'session-1',
      status: 'needs_clarification',
      commandDigest: '0'.repeat(64),
      parse: {
        accepted: true,
        action: 'run',
        program: 'xtb',
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
      intent: { verdict: 'unavailable', failedRuleIds: [], assertions: [] },
      semantic: {
        verdict: 'warn',
        complete: false,
        failedRuleIds: ['cmd.semantic.dry_run_required'],
        missingInfo: [],
        issues: [
          {
            ruleId: 'cmd.semantic.dry_run_required',
            severity: 'warn',
            message: 'Dry run is required.'
          }
        ]
      },
      dryRun: { state: 'required', processStarted: false },
      executionPerformed: false,
      approvalRequiredForExecution: true,
      missingInfo: ['explicit research intent'],
      extensions: {}
    }
    agent.inspectCommand.mockResolvedValueOnce(result)
    const request = {
      sessionId: 'session-1',
      command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt'
    }

    await expect(chemsmartStudioHandlers['chemsmart_studio.command.inspect'](request, ctx)).resolves.toEqual(result)
    expect(agent.inspectCommand).toHaveBeenCalledWith(request)
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.command.inspect'](request, {
        senderId: null
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
  })

  it('binds trusted snapshots and one-shot actions to the managed sender', async () => {
    const snapshot = {
      sessionId: 'session-1',
      snapshotRevision: 0,
      molecule: null,
      pendingApprovals: [],
      activity: [],
      optimization: null,
      extensions: {}
    }
    control.getSnapshot.mockReturnValueOnce(snapshot)
    control.performAction.mockResolvedValueOnce({ ...snapshot, snapshotRevision: 1 })

    await expect(
      chemsmartStudioHandlers['chemsmart_studio.control.snapshot']({ sessionId: 'session-1' }, ctx)
    ).resolves.toEqual(snapshot)
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.control.perform_action'](
        { sessionId: 'session-1', actionId: 'action-1' },
        ctx
      )
    ).resolves.toEqual({ ...snapshot, snapshotRevision: 1 })
    expect(control.getSnapshot).toHaveBeenCalledWith('session-1', 'main-window')
    expect(control.performAction).toHaveBeenCalledWith('session-1', 'action-1', 'main-window')
  })

  it('rejects trusted controls from an unmanaged sender', async () => {
    await expect(
      chemsmartStudioHandlers['chemsmart_studio.control.snapshot']({ sessionId: 'session-1' }, { senderId: null })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SENDER' })
  })
})
