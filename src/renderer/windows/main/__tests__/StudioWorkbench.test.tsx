import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StudioWorkbench } from '../StudioWorkbench'

const setPinnedTabs = vi.fn()

vi.mock('@renderer/components/ChemSmartStudio', () => ({
  ChemSmartWorkspace: ({ sessionId }: { sessionId: string }) => (
    <div data-session-id={sessionId} data-testid="studio-workspace" />
  ),
  useResearchProjectSession: () => ({ activeThreadId: 'studio-session', failed: false })
}))

vi.mock('@renderer/data/hooks/useCache', () => ({
  usePersistCache: () => [[{ id: 'legacy-chat' }], setPinnedTabs]
}))

vi.mock('@renderer/hooks/useMacTransparentWindow', () => ({
  default: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('StudioWorkbench', () => {
  beforeEach(() => {
    setPinnedTabs.mockReset()
  })

  it('renders only the Studio product shell and clears legacy persisted tabs', async () => {
    render(<StudioWorkbench />)

    expect(screen.getByTestId('studio-product-shell')).toHaveAttribute('data-product-route', '/app/chemsmart')
    expect(screen.getByTestId('studio-workspace')).toHaveAttribute('data-session-id', 'studio-session')
    expect(screen.queryByText(/Chat|Work|Translation|Paintings|Knowledge Base|Launchpad/)).toBeNull()
    await waitFor(() => expect(setPinnedTabs).toHaveBeenCalled())
    const reconcile = setPinnedTabs.mock.calls[0][0] as (tabs: unknown[]) => unknown[]
    expect(reconcile([{ id: 'legacy-chat' }])).toEqual([])
  })

  it('shows a lease-free retirement message for an assigned detached window', () => {
    render(<StudioWorkbench active={false} />)

    expect(screen.queryByTestId('studio-workspace')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('chemsmart_studio.ide.detached_retired')
  })
})
