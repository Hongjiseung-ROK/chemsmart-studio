import '@cherrystudio/ui/components/composites/markdown/styles'

import type {
  StudioAgentLiveEvent,
  StudioAgentToolProjection,
  StudioAgentTurnEvent,
  StudioAgentTurnStatus
} from '@chemsmart/studio-protocol'
import { Badge, Button, Markdown, StreamingMarkdown } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FlaskConical,
  LoaderCircle,
  ShieldQuestion,
  Sparkles,
  Wrench
} from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Renderer-only projection of the transient v2 live event.
 *
 * Main supplies these events through `chemsmart_studio.agent.live_event`. They
 * are never replayed or written into the durable conversation. Keeping this
 * interface structural lets the generated protocol type replace it at the
 * integration boundary without coupling the renderer to a provider payload.
 */
export type StudioAgentLiveProjection = StudioAgentLiveEvent

interface AgentTraceTimelineProps {
  events: readonly StudioAgentTurnEvent[]
  liveEvents?: readonly StudioAgentLiveProjection[]
}

interface ProjectionTurn {
  events: StudioAgentTurnEvent[]
  failed: boolean
  terminal: boolean
  turnId: string
}

interface LiveTextProjection {
  completed: boolean
  started: boolean
  text: string
}

interface ToolLifecycle {
  event: StudioAgentTurnEvent
  started: boolean
}

const toolKinds = new Set<StudioAgentTurnEvent['kind']>([
  'permission_waiting',
  'tool_failed',
  'tool_progress',
  'tool_started',
  'tool_succeeded'
])

const terminalToolStatuses = new Set<StudioAgentTurnStatus>(['cancelled', 'denied', 'failed', 'needs_user', 'waiting'])

function stripRawHtml(source: string) {
  return source.replace(/<\/?[A-Za-z][^>]*>/g, '')
}

function answerToMarkdown(event: StudioAgentTurnEvent) {
  const answer = event.answer
  if (!answer) return ''

  const seen = new Set<string>()
  const parts: string[] = []
  if (answer.heading.trim() && answer.heading.trim() !== answer.summary.trim()) {
    parts.push(`### ${answer.heading.trim()}`)
  }
  if (answer.summary.trim()) {
    seen.add(answer.summary.trim())
    parts.push(answer.summary.trim())
  }
  for (const section of answer.sections) {
    const summary = section.summary.trim()
    if (!summary || seen.has(summary)) continue
    seen.add(summary)
    const heading = section.heading.trim()
    if (heading && heading.toLowerCase() !== answer.heading.trim().toLowerCase()) {
      parts.push(`#### ${heading}\n\n${summary}`)
    } else {
      parts.push(summary)
    }
  }
  return stripRawHtml(parts.join('\n\n'))
}

function workflowRequest(summary: string) {
  const match = summary.match(/^(@\[(general|project-setup|command|molecule|calculation|results)\])(?:\s+|$)/)
  if (!match) return { label: '', text: summary }
  return {
    label: match[1],
    text: summary.slice(match[0].length)
  }
}

function collectLiveText(events: readonly StudioAgentLiveProjection[], turnId: string): LiveTextProjection {
  const blocks = new Map<string, LiveTextProjection>()
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.turnId !== turnId || event.kind === 'public_summary') continue
    const current = blocks.get(event.blockId) ?? { completed: false, started: false, text: '' }
    if (event.kind === 'text_started') {
      current.started = true
      if (event.text) current.text = event.text
    } else if (event.kind === 'text_delta') {
      current.started = true
      current.text += event.text ?? ''
    } else {
      current.completed = true
      current.started = true
      if (event.text) current.text = event.text
    }
    blocks.set(event.blockId, current)
  }

  const projections = [...blocks.values()]
  return {
    completed: projections.length > 0 && projections.every((projection) => projection.completed),
    started: projections.some((projection) => projection.started),
    text: projections
      .map((projection) => projection.text)
      .filter(Boolean)
      .join('\n\n')
  }
}

function groupTurns(events: readonly StudioAgentTurnEvent[]): ProjectionTurn[] {
  const turns = new Map<string, ProjectionTurn>()
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
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

function unique(values: readonly (readonly string[] | undefined)[]) {
  return [...new Set(values.flatMap((value) => value ?? []))]
}

function groupToolEvents(events: readonly StudioAgentTurnEvent[]): ToolLifecycle[] {
  const groups = new Map<string, StudioAgentTurnEvent[]>()
  for (const event of events) {
    if (!toolKinds.has(event.kind) || !event.tool) continue
    const lifecycle = groups.get(event.tool.toolCallId) ?? []
    lifecycle.push(event)
    groups.set(event.tool.toolCallId, lifecycle)
  }

  return [...groups.values()].map((lifecycle) => {
    const first = lifecycle[0]
    const latest = lifecycle.at(-1) ?? first
    const tools = lifecycle.flatMap((event) => (event.tool ? [event.tool] : []))
    const firstTool = tools[0]
    if (!firstTool) return { event: latest, started: false }
    const argumentKeys = unique(tools.map((tool) => tool.argumentKeys))
    const resultKeys = unique(tools.map((tool) => tool.resultKeys))
    const ruleIds = unique(tools.map((tool) => tool.ruleIds))
    const finalWithVerdict = [...tools].reverse().find((tool) => tool.verdict !== undefined)
    const finalWithDuration = [...tools].reverse().find((tool) => tool.durationMs !== undefined)
    return {
      event: {
        ...latest,
        tool: {
          toolCallId: firstTool.toolCallId,
          toolName: firstTool.toolName,
          purpose: firstTool.purpose,
          ...(argumentKeys.length > 0 ? { argumentKeys } : {}),
          ...(resultKeys.length > 0 ? { resultKeys } : {}),
          ...(ruleIds.length > 0 ? { ruleIds } : {}),
          ...(finalWithVerdict?.verdict ? { verdict: finalWithVerdict.verdict } : {}),
          ...(finalWithDuration?.durationMs !== undefined ? { durationMs: finalWithDuration.durationMs } : {})
        }
      },
      started: lifecycle.some((event) => event.kind === 'tool_started')
    }
  })
}

function hasStructuredDetail(tool: StudioAgentToolProjection | undefined) {
  return Boolean(
    tool &&
      ((tool.argumentKeys?.length ?? 0) > 0 ||
        (tool.resultKeys?.length ?? 0) > 0 ||
        (tool.ruleIds?.length ?? 0) > 0 ||
        tool.verdict)
  )
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`
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

function RunningWave() {
  return (
    <span
      aria-hidden
      className="flex h-4 items-center gap-0.5 motion-reduce:hidden"
      data-testid="agent-trace-running-wave">
      {[0, 1, 2].map((index) => (
        <span
          className="size-1 animate-bounce rounded-full bg-info"
          key={index}
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  )
}

function ToolState({ status }: { status: StudioAgentTurnStatus }) {
  const { t } = useTranslation()
  if (status === 'running' || status === 'queued') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-info text-xs">
        <LoaderCircle aria-hidden className="size-3.5" />
        <span>{t('chemsmart_studio.optimization.status.running')}</span>
      </span>
    )
  }
  if (status === 'waiting' || status === 'needs_user') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-warning text-xs">
        <ShieldQuestion aria-hidden className="size-3.5" />
        {t('chemsmart_studio.optimization.status.pending_approval')}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-destructive text-xs">
        <CircleAlert aria-hidden className="size-3.5" />
        {t('chemsmart_studio.trusted_activity.status.failed')}
      </span>
    )
  }
  if (status === 'denied') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-foreground-muted text-xs">
        <CircleAlert aria-hidden className="size-3.5" />
        {t('chemsmart_studio.trusted_activity.status.denied')}
      </span>
    )
  }
  if (status === 'cancelled') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-foreground-muted text-xs">
        <CircleAlert aria-hidden className="size-3.5" />
        {t('chemsmart_studio.agent_workbench.status.cancelled')}
      </span>
    )
  }
  return (
    <span
      aria-label={t('chemsmart_studio.trusted_activity.status.completed')}
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-success">
      <Check aria-hidden className="size-3.5" />
    </span>
  )
}

function ToolRow({ lifecycle }: { lifecycle: ToolLifecycle }) {
  const { t } = useTranslation()
  const event = lifecycle.event
  const tool = event.tool
  const detailId = useId()
  const [open, setOpen] = useState(event.status === 'failed')
  const expandable = hasStructuredDetail(tool)

  useEffect(() => {
    if (event.status === 'failed') setOpen(true)
  }, [event.status])

  if (!tool) return null
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
      <Wrench aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-medium text-foreground text-xs">{tool.purpose}</span>
        <span className="block truncate font-mono text-[11px] text-foreground-muted">{tool.toolName}</span>
      </span>
      {tool.durationMs !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] text-foreground-muted">{formatDuration(tool.durationMs)}</span>
      ) : null}
      <ToolState status={event.status} />
    </>
  )
  return (
    <li data-status={event.status} data-trace-event-id={event.eventId}>
      <article
        className={cn(
          'rounded-md border border-border-subtle bg-background-subtle',
          event.status === 'failed' && 'border-error-border bg-error-bg'
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
        {open && expandable ? (
          <dl className="space-y-1.5 border-border-muted border-t px-2 py-2 text-xs" id={detailId}>
            <DetailValues label={t('chemsmart_studio.agent_trace.input')} values={tool.argumentKeys ?? []} />
            <DetailValues label={t('chemsmart_studio.agent_trace.output')} values={tool.resultKeys ?? []} />
            <DetailValues label={t('chemsmart_studio.agent_trace.rules')} values={tool.ruleIds ?? []} />
            {tool.verdict ? (
              <div className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-2">
                <dt className="text-foreground-muted">{t('chemsmart_studio.agent_trace.verdict')}</dt>
                <dd className="min-w-0 break-words font-mono text-foreground-secondary">{tool.verdict}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </article>
    </li>
  )
}

function ToolActivity({
  lifecycles,
  narrationStarted,
  turn
}: {
  lifecycles: readonly ToolLifecycle[]
  narrationStarted: boolean
  turn: ProjectionTurn
}) {
  const { t } = useTranslation()
  const contentId = useId()
  const terminal = [...turn.events].reverse().find((event) => event.kind === 'turn_terminal')
  const blocking =
    turn.failed ||
    (terminal ? terminalToolStatuses.has(terminal.status) : false) ||
    lifecycles.some((lifecycle) => terminalToolStatuses.has(lifecycle.event.status))
  const running = lifecycles.some((lifecycle) => ['queued', 'running'].includes(lifecycle.event.status))
  const startedCount = turn.events.filter((event) => event.kind === 'tool_started').length
  const allStartedSucceeded =
    startedCount > 0 &&
    lifecycles.filter((lifecycle) => lifecycle.started).every((lifecycle) => lifecycle.event.status === 'succeeded')
  const shouldCollapse = allStartedSucceeded && narrationStarted && !blocking
  const [open, setOpen] = useState(!shouldCollapse)
  const durationMs = lifecycles.reduce((total, lifecycle) => total + (lifecycle.event.tool?.durationMs ?? 0), 0)

  useEffect(() => {
    if (blocking || running) setOpen(true)
    else if (shouldCollapse) setOpen(false)
  }, [blocking, running, shouldCollapse])

  if (lifecycles.length === 0) return null
  const label = running
    ? t('chemsmart_studio.agent_trace.tools_running', { count: startedCount })
    : t('chemsmart_studio.agent_trace.tools_used', {
        count: startedCount,
        duration: formatDuration(durationMs)
      })

  return (
    <section
      aria-label={t('chemsmart_studio.agent_workbench.tools')}
      className="rounded-md border border-border-subtle">
      <Button
        aria-controls={contentId}
        aria-expanded={open}
        className="h-8 w-full justify-start gap-1.5 rounded-md px-2 text-foreground-secondary"
        size="sm"
        variant="ghost"
        onClick={() => setOpen((current) => !current)}>
        {open ? (
          <ChevronDown aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        )}
        <Wrench aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        {running ? <RunningWave /> : null}
        {running ? <LoaderCircle aria-hidden className="hidden size-3.5 motion-reduce:block" /> : null}
      </Button>
      {open ? (
        <ol className="space-y-1.5 border-border-muted border-t p-1.5" id={contentId}>
          {lifecycles.map((lifecycle) => (
            <ToolRow key={lifecycle.event.tool?.toolCallId ?? lifecycle.event.eventId} lifecycle={lifecycle} />
          ))}
        </ol>
      ) : null}
    </section>
  )
}

function ScientificArtifact({ event }: { event: StudioAgentTurnEvent }) {
  const { t } = useTranslation()
  const artifact = event.artifact
  if (!artifact) return null
  return (
    <article className="rounded-lg border border-border-subtle bg-background-subtle p-3">
      <div className="flex items-center gap-2">
        <FlaskConical aria-hidden className="size-4 shrink-0 text-info" />
        <h4 className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">{artifact.heading}</h4>
      </div>
      <p className="mt-1.5 text-foreground-secondary text-xs leading-5">{artifact.summary}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-border-muted border-t pt-2 text-xs">
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
    </article>
  )
}

function AssistantResponse({
  canonical,
  live,
  turnId
}: {
  canonical: StudioAgentTurnEvent | undefined
  live: LiveTextProjection
  turnId: string
}) {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  const content = canonical ? answerToMarkdown(canonical) : stripRawHtml(live.text)
  if (!content) return null

  return (
    <article
      aria-label={t('chemsmart_studio.agent_trace.assistant_response')}
      className="min-w-0 px-1 text-foreground text-sm leading-6"
      data-streaming={!canonical && live.started && !live.completed ? 'true' : undefined}>
      {canonical ? (
        <Markdown id={`agent-answer-${canonical.eventId}`} className="max-w-none">
          {content}
        </Markdown>
      ) : (
        <StreamingMarkdown
          animated={reduceMotion ? false : undefined}
          id={`agent-live-${turnId}`}
          parseIncompleteMarkdown={!live.completed}>
          {content}
        </StreamingMarkdown>
      )}
    </article>
  )
}

function latestCompletedSentence(text: string) {
  const matches = text.match(/[^.!?。！？\n]+[.!?。！？](?=\s|$)/g)
  return matches?.at(-1)?.trim() ?? ''
}

function AgentProjectionTurn({
  current,
  liveEvents,
  turn
}: {
  current: boolean
  liveEvents: readonly StudioAgentLiveProjection[]
  turn: ProjectionTurn
}) {
  const { t } = useTranslation()
  const request = turn.events.find((event) => event.kind === 'user_message')
  const requestContent = request ? workflowRequest(request.summary) : undefined
  const reasoning = [...turn.events].reverse().find((event) => event.kind === 'reasoning_summary')
  const liveSummary = [...liveEvents]
    .reverse()
    .find((event) => event.turnId === turn.turnId && event.kind === 'public_summary' && event.text?.trim())
  const canonicalAnswer = [...turn.events].reverse().find((event) => event.kind === 'answer_published' && event.answer)
  const artifacts = turn.events.filter((event) => event.kind === 'artifact_published' && event.artifact)
  const terminal = [...turn.events].reverse().find((event) => event.kind === 'turn_terminal')
  const live = collectLiveText(liveEvents, turn.turnId)
  const lifecycles = groupToolEvents(turn.events)
  const narrationStarted = live.started || Boolean(canonicalAnswer)
  const lifecycleAnnouncementRef = useRef('')
  const sentenceAnnouncementRef = useRef('')
  const [announcement, setAnnouncement] = useState('')
  const latestLifecycleEvent = [...turn.events]
    .reverse()
    .find((event) => toolKinds.has(event.kind) || event.kind === 'turn_terminal')
  const completedSentence = latestCompletedSentence(live.text)

  useEffect(() => {
    if (!current) return
    const next = latestLifecycleEvent?.summary
    if (!next || lifecycleAnnouncementRef.current === latestLifecycleEvent.eventId) return
    lifecycleAnnouncementRef.current = latestLifecycleEvent.eventId
    setAnnouncement(next)
  }, [current, latestLifecycleEvent?.eventId, latestLifecycleEvent?.summary])

  useEffect(() => {
    if (!current || !completedSentence || sentenceAnnouncementRef.current === completedSentence) return
    sentenceAnnouncementRef.current = completedSentence
    setAnnouncement(completedSentence)
  }, [completedSentence, current])

  return (
    <li className="space-y-3 py-2" data-current={current || undefined} data-turn-id={turn.turnId}>
      {request ? (
        <div
          aria-label={t('chemsmart_studio.agent_workbench.request')}
          className="ml-8 rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-foreground text-sm leading-5">
          <span className="flex items-start gap-2">
            {requestContent?.label ? (
              <Badge className="shrink-0 font-mono" data-testid="agent-workflow-tag" variant="outline">
                {requestContent.label}
              </Badge>
            ) : null}
            <span>{requestContent?.text}</span>
          </span>
        </div>
      ) : null}
      {(liveSummary || reasoning) && !canonicalAnswer && !live.text ? (
        <p className="flex items-start gap-2 px-1 text-foreground-muted text-xs leading-5">
          <Sparkles aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />
          <span>{liveSummary?.text ?? reasoning?.summary}</span>
        </p>
      ) : null}
      <AssistantResponse canonical={canonicalAnswer} live={live} turnId={turn.turnId} />
      <ToolActivity lifecycles={lifecycles} narrationStarted={narrationStarted} turn={turn} />
      {artifacts.map((event) => (
        <ScientificArtifact event={event} key={event.eventId} />
      ))}
      {terminal && terminal.outcome !== 'completed' ? (
        <p
          className={cn(
            'flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs leading-5',
            terminal.status === 'failed'
              ? 'border-error-border bg-error-bg text-error-text'
              : terminal.status === 'needs_user' || terminal.status === 'waiting'
                ? 'border-warning bg-background-subtle text-foreground-secondary'
                : 'border-border-subtle bg-background-subtle text-foreground-muted'
          )}>
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {terminal.summary}
        </p>
      ) : null}
      {current ? (
        <span aria-atomic="true" aria-live="polite" className="sr-only" data-testid="agent-live-region">
          {announcement}
        </span>
      ) : null}
    </li>
  )
}

/** Main-owned canonical projection reconciled with non-durable assistant text deltas. */
export function AgentTraceTimeline({ events, liveEvents = [] }: AgentTraceTimelineProps) {
  const turns = useMemo(() => groupTurns(events), [events])
  const currentTurnId = [...turns].reverse().find((turn) => !turn.terminal)?.turnId ?? turns.at(-1)?.turnId
  if (turns.length === 0) return null
  return (
    <ol className="divide-y divide-border-subtle" data-testid="agent-trace-timeline">
      {turns.map((turn) => (
        <AgentProjectionTurn
          current={turn.turnId === currentTurnId}
          key={turn.turnId}
          liveEvents={liveEvents}
          turn={turn}
        />
      ))}
    </ol>
  )
}
