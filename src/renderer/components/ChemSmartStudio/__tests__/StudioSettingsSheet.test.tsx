import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StudioSettingsSheet } from '../StudioSettingsSheet'

const openSettingsTab = vi.fn()

vi.mock('@cherrystudio/ui', () => ({
  Button: ({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) => (
    <button className={className} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Drawer: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
  DrawerClose: ({ children }: { children: ReactNode }) => children,
  DrawerContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  DrawerDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DrawerHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DrawerTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openSettingsTab: (path: string) => openSettingsTab(path)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'chemsmart_studio.ide.settings.about': 'About & Diagnostics',
          'chemsmart_studio.ide.settings.appearance': 'Appearance & Accessibility',
          'chemsmart_studio.ide.settings.description': 'Studio configuration',
          'chemsmart_studio.ide.settings.models': 'Models & Providers',
          'chemsmart_studio.ide.settings.readiness': 'Execution Readiness',
          'chemsmart_studio.ide.settings.title': 'Studio Settings',
          'common.close': 'Close',
          'settings.model': 'Default model'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

describe('StudioSettingsSheet', () => {
  beforeEach(() => openSettingsTab.mockReset())

  it('opens the provider settings route and closes the Studio sheet', () => {
    const onOpenChange = vi.fn()
    render(<StudioSettingsSheet open onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Models & Providers' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(openSettingsTab).toHaveBeenCalledWith('/settings/provider')
  })

  it('opens the default model settings route', () => {
    render(<StudioSettingsSheet open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Default model' }))

    expect(openSettingsTab).toHaveBeenCalledWith('/settings/model')
  })
})
