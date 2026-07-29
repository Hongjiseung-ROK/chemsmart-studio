import type { StudioAgentTraceEvent } from '@chemsmart/studio-protocol'
import { Badge, Button } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import {
  Ban,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  ShieldQuestion,
  Wrench
} from 'lucide-react'
import { type ComponentType, type SVGProps, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface AgentTraceTimelineProps {
  events: readonly StudioAgentTraceEvent[]
}

type TraceStatus = StudioAgentTraceEvent['status']
type TraceKind = StudioAgentTraceEvent['kind']
type TraceIcon = ComponentType<SVGProps<SVGSVGElement>>

const statusTranslationKeys: Record<TraceStatus, string> = {
  denied: 'chemsmart_studio.trusted_activity.status.denied',
  failed: 'chemsmart_studio.trusted_activity.status.failed',
  queued: 'chemsmart_studio.optimization.status.queued',
  running: 'chemsmart_studio.optimization.status.running',
  succeeded: 'chemsmart_studio.trusted_activity.status.completed',
  waiting: 'chemsmart_studio.optimization.status.pending_approval'
}

const statusClasses: Record<TraceStatus, string> = {
  denied: 'border-warning text-warning',
  failed: 'border-destructive text-destructive',
  queued: 'border-border text-foreground-muted',
  running: 'border-info text-info',
  succeeded: 'border-success text-success',
  waiting: 'border-warning text-warning'
}

const kindIcons: Record<TraceKind, TraceIcon> = {
  permission_waiting: ShieldQuestion,
  reasoning_summary: Brain,
  tool_failed: CircleAlert,
  tool_progress: Wrench,
  tool_started: Wrench,
  tool_succeeded: CheckCircle2,
  turn_blocked: Ban,
  turn_completed: CheckCircle2,
  turn_started: Clock3
}

function RunningWave() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5" data-testid="agent-trace-running-wave">
      {[0, 1, 2].map((index) => (
        <span
          className="size-1 animate-bounce rounded-full bg-info motion-reduce:animate-none"
          key={index}
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  )
}

function hasStructuredDetail(event: StudioAgentTraceEvent) {
  const detail = event.detail
  return Boolean(
    detail &&
      ((detail.argumentKeys?.length ?? 0) > 0 ||
        (detail.resultKeys?.length ?? 0) > 0 ||
        (detail.ruleIds?.length ?? 0) > 0 ||
        detail.verdict ||
        detail.durationMs !== undefined)
  )
}

function DetailValues({ label, values }: { label: string; values: readonly string[] }) {
  if (values.length === 0) return null
  return (
    <div className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-2">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap gap-1">
        {values.map((value) => (
          <Badge className="max-w-full font-mono" key={value} variant="outline">
            <span className="truncate">{value}</span>
          </Badge>
        ))}
      </dd>
    </div>
  )
}

function AgentTraceEventCard({
  effectiveStatus,
  event,
  live
}: {
  effectiveStatus: TraceStatus
  event: StudioAgentTraceEvent
  live: boolean
}) {
  const { t } = useTranslation()
  const failed = event.kind === 'tool_failed' || event.kind === 'turn_blocked' || effectiveStatus === 'failed'
  const [open, setOpen] = useState(failed)
  const detailId = useId()
  const expandable = hasStructuredDetail(event)
  const Icon = kindIcons[event.kind]

  useEffect(() => {
    if (failed) setOpen(true)
  }, [failed])

  const header = (
    <>
      {expandable ? (
        open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
      <Icon aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />
      {event.toolName ? (
        <Badge className="max-w-32 font-mono" variant="outline">
          <span className="truncate">{event.toolName}</span>
        </Badge>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">{event.title}</span>
      {effectiveStatus === 'running' ? <RunningWave /> : null}
      {event.detail?.durationMs !== undefined ? (
        <span className="shrink-0 font-mono text-foreground-muted text-xs">
          {t('chemsmart_studio.agent_trace.elapsed', { duration: event.detail.durationMs })}
        </span>
      ) : null}
      <Badge
        aria-label={t(statusTranslationKeys[effectiveStatus])}
        className={statusClasses[effectiveStatus]}
        data-trace-status={effectiveStatus}
        variant="outline">
        {t(statusTranslationKeys[effectiveStatus])}
      </Badge>
    </>
  )

  return (
    <li data-status={effectiveStatus} data-trace-event-id={event.eventId}>
      <article
        aria-live={live ? 'polite' : 'off'}
        className={cn(
          'rounded-md border border-border-subtle bg-background-subtle',
          failed && 'border-error-border bg-error-bg'
        )}>
        {expandable ? (
          <Button
            aria-controls={detailId}
            aria-expanded={open}
            className="h-auto min-h-8 w-full justify-start gap-1.5 rounded-md px-2 py-1.5"
            size="sm"
            variant="ghost"
            onClick={() => setOpen((current) => !current)}>
            {header}
          </Button>
        ) : (
          <div className="flex min-h-8 items-center gap-1.5 px-2 py-1.5">{header}</div>
        )}
        <p className="px-2 pb-2 text-foreground-secondary text-xs leading-5">{event.summary}</p>
        {open && expandable ? (
          <dl className="space-y-1.5 border-border-muted border-t px-2 py-2 text-xs" id={detailId}>
            <DetailValues label={t('chemsmart_studio.agent_trace.input')} values={event.detail?.argumentKeys ?? []} />
            <DetailValues label={t('chemsmart_studio.agent_trace.output')} values={event.detail?.resultKeys ?? []} />
            <DetailValues label={t('chemsmart_studio.agent_trace.rules')} values={event.detail?.ruleIds ?? []} />
            {event.detail?.verdict ? (
              <div className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-2">
                <dt className="text-foreground-muted">{t('chemsmart_studio.agent_trace.verdict')}</dt>
                <dd className="min-w-0 break-words font-mono text-foreground-secondary">{event.detail.verdict}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </article>
    </li>
  )
}

interface TraceTurn {
  events: StudioAgentTraceEvent[]
  failed: boolean
  terminalStatus?: TraceStatus
  turnId: string
}

function groupTurns(events: readonly StudioAgentTraceEvent[]): TraceTurn[] {
  const turns = new Map<string, TraceTurn>()
  for (const event of events) {
    const turn: TraceTurn = turns.get(event.turnId) ?? { events: [], failed: false, turnId: event.turnId }
    turn.events.push(event)
    turn.failed ||= event.kind === 'tool_failed' || event.kind === 'turn_blocked' || event.status === 'failed'
    if (event.kind === 'turn_completed' || event.kind === 'turn_blocked') turn.terminalStatus = event.status
    turns.set(event.turnId, turn)
  }
  return [...turns.values()]
}

function AgentTraceTurn({ current, index, turn }: { current: boolean; index: number; turn: TraceTurn }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(current || turn.failed)
  const contentId = useId()

  useEffect(() => {
    setOpen(current || turn.failed)
  }, [current, turn.failed])

  return (
    <li className="rounded-lg border border-border-subtle bg-background" data-current={current || undefined}>
      <Button
        aria-controls={contentId}
        aria-expanded={open}
        className="h-auto min-h-8 w-full justify-start gap-1.5 px-2 py-1.5"
        size="sm"
        variant="ghost"
        onClick={() => setOpen((value) => !value)}>
        {open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{t('chemsmart_studio.agent_trace.turn', { index })}</span>
        {current ? <Badge variant="secondary">{t('chemsmart_studio.agent_trace.current')}</Badge> : null}
        <Badge className={turn.failed ? statusClasses.failed : undefined} variant="outline">
          {turn.events.length}
        </Badge>
      </Button>
      {open ? (
        <ol className="space-y-1.5 px-2 pb-2" id={contentId}>
          {turn.events.map((event, index) => {
            const effectiveStatus =
              turn.terminalStatus !== undefined &&
              event.status === 'running' &&
              event.kind !== 'turn_completed' &&
              event.kind !== 'turn_blocked'
                ? turn.terminalStatus
                : event.status
            return (
              <AgentTraceEventCard
                effectiveStatus={effectiveStatus}
                event={event}
                key={event.eventId}
                live={current && index === turn.events.length - 1}
              />
            )
          })}
        </ol>
      ) : null}
    </li>
  )
}

/**
 * Balanced, trusted Agent activity. Current work is visible, historical turns recede, and only
 * schema-approved summaries cross the renderer boundary.
 */
export function AgentTraceTimeline({ events }: AgentTraceTimelineProps) {
  const turns = useMemo(() => groupTurns(events), [events])
  const latestTurn = turns.at(-1)
  const currentTurnId = latestTurn?.terminalStatus === undefined ? latestTurn?.turnId : undefined

  if (turns.length === 0) return null

  return (
    <ol className="space-y-2" data-testid="agent-trace-timeline">
      {turns.map((turn, index) => (
        <AgentTraceTurn current={turn.turnId === currentTurnId} index={index + 1} key={turn.turnId} turn={turn} />
      ))}
    </ol>
  )
}
