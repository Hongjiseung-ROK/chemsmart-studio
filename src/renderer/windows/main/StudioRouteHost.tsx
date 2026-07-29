import { Button } from '@cherrystudio/ui'
import { TabRouter } from '@renderer/components/layout/TabRouter'
import { useMainWindowNavigation, useTabs } from '@renderer/hooks/tab'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StudioWorkbench } from './StudioWorkbench'

export function StudioRouteHost() {
  const { t } = useTranslation()
  const { activeTab, closeTab, updateTab } = useTabs()

  useMainWindowNavigation()

  if (!activeTab?.url.startsWith('/settings')) return <StudioWorkbench />

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center border-border border-b px-3 [-webkit-app-region:drag]">
        <Button
          aria-label={t('common.back')}
          className="[-webkit-app-region:no-drag]"
          size="sm"
          variant="ghost"
          onClick={() => closeTab(activeTab.id)}>
          <ArrowLeft aria-hidden className="size-4" />
          {t('common.back')}
        </Button>
      </header>
      <main className="min-h-0 flex-1">
        <TabRouter
          isActive
          tab={activeTab}
          onUrlChange={(url) => updateTab(activeTab.id, { url, lastAccessTime: Date.now() })}
        />
      </main>
    </div>
  )
}
