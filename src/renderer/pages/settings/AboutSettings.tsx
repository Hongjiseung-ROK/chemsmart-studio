import { Badge, Button, Divider } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'
import LogoAvatar from '@renderer/components/icons/LogoAvatar'
import {
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingsContentColumn,
  SettingTitle
} from '@renderer/components/SettingsPrimitives'
import { useTheme } from '@renderer/hooks/useTheme'
import { ipcApi } from '@renderer/ipc'
import { Bug, Github, Rss } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const REPOSITORY_URL = 'https://github.com/Hongjiseung-ROK/chemsmart-studio'

const AboutSettings: FC = () => {
  const [version, setVersion] = useState('')
  const { t } = useTranslation()
  const { theme } = useTheme()

  const openWebsite = (url: string) => {
    void ipcApi.request('system.shell.open_website', url)
  }

  useEffect(() => {
    void ipcApi.request('app.get_info').then((appInfo) => setVersion(appInfo.version))
  }, [])

  return (
    <SettingsContentColumn theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle className="gap-2">
          <span className="font-semibold text-[15px]">{t('settings.about.title')}</span>
          <button
            type="button"
            aria-label={t('chemsmart_studio.release.open_source')}
            onClick={() => openWebsite(REPOSITORY_URL)}
            className="inline-flex size-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
            <Github className="size-5" />
          </button>
        </SettingTitle>

        <Divider className="my-1.5" />

        <div className="flex flex-wrap items-center gap-3 py-1">
          <LogoAvatar logo={AppLogo} size={72} className="rounded-2xl" />
          <div className="flex min-h-18 min-w-0 flex-1 flex-col items-start justify-center">
            <div className="mb-1 font-bold text-foreground text-lg">ChemSmart Studio</div>
            <div className="text-foreground-secondary text-sm">{t('chemsmart_studio.release.description')}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge className="rounded-md border-primary/20 bg-primary/10 px-1.5 py-0 font-medium text-[11px] text-primary leading-4">
                v{version}
              </Badge>
              <Badge className="rounded-md border-border bg-muted px-1.5 py-0 font-medium text-[11px] text-foreground-secondary leading-4">
                {t('chemsmart_studio.release.channel')}
              </Badge>
            </div>
          </div>
        </div>

        <Divider className="my-3" />
        <dl className="grid gap-2 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr]">
          <dt className="text-foreground-secondary">{t('chemsmart_studio.release.copyright_label')}</dt>
          <dd>© 2026 Zhang Lab</dd>
          <dt className="text-foreground-secondary">{t('chemsmart_studio.release.maintainer_label')}</dt>
          <dd>Jiseung Hong</dd>
          <dt className="text-foreground-secondary">{t('chemsmart_studio.release.distribution_label')}</dt>
          <dd>{t('chemsmart_studio.release.distribution')}</dd>
          <dt className="text-foreground-secondary">{t('chemsmart_studio.release.readiness_label')}</dt>
          <dd>{t('chemsmart_studio.release.readiness')}</dd>
        </dl>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <AboutActionRow
          icon={<Rss className="size-4.5" />}
          title={t('settings.about.releases.title')}
          actionLabel={t('settings.about.releases.button')}
          onAction={() => openWebsite(`${REPOSITORY_URL}/releases`)}
        />
        <Divider className="my-3" />
        <AboutActionRow
          icon={<Github className="size-4.5" />}
          title={t('settings.about.feedback.title')}
          actionLabel={t('settings.about.feedback.button')}
          onAction={() => openWebsite(`${REPOSITORY_URL}/issues/new`)}
        />
        <Divider className="my-3" />
        <AboutActionRow
          icon={<Bug className="size-4.5" />}
          title={t('settings.about.debug.title')}
          actionLabel={t('settings.about.debug.open')}
          onAction={() => ipcApi.request('system.toggle_dev_tools')}
        />
      </SettingGroup>
    </SettingsContentColumn>
  )
}

function AboutActionRow({
  actionLabel,
  icon,
  onAction,
  title
}: {
  actionLabel: string
  icon: ReactNode
  onAction: () => void | Promise<void>
  title: string
}) {
  return (
    <SettingRow className="gap-3">
      <SettingRowTitle className="gap-2.5">
        {icon}
        {title}
      </SettingRowTitle>
      <Button size="sm" onClick={() => void onAction()} variant="outline">
        {actionLabel}
      </Button>
    </SettingRow>
  )
}

export default AboutSettings
