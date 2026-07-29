import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import { loggerService } from '@logger'
import { BaseService, type Disposable, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { crossPlatformSpawn } from '@main/utils/processRunner'
import type { ChemSmartStudioConsoleCompletions, ChemSmartStudioConsoleRun } from '@shared/ipc/schemas/chemsmartStudio'

import { type CliSchemaDocument, resolveCompletions } from './cliCompletion'
import { OwnedProcessTree } from './OwnedProcessTree'

const logger = loggerService.withContext('StudioConsoleService')

/**
 * How often buffered output reaches the renderer. A chatty job writes thousands of times a second;
 * emitting per write would flood IPC for no gain, since nobody can read faster than the screen
 * repaints. One tick is the whole backpressure story.
 */
const FLUSH_INTERVAL_MS = 50
/** A runaway job must not grow main's heap without bound. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** A real calculation can run for hours, so the graceful window is short and the kill is certain. */
const TERMINATE_GRACEFUL_MS = 5_000
const TERMINATE_FORCED_MS = 5_000
const MAX_COMMAND_LENGTH = 8_192
/** Written by `chemsmart agent _dump-cli-schema --out <path>`. */
const CLI_SCHEMA_FILE = 'cli-schema.json'

function isCliCommand(value: unknown): value is CliSchemaDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CliSchemaDocument>
  return (
    typeof candidate.name === 'string' && Array.isArray(candidate.options) && typeof candidate.subcommands === 'object'
  )
}

interface ActiveRun {
  runId: string
  tree: OwnedProcessTree
  pending: { stream: 'stdout' | 'stderr'; chunk: string }[]
  bytesEmitted: number
  truncated: boolean
  /** Ticks only while this run is alive; an idle console has no timer at all. */
  flush: Disposable
}

/**
 * Runs what the researcher types, and streams it back.
 *
 * This is a *human* surface. A command here is the researcher acting on their own machine, so it
 * needs no approval — but for the same reason the agent can never reach it: agent execution goes
 * through the approval-gated tool path, and nothing in this service is exposed to the tool loop.
 *
 * The shell is started as a login shell so the researcher's own profile supplies the chemistry
 * environment a real run needs (`GAUSS_EXEDIR`, ORCA on `PATH`, a conda activation). The trusted
 * bundled ChemSmart CLI directory is prepended after login; main's remaining environment is
 * deliberately *not* inherited because it may carry provider credentials.
 */
@Injectable('StudioConsoleService')
@ServicePhase(Phase.WhenReady)
export class StudioConsoleService extends BaseService {
  private active: ActiveRun | null = null
  /** `undefined` until first read; `null` once a read established there is no usable dump. */
  private cliSchema: CliSchemaDocument | null | undefined = undefined

  /**
   * Starts one command. A second submission while one is running is refused rather than queued —
   * a hidden queue is how a researcher ends up watching output from a command they forgot they sent.
   */
  run(command: string): ChemSmartStudioConsoleRun {
    const line = command.trim()
    if (line.length === 0) throw new Error('A command is required')
    if (line.length > MAX_COMMAND_LENGTH) throw new Error('That command is too long to run')
    if (this.active) throw new Error('A command is already running in the console')

    const runId = randomUUID()
    const shell = process.env.SHELL ?? '/bin/sh'
    const bridgeBin = path.dirname(application.getPath('feature.chemsmart_studio.bridge.python_file'))
    const shellLine = `export PATH="$CHEMSMART_STUDIO_BRIDGE_BIN:$PATH"\n${line}`
    const child = crossPlatformSpawn(shell, ['-l', '-c', shellLine], {
      cwd: application.getPath('feature.chemsmart_studio.projects'),
      // Only what a login shell needs to find the researcher's own profile; everything else comes
      // from that profile rather than from this process.
      env: {
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.USER ? { USER: process.env.USER } : {}),
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.TERM ? { TERM: process.env.TERM } : { TERM: 'dumb' }),
        CHEMSMART_STUDIO_BRIDGE_BIN: bridgeBin
      },
      // Its own process group, so cancelling reaches the whole tree rather than only the shell —
      // a Gaussian child must not survive the command that started it.
      detached: process.platform !== 'win32'
    })

    const run: ActiveRun = {
      runId,
      tree: new OwnedProcessTree(child, 'console command'),
      pending: [],
      bytesEmitted: 0,
      truncated: false,
      flush: this.registerInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    }
    this.active = run

    child.stdout?.on('data', (chunk: Buffer) => this.append(run, 'stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.append(run, 'stderr', chunk))
    child.on('error', (error) => {
      logger.error('Console command failed to start', error)
      this.append(run, 'stderr', Buffer.from(`${error.message}\n`))
      this.finish(run, null, null)
    })
    child.on('close', (code, signal) => this.finish(run, code, signal))

    return { runId }
  }

  /**
   * Completions for a line, resolved against the command path.
   *
   * The schema is dumped once per chemsmart build and reused: it is derived from the installed CLI,
   * so it is correct for the binary the researcher will actually invoke rather than for whatever
   * version this app was written against. A missing or unreadable dump yields no completions — the
   * console still runs commands, it just stops offering advice it cannot ground.
   */
  async complete(line: string, cursor: number): Promise<ChemSmartStudioConsoleCompletions> {
    const schema = await this.loadCliSchema()
    if (!schema) return { commandPath: [], replaceFrom: cursor, completions: [] }
    return resolveCompletions(schema, line, cursor)
  }

  private async loadCliSchema(): Promise<CliSchemaDocument | null> {
    if (this.cliSchema !== undefined) return this.cliSchema
    const schemaPath = application.getPath('feature.chemsmart_studio.runtime', CLI_SCHEMA_FILE)
    try {
      const raw = await readFile(schemaPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cliSchema = isCliCommand(parsed) ? parsed : null
      if (!this.cliSchema) logger.warn('The chemsmart CLI schema dump is not a command tree')
    } catch (error) {
      // Absent is the ordinary case before the first dump, so this is not an error state.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to read the chemsmart CLI schema dump', error as Error)
      }
      this.cliSchema = null
    }
    return this.cliSchema
  }

  /** Cancels the running command. An unknown or already-finished run id is a no-op, not an error. */
  async cancel(runId: string): Promise<void> {
    const run = this.active
    if (!run || run.runId !== runId) return
    try {
      await run.tree.terminate(TERMINATE_GRACEFUL_MS, TERMINATE_FORCED_MS)
    } catch (error) {
      logger.error('Console command did not exit after SIGKILL', error as Error)
    }
  }

  private append(run: ActiveRun, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (this.active !== run) return
    if (run.bytesEmitted >= MAX_OUTPUT_BYTES) {
      if (!run.truncated) {
        run.truncated = true
        run.pending.push({ stream: 'stderr', chunk: '\n[output truncated]\n' })
      }
      return
    }
    const remaining = MAX_OUTPUT_BYTES - run.bytesEmitted
    const text = chunk.subarray(0, remaining).toString('utf8')
    run.bytesEmitted += Math.min(chunk.byteLength, remaining)
    run.pending.push({ stream, chunk: text })
  }

  private flush(): void {
    const run = this.active
    if (!run || run.pending.length === 0) return
    const pending = run.pending
    run.pending = []
    // One event per stream per tick keeps ordering within a stream while staying cheap.
    for (const stream of ['stdout', 'stderr'] as const) {
      const chunk = pending
        .filter((entry) => entry.stream === stream)
        .map((entry) => entry.chunk)
        .join('')
      if (chunk.length > 0) {
        application.get('IpcApiService').broadcast('chemsmart_studio.console.output', {
          runId: run.runId,
          stream,
          chunk
        })
      }
    }
  }

  private finish(run: ActiveRun, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.active !== run) return
    this.flush()
    run.flush.dispose()
    this.active = null
    application.get('IpcApiService').broadcast('chemsmart_studio.console.exited', {
      runId: run.runId,
      code,
      signal: signal ?? null
    })
  }

  protected async onStop(): Promise<void> {
    const run = this.active
    if (!run) return
    // A command outliving the app would keep a scratch directory locked and a scheduler slot warm.
    await run.tree.terminate(TERMINATE_GRACEFUL_MS, TERMINATE_FORCED_MS).catch((error) => {
      logger.error('Console command survived shutdown', error as Error)
    })
    this.active = null
  }
}
