import type { StudioAgentTraceEvent } from '@chemsmart/studio-protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentTraceTimeline } from '../AgentTraceTimeline'

vi.unmock('@cherrystudio/ui')

function event(
  overrides: Partial<StudioAgentTraceEvent> &
    Pick<StudioAgentTraceEvent, 'eventId' | 'kind' | 'status' | 'summary' | 'title' | 'turnId'>
): StudioAgentTraceEvent {
  return {
    eventId: overrides.eventId,
    extensions: {},
    kind: overrides.kind,
    sequence: overrides.sequence ?? 0,
    sessionId: 'session-1',
    status: overrides.status,
    summary: overrides.summary,
    timestamp: '2026-07-29T00:00:00Z',
    title: overrides.title,
    turnId: overrides.turnId,
    ...(overrides.toolCallId ? { toolCallId: overrides.toolCallId } : {}),
    ...(overrides.toolName ? { toolName: overrides.toolName } : {}),
    ...(overrides.detail ? { detail: overrides.detail } : {})
  }
}

describe('AgentTraceTimeline', () => {
  it('opens the current turn and leaves completed history collapsed', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            eventId: 'event-old',
            kind: 'turn_completed',
            status: 'succeeded',
            summary: 'The earlier task completed.',
            title: 'Completed earlier task',
            turnId: 'turn-old'
          }),
          event({
            eventId: 'event-current',
            kind: 'reasoning_summary',
            status: 'running',
            summary: 'Checking the current molecule.',
            title: 'Understanding the request',
            turnId: 'turn-current'
          })
        ]}
      />
    )

    expect(screen.queryByText('The earlier task completed.')).toBeNull()
    expect(screen.getByText('Checking the current molecule.')).toBeInTheDocument()

    const turns = screen.getAllByRole('button', { expanded: false })
    fireEvent.click(turns[0])
    expect(screen.getByText('The earlier task completed.')).toBeInTheDocument()
  })

  it('shows a balanced tool row and reveals only structured safe detail on demand', () => {
    const traceEvent = event({
      detail: {
        argumentKeys: ['engine', 'moleculeRevision'],
        durationMs: 248,
        resultKeys: ['receiptId'],
        ruleIds: ['exact-molecule-binding'],
        verdict: 'passed'
      },
      eventId: 'event-tool',
      kind: 'tool_succeeded',
      status: 'succeeded',
      summary: 'Validated the immutable molecule snapshot.',
      title: 'Prepared xTB preflight',
      toolCallId: 'tool-call-1',
      toolName: 'prepare_xtb',
      turnId: 'turn-current'
    })
    Object.assign(traceEvent, {
      providerPayload: 'RAW_CHAIN_OF_THOUGHT',
      rawArguments: { path: '/Users/researcher/private.xyz' }
    })

    render(<AgentTraceTimeline events={[traceEvent]} />)

    expect(screen.getByText('prepare_xtb')).toBeInTheDocument()
    expect(screen.getByText('Prepared xTB preflight')).toBeInTheDocument()
    expect(screen.getByText('Validated the immutable molecule snapshot.')).toBeInTheDocument()
    expect(screen.queryByText('engine')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /prepare_xtb/i }))
    expect(screen.getByText('engine')).toBeInTheDocument()
    expect(screen.getByText('receiptId')).toBeInTheDocument()
    expect(screen.getByText('exact-molecule-binding')).toBeInTheDocument()
    expect(screen.queryByText('RAW_CHAIN_OF_THOUGHT')).toBeNull()
    expect(screen.queryByText('/Users/researcher/private.xyz')).toBeNull()
  })

  it('groups one host tool lifecycle into one compact disclosure', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            detail: { argumentKeys: ['engine'] },
            eventId: 'event-tool-start',
            kind: 'tool_started',
            status: 'running',
            summary: 'Starting the deterministic preflight.',
            title: 'Prepare xTB preflight',
            toolCallId: 'tool-call-1',
            toolName: 'prepare_xtb',
            turnId: 'turn-current'
          }),
          event({
            detail: { durationMs: 42, resultKeys: ['receiptId'] },
            eventId: 'event-tool-finish',
            kind: 'tool_succeeded',
            status: 'succeeded',
            summary: 'Prepared a safe preflight receipt.',
            title: 'Preflight ready',
            toolCallId: 'tool-call-1',
            toolName: 'prepare_xtb',
            turnId: 'turn-current'
          })
        ]}
      />
    )

    expect(document.querySelectorAll('[data-trace-event-id]')).toHaveLength(1)
    expect(screen.getByText('Prepare xTB preflight')).toBeInTheDocument()
    expect(screen.getByText('Prepared a safe preflight receipt.')).toBeInTheDocument()
    expect(document.querySelector('[data-trace-status="succeeded"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /prepare_xtb/i }))
    expect(screen.getByText('engine')).toBeInTheDocument()
    expect(screen.getByText('receiptId')).toBeInTheDocument()
  })

  it('auto-opens failed tool detail and labels failure without relying on color', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            detail: { ruleIds: ['project-not-required'], verdict: 'rejected' },
            eventId: 'event-failed',
            kind: 'tool_failed',
            status: 'failed',
            summary: 'The preflight required an unsupported project file.',
            title: 'xTB preflight failed',
            toolCallId: 'tool-call-2',
            toolName: 'prepare_xtb',
            turnId: 'turn-failed'
          })
        ]}
      />
    )

    const card = screen.getByText('xTB preflight failed').closest('article')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByText('project-not-required')).toBeInTheDocument()
    const failedStatus = card?.querySelector('[data-trace-status="failed"]')
    expect(failedStatus).not.toBeNull()
    expect(failedStatus).not.toHaveAccessibleName('')
    expect(within(card as HTMLElement).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('uses a motion-safe running wave with an accessible status label', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            eventId: 'event-running',
            kind: 'tool_progress',
            status: 'running',
            summary: 'Generating a deterministic preflight receipt.',
            title: 'Using prepare_xtb',
            toolCallId: 'tool-call-3',
            toolName: 'prepare_xtb',
            turnId: 'turn-running'
          })
        ]}
      />
    )

    const runningStatus = document.querySelector('[data-trace-status="running"]')
    expect(runningStatus).not.toBeNull()
    expect(runningStatus).not.toHaveAccessibleName('')
    const wave = screen.getByTestId('agent-trace-running-wave')
    expect(wave).toHaveAttribute('aria-hidden', 'true')
    for (const dot of wave.children) {
      expect(dot).toHaveClass('animate-bounce', 'motion-reduce:animate-none')
    }
  })

  it('settles earlier running rows when their turn reaches a terminal event', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            eventId: 'event-started',
            kind: 'turn_started',
            status: 'running',
            summary: 'Started the Agent turn.',
            title: 'Starting',
            turnId: 'turn-complete'
          }),
          event({
            eventId: 'event-reasoning',
            kind: 'reasoning_summary',
            status: 'running',
            summary: 'Prepared the deterministic request.',
            title: 'Reasoning',
            turnId: 'turn-complete'
          }),
          event({
            eventId: 'event-terminal',
            kind: 'turn_completed',
            status: 'succeeded',
            summary: 'The Agent turn completed.',
            title: 'Completed',
            turnId: 'turn-complete'
          })
        ]}
      />
    )

    expect(screen.getByText('Started the Agent turn.')).toBeInTheDocument()

    for (const eventId of ['event-started', 'event-reasoning']) {
      const row = document.querySelector(`[data-trace-event-id="${eventId}"]`)
      expect(row).toHaveAttribute('data-status', 'succeeded')
      expect(row?.querySelector('[data-trace-status="running"]')).toBeNull()
      expect(row?.querySelector('[data-trace-status="succeeded"]')).not.toBeNull()
    }
    expect(screen.queryByTestId('agent-trace-running-wave')).toBeNull()
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
  })
})
