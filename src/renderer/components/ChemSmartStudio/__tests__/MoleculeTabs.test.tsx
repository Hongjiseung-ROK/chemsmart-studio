import type * as CherryStudioUi from '@cherrystudio/ui'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

import { MoleculeTabs } from '../MoleculeTabs'

const documents = {
  activeProjectId: 'project-ethanol',
  documents: [
    { projectId: 'project-ethanol', projectName: 'Ethanol' },
    { projectId: 'project-water', projectName: 'Water dimer' }
  ]
}

function renderTabs(overrides: Partial<Parameters<typeof MoleculeTabs>[0]> = {}) {
  const props = { busy: false, documents, onActivate: vi.fn(), ...overrides }
  render(<MoleculeTabs {...props} />)
  return props
}

describe('MoleculeTabs', () => {
  it('renders one tab per open project and marks the active one', () => {
    renderTabs()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Ethanol', 'Water dimer'])
    expect(screen.getByRole('tab', { name: 'Ethanol' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Water dimer' })).toHaveAttribute('aria-selected', 'false')
  })

  it('switches the active document by handle, never by path', async () => {
    const user = userEvent.setup()
    const props = renderTabs()

    await user.click(screen.getByRole('tab', { name: 'Water dimer' }))

    expect(props.onActivate).toHaveBeenCalledWith('project-water')
  })

  it('ignores a click on the project that is already active', async () => {
    const user = userEvent.setup()
    const props = renderTabs()

    await user.click(screen.getByRole('tab', { name: 'Ethanol' }))

    // Re-activating would restart the editor for no reason, so the strip does not ask.
    expect(props.onActivate).not.toHaveBeenCalled()
  })

  it('makes every tab inert while a project switch is in flight', async () => {
    const user = userEvent.setup()
    const props = renderTabs({ busy: true })

    await user.click(screen.getByRole('tab', { name: 'Water dimer' }))

    expect(props.onActivate).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Water dimer' })).toBeDisabled()
  })

  it('only switches — opening and importing stay with the document section', () => {
    renderTabs()

    // Two controls for one action is how a researcher ends up unsure which one is authoritative.
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('renders the strip before the document list has arrived', () => {
    renderTabs({ documents: null })

    expect(screen.getByTestId('molecule-tabs')).toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toEqual([])
  })
})
