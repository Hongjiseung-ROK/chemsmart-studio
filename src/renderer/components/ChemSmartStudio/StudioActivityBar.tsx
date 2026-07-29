import { Button, Tooltip } from '@cherrystudio/ui'
import { Bot, FlaskConical, FolderTree, Settings2, SquareTerminal } from 'lucide-react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

import type { StudioPaneId } from './studioLayout'

interface ActivityItem {
  icon: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  pane: StudioPaneId
  translationKey: string
}

const activityItems: readonly ActivityItem[] = [
  { icon: FolderTree, pane: 'explorer', translationKey: 'chemsmart_studio.ide.activity.explorer' },
  { icon: FlaskConical, pane: 'jobs', translationKey: 'chemsmart_studio.ide.activity.calculations' },
  { icon: Bot, pane: 'decisions', translationKey: 'chemsmart_studio.ide.activity.agent_decisions' },
  { icon: SquareTerminal, pane: 'console', translationKey: 'chemsmart_studio.ide.activity.console' }
]

interface StudioActivityBarProps {
  activePane: StudioPaneId | null
  onPaneSelect: (pane: StudioPaneId) => void
  onSettingsOpen: () => void
}

export function StudioActivityBar({ activePane, onPaneSelect, onSettingsOpen }: StudioActivityBarProps) {
  const { t } = useTranslation()

  return (
    <nav
      aria-label={t('chemsmart_studio.ide.activity.label')}
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-sidebar-border border-r bg-sidebar py-2"
      data-testid="studio-activity-bar">
      {activityItems.map(({ icon: Icon, pane, translationKey }) => {
        const selected = activePane === pane
        const label = t(translationKey)
        return (
          <Tooltip content={label} key={pane}>
            <Button
              aria-current={selected ? 'true' : undefined}
              aria-label={label}
              className="size-8"
              size="icon-sm"
              variant={selected ? 'secondary' : 'ghost'}
              onClick={() => onPaneSelect(pane)}>
              <Icon aria-hidden className="size-4" />
            </Button>
          </Tooltip>
        )
      })}
      <div className="min-h-3 flex-1" />
      <Tooltip content={t('chemsmart_studio.ide.activity.settings')}>
        <Button
          aria-label={t('chemsmart_studio.ide.activity.settings')}
          className="size-8 text-foreground-muted hover:text-foreground"
          size="icon-sm"
          variant="ghost"
          onClick={onSettingsOpen}>
          <Settings2 aria-hidden className="size-4" />
        </Button>
      </Tooltip>
    </nav>
  )
}
