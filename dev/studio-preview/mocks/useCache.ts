import { useState } from 'react'

/** In-memory stand-in for the persist cache, so a reload always starts from the default layout. */
export function usePersistCache<Value>(_key: string, initial: Value | null = null) {
  return useState<Value | null>(initial)
}

export function useCache<Value>(_key: string, initial: Value | null = null) {
  return useState<Value | null>(initial)
}
