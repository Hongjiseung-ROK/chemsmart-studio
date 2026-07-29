import type { StudioUiEvent } from '@chemsmart/studio-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type StudioUiDelivery, StudioUiEventChannel } from '../StudioUiEventChannel'

function event(sequence: number, overrides: Partial<StudioUiEvent> = {}): StudioUiEvent {
  return {
    eventId: `ui-${sequence}`,
    sessionId: 'session-1',
    sequence,
    timestamp: '2026-07-22T05:00:00.000Z',
    source: 'model_tool',
    kind: 'status',
    payload: { message: `event ${sequence}` },
    extensions: {},
    ...overrides
  }
}

describe('StudioUiEventChannel', () => {
  const broadcast = vi.fn()
  const applyTransientFocus = vi.fn<(_event: StudioUiEvent) => Promise<StudioUiDelivery>>()
  let channel: StudioUiEventChannel

  beforeEach(() => {
    vi.clearAllMocks()
    applyTransientFocus.mockResolvedValue({ accepted: true, eventId: 'ui-focus', sequence: 0 })
    channel = new StudioUiEventChannel(broadcast, applyTransientFocus)
  })

  async function restoreEmptySession(): Promise<void> {
    channel.startReplay('replay-empty', 'session-1', -1, true)
    await channel.finishReplay('replay-empty', { replayed: 0, nextSequence: 0 })
  }

  it('revalidates and broadcasts a trusted live event in sequence', async () => {
    await restoreEmptySession()

    await expect(channel.enqueueLive(event(0))).resolves.toEqual({
      accepted: true,
      eventId: 'ui-0',
      sequence: 0
    })
    expect(broadcast).toHaveBeenCalledWith(event(0))
  })

  it('rejects approval-like and out-of-order events before broadcast', async () => {
    await restoreEmptySession()
    const forged = { ...event(0), kind: 'approval_request' }

    await expect(channel.enqueueLive(forged)).resolves.toMatchObject({
      accepted: false,
      error: { code: 'SCHEMA_INVALID' }
    })
    await expect(channel.enqueueLive(event(2))).resolves.toMatchObject({
      accepted: false,
      error: { code: 'EVENT_OUT_OF_ORDER' }
    })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('returns a stale focus conflict without broadcasting or blocking the next sequence', async () => {
    await restoreEmptySession()
    applyTransientFocus.mockResolvedValueOnce({
      accepted: false,
      eventId: 'ui-0',
      sequence: 0,
      error: { code: 'REVISION_CONFLICT', message: 'stale revision' }
    })
    const focus = event(0, {
      kind: 'molecule_focus',
      payload: {
        message: 'Focus atom.',
        documentId: 'mol-1',
        revision: 2,
        atomIds: ['a-1']
      }
    })

    await expect(channel.enqueueLive(focus)).resolves.toMatchObject({
      accepted: false,
      error: { code: 'REVISION_CONFLICT' }
    })
    await expect(channel.enqueueLive(event(1))).resolves.toMatchObject({ accepted: true, sequence: 1 })
    expect(applyTransientFocus).toHaveBeenCalledWith(focus)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('validates historical replay in order without reapplying native focus', async () => {
    const focus = event(1, {
      kind: 'molecule_focus',
      payload: {
        message: 'Historical focus.',
        documentId: 'mol-1',
        revision: 2,
        bondIds: ['b-1']
      }
    })
    channel.startReplay('replay-1', 'session-1', -1, true)

    await channel.enqueueReplay({ replayId: 'replay-1', event: event(0) })
    await channel.enqueueReplay({ replayId: 'replay-1', event: focus })
    await expect(channel.finishReplay('replay-1', { replayed: 2, nextSequence: 2 })).resolves.toEqual({
      replayed: 2,
      nextSequence: 2
    })

    expect(applyTransientFocus).not.toHaveBeenCalled()
    expect(broadcast.mock.calls.map(([value]) => value.sequence)).toEqual([0, 1])
    await expect(channel.enqueueLive(event(2))).resolves.toMatchObject({ accepted: true, sequence: 2 })
  })

  it('keeps malicious markup inert as validated message text', async () => {
    await restoreEmptySession()
    const markup = '<script>window.api.invoke("approval.allow")</script>'

    await channel.enqueueLive(event(0, { payload: { message: markup } }))

    expect(broadcast.mock.calls[0][0].payload.message).toBe(markup)
  })
})
