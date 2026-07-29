import { Badge, Button, Scrollbar } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export const inspectorTabs = ['properties', 'agent', 'decisions'] as const
export type InspectorTab = (typeof inspectorTabs)[number]

interface InspectorPanelProps {
  activeTab: InspectorTab
  /** One node per tab; the inactive one stays mounted so its scroll position and state survive. */
  content: Record<InspectorTab, ReactNode>
  /** Count shown on the decisions tab, so waiting decisions are visible without opening it. */
  decisionCount: number
  onTabChange: (tab: InspectorTab) => void
}

/**
 * The right inspector. Its tabs are where the workspace puts everything that is only needed sometimes —
 * the optional Agent and the trusted decisions — so neither occupies the workspace when it is not needed.
 */
export function InspectorPanel({ activeTab, content, decisionCount, onTabChange }: InspectorPanelProps) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-border border-l bg-background" id="chemsmart-inspector">
      <div
        aria-label={t('chemsmart_studio.inspector.tabs')}
        className="flex shrink-0 gap-1 border-border border-b px-2 py-2"
        role="tablist">
        {inspectorTabs.map((tab) => (
          <Button
            aria-controls={`chemsmart-inspector-${tab}`}
            aria-selected={activeTab === tab}
            className="flex-1 gap-1.5"
            key={tab}
            role="tab"
            size="sm"
            variant={activeTab === tab ? 'secondary' : 'ghost'}
            onClick={() => onTabChange(tab)}>
            {t(`chemsmart_studio.inspector.tab.${tab}`)}
            {tab === 'decisions' && decisionCount > 0 ? (
              <Badge className="px-1.5" variant="secondary">
                {decisionCount}
              </Badge>
            ) : null}
          </Button>
        ))}
      </div>
      {inspectorTabs.map((tab) => (
        <div
          aria-hidden={activeTab === tab ? undefined : true}
          className={cn('min-h-0 flex-1 flex-col', activeTab === tab ? 'flex' : 'hidden')}
          data-testid={`inspector-tab-${tab}`}
          id={`chemsmart-inspector-${tab}`}
          inert={activeTab === tab ? undefined : true}
          key={tab}
          role="tabpanel">
          {tab === 'agent' ? content[tab] : <Scrollbar className="min-h-0 flex-1">{content[tab]}</Scrollbar>}
        </div>
      ))}
    </div>
  )
}
