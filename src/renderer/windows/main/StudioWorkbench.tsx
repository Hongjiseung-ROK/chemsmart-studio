import { ChemSmartWorkspace, useResearchProjectSession } from '@renderer/components/ChemSmartStudio'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import useMacTransparentWindow from '@renderer/hooks/useMacTransparentWindow'
import { cn } from '@renderer/utils/style'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface StudioWorkbenchProps {
  active?: boolean
}

function ActiveStudioWorkspace() {
  const { t } = useTranslation()
  const { activeThreadId, context, createThread, failed, renameThread, selectThread } = useResearchProjectSession()

  return activeThreadId ? (
    <ChemSmartWorkspace
      active
      researchContext={context}
      sessionId={activeThreadId}
      onCreateThread={createThread}
      onRenameThread={renameThread}
      onSelectThread={selectThread}
    />
  ) : (
    <div className="flex h-full items-center justify-center p-6 text-foreground-secondary text-sm" role="status">
      {failed ? t('chemsmart_studio.research_session.unavailable') : t('chemsmart_studio.research_session.loading')}
    </div>
  )
}

/**
 * The main window has one product workspace. Legacy route tabs are intentionally not rendered here;
 * clearing their persisted pins prevents an old consumer route from returning on a later launch.
 */
export function StudioWorkbench({ active = true }: StudioWorkbenchProps) {
  const { t } = useTranslation()
  const isMacTransparentWindow = useMacTransparentWindow()
  const [, setPinnedTabs] = usePersistCache('ui.tab.pinned_tabs')

  useEffect(() => {
    setPinnedTabs((tabs) => (tabs.length === 0 ? [...tabs] : []))
  }, [setPinnedTabs])

  return (
    <div
      className={cn(
        'h-screen w-screen overflow-hidden text-foreground',
        isMacTransparentWindow ? 'bg-transparent' : 'bg-background'
      )}
      data-product-route="/app/chemsmart"
      data-testid="studio-product-shell">
      {active ? (
        <ActiveStudioWorkspace />
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-foreground-secondary text-sm" role="status">
          {t('chemsmart_studio.ide.detached_retired')}
        </div>
      )}
    </div>
  )
}
