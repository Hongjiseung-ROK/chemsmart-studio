import type { StudioAgentTurnEvent } from '@chemsmart/studio-protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentTraceTimeline } from '../AgentTraceTimeline'

vi.unmock('@cherrystudio/ui')

function event(
  overrides: Partial<StudioAgentTurnEvent> &
    Pick<StudioAgentTurnEvent, 'eventId' | 'kind' | 'status' | 'summary' | 'turnId'>
): StudioAgentTurnEvent {
  return {
    eventId: overrides.eventId,
    extensions: {},
    kind: overrides.kind,
    sequence: overrides.sequence ?? 0,
    status: overrides.status,
    summary: overrides.summary,
    threadId: 'thread-1',
    timestamp: '2026-07-29T00:00:00Z',
    turnId: overrides.turnId,
    ...(overrides.tool ? { tool: overrides.tool } : {}),
    ...(overrides.answer ? { answer: overrides.answer } : {}),
    ...(overrides.artifact ? { artifact: overrides.artifact } : {}),
    ...(overrides.outcome ? { outcome: overrides.outcome } : {})
  }
}

describe('AgentTraceTimeline', () => {
  it('keeps terminal history collapsed and the current turn expanded', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            eventId: 'old-request',
            kind: 'user_message',
            status: 'running',
            summary: 'Earlier request',
            turnId: 'turn-old'
          }),
          event({
            eventId: 'old-terminal',
            kind: 'turn_terminal',
            outcome: 'completed',
            status: 'succeeded',
            summary: 'Earlier task completed',
            turnId: 'turn-old'
          }),
          event({
            eventId: 'current-request',
            kind: 'user_message',
            status: 'running',
            summary: 'Inspect the current molecule',
            turnId: 'turn-current'
          }),
          event({
            eventId: 'current-reasoning',
            kind: 'reasoning_summary',
            status: 'running',
            summary: 'Checking the visible molecule',
            turnId: 'turn-current'
          })
        ]}
      />
    )

    expect(screen.queryByText('Earlier task completed')).toBeNull()
    expect(screen.getByText('Checking the visible molecule')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Earlier request/ }))
    expect(screen.getByText('Earlier task completed')).toBeInTheDocument()
  })

  it('shows one safe tool disclosure with motion-safe progress', () => {
    const tool = {
      argumentKeys: ['engine'],
      durationMs: 248,
      resultKeys: ['receiptId'],
      ruleIds: ['exact-molecule-binding'],
      toolCallId: 'tool-1',
      toolName: 'prepare_xtb',
      purpose: 'Prepare xTB preflight',
      verdict: 'passed'
    }
    const turnEvent = event({
      eventId: 'tool-event',
      kind: 'tool_progress',
      status: 'running',
      summary: 'Validating the immutable molecule snapshot',
      tool,
      turnId: 'turn-current'
    })
    Object.assign(turnEvent, {
      providerPayload: 'RAW_CHAIN_OF_THOUGHT',
      rawArguments: { path: '/Users/researcher/private.xyz' }
    })

    render(<AgentTraceTimeline events={[turnEvent]} />)

    expect(screen.getByText('prepare_xtb')).toBeInTheDocument()
    expect(screen.getByTestId('agent-trace-running-wave')).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(screen.getByRole('button', { name: /prepare_xtb/i }))
    expect(screen.getByText('engine')).toBeInTheDocument()
    expect(screen.getByText('receiptId')).toBeInTheDocument()
    expect(screen.queryByText('RAW_CHAIN_OF_THOUGHT')).toBeNull()
    expect(screen.queryByText('/Users/researcher/private.xyz')).toBeNull()
  })

  it('auto-opens an actual failure and labels it without color alone', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            eventId: 'failed-tool',
            kind: 'tool_failed',
            status: 'failed',
            summary: 'The preflight failed validation',
            tool: {
              ruleIds: ['project-not-required'],
              toolCallId: 'tool-2',
              toolName: 'prepare_xtb',
              purpose: 'Prepare xTB preflight',
              verdict: 'rejected'
            },
            turnId: 'turn-failed'
          })
        ]}
      />
    )

    const card = screen.getByText('The preflight failed validation').closest('article')
    expect(card).not.toBeNull()
    expect(within(card as HTMLElement).getByText('project-not-required')).toBeInTheDocument()
    expect(within(card as HTMLElement).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    const status = card?.querySelector('.border-destructive')
    expect(status).not.toBeNull()
    expect(status).not.toHaveTextContent('')
  })

  it('renders structured scientific identity and energy without Markdown parsing', () => {
    render(
      <AgentTraceTimeline
        events={[
          event({
            artifact: {
              artifactId: 'artifact-1',
              calculationKind: 'single_point',
              charge: 0,
              documentId: 'water',
              energy: { unit: 'hartree', value: -5.0 },
              engine: 'xtb',
              extensions: {},
              geometryHash: `sha256:${'a'.repeat(64)}`,
              heading: 'xTB result',
              kind: 'trajectory_result',
              method: 'GFN2-xTB',
              multiplicity: 1,
              revision: 2,
              runId: 'run-1',
              summary: 'Calculation completed'
            },
            eventId: 'artifact-event',
            kind: 'artifact_published',
            status: 'succeeded',
            summary: 'Calculation completed',
            turnId: 'turn-result'
          })
        ]}
      />
    )

    expect(screen.getByText('-5 hartree')).toBeInTheDocument()
    expect(screen.getByText(/xtb · GFN2-xTB · single_point/)).toBeInTheDocument()
    expect(screen.queryByText('| Field | Value |')).toBeNull()
  })
})
