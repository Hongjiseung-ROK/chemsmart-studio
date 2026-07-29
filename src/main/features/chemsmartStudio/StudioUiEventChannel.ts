import {
  type StudioUiDelivery,
  type StudioUiDeliveryError,
  type StudioUiEvent,
  studioUiEventRuntimeSchema
} from '@chemsmart/studio-protocol'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import * as z from 'zod'

const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const replayEnvelopeSchema = z
  .object({
    replayId: stableIdSchema,
    event: z.unknown()
  })
  .strict()
const replayResultSchema = z
  .object({
    replayed: z.number().int().nonnegative(),
    nextSequence: z.number().int().nonnegative()
  })
  .strict()

const validateStudioUiEvent = new CfWorkerJsonSchemaValidator({
  draft: '2020-12',
  shortcircuit: false
}).getValidator<StudioUiEvent>(studioUiEventRuntimeSchema as unknown as JsonSchemaType)

export type { StudioUiDelivery } from '@chemsmart/studio-protocol'

interface ReplayState {
  sessionId: string
  expectedSequence: number
  received: number
  restoreLiveSequence: boolean
  error: Error | null
}

type BroadcastEvent = (event: StudioUiEvent) => void
type ApplyTransientFocus = (event: StudioUiEvent) => Promise<StudioUiDelivery>

export class StudioUiEventChannel {
  private readonly expectedLiveSequences = new Map<string, number>()
  private readonly replays = new Map<string, ReplayState>()
  private eventQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly broadcast: BroadcastEvent,
    private readonly applyTransientFocus: ApplyTransientFocus
  ) {}

  hasLiveSequence(sessionId: string): boolean {
    return this.expectedLiveSequences.has(sessionId)
  }

  startReplay(replayId: string, sessionId: string, afterSequence: number, restoreLiveSequence: boolean): void {
    if (this.replays.has(replayId)) throw new Error(`Studio UI replay already exists: ${replayId}`)
    this.replays.set(replayId, {
      sessionId,
      expectedSequence: afterSequence + 1,
      received: 0,
      restoreLiveSequence,
      error: null
    })
  }

  enqueueLive(value: unknown): Promise<StudioUiDelivery> {
    return this.enqueue(() => this.acceptLive(value))
  }

  enqueueReplay(value: unknown): Promise<{ accepted: true }> {
    return this.enqueue(async () => {
      const envelope = replayEnvelopeSchema.safeParse(value)
      if (!envelope.success) throw new Error('Studio UI replay envelope is schema-invalid')
      const state = this.replays.get(envelope.data.replayId)
      if (!state) throw new Error(`Unknown Studio UI replay: ${envelope.data.replayId}`)
      try {
        const event = this.parseEvent(envelope.data.event)
        if (event.sessionId !== state.sessionId) throw new Error('Studio UI replay session does not match')
        if (event.sequence !== state.expectedSequence) {
          throw new Error(`Studio UI replay expected sequence ${state.expectedSequence}, received ${event.sequence}`)
        }
        state.expectedSequence += 1
        state.received += 1
        this.broadcast(event)
        return { accepted: true }
      } catch (error) {
        state.error = error instanceof Error ? error : new Error(String(error))
        throw error
      }
    })
  }

  async finishReplay(replayId: string, value: unknown): Promise<{ replayed: number; nextSequence: number }> {
    await this.eventQueue
    const state = this.replays.get(replayId)
    if (!state) throw new Error(`Unknown Studio UI replay: ${replayId}`)
    this.replays.delete(replayId)
    if (state.error) throw state.error

    const result = replayResultSchema.safeParse(value)
    if (!result.success) throw new Error('Studio UI replay result is schema-invalid')
    if (result.data.replayed !== state.received) {
      throw new Error(`Studio UI replay count mismatch: expected ${result.data.replayed}, received ${state.received}`)
    }
    if (state.restoreLiveSequence) {
      if (state.expectedSequence !== result.data.nextSequence) {
        throw new Error(
          `Studio UI replay sequence mismatch: expected ${state.expectedSequence}, next is ${result.data.nextSequence}`
        )
      }
      this.expectedLiveSequences.set(state.sessionId, result.data.nextSequence)
    }
    return result.data
  }

  abortReplay(replayId: string): void {
    this.replays.delete(replayId)
  }

  private async acceptLive(value: unknown): Promise<StudioUiDelivery> {
    let event: StudioUiEvent
    try {
      event = this.parseEvent(value)
    } catch (error) {
      return this.failure('SCHEMA_INVALID', error instanceof Error ? error.message : String(error))
    }

    const expectedSequence = this.expectedLiveSequences.get(event.sessionId)
    if (expectedSequence === undefined || event.sequence !== expectedSequence) {
      return this.failure(
        'EVENT_OUT_OF_ORDER',
        expectedSequence === undefined
          ? `Studio UI session ${event.sessionId} has not been restored`
          : `Expected Studio UI sequence ${expectedSequence}, received ${event.sequence}`,
        event
      )
    }
    this.expectedLiveSequences.set(event.sessionId, expectedSequence + 1)

    if (event.kind === 'molecule_focus') {
      const focus = await this.applyTransientFocus(event)
      if (!focus.accepted) return focus
    }
    this.broadcast(event)
    return { accepted: true, eventId: event.eventId, sequence: event.sequence }
  }

  private parseEvent(value: unknown): StudioUiEvent {
    const result = validateStudioUiEvent(value)
    if (!result.valid) throw new Error(result.errorMessage ?? 'Studio UI event is schema-invalid')
    return result.data
  }

  private failure(code: StudioUiDeliveryError['code'], message: string, event?: StudioUiEvent): StudioUiDelivery {
    return {
      accepted: false,
      ...(event ? { eventId: event.eventId, sequence: event.sequence } : {}),
      error: { code, message }
    }
  }

  private enqueue<TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult> {
    const result = this.eventQueue.then(operation)
    this.eventQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
