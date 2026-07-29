import { describe, expect, it } from 'vitest'

import {
  normalizedSizeToPercentage,
  normalizePanelLayout,
  resolvePanePresentation,
  type StudioPaneIntent
} from '../studioLayout'

const openIntent: StudioPaneIntent = {
  open: true,
  normalizedSize: 0.28,
  lastActivatedAt: 1
}

describe('Studio relative layout', () => {
  it('stores splitter geometry as normalized workspace ratios', () => {
    expect(normalizePanelLayout({ explorer: 18, center: 54, inspector: 28 })).toEqual({
      explorer: 0.18,
      center: 0.54,
      inspector: 0.28
    })
    expect(normalizedSizeToPercentage(0.28, 0.25)).toBe('28%')
  })

  it('changes presentation without changing pane intent', () => {
    expect(resolvePanePresentation({ compact: false, intent: openIntent, sheetActive: false })).toBe('docked')
    expect(resolvePanePresentation({ compact: true, intent: openIntent, sheetActive: true })).toBe('relative-sheet')
    expect(resolvePanePresentation({ compact: true, intent: openIntent, sheetActive: false })).toBe('hidden')
    expect(openIntent).toEqual({ open: true, normalizedSize: 0.28, lastActivatedAt: 1 })
  })
})
