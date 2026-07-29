import { SegmentedControl, Tooltip } from '@cherrystudio/ui'
import { ShieldCheck, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export const agentModes = ['allow', 'execute'] as const
export type AgentMode = (typeof agentModes)[number]

const MODE_ICONS = { allow: ShieldCheck, execute: Zap } as const

interface AgentModeSwitchProps {
  /** True while a switch is in flight, or while the session cannot accept one. */
  disabled: boolean
  mode: AgentMode
  onChange: (mode: AgentMode) => void
}

/**
 * How much the agent may do without asking.
 *
 * Allow decides every action. Execute pre-authorizes the *reversible* ones for the session — a
 * committed molecule preview publishes a new revision and can be undone, so granting it costs the
 * researcher nothing they cannot take back. Starting a calculation is never granted in either mode:
 * it spends compute, and no revision undoes that.
 *
 * The switch names the mode; main's policy table decides what the mode covers, so the two cannot
 * drift into disagreeing about what was authorized.
 */
export function AgentModeSwitch({ disabled, mode, onChange }: AgentModeSwitchProps) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-2" data-testid="agent-mode-switch">
      <SegmentedControl
        aria-label={t('chemsmart_studio.agent_mode.label')}
        disabled={disabled}
        options={agentModes.map((value) => {
          const Icon = MODE_ICONS[value]
          return {
            value,
            label: (
              <Tooltip key={value} title={t(`chemsmart_studio.agent_mode.${value}_description`)}>
                <span className="flex items-center gap-1.5">
                  <Icon aria-hidden className="size-3.5" />
                  {t(`chemsmart_studio.agent_mode.${value}`)}
                </span>
              </Tooltip>
            )
          }
        })}
        size="sm"
        value={mode}
        onValueChange={(value) => onChange(value)}
      />
    </div>
  )
}
