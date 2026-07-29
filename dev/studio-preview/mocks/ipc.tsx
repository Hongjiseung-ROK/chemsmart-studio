import type { MoleculeDocument, MoleculeOperation, PreviewReceipt, StudioUiEvent } from '@chemsmart/studio-protocol'
import type { ChemSmartStudioViewportState } from '@shared/ipc/schemas/chemsmartStudio'
import { useEffect } from 'react'

import {
  applyOperations,
  commandInspection,
  previewApproval,
  replayCatalog,
  replaySelection,
  replayTimeline,
  type Scenario,
  scenario,
  type ScenarioName,
  viewportState
} from '../scenarios'

type Listener = (payload: never) => void

const listeners = new Map<string, Set<Listener>>()
const requestLog: string[] = []

let state: Scenario = scenario('working')
let pendingOperations: readonly MoleculeOperation[] = []

function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload as never)
}

function status(processState: 'stopped' | 'running') {
  return { state: processState, pid: processState === 'running' ? 4242 : null, lastError: null }
}

function receipt(document: MoleculeDocument, operations: readonly MoleculeOperation[]): PreviewReceipt {
  const affectedAtomIds = operations.flatMap((operation) => {
    switch (operation.op) {
      case 'add_atoms':
        return operation.atoms.map((atom) => atom.id)
      case 'remove_atoms':
      case 'set_selection':
        return operation.atomIds
      case 'set_positions':
        return operation.positions.map((position) => position.atomId)
      case 'set_atomic_numbers':
        return operation.atoms.map((atom) => atom.atomId)
      case 'set_frozen_axes':
        return operation.masks.map((mask) => mask.atomId)
      case 'set_constraints':
        return operation.constraints.flatMap((constraint) => constraint.atomIds)
      default:
        return []
    }
  })
  const affectedBondIds = operations.flatMap((operation) => {
    switch (operation.op) {
      case 'add_bonds':
        return operation.bonds.map((bond) => bond.id)
      case 'remove_bonds':
        return operation.bondIds
      case 'set_bond_orders':
        return operation.bonds.map((bond) => bond.bondId)
      default:
        return []
    }
  })
  return {
    previewId: 'preview-1',
    operationId: 'operation-1',
    baseRevision: document.revision,
    affectedAtomIds,
    affectedBondIds,
    beforeHash: `sha256:${'a'.repeat(64)}`,
    afterHash: `sha256:${'b'.repeat(64)}`,
    diff: { operationCount: operations.length },
    createdAt: new Date().toISOString(),
    extensions: {}
  }
}

/** Commits or discards whatever the last proposal was, exactly like the trusted commit path. */
function performAction(actionId: string) {
  if (actionId === 'action-commit' && state.document) {
    const committed = applyOperations(state.document, pendingOperations)
    state = {
      ...state,
      document: { ...committed, revision: state.document.revision + 1 },
      snapshot: { ...state.snapshot, pendingApprovals: [], snapshotRevision: state.snapshot.snapshotRevision + 1 }
    }
    pendingOperations = []
    emit('chemsmart_studio.molecule.changed', {
      documentId: state.document!.documentId,
      revision: state.document!.revision
    })
  } else if (actionId === 'action-discard' || actionId.startsWith('action-deny')) {
    pendingOperations = []
    state = { ...state, snapshot: { ...state.snapshot, pendingApprovals: [] } }
  } else if (actionId === 'action-allow-calculation') {
    state = { ...state, snapshot: scenario('running').snapshot }
  } else if (actionId === 'action-cancel') {
    state = { ...state, snapshot: scenario('working').snapshot }
  } else if (actionId.startsWith('action-accept-final') || actionId.startsWith('action-reject-final')) {
    state = { ...state, snapshot: scenario('working').snapshot }
  }
  return state.snapshot
}

export const ipcApi = {
  async request(route: string, input?: unknown): Promise<unknown> {
    requestLog.push(route)
    switch (route) {
      case 'chemsmart_studio.status':
        return { editor: status(state.editorState), agent: status(state.agentState) }
      case 'chemsmart_studio.agent.runtime_context':
        return { deterministicModelId: 'preview:deterministic-validator' }
      case 'chemsmart_studio.editor.start':
        state = { ...state, editorState: 'running', viewport: viewportState('attached') }
        emit('chemsmart_studio.viewport.state_changed', state.viewport)
        return status('running')
      case 'chemsmart_studio.editor.stop':
        state = { ...state, editorState: 'stopped', viewport: viewportState('editor_stopped') }
        emit('chemsmart_studio.viewport.state_changed', state.viewport)
        return status('stopped')
      case 'chemsmart_studio.editor.focus':
        return { success: true }
      case 'chemsmart_studio.molecule.summary':
        if (!state.document) throw Object.assign(new Error('editor unavailable'), { code: 'EDITOR_UNAVAILABLE' })
        return { documentId: state.document.documentId, revision: state.document.revision }
      case 'chemsmart_studio.molecule.document':
        if (!state.document) throw Object.assign(new Error('editor unavailable'), { code: 'EDITOR_UNAVAILABLE' })
        return state.document
      case 'chemsmart_studio.molecule.set_selection': {
        if (!state.document) throw Object.assign(new Error('editor unavailable'), { code: 'EDITOR_UNAVAILABLE' })
        const { atomIds, documentId, expectedRevision } = input as {
          atomIds: string[]
          documentId: string
          expectedRevision: number
        }
        if (documentId !== state.document.documentId || expectedRevision !== state.document.revision) {
          throw Object.assign(new Error('stale selection'), { code: 'REVISION_CONFLICT' })
        }
        state = { ...state, document: { ...state.document, selections: [...atomIds] } }
        return state.document
      }
      case 'chemsmart_studio.molecule.propose_patch': {
        const { operations } = input as { operations: readonly MoleculeOperation[] }
        pendingOperations = operations
        const preview = receipt(state.document!, operations)
        state = { ...state, snapshot: previewApproval(state.document!.revision, preview.affectedAtomIds) }
        emit('chemsmart_studio.control.changed', {
          sessionId: state.snapshot.sessionId,
          snapshotRevision: state.snapshot.snapshotRevision
        })
        return preview
      }
      case 'chemsmart_studio.control.snapshot':
        return state.snapshot
      case 'chemsmart_studio.control.perform_action':
        return performAction((input as { actionId: string }).actionId)
      case 'chemsmart_studio.command.inspect':
        return commandInspection()
      case 'chemsmart_studio.agent.replay_studio_ui':
        for (const event of state.events) emit('chemsmart_studio.studio_ui.event', event)
        return { replayed: state.events.length, nextSequence: state.events.length }
      case 'chemsmart_studio.agent.run_turn':
        for (const event of state.events) emit('chemsmart_studio.studio_ui.event', event)
        return { completed: true }
      case 'chemsmart_studio.optimization.replay_catalog':
        return replayCatalog()
      case 'chemsmart_studio.optimization.replay_timeline':
        return replayTimeline()
      case 'chemsmart_studio.optimization.replay_frame': {
        const selection = replaySelection((input as { stepIndex: number }).stepIndex)
        emit('chemsmart_studio.optimization.replay_changed', { sessionId: state.snapshot.sessionId, selection })
        return selection
      }
      case 'chemsmart_studio.optimization.stop_replay':
        return { ...replaySelection(0), viewing: false, runId: null, stepIndex: null, frame: null }
      case 'chemsmart_studio.viewport.attach':
      case 'chemsmart_studio.viewport.set_bounds': {
        const covered = (input as { covered: boolean }).covered
        const reason = state.editorState !== 'running' ? 'editor_stopped' : state.viewport.reason
        const next: ChemSmartStudioViewportState =
          covered && reason === 'attached' ? viewportState('covered') : viewportState(reason)
        return next
      }
      case 'chemsmart_studio.project.list':
        return {
          schemaVersion: '1',
          programs: [
            { program: 'gaussian', projectNames: ['b3lyp-water'], projectRequired: true, extensions: {} },
            { program: 'orca', projectNames: [], projectRequired: true, extensions: {} },
            { program: 'xtb', projectNames: [], projectRequired: false, extensions: {} }
          ],
          extensions: {}
        }
      case 'chemsmart_studio.project.read':
        return {
          schemaVersion: '1',
          projectName: 'b3lyp-water',
          program: 'gaussian',
          yamlText: [
            'gas:',
            '  functional: b3lyp',
            '  basis: 6-31G(d)',
            'solvent:',
            '  model: smd',
            '  solvent_id: water'
          ].join('\n'),
          extensions: {}
        }
      case 'chemsmart_studio.project.validate': {
        const request = input as { projectName: string; program: 'gaussian' | 'orca' }
        return {
          schemaVersion: '1',
          projectName: request.projectName,
          program: request.program,
          verdict: 'ok',
          issues: [],
          message: 'Project YAML passed ChemSmart validation.',
          extensions: {}
        }
      }
      case 'chemsmart_studio.project.critic': {
        const request = input as { projectName: string; program: 'gaussian' | 'orca' }
        return {
          schemaVersion: '1',
          projectName: request.projectName,
          program: request.program,
          verdict: 'ok',
          issues: [],
          summary: 'The method project is internally consistent for the requested program.',
          unsupportedFeatures: [],
          extensions: {}
        }
      }
      case 'chemsmart_studio.command.synthesize': {
        const synthesisRequest = input as { request: string; sessionId: string }
        const request = String(synthesisRequest.request ?? '')
        // A request that names no project drifts to a different charge, which is what the intent gate is for.
        if (/charge\s*-1|anion/i.test(request)) {
          return {
            schemaVersion: '1',
            synthesisId: 'preview-synthesis-intent-reject',
            sessionId: synthesisRequest.sessionId,
            status: 'intentRejected',
            command: 'chemsmart -p b3lyp-water run -f ethanol.xyz gaussian opt -c 0 -m 1',
            commandDigest: 'dc8345a34438126df9adc6971a0a64ec9ef7d73aaeaf227040fbd34fbf39a927',
            explanation: 'The synthesized command is executable but does not preserve all explicit user intent.',
            projectName: 'b3lyp-water',
            missingInfo: ['The requested -1 charge was not preserved.'],
            semantic: {
              verdict: 'ok',
              failedRuleIds: [],
              message: 'The command is valid ChemSmart syntax.',
              extensions: {}
            },
            intent: {
              verdict: 'reject',
              failedRuleIds: ['intent.charge'],
              message: 'The command changed the explicitly requested molecular charge.',
              extensions: {}
            },
            publicEvidence: [
              {
                evidenceId: 'preview-intent-gate',
                kind: 'intentGate',
                verdict: 'reject',
                summary: 'Explicit charge preservation failed.',
                ruleIds: ['intent.charge'],
                extensions: {}
              }
            ],
            executionPerformed: false,
            approvalRequiredForExecution: true,
            extensions: {}
          }
        }
        return {
          schemaVersion: '1',
          synthesisId: 'preview-synthesis-ready',
          sessionId: synthesisRequest.sessionId,
          status: 'ready',
          command: 'chemsmart run -f ethanol.xyz xtb -c 0 -m 1 opt',
          commandDigest: 'ae5a26936d941f29a356e81df42abf7bfc689cf54b9c28e852ad8ed373a15ed6',
          explanation: 'GFN2-xTB geometry optimisation of the neutral singlet. xTB needs no project.',
          projectName: null,
          missingInfo: [],
          semantic: {
            verdict: 'ok',
            failedRuleIds: [],
            message: 'The command is valid ChemSmart syntax.',
            extensions: {}
          },
          intent: {
            verdict: 'ok',
            failedRuleIds: [],
            message: 'Method, charge, multiplicity, task, and input match the request.',
            extensions: {}
          },
          publicEvidence: [
            {
              evidenceId: 'preview-command-validation',
              kind: 'commandValidation',
              verdict: 'ok',
              summary: 'Command syntax and user intent both passed.',
              ruleIds: [],
              extensions: {}
            }
          ],
          executionPerformed: false,
          approvalRequiredForExecution: true,
          extensions: {}
        }
      }
      case 'chemsmart_studio.viewport.detach':
        return viewportState('editor_stopped')
      default:
        throw new Error(`The harness has no answer for ${route}`)
    }
  }
}

export function useIpcOn(event: string, handler: Listener): void {
  useEffect(() => {
    const set = listeners.get(event) ?? new Set<Listener>()
    set.add(handler)
    listeners.set(event, set)
    return () => {
      set.delete(handler)
    }
  })
}

/** Drives the harness from the page, so a screenshot run is scripted rather than hand-clicked. */
export const harness = {
  emit,
  get requests() {
    return [...requestLog]
  },
  get scenario() {
    return state
  },
  pushEvents(events: StudioUiEvent[]) {
    for (const event of events) emit('chemsmart_studio.studio_ui.event', event)
  },
  setScenario(name: ScenarioName) {
    state = scenario(name)
    pendingOperations = []
    return name
  },
  setViewport(reason: ChemSmartStudioViewportState['reason']) {
    state = { ...state, viewport: viewportState(reason) }
    emit('chemsmart_studio.viewport.state_changed', state.viewport)
  }
}
