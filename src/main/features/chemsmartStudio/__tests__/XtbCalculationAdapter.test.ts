import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ControlledCalculationExecutableIdentity,
  ControlledCalculationExternalFrame,
  ControlledCalculationReservation,
  ControlledCalculationTerminal,
  MoleculeDocument,
  PreparedControlledCalculation
} from '@chemsmart/studio-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { digestJson, moleculeGeometryHash, preparedPlanDigestPayload } from '../ControlledCalculationIdentity'
import { XtbCalculationAdapter, type XtbExecutionRuntime } from '../XtbCalculationAdapter'

const timestamp = '2026-07-23T13:30:00.000Z'
const fixturePath = fileURLToPath(new URL('./fixtures/xtbProcessFixture.cjs', import.meta.url))
const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
type CalculationEvent = ControlledCalculationExternalFrame | ControlledCalculationTerminal
const document: MoleculeDocument = {
  documentId: 'water-fixture',
  revision: 3,
  atoms: [
    { id: 'atom-o1', atomicNumber: 8, position: [0, 0, -0.3893611], formalCharge: 0, extensions: {} },
    { id: 'atom-h1', atomicNumber: 1, position: [0.7629844, 0, 0.1946806], formalCharge: 0, extensions: {} },
    { id: 'atom-h2', atomicNumber: 1, position: [-0.7629844, 0, 0.1946806], formalCharge: 0, extensions: {} }
  ],
  bonds: [
    { id: 'bond-oh1', atomIds: ['atom-o1', 'atom-h1'], order: 1, extensions: {} },
    { id: 'bond-oh2', atomIds: ['atom-o1', 'atom-h2'], order: 1, extensions: {} }
  ],
  selections: [],
  frozenAxes: {},
  constraints: [],
  properties: { charge: 0, multiplicity: 1, extensions: {} },
  extensions: {}
}
const executable: ControlledCalculationExecutableIdentity = {
  kind: 'local_executable',
  engine: 'xtb',
  version: '6.7.1',
  architecture: 'arm64',
  executableDigest: digestA,
  runtimeFingerprint: digestB,
  libraries: [],
  resources: [{ name: 'param_gfn2-xtb.txt', digest: digestC }],
  verifiedAt: timestamp
}
const plan: PreparedControlledCalculation = {
  type: 'prepared_controlled_calculation',
  planId: 'plan-water-1',
  binding: {
    sessionId: 'session-1',
    documentId: document.documentId,
    expectedRevision: document.revision,
    geometryHash: 'sha256:placeholder'
  },
  engine: 'xtb',
  method: 'GFN2-xTB',
  settings: {
    maxSteps: 20,
    maxRuntimeSeconds: 2,
    threads: 1,
    charge: 0,
    multiplicity: 1,
    extensions: {}
  },
  settingsDigest: digestA,
  planDigest: digestB,
  executable,
  state: 'validated',
  createdAt: timestamp,
  expiresAt: '2026-07-23T13:35:00.000Z',
  extensions: {}
}
const reservation: ControlledCalculationReservation = {
  type: 'controlled_calculation_reservation',
  runId: 'run-water-1',
  planId: plan.planId,
  planDigest: plan.planDigest,
  binding: plan.binding,
  executable,
  reservedAt: timestamp,
  extensions: {}
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe('XtbCalculationAdapter', () => {
  const roots: string[] = []
  const fallbackPids: number[] = []

  async function createAdapter(mode = 'success', signal?: AbortSignal) {
    const calculationsRoot = await mkdtemp(path.join(tmpdir(), 'chemsmart-xtb-adapter-'))
    roots.push(calculationsRoot)
    const runDirectory = path.join(calculationsRoot, reservation.runId)
    const parameterDirectory = path.join(calculationsRoot, 'runtime-parameters')
    await mkdir(runDirectory, { mode: 0o700 })
    await mkdir(parameterDirectory, { mode: 0o700 })
    await writeFile(path.join(parameterDirectory, 'param_gfn2-xtb.txt'), 'fixture parameters', { mode: 0o600 })
    await writeFile(path.join(runDirectory, 'fixture-mode'), `${mode}\n`, { mode: 0o600 })
    await chmod(fixturePath, 0o755)
    const runtime: XtbExecutionRuntime = {
      executablePath: fixturePath,
      parameterDirectory,
      identity: executable,
      assertUnchanged: vi.fn().mockResolvedValue(undefined)
    }
    const settings = structuredClone(plan.settings)
    const binding = {
      ...plan.binding,
      geometryHash: moleculeGeometryHash(document)
    }
    const planWithoutDigest: Omit<PreparedControlledCalculation, 'planDigest' | 'state'> = {
      type: plan.type,
      planId: plan.planId,
      binding,
      engine: plan.engine,
      method: plan.method,
      settings,
      settingsDigest: digestJson(settings),
      executable,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      extensions: {}
    }
    const exactPlan: PreparedControlledCalculation = {
      ...planWithoutDigest,
      planDigest: digestJson(preparedPlanDigestPayload(planWithoutDigest)),
      state: 'validated'
    }
    const exactReservation: ControlledCalculationReservation = {
      ...reservation,
      planDigest: exactPlan.planDigest,
      binding,
      executable
    }
    return {
      adapter: new XtbCalculationAdapter({
        calculationsRoot,
        document,
        plan: exactPlan,
        reservation: exactReservation,
        runtime,
        signal,
        pollIntervalMs: 5,
        gracefulShutdownMs: 50,
        forcedShutdownMs: 2_000,
        now: () => timestamp
      }),
      calculationsRoot,
      runDirectory,
      runtime
    }
  }

  afterEach(async () => {
    for (const pid of fallbackPids.splice(0)) {
      if (isPidAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('streams only complete source-ordered frames and captures bounded opaque artifact sources', async () => {
    const { adapter, runDirectory, runtime } = await createAdapter()
    const events: CalculationEvent[] = []
    let observedBeforeProcessCompletion = false

    for await (const event of adapter.execute(adapter.reservation)) {
      events.push(event)
      if (event.type === 'controlled_calculation_frame' && event.frameIndex === 0) {
        observedBeforeProcessCompletion = await access(path.join(runDirectory, 'engine', '.xtboptok')).then(
          () => false,
          () => true
        )
      }
    }

    expect(observedBeforeProcessCompletion).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'controlled_calculation_frame',
      'controlled_calculation_frame',
      'controlled_calculation_terminal'
    ])
    expect(events.at(-1)).toMatchObject({ status: 'completed', frameCount: 2 })
    expect(events.slice(0, 2).map((event) => ('energy' in event ? event.energy?.value : null))).toEqual([
      -5.07045135456, -5.070544443465
    ])
    expect(events.slice(0, 2).map((event) => ('gradientNorm' in event ? event.gradientNorm?.value : null))).toEqual([
      0.006457564538, 0.000075549242
    ])
    expect(
      events
        .filter((event): event is ControlledCalculationExternalFrame => event.type === 'controlled_calculation_frame')
        .flatMap((event) => event.positions.flat())
        .some((coordinate) => Object.is(coordinate, -0))
    ).toBe(false)
    expect(events.slice(0, 2)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ forceMetrics: expect.anything() })])
    )
    expect(JSON.stringify(events)).not.toContain(runDirectory)
    expect(runtime.assertUnchanged).toHaveBeenCalledTimes(2)
    await expect(access(path.join(runDirectory, 'engine', '.xtboptok'))).resolves.toBeUndefined()
    await expect(access(path.join(runDirectory, 'engine', '.xtbok'))).rejects.toMatchObject({ code: 'ENOENT' })

    const args = JSON.parse(await readFile(path.join(runDirectory, 'engine', 'fixture-args.json'), 'utf8'))
    expect(args).toEqual([
      'input.xyz',
      '--gfn',
      '2',
      '--opt',
      'normal',
      '--cycles',
      '20',
      '--chrg',
      '0',
      '--uhf',
      '0',
      '--parallel',
      '1',
      '--no-restart',
      '--strict'
    ])
    expect(await readFile(path.join(runDirectory, 'engine', 'input.xyz'), 'utf8')).toContain(
      'ChemSmart Studio controlled GFN2-xTB input'
    )
    expect(adapter.getArtifactSources().map(({ key }) => key)).toEqual([
      'input',
      'stdout',
      'stderr',
      'trajectory',
      'optimized_geometry'
    ])
    for (const source of adapter.getArtifactSources()) {
      expect((await stat(source.filePath)).mode & 0o777).toBe(0o600)
    }
  })

  it.each(['reordered', 'final-elements-reordered', 'incomplete', 'not-converged'])(
    'fails closed on %s engine output without fabricating a completed result',
    async (mode) => {
      const { adapter } = await createAdapter(mode)
      const events: CalculationEvent[] = []

      for await (const event of adapter.execute(adapter.reservation)) events.push(event)

      expect(events.at(-1)).toMatchObject({ type: 'controlled_calculation_terminal', status: 'failed' })
      expect(events.at(-1)).not.toHaveProperty('outputGeometryHash')
      expect(events.filter((event) => event.type === 'controlled_calculation_frame')).toHaveLength(
        mode === 'incomplete' ? 1 : mode === 'reordered' ? 0 : 2
      )
    }
  )

  it('cancels the exact owned process tree after a streamed frame', async () => {
    const controller = new AbortController()
    const { adapter, runDirectory } = await createAdapter('cancel', controller.signal)
    const events: CalculationEvent[] = []
    const descendantPidPath = path.join(runDirectory, 'engine', 'descendant.pid')

    for await (const event of adapter.execute(adapter.reservation)) {
      events.push(event)
      if (event.type === 'controlled_calculation_frame') {
        await vi.waitFor(() => access(descendantPidPath))
        controller.abort()
      }
    }
    const childPid = Number(await readFile(path.join(runDirectory, 'engine', 'fixture.pid'), 'utf8'))
    const descendantPid = Number(await readFile(descendantPidPath, 'utf8'))
    fallbackPids.push(childPid, descendantPid)

    expect(events.at(-1)).toMatchObject({ status: 'cancelled', frameCount: 1 })
    expect(isPidAlive(childPid)).toBe(false)
    expect(isPidAlive(descendantPid)).toBe(false)
  })

  it('rejects inconsistent chemical settings before creating an engine directory', async () => {
    const { adapter, runDirectory } = await createAdapter()
    adapter.plan.settings.charge = 1

    await expect(async () => {
      for await (const event of adapter.execute(adapter.reservation)) {
        throw new Error(`Invalid plan exposed ${event.type}`)
      }
    }).rejects.toThrow('exact validated GFN2 plan')
    await expect(access(path.join(runDirectory, 'engine'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
