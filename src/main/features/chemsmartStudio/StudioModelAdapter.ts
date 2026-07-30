import { loggerService } from '@logger'
import { processMessage } from '@main/features/apiGateway/proxyStream'
import { formatGatewayModelId } from '@shared/utils/apiGateway'

import { JsonRpcFault } from './JsonRpcPeer'

const logger = loggerService.withContext('StudioModelAdapter')

/**
 * Resolves a Studio agent model request in this process.
 *
 * Studio used to reach its own provider by starting an HTTP server, minting itself a Bearer token,
 * and `fetch`ing `127.0.0.1:23333/v1/chat/completions` — a loopback to a provider main already held.
 * `processMessage` is the gateway's own request core, so calling it directly keeps the identical
 * OpenAI response shape the Python sidecar parses while deleting the socket, the token and the
 * server from the Studio path. Cherry's provider registry, `aiCore` and chat path are untouched:
 * this reuses them rather than reimplementing them.
 */

/** Matches the gateway's own clamp: a Studio turn may not wait indefinitely, nor time out instantly. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_LIVE_TEXT_LENGTH = 20_000

type OpenAiToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type OpenAiStreamChoice = {
  index?: unknown
  delta?: unknown
  finish_reason?: unknown
}

type OpenAiStreamChunk = {
  id?: unknown
  object?: unknown
  created?: unknown
  model?: unknown
  choices?: unknown
  usage?: unknown
  error?: unknown
}

type ToolCallAccumulator = {
  id: string
  name: string
  arguments: string
}

export interface StudioModelStreamObserver {
  onTextStarted(): void
  onTextDelta(delta: string): void
  onTextCompleted(text: string): void
  onTextStopped(): void
}

export interface StudioModelRequest {
  /** The provider-qualified model the operation was authorized against. */
  providerId: string
  apiModelId: string
  messages: readonly unknown[]
  tools?: readonly unknown[]
  timeoutMs?: number
  /** Aborted when the researcher cancels the turn or the operation is superseded. */
  signal: AbortSignal
  /** Optional transient renderer projection. Provider-private reasoning never reaches it. */
  observer?: StudioModelStreamObserver
  /** Final narration may describe verified artifacts but must not restate scientific values. */
  publicTextPolicy?: 'advisory' | 'narration'
}

export function resolveStudioModelTimeout(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

export function studioReasoningEffort(providerId: string, apiModelId: string): 'high' | undefined {
  return providerId.toLowerCase() === 'deepseek' || apiModelId.toLowerCase().includes('deepseek') ? 'high' : undefined
}

const PRIVATE_FIELD = /\b(?:reasoning_content|chain[- ]of[- ]thought|raw reasoning|provider payload)\b/i
const FILE_URI = /^file:(?:\/\/)?(?:\/|[A-Za-z]:[\\/])/i
const POSIX_PATH = /^\/(?!\/)\S+/
const WINDOWS_PATH = /^[A-Za-z]:[\\/]\S+/
const UNC_PATH = /^(?:\\\\|\/\/)\S+[\\/]\S+/
const CREDENTIAL = /^(?:sk|cs-sk)-[A-Za-z0-9_-]{12,}$/
const SCIENTIFIC_VALUE = /(?:^|[^\p{L}])[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?:[^\p{L}]|$)/u

class SafeLiveText {
  private pending = ''
  private rendered = ''
  private started = false

  constructor(
    private readonly observer: StudioModelStreamObserver | undefined,
    private readonly policy: 'advisory' | 'narration'
  ) {}

  push(delta: string): void {
    if (!delta || !this.observer || this.rendered.length >= MAX_LIVE_TEXT_LENGTH) return
    this.pending += delta
    let whitespace = this.pending.search(/\s/)
    while (whitespace >= 0) {
      let end = whitespace + 1
      while (end < this.pending.length && /\s/.test(this.pending[end])) end += 1
      this.emit(this.pending.slice(0, end))
      this.pending = this.pending.slice(end)
      whitespace = this.pending.search(/\s/)
    }
  }

  finish(): string {
    if (this.pending) {
      this.emit(this.pending)
      this.pending = ''
    }
    if (this.started) this.observer?.onTextCompleted(this.rendered)
    return this.rendered
  }

  stop(): void {
    this.pending = ''
    if (this.observer) this.observer.onTextStopped()
  }

  private emit(segment: string): void {
    if (!this.observer || this.rendered.length >= MAX_LIVE_TEXT_LENGTH) return
    const trailingWhitespace = segment.match(/\s+$/)?.[0] ?? ''
    const token = segment.slice(0, segment.length - trailingWhitespace.length)
    const unsafe =
      PRIVATE_FIELD.test(token) ||
      FILE_URI.test(token) ||
      POSIX_PATH.test(token) ||
      WINDOWS_PATH.test(token) ||
      UNC_PATH.test(token) ||
      CREDENTIAL.test(token) ||
      (this.policy === 'narration' && SCIENTIFIC_VALUE.test(token))
    const safeToken = unsafe ? '[private content withheld]' : token
    const remaining = MAX_LIVE_TEXT_LENGTH - this.rendered.length
    const safeSegment = `${safeToken}${trailingWhitespace}`.slice(0, remaining)
    if (!safeSegment) return
    if (!this.started) {
      this.started = true
      this.observer.onTextStarted()
    }
    this.rendered += safeSegment
    this.observer.onTextDelta(safeSegment)
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function appendIncrement(current: string, incoming: unknown): string {
  if (typeof incoming !== 'string' || incoming.length === 0) return current
  if (incoming === current || current.endsWith(incoming)) return current
  if (incoming.startsWith(current)) return incoming
  return current + incoming
}

function mergeToolCalls(value: unknown, tools: Map<number, ToolCallAccumulator>): void {
  if (!Array.isArray(value)) return
  for (const raw of value) {
    const call = objectValue(raw)
    if (!call) continue
    const index =
      typeof call.index === 'number' && Number.isInteger(call.index) && call.index >= 0 ? call.index : tools.size
    const current = tools.get(index) ?? { id: '', name: '', arguments: '' }
    const fn = objectValue(call.function)
    current.id = appendIncrement(current.id, call.id)
    current.name = appendIncrement(current.name, fn?.name)
    current.arguments = appendIncrement(current.arguments, fn?.arguments)
    tools.set(index, current)
  }
}

function streamFailure(value: unknown): Error | null {
  const error = objectValue(value)
  if (!error) return null
  const message = typeof error.message === 'string' ? error.message : 'Host model stream failed'
  return new Error(message)
}

/**
 * Consumes the gateway's OpenAI SSE output without persisting provider-private chunks.
 * The returned object is the canonical completion expected by the Python tool loop.
 */
export async function consumeOpenAiStudioStream(
  response: Response,
  observer?: StudioModelStreamObserver,
  publicTextPolicy: 'advisory' | 'narration' = 'advisory'
): Promise<unknown> {
  if (!response.body) throw new Error('Host model stream has no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const liveText = new SafeLiveText(observer, publicTextPolicy)
  const tools = new Map<number, ToolCallAccumulator>()
  let buffer = ''
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let content = ''
  let reasoningContent = ''
  let finishReason: string | null = null
  let usage: unknown

  const consumeFrame = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    const chunk = JSON.parse(data) as OpenAiStreamChunk
    const failure = streamFailure(chunk.error)
    if (failure) throw failure
    if (typeof chunk.id === 'string') id ||= chunk.id
    if (typeof chunk.model === 'string') model ||= chunk.model
    if (typeof chunk.created === 'number' && Number.isFinite(chunk.created)) created = chunk.created
    if (chunk.usage !== undefined) usage = chunk.usage
    if (!Array.isArray(chunk.choices)) return
    for (const rawChoice of chunk.choices as OpenAiStreamChoice[]) {
      const choice = objectValue(rawChoice)
      if (!choice) continue
      const delta = objectValue(choice.delta)
      if (delta) {
        if (typeof delta.content === 'string') {
          content += delta.content
          liveText.push(delta.content)
        }
        if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content
        mergeToolCalls(delta.tool_calls, tools)
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        consumeFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    if (buffer.trim()) consumeFrame(buffer)
    liveText.finish()
  } catch (error) {
    liveText.stop()
    throw error
  } finally {
    reader.releaseLock()
  }

  const toolCalls: OpenAiToolCall[] = [...tools.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    }))
  return {
    id: id || 'chatcmpl-studio',
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          refusal: null,
          // DeepSeek requires this on the next tool subturn. The sidecar strips it from
          // durable history and evidence before the turn terminalizes.
          ...(reasoningContent && toolCalls.length > 0 ? { reasoning_content: reasoningContent } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        logprobs: null
      }
    ],
    ...(usage !== undefined ? { usage } : {})
  }
}

/**
 * Runs one streaming completion and returns the reconstructed OpenAI body.
 *
 * The sidecar receives exactly the complete shape it consumed before, while the renderer
 * sees only the bounded public assistant text deltas.
 */
export async function generateStudioModelResponse(request: StudioModelRequest): Promise<unknown> {
  const timeoutMs = resolveStudioModelTimeout(request.timeoutMs)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, timeoutSignal])

  let response: Response
  try {
    response = await processMessage({
      params: {
        model: formatGatewayModelId(request.providerId, request.apiModelId),
        messages: [...request.messages],
        tools: request.tools && request.tools.length > 0 ? [...request.tools] : undefined,
        reasoning_effort: studioReasoningEffort(request.providerId, request.apiModelId),
        stream: true
      },
      inputFormat: 'openai',
      outputFormat: 'openai',
      signal
    })
  } catch (error) {
    // Cancellation and timeout are ordinary outcomes of a turn, not provider faults, and the
    // sidecar distinguishes them by code.
    if (request.signal.aborted) throw new JsonRpcFault(-32003, 'Host model request was cancelled')
    if (timeoutSignal.aborted) throw new JsonRpcFault(-32002, 'Host model request timed out')
    logger.error('Studio model request failed', error as Error)
    throw new JsonRpcFault(-32020, 'Host model request failed', {
      message: error instanceof Error ? error.message : String(error)
    })
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({ error: { message: 'Host model request failed' } }))
    throw new JsonRpcFault(-32020, `Host model request returned HTTP ${response.status}`, body)
  }
  try {
    return await consumeOpenAiStudioStream(response, request.observer, request.publicTextPolicy)
  } catch (error) {
    if (request.signal.aborted) throw new JsonRpcFault(-32003, 'Host model request was cancelled')
    if (timeoutSignal.aborted) throw new JsonRpcFault(-32002, 'Host model request timed out')
    logger.error('Studio model stream failed', error as Error)
    throw new JsonRpcFault(-32020, 'Host model stream failed')
  }
}
