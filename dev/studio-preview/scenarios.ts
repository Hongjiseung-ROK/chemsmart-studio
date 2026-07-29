import type {
  CommandInspectionResult,
  MoleculeDocument,
  MoleculeOperation,
  OptimizationReplayCatalog,
  OptimizationReplayTimeline,
  StudioControlSnapshot,
  StudioUiEvent
} from '@chemsmart/studio-protocol'
import type { ChemSmartStudioViewportState } from '@shared/ipc/schemas/chemsmartStudio'

export const sessionId = 'session-preview'
const documentId = 'ethanol-fixture'
const hash = (character: string) => `sha256:${character.repeat(64)}`

/** Ethanol, so the coordinate table, measurements and constraints all have something real to show. */
export function ethanol(revision = 12): MoleculeDocument {
  return {
    documentId,
    revision,
    atoms: [
      { id: 'C1', atomicNumber: 6, position: [-0.7487, 0.0193, 0.0], formalCharge: 0, extensions: {} },
      { id: 'C2', atomicNumber: 6, position: [0.6842, -0.4523, 0.0], formalCharge: 0, extensions: {} },
      { id: 'O1', atomicNumber: 8, position: [1.5847, 0.6273, 0.0], formalCharge: 0, extensions: {} },
      { id: 'H1', atomicNumber: 1, position: [-1.4372, -0.8318, 0.0], formalCharge: 0, extensions: {} },
      { id: 'H2', atomicNumber: 1, position: [-0.9294, 0.6215, 0.8942], formalCharge: 0, extensions: {} },
      { id: 'H3', atomicNumber: 1, position: [-0.9294, 0.6215, -0.8942], formalCharge: 0, extensions: {} },
      { id: 'H4', atomicNumber: 1, position: [0.8461, -1.0729, 0.8901], formalCharge: 0, extensions: {} },
      { id: 'H5', atomicNumber: 1, position: [0.8461, -1.0729, -0.8901], formalCharge: 0, extensions: {} },
      { id: 'H6', atomicNumber: 1, position: [2.4938, 0.2937, 0.0], formalCharge: 0, extensions: {} }
    ],
    bonds: [
      { id: 'b1', atomIds: ['C1', 'C2'], order: 1, extensions: {} },
      { id: 'b2', atomIds: ['C2', 'O1'], order: 1, extensions: {} },
      { id: 'b3', atomIds: ['C1', 'H1'], order: 1, extensions: {} },
      { id: 'b4', atomIds: ['C1', 'H2'], order: 1, extensions: {} },
      { id: 'b5', atomIds: ['C1', 'H3'], order: 1, extensions: {} },
      { id: 'b6', atomIds: ['C2', 'H4'], order: 1, extensions: {} },
      { id: 'b7', atomIds: ['C2', 'H5'], order: 1, extensions: {} },
      { id: 'b8', atomIds: ['O1', 'H6'], order: 1, extensions: {} }
    ],
    selections: [],
    frozenAxes: { O1: [false, false, true] },
    constraints: [
      { id: 'c1', type: 'distance', atomIds: ['C2', 'O1'], target: 1.43, unit: 'angstrom', extensions: {} }
    ],
    properties: { name: 'Ethanol', charge: 0, multiplicity: 1, extensions: {} },
    extensions: {}
  }
}

export function emptySnapshot(): StudioControlSnapshot {
  return {
    sessionId,
    snapshotRevision: 1,
    molecule: { documentId, revision: 12, geometryHash: hash('a'), source: 'committed', updatedAt: at(0) },
    pendingApprovals: [],
    activity: [],
    optimization: null,
    extensions: {}
  }
}

function at(minutes: number): string {
  return new Date(Date.UTC(2026, 6, 25, 9, minutes, 0)).toISOString()
}

export function previewApproval(revision: number, affectedAtomIds: string[]): StudioControlSnapshot {
  return {
    ...emptySnapshot(),
    snapshotRevision: 2,
    pendingApprovals: [
      {
        kind: 'preview_commit',
        requestId: 'request-preview',
        approvalId: 'approval-preview',
        requestedAt: at(3),
        expiresAt: at(8),
        risk: 'molecule_mutation',
        receipt: {
          previewId: 'preview-1',
          operationId: 'operation-1',
          baseRevision: revision,
          affectedAtomIds,
          affectedBondIds: [],
          beforeHash: hash('a'),
          afterHash: hash('b'),
          diff: { operationCount: 1, movedAtomCount: affectedAtomIds.length },
          createdAt: at(3),
          extensions: {}
        },
        commitActionId: 'action-commit',
        discardActionId: 'action-discard'
      }
    ],
    activity: [
      {
        activityId: 'activity-1',
        sequence: 0,
        timestamp: at(3),
        kind: 'schema_validation',
        status: 'passed',
        title: 'Molecule patch validated',
        summary: 'One operation against revision 12.',
        toolName: 'propose_molecule_patch',
        extensions: {}
      }
    ]
  }
}

export function calculationApproval(): StudioControlSnapshot {
  return {
    ...emptySnapshot(),
    snapshotRevision: 3,
    pendingApprovals: [
      {
        kind: 'controlled_calculation_start',
        requestId: 'request-controlled',
        approvalId: 'approval-controlled',
        requestedAt: at(5),
        expiresAt: at(10),
        risk: 'calculation_execution',
        documentId,
        expectedRevision: 12,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: {
          maxSteps: 40,
          maxRuntimeSeconds: 180,
          threads: 1,
          charge: 0,
          multiplicity: 1,
          extensions: {}
        },
        planId: 'plan-ethanol-1',
        planDigest: hash('c'),
        runtimeFingerprint: hash('d'),
        allowActionId: 'action-allow-calculation',
        denyActionId: 'action-deny-calculation'
      }
    ],
    activity: [
      {
        activityId: 'activity-2',
        sequence: 0,
        timestamp: at(4),
        kind: 'intent_gate',
        status: 'passed',
        title: 'Intent gate passed',
        summary: 'The request asks for a geometry optimisation of the committed structure.',
        toolName: 'prepare_molecule_optimization',
        extensions: {}
      },
      {
        activityId: 'activity-3',
        sequence: 1,
        timestamp: at(5),
        kind: 'semantic_gate',
        status: 'passed',
        title: 'Semantic gate passed',
        summary: 'Charge, multiplicity and thread budget are consistent with the committed molecule.',
        toolName: 'validate_prepared_optimization',
        extensions: {}
      }
    ],
    agent: agentWorkspace('awaiting_calculation_approval', 'calculation', 0.35, true)
  }
}

function agentWorkspace(
  phase: string,
  currentObject: string,
  progress: number | null,
  requiresUserInput: boolean
): NonNullable<StudioControlSnapshot['agent']> {
  return {
    phase,
    currentObject,
    activeTool: 'validate_prepared_optimization',
    statusSummary: 'Waiting for your decision before any calculation starts.',
    progress,
    focus: { atomIds: ['C2', 'O1'], bondIds: [] },
    latestGate: 'passed',
    pendingTrustedAction: 'calculation_start',
    requiresUserInput,
    terminalResult: null,
    recoverySequence: 0,
    updatedAt: at(5),
    extensions: {}
  } as NonNullable<StudioControlSnapshot['agent']>
}

const runFrame = (stepIndex: number) => ({
  runId: 'run-1',
  stepIndex,
  energy: { value: -154.7723 + stepIndex * -0.0031, unit: 'hartree' as const },
  forceMetrics: { max: 0.0182 - stepIndex * 0.004, rms: 0.0091 - stepIndex * 0.002, unit: 'hartree/bohr' as const },
  convergence: { converged: stepIndex >= 3, threshold: 0.001 },
  structureHash: hash('e'),
  timestamp: at(6 + stepIndex)
})

export function runningOptimization(): StudioControlSnapshot {
  return {
    ...emptySnapshot(),
    snapshotRevision: 4,
    optimization: {
      run: {
        runId: 'run-1',
        documentId,
        inputRevision: 12,
        engine: 'xtb',
        method: 'GFN2-xTB',
        settings: { maxSteps: 40, charge: 0, multiplicity: 1, extensions: {} },
        frozenAtomIds: ['O1'],
        constraintIds: ['c1'],
        status: 'running',
        createdAt: at(6),
        extensions: {}
      },
      frameCount: 3,
      latestFrame: runFrame(2),
      cancelActionId: 'action-cancel',
      finalGeometry: null,
      extensions: {}
    },
    activity: calculationApproval().activity,
    agent: {
      ...agentWorkspace('running_calculation', 'trajectory', 0.62, false),
      statusSummary: 'Watching the trajectory; three frames committed so far.'
    }
  }
}

export function awaitingFinalGeometry(): StudioControlSnapshot {
  const running = runningOptimization()
  return {
    ...running,
    snapshotRevision: 5,
    optimization: {
      ...running.optimization!,
      run: { ...running.optimization!.run, status: 'awaiting_final_geometry' },
      frameCount: 4,
      latestFrame: runFrame(3),
      cancelActionId: undefined,
      finalGeometry: {
        risk: 'final_geometry_commit',
        expectedRevision: 12,
        frame: runFrame(3),
        acceptActionId: 'action-accept-final',
        rejectActionId: 'action-reject-final'
      }
    },
    agent: {
      ...agentWorkspace('awaiting_final_geometry_decision', 'trajectory', 1, true),
      statusSummary: 'The run converged. The final geometry needs your decision before it is committed.'
    }
  }
}

export function replayCatalog(): OptimizationReplayCatalog {
  return {
    totalRuns: 1,
    runs: [
      {
        run: {
          runId: 'run-1',
          documentId,
          inputRevision: 12,
          engine: 'xtb',
          method: 'GFN2-xTB',
          settings: { maxSteps: 40, extensions: {} },
          frozenAtomIds: ['O1'],
          constraintIds: ['c1'],
          status: 'completed',
          createdAt: at(6),
          extensions: {}
        },
        frameCount: 4,
        latestFrame: runFrame(3),
        outcome: 'accepted',
        message: '',
        updatedAt: at(9),
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

export function replayTimeline(): OptimizationReplayTimeline {
  return {
    runId: 'run-1',
    offset: 0,
    limit: 500,
    totalFrames: 4,
    frames: [runFrame(0), runFrame(1), runFrame(2), runFrame(3)],
    extensions: {}
  }
}

export function replaySelection(stepIndex: number) {
  return {
    viewing: true,
    runId: 'run-1',
    stepIndex,
    frameCount: 4,
    documentId,
    revision: 12,
    frame: runFrame(stepIndex),
    extensions: {}
  }
}

export function commandInspection(): CommandInspectionResult {
  return {
    schemaVersion: '1',
    inspectionId: 'inspection-1',
    sessionId,
    status: 'ready_for_dry_run',
    commandDigest: 'f'.repeat(64),
    parse: {
      accepted: true,
      action: 'run',
      program: 'xtb',
      job: 'opt',
      project: null,
      inputName: 'ethanol.xyz',
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
      verdict: 'ok',
      failedRuleIds: [],
      assertions: [
        { id: 'intent.program', status: 'pass' },
        { id: 'intent.kind', status: 'pass' }
      ]
    },
    semantic: {
      verdict: 'warn',
      complete: false,
      failedRuleIds: ['cmd.semantic.dry_run_required'],
      missingInfo: [],
      issues: [
        {
          ruleId: 'cmd.semantic.dry_run_required',
          severity: 'warn',
          message: 'Static preflight passed; an isolated dry run is still required before execution.'
        }
      ]
    },
    dryRun: { state: 'required', processStarted: false },
    executionPerformed: false,
    approvalRequiredForExecution: true,
    missingInfo: [],
    extensions: {}
  }
}

let sequence = 0
function event(kind: StudioUiEvent['kind'], payload: StudioUiEvent['payload']): StudioUiEvent {
  sequence += 1
  return {
    eventId: `ui-event-${sequence}`,
    sessionId,
    sequence,
    timestamp: at(3 + sequence),
    source: 'runtime',
    kind,
    payload,
    extensions: {}
  }
}

/** A short agent turn: what it said it was doing, where it pointed, and what it asked for. */
export function agentTurnEvents(): StudioUiEvent[] {
  sequence = 0
  return [
    event('status', { message: 'Reading the committed structure at revision 12.' }),
    event('agent_thought', {
      message: 'The C–O bond looks long for an alcohol; measuring before proposing anything.',
      phase: 'understanding_request'
    }),
    event('molecule_focus', {
      message: 'Measuring C2–O1.',
      documentId,
      revision: 12,
      atomIds: ['C2', 'O1']
    }),
    event('agent_thought', {
      message: 'A GFN2-xTB optimisation is the cheapest way to settle the geometry; it needs approval.',
      phase: 'preparing_calculation',
      toolName: 'prepare_molecule_optimization'
    }),
    event('inspector_target', { message: 'Asking for the calculation decision.', target: 'decisions' }),
    event('notice', { message: 'A calculation approval is waiting for you.' })
  ]
}

export function viewportState(reason: ChemSmartStudioViewportState['reason']): ChemSmartStudioViewportState {
  return { attached: reason === 'attached', reason, visible: reason === 'attached' }
}

export const scenarioNames = ['empty', 'working', 'human-edit', 'approval', 'running', 'final', 'standalone'] as const
export type ScenarioName = (typeof scenarioNames)[number]

export interface Scenario {
  editorState: 'stopped' | 'running'
  agentState: 'stopped' | 'running'
  document: MoleculeDocument | null
  snapshot: StudioControlSnapshot
  events: StudioUiEvent[]
  viewport: ChemSmartStudioViewportState
}

export function scenario(name: ScenarioName): Scenario {
  switch (name) {
    case 'empty':
      return {
        editorState: 'stopped',
        agentState: 'stopped',
        document: null,
        snapshot: { ...emptySnapshot(), molecule: null },
        events: [],
        viewport: viewportState('editor_stopped')
      }
    case 'human-edit':
      return {
        editorState: 'running',
        agentState: 'stopped',
        document: ethanol(),
        snapshot: previewApproval(12, ['H6']),
        events: [],
        viewport: viewportState('attached')
      }
    case 'approval':
      return {
        editorState: 'running',
        agentState: 'running',
        document: ethanol(),
        snapshot: calculationApproval(),
        events: agentTurnEvents(),
        viewport: viewportState('attached')
      }
    case 'running':
      return {
        editorState: 'running',
        agentState: 'running',
        document: ethanol(),
        snapshot: runningOptimization(),
        events: agentTurnEvents(),
        viewport: viewportState('attached')
      }
    case 'final':
      return {
        editorState: 'running',
        agentState: 'running',
        document: ethanol(),
        snapshot: awaitingFinalGeometry(),
        events: agentTurnEvents(),
        viewport: viewportState('attached')
      }
    case 'standalone':
      return {
        editorState: 'running',
        agentState: 'stopped',
        document: ethanol(),
        snapshot: emptySnapshot(),
        events: [],
        viewport: viewportState('standalone')
      }
    default:
      return {
        editorState: 'running',
        agentState: 'stopped',
        document: ethanol(),
        snapshot: emptySnapshot(),
        events: [],
        viewport: viewportState('attached')
      }
  }
}

/** Applies a proposed patch so a committed preview really changes what the tables show. */
export function applyOperations(
  document: MoleculeDocument,
  operations: readonly MoleculeOperation[]
): MoleculeDocument {
  let next: MoleculeDocument = structuredClone(document)
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_atoms':
        next = { ...next, atoms: [...next.atoms, ...operation.atoms] }
        break
      case 'remove_atoms':
        next = {
          ...next,
          atoms: next.atoms.filter((atom) => !operation.atomIds.includes(atom.id)),
          bonds: next.bonds.filter((bond) => !bond.atomIds.some((id) => operation.atomIds.includes(id)))
        }
        break
      case 'add_bonds':
        next = { ...next, bonds: [...next.bonds, ...operation.bonds] }
        break
      case 'remove_bonds':
        next = { ...next, bonds: next.bonds.filter((bond) => !operation.bondIds.includes(bond.id)) }
        break
      case 'set_positions':
        next = {
          ...next,
          atoms: next.atoms.map((atom) => {
            const moved = operation.positions.find((position) => position.atomId === atom.id)
            return moved ? { ...atom, position: moved.position } : atom
          })
        }
        break
      case 'set_atomic_numbers':
        next = {
          ...next,
          atoms: next.atoms.map((atom) => {
            const replacement = operation.atoms.find((candidate) => candidate.atomId === atom.id)
            return replacement ? { ...atom, atomicNumber: replacement.atomicNumber } : atom
          })
        }
        break
      case 'set_bond_orders':
        next = {
          ...next,
          bonds: next.bonds.map((bond) => {
            const replacement = operation.bonds.find((candidate) => candidate.bondId === bond.id)
            return replacement ? { ...bond, order: replacement.order } : bond
          })
        }
        break
      case 'set_selection':
        next = { ...next, selections: [...operation.atomIds] }
        break
      case 'set_frozen_axes':
        next = {
          ...next,
          frozenAxes: operation.masks.reduce((axes, mask) => ({ ...axes, [mask.atomId]: mask.axes }), next.frozenAxes)
        }
        break
      case 'set_constraints':
        next = { ...next, constraints: [...next.constraints, ...operation.constraints] }
        break
      case 'remove_constraints':
        next = {
          ...next,
          constraints: next.constraints.filter((constraint) => !operation.constraintIds.includes(constraint.id))
        }
        break
    }
  }
  return next
}
