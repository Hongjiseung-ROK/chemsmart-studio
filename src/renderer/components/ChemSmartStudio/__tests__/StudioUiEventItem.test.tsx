import type { StudioUiEvent, StudioUiEventKind } from '@chemsmart/studio-protocol'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { StudioUiEventItem } from '../StudioUiEventItem'

vi.unmock('@cherrystudio/ui')

function createEvent(kind: StudioUiEventKind, message = 'Working on the molecule'): StudioUiEvent {
  const payload: StudioUiEvent['payload'] = { message }
  if (kind === 'progress') {
    Object.assign(payload, { runId: 'run-1', stepIndex: 2, totalSteps: 10, progress: 0.25 })
  }
  if (kind === 'molecule_focus') {
    Object.assign(payload, { documentId: 'molecule-1', revision: 4, atomIds: ['atom-1'] })
  }

  return {
    eventId: `event-${kind}`,
    sessionId: 'session-1',
    sequence: 0,
    timestamp: '2026-07-22T00:00:00Z',
    source: 'model_tool',
    kind,
    payload,
    extensions: {}
  }
}

describe('StudioUiEventItem', () => {
  it.each([
    ['status', 'status'],
    ['progress', 'progress'],
    ['molecule_focus', 'molecule-focus'],
    ['notice', 'notice']
  ] as const)('maps %s to its fixed component', (kind, component) => {
    const { container } = render(<StudioUiEventItem event={createEvent(kind)} />)

    expect(container.querySelector(`[data-studio-ui-component="${component}"]`)).not.toBeNull()
  })

  it('renders progress only from the validated numeric progress field', () => {
    render(<StudioUiEventItem event={createEvent('progress')} />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '25%')
  })

  it('keeps historical events out of the polite live region', () => {
    render(<StudioUiEventItem event={createEvent('status')} live={false} />)

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('group')).toHaveAttribute('aria-live', 'off')
  })

  it('keeps malicious markup inert and ignores extension rendering instructions', () => {
    const message = '<script>window.api.ipcApi.request("approval.allow")</script><a href="https://evil.test">open</a>'
    const event = createEvent('notice', message)
    event.extensions = {
      'attacker.render': {
        component: 'iframe',
        html: '<button>Approve</button>',
        ipcMethod: 'chemsmart_studio.agent.respond_approval',
        style: 'position: fixed'
      }
    }

    const { container } = render(<StudioUiEventItem event={event} />)

    expect(screen.getByText(message)).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container).not.toHaveTextContent('chemsmart_studio.agent.respond_approval')
  })
})
