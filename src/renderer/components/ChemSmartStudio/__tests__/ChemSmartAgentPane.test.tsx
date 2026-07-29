import type { StudioAgentTurnEvent } from '@chemsmart/studio-protocol'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { type AgentComposerSnapshot, type AgentWorkbenchArtifact, ChemSmartAgentPane } from '../ChemSmartAgentPane'

vi.unmock('@cherrystudio/ui')
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false
if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {}
if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}

const initialComposer: AgentComposerSnapshot = {
  selectionEnd: 0,
  selectionStart: 0,
  scrollTop: 0,
  value: ''
}

function traceEvent(overrides: Partial<StudioAgentTurnEvent> = {}): StudioAgentTurnEvent {
  return {
    eventId: 'event-1',
    extensions: {},
    kind: 'reasoning_summary',
    sequence: 1,
    status: 'running',
    summary: 'Checking the visible molecule without exposing private provider data.',
    threadId: 'thread-1',
    timestamp: '2026-07-29T00:00:00Z',
    turnId: 'turn-1',
    ...overrides
  }
}

function PaneHarness({
  artifacts = [],
  pendingDecisionCount = 0,
  turnEvents = [],
  onSubmit = vi.fn()
}: {
  artifacts?: readonly AgentWorkbenchArtifact[]
  pendingDecisionCount?: number
  turnEvents?: readonly StudioAgentTurnEvent[]
  onSubmit?: () => void
}) {
  const [composer, setComposer] = useState(initialComposer)
  return (
    <ChemSmartAgentPane
      activeThreadId="thread-1"
      artifacts={artifacts}
      available
      busy={false}
      capabilities={[
        {
          capability: 'inspect',
          contextRef: 'context-molecule',
          description: 'Reference the molecule visible in the Stage',
          discovery: 'mention',
          key: 'current_molecule',
          label: 'Current molecule'
        },
        {
          capability: 'inspect',
          description: 'Inspect the visible molecule',
          discovery: 'command',
          key: 'inspect',
          label: 'Inspect molecule'
        }
      ]}
      composer={composer}
      failed={false}
      pendingDecisionCount={pendingDecisionCount}
      reviewContent={<p>Trusted decision content</p>}
      reviewRequestId={0}
      threadTitle="Water optimization"
      threads={[
        {
          activityCount: 1,
          agentBound: true,
          createdAt: '2026-07-29T00:00:00Z',
          imported: false,
          threadId: 'thread-1',
          title: 'Water optimization',
          updatedAt: '2026-07-29T00:00:00Z'
        }
      ]}
      turnEvents={turnEvents}
      onClose={vi.fn()}
      onComposerChange={setComposer}
      onCreateThread={vi.fn()}
      onOpenProperties={vi.fn()}
      onRenameThread={vi.fn()}
      onSelectThread={vi.fn()}
      onSubmit={onSubmit}
    />
  )
}

describe('ChemSmartAgentPane', () => {
  it('uses one dedicated Agent conversation without legacy Inspector tabs or mode controls', () => {
    render(<PaneHarness />)

    expect(screen.getByRole('heading', { name: 'chemsmart_studio.agent_workbench.title' })).toBeInTheDocument()
    expect(screen.getByText('Water optimization')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('chemsmart_studio.agent_mode.allow')).toBeNull()
    expect(screen.queryByText('chemsmart_studio.activity.title')).toBeNull()

    for (const name of [
      'chemsmart_studio.agent_workbench.new',
      'chemsmart_studio.agent_workbench.history',
      'chemsmart_studio.agent_workbench.more',
      'common.close'
    ]) {
      expect(screen.getByRole('button', { name })).toHaveClass('size-8')
    }
  })

  it('discovers composer capabilities with the keyboard without submitting or invoking an action', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<PaneHarness onSubmit={onSubmit} />)
    const composer = screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })

    await user.click(composer)
    await user.type(composer, '@cur')

    expect(
      screen.getByRole('listbox', { name: 'chemsmart_studio.agent_workbench.discovery.label' })
    ).toBeInTheDocument()
    expect(screen.getByRole('option')).toHaveTextContent('Current molecule')
    await user.keyboard('{Enter}')

    expect(composer).toHaveValue('@current_molecule ')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows trusted lifecycle summaries and never renders undeclared provider or path fields', () => {
    const event = traceEvent()
    Object.assign(event, {
      providerPayload: 'RAW_CHAIN_OF_THOUGHT',
      rawArguments: { path: '/Users/researcher/private.xyz' }
    })
    render(<PaneHarness turnEvents={[event]} />)

    expect(
      screen.getByText('Checking the visible molecule without exposing private provider data.')
    ).toBeInTheDocument()
    expect(screen.getByText('chemsmart_studio.agent_workbench.reasoning')).toBeInTheDocument()
    expect(screen.queryByText('RAW_CHAIN_OF_THOUGHT')).toBeNull()
    expect(screen.queryByText('/Users/researcher/private.xyz')).toBeNull()
  })

  it('keeps approval waiting inline and returns focus after closing its Review Sheet', async () => {
    render(<PaneHarness pendingDecisionCount={1} />)
    const approval = screen.getByTestId('agent-inline-approval')
    const review = approval.querySelector('button')
    expect(review).not.toBeNull()

    fireEvent.click(review as HTMLButtonElement)
    expect(screen.getByTestId('agent-review-sheet')).toBeInTheDocument()
    expect(screen.getByText('Trusted decision content')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('agent-review-sheet')).getByRole('button', { name: 'common.close' }))

    expect(screen.queryByTestId('agent-review-sheet')).toBeNull()
    await waitFor(() => expect(review).toHaveFocus())
  })

  it('restores the controlled composer selection and scroll position after a presentation rerender', () => {
    const { rerender } = render(<PaneHarness />)
    const composer = screen.getByRole('textbox', {
      name: 'chemsmart_studio.workspace.agent_request'
    }) as HTMLTextAreaElement
    fireEvent.change(composer, {
      target: { selectionEnd: 13, selectionStart: 13, value: 'water request with details' }
    })
    composer.focus()
    composer.setSelectionRange(5, 13)
    composer.scrollTop = 8
    fireEvent.select(composer)
    fireEvent.scroll(composer)

    rerender(<PaneHarness />)
    const restored = screen.getByRole('textbox', {
      name: 'chemsmart_studio.workspace.agent_request'
    }) as HTMLTextAreaElement
    expect(restored).toHaveValue('water request with details')
    expect(restored.selectionStart).toBe(5)
    expect(restored.selectionEnd).toBe(13)
    expect(restored.scrollTop).toBe(8)
  })

  it('opens structured artifacts in the same Review Sheet', async () => {
    const user = userEvent.setup()
    render(
      <PaneHarness
        artifacts={[
          {
            id: 'draft-1',
            review: <p>Three validated draft changes</p>,
            status: 'draft',
            summary: '3 draft changes',
            title: 'Water draft'
          }
        ]}
      />
    )

    await user.click(screen.getByRole('button', { name: /chemsmart_studio\.agent_workbench\.review/ }))
    expect(screen.getByTestId('agent-review-sheet')).toHaveTextContent('Three validated draft changes')
  })
})
