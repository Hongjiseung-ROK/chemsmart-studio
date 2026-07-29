import type { StudioAgentTraceEvent } from '@chemsmart/studio-protocol'
import { describe, expect, it, vi } from 'vitest'

import { StudioAgentTraceChannel } from '../StudioAgentTraceChannel'

describe('StudioAgentTraceChannel', () => {
  it('creates trusted identity and a monotonic lifecycle for one tool call', () => {
    const events: StudioAgentTraceEvent[] = []
    const channel = new StudioAgentTraceChannel((event) => events.push(event))

    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'turn_started',
      title: 'ChemSmart Agent',
      summary: 'Understanding the request.'
    })
    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'permission_waiting',
      toolCallId: 'call-1',
      toolName: 'run_local',
      title: 'run_local',
      summary: 'Waiting for exact approval.'
    })
    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'tool_started',
      toolCallId: 'call-1',
      toolName: 'run_local',
      title: 'run_local',
      summary: 'Using the approved tool.',
      detail: { argumentKeys: ['job'] }
    })
    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'tool_succeeded',
      toolCallId: 'call-1',
      toolName: 'run_local',
      title: 'run_local',
      summary: 'Tool completed.',
      detail: { durationMs: 12, resultKeys: ['ok'] }
    })
    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'turn_completed',
      title: 'ChemSmart Agent',
      summary: 'Turn completed.'
    })

    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4])
    expect(events[1]).toMatchObject({ status: 'waiting', turnId: 'turn-1', toolCallId: 'call-1' })
    expect(events[0].eventId).toMatch(/^trace-/)
    expect(events[0].timestamp).toMatch(/Z$/)
  })

  it('rejects forged order, raw fields, paths, and post-terminal events', () => {
    const broadcast = vi.fn()
    const channel = new StudioAgentTraceChannel(broadcast)

    expect(() =>
      channel.emit('turn-1', {
        sessionId: 'session-1',
        kind: 'tool_started',
        toolCallId: 'call-1',
        toolName: 'read_project_yaml',
        title: 'read_project_yaml',
        summary: 'Reading.'
      })
    ).toThrow('active turn')
    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'turn_started',
      title: 'ChemSmart Agent',
      summary: 'Understanding.'
    })
    expect(() =>
      channel.emit('turn-1', {
        sessionId: 'session-1',
        kind: 'reasoning_summary',
        title: 'Reasoning',
        summary: 'Inspect /Users/researcher/private.xyz'
      })
    ).toThrow('path-free')
    expect(() =>
      channel.emit('turn-1', {
        sessionId: 'session-1',
        kind: 'reasoning_summary',
        title: 'Reasoning',
        summary: 'Inspecting the molecule.',
        reasoning_content: 'private chain of thought'
      })
    ).toThrow()
    channel.emit('turn-1', {
      sessionId: 'session-1',
      kind: 'turn_blocked',
      title: 'ChemSmart Agent',
      summary: 'Turn blocked.'
    })
    expect(() =>
      channel.emit('turn-1', {
        sessionId: 'session-1',
        kind: 'reasoning_summary',
        title: 'Reasoning',
        summary: 'Continuing.'
      })
    ).toThrow('active turn')
  })

  it('keeps sequence monotonic across turns in the same Studio session', () => {
    const events: StudioAgentTraceEvent[] = []
    const channel = new StudioAgentTraceChannel((event) => events.push(event))

    for (const turnId of ['turn-1', 'turn-2']) {
      channel.emit(turnId, {
        sessionId: 'session-1',
        kind: 'turn_started',
        title: 'ChemSmart Agent',
        summary: 'Understanding.'
      })
      channel.emit(turnId, {
        sessionId: 'session-1',
        kind: 'turn_completed',
        title: 'ChemSmart Agent',
        summary: 'Completed.'
      })
    }

    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3])
    expect(events.map(({ turnId }) => turnId)).toEqual(['turn-1', 'turn-1', 'turn-2', 'turn-2'])
  })
})
