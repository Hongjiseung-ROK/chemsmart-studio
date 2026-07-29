import { Button } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export const workbenchTabs = ['console', 'jobs', 'problems'] as const
export type WorkbenchTab = (typeof workbenchTabs)[number]

interface WorkbenchTabsProps {
  activeTab: WorkbenchTab
  content: Record<WorkbenchTab, ReactNode>
  onTabChange: (tab: WorkbenchTab) => void
}

/**
 * The bottom dock. It holds the ways a researcher reaches the ChemSmart command line — inspect one they
 * wrote, have one synthesized from a request, set up the method project that Gaussian and ORCA need, or
 * run one themselves — so none of them occupies the workspace when it is not wanted.
 */
export function WorkbenchTabs({ activeTab, content, onTabChange }: WorkbenchTabsProps) {
  const { t } = useTranslation()

  return (
    <div
      // `clip`, not `hidden`: a hidden pane is still a scroll container, so focusing a control near its edge
      // scrolls the pane with nothing able to scroll it back.
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip border-border border-t bg-background"
      id="chemsmart-workbench"
      data-testid="workbench-tabs">
      <div
        aria-label={t('chemsmart_studio.workbench.tabs')}
        className="flex shrink-0 gap-1 border-border border-b px-2 py-2"
        role="tablist">
        {workbenchTabs.map((tab) => (
          <Button
            aria-controls={`chemsmart-workbench-${tab}`}
            aria-selected={activeTab === tab}
            key={tab}
            role="tab"
            size="sm"
            variant={activeTab === tab ? 'secondary' : 'ghost'}
            onClick={() => onTabChange(tab)}>
            {t(`chemsmart_studio.workbench.tab.${tab}`)}
          </Button>
        ))}
      </div>
      {workbenchTabs.map((tab) => (
        <div
          aria-hidden={activeTab === tab ? undefined : true}
          className={cn('min-h-0 min-w-0 flex-1 flex-col overflow-clip', activeTab === tab ? 'flex' : 'hidden')}
          data-testid={`workbench-tab-${tab}`}
          id={`chemsmart-workbench-${tab}`}
          inert={activeTab === tab ? undefined : true}
          key={tab}
          role="tabpanel">
          {content[tab]}
        </div>
      ))}
    </div>
  )
}
