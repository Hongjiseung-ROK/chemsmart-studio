import '@testing-library/jest-dom/vitest'

import type {
  MoleculeDocument,
  MoleculeOperation,
  StudioAgentTurnEvent,
  StudioControlSnapshot,
  StudioDraftSnapshot
} from '@chemsmart/studio-protocol'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChemSmartWorkspace as ChemSmartStudioPanel } from '../ChemSmartWorkspace'

if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false
if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {}
if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}

const ipcMocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  order: [] as string[],
  request: vi.fn()
}))

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => loggerMocks
  }
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: async (route: string, ...args: unknown[]) => {
      try {
        const result = await ipcMocks.request(route, ...args)
        return route === 'chemsmart_studio.molecule.draft_snapshot' && result === undefined ? null : result
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unexpected route:')) {
          if (route === 'chemsmart_studio.molecule.draft_snapshot') return null
          if (route === 'chemsmart_studio.agent.update_workspace_view') return { accepted: true }
          if (route === 'chemsmart_studio.agent.capabilities') {
            return {
              threadId: 'topic-a',
              projectId: 'project-1',
              generatedAt: '2026-07-29T00:00:00Z',
              items: [],
              extensions: {}
            }
          }
          if (route === 'chemsmart_studio.agent.turns') {
            return { threadId: 'topic-a', events: [], nextBeforeSequence: null, extensions: {} }
          }
        }
        throw error
      }
    }
  },
  useIpcOn: (event: string, handler: (payload: never) => void) => {
    ipcMocks.order.push(`subscribe:${event}`)
    ipcMocks.listeners.set(event, handler)
  }
}))

// jsdom has no WebGL context, and a panel test has no business starting a real renderer —
// the engine is covered by its own tests in packages/chem-molecular-engine. The gesture handlers it
// is handed are kept, so a test can play a pick or a finished drag down the same path a pointer takes.
const stageEngine = vi.hoisted(() => ({
  handlers: null as {
    onAtomMoved?: (atomId: string, position: readonly [number, number, number]) => void
    onPlacementPick?: (siteIndex: number) => void
    onPick?: (
      atomId: string | null,
      additive: boolean,
      emptyPosition?: readonly [number, number, number] | null
    ) => void
  } | null,
  setGizmoTarget: vi.fn(),
  setTransformEnabled: vi.fn(),
  setPlacementPreview: vi.fn(),
  setActionCues: vi.fn()
}))

vi.mock('@chemsmart/molecular-engine', () => ({
  MoleculeCanvas: class {
    setDocument = vi.fn()
    frameAll = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    setGizmoTarget = stageEngine.setGizmoTarget
    setTransformEnabled = stageEngine.setTransformEnabled
    setPlacementPreview = stageEngine.setPlacementPreview
    setActionCues = stageEngine.setActionCues
    constructor(_canvas: HTMLCanvasElement, handlers: NonNullable<typeof stageEngine.handlers>) {
      stageEngine.handlers = handlers
    }
  }
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useDefaultModel: () => ({ defaultModel: undefined })
}))

// The rail's own tree is not exercised here — `DynamicVirtualList` needs a sized scroll container
// that jsdom does not provide, so rendering it would prove nothing. `ResearchRail.test.tsx` covers
// the tree with virtualization bypassed, including that it deliberately *does* show `.cmsproj`
// names. This file keeps its path-leak assertion scoped to the panel surfaces instead.
const projectTree = vi.hoisted(() => ({ rootPath: '/private/user/Projects', bundle: 'Toluene.cmsproj' }))

vi.mock('@renderer/hooks/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ root: null, isLoading: false, error: null, version: 0, treeId: null, getNode: () => null })
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    Scrollbar: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>
  }
})

function stoppedStatus() {
  return {
    agent: { state: 'stopped', pid: null, lastError: null }
  } as const
}

function emptyControlSnapshot(sessionId = 'topic-a'): StudioControlSnapshot {
  return {
    sessionId,
    snapshotRevision: 0,
    molecule: null,
    pendingApprovals: [],
    activity: [],
    optimization: null,
    extensions: {}
  }
}

function moleculeDraft(
  document: MoleculeDocument,
  operations: MoleculeOperation[] = [{ op: 'set_positions', positions: [] }]
): StudioDraftSnapshot {
  const now = '2026-07-29T00:00:00Z'
  return {
    draftId: 'draft-1',
    documentId: document.documentId,
    baseRevision: document.revision,
    document,
    entries: [
      {
        entryId: 'draft-entry-1',
        actor: 'human',
        mode: 'build',
        operations,
        summary: {
          operationKinds: operations.map(({ op }) => op),
          elementChanges: [],
          coordinateChangeCount: 0,
          bondChangeCount: 0,
          constraintChangeCount: 0,
          affectedAtomIds: [],
          affectedBondIds: [],
          affectedConstraintIds: []
        },
        beforeHash: `sha256:${'a'.repeat(64)}`,
        afterHash: `sha256:${'b'.repeat(64)}`,
        createdAt: now,
        extensions: {}
      }
    ],
    cursor: 1,
    dirty: true,
    canUndo: true,
    canRedo: false,
    createdAt: now,
    updatedAt: now,
    extensions: {}
  }
}

function previewControlSnapshot(sessionId = 'topic-a'): StudioControlSnapshot {
  return {
    ...emptyControlSnapshot(sessionId),
    snapshotRevision: 1,
    pendingApprovals: [
      {
        kind: 'preview_commit',
        requestId: 'request-preview',
        approvalId: 'approval-preview',
        requestedAt: '2026-07-22T00:00:00Z',
        expiresAt: '2026-07-22T00:05:00Z',
        risk: 'molecule_mutation',
        receipt: {
          previewId: 'preview-1',
          operationId: 'operation-1',
          baseRevision: 4,
          affectedAtomIds: ['atom-1', 'atom-2'],
          affectedBondIds: ['bond-1'],
          beforeHash: 'a'.repeat(64),
          afterHash: 'b'.repeat(64),
          diff: { operationCount: 3, movedAtomCount: 2 },
          summary: {
            operationKinds: ['set_atomic_numbers', 'set_positions', 'set_bond_orders'],
            elementChanges: [
              {
                atomId: 'atom-1',
                kind: 'changed',
                beforeAtomicNumber: 8,
                afterAtomicNumber: 6
              }
            ],
            coordinateChangeCount: 2,
            bondChangeCount: 1,
            constraintChangeCount: 0,
            affectedAtomIds: ['atom-1', 'atom-2'],
            affectedBondIds: ['bond-1'],
            affectedConstraintIds: []
          },
          createdAt: '2026-07-22T00:00:00Z',
          extensions: {
            coordinates: { positions: [1, 2, 3] },
            providerArguments: { apiKey: 'must-not-render' },
            rawJson: { value: '{"action":"bypass"}' }
          }
        },
        commitActionId: 'action-commit',
        discardActionId: 'action-discard'
      }
    ],
    activity: [
      {
        activityId: 'activity-1',
        sequence: 0,
        timestamp: '2026-07-22T00:00:00Z',
        kind: 'semantic_gate',
        status: 'needs_user',
        title: 'UNLOCALIZED MAIN TITLE',
        summary: 'UNLOCALIZED MAIN SUMMARY',
        toolName: 'commit_molecule_preview',
        extensions: { rawCoordinates: { value: [[9, 8, 7]] } }
      }
    ],
    extensions: { rawJson: { value: 'TOP-LEVEL-RAW' } }
  }
}

function controlledCalculationControlSnapshot(sessionId = 'topic-a'): StudioControlSnapshot {
  return {
    ...emptyControlSnapshot(sessionId),
    snapshotRevision: 3,
    pendingApprovals: [
      {
        kind: 'controlled_calculation_start',
        requestId: 'request-controlled-calculation',
        approvalId: 'approval-controlled-calculation',
        requestedAt: '2026-07-23T00:00:00Z',
        expiresAt: '2026-07-23T00:05:00Z',
        risk: 'calculation_execution',
        documentId: 'ethanol-fixture',
        expectedRevision: 4,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: {
          maxSteps: 100,
          maxRuntimeSeconds: 180,
          threads: 1,
          charge: 0,
          multiplicity: 1,
          extensions: {}
        },
        planId: 'plan-ethanol-1',
        planDigest: `sha256:${'a'.repeat(64)}`,
        runtimeFingerprint: `sha256:${'b'.repeat(64)}`,
        allowActionId: 'action-start-controlled',
        denyActionId: 'action-deny-controlled'
      }
    ]
  }
}

function executionControlSnapshot(sessionId = 'topic-a'): StudioControlSnapshot {
  return {
    ...emptyControlSnapshot(sessionId),
    snapshotRevision: 4,
    pendingApprovals: [
      {
        kind: 'execution_tool',
        requestId: 'request-execute-command',
        approvalId: 'approval-execute-command',
        requestedAt: '2026-07-23T00:00:00Z',
        expiresAt: '2026-07-23T00:05:00Z',
        risk: 'calculation_execution',
        tool: 'execute_chemsmart_command',
        arguments: {
          command: 'chemsmart run gaussian sp water',
          test: true,
          timeout_s: 30
        },
        calculationKind: 'single_point',
        commandDigest: 'd'.repeat(64),
        documentId: 'water',
        engine: 'gaussian',
        expectedRevision: 2,
        geometryHash: `sha256:${'c'.repeat(64)}`,
        method: 'B3LYP/6-31G(d)',
        planId: 'synthesis-water-sp',
        allowActionId: 'action-execute-once',
        denyActionId: 'action-deny-execution'
      }
    ]
  }
}

function optimizationControlSnapshot(
  status: 'running' | 'failed' | 'awaiting_final_geometry',
  sessionId = 'topic-a'
): StudioControlSnapshot {
  const frame = {
    runId: 'run-1',
    stepIndex: 2,
    energy: { value: -40.5, unit: 'hartree' as const },
    forceMetrics: { max: 0.03, rms: 0.01, unit: 'hartree/bohr' as const },
    convergence: { converged: false, threshold: 0.001 },
    structureHash: 'c'.repeat(64),
    timestamp: '2026-07-22T00:02:00Z'
  }

  return {
    ...emptyControlSnapshot(sessionId),
    snapshotRevision: 3,
    optimization: {
      run: {
        runId: 'run-1',
        documentId: 'molecule-1',
        inputRevision: 4,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: { maxSteps: 100, extensions: { rawArguments: { value: 'must-not-render' } } },
        frozenAtomIds: [],
        constraintIds: [],
        status,
        createdAt: '2026-07-22T00:00:00Z',
        extensions: { positions: { value: [[1, 2, 3]] } }
      },
      frameCount: 3,
      latestFrame: frame,
      ...(status === 'running' ? { cancelActionId: 'action-cancel' } : {}),
      finalGeometry:
        status === 'awaiting_final_geometry'
          ? {
              risk: 'final_geometry_commit',
              expectedRevision: 4,
              frame,
              acceptActionId: 'action-accept',
              rejectActionId: 'action-reject'
            }
          : null,
      extensions: { coordinates: { value: [1, 2, 3] } }
    }
  }
}

function replayCatalog() {
  const frame = {
    runId: 'run-recorded',
    stepIndex: 1,
    energy: { value: -2, unit: 'kJ/mol' as const },
    forceMetrics: { max: 0.1, unit: 'kJ/mol/angstrom' as const },
    convergence: { converged: false },
    timestamp: '2026-07-22T00:02:00Z'
  }
  return {
    totalRuns: 1,
    runs: [
      {
        run: {
          runId: 'run-recorded',
          documentId: 'molecule-1',
          inputRevision: 4,
          engine: 'xtb' as const,
          method: 'GFN2-xTB',
          settings: { extensions: {} },
          frozenAtomIds: ['must-not-render-atom'],
          constraintIds: [],
          status: 'completed' as const,
          createdAt: '2026-07-22T00:00:00Z',
          extensions: {}
        },
        frameCount: 2,
        latestFrame: frame,
        outcome: 'accepted' as const,
        message: '',
        updatedAt: '2026-07-22T00:02:00Z',
        active: false,
        recovered: false,
        replayable: true,
        extensions: {}
      }
    ],
    nextRunId: null,
    extensions: {}
  }
}

function createTurnEvent(
  threadId: string,
  sequence: number,
  overrides: Partial<StudioAgentTurnEvent> = {}
): StudioAgentTurnEvent {
  return {
    eventId: `event-${sequence}`,
    threadId,
    turnId: 'turn-1',
    sequence,
    timestamp: '2026-07-29T00:00:00Z',
    kind: 'tool_started',
    status: 'running',
    summary: 'Using the immutable draft snapshot.',
    tool: {
      toolCallId: 'tool-call-1',
      toolName: 'analyze_current_molecule',
      purpose: 'Analyze visible molecule'
    },
    extensions: {},
    ...overrides
  }
}

function moleculeDocument(revision = 4): MoleculeDocument {
  return {
    documentId: 'molecule-1',
    revision,
    atoms: [
      { id: 'atom-1', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
      { id: 'atom-2', atomicNumber: 1, position: [0.758, 0.586, 0], formalCharge: 0, extensions: {} }
    ],
    bonds: [{ id: 'bond-1', atomIds: ['atom-1', 'atom-2'], order: 1, extensions: {} }],
    selections: [] as string[],
    frozenAxes: { 'atom-2': [false, false, true] },
    constraints: [],
    properties: { extensions: {} },
    extensions: {}
  }
}

function emit(event: string, payload: unknown) {
  const listener = ipcMocks.listeners.get(event)
  expect(listener).toBeDefined()
  listener?.(payload as never)
}

/** Opens the trusted decision history from the Agent's inline waiting card. */
async function openDecisions() {
  const waitingCard = await screen.findByTestId('agent-inline-approval')
  fireEvent.click(within(waitingCard).getByRole('button', { name: /chemsmart_studio\.approval\.review/ }))
  await screen.findByTestId('agent-review-sheet')
}

/** Opens the dedicated Agent pane if it is currently hidden. */
async function openAgentPanel() {
  const show = screen.queryByRole('button', { name: 'chemsmart_studio.agent_workbench.show' })
  if (show) fireEvent.click(show)
  await screen.findByTestId('chemsmart-agent-pane')
}

async function openJobs() {
  fireEvent.click(await screen.findByRole('button', { name: 'chemsmart_studio.ide.activity.calculations' }))
}

async function openProblems() {
  fireEvent.click(await screen.findByRole('button', { name: 'chemsmart_studio.ide.bottom.show' }))
  fireEvent.click(screen.getByRole('tab', { name: 'chemsmart_studio.workbench.tab.problems' }))
}

const defaultResizeObserver = globalThis.ResizeObserver

/**
 * Reports a fixed size to the observer the workspace measures its tier with. The shared jsdom stub never
 * invokes its callback, so without this the workspace stays on its widest tier.
 */
function stubWorkspaceSize(width: number, height = 700) {
  const boxSize = [{ blockSize: height, inlineSize: width }]
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              borderBoxSize: boxSize,
              contentBoxSize: boxSize,
              contentRect: { height, width } as DOMRectReadOnly,
              devicePixelContentBoxSize: boxSize,
              target
            } as ResizeObserverEntry
          ],
          this as never
        )
      }
      unobserve() {}
      disconnect() {}
    }
  )
}

function stubResizableWorkspace(initialWidth: number, initialHeight: number) {
  const observers: Array<{ callback: ResizeObserverCallback; target: Element }> = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(nextTarget: Element) {
        observers.push({ callback: this.callback, target: nextTarget })
        reportTo(this.callback, nextTarget, initialWidth, initialHeight)
      }
      unobserve() {}
      disconnect() {}
    }
  )

  const reportTo = (callback: ResizeObserverCallback, target: Element, width: number, height: number) => {
    const boxSize = [{ blockSize: height, inlineSize: width }]
    callback(
      [
        {
          borderBoxSize: boxSize,
          contentBoxSize: boxSize,
          contentRect: { height, width } as DOMRectReadOnly,
          devicePixelContentBoxSize: boxSize,
          target
        } as ResizeObserverEntry
      ],
      {} as ResizeObserver
    )
  }

  return {
    resize: (width: number, height: number) => {
      for (const observer of observers) reportTo(observer.callback, observer.target, width, height)
    }
  }
}

describe('ChemSmartStudioPanel', () => {
  afterEach(() => {
    vi.stubGlobal('ResizeObserver', defaultResizeObserver)
  })

  beforeEach(() => {
    Element.prototype.scrollIntoView ??= vi.fn()
    ipcMocks.listeners.clear()
    ipcMocks.order.length = 0
    ipcMocks.request.mockReset()
    loggerMocks.error.mockReset()
    loggerMocks.warn.mockReset()
    stageEngine.handlers = null
    stageEngine.setGizmoTarget.mockReset()
    stageEngine.setTransformEnabled.mockReset()
    stageEngine.setPlacementPreview.mockReset()
    stageEngine.setActionCues.mockReset()
    ipcMocks.request.mockImplementation(async (route: string) => {
      ipcMocks.order.push(`request:${route}`)
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return moleculeDocument()
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })
  })

  it('subscribes before loading status and never starts a process implicitly', async () => {
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    expect(screen.getByRole('img', { name: 'chemsmart_studio.workspace.brand_logo' })).toBeInTheDocument()
    await screen.findByTestId('molecule-stage')
    expect(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.hide' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('workspace-dock-inspector')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('chemsmart-agent-pane')).toBeInTheDocument()

    const statusRequestIndex = ipcMocks.order.indexOf('request:chemsmart_studio.status')
    expect(statusRequestIndex).toBeGreaterThan(-1)
    expect(ipcMocks.order.indexOf('subscribe:chemsmart_studio.agent.state_changed')).toBeLessThan(statusRequestIndex)
    expect(ipcMocks.order.indexOf('subscribe:chemsmart_studio.agent.turn_event')).toBeLessThan(statusRequestIndex)
    expect(ipcMocks.order).not.toContain('subscribe:chemsmart_studio.agent.trace')
    expect(ipcMocks.order).not.toContain('subscribe:chemsmart_studio.studio_ui.event')
    expect(ipcMocks.order.indexOf('subscribe:chemsmart_studio.control.changed')).toBeLessThan(statusRequestIndex)
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.control.snapshot', { sessionId: 'topic-a' })
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.agent.start')
  })

  it('renders only thread-bound main-owned Agent turn events', async () => {
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    act(() => {
      emit('chemsmart_studio.agent.turn_event', createTurnEvent('topic-other', 0))
      emit('chemsmart_studio.agent.turn_event', createTurnEvent('topic-a', 0))
    })

    expect(screen.getByTestId('agent-trace-timeline')).toHaveTextContent('Using the immutable draft snapshot.')
    expect(screen.getAllByText('Using the immutable draft snapshot.')).toHaveLength(1)
  })

  it('shares only path-free pane and editor metadata with the Agent context', async () => {
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.agent.update_workspace_view', {
        sessionId: 'topic-a',
        view: {
          editorMode: 'build',
          panes: ['explorer', 'agent']
        }
      })
    )
    const call = ipcMocks.request.mock.calls.find(([route]) => route === 'chemsmart_studio.agent.update_workspace_view')
    expect(call?.[1]).not.toHaveProperty('view.displayState')
  })

  it('keeps the committed molecule when the Python sidecar stops', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'running', pid: 61, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return moleculeDocument()
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await waitFor(() =>
      expect(screen.getByTestId('viewport-identity')).toHaveTextContent('chemsmart_studio.stage.committed_revision')
    )

    act(() => {
      emit('chemsmart_studio.agent.state_changed', {
        state: 'failed',
        pid: null,
        lastError: 'sidecar exited'
      })
    })

    // The sidecar does not own the main-process document, so an agent failure cannot blank it.
    expect(screen.getByTestId('viewport-identity')).toHaveTextContent('chemsmart_studio.stage.committed_revision')
    expect(screen.queryByText('chemsmart_studio.stage.no_identity')).toBeNull()
  })

  it('reads the molecule without the Python sidecar running', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return moleculeDocument()
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    await waitFor(() =>
      expect(screen.getByTestId('viewport-identity')).toHaveTextContent('chemsmart_studio.stage.committed_revision')
    )
    await waitFor(() =>
      expect(ipcMocks.request.mock.calls.map(([route]) => route)).toContain('chemsmart_studio.molecule.document')
    )
  })

  it('makes XYZ bond-inference provenance visible for researcher review', async () => {
    const imported = {
      ...moleculeDocument(),
      extensions: {
        'chemsmart.import': {
          format: 'xyz',
          topology: 'inferred',
          algorithm: 'rdkit.DetermineConnectivity',
          algorithmVersion: '2026.03.4',
          reviewRequired: true
        }
      }
    }
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return imported
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    expect(await screen.findByTestId('molecule-import-inference')).toHaveTextContent(
      'chemsmart_studio.stage.import_inference'
    )
  })

  it('treats an empty project as a valid first-launch state without logging an error', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary' || route === 'chemsmart_studio.molecule.document') {
        throw new IpcError(chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE, 'No validated molecule is available')
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.workspace.roots') {
        return {
          projectsRoot: projectTree.rootPath,
          activeProjectPath: `${projectTree.rootPath}/${projectTree.bundle}`
        }
      }
      if (route === 'chemsmart_studio.editor.open_documents') {
        return {
          activeProjectId: 'project-toluene',
          documents: [{ projectId: 'project-toluene', projectName: 'Toluene' }]
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    await screen.findByRole('button', { name: 'chemsmart_studio.editor.save_as' })
    await waitFor(() =>
      expect(ipcMocks.request.mock.calls.map(([route]) => route)).toContain('chemsmart_studio.molecule.summary')
    )
    expect(screen.getByRole('heading', { name: 'chemsmart_studio.title' }).parentElement).toHaveTextContent('Toluene')
    expect(screen.getByTestId('molecule-stage')).toHaveTextContent('chemsmart_studio.stage.empty')
    expect(screen.getByTestId('viewport-identity')).toHaveTextContent('chemsmart_studio.stage.no_identity')
    expect(loggerMocks.error).not.toHaveBeenCalled()
  })

  it('keeps compact chrome and presents the active Agent intent in one relative Sheet', async () => {
    stubWorkspaceSize(760, 560)
    const user = userEvent.setup()
    const baseRequest = ipcMocks.request.getMockImplementation()!
    ipcMocks.request.mockImplementation(async (route: string, ...args: unknown[]) => {
      if (route === 'chemsmart_studio.agent.capabilities') {
        return {
          extensions: {},
          generatedAt: '2026-07-29T00:00:00Z',
          items: [
            {
              capability: 'inspect',
              description: 'Inspect the current scientific context.',
              discovery: 'command',
              key: 'inspect',
              label: 'Inspect'
            }
          ],
          projectId: 'project-1',
          threadId: 'topic-a'
        }
      }
      return baseRequest(route, ...args)
    })
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    expect(screen.getByTestId('chemsmart-workspace')).toHaveAttribute('data-tier', 'viewport-only')
    expect(screen.getByTestId('workspace-dock-viewport-only')).toBeInTheDocument()
    expect(screen.getByTestId('molecule-canvas')).toBeInTheDocument()
    expect(screen.queryByTestId('studio-activity-bar')).toBeNull()
    expect(screen.queryByTestId('research-rail')).toBeNull()
    expect(screen.queryByTestId('workspace-dock-inspector')).toBeNull()
    expect(screen.queryByTestId('workspace-dock-bottom')).toBeNull()
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'agent')
    expect(screen.getByTestId('studio-pane-sheet')).toHaveStyle({ width: '44%' })
    expect(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.hide' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'chemsmart_studio.ide.bottom.show' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    const composer = screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })
    await user.click(composer)
    await user.type(composer, '/ins')
    expect(
      screen.getByRole('listbox', { name: 'chemsmart_studio.agent_workbench.discovery.label' })
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(composer).toHaveValue('/ins')
    expect(composer).toHaveFocus()
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'agent')

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.ide.open_views' }))
    expect(screen.getByRole('dialog', { name: 'chemsmart_studio.ide.palette.title' })).toBeInTheDocument()
  })

  it('opens a waiting decision in the single viewport-only sheet', async () => {
    stubWorkspaceSize(760, 560)
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return moleculeDocument()
      if (route === 'chemsmart_studio.control.snapshot') return previewControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openDecisions()

    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'agent')
    const reviewSheet = await screen.findByTestId('agent-review-sheet')
    expect(within(reviewSheet).getByTestId('preview-approval')).toBeInTheDocument()
  })

  it('uses an icon-only Activity Bar while preserving the default Agent pane intent in focused layout', async () => {
    stubWorkspaceSize(960, 660)
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    expect(screen.getByTestId('chemsmart-workspace')).toHaveAttribute('data-tier', 'focused')
    expect(screen.getByTestId('studio-activity-bar')).toBeInTheDocument()
    expect(screen.queryByTestId('research-rail')).toBeNull()
    expect(screen.getByTestId('workspace-dock-inspector')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('viewport-identity')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.hide' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chemsmart_studio.ide.bottom.show' })).toBeInTheDocument()
  })

  it('preserves Agent and Console intent, Console draft text, and focus across compact presentation', async () => {
    const workspace = stubResizableWorkspace(1440, 900)
    const user = userEvent.setup()
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    const agentInput = screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })
    fireEvent.change(agentInput, { target: { value: 'Keep this research plan' } })
    expect(agentInput).toHaveValue('Keep this research plan')
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.ide.bottom.show' }))
    const consoleInput = screen.getByTestId('console-input')
    fireEvent.change(consoleInput, { target: { value: 'chemsmart run xtb -f water.xyz' } })
    expect(consoleInput).toHaveValue('chemsmart run xtb -f water.xyz')
    consoleInput.focus()

    act(() => workspace.resize(960, 600))
    await waitFor(() => expect(screen.getByTestId('chemsmart-workspace')).toHaveAttribute('data-tier', 'viewport-only'))
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'console')
    expect(screen.getByTestId('studio-pane-sheet')).toHaveStyle({ height: '42%' })
    expect(screen.getByTestId('console-input')).toHaveValue('chemsmart run xtb -f water.xyz')
    expect(screen.getByTestId('console-input')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'chemsmart_studio.ide.bottom.hide' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.show' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.show' }))
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'agent')
    expect(screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })).toHaveValue(
      'Keep this research plan'
    )

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.ide.bottom.show' }))
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'console')
    expect(screen.getByTestId('console-input')).toHaveValue('chemsmart run xtb -f water.xyz')

    act(() => workspace.resize(1440, 900))
    await waitFor(() => expect(screen.getByTestId('chemsmart-workspace')).toHaveAttribute('data-tier', 'wide'))
    expect(screen.getByTestId('workspace-dock-inspector')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('console-input')).toHaveValue('chemsmart run xtb -f water.xyz')
  })

  it('stacks researcher edits in a draft without invoking the Agent or committing a revision', async () => {
    const user = userEvent.setup()
    const baseDocument = moleculeDocument()
    let selectedDocument: MoleculeDocument = {
      ...baseDocument,
      atoms: [
        ...baseDocument.atoms,
        { id: 'atom-3', atomicNumber: 1, position: [-0.758, 0.586, 0], formalCharge: 0, extensions: {} }
      ]
    }
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return selectedDocument
      if (route === 'chemsmart_studio.molecule.set_selection') {
        const atomIds = (input as { atomIds: string[] }).atomIds
        selectedDocument = { ...selectedDocument, selections: [...atomIds] }
        return selectedDocument
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.molecule.draft_apply') {
        return moleculeDraft(selectedDocument, (input as { operations: MoleculeOperation[] }).operations)
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    const stage = await screen.findByTestId('molecule-stage')
    expect(within(stage).queryByRole('button', { name: /chemsmart_studio.build.insert_atom/ })).toBeNull()
    expect(within(stage).getByTestId('element-picker')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.measure' }))

    const table = await screen.findByTestId('coordinate-table')
    expect(within(table).getByText('atom-1')).toBeInTheDocument()
    expect(within(table).getByText('O')).toBeInTheDocument()
    expect(within(table).getAllByText('H')).toHaveLength(2)
    // Element, stable id, angstrom coordinates, and the frozen axis all come from trusted state.
    expect(screen.getByText('chemsmart_studio.coordinates.unit_notice')).toBeInTheDocument()
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'properties')
    expect(within(table).getAllByRole('checkbox').length).toBeGreaterThan(0)
    // Structural editing belongs beside the 3D view, which is where the researcher is looking while
    // they build — not in the inspector alongside the agent's surfaces.
    expect(within(screen.getByTestId('molecule-inspector')).queryByTestId('molecule-build-tools')).toBeNull()
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.agent.run_turn')

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.coordinates.xyz_title' }))
    const xyzPreview = screen.getByTestId('trusted-xyz-preview')
    expect(xyzPreview).toHaveTextContent(
      '3 ChemSmart Studio document=molecule-1 revision=4 O 0 0 0 H 0.758 0.586 0 H -0.758 0.586 0'
    )
    expect(xyzPreview.textContent).not.toMatch(/[/\\]/)

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.build' }))
    const atomCheckboxes = within(table).getAllByRole('checkbox', {
      name: 'chemsmart_studio.coordinates.select_atom'
    })
    await user.click(atomCheckboxes[0])
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.build.change_selected_element' }))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith(
        'chemsmart_studio.molecule.draft_apply',
        expect.objectContaining({
          sessionId: 'topic-a',
          expectedRevision: 4,
          mode: 'build',
          operations: [{ op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-1', atomicNumber: 6 }] }]
        })
      )
    )
    await user.click(atomCheckboxes[1])
    await user.click(screen.getByRole('radio', { name: '2' }))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith(
        'chemsmart_studio.molecule.draft_apply',
        expect.objectContaining({
          sessionId: 'topic-a',
          expectedRevision: 4,
          mode: 'build',
          operations: [{ op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 2 }] }]
        })
      )
    )
    await user.click(atomCheckboxes[1])
    await user.click(atomCheckboxes[2])
    await user.click(screen.getByRole('radio', { name: '1' }))
    await waitFor(() => {
      const request = ipcMocks.request.mock.calls
        .filter(([route]) => route === 'chemsmart_studio.molecule.draft_apply')
        .at(-1)?.[1] as { operations: Array<{ op: string; bonds?: Array<{ atomIds: string[]; order: number }> }> }
      expect(request.operations[0]).toMatchObject({
        op: 'add_bonds',
        bonds: [{ atomIds: ['atom-1', 'atom-3'], order: 1 }]
      })
    })

    const xField = within(table).getAllByRole('spinbutton', {
      name: 'chemsmart_studio.coordinates.position_field'
    })[0]
    xField.focus()
    await user.keyboard('{Control>}a{/Control}1.25{Enter}')

    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.molecule.draft_apply', {
        sessionId: 'topic-a',
        expectedRevision: 4,
        mode: 'build',
        operations: [{ op: 'set_positions', positions: [{ atomId: 'atom-1', position: [1.25, 0, 0] }] }]
      })
    )
    // Researcher edits remain a recoverable draft: nothing is committed by the edit itself.
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.control.perform_action')
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.molecule.draft_commit')
  })

  it('requires Apply, Discard, or Cancel before closing a window with a draft', async () => {
    const user = userEvent.setup()
    const document = moleculeDocument()
    const draft = moleculeDraft(document)
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: document.documentId, revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return document
      if (route === 'chemsmart_studio.molecule.draft_snapshot') return draft
      if (route === 'chemsmart_studio.molecule.draft_commit') return { ...document, revision: 5 }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'window.close') return undefined
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    const canceledClose = new Event('beforeunload', { cancelable: true })
    await act(async () => {
      window.dispatchEvent(canceledClose)
    })
    expect(canceledClose.defaultPrevented).toBe(true)
    expect(await screen.findByText('chemsmart_studio.draft.review.close.title')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.queryByTestId('molecule-draft-review')).toBeNull()
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('window.close')

    await act(async () => {
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    })
    await user.click(await screen.findByRole('button', { name: 'chemsmart_studio.draft.review.close.apply' }))
    await waitFor(() => {
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.molecule.draft_commit', {
        sessionId: 'topic-a',
        expectedRevision: 4
      })
      expect(ipcMocks.request).toHaveBeenCalledWith('window.close')
    })
  })

  it('shows a refused human edit beside the stage and confirms committed geometry is unchanged', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return moleculeDocument()
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.molecule.draft_apply') {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'refused')
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    const stage = await screen.findByTestId('molecule-stage')
    act(() => stageEngine.handlers?.onPick?.(null, false, [0, 0, 0]))

    expect(await within(stage).findByRole('alert')).toHaveTextContent('chemsmart_studio.coordinates.proposal_failed')
    expect(within(stage).getByTestId('viewport-identity')).toHaveTextContent(
      'chemsmart_studio.stage.committed_revision'
    )
  })

  it('opens all 118 elements, enters insertion immediately, and adds explicit-hydrogen fragments', async () => {
    const user = userEvent.setup()
    const document = moleculeDocument()
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return document
      if (route === 'chemsmart_studio.molecule.set_selection') return document
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.molecule.draft_apply') {
        return moleculeDraft(document, (input as { operations: MoleculeOperation[] }).operations)
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    const stage = await screen.findByTestId('molecule-stage')
    await user.click(within(stage).getByTestId('element-picker'))
    await user.click(await screen.findByRole('button', { name: 'Og 118' }))
    expect(within(stage).getByText('chemsmart_studio.build.insertion_mode')).toBeInTheDocument()

    act(() => stageEngine.handlers?.onPick?.(null, false, [2, 3, 0]))
    await waitFor(() => {
      const request = ipcMocks.request.mock.calls
        .filter(([route]) => route === 'chemsmart_studio.molecule.draft_apply')
        .at(-1)?.[1] as { operations: Array<{ atoms?: Array<{ atomicNumber: number; position: number[] }> }> }
      expect(request.operations[0].atoms?.[0]).toMatchObject({ atomicNumber: 118, position: [2, 3, 0] })
    })

    const fragments = within(stage).getByRole('button', { name: 'chemsmart_studio.build.fragments' })
    await waitFor(() => expect(fragments).toBeEnabled())
    fireEvent.keyDown(fragments, { key: 'Enter' })
    await user.click(await screen.findByRole('menuitem', { name: 'chemsmart_studio.build.fragment.benzene' }))
    await waitFor(() => {
      const request = ipcMocks.request.mock.calls
        .filter(([route]) => route === 'chemsmart_studio.molecule.draft_apply')
        .at(-1)?.[1] as {
        gesture: { fragmentName: string; kind: string }
        operations: [{ atoms: Array<{ atomicNumber: number }> }, { bonds: Array<{ order: number }> }]
      }
      expect(request.gesture).toMatchObject({ fragmentName: 'benzene', kind: 'insert_ring' })
      expect(request.operations[0].atoms).toHaveLength(12)
      expect(request.operations[0].atoms.filter(({ atomicNumber }) => atomicNumber === 1)).toHaveLength(6)
      expect(request.operations[1].bonds).toHaveLength(12)
    })
  })

  it('measures the ordered selection and constrains it in the draft', async () => {
    const user = userEvent.setup()
    let selectedDocument = moleculeDocument()
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return selectedDocument
      if (route === 'chemsmart_studio.molecule.set_selection') {
        const atomIds = (input as { atomIds: string[] }).atomIds
        selectedDocument = { ...selectedDocument, selections: [...atomIds] }
        return selectedDocument
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.molecule.draft_apply') {
        return moleculeDraft(selectedDocument, (input as { operations: MoleculeOperation[] }).operations)
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await user.click(await screen.findByRole('button', { name: 'chemsmart_studio.workspace.mode.measure' }))

    // With nothing picked there is no measurement to report, rather than a fabricated one.
    expect(screen.getByText('chemsmart_studio.measure.empty')).toBeInTheDocument()

    const table = screen.getByTestId('coordinate-table')
    const [firstAtom, secondAtom] = within(table).getAllByRole('checkbox', {
      name: 'chemsmart_studio.coordinates.select_atom'
    })
    await user.click(firstAtom)
    await user.click(secondAtom)
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.molecule.set_selection', {
        sessionId: 'topic-a',
        documentId: 'molecule-1',
        expectedRevision: 4,
        atomIds: ['atom-1', 'atom-2']
      })
    )

    const measure = screen.getByTestId('measure-panel')
    expect(within(measure).getByText('chemsmart_studio.measure.kind.distance')).toBeInTheDocument()
    // The O–H distance of the fixture itself, reported in angstrom to four decimals.
    expect(within(measure).getByText(Math.hypot(0.758, 0.586).toFixed(4))).toBeInTheDocument()
    expect(within(measure).getByText(/chemsmart_studio.measure.moves_only/)).toBeInTheDocument()

    const targetField = within(measure).getByRole('spinbutton', { name: 'chemsmart_studio.measure.target' })
    targetField.focus()
    await user.keyboard('{Control>}a{/Control}1.2{Enter}')
    await user.click(within(measure).getByRole('button', { name: 'chemsmart_studio.measure.apply' }))

    await waitFor(() => {
      const call = ipcMocks.request.mock.calls.find(([route]) => route === 'chemsmart_studio.molecule.draft_apply')
      expect(call).toBeDefined()
      if (!call) return
      expect(call[1]).toMatchObject({ mode: 'measure', expectedRevision: 4 })
      const [operation] = (call[1] as { operations: { op: string; positions: { position: number[] }[] }[] }).operations
      expect(operation.op).toBe('set_positions')
      // Only the second atom moves, and it lands exactly 1.2 angstrom from the first.
      expect(Math.hypot(...operation.positions[0].position)).toBeCloseTo(1.2, 6)
    })

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.constrain' }))
    const constraints = screen.getByTestId('constraint-panel')
    await user.click(within(constraints).getByRole('button', { name: 'chemsmart_studio.constraints.add' }))

    await waitFor(() => {
      const call = ipcMocks.request.mock.calls
        .filter(([route]) => route === 'chemsmart_studio.molecule.draft_apply')
        .at(-1)
      expect(call).toBeDefined()
      if (!call) return
      expect(call[1]).toMatchObject({ mode: 'constrain' })
      const [operation] = (call[1] as { operations: { op: string; constraints: { type: string; unit: string }[] }[] })
        .operations
      expect(operation.op).toBe('set_constraints')
      // A distance constraint is recorded in angstrom, never in degrees.
      expect(operation.constraints[0]).toMatchObject({ type: 'distance', unit: 'angstrom' })
    })
  })

  it('turns a canvas pick and a gizmo drag into the same draft operations the coordinate table makes', async () => {
    const user = userEvent.setup()
    let selectedDocument = moleculeDocument()
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return selectedDocument
      if (route === 'chemsmart_studio.molecule.set_selection') {
        const atomIds = (input as { atomIds: string[] }).atomIds
        selectedDocument = { ...selectedDocument, selections: [...atomIds] }
        return selectedDocument
      }
      if (route === 'chemsmart_studio.molecule.draft_undo') {
        return null
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.molecule.draft_apply') {
        return moleculeDraft(selectedDocument, (input as { operations: MoleculeOperation[] }).operations)
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    // Insertion is the Builder default; Selection is a separate explicit tool.
    await user.click(screen.getByTestId('stage-tool-select'))
    act(() => stageEngine.handlers?.onPick?.('atom-2', false))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.molecule.set_selection', {
        sessionId: 'topic-a',
        documentId: 'molecule-1',
        expectedRevision: 4,
        atomIds: ['atom-2']
      })
    )

    // Selecting alone must not arm the gizmo — moving is a separate, deliberate tool.
    expect(stageEngine.setTransformEnabled).not.toHaveBeenCalledWith(true)
    await user.click(screen.getByTestId('stage-tool-manipulate'))
    await waitFor(() => expect(stageEngine.setTransformEnabled).toHaveBeenLastCalledWith(true))
    // Activating a new editing tool clears the old target. Move acquires only the next atom picked.
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.molecule.set_selection', {
        sessionId: 'topic-a',
        documentId: 'molecule-1',
        expectedRevision: 4,
        atomIds: []
      })
    )
    expect(stageEngine.setGizmoTarget).toHaveBeenLastCalledWith(null)
    act(() => stageEngine.handlers?.onPick?.('atom-2', false))
    await waitFor(() => expect(stageEngine.setGizmoTarget).toHaveBeenLastCalledWith('atom-2'))

    act(() => stageEngine.handlers?.onAtomMoved?.('atom-2', [1.2, 0.5, 0]))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith(
        'chemsmart_studio.molecule.draft_apply',
        expect.objectContaining({
          sessionId: 'topic-a',
          expectedRevision: 4,
          mode: 'build',
          operations: [{ op: 'set_positions', positions: [{ atomId: 'atom-2', position: [1.2, 0.5, 0] }] }]
        })
      )
    )
    // One gesture is exactly one proposal, and a drag never commits itself.
    expect(
      ipcMocks.request.mock.calls.filter(([route]) => route === 'chemsmart_studio.molecule.draft_apply')
    ).toHaveLength(1)
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.control.perform_action')

    await waitFor(() => expect(screen.getByTestId('molecule-undo')).not.toBeDisabled())
    await user.click(screen.getByTestId('molecule-undo'))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.molecule.draft_undo', { sessionId: 'topic-a' })
    )
  })

  it('previews main-validated coordination sites and cycles only those sites with Tab', async () => {
    const document = moleculeDocument()
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: document.documentId, revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return document
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      if (route === 'chemsmart_studio.molecule.placement_preview') {
        const intent = (input as { intent: { geometryHash: string } }).intent
        return {
          documentId: document.documentId,
          revision: 4,
          geometryHash: intent.geometryHash,
          anchorAtomId: 'atom-1',
          atomicNumber: 6,
          bondOrder: 1,
          coordinationGeometry: 'tetrahedral',
          candidates: [
            {
              siteIndex: 0,
              position: [1, 0, 0],
              bondLength: 1,
              minimumClearance: 0,
              occupied: true,
              safe: false
            },
            {
              siteIndex: 1,
              position: [0, 1, 0],
              bondLength: 1,
              minimumClearance: 1,
              occupied: false,
              safe: true
            },
            {
              siteIndex: 2,
              position: [0, 0, 1],
              bondLength: 1,
              minimumClearance: 1,
              occupied: false,
              safe: true
            }
          ],
          selectedSiteIndex: 1,
          status: 'ready'
        }
      }
      if (route === 'chemsmart_studio.molecule.placement_apply') {
        return { snapshot: moleculeDraft(document), insertedAtomId: 'atom-new' }
      }
      if (route === 'chemsmart_studio.molecule.set_selection') return document
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')
    act(() => stageEngine.handlers?.onPick?.('atom-1', false))
    await screen.findByTestId('placement-guide-status')
    await waitFor(() =>
      expect(stageEngine.setPlacementPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ selectedSiteIndex: 1, status: 'ready' })
      )
    )

    fireEvent.keyDown(window, { key: 'Tab' })
    await waitFor(() =>
      expect(stageEngine.setPlacementPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ selectedSiteIndex: 2 })
      )
    )
    act(() => stageEngine.handlers?.onPlacementPick?.(2))
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenCalledWith(
        'chemsmart_studio.molecule.placement_apply',
        expect.objectContaining({
          sessionId: 'topic-a',
          intent: expect.objectContaining({ siteIndex: 2 })
        })
      )
    )
  })

  it('keeps scientific tools on the viewport and reveals only the pane each tool owns', async () => {
    const user = userEvent.setup()
    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await screen.findByTestId('molecule-stage')

    // Build owns structural editing: it can propose operations and leaves the Agent intent and workbench alone.
    const buildTool = screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.build' })
    expect(buildTool).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('workspace-dock-inspector')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('chemsmart-agent-pane')).toBeInTheDocument()

    // Measure opens a contextual Properties sheet without replacing the dedicated Agent pane.
    const measureTool = screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.measure' })
    await user.click(measureTool)
    expect(measureTool).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-dock-inspector')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('studio-pane-sheet')).toHaveAttribute('data-pane', 'properties')
    expect(screen.getByTestId('molecule-inspector')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-open', 'false')

    // Calculations live in Jobs, and selecting them reveals the bottom panel.
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.ide.activity.calculations' }))
    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-open', 'true')
    expect(screen.getByRole('tab', { name: 'chemsmart_studio.workbench.tab.jobs' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Returning to Build does not steal focus or close a pane the researcher chose.
    await user.click(buildTool)
    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-open', 'true')
  })

  it('runs the deterministic Agent path only after an explicit composer submission', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.agent.runtime_context') {
        return { deterministicModelId: 'deterministic::controlled-calculation' }
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.agent.run_turn') return { completed: true }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openAgentPanel()
    const request = await screen.findByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.agent.run_turn')

    request.focus()
    await user.keyboard('Inspect and prepare the controlled calculation.')
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.workspace.send_agent_request' }))

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.agent.run_turn', {
      sessionId: 'topic-a',
      modelId: 'deterministic::controlled-calculation',
      request: 'Inspect and prepare the controlled calculation.',
      intent: null
    })
    await waitFor(() => expect(request).toHaveValue(''))
  })

  it('keeps transport paths and opaque document IDs private and retries status explicitly', async () => {
    const user = userEvent.setup()
    let statusFails = true
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        if (statusFails) throw new Error('socket /private/runtime/token.sock refused')
        return stoppedStatus()
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-2', revision: 7 }
      if (route === 'chemsmart_studio.molecule.document') {
        return { ...moleculeDocument(), documentId: 'molecule-2', revision: 7 }
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    expect(await screen.findByTestId('workspace-inline-error')).toHaveTextContent('chemsmart_studio.error.status_title')
    expect(screen.queryByText(/private\/runtime|token\.sock/)).toBeNull()

    statusFails = false
    await openProblems()
    await user.click(within(screen.getByTestId('studio-problems-panel')).getByRole('button', { name: 'common.retry' }))

    expect(await screen.findByRole('button', { name: 'chemsmart_studio.editor.save_as' })).toBeInTheDocument()
    expect(screen.getByTestId('viewport-identity')).toHaveTextContent('chemsmart_studio.stage.committed_revision')
    expect(screen.getByTestId('chemsmart-workspace').querySelector('header')).not.toHaveTextContent('molecule-2')
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.measure' }))
    expect(within(screen.getByTestId('studio-pane-sheet')).getByText('molecule-2')).toBeInTheDocument()
    expect(screen.queryByText(/private\/runtime|token\.sock/)).toBeNull()
    expect(loggerMocks.error).toHaveBeenCalled()
  })

  it('opens, imports, and saves projects through path-free main-owned actions', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') {
        return { documentId: 'private-document-uuid', revision: 2 }
      }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.editor.open_project') {
        return {
          canceled: false,
          status: { state: 'running', pid: 62, lastError: null },
          molecule: { documentId: 'opened-document-uuid', revision: 4 },
          documentName: 'Opened Project'
        }
      }
      if (route === 'chemsmart_studio.editor.import_molecule') {
        return {
          canceled: false,
          status: { state: 'running', pid: 63, lastError: null },
          molecule: { documentId: 'imported-document-uuid', revision: 0 },
          documentName: 'Ethanol'
        }
      }
      if (route === 'chemsmart_studio.editor.save_as') {
        return {
          canceled: false,
          status: { state: 'running', pid: 64, lastError: null },
          molecule: { documentId: 'imported-document-uuid', revision: 0 },
          documentName: 'Ethanol Copy'
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    expect(await screen.findByRole('button', { name: 'chemsmart_studio.editor.open_project' })).toBeInTheDocument()
    expect(screen.queryByText('private-document-uuid')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.editor.open_project' }))
    expect((await screen.findAllByText('Opened Project')).length).toBeGreaterThan(0)
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.editor.open_project')

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.editor.import_molecule' }))
    expect((await screen.findAllByText('Ethanol')).length).toBeGreaterThan(0)
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.editor.import_molecule')

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.editor.save_as' }))
    expect((await screen.findAllByText('Ethanol Copy')).length).toBeGreaterThan(0)
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.editor.save_as')

    // The explorer is the app's one deliberate path surface — the researcher has to be able to see
    // which project is open — so this is scoped to everything else rather than asserted globally.
    // A global assertion would silently start passing for the wrong reason the moment the rail
    // renders a bundle name.
    const rail = await screen.findByTestId('research-rail')
    const leaked = screen.queryAllByText(/\/private\/|\.cmsproj/).filter((node) => !rail.contains(node))
    expect(leaked).toEqual([])
  })

  it('keeps a failed project action in Problems after a later action succeeds', async () => {
    const user = userEvent.setup()
    let openAttempts = 0
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-3', revision: 2 }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.editor.open_project') {
        openAttempts += 1
        if (openAttempts === 1) throw new Error('/private/project-path must stay out of the renderer')
        return {
          canceled: false,
          status: { state: 'running', pid: 62, lastError: null },
          molecule: { documentId: 'opened-document-uuid', revision: 4 },
          documentName: 'Recovered Project'
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    const openProject = await screen.findByRole('button', { name: 'chemsmart_studio.editor.open_project' })

    await user.click(openProject)
    expect(await screen.findByTestId('workspace-inline-error')).toHaveTextContent('chemsmart_studio.error.action')
    expect(screen.queryByText('/private/project-path')).toBeNull()

    await user.click(openProject)
    expect((await screen.findAllByText('Recovered Project')).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('workspace-inline-error')).toBeNull()

    await openProblems()
    expect(screen.getByTestId('studio-problems-panel')).toHaveTextContent('chemsmart_studio.ide.problems.workspace')
  })

  it('disables project replacement while trusted final geometry remains unresolved', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-3', revision: 2 }
      if (route === 'chemsmart_studio.control.snapshot') {
        return optimizationControlSnapshot('awaiting_final_geometry')
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    expect(await screen.findByRole('button', { name: 'chemsmart_studio.editor.open_project' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'chemsmart_studio.editor.import_molecule' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'chemsmart_studio.editor.save_as' })).toBeDisabled()
    expect(screen.getByTestId('agent-inline-approval')).toBeInTheDocument()
  })

  it('renders a canonical preview approval and sends only the session and opaque action id', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return previewControlSnapshot()
      if (route === 'chemsmart_studio.control.perform_action') return emptyControlSnapshot()
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    // A preview commit is not high risk, so it never blocks the workspace behind an allow notice.
    expect(screen.queryByTestId('allow-notice')).toBeNull()

    await openDecisions()
    expect(screen.getByTestId('trusted-decision-list')).toBeInTheDocument()
    expect(screen.getAllByTestId('preview-approval')).toHaveLength(1)
    expect(screen.queryByText('preview-1')).toBeNull()
    expect(screen.getByText('atom-1: O → C')).toBeInTheDocument()
    expect(screen.getByText('chemsmart_studio.approval.preview.not_displayed')).toBeInTheDocument()
    expect(screen.getByText('atom-1, atom-2')).toBeInTheDocument()
    expect(screen.getByText('bond-1')).toBeInTheDocument()
    expect(screen.queryByText('UNLOCALIZED MAIN TITLE')).toBeNull()
    expect(screen.queryByText('UNLOCALIZED MAIN SUMMARY')).toBeNull()
    // Unambiguous internals must not appear anywhere; "coordinates" is also a localized label, so that
    // token is checked inside the card that would leak it.
    expect(screen.queryByText(/must-not-render|TOP-LEVEL-RAW|providerArguments|rawJson/)).toBeNull()
    expect(within(screen.getByTestId('preview-approval')).queryByText(/providerArguments|rawJson/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'chemsmart_studio.approval.preview.commit' }))

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.control.perform_action', {
      sessionId: 'topic-a',
      actionId: 'action-commit'
    })
    const actionCall = ipcMocks.request.mock.calls.find(
      ([route]) => route === 'chemsmart_studio.control.perform_action'
    )
    expect(actionCall).toHaveLength(2)
  })

  it('renders exact generic execution arguments and sends only the one-shot action id', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return executionControlSnapshot()
      if (route === 'chemsmart_studio.control.perform_action') return emptyControlSnapshot()
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    await openDecisions()
    const reviewSheet = screen.getByTestId('agent-review-sheet')
    expect(within(reviewSheet).getByText('chemsmart_studio.approval.execution.title')).toBeInTheDocument()
    expect(within(reviewSheet).getByText('chemsmart run gaussian sp water')).toBeInTheDocument()
    expect(within(reviewSheet).getByText('30')).toBeInTheDocument()
    expect(within(reviewSheet).getByTestId('execution-approval')).toBeInTheDocument()
    expect(screen.queryByText(/providerArguments|rawJson|session_root|\/private\//)).toBeNull()

    fireEvent.click(within(reviewSheet).getByRole('button', { name: 'chemsmart_studio.approval.execution.approve' }))

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.control.perform_action', {
      sessionId: 'topic-a',
      actionId: 'action-execute-once'
    })
  })

  it('renders a controlled xTB plan and runtime identity before its one-shot start action', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return controlledCalculationControlSnapshot()
      if (route === 'chemsmart_studio.control.perform_action') return emptyControlSnapshot()
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)

    await openDecisions()
    const reviewSheet = screen.getByTestId('agent-review-sheet')
    expect(within(reviewSheet).getByTestId('calculation-approval')).toBeInTheDocument()
    expect(screen.getByText('plan-ethanol-1')).toBeInTheDocument()
    expect(screen.getByText(`sha256:${'a'.repeat(64)}`)).toBeInTheDocument()
    expect(screen.getByText(`sha256:${'b'.repeat(64)}`)).toBeInTheDocument()
    expect(screen.getByText(/chemsmart_studio.optimization.settings.max_runtime_seconds.*180/)).toBeInTheDocument()
    expect(screen.getByText(/chemsmart_studio.optimization.settings.threads.*1/)).toBeInTheDocument()
    expect(screen.getByText('chemsmart_studio.approval.technical_details').closest('details')).not.toHaveAttribute(
      'open'
    )

    fireEvent.click(within(reviewSheet).getByRole('button', { name: 'chemsmart_studio.approval.calculation.start' }))

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.control.perform_action', {
      sessionId: 'topic-a',
      actionId: 'action-start-controlled'
    })
  })

  it('consumes a UI action once and blocks replaying it through rapid clicks', async () => {
    let resolveAction: ((snapshot: StudioControlSnapshot) => void) | undefined
    const actionResponse = new Promise<StudioControlSnapshot>((resolve) => {
      resolveAction = resolve
    })
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return previewControlSnapshot()
      if (route === 'chemsmart_studio.control.perform_action') return actionResponse
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openDecisions()
    const commitButton = await screen.findByRole('button', { name: 'chemsmart_studio.approval.preview.commit' })

    fireEvent.click(commitButton)
    fireEvent.click(commitButton)

    expect(
      ipcMocks.request.mock.calls.filter(([route]) => route === 'chemsmart_studio.control.perform_action')
    ).toHaveLength(1)
    expect(commitButton).toBeDisabled()

    resolveAction?.(emptyControlSnapshot())
    await waitFor(() => expect(screen.queryByTestId('preview-approval')).toBeNull())
  })

  it('keeps stale actions disabled after a failed request until trusted state is refreshed', async () => {
    const user = userEvent.setup()
    let snapshotAttempt = 0
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') {
        snapshotAttempt += 1
        return snapshotAttempt === 1 ? previewControlSnapshot() : emptyControlSnapshot()
      }
      if (route === 'chemsmart_studio.control.perform_action') {
        throw new IpcError(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'action may already be stale')
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openDecisions()
    fireEvent.click(await screen.findByRole('button', { name: 'chemsmart_studio.approval.preview.commit' }))

    expect((await screen.findAllByText('chemsmart_studio.control.revision_conflict')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'chemsmart_studio.approval.preview.commit' })).toBeDisabled()

    fireEvent.click(within(screen.getByTestId('agent-review-sheet')).getByRole('button', { name: 'common.close' }))
    await openProblems()
    await user.click(within(screen.getByTestId('studio-problems-panel')).getByRole('button', { name: 'common.retry' }))

    await openJobs()
    expect(await screen.findByText('chemsmart_studio.control.empty')).toBeInTheDocument()
    expect(screen.queryByTestId('preview-approval')).toBeNull()
  })

  it('explains that a malformed trusted request was refused without applying it', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return previewControlSnapshot()
      if (route === 'chemsmart_studio.control.perform_action') {
        throw new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'invalid internal payload')
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openDecisions()
    fireEvent.click(await screen.findByRole('button', { name: 'chemsmart_studio.approval.preview.commit' }))

    expect((await screen.findAllByText('chemsmart_studio.control.schema_invalid')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'chemsmart_studio.approval.preview.commit' })).toBeDisabled()
    expect(screen.queryByText('invalid internal payload')).not.toBeInTheDocument()
  })

  it('refreshes trusted state only for the current session', async () => {
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') {
        return emptyControlSnapshot((input as { sessionId: string }).sessionId)
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openJobs()
    await screen.findByText('chemsmart_studio.control.empty')
    const snapshotsBefore = ipcMocks.request.mock.calls.filter(
      ([route]) => route === 'chemsmart_studio.control.snapshot'
    ).length

    act(() => emit('chemsmart_studio.control.changed', { sessionId: 'topic-b', snapshotRevision: 1 }))
    expect(ipcMocks.request.mock.calls.filter(([route]) => route === 'chemsmart_studio.control.snapshot')).toHaveLength(
      snapshotsBefore
    )

    act(() => emit('chemsmart_studio.control.changed', { sessionId: 'topic-a', snapshotRevision: 1 }))
    await waitFor(() => {
      expect(
        ipcMocks.request.mock.calls.filter(([route]) => route === 'chemsmart_studio.control.snapshot')
      ).toHaveLength(snapshotsBefore + 1)
    })
  })

  it('keeps ordered atom selection available while an optimization locks geometry edits', async () => {
    const user = userEvent.setup()
    let selectedDocument = moleculeDocument()
    ipcMocks.request.mockImplementation(async (route: string, input?: unknown) => {
      if (route === 'chemsmart_studio.status') {
        return {
          agent: { state: 'stopped', pid: null, lastError: null }
        }
      }
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.molecule.document') return selectedDocument
      if (route === 'chemsmart_studio.molecule.set_selection') {
        const atomIds = (input as { atomIds: string[] }).atomIds
        selectedDocument = { ...selectedDocument, selections: [...atomIds] }
        return selectedDocument
      }
      if (route === 'chemsmart_studio.control.snapshot') return optimizationControlSnapshot('running')
      if (route === 'chemsmart_studio.optimization.replay_catalog') {
        return { totalRuns: 0, runs: [], nextRunId: null, extensions: {} }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.workspace.mode.measure' }))

    const table = await screen.findByTestId('coordinate-table')
    let atomCheckboxes = within(table).getAllByRole('checkbox', {
      name: 'chemsmart_studio.coordinates.select_atom'
    })
    expect(atomCheckboxes[0]).toBeEnabled()
    expect(atomCheckboxes[1]).toBeEnabled()
    expect(
      within(table).getAllByRole('spinbutton', {
        name: 'chemsmart_studio.coordinates.position_field'
      })[0]
    ).toBeDisabled()

    await user.click(atomCheckboxes[1])
    atomCheckboxes = within(table).getAllByRole('checkbox', {
      name: 'chemsmart_studio.coordinates.select_atom'
    })
    await user.click(atomCheckboxes[0])
    await waitFor(() =>
      expect(ipcMocks.request).toHaveBeenLastCalledWith('chemsmart_studio.molecule.set_selection', {
        sessionId: 'topic-a',
        documentId: 'molecule-1',
        expectedRevision: 4,
        atomIds: ['atom-2', 'atom-1']
      })
    )
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.molecule.draft_apply')
  })

  it('shows loading, error, retry, and empty states without starting a process', async () => {
    const user = userEvent.setup()
    let rejectSnapshot: ((error: Error) => void) | undefined
    let attempt = 0
    const firstSnapshot = new Promise<StudioControlSnapshot>((_resolve, reject) => {
      rejectSnapshot = reject
    })
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') {
        attempt += 1
        return attempt === 1 ? firstSnapshot : emptyControlSnapshot()
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openJobs()
    expect(await screen.findByText('chemsmart_studio.control.loading')).toBeInTheDocument()

    rejectSnapshot?.(new Error('private socket coordinates provider args'))
    expect(await screen.findByText('chemsmart_studio.control.error_title')).toBeInTheDocument()
    expect(screen.queryByText(/private socket coordinates provider args/)).toBeNull()

    await user.click(screen.getAllByRole('button', { name: 'common.retry' }).at(-1)!)
    expect(await screen.findByText('chemsmart_studio.control.empty')).toBeInTheDocument()
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.editor.start')
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain('chemsmart_studio.agent.start')
  })

  it('renders coordinate-free optimization progress and cancellation from the trusted snapshot', async () => {
    const user = userEvent.setup()
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return optimizationControlSnapshot('running')
      if (route === 'chemsmart_studio.control.perform_action') return emptyControlSnapshot()
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openJobs()

    const timeline = await screen.findByTestId('optimization-timeline')
    expect(screen.getByText('run-1')).toBeInTheDocument()
    expect(within(timeline).getByText('-40.5 hartree')).toBeInTheDocument()
    expect(within(timeline).getByText('0.03 hartree/bohr')).toBeInTheDocument()
    expect(screen.queryByText(/must-not-render|rawArguments/)).toBeNull()
    expect(within(timeline).queryByText(/positions|coordinates/)).toBeNull()
    expect(screen.queryByText('c'.repeat(64))).toBeNull()

    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.optimization.cancel' }))
    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.control.perform_action', {
      sessionId: 'topic-a',
      actionId: 'action-cancel'
    })
  })

  it('renders an xTB gradient norm without presenting it as a maximum force', async () => {
    const snapshot = optimizationControlSnapshot('running') as StudioControlSnapshot & {
      optimization: NonNullable<StudioControlSnapshot['optimization']>
    }
    const latestFrame = snapshot.optimization.latestFrame as unknown as Record<string, unknown>
    delete latestFrame.forceMetrics
    latestFrame.gradientNorm = { value: 0.000158527152, unit: 'hartree/bohr' }
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return snapshot
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openJobs()

    const timeline = await screen.findByTestId('optimization-timeline')
    expect(within(timeline).getByText('0.000158527152 hartree/bohr')).toBeInTheDocument()
    expect(within(timeline).getByText('chemsmart_studio.optimization.gradient_norm')).toBeInTheDocument()
  })

  it.each([
    ['chemsmart_studio.optimization.final_geometry.accept', 'action-accept'],
    ['chemsmart_studio.optimization.final_geometry.reject', 'action-reject']
  ])('performs the final geometry control %s through its one-shot action', async (buttonName, expectedActionId) => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') {
        return optimizationControlSnapshot('awaiting_final_geometry')
      }
      if (route === 'chemsmart_studio.control.perform_action') return emptyControlSnapshot()
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openDecisions()
    fireEvent.click(await screen.findByRole('button', { name: buttonName }))

    expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.control.perform_action', {
      sessionId: 'topic-a',
      actionId: expectedActionId
    })
  })

  it('renders a localized failure state without exposing main-process details', async () => {
    ipcMocks.request.mockImplementation(async (route: string) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.control.snapshot') return optimizationControlSnapshot('failed')
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openJobs()

    expect(await screen.findByText('chemsmart_studio.optimization.failed')).toBeInTheDocument()
    expect(screen.getByText('chemsmart_studio.optimization.status.failed')).toBeInTheDocument()
  })

  it('loads and replays recorded frames without a helper process', async () => {
    const user = userEvent.setup()
    const catalog = replayCatalog()
    const firstFrame = { ...catalog.runs[0].latestFrame, stepIndex: 0, energy: { value: -1, unit: 'kJ/mol' as const } }
    ipcMocks.request.mockImplementation(async (route: string, params?: unknown) => {
      if (route === 'chemsmart_studio.status') return stoppedStatus()
      if (route === 'chemsmart_studio.molecule.summary') return { documentId: 'molecule-1', revision: 4 }
      if (route === 'chemsmart_studio.control.snapshot') return emptyControlSnapshot()
      if (route === 'chemsmart_studio.optimization.replay_catalog') return catalog
      if (route === 'chemsmart_studio.optimization.replay_timeline') {
        return {
          runId: 'run-recorded',
          offset: 0,
          limit: 500,
          totalFrames: 2,
          frames: [firstFrame, catalog.runs[0].latestFrame],
          extensions: {}
        }
      }
      if (route === 'chemsmart_studio.optimization.replay_frame') {
        const stepIndex = (params as { stepIndex: number }).stepIndex
        return {
          viewing: true,
          runId: 'run-recorded',
          stepIndex,
          frameCount: 2,
          documentId: 'molecule-1',
          revision: 4,
          frame: stepIndex === 0 ? firstFrame : catalog.runs[0].latestFrame,
          extensions: {}
        }
      }
      throw new Error(`Unexpected route: ${route}`)
    })

    render(<ChemSmartStudioPanel active sessionId="topic-a" />)
    await openJobs()
    const replay = await screen.findByTestId('optimization-replay')
    expect(within(replay).getByText('-1 kJ/mol')).toBeInTheDocument()
    expect(screen.queryByText(/must-not-render-atom|structureHash/)).toBeNull()
    expect(within(replay).queryByText(/coordinates|positions/)).toBeNull()
    expect(ipcMocks.request.mock.calls.map(([route]) => route)).not.toContain(
      'chemsmart_studio.optimization.replay_frame'
    )

    await user.click(within(replay).getByRole('button', { name: 'chemsmart_studio.optimization.playback.play' }))
    await waitFor(() => {
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.optimization.replay_frame', {
        sessionId: 'topic-a',
        runId: 'run-recorded',
        stepIndex: 0
      })
    })
    await user.click(within(replay).getByRole('button', { name: 'chemsmart_studio.optimization.playback.pause' }))
    await user.click(within(replay).getByRole('button', { name: 'chemsmart_studio.optimization.playback.next' }))
    await waitFor(() => {
      expect(ipcMocks.request).toHaveBeenCalledWith('chemsmart_studio.optimization.replay_frame', {
        sessionId: 'topic-a',
        runId: 'run-recorded',
        stepIndex: 1
      })
    })
  })
})
