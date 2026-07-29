import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'

import { OwnedProcessTree } from './OwnedProcessTree'

const MAX_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const SAFE_ENVIRONMENT_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'] as const

export type BoundedProcessFailureReason =
  | 'aborted'
  | 'descendant_leak'
  | 'invalid_options'
  | 'runtime_changed'
  | 'spawn_failed'
  | 'stderr_limit'
  | 'stdout_limit'
  | 'timeout'

export class BoundedProcessError extends Error {
  constructor(
    public readonly reason: BoundedProcessFailureReason,
    message: string,
    public readonly evidence?: {
      stdout: string
      stderr: string
      durationMs: number
    }
  ) {
    super(message)
    this.name = 'BoundedProcessError'
  }
}

export interface BoundedProcessOptions {
  name: string
  command: string
  args: string[]
  cwd: string
  environment?: NodeJS.ProcessEnv
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  gracefulShutdownMs?: number
  forcedShutdownMs?: number
  signal?: AbortSignal
}

export interface BoundedProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface VerifiedLocalRuntime {
  readonly executablePath: string
  assertUnchanged(): Promise<void>
}

export interface BoundedLocalProcessRunOptions {
  args: string[]
  cwd: string
  environment?: NodeJS.ProcessEnv
  timeoutMs: number
  gracefulShutdownMs?: number
  forcedShutdownMs?: number
  signal?: AbortSignal
}

interface ProcessExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

function safeEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return { ...environment, ...overrides }
}

function validateOptions(options: BoundedProcessOptions): void {
  const gracefulShutdownMs = options.gracefulShutdownMs ?? 5_000
  const forcedShutdownMs = options.forcedShutdownMs ?? 5_000
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.name) &&
    path.isAbsolute(options.command) &&
    path.isAbsolute(options.cwd) &&
    Number.isInteger(options.timeoutMs) &&
    options.timeoutMs >= 1 &&
    options.timeoutMs <= MAX_TIMEOUT_MS &&
    Number.isInteger(options.maxStdoutBytes) &&
    options.maxStdoutBytes >= 0 &&
    options.maxStdoutBytes <= MAX_OUTPUT_BYTES &&
    Number.isInteger(options.maxStderrBytes) &&
    options.maxStderrBytes >= 0 &&
    options.maxStderrBytes <= MAX_OUTPUT_BYTES &&
    Number.isInteger(gracefulShutdownMs) &&
    gracefulShutdownMs >= 0 &&
    gracefulShutdownMs <= 10_000 &&
    Number.isInteger(forcedShutdownMs) &&
    forcedShutdownMs >= 1 &&
    forcedShutdownMs <= 10_000
  if (!valid) {
    throw new BoundedProcessError('invalid_options', `${options.name || 'unnamed'} process options are invalid`)
  }
}

function collectOutput(
  child: ChildProcess,
  stream: 'stdout' | 'stderr',
  limit: number,
  fail: (error: BoundedProcessError) => void
): { chunks: Buffer[]; dispose: () => void } {
  const chunks: Buffer[] = []
  let size = 0
  const source = child[stream]
  const onData = (chunk: Buffer) => {
    size += chunk.byteLength
    if (size > limit) {
      fail(new BoundedProcessError(`${stream}_limit`, `${stream} exceeded its byte limit`))
      return
    }
    chunks.push(chunk)
  }
  source?.on('data', onData)
  return {
    chunks,
    dispose: () => source?.off('data', onData)
  }
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  validateOptions(options)
  if (options.signal?.aborted) {
    throw new BoundedProcessError('aborted', `${options.name} process was cancelled`)
  }

  const gracefulShutdownMs = options.gracefulShutdownMs ?? 5_000
  const forcedShutdownMs = options.forcedShutdownMs ?? 5_000
  const startedAt = Date.now()
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: safeEnvironment(options.environment),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const processTree = new OwnedProcessTree(child, options.name)

  let rejectControl: (error: BoundedProcessError) => void = () => {}
  let controlSettled = false
  const control = new Promise<never>((_resolve, reject) => {
    rejectControl = reject
  })
  const fail = (error: BoundedProcessError) => {
    if (controlSettled) return
    controlSettled = true
    rejectControl(error)
  }
  const stdout = collectOutput(child, 'stdout', options.maxStdoutBytes, fail)
  const stderr = collectOutput(child, 'stderr', options.maxStderrBytes, fail)

  const completion = new Promise<ProcessExit>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  const timeout = setTimeout(
    () => fail(new BoundedProcessError('timeout', `${options.name} process exceeded its time limit`)),
    options.timeoutMs
  )
  timeout.unref()
  const onAbort = () => fail(new BoundedProcessError('aborted', `${options.name} process was cancelled`))
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let exit: ProcessExit
    try {
      exit = await Promise.race([completion, control])
    } catch (error) {
      await processTree.terminate(gracefulShutdownMs, forcedShutdownMs)
      await completion.catch(() => {})
      if (error instanceof BoundedProcessError) {
        throw new BoundedProcessError(error.reason, error.message, {
          stdout: Buffer.concat(stdout.chunks).toString('utf8'),
          stderr: Buffer.concat(stderr.chunks).toString('utf8'),
          durationMs: Date.now() - startedAt
        })
      }
      throw new BoundedProcessError('spawn_failed', `${options.name} process could not be started`)
    }

    if (processTree.isAlive()) {
      await processTree.terminate(gracefulShutdownMs, forcedShutdownMs)
      throw new BoundedProcessError(
        'descendant_leak',
        `${options.name} left an owned descendant after its leader exited`
      )
    }
    return {
      ...exit,
      stdout: Buffer.concat(stdout.chunks).toString('utf8'),
      stderr: Buffer.concat(stderr.chunks).toString('utf8'),
      durationMs: Date.now() - startedAt
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
    stdout.dispose()
    stderr.dispose()
  }
}

export class BoundedLocalProcessAdapter {
  constructor(
    private readonly runtime: VerifiedLocalRuntime,
    private readonly name: string,
    private readonly maxStdoutBytes: number,
    private readonly maxStderrBytes: number
  ) {}

  async run(options: BoundedLocalProcessRunOptions): Promise<BoundedProcessResult> {
    try {
      await this.runtime.assertUnchanged()
    } catch {
      throw new BoundedProcessError('runtime_changed', `${this.name} runtime identity changed before execution`)
    }

    let result: BoundedProcessResult | undefined
    let processError: unknown
    let processFailed = false
    try {
      result = await runBoundedProcess({
        ...options,
        name: this.name,
        command: this.runtime.executablePath,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes
      })
    } catch (error) {
      processFailed = true
      processError = error
    }

    try {
      await this.runtime.assertUnchanged()
    } catch {
      throw new BoundedProcessError('runtime_changed', `${this.name} runtime identity changed during execution`)
    }
    if (processFailed) throw processError
    return result!
  }
}
