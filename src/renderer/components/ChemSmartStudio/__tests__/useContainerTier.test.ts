import { describe, expect, it } from 'vitest'

import { resolveStudioLayoutTier } from '../useContainerTier'

describe('resolveStudioLayoutTier', () => {
  it('uses the Studio IDE width tiers at normal height', () => {
    expect(resolveStudioLayoutTier(1440, 900)).toBe('wide')
    expect(resolveStudioLayoutTier(1180, 680)).toBe('wide')
    expect(resolveStudioLayoutTier(1179, 900)).toBe('focused')
    expect(resolveStudioLayoutTier(840, 900)).toBe('focused')
    expect(resolveStudioLayoutTier(839, 900)).toBe('viewport-only')
    expect(resolveStudioLayoutTier(960, 600)).toBe('viewport-only')
    expect(resolveStudioLayoutTier(760, 560)).toBe('viewport-only')
  })

  it('uses height to protect the stage', () => {
    expect(resolveStudioLayoutTier(1440, 639)).toBe('viewport-only')
    expect(resolveStudioLayoutTier(1440, 640)).toBe('focused')
    expect(resolveStudioLayoutTier(1440, 679)).toBe('focused')
    expect(resolveStudioLayoutTier(1440, 680)).toBe('wide')
  })
})
