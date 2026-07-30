import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import type { StudioProtocolHello } from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import type { ChemSmartStudioProcessStatus } from '@shared/ipc/schemas/chemsmartStudio'

import { JsonRpcPeer } from './JsonRpcPeer'
import { OwnedProcessTree } from './OwnedProcessTree'

const logger = loggerService.withContext('LocalRpcProcess')
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000
const FORCED_SHUTDOWN_TIMEOUT_MS = 5_000
const SAFE_CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE'
] as const

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

export interface LocalRpcProcessOptions {
  name: string
  command: string
  args: (socketPath: string) => string[]
  cwd: string
  runtimeDirectory: string
  environment?: NodeJS.ProcessEnv
  incomingHandler: (method: string, params: unknown) => Promise<unknown>
  onStateChanged: (status: ChemSmartStudioProcessStatus) => void
  prepareBootstrap?: () => Promise<LocalRpcProcessBootstrap>
  protocolHello?: StudioProtocolHello
}

export interface LocalRpcAuthenticatedContext {
  pid: number
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>
}

/**
 * A process-scoped capability prepared before spawn and disclosed to the helper
 * only after the normal JSON-RPC authentication succeeds.
 */
export interface LocalRpcProcessBootstrap {
  onSpawned: (pid: number) => Promise<void>
  onAuthenticated: (context: LocalRpcAuthenticatedContext) => Promise<void>
  dispose: () => Promise<void>
}

export class LocalRpcProcess {
  private bootstrap: LocalRpcProcessBootstrap | null = null
  private bootstrapDisposePromise: Promise<void> | null = null
  private child: ChildProcess | null = null
  private cleanupPromise: Promise<void> | null = null
  private peer: JsonRpcPeer | null = null
  private socketPath: string | null = null
  private status: ChemSmartStudioProcessStatus = { state: 'stopped', pid: null, lastError: null }

  constructor(private readonly options: LocalRpcProcessOptions) {}

  getStatus(): ChemSmartStudioProcessStatus {
    return this.status
  }

  async start(): Promise<ChemSmartStudioProcessStatus> {
    if (this.cleanupPromise) await this.cleanupPromise
    if (this.status.state === 'running') return this.status
    if (this.status.state === 'starting') throw new Error(`${this.options.name} is already starting`)
    this.setStatus({ state: 'starting', pid: null, lastError: null })
    try {
      await mkdir(this.options.runtimeDirectory, { recursive: true, mode: 0o700 })
      const runtimeStat = await lstat(this.options.runtimeDirectory)
      if (
        !runtimeStat.isDirectory() ||
        runtimeStat.isSymbolicLink() ||
        (typeof process.getuid === 'function' && runtimeStat.uid !== process.getuid())
      ) {
        throw new Error(`${this.options.name} runtime directory is not securely owned`)
      }
      await chmod(this.options.runtimeDirectory, 0o700)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'failed', pid: null, lastError: message })
      throw error
    }
    const suffix = randomBytes(8).toString('hex')
    const socketPath = path.join(this.options.runtimeDirectory, `${this.options.name}-${suffix}.sock`)
    const token = randomBytes(32).toString('base64url')
    this.socketPath = socketPath

    try {
      this.bootstrap = (await this.options.prepareBootstrap?.()) ?? null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.removeSocket(socketPath)
      this.setStatus({ state: 'failed', pid: null, lastError: message })
      throw error
    }

    const child = spawn(this.options.command, this.options.args(socketPath), {
      cwd: this.options.cwd,
      detached: process.platform !== 'win32',
      env: { ...safeChildEnvironment(), ...this.options.environment, CHEMSMART_STUDIO_SESSION_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.once('error', (error) => {
      if (this.child !== child || this.status.state === 'starting' || this.status.state === 'stopping') return
      this.peer?.destroy()
      this.peer = null
      this.setStatus({ state: 'failed', pid: child.pid ?? null, lastError: error.message })
      const cleanup = this.cleanupAfterRuntimeError(child, socketPath, error)
      this.cleanupPromise = cleanup
      void cleanup.then(
        () => {
          if (this.cleanupPromise === cleanup) this.cleanupPromise = null
        },
        () => {
          if (this.cleanupPromise === cleanup && this.hasExited(child)) this.cleanupPromise = null
        }
      )
    })
    child.stdout?.on('data', (data) => logger.debug(`${this.options.name} stdout`, { bytes: data.length }))
    child.stderr?.on('data', (data) => logger.warn(`${this.options.name} stderr`, { bytes: data.length }))
    child.once('exit', (code, signal) => {
      if (this.child !== child) {
        void this.removeSocket(socketPath)
        return
      }
      this.peer?.destroy()
      this.peer = null
      this.child = null
      this.cleanupPromise = null
      const expected = this.status.state === 'stopping'
      if (!expected) {
        this.setStatus({
          state: 'failed',
          pid: child.pid ?? null,
          lastError: `${this.options.name} exited (code=${code}, signal=${signal})`
        })
        const cleanup = this.cleanupAfterRuntimeExit(child, socketPath)
        this.cleanupPromise = cleanup
        void cleanup.then(
          () => {
            if (this.cleanupPromise === cleanup) this.cleanupPromise = null
          },
          () => {
            if (this.cleanupPromise === cleanup && !this.isProcessTreeAlive(child)) this.cleanupPromise = null
          }
        )
        return
      }
      void this.removeSocket(socketPath)
    })

    try {
      if (this.bootstrap) {
        if (!child.pid || child.pid <= 0) throw new Error(`${this.options.name} did not report a valid child PID`)
        await this.bootstrap.onSpawned(child.pid)
      }
      const socket = await this.connect(socketPath, child)
      await chmod(socketPath, 0o600)
      const peer = new JsonRpcPeer(socket, this.options.incomingHandler)
      this.peer = peer
      await peer.request('system.authenticate', { token }, 10_000)
      if (this.options.protocolHello) {
        const hello = await peer.request('system.protocol_hello', {}, 10_000)
        this.assertProtocolHello(hello, this.options.protocolHello)
      }
      if (this.bootstrap) {
        if (!child.pid || child.pid <= 0) throw new Error(`${this.options.name} did not report a valid child PID`)
        await this.bootstrap.onAuthenticated({
          pid: child.pid,
          request: (method, params, timeoutMs) => peer.request(method, params, timeoutMs)
        })
      }
      this.setStatus({ state: 'running', pid: child.pid ?? null, lastError: null })
      return this.status
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.peer?.destroy()
      this.peer = null
      try {
        await this.terminateChild(child)
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        this.setStatus({ state: 'failed', pid: child.pid ?? null, lastError: `${message}; ${cleanupMessage}` })
        throw cleanupError
      }
      if (this.child === child) this.child = null
      await this.removeSocket(socketPath)
      try {
        await this.disposeBootstrap()
      } catch (bootstrapError) {
        const bootstrapMessage = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)
        this.setStatus({ state: 'failed', pid: null, lastError: `${message}; ${bootstrapMessage}` })
        throw bootstrapError
      }
      this.setStatus({ state: 'failed', pid: null, lastError: message })
      throw error
    }
  }

  async stop(): Promise<ChemSmartStudioProcessStatus> {
    const child = this.child
    if (!child) {
      await this.disposeBootstrap()
      this.setStatus({ state: 'stopped', pid: null, lastError: null })
      return this.status
    }
    const socketPath = this.socketPath
    this.setStatus({ state: 'stopping', pid: child.pid ?? null, lastError: null })
    this.peer?.destroy()
    this.peer = null
    try {
      await this.terminateChild(child)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'failed', pid: child.pid ?? null, lastError: message })
      throw error
    }
    if (this.child === child) this.child = null
    await this.removeSocket(socketPath)
    try {
      await this.disposeBootstrap()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'failed', pid: null, lastError: message })
      throw error
    }
    this.setStatus({ state: 'stopped', pid: null, lastError: null })
    return this.status
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.peer || this.status.state !== 'running') throw new Error(`${this.options.name} is unavailable`)
    return this.peer.request(method, params, timeoutMs)
  }

  private assertProtocolHello(actual: unknown, expected: StudioProtocolHello): void {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      throw new Error(`${this.options.name} returned an invalid protocol hello`)
    }
    const candidate = actual as Partial<StudioProtocolHello>
    const keys = Object.keys(actual).sort()
    if (
      keys.length !== 3 ||
      keys[0] !== 'chemSmartCommit' ||
      keys[1] !== 'protocolVersion' ||
      keys[2] !== 'schemaSha256' ||
      candidate.protocolVersion !== expected.protocolVersion ||
      candidate.schemaSha256 !== expected.schemaSha256 ||
      candidate.chemSmartCommit !== expected.chemSmartCommit
    ) {
      throw new Error(`${this.options.name} protocol identity mismatch`)
    }
  }

  private connect(socketPath: string, child: ChildProcess): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      let settled = false
      let retry: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (retry) clearTimeout(retry)
        child.off('error', onChildError)
        child.off('exit', onChildExit)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onChildError = (error: Error) => fail(error)
      const onChildExit = (code: number | null, signal: NodeJS.Signals | null) =>
        fail(new Error(`${this.options.name} exited before opening its socket (code=${code}, signal=${signal})`))

      child.once('error', onChildError)
      child.once('exit', onChildExit)
      const attempt = () => {
        if (settled) return
        if (child.exitCode !== null || child.signalCode !== null) {
          fail(new Error(`${this.options.name} exited before opening its socket`))
          return
        }
        const socket = net.createConnection(socketPath)
        socket.once('connect', () => {
          if (settled) {
            socket.destroy()
            return
          }
          settled = true
          cleanup()
          resolve(socket)
        })
        socket.once('error', () => {
          socket.destroy()
          if (Date.now() - startedAt >= 10_000) fail(new Error(`Timed out connecting to ${this.options.name}`))
          else {
            retry = setTimeout(attempt, 50)
            retry.unref()
          }
        })
      }
      attempt()
    })
  }

  private async cleanupAfterRuntimeError(child: ChildProcess, socketPath: string, error: Error): Promise<void> {
    try {
      await this.terminateChild(child)
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      if (this.child === child) {
        this.setStatus({ state: 'failed', pid: child.pid ?? null, lastError: `${error.message}; ${message}` })
      }
      throw cleanupError
    }
    if (this.child === child) this.child = null
    await this.removeSocket(socketPath)
    try {
      await this.disposeBootstrap()
    } catch (bootstrapError) {
      const message = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)
      this.setStatus({ state: 'failed', pid: null, lastError: `${error.message}; ${message}` })
      throw bootstrapError
    }
    if (this.status.state === 'failed') this.setStatus({ state: 'failed', pid: null, lastError: error.message })
  }

  private async cleanupAfterRuntimeExit(child: ChildProcess, socketPath: string): Promise<void> {
    const lastError = this.status.lastError
    try {
      await this.terminateChild(child)
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      this.setStatus({
        state: 'failed',
        pid: child.pid ?? null,
        lastError: lastError ? `${lastError}; ${message}` : message
      })
      throw cleanupError
    }
    if (this.child === child) this.child = null
    await this.removeSocket(socketPath)
    try {
      await this.disposeBootstrap()
    } catch (bootstrapError) {
      const message = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError)
      this.setStatus({
        state: 'failed',
        pid: null,
        lastError: lastError ? `${lastError}; ${message}` : message
      })
      throw bootstrapError
    }
    if (this.status.state === 'failed') this.setStatus({ state: 'failed', pid: null, lastError })
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    await new OwnedProcessTree(child, this.options.name).terminate(
      GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      FORCED_SHUTDOWN_TIMEOUT_MS
    )
  }

  private hasExited(child: ChildProcess): boolean {
    return child.pid === undefined || child.exitCode !== null || child.signalCode !== null
  }

  private isProcessTreeAlive(child: ChildProcess): boolean {
    return new OwnedProcessTree(child, this.options.name).isAlive()
  }

  private setStatus(status: ChemSmartStudioProcessStatus): void {
    this.status = status
    this.options.onStateChanged(status)
  }

  private async disposeBootstrap(): Promise<void> {
    if (this.bootstrapDisposePromise) return this.bootstrapDisposePromise
    const bootstrap = this.bootstrap
    if (!bootstrap) return
    const disposal = Promise.resolve().then(() => bootstrap.dispose())
    this.bootstrapDisposePromise = disposal
    try {
      await disposal
      if (this.bootstrap === bootstrap) this.bootstrap = null
    } finally {
      if (this.bootstrapDisposePromise === disposal) this.bootstrapDisposePromise = null
    }
  }

  private async removeSocket(socketPath: string | null): Promise<void> {
    if (!socketPath) return
    if (this.socketPath === socketPath) this.socketPath = null
    await rm(socketPath, { force: true }).catch(() => {})
  }
}
