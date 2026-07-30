import { describe, expect, it, vi } from 'vitest'

import { StudioAgentLiveChannel } from '../StudioAgentLiveChannel'

describe('StudioAgentLiveChannel', () => {
  it('issues monotonic transient events for one text block', () => {
    const broadcast = vi.fn()
    const channel = new StudioAgentLiveChannel(broadcast)
    channel.beginTurn('thread-1', 'turn-1')

    channel.beginText('turn-1')
    channel.appendText('turn-1', 'Hello ')
    channel.appendText('turn-1', 'researcher.')
    channel.completeText('turn-1', 'Hello researcher.')

    expect(broadcast.mock.calls.map(([event]) => event.sequence)).toEqual([0, 1, 2, 3])
    expect(broadcast.mock.calls.map(([event]) => event.kind)).toEqual([
      'text_started',
      'text_delta',
      'text_delta',
      'text_completed'
    ])
    expect(new Set(broadcast.mock.calls.map(([event]) => event.blockId)).size).toBe(1)
    expect(broadcast.mock.calls.at(-1)?.[0]).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'Hello researcher.',
      transient: true
    })
  })

  it('terminalizes an interrupted block once and allows a later fallback block', () => {
    const broadcast = vi.fn()
    const channel = new StudioAgentLiveChannel(broadcast)
    channel.beginTurn('thread-1', 'turn-1')
    channel.beginText('turn-1')
    channel.appendText('turn-1', 'Partial ')

    channel.stopText('turn-1')
    channel.stopText('turn-1')
    channel.publishText('turn-1', 'Summary unavailable')

    const completed = broadcast.mock.calls.map(([event]) => event).filter((event) => event.kind === 'text_completed')
    expect(completed.map((event) => event.text)).toEqual(['Response stopped', 'Summary unavailable'])
    expect(completed[0].blockId).not.toBe(completed[1].blockId)
    expect(broadcast.mock.calls.map(([event]) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5])
  })
})
