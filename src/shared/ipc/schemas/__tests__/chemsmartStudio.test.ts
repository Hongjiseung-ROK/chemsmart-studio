import { describe, expect, it } from 'vitest'

import { chemsmartStudioRequestSchemas } from '../chemsmartStudio'

const snapshotRoute = chemsmartStudioRequestSchemas['chemsmart_studio.control.snapshot']
const performActionRoute = chemsmartStudioRequestSchemas['chemsmart_studio.control.perform_action']

const validSnapshot = {
  sessionId: 'session-1',
  snapshotRevision: 0,
  molecule: null,
  pendingApprovals: [],
  activity: [],
  optimization: null,
  extensions: {}
}
const validAgentState = {
  phase: 'awaiting_calculation_approval',
  currentObject: 'calculation_plan',
  activeTool: 'start_prepared_optimization',
  statusSummary: 'Waiting for calculation approval',
  progress: null,
  focus: { atomIds: [], bondIds: [] },
  latestGate: 'passed',
  pendingTrustedAction: 'calculation_start',
  requiresUserInput: true,
  terminalResult: null,
  recoverySequence: 0,
  updatedAt: '2026-07-25T00:00:00Z',
  extensions: {}
}
const validFrame = {
  runId: 'run-1',
  stepIndex: 0,
  energy: { value: -76.1, unit: 'hartree' },
  forceMetrics: { max: 0.0002, rms: 0.0001, unit: 'hartree/bohr' },
  convergence: { converged: false },
  structureHash: `sha256:${'3'.repeat(64)}`,
  timestamp: '2026-07-22T00:10:00Z'
}
const validRun = {
  runId: 'run-1',
  documentId: 'molecule-1',
  inputRevision: 2,
  engine: 'avogadro',
  method: 'UFF',
  settings: { maxSteps: 50, extensions: {} },
  constraintIds: [],
  frozenAtomIds: [],
  status: 'running',
  createdAt: '2026-07-22T00:03:00Z',
  extensions: {}
}
const validRunningOptimization = {
  run: validRun,
  frameCount: 1,
  latestFrame: validFrame,
  cancelActionId: 'action-cancel-1',
  finalGeometry: null,
  extensions: {}
}
const validFinalGeometry = {
  risk: 'final_geometry_commit',
  expectedRevision: 2,
  frame: { ...validFrame, convergence: { converged: true } },
  acceptActionId: 'action-accept-1',
  rejectActionId: 'action-reject-1'
}

describe('ChemSmart Studio trusted control schemas', () => {
  it('validates a generated Studio draft snapshot with bundled local definitions', () => {
    const route = chemsmartStudioRequestSchemas['chemsmart_studio.molecule.draft_apply']
    const beforeHash = `sha256:${'1'.repeat(64)}`
    const afterHash = `sha256:${'2'.repeat(64)}`
    const createdAt = '2026-07-29T00:00:00Z'
    const atom = {
      id: 'atom-1',
      atomicNumber: 6,
      position: [0, 0, 0],
      formalCharge: 0,
      extensions: {}
    }
    const operation = { op: 'add_atoms', atoms: [atom] }
    const snapshot = {
      draftId: 'draft-1',
      documentId: 'molecule-1',
      baseRevision: 0,
      document: {
        documentId: 'molecule-1',
        revision: 0,
        atoms: [atom],
        bonds: [],
        selections: [],
        frozenAxes: {},
        constraints: [],
        properties: { extensions: {} },
        extensions: {}
      },
      entries: [
        {
          entryId: 'entry-1',
          actor: 'human',
          mode: 'build',
          operations: [operation],
          summary: {
            operationKinds: ['add_atoms'],
            elementChanges: [{ atomId: 'atom-1', kind: 'added', afterAtomicNumber: 6 }],
            coordinateChangeCount: 0,
            bondChangeCount: 0,
            constraintChangeCount: 0,
            affectedAtomIds: ['atom-1'],
            affectedBondIds: [],
            affectedConstraintIds: []
          },
          beforeHash,
          afterHash,
          gesture: {
            gestureId: 'gesture-1',
            kind: 'insert_atom',
            atomicNumber: 6,
            position: [0, 0, 0],
            createdAt,
            extensions: {}
          },
          createdAt,
          extensions: {}
        }
      ],
      cursor: 1,
      dirty: true,
      canUndo: true,
      canRedo: false,
      createdAt,
      updatedAt: createdAt,
      extensions: {}
    }

    expect(
      route.input.safeParse({
        sessionId: 'session-1',
        expectedRevision: 0,
        mode: 'build',
        operations: [operation],
        gesture: snapshot.entries[0].gesture
      }).success
    ).toBe(true)
    expect(route.output.safeParse(snapshot).success).toBe(true)
  })

  it('accepts path-free command inspection and rejects renderer execution controls', () => {
    const route = chemsmartStudioRequestSchemas['chemsmart_studio.command.inspect']
    const input = {
      sessionId: 'session-1',
      command: 'chemsmart run xtb -f water.xyz -c 0 -m 1 opt',
      intentDescription: 'Run a GFN2-xTB geometry optimization.'
    }
    const result = {
      schemaVersion: '1',
      inspectionId: 'inspection-1',
      sessionId: 'session-1',
      status: 'ready_for_dry_run',
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
      intent: {
        verdict: 'ok',
        failedRuleIds: [],
        assertions: [{ id: 'intent.kind', status: 'pass' }]
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
            message: 'Dry run is required.'
          }
        ]
      },
      dryRun: { state: 'required', processStarted: false },
      executionPerformed: false,
      approvalRequiredForExecution: true,
      missingInfo: [],
      extensions: {}
    }

    expect(route.input.safeParse(input).success).toBe(true)
    expect(route.input.safeParse({ ...input, execute: true }).success).toBe(false)
    expect(route.output.safeParse(result).success).toBe(true)
    expect(route.output.safeParse({ ...result, stdout: '/private/output' }).success).toBe(false)
    expect(route.output.safeParse({ ...result, executionPerformed: true }).success).toBe(false)
  })

  it.each([
    'chemsmart_studio.editor.open_project',
    'chemsmart_studio.editor.import_molecule',
    'chemsmart_studio.editor.save_as'
  ] as const)('keeps filesystem paths out of the renderer result for %s', (route) => {
    const output = chemsmartStudioRequestSchemas[route].output
    const valid = {
      canceled: false,
      molecule: { documentId: 'molecule-1', revision: 2 },
      documentName: 'Ethanol'
    }

    expect(output.safeParse(valid).success).toBe(true)
    expect(output.safeParse({ ...valid, projectPath: '/private/user/Ethanol.cmsproj' }).success).toBe(false)
  })

  it('names an open document by opaque handle only', () => {
    const list = chemsmartStudioRequestSchemas['chemsmart_studio.editor.open_documents'].output
    const activate = chemsmartStudioRequestSchemas['chemsmart_studio.editor.activate_document'].input
    const valid = {
      activeProjectId: 'project-a1b2',
      documents: [{ projectId: 'project-a1b2', projectName: 'Ethanol' }]
    }

    expect(list.safeParse(valid).success).toBe(true)
    // The active project is always open, so an empty strip is not a representable state.
    expect(list.safeParse({ ...valid, documents: [] }).success).toBe(false)
    // A tab must never carry the location it stands for.
    expect(
      list.safeParse({
        ...valid,
        documents: [{ ...valid.documents[0], projectPath: '/private/user/Ethanol.cmsproj' }]
      }).success
    ).toBe(false)
    expect(activate.safeParse({ projectId: 'project-a1b2' }).success).toBe(true)
    expect(activate.safeParse({ projectPath: '/private/user/Ethanol.cmsproj' }).success).toBe(false)
  })

  it('exposes explorer roots as paths and nothing else', () => {
    const route = chemsmartStudioRequestSchemas['chemsmart_studio.workspace.roots']
    // The explorer is a human surface, so unlike every other Studio route this one carries real
    // paths on purpose. What it must not do is grow beyond the two the tree consumes.
    const valid = { projectsRoot: '/private/user/Projects', activeProjectPath: '/private/user/Projects/A.cmsproj' }

    expect(route.input.safeParse(undefined).success).toBe(true)
    expect(route.output.safeParse(valid).success).toBe(true)
    expect(route.output.safeParse({ ...valid, projectsRoot: '' }).success).toBe(false)
    expect(route.output.safeParse({ ...valid, activeProjectPath: '' }).success).toBe(false)
    expect(route.output.safeParse({ ...valid, calculationsRoot: '/private/user/Calculations' }).success).toBe(false)
    expect(route.output.safeParse({ projectsRoot: valid.projectsRoot }).success).toBe(false)
  })

  it('keeps replay document identity main-owned while accepting canonical replay outputs', () => {
    const frameInput = chemsmartStudioRequestSchemas['chemsmart_studio.optimization.replay_frame'].input
    const frameOutput = chemsmartStudioRequestSchemas['chemsmart_studio.optimization.replay_frame'].output
    expect(frameInput.parse({ sessionId: 'session-1', runId: 'run-1', stepIndex: 0 })).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      stepIndex: 0
    })
    expect(
      frameInput.safeParse({
        sessionId: 'session-1',
        runId: 'run-1',
        stepIndex: 0,
        documentId: 'forged',
        expectedRevision: 99
      }).success
    ).toBe(false)
    const selection = {
      viewing: false,
      runId: null,
      stepIndex: null,
      frameCount: 0,
      documentId: 'molecule-1',
      revision: 2,
      frame: null,
      extensions: {}
    }
    expect(frameOutput.parse(selection)).toEqual(selection)
    expect(frameOutput.safeParse({ ...selection, positions: [[0, 0, 0]] }).success).toBe(false)
  })
  it('accepts valid snapshot and perform-action inputs', () => {
    expect(snapshotRoute.input.parse({ sessionId: 'session-1' })).toEqual({ sessionId: 'session-1' })
    expect(performActionRoute.input.parse({ sessionId: 'session-1', actionId: 'action-1' })).toEqual({
      sessionId: 'session-1',
      actionId: 'action-1'
    })
  })

  it('accepts a canonical StudioControlSnapshot output', () => {
    expect(snapshotRoute.output.parse(validSnapshot)).toEqual(validSnapshot)
    expect(
      performActionRoute.output.parse({
        ...validSnapshot,
        molecule: { documentId: 'molecule-1', revision: 2 },
        optimization: validRunningOptimization
      })
    ).toBeDefined()
  })

  it('accepts public agent workflow state and rejects private or unknown phases', () => {
    expect(snapshotRoute.output.safeParse({ ...validSnapshot, agent: validAgentState }).success).toBe(true)
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        agent: { ...validAgentState, phase: 'revealing_private_reasoning' }
      }).success
    ).toBe(false)
  })

  it.each([
    ['decision', 'allow_once'],
    ['previewId', 'preview-1'],
    ['expectedRevision', 3],
    ['runId', 'run-1'],
    ['argumentsJson', '{}'],
    ['payloadJson', '{}'],
    ['coordinates', [0, 0, 0]]
  ])('rejects rather than strips the extra %s field', (field, value) => {
    const result = performActionRoute.input.safeParse({
      sessionId: 'session-1',
      actionId: 'action-1',
      [field]: value
    })

    expect(result.success).toBe(false)
  })

  it('rejects invalid session and action identifiers', () => {
    expect(snapshotRoute.input.safeParse({ sessionId: 'contains spaces' }).success).toBe(false)
    expect(performActionRoute.input.safeParse({ sessionId: 'session-1', actionId: '../action' }).success).toBe(false)
  })

  it('rejects invalid or embellished snapshot outputs', () => {
    expect(snapshotRoute.output.safeParse({ ...validSnapshot, snapshotRevision: -1 }).success).toBe(false)
    expect(snapshotRoute.output.safeParse({ ...validSnapshot, payloadJson: '{}' }).success).toBe(false)
    expect(snapshotRoute.output.safeParse({ ...validSnapshot, extensions: undefined }).success).toBe(false)
  })

  it('requires final geometry exactly while its decision is pending', () => {
    const awaitingRun = { ...validRun, status: 'awaiting_final_geometry' }
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        optimization: { ...validRunningOptimization, run: awaitingRun, cancelActionId: undefined, finalGeometry: null }
      }).success
    ).toBe(false)
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        optimization: { ...validRunningOptimization, finalGeometry: validFinalGeometry }
      }).success
    ).toBe(false)
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        optimization: {
          ...validRunningOptimization,
          run: awaitingRun,
          cancelActionId: undefined,
          finalGeometry: validFinalGeometry
        }
      }).success
    ).toBe(true)
  })

  it('allows a cancel action only for a running optimization', () => {
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        optimization: {
          ...validRunningOptimization,
          run: { ...validRun, status: 'awaiting_final_geometry' },
          finalGeometry: validFinalGeometry
        }
      }).success
    ).toBe(false)
  })

  it('requires latest-frame presence to agree with the frame count', () => {
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        optimization: { ...validRunningOptimization, frameCount: 0 }
      }).success
    ).toBe(false)
    expect(
      snapshotRoute.output.safeParse({
        ...validSnapshot,
        optimization: { ...validRunningOptimization, latestFrame: null }
      }).success
    ).toBe(false)
  })
})
