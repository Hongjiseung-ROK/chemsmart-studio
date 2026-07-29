import type { StudioAgentToolProjection, StudioAgentTurnEvent, StudioAgentTurnStatus } from '@chemsmart/studio-protocol'
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
  FlaskConical,
  ShieldQuestion,
  Wrench
} from 'lucide-react'
import { type ComponentType, type SVGProps, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface AgentTraceTimelineProps {
  events: readonly StudioAgentTurnEvent[]
}

type TraceIcon = ComponentType<SVGProps<SVGSVGElement>>

const statusTranslationKeys: Record<StudioAgentTurnStatus, string> = {
  cancelled: 'chemsmart_studio.agent_workbench.status.cancelled',
  denied: 'chemsmart_studio.trusted_activity.status.denied',
  failed: 'chemsmart_studio.trusted_activity.status.failed',
  needs_user: 'chemsmart_studio.trusted_activity.status.needs_user',
  queued: 'chemsmart_studio.optimization.status.queued',
  running: 'chemsmart_studio.optimization.status.running',
  succeeded: 'chemsmart_studio.trusted_activity.status.completed',
  waiting: 'chemsmart_studio.optimization.status.pending_approval'
}

const statusClasses: Record<StudioAgentTurnStatus, string> = {
  cancelled: 'border-border text-foreground-muted',
  denied: 'border-border text-foreground-muted',
  failed: 'border-destructive text-destructive',
  needs_user: 'border-warning text-warning',
  queued: 'border-border text-foreground-muted',
  running: 'border-info text-info',
  succeeded: 'border-success text-success',
  waiting: 'border-warning text-warning'
}

const kindIcons: Record<Exclude<StudioAgentTurnEvent['kind'], 'user_message'>, TraceIcon> = {
  answer_published: CheckCircle2,
  artifact_published: FlaskConical,
  permission_waiting: ShieldQuestion,
  reasoning_summary: Brain,
  tool_failed: CircleAlert,
  tool_progress: Wrench,
  tool_started: Wrench,
  tool_succeeded: CheckCircle2,
  turn_terminal: Ban
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

function hasStructuredDetail(tool: StudioAgentToolProjection | undefined) {
  return Boolean(
    tool &&
      ((tool.argumentKeys?.length ?? 0) > 0 ||
        (tool.resultKeys?.length ?? 0) > 0 ||
        (tool.ruleIds?.length ?? 0) > 0 ||
        tool.verdict ||
        tool.durationMs !== undefined)
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

function ScientificSummary({ event }: { event: StudioAgentTurnEvent }) {
  const { t } = useTranslation()
  if (event.answer) {
    return (
      <div className="space-y-2 px-2 pb-2">
        <p className="font-medium text-foreground text-sm">{event.answer.heading}</p>
        <p className="text-foreground-secondary text-xs leading-5">{event.answer.summary}</p>
        {event.answer.sections.map((section) => (
          <div className="rounded-md border border-border-subtle p-2" key={`${section.kind}:${section.heading}`}>
            <p className="font-medium text-foreground text-xs">{section.heading}</p>
            <p className="mt-1 text-foreground-muted text-xs leading-5">{section.summary}</p>
          </div>
        ))}
      </div>
    )
  }
  if (!event.artifact) return <p className="px-2 pb-2 text-foreground-secondary text-xs leading-5">{event.summary}</p>
  const artifact = event.artifact
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 pb-2 text-xs">
      <dt className="text-foreground-muted">{t('chemsmart_studio.agent_workbench.science.molecule')}</dt>
      <dd className="truncate font-mono text-foreground-secondary">
        r{artifact.revision} · {artifact.geometryHash.slice(0, 15)}
      </dd>
      <dt className="text-foreground-muted">{t('chemsmart_studio.agent_workbench.science.state')}</dt>
      <dd className="text-foreground-secondary">
        {artifact.charge} · {artifact.multiplicity}
      </dd>
      {artifact.engine ? (
        <>
          <dt className="text-foreground-muted">{t('chemsmart_studio.agent_workbench.science.method')}</dt>
          <dd className="text-foreground-secondary">
            {artifact.engine} · {artifact.method} · {artifact.calculationKind}
          </dd>
        </>
      ) : null}
      {artifact.energy ? (
        <>
          <dt className="text-foreground-muted">{t('chemsmart_studio.agent_workbench.science.energy')}</dt>
          <dd className="font-mono text-foreground-secondary">
            {artifact.energy.value} {artifact.energy.unit}
          </dd>
        </>
      ) : null}
    </dl>
  )
}

function AgentTurnEventCard({ event, live }: { event: StudioAgentTurnEvent; live: boolean }) {
  const { t } = useTranslation()
  const failed = event.kind === 'tool_failed' || event.status === 'failed'
  const [open, setOpen] = useState(failed)
  const detailId = useId()
  const expandable = hasStructuredDetail(event.tool)
  const Icon = kindIcons[event.kind as Exclude<StudioAgentTurnEvent['kind'], 'user_message'>]

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
      {event.tool ? (
        <Badge className="max-w-32 font-mono" variant="outline">
          <span className="truncate">{event.tool.toolName}</span>
        </Badge>
      ) : null}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-medium text-foreground">{event.tool?.purpose ?? event.summary}</span>
        {event.tool && event.tool.purpose !== event.summary ? (
          <span className="block truncate text-foreground-muted text-xs">{event.summary}</span>
        ) : null}
      </span>
      {event.status === 'running' ? <RunningWave /> : null}
      {event.tool?.durationMs !== undefined ? (
        <span className="shrink-0 font-mono text-foreground-muted text-xs">
          {t('chemsmart_studio.agent_trace.elapsed', { duration: event.tool.durationMs })}
        </span>
      ) : null}
      <Badge className={statusClasses[event.status]} variant="outline">
        {t(statusTranslationKeys[event.status])}
      </Badge>
    </>
  )

  return (
    <li data-status={event.status} data-trace-event-id={event.eventId}>
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
        {event.answer || event.artifact ? <ScientificSummary event={event} /> : null}
        {open && expandable ? (
          <dl className="space-y-1.5 border-border-muted border-t px-2 py-2 text-xs" id={detailId}>
            <DetailValues label={t('chemsmart_studio.agent_trace.input')} values={event.tool?.argumentKeys ?? []} />
            <DetailValues label={t('chemsmart_studio.agent_trace.output')} values={event.tool?.resultKeys ?? []} />
            <DetailValues label={t('chemsmart_studio.agent_trace.rules')} values={event.tool?.ruleIds ?? []} />
            {event.tool?.verdict ? (
              <div className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-2">
                <dt className="text-foreground-muted">{t('chemsmart_studio.agent_trace.verdict')}</dt>
                <dd className="min-w-0 break-words font-mono text-foreground-secondary">{event.tool.verdict}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </article>
    </li>
  )
}

interface ProjectionTurn {
  events: StudioAgentTurnEvent[]
  failed: boolean
  terminal: boolean
  turnId: string
}

const transientStatuses = new Set<StudioAgentTurnStatus>(['queued', 'running', 'waiting'])

function settleReasoningEvents(events: readonly StudioAgentTurnEvent[]) {
  const terminal = [...events].reverse().find((event) => event.kind === 'turn_terminal')
  return events
    .filter((event) => event.kind === 'reasoning_summary')
    .map((event) =>
      terminal && transientStatuses.has(event.status)
        ? {
            ...event,
            status: terminal.status
          }
        : event
    )
}

function groupTurns(events: readonly StudioAgentTurnEvent[]): ProjectionTurn[] {
  const turns = new Map<string, ProjectionTurn>()
  for (const event of events) {
    const turn: ProjectionTurn = turns.get(event.turnId) ?? {
      events: [],
      failed: false,
      terminal: false,
      turnId: event.turnId
    }
    turn.events.push(event)
    turn.failed ||= event.kind === 'tool_failed' || event.status === 'failed'
    turn.terminal ||= event.kind === 'turn_terminal'
    turns.set(event.turnId, turn)
  }
  return [...turns.values()]
}

function groupToolEvents(events: readonly StudioAgentTurnEvent[]): StudioAgentTurnEvent[] {
  const groups = new Map<string, StudioAgentTurnEvent[]>()
  for (const event of events) {
    const key = event.tool?.toolCallId ?? event.eventId
    const lifecycle = groups.get(key) ?? []
    lifecycle.push(event)
    groups.set(key, lifecycle)
  }
  return [...groups.values()].map((lifecycle) => {
    const first = lifecycle[0]
    const latest = lifecycle.at(-1) ?? first
    const tools = lifecycle.flatMap((event) => (event.tool ? [event.tool] : []))
    if (!first.tool || tools.length === 0) return latest
    const unique = (values: readonly (readonly string[] | undefined)[]) => [
      ...new Set(values.flatMap((value) => value ?? []))
    ]
    const argumentKeys = unique(tools.map((tool) => tool.argumentKeys))
    const resultKeys = unique(tools.map((tool) => tool.resultKeys))
    const ruleIds = unique(tools.map((tool) => tool.ruleIds))
    const finalWithVerdict = [...tools].reverse().find((tool) => tool.verdict !== undefined)
    const finalWithDuration = [...tools].reverse().find((tool) => tool.durationMs !== undefined)
    return {
      ...latest,
      tool: {
        toolCallId: first.tool.toolCallId,
        toolName: first.tool.toolName,
        purpose: first.tool.purpose,
        ...(argumentKeys.length > 0 ? { argumentKeys } : {}),
        ...(resultKeys.length > 0 ? { resultKeys } : {}),
        ...(ruleIds.length > 0 ? { ruleIds } : {}),
        ...(finalWithVerdict?.verdict ? { verdict: finalWithVerdict.verdict } : {}),
        ...(finalWithDuration?.durationMs !== undefined ? { durationMs: finalWithDuration.durationMs } : {})
      }
    }
  })
}

function EventSection({
  current,
  events,
  label
}: {
  current: boolean
  events: readonly StudioAgentTurnEvent[]
  label: string
}) {
  if (events.length === 0) return null
  return (
    <section aria-label={label} className="space-y-1.5">
      <h4 className="px-0.5 font-medium text-[11px] text-foreground-muted uppercase tracking-wide">{label}</h4>
      <ol className="space-y-1.5">
        {events.map((event, index) => (
          <AgentTurnEventCard event={event} key={event.eventId} live={current && index === events.length - 1} />
        ))}
      </ol>
    </section>
  )
}

function AgentProjectionTurn({ current, index, turn }: { current: boolean; index: number; turn: ProjectionTurn }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(current || turn.failed)
  const contentId = useId()
  const request = turn.events.find((event) => event.kind === 'user_message')
  const reasoning = settleReasoningEvents(turn.events)
  const tools = groupToolEvents(
    turn.events.filter((event) =>
      ['tool_started', 'permission_waiting', 'tool_progress', 'tool_succeeded', 'tool_failed'].includes(event.kind)
    )
  )
  const results = turn.events.filter((event) =>
    ['artifact_published', 'answer_published', 'turn_terminal'].includes(event.kind)
  )

  useEffect(() => setOpen(current || turn.failed), [current, turn.failed])

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
        <Clock3 aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />
        <span className="min-w-0 flex-1 truncate text-left">
          {request?.summary ?? t('chemsmart_studio.agent_trace.turn', { index })}
        </span>
        {current ? <Badge variant="secondary">{t('chemsmart_studio.agent_trace.current')}</Badge> : null}
      </Button>
      {open ? (
        <div className="space-y-3 px-2 pb-2" id={contentId}>
          {request ? (
            <section aria-label={t('chemsmart_studio.agent_workbench.request')}>
              <div className="ml-6 rounded-lg border border-border-subtle bg-secondary px-3 py-2 text-foreground text-sm leading-5">
                {request.summary}
              </div>
            </section>
          ) : null}
          <EventSection current={current} events={reasoning} label={t('chemsmart_studio.agent_workbench.reasoning')} />
          <EventSection current={current} events={tools} label={t('chemsmart_studio.agent_workbench.tools')} />
          <EventSection current={current} events={results} label={t('chemsmart_studio.agent_workbench.result')} />
        </div>
      ) : null}
    </li>
  )
}

/** Main-owned, schema-validated projection. Provider payloads and raw reasoning never reach this component. */
export function AgentTraceTimeline({ events }: AgentTraceTimelineProps) {
  const turns = useMemo(() => groupTurns(events), [events])
  const currentTurnId = [...turns].reverse().find((turn) => !turn.terminal)?.turnId ?? turns.at(-1)?.turnId
  if (turns.length === 0) return null
  return (
    <ol className="space-y-2" data-testid="agent-trace-timeline">
      {turns.map((turn, index) => (
        <AgentProjectionTurn current={turn.turnId === currentTurnId} index={index + 1} key={turn.turnId} turn={turn} />
      ))}
    </ol>
  )
}
