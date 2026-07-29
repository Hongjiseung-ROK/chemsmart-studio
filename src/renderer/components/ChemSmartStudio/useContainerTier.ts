import { type RefObject, useEffect, useState } from 'react'

/** The three tested layouts supported by the Studio IDE shell. */
export type StudioLayoutTier = 'wide' | 'focused' | 'viewport-only'

const WIDE_MIN_WIDTH = 1180
const WIDE_MIN_HEIGHT = 680
const VIEWPORT_ONLY_MAX_WIDTH = 839
const VIEWPORT_ONLY_MAX_HEIGHT = 639

/** Resolves the tier for a measured container. Height matters because a short window clips panels first. */
export function resolveStudioLayoutTier(width: number, height: number): StudioLayoutTier {
  if (width <= VIEWPORT_ONLY_MAX_WIDTH || height <= VIEWPORT_ONLY_MAX_HEIGHT) return 'viewport-only'
  if (width < WIDE_MIN_WIDTH || height < WIDE_MIN_HEIGHT) return 'focused'
  return 'wide'
}

/**
 * Observes the container instead of the viewport: the workspace is one pane among others, so its own
 * width is what decides how much detail fits. Stays `wide` until the first measurement.
 */
export function useContainerTier(ref: RefObject<HTMLElement | null>): StudioLayoutTier {
  const [tier, setTier] = useState<StudioLayoutTier>('wide')

  useEffect(() => {
    const container = ref.current
    if (!container || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(0)?.contentRect
      if (!rect || rect.width <= 0) return
      setTier(resolveStudioLayoutTier(rect.width, rect.height))
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [ref])

  return tier
}
