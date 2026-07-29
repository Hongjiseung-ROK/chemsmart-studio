import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@cherrystudio/ui'
import { useTranslation } from 'react-i18next'

import type { StudioPaneId } from './studioLayout'

interface StudioToolkitMenuProps {
  isPaneExpanded: (pane: StudioPaneId) => boolean
  onCommandPaletteOpen: () => void
  onPaneSelect: (pane: StudioPaneId) => void
  onSettingsOpen: () => void
}

const viewPanes = ['explorer', 'agent', 'console', 'jobs', 'problems'] as const satisfies readonly StudioPaneId[]

function MenuTrigger({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button className="h-8 rounded-sm px-2.5 text-xs" size="sm" variant="ghost">
        {label}
      </Button>
    </DropdownMenuTrigger>
  )
}

export function StudioToolkitMenu({
  isPaneExpanded,
  onCommandPaletteOpen,
  onPaneSelect,
  onSettingsOpen
}: StudioToolkitMenuProps) {
  const { t } = useTranslation()

  return (
    <nav
      aria-label={t('chemsmart_studio.toolkit.label')}
      className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-border border-b bg-background-subtle px-2 [-webkit-app-region:no-drag]"
      data-testid="studio-toolkit-menu">
      <DropdownMenu>
        <MenuTrigger label={t('chemsmart_studio.toolkit.settings')} />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={onSettingsOpen}>{t('chemsmart_studio.ide.settings.title')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <MenuTrigger label={t('chemsmart_studio.toolkit.view')} />
        <DropdownMenuContent align="start">
          {viewPanes.map((pane) => (
            <DropdownMenuCheckboxItem checked={isPaneExpanded(pane)} key={pane} onSelect={() => onPaneSelect(pane)}>
              {t(`chemsmart_studio.ide.pane.${pane}`)}
              {pane === 'explorer' ? <DropdownMenuShortcut>⌘/Ctrl B</DropdownMenuShortcut> : null}
              {pane === 'console' ? <DropdownMenuShortcut>⌘/Ctrl J</DropdownMenuShortcut> : null}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuItem onSelect={onCommandPaletteOpen}>
            {t('chemsmart_studio.ide.palette.title')}
            <DropdownMenuShortcut>⌘/Ctrl ⇧ P</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <MenuTrigger label={t('chemsmart_studio.toolkit.server')} />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onPaneSelect('jobs')}>
            {t('chemsmart_studio.ide.pane.jobs')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onSettingsOpen}>{t('chemsmart_studio.ide.settings.readiness')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <MenuTrigger label={t('chemsmart_studio.toolkit.agent')} />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onPaneSelect('agent')}>
            {t('chemsmart_studio.ide.pane.agent')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaneSelect('decisions')}>
            {t('chemsmart_studio.ide.pane.decisions')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <MenuTrigger label={t('chemsmart_studio.toolkit.info')} />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={onSettingsOpen}>{t('chemsmart_studio.ide.settings.about')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  )
}
