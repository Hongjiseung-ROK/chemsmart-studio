import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizablePanelHandle,
  useResizablePanelRef
} from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import {
  defaultStudioRelativeLayout,
  isBottomPane,
  isInspectorPane,
  normalizedSizeToPercentage,
  normalizePanelLayout,
  type StudioPaneId,
  type StudioPaneIntent,
  type StudioPanePresentation
} from './studioLayout'
import { StudioPaneSheet } from './StudioPaneSheet'
import type { StudioLayoutTier } from './useContainerTier'

const RAIL_SIZE = '18%'
/** Dense keeps the rail as an icon strip: still reachable, no room spent on labels. */
const RAIL_ICON_SIZE = '48px'
/** An expanded Explorer must keep project names readable even when an old splitter cache was narrower. */
const RAIL_EXPANDED_MIN_SIZE = '220px'

/**
 * Panel size lives in `flex-grow` on the panel element the group owns, and a panel's own `className`
 * lands on an inner wrapper — so the collapse/expand easing has to be declared from the group down.
 */
const PANEL_MOTION =
  '[&>[data-panel]]:transition-[flex-grow] [&>[data-panel]]:duration-[180ms] [&>[data-panel]]:ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:[&>[data-panel]]:transition-none'
/** Dragging must track the pointer exactly, so easing is dropped for the duration of the drag. */
const PANEL_MOTION_OFF = '[&>[data-panel]]:transition-none'

/**
 * True while a separator is being dragged. Panel size transitions must be off during a drag so the
 * panel edge tracks the pointer instead of easing behind it.
 */
function useSeparatorDragging(rootRef: RefObject<HTMLDivElement | null>) {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const startDragging = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-separator]')) return
      setDragging(true)
    }
    const stopDragging = () => setDragging(false)

    root.addEventListener('pointerdown', startDragging)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)

    return () => {
      root.removeEventListener('pointerdown', startDragging)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }
  }, [rootRef])

  return dragging
}

/** A panel narrower than this counts as closed however it got there. */
const OPEN_THRESHOLD_PERCENT = 1

/**
 * What has to happen for a panel to match the researcher's intent. `follow` means the panel changed on its
 * own — the researcher dragged it — and the intent should be updated to match instead of fought.
 */
export type PanelReconciliation = 'collapse' | 'expand' | 'follow' | 'none' | 'resize'

/**
 * The panel group sizes itself asynchronously, and its imperative `collapse`/`resize` are dropped while it
 * is still measuring. So intent is re-asserted after every commit until the panel obeys, and once it has
 * obeyed, any later disagreement is the researcher's own drag.
 */
export function reconcilePanel({
  dragged,
  open,
  pending,
  size
}: {
  /** True only once the researcher has dragged this panel's separator since the last intent change. */
  dragged: boolean
  open: boolean
  pending: boolean
  /** Target size; `null` asks for a closed panel. */
  size: string | null
}): PanelReconciliation {
  const wantsOpen = size !== null
  if (wantsOpen !== open) {
    if (pending) return wantsOpen ? 'expand' : 'collapse'
    // Only a drag may rewrite intent. Any other disagreement is the group still settling, and rewriting
    // intent from it would undo the toggle that just asked for this state.
    return dragged ? 'follow' : 'none'
  }
  // A pixel target (the dense icon rail) is a fixed width, so it is re-applied even when already open.
  return size !== null && size.endsWith('px') ? 'resize' : 'none'
}

/**
 * Drives one panel from a target size: `null` collapses it. A percentage target reopens at whatever size
 * the researcher last dragged the panel to; an explicit pixel target (the dense icon rail) always wins.
 * `onOpenChange` reports a panel the researcher dragged open or closed, so the toggle that owns it never
 * claims the opposite of what is on screen.
 */
function useSizedPanel({
  dragging,
  minimumPixels,
  mounted,
  onNormalizedSizeChange,
  onOpenChange,
  size
}: {
  dragging: boolean
  minimumPixels?: number
  mounted: boolean
  onNormalizedSizeChange?: (normalizedSize: number) => void
  onOpenChange?: (open: boolean) => void
  size: string | null
}) {
  const panelRef = useResizablePanelRef()
  const lastSizeRef = useRef<string | null>(null)
  // A freshly mounted panel has not obeyed anything yet, so the first pass always asserts.
  const pendingRef = useRef(true)
  const draggedRef = useRef(false)
  const [, setObservedSize] = useState<number | null>(null)

  const handleResize = useCallback(
    (panelSize: { asPercentage: number; inPixels: number }) => {
      if (
        panelSize.asPercentage >= OPEN_THRESHOLD_PERCENT &&
        (minimumPixels === undefined || panelSize.inPixels >= minimumPixels)
      ) {
        lastSizeRef.current = `${panelSize.asPercentage}%`
        onNormalizedSizeChange?.(panelSize.asPercentage / 100)
      }
      setObservedSize(panelSize.asPercentage)
    },
    [minimumPixels, onNormalizedSizeChange]
  )

  useEffect(() => {
    pendingRef.current = true
    draggedRef.current = false
  }, [size])

  useEffect(() => {
    if (dragging) draggedRef.current = true
  }, [dragging])

  // Intentionally runs after every commit: the group settles over several frames and the panel must not be
  // left contradicting the toggle that opened it.
  useEffect(() => {
    const panel: ResizablePanelHandle | null = mounted ? panelRef.current : null
    if (!panel) return

    const panelSize = panel.getSize()
    if (size !== null && minimumPixels !== undefined && panelSize.inPixels < minimumPixels) {
      panel.resize(size)
      return
    }
    const open = !panel.isCollapsed() && panelSize.asPercentage >= OPEN_THRESHOLD_PERCENT
    switch (reconcilePanel({ dragged: draggedRef.current, open, pending: pendingRef.current, size })) {
      case 'collapse':
        panel.collapse()
        return
      case 'expand':
        panel.resize(size!.endsWith('px') ? size! : (lastSizeRef.current ?? size!))
        return
      case 'resize':
        panel.resize(size!)
        pendingRef.current = false
        return
      case 'follow':
        onOpenChange?.(open)
        return
      default:
        pendingRef.current = false
    }
  })

  useEffect(() => {
    if (!mounted) return

    let animationFrame = 0
    let attempts = 0
    let cancelled = false
    const assertIntent = () => {
      if (cancelled || attempts >= 20) return
      attempts += 1
      const panel = panelRef.current
      if (!panel) {
        animationFrame = requestAnimationFrame(assertIntent)
        return
      }

      const panelSize = panel.getSize()
      if (size !== null && minimumPixels !== undefined && panelSize.inPixels < minimumPixels) {
        panel.resize(size)
        animationFrame = requestAnimationFrame(assertIntent)
        return
      }
      const open = !panel.isCollapsed() && panelSize.asPercentage >= OPEN_THRESHOLD_PERCENT
      const reconciliation = reconcilePanel({
        dragged: draggedRef.current,
        open,
        pending: pendingRef.current,
        size
      })
      if (reconciliation === 'collapse') panel.collapse()
      else if (reconciliation === 'expand') {
        panel.resize(size!.endsWith('px') ? size! : (lastSizeRef.current ?? size!))
      } else if (reconciliation === 'resize') {
        panel.resize(size!)
        pendingRef.current = false
        return
      } else if (reconciliation === 'follow') {
        onOpenChange?.(open)
        return
      } else {
        pendingRef.current = false
        return
      }
      animationFrame = requestAnimationFrame(assertIntent)
    }

    animationFrame = requestAnimationFrame(assertIntent)
    return () => {
      cancelled = true
      cancelAnimationFrame(animationFrame)
    }
  }, [minimumPixels, mounted, onOpenChange, panelRef, size])

  return { onResize: handleResize, panelRef }
}

function DockRegion({
  active,
  children,
  className,
  hidden,
  testId
}: {
  active?: boolean
  children: ReactNode
  className?: string
  hidden: boolean
  testId: string
}) {
  return (
    <div
      aria-hidden={hidden || undefined}
      // `clip` rather than `hidden`: a hidden region is still a scroll container, so focusing a control near
      // its edge scrolls the region and nothing can scroll it back.
      className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-clip', className)}
      data-active={active || undefined}
      data-open={!hidden}
      data-testid={testId}
      hidden={hidden}
      inert={hidden || undefined}>
      {children}
    </div>
  )
}

interface WorkspaceDockProps {
  /** Bottom dock content — the ChemSmart command workbench. */
  bottom: ReactNode
  bottomIntent: StudioPaneIntent
  bottomPresentation: StudioPanePresentation
  /** Molecule workspace: structure header, stage, and scientific controls. */
  center: ReactNode
  /** Right inspector content — currently the ChemSmart Agent workspace. */
  inspector: ReactNode
  inspectorIntent: StudioPaneIntent
  inspectorPresentation: StudioPanePresentation
  /** Reports a region the researcher dragged open or closed, so its toggle stays truthful. */
  onBottomOpenChange: (open: boolean) => void
  onBottomSizeChange: (normalizedSize: number) => void
  onInspectorOpenChange: (open: boolean) => void
  onInspectorSizeChange: (normalizedSize: number) => void
  /** Left research navigation. */
  rail: ReactNode
  /** Activity bar stays visible; this only decides whether the Explorer shares its dock. */
  railExpanded: boolean
  sheetExplorer: ReactNode
  sheetPane: StudioPaneId | null
  onSheetOpenChange: (open: boolean) => void
  tier: StudioLayoutTier
}

/**
 * The Studio dock: every toggleable region is a real resizable panel, so opening the inspector and the
 * command workbench together shrinks its siblings instead of overlaying or clipping them. The center
 * panel keeps a minimum size in both axes, which is what makes the molecule workspace impossible to
 * squeeze away.
 */
export function WorkspaceDock({
  bottom,
  bottomIntent,
  bottomPresentation,
  center,
  inspector,
  inspectorIntent,
  inspectorPresentation,
  onBottomOpenChange,
  onBottomSizeChange,
  onInspectorOpenChange,
  onInspectorSizeChange,
  rail,
  railExpanded,
  sheetExplorer,
  sheetPane,
  onSheetOpenChange,
  tier
}: WorkspaceDockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const dragging = useSeparatorDragging(rootRef)
  const [horizontalLayout, setHorizontalLayout] = usePersistCache('ui.studio.layout.horizontal')
  // The bottom dock used to be a sibling of the whole horizontal workbench and therefore spanned
  // Explorer and Inspector. This versioned cache starts clean for the center-column-only layout.
  const [centerVerticalLayout, setCenterVerticalLayout] = usePersistCache('ui.studio.layout.center_vertical_v2')
  // `defaultLayout` seeds the group once. Feeding later cache writes back into it would re-initialize the
  // group on every persisted resize and remount the docked regions.
  const [initialHorizontalLayout] = useState(() =>
    horizontalLayout ? normalizePanelLayout(horizontalLayout) : undefined
  )
  const [initialCenterVerticalLayout] = useState(() =>
    centerVerticalLayout ? normalizePanelLayout(centerVerticalLayout) : undefined
  )

  const stacked = tier === 'viewport-only'
  const inspectorDocked = inspectorPresentation === 'docked'
  const bottomDocked = bottomPresentation === 'docked'
  const railPanel = useSizedPanel({
    dragging,
    minimumPixels: tier === 'wide' && railExpanded ? 220 : undefined,
    mounted: !stacked,
    size: tier === 'wide' && railExpanded ? RAIL_SIZE : RAIL_ICON_SIZE
  })
  const inspectorPanel = useSizedPanel({
    dragging,
    mounted: !stacked,
    onNormalizedSizeChange: onInspectorSizeChange,
    onOpenChange: onInspectorOpenChange,
    size: inspectorDocked
      ? normalizedSizeToPercentage(inspectorIntent.normalizedSize, defaultStudioRelativeLayout.horizontal.inspector)
      : null
  })
  const bottomPanel = useSizedPanel({
    dragging,
    mounted: !stacked,
    onNormalizedSizeChange: onBottomSizeChange,
    onOpenChange: onBottomOpenChange,
    size: bottomDocked
      ? normalizedSizeToPercentage(bottomIntent.normalizedSize, defaultStudioRelativeLayout.vertical.bottom)
      : null
  })

  const groupMotion = dragging ? PANEL_MOTION_OFF : PANEL_MOTION
  const sheetContent =
    sheetPane === 'explorer'
      ? sheetExplorer
      : sheetPane && isInspectorPane(sheetPane)
        ? inspector
        : sheetPane && isBottomPane(sheetPane)
          ? bottom
          : null
  const inspectorActive =
    inspectorDocked && bottomDocked && inspectorIntent.lastActivatedAt > bottomIntent.lastActivatedAt
  const bottomActive =
    inspectorDocked && bottomDocked && bottomIntent.lastActivatedAt >= inspectorIntent.lastActivatedAt

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="workspace-dock" ref={rootRef}>
      {stacked ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-dock-viewport-only">
          <DockRegion className="flex-1" hidden={false} testId="workspace-dock-center">
            {center}
          </DockRegion>
        </div>
      ) : (
        <ResizablePanelGroup
          className={cn('min-h-0 flex-1', groupMotion)}
          defaultLayout={initialHorizontalLayout}
          direction="horizontal"
          id="studio-dock-columns"
          onLayoutChanged={(layout) => setHorizontalLayout(normalizePanelLayout(layout))}>
          <ResizablePanel
            className="min-h-0 min-w-0"
            collapsedSize="0%"
            collapsible
            defaultSize={RAIL_SIZE}
            id="studio-dock-rail"
            maxSize="24%"
            minSize={tier === 'wide' && railExpanded ? RAIL_EXPANDED_MIN_SIZE : RAIL_ICON_SIZE}
            onResize={railPanel.onResize}
            panelRef={railPanel.panelRef}>
            <DockRegion hidden={false} testId="workspace-dock-rail">
              {rail}
            </DockRegion>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel className="min-h-0 min-w-0" id="studio-dock-center" minSize="40%">
            <ResizablePanelGroup
              className={cn('min-h-0', groupMotion)}
              defaultLayout={initialCenterVerticalLayout}
              direction="vertical"
              id="studio-dock-center-vertical-v2"
              onLayoutChanged={(layout) => setCenterVerticalLayout(normalizePanelLayout(layout))}>
              <ResizablePanel className="min-h-0 min-w-0" id="studio-dock-stage" minSize="45%">
                <DockRegion hidden={false} testId="workspace-dock-center">
                  {center}
                </DockRegion>
              </ResizablePanel>
              <ResizableHandle disabled={!bottomDocked} />
              <ResizablePanel
                className="min-h-0 min-w-0"
                collapsedSize="0%"
                collapsible
                defaultSize={
                  bottomDocked
                    ? normalizedSizeToPercentage(
                        bottomIntent.normalizedSize,
                        defaultStudioRelativeLayout.vertical.bottom
                      )
                    : '0%'
                }
                id="studio-dock-bottom"
                maxSize="55%"
                minSize="18%"
                onResize={bottomPanel.onResize}
                panelRef={bottomPanel.panelRef}>
                <DockRegion
                  className="outline-offset-[-1px] data-[active=true]:outline data-[active=true]:outline-1 data-[active=true]:outline-primary"
                  hidden={!bottomDocked}
                  testId="workspace-dock-bottom"
                  active={bottomActive}>
                  {bottom}
                </DockRegion>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle disabled={!inspectorDocked} />
          <ResizablePanel
            className="min-h-0 min-w-0"
            collapsedSize="0%"
            collapsible
            defaultSize={
              inspectorDocked
                ? normalizedSizeToPercentage(
                    inspectorIntent.normalizedSize,
                    defaultStudioRelativeLayout.horizontal.inspector
                  )
                : '0%'
            }
            id="studio-dock-inspector"
            maxSize="40%"
            minSize="20%"
            onResize={inspectorPanel.onResize}
            panelRef={inspectorPanel.panelRef}>
            <DockRegion
              className="outline-offset-[-1px] data-[active=true]:outline data-[active=true]:outline-1 data-[active=true]:outline-primary"
              hidden={!inspectorDocked}
              testId="workspace-dock-inspector"
              active={inspectorActive}>
              {inspector}
            </DockRegion>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {sheetPane ? (
        <StudioPaneSheet open pane={sheetPane} onOpenChange={onSheetOpenChange}>
          {sheetContent}
        </StudioPaneSheet>
      ) : null}
    </div>
  )
}
