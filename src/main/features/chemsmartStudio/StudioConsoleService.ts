import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import { CHEMSMART_COMMIT, type StudioConsoleFileDropResult } from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { BaseService, DependsOn, type Disposable, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { crossPlatformSpawn } from '@main/utils/processRunner'
import type {
  ChemSmartStudioConsoleCompletions,
  ChemSmartStudioConsoleCompletionSelection,
  ChemSmartStudioConsolePreflight,
  ChemSmartStudioConsoleRun
} from '@shared/ipc/schemas/chemsmartStudio'

import {
  type CliSchemaDocument,
  type DynamicCompletionCandidate,
  quoteShellValue,
  resolveCompletions,
  resolveFileDropTarget
} from './cliCompletion'
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
const MAX_COMPLETION_CANDIDATES = 256
const MAX_CONTEXT_ENTRIES = 1_024
const MAX_FILE_DROP_BYTES = 128 * 1024 * 1024
const COMPLETABLE_EXTENSIONS = new Set(['.xyz', '.cjson', '.sdf', '.gjf', '.com', '.inp', '.out', '.log', '.yaml'])
const MOLECULE_EXTENSIONS = new Set(['.xyz', '.cjson', '.sdf'])
const PREFLIGHT_TTL_MS = 60_000
const COMPLETION_CONTEXT_TTL_MS = 5 * 60_000

function isCliCommand(value: unknown): value is CliSchemaDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CliSchemaDocument>
  return (
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.options) &&
    typeof candidate.subcommands === 'object' &&
    candidate._meta?.chemsmart_commit === CHEMSMART_COMMIT &&
    typeof candidate._meta.schema_hash === 'string'
  )
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, stableJson(entry)])
    )
  }
  return value
}

function cliSchemaHash(schema: CliSchemaDocument): string {
  const body: Record<string, unknown> = { ...schema }
  delete body._meta
  return createHash('sha256')
    .update(JSON.stringify(stableJson(body)))
    .digest('hex')
}

function isManifestFresh(schema: CliSchemaDocument): boolean {
  return schema._meta?.schema_hash === cliSchemaHash(schema)
}

function safeCandidateName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && !name.includes('/') && !name.includes('\\')
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

interface CompletionContext {
  contextRef: string
  absolutePath: string
  rootPath: string
  displayName: string
  action: ChemSmartStudioConsoleCompletionSelection['action']
  program?: 'gaussian' | 'orca'
  projectName?: string
  device: number
  inode: number
  size: number
  issuedAt: number
}

interface AcceptedPreflight {
  commandDigest: string
  verdict: 'green' | 'warning'
  issuedAt: number
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
@DependsOn(['ChemSmartAgentService', 'MoleculeWorkspaceService'])
@ServicePhase(Phase.WhenReady)
export class StudioConsoleService extends BaseService {
  private active: ActiveRun | null = null
  /** `undefined` until first read; `null` once a read established there is no usable dump. */
  private cliSchema: CliSchemaDocument | null | undefined = undefined
  private readonly completionContexts = new Map<string, CompletionContext>()
  private readonly acceptedPreflights = new Map<string, AcceptedPreflight>()

  /**
   * Starts one command. A second submission while one is running is refused rather than queued —
   * a hidden queue is how a researcher ends up watching output from a command they forgot they sent.
   */
  run(command: string, preflightDigest?: string): ChemSmartStudioConsoleRun {
    const line = command.trim()
    if (line.length === 0) throw new Error('A command is required')
    if (line.length > MAX_COMMAND_LENGTH) throw new Error('That command is too long to run')
    if (this.active) throw new Error('A command is already running in the console')
    if (/^chemsmart(?:\s|$)/.test(line)) this.consumePreflight(line, preflightDigest)

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
  async complete(
    line: string,
    cursor: number,
    disclosure: 'primary' | 'all' = 'primary'
  ): Promise<ChemSmartStudioConsoleCompletions> {
    const schema = await this.loadCliSchema()
    if (!schema) {
      return {
        commandPath: [],
        stage: 'root',
        disclosure,
        hasMore: false,
        replaceRange: { start: cursor, end: cursor },
        items: [],
        semantic: { breadcrumb: [], slots: [], ghostSuffix: '', complete: false }
      }
    }
    return resolveCompletions(schema, line, cursor, await this.discoverCompletionCandidates(), disclosure)
  }

  /** Validate a Finder drop and issue a one-shot molecule context without starting any process. */
  async prepareFileDrop(line: string, cursor: number, filePath: string): Promise<StudioConsoleFileDropResult> {
    const schema = await this.loadCliSchema()
    if (!schema) throw new Error('Filename guidance is unavailable')
    const target = resolveFileDropTarget(schema, line, cursor)
    if (!path.isAbsolute(filePath)) throw new Error('The dropped file path must be absolute')
    if (!MOLECULE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      throw new Error('Only XYZ, CJSON, and SDF molecule files can be dropped here')
    }

    const identity = await lstat(filePath)
    if (identity.isSymbolicLink() || !identity.isFile()) throw new Error('The dropped item must be a regular file')
    if (identity.size <= 0 || identity.size > MAX_FILE_DROP_BYTES) {
      throw new Error('The dropped molecule file size is not supported')
    }
    const insertText = quoteShellValue(filePath)
    if (insertText.length > 1_024 || /[\u0000\r\n;&|<>]/.test(insertText)) {
      throw new Error('The dropped file path cannot be represented safely')
    }
    const displayName = path.basename(filePath)
    if (displayName.length === 0 || displayName.length > 256 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new Error('The dropped file name cannot be represented safely')
    }
    const context = await this.issueCompletionContext(filePath, path.dirname(filePath), displayName, 'molecule')
    if (
      !context ||
      context.device !== identity.dev ||
      context.inode !== identity.ino ||
      context.size !== identity.size
    ) {
      if (context) this.completionContexts.delete(context.contextRef)
      throw new Error('The dropped file changed before it could be prepared')
    }

    return {
      replaceRange: target.replaceRange,
      item: {
        id: `completion-${randomUUID()}`,
        label: displayName,
        insertText,
        kind: 'file',
        group: 'files',
        detail: target.option.help ?? '',
        appendSpace: true,
        contextRef: context.contextRef,
        openAction: 'molecule'
      }
    }
  }

  /**
   * Runs the existing deterministic command inspection once, only after submit.
   *
   * This deliberately starts no chemistry executable. The sidecar may be started to host the
   * parser/harness, but the returned receipt is rejected unless the harness proves that no command
   * process ran. Human Console execution stays approval-free; the receipt only decides whether the
   * first Enter may continue or a warning needs one explicit repeat.
   */
  async preflight(command: string): Promise<ChemSmartStudioConsolePreflight> {
    const line = command.trim()
    if (!/^chemsmart(?:\s|$)/.test(line)) {
      const commandDigest = createHash('sha256').update(line).digest('hex')
      const result: ChemSmartStudioConsolePreflight = {
        commandDigest,
        verdict: 'green',
        summary: {
          kind: 'shell',
          program: null,
          job: null,
          inputName: null,
          charge: null,
          multiplicity: null
        },
        failedRuleIds: [],
        issues: [],
        processStarted: false
      }
      this.acceptedPreflights.set(commandDigest, { commandDigest, verdict: 'green', issuedAt: Date.now() })
      return result
    }

    const result = await application.get('ChemSmartAgentService').inspectCommand({
      sessionId: `console-${randomUUID()}`,
      command: line,
      // The intent gate compares the command with this deterministic restatement. No model call is
      // made, and no new command meaning is invented in Studio.
      intentDescription: line
    })
    if (result.executionPerformed || result.dryRun.processStarted) {
      throw new Error('Command inspection attempted execution')
    }

    const rejected =
      !result.parse.accepted ||
      result.status === 'rejected' ||
      result.status === 'intent_reject' ||
      result.intent.verdict === 'reject' ||
      result.semantic.verdict === 'reject'
    const warned =
      !rejected &&
      (result.status === 'needs_clarification' ||
        result.intent.verdict === 'unavailable' ||
        result.semantic.verdict === 'warn' ||
        result.semantic.issues.some((issue) => issue.severity === 'warn'))
    const verdict = rejected ? 'rejected' : warned ? 'warning' : 'green'
    const receipt: ChemSmartStudioConsolePreflight = {
      commandDigest: result.commandDigest,
      verdict,
      summary: {
        kind: 'chemsmart',
        program: result.parse.program,
        job: result.parse.job,
        inputName: result.parse.inputName,
        charge: result.parse.charge,
        multiplicity: result.parse.multiplicity
      },
      failedRuleIds: [...new Set([...result.intent.failedRuleIds, ...result.semantic.failedRuleIds])],
      issues: result.semantic.issues.map((issue) => ({
        ruleId: issue.ruleId,
        severity: issue.severity,
        message: issue.message
      })),
      processStarted: false
    }
    if (verdict !== 'rejected') {
      this.acceptedPreflights.set(receipt.commandDigest, {
        commandDigest: receipt.commandDigest,
        verdict: verdict === 'warning' ? 'warning' : 'green',
        issuedAt: Date.now()
      })
    }
    return receipt
  }

  private async loadCliSchema(): Promise<CliSchemaDocument | null> {
    if (this.cliSchema !== undefined) return this.cliSchema
    const schemaPath = application.getPath('feature.chemsmart_studio.cli_schema.file')
    try {
      const raw = await readFile(schemaPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.cliSchema = isCliCommand(parsed) && isManifestFresh(parsed) ? parsed : null
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

  /**
   * Human-only context from Studio-owned roots. Directory entries are never passed to the Agent,
   * and symlinks are ignored so completion cannot become a path traversal oracle.
   */
  private async discoverCompletionCandidates(): Promise<DynamicCompletionCandidate[]> {
    const projectsRoot = application.getPath('feature.chemsmart_studio.projects')
    const workspace = application.getPath('feature.chemsmart_studio.workspace')
    const candidates: DynamicCompletionCandidate[] = []
    this.pruneCompletionContexts()

    const addFiles = async (directory: string, relativeRoot: string, depth: number): Promise<void> => {
      if (depth < 0 || candidates.length >= MAX_COMPLETION_CANDIDATES) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (candidates.length >= MAX_COMPLETION_CANDIDATES || entry.isSymbolicLink() || !safeCandidateName(entry.name))
          continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await addFiles(absolute, relativeRoot, depth - 1)
          continue
        }
        if (!entry.isFile() || !COMPLETABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        const relative = path.relative(relativeRoot, absolute)
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue
        const extension = path.extname(entry.name).toLowerCase()
        const context = MOLECULE_EXTENSIONS.has(extension)
          ? await this.issueCompletionContext(absolute, relativeRoot, relative, 'molecule')
          : undefined
        candidates.push({
          label: relative,
          insertText: relative,
          kind: 'file',
          detail: 'Studio project artifact',
          optionNames: ['filename', 'file', 'input', 'structure', 'geometry'],
          ...(context ? { contextRef: context.contextRef, openAction: context.action } : {})
        })
      }
    }

    await addFiles(projectsRoot, projectsRoot, 3)
    for (const program of ['gaussian', 'orca', 'xtb'] as const) {
      const directory = path.join(workspace, '.chemsmart', program)
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name) !== '.yaml') continue
        const label = path.basename(entry.name, '.yaml')
        if (!safeCandidateName(label)) continue
        const absolute = path.join(directory, entry.name)
        const context =
          program === 'xtb'
            ? undefined
            : await this.issueCompletionContext(absolute, directory, label, 'project_yaml', {
                program,
                projectName: label
              })
        candidates.push({
          label,
          insertText: label,
          kind: 'project',
          detail: `${program.toUpperCase()} project`,
          optionNames: ['project'],
          ...(context ? { contextRef: context.contextRef, openAction: context.action } : {})
        })
      }
    }
    const serverDirectory = path.join(workspace, '.chemsmart', 'server')
    try {
      const entries = await readdir(serverDirectory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name) !== '.yaml') continue
        const label = path.basename(entry.name, '.yaml')
        if (!safeCandidateName(label)) continue
        candidates.push({
          label,
          insertText: label,
          kind: 'server',
          detail: 'Configured server',
          optionNames: ['server']
        })
      }
    } catch {
      // No configured servers is an ordinary state.
    }
    return candidates.slice(0, MAX_COMPLETION_CANDIDATES)
  }

  async acceptCompletionContext(contextRef: string): Promise<ChemSmartStudioConsoleCompletionSelection> {
    this.pruneCompletionContexts()
    const context = this.completionContexts.get(contextRef)
    if (!context) {
      throw new Error('That completion context is no longer available')
    }
    const [root, target, identity] = await Promise.all([
      realpath(context.rootPath),
      realpath(context.absolutePath),
      lstat(context.absolutePath)
    ])
    const relative = path.relative(root, target)
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      identity.isSymbolicLink() ||
      !identity.isFile() ||
      identity.dev !== context.device ||
      identity.ino !== context.inode ||
      identity.size !== context.size
    ) {
      this.completionContexts.delete(contextRef)
      throw new Error('That completion file changed before it could be opened')
    }
    this.completionContexts.delete(contextRef)
    if (context.action === 'molecule') {
      await application.get('MoleculeWorkspaceService').importMoleculeFromConsole(target, context.displayName)
    }
    return {
      contextRef,
      action: context.action,
      displayName: context.displayName,
      ...(context.program ? { program: context.program } : {}),
      ...(context.projectName ? { projectName: context.projectName } : {})
    }
  }

  private async issueCompletionContext(
    absolutePath: string,
    rootPath: string,
    displayName: string,
    action: CompletionContext['action'],
    metadata: Pick<CompletionContext, 'program' | 'projectName'> = {}
  ): Promise<CompletionContext | undefined> {
    try {
      const identity = await lstat(absolutePath)
      if (!identity.isFile() || identity.isSymbolicLink()) return undefined
      this.pruneCompletionContexts(Date.now(), 1)
      const context: CompletionContext = {
        contextRef: `completion-${randomUUID()}`,
        absolutePath,
        rootPath,
        displayName,
        action,
        ...metadata,
        device: identity.dev,
        inode: identity.ino,
        size: identity.size,
        issuedAt: Date.now()
      }
      this.completionContexts.set(context.contextRef, context)
      return context
    } catch {
      return undefined
    }
  }

  private pruneCompletionContexts(now = Date.now(), reservedEntries = 0): void {
    for (const [contextRef, context] of this.completionContexts) {
      if (now - context.issuedAt > COMPLETION_CONTEXT_TTL_MS) this.completionContexts.delete(contextRef)
    }
    const overflow = this.completionContexts.size + reservedEntries - MAX_CONTEXT_ENTRIES
    if (overflow <= 0) return
    const oldest = [...this.completionContexts.values()]
      .sort((left, right) => left.issuedAt - right.issuedAt)
      .slice(0, overflow)
    for (const context of oldest) this.completionContexts.delete(context.contextRef)
  }

  private consumePreflight(command: string, suppliedDigest?: string): void {
    const commandDigest = createHash('sha256').update(command).digest('hex')
    const receipt = suppliedDigest ? this.acceptedPreflights.get(suppliedDigest) : undefined
    if (
      suppliedDigest !== commandDigest ||
      !receipt ||
      receipt.commandDigest !== commandDigest ||
      Date.now() - receipt.issuedAt > PREFLIGHT_TTL_MS
    ) {
      throw new Error('Run the ChemSmart preflight again before executing this command')
    }
    this.acceptedPreflights.delete(commandDigest)
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
