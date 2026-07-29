import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'

import type {
  ControlledCalculationExecutableIdentity,
  ControlledCalculationExternalFrame,
  ControlledCalculationReservation,
  ControlledCalculationTerminal,
  MoleculeDocument,
  PreparedControlledCalculation
} from '@chemsmart/studio-protocol'

import { BoundedLocalProcessAdapter, BoundedProcessError, type VerifiedLocalRuntime } from './BoundedProcess'
import type { CalculationExecutionAdapter } from './CalculationRuntimeService'
import {
  atomicNumberForElementSymbol,
  canonicalJson,
  digestJson,
  elementSymbolForAtomicNumber,
  moleculeGeometryHash,
  preparedPlanDigestPayload
} from './ControlledCalculationIdentity'

const MAX_TRAJECTORY_BYTES = 32 * 1024 * 1024
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const GFN2_PARAMETER_FILE = 'param_gfn2-xtb.txt'
const SUPPORTED_SOLVENTS = new Set([
  'acetone',
  'acetonitrile',
  'aniline',
  'benzaldehyde',
  'benzene',
  'ch2cl2',
  'chcl3',
  'cs2',
  'dioxane',
  'dmf',
  'dmso',
  'ether',
  'ethylacetate',
  'furane',
  'hexandecane',
  'hexane',
  'methanol',
  'nitromethane',
  'octanol',
  'phenol',
  'thf',
  'toluene',
  'water',
  'woctanol'
])
const OPTIMIZATION_LEVELS = new Map<number, string>([
  [0.01, 'crude'],
  [0.006, 'sloppy'],
  [0.004, 'loose'],
  [0.002, 'lax'],
  [0.001, 'normal'],
  [0.0008, 'tight'],
  [0.0002, 'vtight'],
  [0.00005, 'extreme']
])

export interface XtbExecutionRuntime extends VerifiedLocalRuntime {
  readonly parameterDirectory: string
  readonly identity: ControlledCalculationExecutableIdentity
}

export interface XtbArtifactSource {
  key: 'input' | 'stdout' | 'stderr' | 'trajectory' | 'optimized_geometry'
  kind: 'input' | 'output' | 'log' | 'trajectory'
  displayName: string
  mediaType: string
  filePath: string
}

interface XtbCalculationAdapterOptions {
  calculationsRoot: string
  document: MoleculeDocument
  plan: PreparedControlledCalculation
  reservation: ControlledCalculationReservation
  runtime: XtbExecutionRuntime
  signal?: AbortSignal
  pollIntervalMs?: number
  gracefulShutdownMs?: number
  forcedShutdownMs?: number
  now?: () => string
}

interface ParsedTrajectoryFrame {
  atomicNumbers: number[]
  positions: [number, number, number][]
  energy: number
  gradientNorm: number
}

interface ProcessOutcome {
  result?: {
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }
  error?: unknown
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function finiteNumber(value: string): number {
  const parsed = Number(value.replace(/[dD]/g, 'e'))
  if (!Number.isFinite(parsed)) throw new Error('xTB output contains a non-finite numeric value')
  return parsed === 0 ? 0 : parsed
}

function parseCoordinateRow(row: string): { atomicNumber: number; position: [number, number, number] } {
  const fields = row.trim().split(/\s+/)
  if (fields.length !== 4) throw new Error('xTB output contains a malformed coordinate row')
  return {
    atomicNumber: atomicNumberForElementSymbol(fields[0]),
    position: [finiteNumber(fields[1]), finiteNumber(fields[2]), finiteNumber(fields[3])]
  }
}

function parseTrajectory(text: string, expectedAtomCount: number, allowIncomplete: boolean): ParsedTrajectoryFrame[] {
  const lines = text.split(/\r?\n/)
  const completeFinalLine = text.endsWith('\n') || text.endsWith('\r')
  const frames: ParsedTrajectoryFrame[] = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1
      continue
    }
    const frameStart = index
    const atomCount = Number(lines[index].trim())
    if (!Number.isInteger(atomCount) || atomCount !== expectedAtomCount) {
      if (allowIncomplete) break
      throw new Error('xTB trajectory atom count changed')
    }
    const frameEnd = frameStart + atomCount + 2
    if (frameEnd > lines.length || (frameEnd === lines.length && !completeFinalLine)) {
      if (allowIncomplete) break
      throw new Error('xTB trajectory ended with an incomplete frame')
    }
    const energyMatch = lines[frameStart + 1].match(/\benergy:\s*(\S+)/i)
    const gradientNormMatch = lines[frameStart + 1].match(/\bgnorm:\s*(\S+)/i)
    if (!energyMatch || !gradientNormMatch) {
      if (allowIncomplete) break
      throw new Error('xTB trajectory frame is missing scientific metrics')
    }
    const atomicNumbers: number[] = []
    const positions: [number, number, number][] = []
    try {
      for (const row of lines.slice(frameStart + 2, frameEnd)) {
        const parsed = parseCoordinateRow(row)
        atomicNumbers.push(parsed.atomicNumber)
        positions.push(parsed.position)
      }
    } catch (error) {
      if (allowIncomplete) break
      throw error
    }
    let energy: number
    let gradientNorm: number
    try {
      energy = finiteNumber(energyMatch[1])
      gradientNorm = finiteNumber(gradientNormMatch[1])
      if (gradientNorm < 0) throw new Error('xTB trajectory contains a negative gradient norm')
    } catch (error) {
      if (allowIncomplete) break
      throw error
    }
    frames.push({ atomicNumbers, positions, energy, gradientNorm })
    index = frameEnd
  }
  return frames
}

function parseOptimizedGeometry(
  text: string,
  expectedAtomCount: number
): Pick<ParsedTrajectoryFrame, 'atomicNumbers' | 'positions'> {
  const lines = text.split(/\r?\n/)
  if (Number(lines[0]?.trim()) !== expectedAtomCount || lines.length < expectedAtomCount + 2) {
    throw new Error('xTB optimized geometry is incomplete')
  }
  const atomicNumbers: number[] = []
  const positions: ParsedTrajectoryFrame['positions'] = []
  for (const row of lines.slice(2, expectedAtomCount + 2)) {
    const parsed = parseCoordinateRow(row)
    atomicNumbers.push(parsed.atomicNumber)
    positions.push(parsed.position)
  }
  return { atomicNumbers, positions }
}

async function readBoundedFile(filePath: string, maxBytes: number, allowMissing = false): Promise<Buffer | null> {
  let file
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maxBytes) throw new Error('xTB output file is invalid or oversized')
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const after = await file.stat()
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytesRead !== before.size
    ) {
      if (allowMissing) return null
      throw new Error('xTB output file changed while it was read')
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

async function readUtf8File(filePath: string, maxBytes: number, allowMissing = false): Promise<string | null> {
  const data = await readBoundedFile(filePath, maxBytes, allowMissing)
  if (data === null) return null
  const text = data.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(data)) throw new Error('xTB output is not valid UTF-8')
  return text
}

async function writeOwnedFile(filePath: string, content: string): Promise<void> {
  const file = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await file.chmod(0o600)
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

async function secureExistingFile(filePath: string, allowMissing = false): Promise<boolean> {
  try {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const fileStat = await file.stat()
      if (!fileStat.isFile()) throw new Error('xTB artifact is not a regular file')
      await file.chmod(0o600)
    } finally {
      await file.close()
    }
    return true
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function optimizationLevel(plan: PreparedControlledCalculation): string {
  const threshold = plan.settings.forceThreshold
  if (!threshold) return 'normal'
  if (threshold.unit !== 'hartree/bohr') {
    throw new Error('xTB force threshold must use hartree/bohr')
  }
  const level = OPTIMIZATION_LEVELS.get(threshold.value)
  if (!level) throw new Error('xTB force threshold does not match a supported exact optimization level')
  return level
}

function createArguments(plan: PreparedControlledCalculation): string[] {
  const args = [
    'input.xyz',
    '--gfn',
    '2',
    '--opt',
    optimizationLevel(plan),
    '--cycles',
    String(plan.settings.maxSteps),
    '--chrg',
    String(plan.settings.charge),
    '--uhf',
    String(plan.settings.multiplicity - 1),
    '--parallel',
    '1',
    '--no-restart',
    '--strict'
  ]
  if (plan.settings.solvent) args.push('--alpb', plan.settings.solvent.toLowerCase())
  return args
}

function createInput(document: MoleculeDocument): string {
  const coordinates = document.atoms.map((atom) => {
    const position = atom.position.map((value) => value.toPrecision(17))
    return `${elementSymbolForAtomicNumber(atom.atomicNumber)} ${position.join(' ')}`
  })
  return `${document.atoms.length}\nChemSmart Studio controlled GFN2-xTB input\n${coordinates.join('\n')}\n`
}

export class XtbCalculationAdapter implements CalculationExecutionAdapter {
  readonly kind = 'local' as const
  readonly plan: PreparedControlledCalculation
  readonly reservation: ControlledCalculationReservation

  private readonly calculationsRoot: string
  private readonly document: MoleculeDocument
  private readonly runtime: XtbExecutionRuntime
  private readonly signal?: AbortSignal
  private readonly pollIntervalMs: number
  private readonly gracefulShutdownMs: number
  private readonly forcedShutdownMs: number
  private readonly now: () => string
  private artifactSources: XtbArtifactSource[] = []

  constructor(options: XtbCalculationAdapterOptions) {
    this.calculationsRoot = options.calculationsRoot
    this.document = structuredClone(options.document)
    this.plan = structuredClone(options.plan)
    this.reservation = structuredClone(options.reservation)
    this.runtime = options.runtime
    this.signal = options.signal
    this.pollIntervalMs = options.pollIntervalMs ?? 50
    this.gracefulShutdownMs = options.gracefulShutdownMs ?? 5_000
    this.forcedShutdownMs = options.forcedShutdownMs ?? 5_000
    this.now = options.now ?? (() => new Date().toISOString())
  }

  getArtifactSources(): XtbArtifactSource[] {
    return this.artifactSources.map((source) => ({ ...source }))
  }

  async *execute(
    reservation: ControlledCalculationReservation
  ): AsyncIterable<ControlledCalculationExternalFrame | ControlledCalculationTerminal> {
    this.validate(reservation)
    const root = await realpath(this.calculationsRoot)
    const runDirectory = await realpath(path.join(root, reservation.runId))
    if (!isWithinRoot(root, runDirectory)) throw new Error('xTB run directory escaped the calculation root')
    const engineDirectory = path.join(runDirectory, 'engine')
    await mkdir(engineDirectory, { mode: 0o700 })
    await chmod(engineDirectory, 0o700)

    const inputPath = path.join(engineDirectory, 'input.xyz')
    const stdoutPath = path.join(engineDirectory, 'stdout.log')
    const stderrPath = path.join(engineDirectory, 'stderr.log')
    const trajectoryPath = path.join(engineDirectory, 'xtbopt.log')
    const optimizedGeometryPath = path.join(engineDirectory, 'xtbopt.xyz')
    await writeOwnedFile(inputPath, createInput(this.document))

    const localAbort = new AbortController()
    const onAbort = () => localAbort.abort()
    this.signal?.addEventListener('abort', onAbort, { once: true })
    if (this.signal?.aborted) localAbort.abort()
    const processAdapter = new BoundedLocalProcessAdapter(
      this.runtime,
      'xtb-controlled-optimization',
      OUTPUT_LIMIT_BYTES,
      OUTPUT_LIMIT_BYTES
    )
    let settled = false
    let outcome: ProcessOutcome = {}
    const running = processAdapter
      .run({
        args: createArguments(this.plan),
        cwd: engineDirectory,
        environment: {
          XTBPATH: this.runtime.parameterDirectory,
          OMP_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          VECLIB_MAXIMUM_THREADS: '1'
        },
        timeoutMs: this.plan.settings.maxRuntimeSeconds * 1000,
        gracefulShutdownMs: this.gracefulShutdownMs,
        forcedShutdownMs: this.forcedShutdownMs,
        signal: localAbort.signal
      })
      .then(
        (result) => {
          outcome = { result }
          settled = true
        },
        (error) => {
          outcome = { error }
          settled = true
        }
      )

    const observed: ParsedTrajectoryFrame[] = []
    let outputError: Error | null = null
    try {
      while (!settled) {
        try {
          const available = await this.readFrames(trajectoryPath, true)
          if (available) {
            for (const frame of this.newFrames(observed, available)) {
              observed.push(frame)
              yield this.toExternalFrame(frame, observed.length - 1)
            }
          }
        } catch (error) {
          outputError = error instanceof Error ? error : new Error('xTB trajectory validation failed')
          localAbort.abort()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      }
      await running

      const stdout =
        outcome.result?.stdout ??
        (outcome.error instanceof BoundedProcessError ? outcome.error.evidence?.stdout : undefined) ??
        ''
      const stderr =
        outcome.result?.stderr ??
        (outcome.error instanceof BoundedProcessError ? outcome.error.evidence?.stderr : undefined) ??
        ''
      await writeOwnedFile(stdoutPath, stdout)
      await writeOwnedFile(stderrPath, stderr)

      if (!outputError) {
        try {
          const available = await this.readFrames(trajectoryPath, outcome.error !== undefined)
          if (available) {
            for (const frame of this.newFrames(observed, available)) {
              observed.push(frame)
              yield this.toExternalFrame(frame, observed.length - 1)
            }
          }
        } catch (error) {
          outputError = error instanceof Error ? error : new Error('xTB trajectory validation failed')
        }
      }

      await this.captureArtifacts({
        inputPath,
        stdoutPath,
        stderrPath,
        trajectoryPath,
        optimizedGeometryPath
      })

      if (this.signal?.aborted) {
        yield this.cancelledTerminal(observed.length)
        return
      }
      if (outputError) {
        yield this.failedTerminal('XTB_OUTPUT_INVALID', 'xTB output failed strict frame validation', observed.length)
        return
      }
      if (outcome.error) {
        const code =
          outcome.error instanceof BoundedProcessError
            ? ({
                timeout: 'XTB_TIMEOUT',
                runtime_changed: 'XTB_RUNTIME_CHANGED',
                stdout_limit: 'XTB_OUTPUT_LIMIT',
                stderr_limit: 'XTB_OUTPUT_LIMIT',
                descendant_leak: 'XTB_PROCESS_LEAK'
              }[outcome.error.reason] ?? 'XTB_PROCESS_FAILED')
            : 'XTB_PROCESS_FAILED'
        yield this.failedTerminal(code, 'xTB process did not complete successfully', observed.length)
        return
      }
      if (outcome.result?.exitCode !== 0 || outcome.result.signal !== null) {
        yield this.failedTerminal('XTB_PROCESS_FAILED', 'xTB process returned a nonzero result', observed.length)
        return
      }
      const lowered = outcome.result.stdout.toLowerCase()
      const notConverged = await lstat(path.join(engineDirectory, 'NOT_CONVERGED')).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      )
      if (
        notConverged ||
        !lowered.includes('geometry optimization converged') ||
        !lowered.includes('finished run') ||
        !(await secureExistingFile(path.join(engineDirectory, '.xtboptok'), true))
      ) {
        yield this.failedTerminal(
          'XTB_NOT_CONVERGED',
          'xTB did not provide complete convergence proof',
          observed.length
        )
        return
      }
      if (observed.length < 1) {
        yield this.failedTerminal('XTB_OUTPUT_INVALID', 'xTB produced no complete optimization frame', 0)
        return
      }
      const optimizedText = await readUtf8File(optimizedGeometryPath, MAX_TRAJECTORY_BYTES)
      const optimizedGeometry = parseOptimizedGeometry(optimizedText!, this.document.atoms.length)
      if (
        canonicalJson(optimizedGeometry.atomicNumbers) !==
          canonicalJson(this.document.atoms.map((atom) => atom.atomicNumber)) ||
        canonicalJson(optimizedGeometry.positions) !== canonicalJson(observed.at(-1)!.positions)
      ) {
        yield this.failedTerminal(
          'XTB_OUTPUT_INVALID',
          'xTB optimized geometry identity disagrees with its final trajectory frame',
          observed.length
        )
        return
      }
      const outputGeometryHash = moleculeGeometryHash({
        ...this.document,
        atoms: this.document.atoms.map((atom, index) => ({
          ...atom,
          position: optimizedGeometry.positions[index]
        }))
      })
      yield {
        type: 'controlled_calculation_terminal',
        runId: reservation.runId,
        status: 'completed',
        frameCount: observed.length,
        outputGeometryHash,
        completedAt: this.now(),
        extensions: {}
      }
    } finally {
      this.signal?.removeEventListener('abort', onAbort)
      if (!settled) {
        localAbort.abort()
        await running
      }
    }
  }

  private validate(reservation: ControlledCalculationReservation): void {
    if (
      canonicalJson(reservation) !== canonicalJson(this.reservation) ||
      canonicalJson(this.reservation.binding) !== canonicalJson(this.plan.binding) ||
      canonicalJson(this.reservation.executable) !== canonicalJson(this.plan.executable) ||
      canonicalJson(this.plan.executable) !== canonicalJson(this.runtime.identity)
    ) {
      throw new Error('xTB execution identity is inconsistent')
    }
    if (
      this.plan.state !== 'validated' ||
      this.plan.engine !== 'xtb' ||
      this.plan.method !== 'GFN2-xTB' ||
      this.plan.planDigest !== this.reservation.planDigest ||
      this.plan.settingsDigest !== digestJson(this.plan.settings) ||
      this.plan.planDigest !== digestJson(preparedPlanDigestPayload(this.plan))
    ) {
      throw new Error('xTB plan is not an exact validated GFN2 plan')
    }
    if (
      this.document.documentId !== this.plan.binding.documentId ||
      this.document.revision !== this.plan.binding.expectedRevision ||
      moleculeGeometryHash(this.document) !== this.plan.binding.geometryHash
    ) {
      throw new Error('xTB plan no longer matches the committed molecule')
    }
    const charge = this.document.properties.charge ?? 0
    const multiplicity = this.document.properties.multiplicity ?? 1
    if (this.plan.settings.charge !== charge || this.plan.settings.multiplicity !== multiplicity) {
      throw new Error('xTB charge and multiplicity differ from the committed molecule')
    }
    if (this.plan.settings.threads !== 1) throw new Error('xTB execution requires exactly one thread')
    if (this.plan.settings.solvent && !SUPPORTED_SOLVENTS.has(this.plan.settings.solvent.toLowerCase())) {
      throw new Error('xTB solvent is not supported by the controlled GFN2 profile')
    }
    optimizationLevel(this.plan)
    if (!this.runtime.identity.resources?.some(({ name }) => name === GFN2_PARAMETER_FILE)) {
      throw new Error('xTB GFN2 parameter identity is missing')
    }
    if (Date.parse(this.plan.expiresAt) <= Date.parse(this.now())) throw new Error('xTB plan expired before execution')
  }

  private async readFrames(filePath: string, allowIncomplete: boolean): Promise<ParsedTrajectoryFrame[] | null> {
    const text = await readUtf8File(filePath, MAX_TRAJECTORY_BYTES, allowIncomplete)
    if (text === null) return null
    return parseTrajectory(text, this.document.atoms.length, allowIncomplete)
  }

  private newFrames(observed: ParsedTrajectoryFrame[], available: ParsedTrajectoryFrame[]): ParsedTrajectoryFrame[] {
    if (available.length > this.plan.settings.maxSteps || available.length < observed.length) {
      throw new Error('xTB trajectory frame count violates the controlled plan')
    }
    for (let index = 0; index < observed.length; index += 1) {
      if (canonicalJson(observed[index]) !== canonicalJson(available[index])) {
        throw new Error('xTB rewrote an already exposed trajectory frame')
      }
    }
    const expectedNumbers = this.document.atoms.map((atom) => atom.atomicNumber)
    for (const frame of available) {
      if (canonicalJson(frame.atomicNumbers) !== canonicalJson(expectedNumbers)) {
        throw new Error('xTB trajectory element order changed')
      }
    }
    return available.slice(observed.length)
  }

  private toExternalFrame(frame: ParsedTrajectoryFrame, index: number): ControlledCalculationExternalFrame {
    const structureHash = moleculeGeometryHash({
      ...this.document,
      atoms: this.document.atoms.map((atom, atomIndex) => ({ ...atom, position: frame.positions[atomIndex] }))
    })
    return {
      type: 'controlled_calculation_frame',
      runId: this.reservation.runId,
      frameIndex: index,
      engineStepIndex: index,
      atomIds: this.document.atoms.map((atom) => atom.id),
      atomicNumbers: [...frame.atomicNumbers],
      positions: frame.positions.map((position) => [...position]),
      coordinateUnit: 'angstrom',
      provenance: {
        coordinateSource: 'engine',
        atomOrder: 'document_stable_id_order',
        transformation: 'none'
      },
      energy: { value: frame.energy, unit: 'hartree' },
      gradientNorm: { value: frame.gradientNorm, unit: 'hartree/bohr' },
      structureHash,
      timestamp: this.now(),
      extensions: {}
    }
  }

  private failedTerminal(code: string, message: string, frameCount: number): ControlledCalculationTerminal {
    return {
      type: 'controlled_calculation_terminal',
      runId: this.reservation.runId,
      status: 'failed',
      frameCount,
      error: { code, message },
      terminatedAt: this.now(),
      extensions: {}
    }
  }

  private cancelledTerminal(frameCount: number): ControlledCalculationTerminal {
    return {
      type: 'controlled_calculation_terminal',
      runId: this.reservation.runId,
      status: 'cancelled',
      frameCount,
      reason: 'Controlled xTB execution was cancelled',
      terminatedAt: this.now(),
      extensions: {}
    }
  }

  private async captureArtifacts(paths: {
    inputPath: string
    stdoutPath: string
    stderrPath: string
    trajectoryPath: string
    optimizedGeometryPath: string
  }): Promise<void> {
    const sources: XtbArtifactSource[] = [
      {
        key: 'input',
        kind: 'input',
        displayName: 'GFN2-xTB input',
        mediaType: 'chemical/x-xyz',
        filePath: paths.inputPath
      },
      {
        key: 'stdout',
        kind: 'log',
        displayName: 'xTB standard output',
        mediaType: 'text/plain',
        filePath: paths.stdoutPath
      },
      {
        key: 'stderr',
        kind: 'log',
        displayName: 'xTB standard error',
        mediaType: 'text/plain',
        filePath: paths.stderrPath
      }
    ]
    if (await secureExistingFile(paths.trajectoryPath, true)) {
      sources.push({
        key: 'trajectory',
        kind: 'trajectory',
        displayName: 'xTB optimization trajectory',
        mediaType: 'chemical/x-xyz',
        filePath: paths.trajectoryPath
      })
    }
    if (await secureExistingFile(paths.optimizedGeometryPath, true)) {
      sources.push({
        key: 'optimized_geometry',
        kind: 'output',
        displayName: 'xTB optimized geometry',
        mediaType: 'chemical/x-xyz',
        filePath: paths.optimizedGeometryPath
      })
    }
    this.artifactSources = sources
  }
}
