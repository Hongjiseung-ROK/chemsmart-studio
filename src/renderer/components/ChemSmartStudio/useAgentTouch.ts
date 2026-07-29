import type { StudioUiEvent } from '@chemsmart/studio-protocol'
import { useEffect, useState } from 'react'

export type AgentContextTarget = 'agent' | 'decisions' | 'properties'

/** How long a newly touched target stays flashed before it settles into a quiet marker. */
const FLASH_MS = 1200

/** Protocol targets map to the inspector sections that actually hold that work. */
const targetTabs = {
  activity: 'agent',
  constraints: 'properties',
  coordinates: 'properties',
  decisions: 'decisions',
  measurements: 'properties'
} as const satisfies Record<string, AgentContextTarget>

export interface AgentTouch {
  /** Atom ids the Agent last pointed at, so the coordinate rows can mark them. */
  atomIds: readonly string[]
  /** True for a short moment after a new touch, for a one-off flash rather than a permanent animation. */
  flashing: boolean
  /** Context the Agent referenced. Background events never open or focus it. */
  target: AgentContextTarget | null
}

/**
 * Turns the Agent's schema-declared focus into something the UI can mark. The Agent cannot manipulate the
 * interface any other way: it says which object and section it is working on, and the renderer decides
 * how that is shown.
 */
export function useAgentTouch(events: readonly StudioUiEvent[]): AgentTouch {
  const latest = [...events]
    .reverse()
    .find((event) => event.kind === 'molecule_focus' || event.kind === 'inspector_target')
  const [flashingEventId, setFlashingEventId] = useState<string | null>(null)

  useEffect(() => {
    if (!latest) return
    setFlashingEventId(latest.eventId)
    const timeout = window.setTimeout(() => setFlashingEventId(null), FLASH_MS)
    return () => window.clearTimeout(timeout)
  }, [latest])

  if (!latest) return { atomIds: [], flashing: false, target: null }

  const target = latest.payload.target
  return {
    atomIds: latest.payload.atomIds ?? [],
    flashing: flashingEventId === latest.eventId,
    target: target ? targetTabs[target] : null
  }
}
