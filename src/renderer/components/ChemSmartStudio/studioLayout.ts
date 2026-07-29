export type StudioPaneId = 'explorer' | 'properties' | 'agent' | 'decisions' | 'console' | 'jobs' | 'problems'

export interface StudioPaneIntent {
  /** Researcher-owned open state. Container resizing must never rewrite it. */
  open: boolean
  /** Fraction of the workspace occupied by the pane when docked, from 0 to 1. */
  normalizedSize: number
  /** Monotonic activation time used to choose one Sheet without discarding other pane intent. */
  lastActivatedAt: number
}

export type StudioPanePresentation = 'docked' | 'relative-sheet' | 'hidden'

export interface StudioRelativeLayout {
  horizontal: {
    explorer: number
    inspector: number
  }
  vertical: {
    bottom: number
  }
}

export const defaultStudioRelativeLayout: StudioRelativeLayout = {
  horizontal: {
    explorer: 0.18,
    inspector: 0.28
  },
  vertical: {
    bottom: 0.3
  }
}

export const compactStudioRelativeLayout = {
  inspector: 0.44,
  bottom: 0.42
} as const

export const inspectorPaneIds = ['properties', 'agent', 'decisions'] as const satisfies readonly StudioPaneId[]
export const bottomPaneIds = ['console', 'jobs', 'problems'] as const satisfies readonly StudioPaneId[]

export function isInspectorPane(pane: StudioPaneId): pane is (typeof inspectorPaneIds)[number] {
  return inspectorPaneIds.includes(pane as (typeof inspectorPaneIds)[number])
}

export function isBottomPane(pane: StudioPaneId): pane is (typeof bottomPaneIds)[number] {
  return bottomPaneIds.includes(pane as (typeof bottomPaneIds)[number])
}

export function clampNormalizedSize(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

export function normalizePanelLayout(layout: Record<string, number>): Record<string, number> {
  const entries = Object.entries(layout).filter(([, value]) => Number.isFinite(value) && value >= 0)
  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  if (total <= 0) return {}
  return Object.fromEntries(entries.map(([id, value]) => [id, value / total]))
}

export function normalizedSizeToPercentage(value: number, fallback: number): string {
  return `${Math.round(clampNormalizedSize(value, fallback) * 10_000) / 100}%`
}

export function resolvePanePresentation({
  compact,
  intent,
  sheetActive
}: {
  compact: boolean
  intent: StudioPaneIntent
  sheetActive: boolean
}): StudioPanePresentation {
  if (!intent.open) return 'hidden'
  if (compact) return sheetActive ? 'relative-sheet' : 'hidden'
  return 'docked'
}
