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
  requests?: readonly AgentConversationRequest[]
}

export interface AgentConversationRequest {
  id: string
  status: 'failed' | 'running' | 'succeeded'
  text: string
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
  denied: 'border-border text-foreground-muted',
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
  const failed = event.kind === 'tool_failed' || effectiveStatus === 'failed'
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
    turn.failed ||= event.kind === 'tool_failed' || event.status === 'failed'
    if (event.kind === 'turn_completed' || event.kind === 'turn_blocked') turn.terminalStatus = event.status
    turns.set(event.turnId, turn)
  }
  return [...turns.values()]
}

function EventSection({
  current,
  events,
  label
}: {
  current: boolean
  events: readonly StudioAgentTraceEvent[]
  label: string
}) {
  if (events.length === 0) return null
  return (
    <section aria-label={label} className="space-y-1.5">
      <h4 className="px-0.5 font-medium text-[11px] text-foreground-muted uppercase tracking-wide">{label}</h4>
      <ol className="space-y-1.5">
        {events.map((event, index) => (
          <AgentTraceEventCard
            effectiveStatus={event.status}
            event={event}
            key={event.eventId}
            live={current && index === events.length - 1}
          />
        ))}
      </ol>
    </section>
  )
}

function unique(values: readonly (readonly string[] | undefined)[]) {
  return [...new Set(values.flatMap((value) => value ?? []))]
}

function groupToolLifecycles(events: readonly StudioAgentTraceEvent[]) {
  const groups = new Map<string, StudioAgentTraceEvent[]>()
  for (const event of events) {
    const key = event.toolCallId ?? event.eventId
    const lifecycle = groups.get(key) ?? []
    lifecycle.push(event)
    groups.set(key, lifecycle)
  }

  return [...groups.values()].map((lifecycle) => {
    const first = lifecycle[0]
    const latest = lifecycle.at(-1) ?? first
    const argumentKeys = unique(lifecycle.map((event) => event.detail?.argumentKeys))
    const resultKeys = unique(lifecycle.map((event) => event.detail?.resultKeys))
    const ruleIds = unique(lifecycle.map((event) => event.detail?.ruleIds))
    const verdict = [...lifecycle].reverse().find((event) => event.detail?.verdict)?.detail?.verdict
    const durationMs = [...lifecycle].reverse().find((event) => event.detail?.durationMs !== undefined)
      ?.detail?.durationMs
    const hasDetail =
      argumentKeys.length > 0 ||
      resultKeys.length > 0 ||
      ruleIds.length > 0 ||
      verdict !== undefined ||
      durationMs !== undefined

    return {
      ...latest,
      ...(hasDetail
        ? {
            detail: {
              ...(argumentKeys.length > 0 ? { argumentKeys } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(resultKeys.length > 0 ? { resultKeys } : {}),
              ...(ruleIds.length > 0 ? { ruleIds } : {}),
              ...(verdict !== undefined ? { verdict } : {})
            }
          }
        : {}),
      title: first.title,
      toolName: first.toolName ?? latest.toolName
    }
  })
}

function ToolLifecycleSection({
  current,
  events,
  label
}: {
  current: boolean
  events: readonly StudioAgentTraceEvent[]
  label: string
}) {
  const lifecycles = groupToolLifecycles(events)
  if (lifecycles.length === 0) return null
  return (
    <section aria-label={label} className="space-y-1.5">
      <h4 className="px-0.5 font-medium text-[11px] text-foreground-muted uppercase tracking-wide">{label}</h4>
      <ol className="space-y-1.5">
        {lifecycles.map((event, index) => (
          <AgentTraceEventCard
            effectiveStatus={event.status}
            event={event}
            key={event.toolCallId ?? event.eventId}
            live={current && index === lifecycles.length - 1}
          />
        ))}
      </ol>
    </section>
  )
}

function AgentTraceTurn({
  current,
  index,
  request,
  turn
}: {
  current: boolean
  index: number
  request?: AgentConversationRequest
  turn: TraceTurn
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(current || turn.failed)
  const contentId = useId()
  const effectiveEvents = turn.events.map((event) => ({
    ...event,
    status:
      turn.terminalStatus !== undefined &&
      event.status === 'running' &&
      event.kind !== 'turn_completed' &&
      event.kind !== 'turn_blocked'
        ? turn.terminalStatus
        : event.status
  }))
  const reasoningEvents = effectiveEvents.filter(
    (event) => event.kind === 'turn_started' || event.kind === 'reasoning_summary'
  )
  const toolEvents = effectiveEvents.filter(
    (event) =>
      event.kind === 'tool_started' ||
      event.kind === 'tool_progress' ||
      event.kind === 'tool_succeeded' ||
      event.kind === 'tool_failed' ||
      event.kind === 'permission_waiting'
  )
  const resultEvents = effectiveEvents.filter(
    (event) => event.kind === 'turn_completed' || event.kind === 'turn_blocked'
  )

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
        <div className="space-y-3 px-2 pb-2" id={contentId}>
          {request ? (
            <section aria-label={t('chemsmart_studio.agent_workbench.request')}>
              <div
                className={cn(
                  'ml-6 rounded-lg border border-border-subtle bg-secondary px-3 py-2 text-foreground text-sm leading-5',
                  request.status === 'failed' && 'border-error-border bg-error-bg text-error-text'
                )}>
                {request.text}
              </div>
            </section>
          ) : null}
          <EventSection
            current={current}
            events={reasoningEvents}
            label={t('chemsmart_studio.agent_workbench.reasoning')}
          />
          <ToolLifecycleSection
            current={current}
            events={toolEvents}
            label={t('chemsmart_studio.agent_workbench.tools')}
          />
          <EventSection current={current} events={resultEvents} label={t('chemsmart_studio.agent_workbench.result')} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * Balanced, trusted Agent activity. Current work is visible, historical turns recede, and only
 * schema-approved summaries cross the renderer boundary.
 */
export function AgentTraceTimeline({ events, requests = [] }: AgentTraceTimelineProps) {
  const { t } = useTranslation()
  const turns = useMemo(() => groupTurns(events), [events])
  const latestTurn = turns.at(-1)
  const currentTurnId = latestTurn?.turnId
  const pendingRequests = requests.slice(turns.length)

  if (turns.length === 0 && requests.length === 0) return null

  return (
    <ol className="space-y-2" data-testid="agent-trace-timeline">
      {turns.map((turn, index) => (
        <AgentTraceTurn
          current={turn.turnId === currentTurnId}
          index={index + 1}
          key={turn.turnId}
          request={requests[index]}
          turn={turn}
        />
      ))}
      {pendingRequests.map((request, index) => (
        <li
          className={cn(
            'rounded-lg border border-border-subtle bg-background p-2',
            request.status === 'failed' && 'border-error-border bg-error-bg'
          )}
          key={request.id}>
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <span className="font-medium text-foreground text-sm">
              {t('chemsmart_studio.agent_trace.turn', { index: turns.length + index + 1 })}
            </span>
            <Badge variant="secondary">{t('chemsmart_studio.agent_trace.current')}</Badge>
          </div>
          <div className="ml-6 rounded-lg border border-border-subtle bg-secondary px-3 py-2 text-foreground text-sm leading-5">
            {request.text}
          </div>
          {request.status === 'running' ? (
            <div className="mt-2 flex items-center gap-2 px-1 text-foreground-muted text-xs" role="status">
              <RunningWave />
              {t('chemsmart_studio.agent_workbench.waiting_for_agent')}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
