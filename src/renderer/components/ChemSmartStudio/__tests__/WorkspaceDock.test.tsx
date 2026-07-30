import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { StudioPaneId } from '../studioLayout'
import type { StudioLayoutTier } from '../useContainerTier'
import { WorkspaceDock } from '../WorkspaceDock'

const { usePersistCacheMock } = vi.hoisted(() => ({
  usePersistCacheMock: vi.fn(() => [null, vi.fn()])
}))

// The dock invariants depend on the real panel primitives (`data-panel`, `data-separator`), so opt out
// of the blanket `@cherrystudio/ui` stub the renderer setup installs.
vi.mock('@cherrystudio/ui', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))

vi.mock('@renderer/data/hooks/useCache', () => ({
  usePersistCache: usePersistCacheMock
}))

function dock(
  overrides: {
    bottom?: ReactNode
    bottomActivatedAt?: number
    bottomOpen?: boolean
    center?: ReactNode
    inspector?: ReactNode
    inspectorActivatedAt?: number
    inspectorOpen?: boolean
    onSheetOpenChange?: (open: boolean) => void
    sheetPane?: StudioPaneId | null
    tier?: StudioLayoutTier
  } = {}
) {
  const bottomOpen = overrides.bottomOpen ?? true
  const inspectorOpen = overrides.inspectorOpen ?? true
  return (
    <WorkspaceDock
      bottom={overrides.bottom ?? <p>bottom content</p>}
      bottomIntent={{
        open: bottomOpen,
        normalizedSize: 0.3,
        lastActivatedAt: overrides.bottomActivatedAt ?? 1
      }}
      bottomPresentation={
        bottomOpen
          ? overrides.tier === 'viewport-only'
            ? overrides.sheetPane === 'console'
              ? 'relative-sheet'
              : 'hidden'
            : 'docked'
          : 'hidden'
      }
      center={overrides.center ?? <p>center content</p>}
      inspector={overrides.inspector ?? <p>inspector content</p>}
      inspectorIntent={{
        open: inspectorOpen,
        normalizedSize: 0.28,
        lastActivatedAt: overrides.inspectorActivatedAt ?? 2
      }}
      inspectorPresentation={
        inspectorOpen
          ? overrides.tier === 'viewport-only'
            ? overrides.sheetPane === 'agent'
              ? 'relative-sheet'
              : 'hidden'
            : 'docked'
          : 'hidden'
      }
      rail={<p>rail content</p>}
      railExpanded
      sheetContexts={{}}
      sheetExplorer={<p>explorer content</p>}
      sheetPane={overrides.sheetPane ?? null}
      onBottomOpenChange={vi.fn()}
      onBottomSizeChange={vi.fn()}
      onInspectorOpenChange={vi.fn()}
      onInspectorSizeChange={vi.fn()}
      onSheetOpenChange={overrides.onSheetOpenChange ?? vi.fn()}
      tier={overrides.tier ?? 'wide'}
    />
  )
}

function renderDock(overrides: Parameters<typeof dock>[0] = {}) {
  return render(dock(overrides))
}

function DockToggleHarness({ pane, tier }: { pane: 'agent' | 'console'; tier: StudioLayoutTier }) {
  const [open, setOpen] = useState(true)
  const sheetPane = tier === 'viewport-only' && open ? pane : null

  return (
    <div>
      <button aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        Toggle {pane}
      </button>
      {dock({
        bottom: <input aria-label="console input" defaultValue="preserved command" />,
        bottomOpen: pane === 'console' ? open : true,
        inspector: <input aria-label="agent composer" defaultValue="preserved request" />,
        inspectorOpen: pane === 'agent' ? open : true,
        onSheetOpenChange: setOpen,
        sheetPane,
        tier
      })}
    </div>
  )
}

const regionIds = ['workspace-dock-rail', 'workspace-dock-center', 'workspace-dock-inspector', 'workspace-dock-bottom']

describe('WorkspaceDock', () => {
  it('keeps the bottom workbench inside the center column instead of spanning both sidebars', () => {
    renderDock()

    const centerColumn = screen.getByTestId('studio-dock-center-vertical-v2')
    expect(centerColumn).toContainElement(screen.getByTestId('workspace-dock-center'))
    expect(centerColumn).toContainElement(screen.getByTestId('workspace-dock-bottom'))
    expect(centerColumn).not.toContainElement(screen.getByTestId('workspace-dock-rail'))
    expect(centerColumn).not.toContainElement(screen.getByTestId('workspace-dock-inspector'))
  })

  it('uses a versioned splitter cache so the old full-width bottom geometry is not restored', () => {
    renderDock()

    expect(usePersistCacheMock).toHaveBeenCalledWith('ui.studio.layout.horizontal')
    expect(usePersistCacheMock).toHaveBeenCalledWith('ui.studio.layout.center_vertical_v2')
    expect(usePersistCacheMock).not.toHaveBeenCalledWith('ui.studio.layout.vertical')
  })

  it('docks every region inside a resizable panel instead of overlaying it', () => {
    renderDock()

    for (const id of regionIds) {
      const region = screen.getByTestId(id)
      expect(region).toHaveAttribute('data-open', 'true')
      expect(region).not.toHaveClass('fixed', 'absolute', 'hidden')
      // A docked region always sits inside a panel, so opening it resizes siblings instead of covering them.
      expect(region.closest('[data-panel]')).not.toBeNull()
    }
    expect(screen.getByText('center content')).toBeInTheDocument()
  })

  it('marks only the most recently activated open auxiliary dock', () => {
    const { rerender } = renderDock({ bottomActivatedAt: 3, inspectorActivatedAt: 2 })

    expect(screen.getByTestId('workspace-dock-bottom')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('workspace-dock-inspector')).not.toHaveAttribute('data-active')

    rerender(dock({ bottomActivatedAt: 3, inspectorActivatedAt: 4 }))
    expect(screen.getByTestId('workspace-dock-bottom')).not.toHaveAttribute('data-active')
    expect(screen.getByTestId('workspace-dock-inspector')).toHaveAttribute('data-active', 'true')
  })

  it('preserves focused center and bottom controls while pane presentation changes', () => {
    const { rerender } = renderDock({
      bottom: <input aria-label="console input" />,
      center: <input aria-label="stage input" />
    })
    const stageInput = screen.getByRole('textbox', { name: 'stage input' })
    stageInput.focus()

    rerender(
      dock({
        bottom: <input aria-label="console input" />,
        center: <input aria-label="stage input" />,
        inspectorOpen: false
      })
    )
    expect(stageInput).toHaveFocus()

    const consoleInput = screen.getByRole('textbox', { name: 'console input' })
    consoleInput.focus()
    rerender(
      dock({
        bottom: <input aria-label="console input" />,
        center: <input aria-label="stage input" />,
        inspectorOpen: true
      })
    )
    expect(consoleInput).toHaveFocus()
  })

  it('keeps a closed dock inert and hidden from the accessibility tree', () => {
    renderDock({ bottomOpen: false, inspectorOpen: false })

    for (const id of ['workspace-dock-inspector', 'workspace-dock-bottom']) {
      const region = screen.getByTestId(id)
      expect(region).toHaveAttribute('data-open', 'false')
      expect(region).toHaveAttribute('hidden')
      expect(region).toHaveAttribute('inert')
    }
    // The center never collapses, whatever its siblings do.
    expect(screen.getByTestId('workspace-dock-center')).toHaveAttribute('data-open', 'true')
  })

  it('animates panel size changes but stops transitioning while a separator is dragged', () => {
    renderDock()

    // The easing is declared on the group because the panel element the group sizes is not the element a
    // panel's own className reaches.
    const group = screen.getByTestId('studio-dock-columns')
    expect(group).toHaveClass('[&>[data-panel]]:transition-[flex-grow]', '[&>[data-panel]]:duration-[180ms]')
    expect(group).toHaveClass('motion-reduce:[&>[data-panel]]:transition-none')

    const separator = document.querySelector('[data-separator]')
    expect(separator).not.toBeNull()
    fireEvent.pointerDown(separator as Element, { bubbles: true })

    expect(screen.getByTestId('studio-dock-columns')).toHaveClass('[&>[data-panel]]:transition-none')
    expect(screen.getByTestId('studio-dock-columns')).not.toHaveClass('[&>[data-panel]]:transition-[flex-grow]')

    fireEvent.pointerUp(window)
    expect(screen.getByTestId('studio-dock-columns')).toHaveClass('[&>[data-panel]]:transition-[flex-grow]')
  })

  it('mounts only the center region at the viewport-only tier', () => {
    renderDock({ tier: 'viewport-only' })

    expect(screen.getByTestId('workspace-dock-viewport-only')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-dock-rail')).toBeNull()
    expect(screen.queryByTestId('workspace-dock-inspector')).toBeNull()
    expect(screen.queryByTestId('workspace-dock-bottom')).toBeNull()
    expect(screen.getByTestId('workspace-dock-center')).toHaveAttribute('data-open', 'true')
  })

  it('moves focus into a compact Agent Sheet and returns it when Escape closes the presentation', async () => {
    const onSheetOpenChange = vi.fn()
    const { rerender } = renderDock({ inspector: <button>Agent composer</button>, tier: 'viewport-only' })
    const trigger = document.createElement('button')
    trigger.textContent = 'Agent toggle'
    document.body.appendChild(trigger)
    trigger.focus()

    rerender(
      dock({
        inspector: <button>Agent composer</button>,
        onSheetOpenChange,
        sheetPane: 'agent',
        tier: 'viewport-only'
      })
    )
    const sheet = screen.getByTestId('studio-pane-sheet')
    await waitFor(() => expect(sheet).toContainElement(document.activeElement as HTMLElement))

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(onSheetOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(trigger).toHaveFocus())
    trigger.remove()
  })

  it('keeps the rail docked from the dense tier upwards', () => {
    for (const tier of ['wide', 'focused'] as const) {
      const { unmount } = renderDock({ tier })
      expect(screen.queryByTestId('workspace-dock-viewport-only')).toBeNull()
      expect(screen.getByTestId('workspace-dock-rail')).toHaveAttribute('data-open', 'true')
      unmount()
    }
  })

  it.each(['wide', 'focused'] as const)(
    'reopens Agent and Console repeatedly at the %s tier without a recursive render',
    async (tier) => {
      for (const pane of ['agent', 'console'] as const) {
        const user = userEvent.setup()
        const { unmount } = render(<DockToggleHarness pane={pane} tier={tier} />)
        const toggle = screen.getByRole('button', { name: `Toggle ${pane}` })
        const region = screen.getByTestId(pane === 'agent' ? 'workspace-dock-inspector' : 'workspace-dock-bottom')

        for (let index = 0; index < 20; index += 1) {
          await user.click(toggle)
          expect(toggle).toHaveAttribute('aria-expanded', 'false')
          expect(region).toHaveAttribute('hidden')
          await user.click(toggle)
          expect(toggle).toHaveAttribute('aria-expanded', 'true')
          expect(region).not.toHaveAttribute('hidden')
        }
        unmount()
      }
    }
  )

  it.each(['agent', 'console'] as const)(
    'reopens the compact %s Sheet repeatedly and returns focus to its toggle',
    async (pane) => {
      const user = userEvent.setup()
      render(<DockToggleHarness pane={pane} tier="viewport-only" />)
      const toggle = screen.getByRole('button', { name: `Toggle ${pane}` })

      fireEvent.keyDown(screen.getByTestId('studio-pane-sheet'), { key: 'Escape' })
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'))

      for (let index = 0; index < 5; index += 1) {
        toggle.focus()
        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        const sheet = await screen.findByTestId('studio-pane-sheet')
        fireEvent.keyDown(sheet, { key: 'Escape' })
        await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'))
        await waitFor(() => expect(toggle).toHaveFocus())
      }
    }
  )
})
