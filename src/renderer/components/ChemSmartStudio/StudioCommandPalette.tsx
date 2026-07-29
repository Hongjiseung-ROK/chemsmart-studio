import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from '@cherrystudio/ui'
import { FileInput, FolderOpen, PanelsTopLeft, Save, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { StudioPaneId } from './studioLayout'

interface StudioCommandPaletteProps {
  onOpenChange: (open: boolean) => void
  onPaneSelect: (pane: StudioPaneId) => void
  onProjectAction: (action: 'import_molecule' | 'open_project' | 'save_as') => void
  onSettingsOpen: () => void
  open: boolean
}

export function StudioCommandPalette({
  onOpenChange,
  onPaneSelect,
  onProjectAction,
  onSettingsOpen,
  open
}: StudioCommandPaletteProps) {
  const { t } = useTranslation()
  const run = (action: () => void) => {
    onOpenChange(false)
    action()
  }

  return (
    <CommandDialog
      description={t('chemsmart_studio.ide.palette.description')}
      open={open}
      title={t('chemsmart_studio.ide.palette.title')}
      onOpenChange={onOpenChange}>
      <CommandInput placeholder={t('chemsmart_studio.ide.palette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('chemsmart_studio.ide.palette.empty')}</CommandEmpty>
        <CommandGroup heading={t('chemsmart_studio.ide.palette.project')}>
          <CommandItem onSelect={() => run(() => onProjectAction('open_project'))}>
            <FolderOpen aria-hidden />
            {t('chemsmart_studio.editor.open_project')}
          </CommandItem>
          <CommandItem onSelect={() => run(() => onProjectAction('import_molecule'))}>
            <FileInput aria-hidden />
            {t('chemsmart_studio.editor.import_molecule')}
          </CommandItem>
          <CommandItem onSelect={() => run(() => onProjectAction('save_as'))}>
            <Save aria-hidden />
            {t('chemsmart_studio.editor.save_as')}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t('chemsmart_studio.ide.palette.view')}>
          {(['explorer', 'properties', 'agent', 'console', 'jobs', 'problems'] as const).map((pane) => (
            <CommandItem key={pane} onSelect={() => run(() => onPaneSelect(pane))}>
              <PanelsTopLeft aria-hidden />
              {t(`chemsmart_studio.ide.pane.${pane}`)}
              {pane === 'explorer' ? <CommandShortcut>⌘/Ctrl B</CommandShortcut> : null}
              {pane === 'console' ? <CommandShortcut>⌘/Ctrl J</CommandShortcut> : null}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => run(onSettingsOpen)}>
            <Settings2 aria-hidden />
            {t('chemsmart_studio.ide.activity.settings')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
