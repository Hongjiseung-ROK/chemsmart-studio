import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import {
  type StudioAgentAnswer,
  type StudioAgentArtifact,
  type StudioAgentCapabilityManifest,
  type StudioAgentComposerIntent,
  type StudioAgentToolProjection,
  type StudioAgentTurnEvent,
  type StudioAgentTurnEventKind,
  type StudioAgentTurnOutcome,
  type StudioAgentTurnPage,
  type StudioAgentTurnStatus,
  studioAgentWorkbenchRuntimeSchema,
  type StudioAgentWorkflow
} from '@chemsmart/studio-protocol'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { t } from '@main/i18n'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'

const MAX_EVENTS = 20_000
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024
const FILE_URI = /(?:^|[^A-Za-z0-9+.-])file:(?:\/\/)?(?:\/|[A-Za-z]:[\\/])/i
const POSIX_ABSOLUTE_PATH =
  /(?:^|[^A-Za-z0-9._~/-])\/(?:Users|home|private|var|tmp|Volumes|Applications|opt|etc|usr)(?:\/[^/\s"'`]+)+/
const WINDOWS_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~:/\\-])[A-Za-z]:[\\/][^\s"'`]+/
const SECRET_VALUE = /\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/i
const SECRET_LABEL = /\b(?:api[_ -]?key|authorization|bearer)\s*[:=]/i
const RAW_REASONING = /\b(?:reasoning_content|chain[- ]of[- ]thought|raw reasoning)\b/i
const MARKDOWN_APPROVAL = /\bapproval card\b/i
const ASCII_TABLE = /\|[^|\n]+\|/

const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const validateTurnEvent = runtimeValidator.getValidator<StudioAgentTurnEvent>({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: studioAgentWorkbenchRuntimeSchema.$defs,
  $ref: '#/$defs/studioAgentTurnEvent'
} as JsonSchemaType)

interface TranscriptFile {
  schemaVersion: 1
  events: StudioAgentTurnEvent[]
}

interface EventSeed {
  kind: Exclude<StudioAgentTurnEventKind, 'user_message'>
  status: StudioAgentTurnStatus
  summary: string
  tool?: StudioAgentToolProjection
  approvalRef?: string
  artifact?: StudioAgentArtifact
  answer?: StudioAgentAnswer
  outcome?: StudioAgentTurnOutcome
}

interface ReducedTurn {
  terminal: boolean
  tools: Map<string, 'waiting' | 'running' | 'terminal'>
}

function invalid(message: string): IpcError {
  return new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, message)
}

function assertSafeProjection(value: unknown): void {
  if (typeof value === 'string') {
    if (
      FILE_URI.test(value) ||
      POSIX_ABSOLUTE_PATH.test(value) ||
      WINDOWS_ABSOLUTE_PATH.test(value) ||
      SECRET_VALUE.test(value) ||
      SECRET_LABEL.test(value) ||
      RAW_REASONING.test(value) ||
      MARKDOWN_APPROVAL.test(value) ||
      ASCII_TABLE.test(value)
    ) {
      throw invalid('Agent projection contains private or unstructured text')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeProjection(item)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) assertSafeProjection(child)
  }
}

function statusForOutcome(outcome: StudioAgentTurnOutcome): StudioAgentTurnStatus {
  switch (outcome) {
    case 'completed':
      return 'succeeded'
    case 'denied':
      return 'denied'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'needs_user':
      return 'needs_user'
  }
}

function transcriptFileName(threadId: string): string {
  return `${threadId}.json`
}

@Injectable('StudioAgentProjectionService')
@DependsOn(['ResearchProjectSessionService', 'MoleculeWorkspaceService', 'CalculationRuntimeService'])
@ServicePhase(Phase.WhenReady)
export class StudioAgentProjectionService extends BaseService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly contextBindings = new Map<string, unknown>()

  async beginTurn(
    threadId: string,
    userMessage: string,
    workflow: StudioAgentWorkflow = 'general'
  ): Promise<StudioAgentTurnEvent> {
    return this.enqueue(async () => {
      const binding = await this.requireThread(threadId)
      const transcript = await this.load(binding.projectId, threadId)
      const reduced = this.reduce(transcript.events)
      if ([...reduced.values()].some((turn) => !turn.terminal)) {
        throw invalid('The research thread already has an active turn')
      }
      const event = this.createEvent(threadId, `turn-${randomUUID()}`, transcript.events.length, {
        kind: 'user_message',
        status: 'running',
        summary: `@[${workflow.replace('_', '-')}] ${userMessage}`
      })
      transcript.events.push(event)
      await this.persist(binding.projectId, threadId, transcript)
      await application.get('ResearchProjectSessionService').recordActivity(threadId, userMessage)
      this.broadcast(event)
      return event
    })
  }

  async appendTurnEvent(threadId: string, turnId: string, seed: EventSeed): Promise<StudioAgentTurnEvent> {
    return this.enqueue(async () => {
      const binding = await this.requireThread(threadId)
      const transcript = await this.load(binding.projectId, threadId)
      const reduced = this.reduce(transcript.events)
      const turn = reduced.get(turnId)
      if (!turn || turn.terminal) throw invalid('The Agent turn is not active')
      this.validateTransition(turn, seed)
      const event = this.createEvent(threadId, turnId, transcript.events.length, seed)
      transcript.events.push(event)
      await this.persist(binding.projectId, threadId, transcript)
      this.broadcast(event)
      return event
    })
  }

  async terminalize(
    threadId: string,
    turnId: string,
    outcome: StudioAgentTurnOutcome,
    summary: string
  ): Promise<StudioAgentTurnEvent> {
    return this.appendTurnEvent(threadId, turnId, {
      kind: 'turn_terminal',
      status: statusForOutcome(outcome),
      summary,
      outcome
    })
  }

  async getPage(threadId: string, beforeSequence: number | null, limit: number): Promise<StudioAgentTurnPage> {
    return this.enqueue(async () => {
      const binding = await this.requireThread(threadId)
      const transcript = await this.load(binding.projectId, threadId)
      const eligible = transcript.events.filter((event) => beforeSequence === null || event.sequence < beforeSequence)
      const events = eligible.slice(Math.max(0, eligible.length - limit))
      return {
        threadId,
        events,
        nextBeforeSequence: eligible.length > events.length ? (events[0]?.sequence ?? null) : null,
        extensions: {}
      }
    })
  }

  async getCapabilityManifest(threadId: string, sessionId: string): Promise<StudioAgentCapabilityManifest> {
    const binding = await this.requireThread(threadId)
    const context = await application.get('CalculationRuntimeService').getWorkspaceContext(sessionId)
    if (context.project.projectHandleId !== binding.projectId) {
      throw invalid('The Agent context does not belong to the active research project')
    }
    const projectRef = this.issueContextRef('project', context.project)
    const moleculeRef = this.issueContextRef('molecule', {
      document: context.document,
      display: context.display,
      draft: context.draft
    })
    const selectionRef =
      context.selection.atomIds.length > 0 || context.selection.bondIds.length > 0
        ? this.issueContextRef('selection', context.selection)
        : null
    const runFrameRef = context.activeRun
      ? this.issueContextRef('run_frame', {
          activeRun: context.activeRun,
          display: context.display.state === 'run' || context.display.state === 'replay' ? context.display : null
        })
      : null
    const items: StudioAgentCapabilityManifest['items'] = [
      {
        discovery: 'plus',
        key: 'project',
        label: 'Project',
        description: 'Attach the active project identity.',
        capability: 'inspect',
        contextRef: projectRef
      },
      {
        discovery: 'plus',
        key: 'current_molecule',
        label: 'Current molecule',
        description: 'Attach the currently visible molecule.',
        capability: 'inspect',
        contextRef: moleculeRef
      },
      ...(selectionRef
        ? [
            {
              discovery: 'plus' as const,
              key: 'selection',
              label: 'Selection',
              description: 'Attach the current atom and bond selection.',
              capability: 'inspect' as const,
              contextRef: selectionRef
            }
          ]
        : []),
      ...(runFrameRef
        ? [
            {
              discovery: 'plus' as const,
              key: 'current_run_frame',
              label: 'Current run/frame',
              description: 'Attach the active calculation and displayed frame.',
              capability: 'inspect' as const,
              contextRef: runFrameRef
            }
          ]
        : []),
      {
        discovery: 'mention',
        key: 'project',
        label: 'Project',
        description: 'Reference the active project.',
        capability: 'inspect',
        contextRef: projectRef
      },
      {
        discovery: 'mention',
        key: 'current_molecule',
        label: 'Current molecule',
        description: 'Reference the currently visible molecule.',
        capability: 'inspect',
        contextRef: moleculeRef
      },
      ...(selectionRef
        ? [
            {
              discovery: 'mention' as const,
              key: 'selection',
              label: 'Selection',
              description: 'Reference the current selection.',
              capability: 'inspect' as const,
              contextRef: selectionRef
            }
          ]
        : []),
      ...(runFrameRef
        ? [
            {
              discovery: 'mention' as const,
              key: 'current_run_frame',
              label: 'Current run/frame',
              description: 'Reference the active run and frame.',
              capability: 'inspect' as const,
              contextRef: runFrameRef
            }
          ]
        : []),
      ...(
        [
          {
            workflow: 'general',
            capability: 'inspect',
            label: t('chemsmart_studio.agent_workflow.general.label'),
            description: t('chemsmart_studio.agent_workflow.general.description')
          },
          {
            workflow: 'project_setup',
            capability: 'plan',
            label: t('chemsmart_studio.agent_workflow.project_setup.label'),
            description: t('chemsmart_studio.agent_workflow.project_setup.description')
          },
          {
            workflow: 'command',
            capability: 'plan',
            label: t('chemsmart_studio.agent_workflow.command.label'),
            description: t('chemsmart_studio.agent_workflow.command.description')
          },
          {
            workflow: 'molecule',
            capability: 'plan',
            label: t('chemsmart_studio.agent_workflow.molecule.label'),
            description: t('chemsmart_studio.agent_workflow.molecule.description')
          },
          {
            workflow: 'calculation',
            capability: 'act',
            label: t('chemsmart_studio.agent_workflow.calculation.label'),
            description: t('chemsmart_studio.agent_workflow.calculation.description')
          },
          {
            workflow: 'results',
            capability: 'inspect',
            label: t('chemsmart_studio.agent_workflow.results.label'),
            description: t('chemsmart_studio.agent_workflow.results.description')
          }
        ] as const
      ).map(({ workflow, capability, label, description }) => ({
        discovery: 'task' as const,
        key: workflow,
        label,
        description,
        capability,
        workflow
      }))
    ]
    const manifest: StudioAgentCapabilityManifest = {
      projectId: binding.projectId,
      threadId,
      generatedAt: new Date().toISOString(),
      items,
      extensions: {}
    }
    assertSafeProjection(manifest)
    return manifest
  }

  async validateComposerIntent(threadId: string, sessionId: string, intent: StudioAgentComposerIntent): Promise<void> {
    const manifest = await this.getCapabilityManifest(threadId, sessionId)
    const contextRefs = new Set(
      manifest.items.flatMap((item) => (item.contextRef === undefined ? [] : [item.contextRef]))
    )
    if (intent.contextRefs.some((contextRef) => !contextRefs.has(contextRef))) {
      throw invalid('The Agent composer referenced an unavailable context')
    }
    const task = manifest.items.find((item) => item.discovery === 'task' && item.workflow === intent.workflow)
    if (!task || task.capability !== intent.capability) {
      throw invalid('The Agent workflow is not available in the current workspace')
    }
    if (intent.requiresExecutionApproval !== (intent.workflow === 'calculation')) {
      throw invalid('The Agent composer approval declaration is inconsistent')
    }
  }

  resolveContextReference(contextRef: string): unknown | null {
    const value = this.contextBindings.get(contextRef)
    return value === undefined ? null : structuredClone(value)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async requireThread(threadId: string): Promise<{ projectId: string }> {
    const context = await application.get('ResearchProjectSessionService').getContext()
    if (!context.threads.some((thread) => thread.threadId === threadId)) {
      throw invalid('The research thread does not belong to the active project')
    }
    return { projectId: context.projectId }
  }

  private issueContextRef(kind: string, value: unknown): string {
    const digest = createHash('sha256').update(JSON.stringify({ kind, value })).digest('hex').slice(0, 32)
    const contextRef = `context-${digest}`
    this.contextBindings.delete(contextRef)
    this.contextBindings.set(contextRef, structuredClone(value))
    while (this.contextBindings.size > 256) {
      const oldest = this.contextBindings.keys().next().value
      if (oldest === undefined) break
      this.contextBindings.delete(oldest)
    }
    return contextRef
  }

  private createEvent(
    threadId: string,
    turnId: string,
    sequence: number,
    seed: EventSeed | { kind: 'user_message'; status: 'running'; summary: string }
  ): StudioAgentTurnEvent {
    const event: StudioAgentTurnEvent = {
      eventId: `event-${randomUUID()}`,
      threadId,
      turnId,
      sequence,
      timestamp: new Date().toISOString(),
      kind: seed.kind,
      status: seed.status,
      summary: seed.summary,
      ...('tool' in seed && seed.tool ? { tool: seed.tool } : {}),
      ...('approvalRef' in seed && seed.approvalRef ? { approvalRef: seed.approvalRef } : {}),
      ...('artifact' in seed && seed.artifact ? { artifact: seed.artifact } : {}),
      ...('answer' in seed && seed.answer ? { answer: seed.answer } : {}),
      ...('outcome' in seed && seed.outcome ? { outcome: seed.outcome } : {}),
      extensions: {}
    }
    assertSafeProjection(event)
    const result = validateTurnEvent(event)
    if (!result.valid) throw invalid(result.errorMessage ?? 'Agent turn projection is schema-invalid')
    return event
  }

  private validateTransition(turn: ReducedTurn, seed: EventSeed): void {
    if (seed.kind === 'turn_terminal') {
      if (!seed.outcome || seed.status !== statusForOutcome(seed.outcome)) {
        throw invalid('Agent terminal status does not match its outcome')
      }
      return
    }
    const tool = seed.tool
    if (!tool) return
    const state = turn.tools.get(tool.toolCallId)
    switch (seed.kind) {
      case 'permission_waiting':
        if (state) throw invalid('Agent tool permission was already recorded')
        turn.tools.set(tool.toolCallId, 'waiting')
        break
      case 'tool_started':
        if (state !== undefined && state !== 'waiting') throw invalid('Agent tool already started')
        turn.tools.set(tool.toolCallId, 'running')
        break
      case 'tool_progress':
        if (state !== 'waiting' && state !== 'running') throw invalid('Agent tool progress has no active tool')
        break
      case 'tool_succeeded':
      case 'tool_failed':
        if (state !== 'waiting' && state !== 'running') throw invalid('Agent tool completion has no active tool')
        turn.tools.set(tool.toolCallId, 'terminal')
        break
    }
  }

  private reduce(events: StudioAgentTurnEvent[]): Map<string, ReducedTurn> {
    const turns = new Map<string, ReducedTurn>()
    let sequence = 0
    for (const event of events) {
      assertSafeProjection(event)
      const result = validateTurnEvent(event)
      if (!result.valid || event.sequence !== sequence) throw invalid('The Agent transcript is invalid or out of order')
      sequence += 1
      let turn = turns.get(event.turnId)
      if (event.kind === 'user_message') {
        if (turn) throw invalid('The Agent turn was started more than once')
        turn = { terminal: false, tools: new Map() }
        turns.set(event.turnId, turn)
        continue
      }
      if (!turn || turn.terminal) throw invalid('The Agent transcript contains an event outside an active turn')
      this.validateTransition(turn, {
        kind: event.kind,
        status: event.status,
        summary: event.summary,
        ...(event.tool ? { tool: event.tool } : {}),
        ...(event.approvalRef ? { approvalRef: event.approvalRef } : {}),
        ...(event.artifact ? { artifact: event.artifact } : {}),
        ...(event.answer ? { answer: event.answer } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {})
      })
      if (event.kind === 'turn_terminal') turn.terminal = true
    }
    return turns
  }

  private directory(projectId: string): string {
    return path.join(application.getPath('feature.chemsmart_studio.agent_threads'), projectId)
  }

  private transcriptPath(projectId: string, threadId: string): string {
    return path.join(this.directory(projectId), transcriptFileName(threadId))
  }

  private async load(projectId: string, threadId: string): Promise<TranscriptFile> {
    const filePath = this.transcriptPath(projectId, threadId)
    try {
      const stat = await lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) {
        throw invalid('The Agent transcript must be a bounded regular file')
      }
      await chmod(path.dirname(filePath), 0o700)
      await chmod(filePath, 0o600)
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<TranscriptFile>
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) {
        throw invalid('The Agent transcript envelope is invalid')
      }
      const transcript = parsed as TranscriptFile
      this.reduce(transcript.events)
      return transcript
    } catch (error) {
      if (error instanceof IpcError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, events: [] }
      if (error instanceof SyntaxError) throw invalid('The Agent transcript is malformed')
      throw error
    }
  }

  private async persist(projectId: string, threadId: string, transcript: TranscriptFile): Promise<void> {
    if (transcript.events.length > MAX_EVENTS) throw invalid('The Agent transcript reached its event limit')
    this.reduce(transcript.events)
    const directory = this.directory(projectId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(application.getPath('feature.chemsmart_studio.agent_threads'), 0o700)
    await chmod(directory, 0o700)
    const filePath = this.transcriptPath(projectId, threadId)
    const temporary = `${filePath}.${randomUUID()}.tmp`
    const bytes = `${JSON.stringify(transcript)}\n`
    if (Buffer.byteLength(bytes) > MAX_TRANSCRIPT_BYTES) throw invalid('The Agent transcript is too large')
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, filePath)
      await chmod(filePath, 0o600)
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch (error) {
      await handle?.close()
      await rm(temporary, { force: true })
      throw error
    }
  }

  private broadcast(event: StudioAgentTurnEvent): void {
    application.get('IpcApiService').broadcast('chemsmart_studio.agent.turn_event', event)
  }
}
