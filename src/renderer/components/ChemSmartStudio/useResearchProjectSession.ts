import type { ResearchProjectContext } from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { useCallback, useEffect, useRef, useState } from 'react'

const logger = loggerService.withContext('useResearchProjectSession')

export interface ResearchProjectSession {
  /** Null until main has answered, and never null again for this mount. */
  context: ResearchProjectContext | null
  activeThreadId: string | null
  failed: boolean
  createThread: (title: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  selectThread: (threadId: string) => Promise<void>
}

/**
 * Reads the active project and its named research threads from main.
 *
 * The identity is fetched exactly once per mount. Anything session-scoped downstream --
 * the agent turn, the control snapshot, the viewport lease -- is keyed on the active
 * thread id, so re-fetching and briefly reporting no thread would tear those down.
 */
export function useResearchProjectSession(): ResearchProjectSession {
  const [context, setContext] = useState<ResearchProjectContext | null>(null)
  const [failed, setFailed] = useState(false)
  const requested = useRef(false)

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    let cancelled = false
    void ipcApi
      .request('chemsmart_studio.research_session.context')
      .then((next) => {
        if (!cancelled) setContext(next)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailed(true)
        logger.error('Failed to read the research project context', error as Error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const mutate = useCallback(async (operation: () => Promise<ResearchProjectContext>) => {
    const next = await operation()
    setContext(next)
  }, [])

  const createThread = useCallback(
    (title: string) => mutate(() => ipcApi.request('chemsmart_studio.research_session.create_thread', { title })),
    [mutate]
  )
  const renameThread = useCallback(
    (threadId: string, title: string) =>
      mutate(() => ipcApi.request('chemsmart_studio.research_session.rename_thread', { threadId, title })),
    [mutate]
  )
  const selectThread = useCallback(
    (threadId: string) => mutate(() => ipcApi.request('chemsmart_studio.research_session.select_thread', { threadId })),
    [mutate]
  )

  return {
    context,
    activeThreadId: context?.activeThreadId ?? null,
    failed,
    createThread,
    renameThread,
    selectThread
  }
}
