import {
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle
} from '@cherrystudio/ui'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import type { SettingsPath } from '@shared/data/types/settingsPath'
import { Accessibility, Activity, Bot, Info, ServerCog, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const settingsSections = [
  { icon: Bot, id: 'defaultModel', path: '/settings/model' },
  { icon: ServerCog, id: 'models', path: '/settings/provider' },
  { icon: Activity, id: 'readiness', path: '/settings/dependencies' },
  { icon: Accessibility, id: 'appearance', path: '/settings/appearance' },
  { icon: Info, id: 'about', path: '/settings/about' }
] as const satisfies readonly {
  icon: typeof ServerCog
  id: 'defaultModel' | 'models' | 'readiness' | 'appearance' | 'about'
  path: SettingsPath
}[]

interface StudioSettingsSheetProps {
  onOpenChange: (open: boolean) => void
  open: boolean
}

export function StudioSettingsSheet({ onOpenChange, open }: StudioSettingsSheetProps) {
  const { t } = useTranslation()

  return (
    <Drawer direction="right" open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        aria-describedby="studio-settings-description"
        className="w-[min(92vw,420px)] sm:max-w-none"
        data-testid="studio-settings-sheet">
        <DrawerHeader className="flex-row items-center justify-between border-border border-b">
          <div>
            <DrawerTitle>{t('chemsmart_studio.ide.settings.title')}</DrawerTitle>
            <DrawerDescription id="studio-settings-description">
              {t('chemsmart_studio.ide.settings.description')}
            </DrawerDescription>
          </div>
          <DrawerClose asChild>
            <Button
              aria-label={t('common.close')}
              className="size-8 text-foreground-muted hover:text-foreground"
              size="icon-sm"
              variant="ghost">
              <X aria-hidden className="size-4" />
            </Button>
          </DrawerClose>
        </DrawerHeader>
        <div className="flex flex-col gap-2 p-4">
          {settingsSections.map(({ icon: Icon, id, path }) => (
            <Button
              className="min-h-11 justify-start gap-3 border border-border-subtle bg-background-subtle px-3 text-sm"
              key={id}
              variant="ghost"
              onClick={() => {
                onOpenChange(false)
                openSettingsTab(path)
              }}>
              <Icon aria-hidden className="size-4 text-foreground-secondary" />
              {id === 'defaultModel' ? t('settings.model') : t(`chemsmart_studio.ide.settings.${id}`)}
            </Button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
