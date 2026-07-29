import type { StudioUiEvent } from '@chemsmart/studio-protocol'
import { Badge, Button, Scrollbar } from '@cherrystudio/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Reasoning is advisory context, so only the recent stretch is kept. */
const VISIBLE_THOUGHTS = 40

interface AgentThoughtStreamProps {
  /** Trusted activity stream; the thoughts are read out of it, never inferred. */
  events: readonly StudioUiEvent[]
}

/**
 * The Agent's stated reasoning, collapsed by default. It sits apart from the gate results and carries an
 * advisory label, because model confidence is not scientific correctness and must not read like evidence.
 */
export function AgentThoughtStream({ events }: AgentThoughtStreamProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const thoughts = events.filter((event) => event.kind === 'agent_thought').slice(-VISIBLE_THOUGHTS)

  if (thoughts.length === 0) return null

  return (
    <section
      aria-labelledby="chemsmart-agent-thoughts-title"
      className="rounded-lg border border-border-subtle bg-background-subtle"
      data-testid="agent-thought-stream">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Button
          aria-controls="chemsmart-agent-thoughts"
          aria-expanded={open}
          className="min-w-0 flex-1 justify-start gap-1.5"
          size="sm"
          variant="ghost"
          onClick={() => setOpen((current) => !current)}>
          {open ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
          <span id="chemsmart-agent-thoughts-title">
            {t('chemsmart_studio.thoughts.title', { count: thoughts.length })}
          </span>
        </Button>
        <Badge variant="outline">{t('chemsmart_studio.thoughts.advisory')}</Badge>
      </div>
      {open ? (
        <Scrollbar className="max-h-48">
          <ol className="space-y-1.5 px-3 pb-2" id="chemsmart-agent-thoughts">
            {thoughts.map((thought) => (
              <li className="text-xs leading-5" key={thought.eventId}>
                <span className="mr-1.5 font-medium text-foreground-muted">
                  {t(`chemsmart_studio.workspace.agent_phase.${thought.payload.phase}`, {
                    defaultValue: thought.payload.phase ?? ''
                  })}
                </span>
                <span className="font-mono text-foreground-secondary">{thought.payload.message}</span>
              </li>
            ))}
          </ol>
        </Scrollbar>
      ) : null}
    </section>
  )
}
