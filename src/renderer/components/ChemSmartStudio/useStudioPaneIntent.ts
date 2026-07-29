import { type Dispatch, type SetStateAction, useCallback, useState } from 'react'

import { clampNormalizedSize, type StudioPaneIntent } from './studioLayout'

interface StudioPaneIntentController {
  activate: () => void
  intent: StudioPaneIntent
  setNormalizedSize: (normalizedSize: number) => void
  setOpen: Dispatch<SetStateAction<boolean>>
}

/**
 * Owns pane intent independently from how the current container can present it.
 * Resize code receives the intent but has no setter capable of closing it.
 */
export function useStudioPaneIntent(initialOpen: boolean, initialNormalizedSize: number): StudioPaneIntentController {
  const [intent, setIntent] = useState<StudioPaneIntent>({
    open: initialOpen,
    normalizedSize: initialNormalizedSize,
    lastActivatedAt: initialOpen ? 1 : 0
  })

  const setOpen = useCallback<Dispatch<SetStateAction<boolean>>>((next) => {
    setIntent((current) => {
      const open = typeof next === 'function' ? next(current.open) : next
      if (open === current.open) return current
      return {
        ...current,
        open,
        lastActivatedAt: open ? Date.now() : current.lastActivatedAt
      }
    })
  }, [])

  const activate = useCallback(() => {
    setIntent((current) => ({
      ...current,
      open: true,
      lastActivatedAt: Date.now()
    }))
  }, [])

  const setNormalizedSize = useCallback((normalizedSize: number) => {
    setIntent((current) => {
      const next = clampNormalizedSize(normalizedSize, current.normalizedSize)
      return next === current.normalizedSize ? current : { ...current, normalizedSize: next }
    })
  }, [])

  return { activate, intent, setNormalizedSize, setOpen }
}
