import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SubWindowApp from '../SubWindowApp'

const mocks = vi.hoisted(() => ({
  initData: null as unknown,
  studioWorkbench: vi.fn((props: { active?: boolean }) => {
    void props
    return null
  }),
  themeThrows: true
}))

vi.mock('@renderer/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => {
    if (mocks.themeThrows) throw new Error('theme provider boom')
    return children
  }
}))
vi.mock('@renderer/components/CodeStyleProvider', () => ({
  CodeStyleProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/components/command', () => ({
  CommandContextKeyProvider: ({ children }: { children: ReactNode }) => children,
  CommandProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/components/layout/TabsProvider', () => ({
  TabsProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/components/PopupHost', () => ({ PopupHost: () => null }))
vi.mock('@renderer/components/ToastHost', () => ({ default: () => null }))
vi.mock('@renderer/hooks/useWindowInitData', () => ({ useWindowInitData: () => mocks.initData }))
vi.mock('@renderer/hooks/useWindowRuntime', () => ({ useWindowRuntime: vi.fn() }))
vi.mock('@renderer/windows/main/StudioWorkbench', () => ({
  StudioWorkbench: mocks.studioWorkbench
}))

describe('SubWindowApp top-level error boundary', () => {
  beforeEach(() => {
    mocks.initData = null
    mocks.studioWorkbench.mockClear()
    mocks.themeThrows = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the window fatal fallback instead of a white screen when a provider throws', () => {
    render(<SubWindowApp />)

    expect(screen.getByRole('alert')).toHaveTextContent('theme provider boom')
  })

  it('does not mount a Studio session while a pooled subwindow is only warming up', () => {
    mocks.themeThrows = false

    render(<SubWindowApp />)

    expect(mocks.studioWorkbench).not.toHaveBeenCalled()
  })

  it('normalizes an assigned detached window without acquiring the active session lease', () => {
    mocks.initData = {}
    mocks.themeThrows = false

    render(<SubWindowApp />)

    expect(mocks.studioWorkbench).toHaveBeenCalled()
    expect(mocks.studioWorkbench.mock.calls[0]?.[0]).toMatchObject({ active: false })
  })
})
