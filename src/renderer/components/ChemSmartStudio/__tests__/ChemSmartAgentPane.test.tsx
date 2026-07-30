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
  value: '',
  workflow: 'general'
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
  busy = false,
  pendingDecisionCount = 0,
  turnEvents = [],
  onQueue = vi.fn(),
  onSteer = vi.fn(),
  onStop = vi.fn(),
  onSubmit = vi.fn()
}: {
  artifacts?: readonly AgentWorkbenchArtifact[]
  busy?: boolean
  pendingDecisionCount?: number
  turnEvents?: readonly StudioAgentTurnEvent[]
  onQueue?: () => void
  onSteer?: () => void
  onStop?: () => void
  onSubmit?: () => void
}) {
  const [composer, setComposer] = useState(initialComposer)
  return (
    <ChemSmartAgentPane
      activeThreadId="thread-1"
      artifacts={artifacts}
      available
      busy={busy}
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
          capability: 'plan',
          description: 'Prepare project YAML for review',
          discovery: 'task',
          key: 'project_setup',
          label: 'Project setup',
          workflow: 'project_setup'
        }
      ]}
      composer={composer}
      preTurnNotice={false}
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
      onQueue={onQueue}
      onRenameThread={vi.fn()}
      onSelectThread={vi.fn()}
      onSteer={onSteer}
      onStop={onStop}
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
    expect(screen.getByTestId('agent-workflow-chip')).toHaveTextContent('@[general]')
    expect(within(screen.getByTestId('agent-workflow-chip')).queryByRole('button')).toBeNull()

    for (const name of [
      'chemsmart_studio.agent_workbench.new',
      'chemsmart_studio.agent_workbench.history',
      'chemsmart_studio.agent_workbench.more',
      'common.close'
    ]) {
      expect(screen.getByRole('button', { name })).toHaveClass('size-8')
    }
  })

  it('replaces the immutable workflow chip through the task picker without inserting it into the prompt', async () => {
    const user = userEvent.setup()
    render(<PaneHarness />)
    const composer = screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })

    await user.click(composer)
    fireEvent.change(composer, {
      target: { selectionEnd: 5, selectionStart: 5, value: '@[pro' }
    })
    const option = screen.getByRole('option')
    expect(option).toHaveTextContent('@[project-setup]')
    await user.click(option)

    expect(composer).toHaveValue('')
    expect(screen.getByTestId('agent-workflow-chip')).toHaveTextContent('@[project-setup]')
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
    await user.click(
      screen.getByRole('button', {
        name: 'chemsmart_studio.agent_workbench.discovery.remove'
      })
    )
    expect(composer).toHaveValue('')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('closes discovery with Escape without mutating the composer and exposes combobox relationships', async () => {
    const user = userEvent.setup()
    render(<PaneHarness />)
    const composer = screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })

    await user.click(composer)
    fireEvent.change(composer, {
      target: { selectionEnd: 5, selectionStart: 5, value: '@[pro' }
    })
    expect(composer).toHaveAttribute('aria-expanded', 'true')
    expect(composer).toHaveAttribute('aria-controls', 'chemsmart-agent-suggestions')
    expect(composer).toHaveAttribute('aria-activedescendant', 'chemsmart-agent-suggestion-0')

    await user.keyboard('{Escape}')
    expect(composer).toHaveValue('@[pro')
    expect(composer).toHaveFocus()
    expect(composer).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps the composer editable while busy and offers explicit Stop, Steer, and Queue actions', async () => {
    const user = userEvent.setup()
    const onQueue = vi.fn()
    const onSteer = vi.fn()
    const onStop = vi.fn()
    render(<PaneHarness busy onQueue={onQueue} onSteer={onSteer} onStop={onStop} />)
    const composer = screen.getByRole('textbox', { name: 'chemsmart_studio.workspace.agent_request' })

    await user.type(composer, 'Inspect the next frame')
    expect(composer).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.control.steer' }))
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.control.queue' }))
    await user.click(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.control.stop' }))

    expect(onSteer).toHaveBeenCalledOnce()
    expect(onQueue).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('searches project conversation history without changing the active thread', async () => {
    const user = userEvent.setup()
    render(<PaneHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'chemsmart_studio.agent_workbench.history' }))
    const search = screen.getByRole('textbox', { name: 'chemsmart_studio.agent_workbench.history_search' })

    await user.type(search, 'missing')
    expect(screen.getByText('chemsmart_studio.agent_workbench.history_no_results')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Water optimization/ })).toBeNull()
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
    expect(screen.queryByText('chemsmart_studio.agent_workbench.reasoning')).toBeNull()
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
