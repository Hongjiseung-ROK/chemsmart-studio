import '@testing-library/jest-dom/vitest'

import type { StudioAgentTurnEvent } from '@chemsmart/studio-protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentTraceTimeline, type StudioAgentLiveProjection } from '../AgentTraceTimeline'

vi.unmock('@cherrystudio/ui')
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; duration?: string }) => {
      if (key === 'chemsmart_studio.agent_trace.tools_running') return `${options?.count} tools in use`
      if (key === 'chemsmart_studio.agent_trace.tools_used') {
        return `${options?.count} tools used · ${options?.duration}`
      }
      return key
    }
  })
}))

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
    timestamp: '2026-07-30T00:00:00Z',
    turnId: overrides.turnId,
    ...(overrides.tool ? { tool: overrides.tool } : {}),
    ...(overrides.answer ? { answer: overrides.answer } : {}),
    ...(overrides.artifact ? { artifact: overrides.artifact } : {}),
    ...(overrides.outcome ? { outcome: overrides.outcome } : {})
  }
}

function live(
  overrides: Partial<StudioAgentLiveProjection> &
    Pick<StudioAgentLiveProjection, 'blockId' | 'kind' | 'sequence' | 'turnId'>
): StudioAgentLiveProjection {
  return { threadId: 'thread-1', transient: true, ...overrides }
}

const request = event({
  eventId: 'request',
  kind: 'user_message',
  sequence: 1,
  status: 'running',
  summary: '@[general] Inspect the visible water molecule',
  turnId: 'turn-1'
})

describe('AgentTraceTimeline', () => {
  it('renders the workflow tag separately from the user message', () => {
    render(<AgentTraceTimeline events={[request]} />)

    expect(screen.getByTestId('agent-workflow-tag')).toHaveTextContent('@[general]')
    expect(screen.getByText('Inspect the visible water molecule')).toBeInTheDocument()
  })

  it('streams safe Markdown and replaces transient prose with the canonical answer', () => {
    const { container, rerender } = render(
      <AgentTraceTimeline
        events={[request]}
        liveEvents={[
          live({ blockId: 'answer', kind: 'text_started', sequence: 1, turnId: 'turn-1' }),
          live({
            blockId: 'answer',
            kind: 'text_delta',
            sequence: 2,
            text: '### Draft\n\nWater has **three atoms**. <script>ignore()</script>',
            turnId: 'turn-1'
          })
        ]}
      />
    )

    expect(screen.getByRole('heading', { name: 'Draft' })).toBeInTheDocument()
    expect(container.querySelector('[data-streamdown="strong"]')).toHaveTextContent('three atoms')
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByLabelText('chemsmart_studio.agent_trace.assistant_response')).toHaveAttribute(
      'data-streaming',
      'true'
    )

    const canonical = event({
      answer: {
        answerId: 'answer-1',
        extensions: {},
        heading: 'Water inspection',
        sections: [
          { heading: 'Finding', kind: 'finding', summary: 'Water is neutral and ready for review.' },
          {
            heading: 'Duplicate',
            kind: 'evidence',
            summary: 'The canonical molecule contains three atoms.'
          }
        ],
        summary: 'The canonical molecule contains three atoms.'
      },
      eventId: 'answer',
      kind: 'answer_published',
      sequence: 2,
      status: 'succeeded',
      summary: 'Published the verified answer',
      turnId: 'turn-1'
    })
    Object.assign(canonical, {
      providerPayload: 'RAW_CHAIN_OF_THOUGHT',
      rawArguments: { path: '/Users/researcher/private.xyz' }
    })
    rerender(<AgentTraceTimeline events={[request, canonical]} liveEvents={[]} />)

    expect(screen.getByRole('heading', { name: 'Water inspection' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull()
    expect(screen.getAllByText('The canonical molecule contains three atoms.')).toHaveLength(1)
    expect(screen.queryByText('RAW_CHAIN_OF_THOUGHT')).toBeNull()
    expect(screen.queryByText('/Users/researcher/private.xyz')).toBeNull()
  })

  it('preserves safe lists, emphasis, and inline code without duplicating a Finding heading', () => {
    render(
      <AgentTraceTimeline
        events={[
          request,
          event({
            answer: {
              answerId: 'answer-markdown',
              extensions: {},
              heading: 'Finding',
              sections: [
                {
                  heading: 'Finding',
                  kind: 'finding',
                  summary: 'No calculation was started.'
                }
              ],
              summary: '- **Neutral molecule**\n- Formula: `H2O`'
            },
            eventId: 'answer-markdown',
            kind: 'answer_published',
            sequence: 2,
            status: 'succeeded',
            summary: 'Published the verified answer',
            turnId: 'turn-1'
          }),
          event({
            eventId: 'terminal-completed',
            kind: 'turn_terminal',
            outcome: 'completed',
            sequence: 3,
            status: 'succeeded',
            summary: 'Agent turn completed',
            turnId: 'turn-1'
          })
        ]}
      />
    )

    expect(screen.getAllByRole('heading', { name: 'Finding' })).toHaveLength(1)
    expect(screen.getByText('Neutral molecule')).toBeInTheDocument()
    expect(screen.getByText('H2O')).toBeInTheDocument()
    expect(screen.getByText('No calculation was started.')).toBeInTheDocument()
    expect(document.querySelector('.text-error-text')).toBeNull()
  })

  it('groups actual tool starts and collapses successful activity when narration begins', () => {
    const toolOne = {
      durationMs: 400,
      toolCallId: 'tool-1',
      toolName: 'analyze_current_molecule',
      purpose: 'Inspect the visible molecule'
    }
    const toolTwo = {
      durationMs: 1400,
      toolCallId: 'tool-2',
      toolName: 'recommend_method',
      purpose: 'Recommend a bounded method'
    }
    render(
      <AgentTraceTimeline
        events={[
          request,
          event({
            eventId: 'tool-1-start',
            kind: 'tool_started',
            sequence: 2,
            status: 'running',
            summary: 'Inspecting the molecule',
            tool: toolOne,
            turnId: 'turn-1'
          }),
          event({
            eventId: 'tool-1-done',
            kind: 'tool_succeeded',
            sequence: 3,
            status: 'succeeded',
            summary: 'Molecule inspected',
            tool: toolOne,
            turnId: 'turn-1'
          }),
          event({
            eventId: 'tool-2-start',
            kind: 'tool_started',
            sequence: 4,
            status: 'running',
            summary: 'Selecting a method',
            tool: toolTwo,
            turnId: 'turn-1'
          }),
          event({
            eventId: 'tool-2-done',
            kind: 'tool_succeeded',
            sequence: 5,
            status: 'succeeded',
            summary: 'Method recommended',
            tool: toolTwo,
            turnId: 'turn-1'
          })
        ]}
        liveEvents={[
          live({ blockId: 'answer', kind: 'text_started', sequence: 1, turnId: 'turn-1' }),
          live({
            blockId: 'answer',
            kind: 'text_delta',
            sequence: 2,
            text: 'The molecule is ready.',
            turnId: 'turn-1'
          })
        ]}
      />
    )

    const group = screen.getByRole('button', { name: '2 tools used · 1.8 s' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('analyze_current_molecule')).toBeNull()
    fireEvent.click(group)
    expect(screen.getByText('analyze_current_molecule')).toBeInTheDocument()
    expect(screen.getByText('recommend_method')).toBeInTheDocument()
    expect(screen.queryByText('chemsmart_studio.trusted_activity.status.completed')).toBeNull()
  })

  it('keeps running and failed tool activity open with non-color status', () => {
    const { rerender } = render(
      <AgentTraceTimeline
        events={[
          request,
          event({
            eventId: 'tool-start',
            kind: 'tool_started',
            sequence: 2,
            status: 'running',
            summary: 'Preparing the immutable snapshot',
            tool: {
              toolCallId: 'tool-1',
              toolName: 'prepare_xtb',
              purpose: 'Prepare xTB preflight'
            },
            turnId: 'turn-1'
          })
        ]}
      />
    )

    expect(screen.getByRole('button', { name: '1 tools in use' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('agent-trace-running-wave')).toHaveLength(1)
    expect(screen.getByText('chemsmart_studio.optimization.status.running')).toBeInTheDocument()
    expect(document.querySelector('.motion-reduce\\:block')).not.toBeNull()

    rerender(
      <AgentTraceTimeline
        events={[
          request,
          event({
            eventId: 'tool-start',
            kind: 'tool_started',
            sequence: 2,
            status: 'running',
            summary: 'Preparing the immutable snapshot',
            tool: {
              toolCallId: 'tool-1',
              toolName: 'prepare_xtb',
              purpose: 'Prepare xTB preflight'
            },
            turnId: 'turn-1'
          }),
          event({
            eventId: 'tool-failed',
            kind: 'tool_failed',
            sequence: 3,
            status: 'failed',
            summary: 'Preflight validation failed',
            tool: {
              ruleIds: ['exact-molecule-binding'],
              toolCallId: 'tool-1',
              toolName: 'prepare_xtb',
              purpose: 'Prepare xTB preflight',
              verdict: 'rejected'
            },
            turnId: 'turn-1'
          })
        ]}
      />
    )

    expect(screen.getByRole('button', { name: '1 tools used · 0 ms' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('chemsmart_studio.trusted_activity.status.failed')).toBeInTheDocument()
    expect(screen.getByText('exact-molecule-binding')).toBeInTheDocument()
  })

  it('reconciles completed live text and announces sentence boundaries', async () => {
    const { rerender } = render(
      <AgentTraceTimeline
        events={[request]}
        liveEvents={[live({ blockId: 'answer', kind: 'text_delta', sequence: 1, text: 'Water is', turnId: 'turn-1' })]}
      />
    )
    const liveRegion = screen.getByTestId('agent-live-region')
    expect(liveRegion).toHaveTextContent('')

    rerender(
      <AgentTraceTimeline
        events={[request]}
        liveEvents={[
          live({ blockId: 'answer', kind: 'text_delta', sequence: 1, text: 'Water is', turnId: 'turn-1' }),
          live({ blockId: 'answer', kind: 'text_delta', sequence: 2, text: ' ready.', turnId: 'turn-1' })
        ]}
      />
    )
    await waitFor(() => expect(liveRegion).toHaveTextContent('Water is ready.'))

    rerender(
      <AgentTraceTimeline
        events={[request]}
        liveEvents={[
          live({
            blockId: 'answer',
            kind: 'text_delta',
            sequence: 1,
            text: 'Partial response',
            turnId: 'turn-1'
          }),
          live({
            blockId: 'answer',
            kind: 'text_completed',
            sequence: 2,
            text: 'Response stopped',
            turnId: 'turn-1'
          })
        ]}
      />
    )
    expect(screen.queryByText('Partial response')).toBeNull()
    expect(screen.getByLabelText('chemsmart_studio.agent_trace.assistant_response')).toHaveTextContent(
      'Response stopped'
    )
  })

  it('renders structured scientific identity and energy without ASCII tables', () => {
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
