import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StudioRouteHost } from '../StudioRouteHost'

const closeTab = vi.fn()
const updateTab = vi.fn()
const useMainWindowNavigation = vi.fn()
let activeTab: { id: string; type: 'route'; url: string; title: string; lastAccessTime: number } | undefined

vi.mock('@renderer/hooks/tab', () => ({
  useMainWindowNavigation: () => useMainWindowNavigation(),
  useTabs: () => ({ activeTab, closeTab, updateTab })
}))

vi.mock('@renderer/components/layout/TabRouter', () => ({
  TabRouter: ({ tab }: { tab: { url: string } }) => <div data-testid="settings-router">{tab.url}</div>
}))

vi.mock('../StudioWorkbench', () => ({
  StudioWorkbench: () => <div data-testid="studio-workbench" />
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('StudioRouteHost', () => {
  beforeEach(() => {
    closeTab.mockReset()
    updateTab.mockReset()
    useMainWindowNavigation.mockReset()
    activeTab = {
      id: 'studio',
      type: 'route',
      url: '/app/chemsmart',
      title: 'ChemSmart Studio',
      lastAccessTime: 1
    }
  })

  it('keeps the Studio workbench as the normal product surface', () => {
    render(<StudioRouteHost />)

    expect(screen.getByTestId('studio-workbench')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-router')).not.toBeInTheDocument()
    expect(useMainWindowNavigation).toHaveBeenCalledOnce()
  })

  it('renders settings without the legacy app shell and returns to Studio', () => {
    activeTab = {
      id: 'settings',
      type: 'route',
      url: '/settings/provider?id=deepseek',
      title: 'Settings',
      lastAccessTime: 2
    }

    render(<StudioRouteHost />)

    expect(screen.getByTestId('settings-router')).toHaveTextContent('/settings/provider?id=deepseek')
    expect(screen.queryByTestId('studio-workbench')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common.back' }))
    expect(closeTab).toHaveBeenCalledWith('settings')
  })
})
