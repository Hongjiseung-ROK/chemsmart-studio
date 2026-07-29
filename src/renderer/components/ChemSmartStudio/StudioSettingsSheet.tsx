import {
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle
} from '@cherrystudio/ui'
import { Accessibility, Activity, Info, ServerCog, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const settingsSections = [
  { icon: ServerCog, id: 'models' },
  { icon: Activity, id: 'readiness' },
  { icon: Accessibility, id: 'appearance' },
  { icon: Info, id: 'about' }
] as const

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
        <div className="flex flex-col gap-2 p-4" role="list">
          {settingsSections.map(({ icon: Icon, id }) => (
            <div
              className="flex min-h-11 items-center gap-3 rounded-md border border-border-subtle bg-background-subtle px-3 text-sm"
              key={id}
              role="listitem">
              <Icon aria-hidden className="size-4 text-foreground-secondary" />
              {t(`chemsmart_studio.ide.settings.${id}`)}
            </div>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
