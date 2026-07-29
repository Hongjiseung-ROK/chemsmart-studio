import { randomUUID } from 'node:crypto'

import {
  type StudioAgentTraceEvent,
  studioAgentTraceEventRuntimeSchema,
  type StudioAgentTraceKind,
  type StudioAgentTraceStatus
} from '@chemsmart/studio-protocol'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import * as z from 'zod'

const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const safeKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/)
const traceSeedSchema = z
  .object({
    sessionId: stableIdSchema,
    kind: z.enum([
      'turn_started',
      'reasoning_summary',
      'tool_started',
      'permission_waiting',
      'tool_progress',
      'tool_succeeded',
      'tool_failed',
      'turn_completed',
      'turn_blocked'
    ]),
    toolCallId: stableIdSchema.optional(),
    toolName: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z][A-Za-z0-9._-]*$/)
      .optional(),
    title: z.string().min(1).max(256),
    summary: z.string().min(1).max(2048),
    detail: z
      .object({
        argumentKeys: z.array(safeKeySchema).max(64).optional(),
        resultKeys: z.array(safeKeySchema).max(64).optional(),
        ruleIds: z.array(safeKeySchema).max(128).optional(),
        verdict: safeKeySchema.max(64).optional(),
        durationMs: z.number().int().nonnegative().max(86_400_000).optional()
      })
      .strict()
      .optional()
  })
  .strict()

type TraceSeed = z.infer<typeof traceSeedSchema>
type ToolState = 'waiting' | 'running' | 'terminal'

interface TurnState {
  tools: Map<string, ToolState>
}

const MAX_RETAINED_TERMINAL_TURNS = 2_048
const MAX_RETAINED_SESSION_COUNTERS = 512

const validateTraceEvent = new CfWorkerJsonSchemaValidator({
  draft: '2020-12',
  shortcircuit: false
}).getValidator<StudioAgentTraceEvent>(studioAgentTraceEventRuntimeSchema as unknown as JsonSchemaType)

const statusForKind: Record<StudioAgentTraceKind, StudioAgentTraceStatus> = {
  turn_started: 'running',
  reasoning_summary: 'running',
  tool_started: 'running',
  permission_waiting: 'waiting',
  tool_progress: 'running',
  tool_succeeded: 'succeeded',
  tool_failed: 'failed',
  turn_completed: 'succeeded',
  turn_blocked: 'failed'
}

const FILE_URI = /(?:^|[^A-Za-z0-9+.-])file:(?:\/\/)?(?:\/|[A-Za-z]:[\\/])/i
const POSIX_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~/-])\/(?!\/)[^/\s"'`]+(?:\/[^/\s"'`]+)*/
const WINDOWS_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~:/\\-])[A-Za-z]:[\\/][^\s"'`]+/

function containsAbsolutePath(value: string): boolean {
  return FILE_URI.test(value) || POSIX_ABSOLUTE_PATH.test(value) || WINDOWS_ABSOLUTE_PATH.test(value)
}

export class StudioAgentTraceChannel {
  private readonly turns = new Map<string, TurnState>()
  private readonly sessionSequences = new Map<string, number>()
  private readonly sessionActiveTurns = new Map<string, number>()
  private readonly terminalTurns = new Set<string>()

  constructor(private readonly broadcast: (event: StudioAgentTraceEvent) => void) {}

  emit(turnId: string, value: unknown): StudioAgentTraceEvent {
    const seed = traceSeedSchema.parse(value)
    if (containsAbsolutePath(seed.title) || containsAbsolutePath(seed.summary)) {
      throw new Error('Studio Agent trace text must be path-free')
    }
    const key = `${seed.sessionId}:${turnId}`
    this.validateTransition(key, seed)
    const sequence = this.sessionSequences.get(seed.sessionId) ?? 0
    const event: StudioAgentTraceEvent = {
      eventId: `trace-${randomUUID()}`,
      sessionId: seed.sessionId,
      turnId,
      sequence,
      timestamp: new Date().toISOString(),
      kind: seed.kind,
      status: seed.kind === 'tool_failed' && seed.detail?.verdict === 'denied' ? 'denied' : statusForKind[seed.kind],
      ...(seed.toolCallId ? { toolCallId: seed.toolCallId } : {}),
      ...(seed.toolName ? { toolName: seed.toolName } : {}),
      title: seed.title,
      summary: seed.summary,
      ...(seed.detail ? { detail: seed.detail } : {}),
      extensions: {}
    }
    const result = validateTraceEvent(event)
    if (!result.valid) throw new Error(result.errorMessage ?? 'Studio Agent trace event is schema-invalid')
    this.sessionSequences.delete(seed.sessionId)
    this.sessionSequences.set(seed.sessionId, sequence + 1)
    if (seed.kind === 'turn_completed' || seed.kind === 'turn_blocked') {
      this.turns.delete(key)
      const activeTurns = (this.sessionActiveTurns.get(seed.sessionId) ?? 1) - 1
      if (activeTurns > 0) this.sessionActiveTurns.set(seed.sessionId, activeTurns)
      else this.sessionActiveTurns.delete(seed.sessionId)
      this.terminalTurns.add(key)
      if (this.terminalTurns.size > MAX_RETAINED_TERMINAL_TURNS) {
        const oldestTurn = this.terminalTurns.values().next().value
        if (oldestTurn) this.terminalTurns.delete(oldestTurn)
      }
      this.pruneSessionCounters()
    }
    this.broadcast(event)
    return event
  }

  private validateTransition(key: string, seed: TraceSeed): TurnState {
    let state = this.turns.get(key)
    if (seed.kind === 'turn_started') {
      if (state || this.terminalTurns.has(key)) throw new Error('Studio Agent turn trace already started')
      state = { tools: new Map() }
      this.turns.set(key, state)
      this.sessionActiveTurns.set(seed.sessionId, (this.sessionActiveTurns.get(seed.sessionId) ?? 0) + 1)
      return state
    }
    if (!state) throw new Error('Studio Agent trace is not bound to an active turn')

    const toolCallId = seed.toolCallId
    if (seed.kind.startsWith('tool_') || seed.kind === 'permission_waiting') {
      if (!toolCallId || !seed.toolName) throw new Error('Studio Agent tool trace identity is missing')
      const toolState = state.tools.get(toolCallId)
      switch (seed.kind) {
        case 'permission_waiting':
          if (toolState) throw new Error('Studio Agent tool permission was already recorded')
          state.tools.set(toolCallId, 'waiting')
          break
        case 'tool_started':
          if (toolState !== undefined && toolState !== 'waiting') {
            throw new Error('Studio Agent tool already started')
          }
          state.tools.set(toolCallId, 'running')
          break
        case 'tool_progress':
          if (toolState !== 'running' && toolState !== 'waiting') {
            throw new Error('Studio Agent tool progress has no active tool')
          }
          break
        case 'tool_succeeded':
        case 'tool_failed':
          if (toolState !== 'running' && toolState !== 'waiting') {
            throw new Error('Studio Agent tool completion has no active tool')
          }
          state.tools.set(toolCallId, 'terminal')
          break
      }
    }
    return state
  }

  private pruneSessionCounters(): void {
    if (this.sessionSequences.size <= MAX_RETAINED_SESSION_COUNTERS) return
    for (const sessionId of this.sessionSequences.keys()) {
      if (this.sessionActiveTurns.has(sessionId)) continue
      this.sessionSequences.delete(sessionId)
      if (this.sessionSequences.size <= MAX_RETAINED_SESSION_COUNTERS) return
    }
  }
}
