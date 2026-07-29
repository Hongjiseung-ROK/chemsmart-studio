import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SettingsPage from '../SettingsPage'

const navigateMock = vi.hoisted(() => vi.fn())

vi.mock('@cherrystudio/ui', () => ({
  MenuItem: ({ icon, label, onClick }: { icon?: ReactNode; label: string; onClick?: () => void }) => (
    <button type="button" data-testid="menu-item" onClick={onClick}>
      {icon}
      {label}
    </button>
  ),
  MenuList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PageHeader: ({ className, title }: { className?: string; title: string }) => (
    <header className={className}>{title}</header>
  )
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/hooks/useMacTransparentWindow', () => ({
  default: () => false
}))

vi.mock('@tanstack/react-router', () => ({
  Outlet: () => null,
  useLocation: () => ({ pathname: '/settings/provider' }),
  useNavigate: () => navigateMock
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'chemsmart_studio.settings.models_and_providers': 'Models & Providers',
        'chemsmart_studio.settings.execution_readiness': 'Execution Readiness',
        'chemsmart_studio.settings.appearance_accessibility': 'Appearance & Accessibility',
        'chemsmart_studio.settings.about_diagnostics': 'About & Diagnostics'
      })[key] ?? key
  })
}))

describe('SettingsPage', () => {
  beforeEach(() => {
    navigateMock.mockReset()
  })

  it('shows only the four Studio settings surfaces', () => {
    render(<SettingsPage />)

    expect(screen.getByText('title.settings').closest('header')).toHaveClass('mb-1')
    expect(screen.getAllByTestId('menu-item')).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'Models & Providers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Execution Readiness' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Appearance & Accessibility' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About & Diagnostics' })).toBeInTheDocument()
  })

  it('opens execution readiness from the Studio settings menu', () => {
    render(<SettingsPage />)
    const dependenciesItem = screen.getByRole('button', { name: 'Execution Readiness' })
    fireEvent.click(dependenciesItem)
    expect(navigateMock).toHaveBeenCalledWith({ to: '/settings/dependencies' })
  })
})
