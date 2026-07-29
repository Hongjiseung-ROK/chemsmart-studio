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

export interface StudioModelRequest {
  /** The provider-qualified model the operation was authorized against. */
  providerId: string
  apiModelId: string
  messages: readonly unknown[]
  tools?: readonly unknown[]
  timeoutMs?: number
  /** Aborted when the researcher cancels the turn or the operation is superseded. */
  signal: AbortSignal
}

export function resolveStudioModelTimeout(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

export function studioReasoningEffort(providerId: string, apiModelId: string): 'high' | undefined {
  return providerId.toLowerCase() === 'deepseek' || apiModelId.toLowerCase().includes('deepseek') ? 'high' : undefined
}

/**
 * Runs one non-streaming completion and returns the parsed OpenAI body.
 *
 * The sidecar receives exactly what the HTTP route returned before, so this is invisible to it.
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
        stream: false
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

  const body: unknown = await response.json()
  if (!response.ok) {
    throw new JsonRpcFault(-32020, `Host model request returned HTTP ${response.status}`, body)
  }
  return body
}
