import { Alert, Badge, Button, Scrollbar, Textarea } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import type { UniqueModelId } from '@shared/data/types/model'
import { CircleCheck, CircleSlash, TriangleAlert, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type GateVerdict, isRunnable, type SynthesisOutcome, useCommandSynthesis } from './useHarnessWorkbench'

/** Both gates read the same three verdicts, so one presentation serves both. */
const verdictPresentation = {
  ok: { Icon: CircleCheck, className: 'text-success' },
  warn: { Icon: TriangleAlert, className: 'text-warning' },
  reject: { Icon: CircleSlash, className: 'text-destructive' }
} as const

function GateRow({ gate, label, question }: { gate: GateVerdict | null; label: string; question: string }) {
  const { t } = useTranslation()
  const presentation = gate ? verdictPresentation[gate.verdict as keyof typeof verdictPresentation] : undefined
  const Icon = presentation?.Icon ?? CircleSlash

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle p-2.5" data-gate={label}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground text-xs">{label}</span>
        <Badge className="gap-1.5" variant="outline">
          <Icon aria-hidden className={cn('size-3', presentation?.className ?? 'text-foreground-muted')} />
          {gate
            ? t(`chemsmart_studio.synthesis.verdict.${gate.verdict}`, { defaultValue: gate.verdict })
            : t('chemsmart_studio.synthesis.verdict.absent')}
        </Badge>
      </div>
      <p className="text-foreground-muted text-xs leading-5">{question}</p>
      {gate && gate.failedRuleIds.length > 0 ? (
        <ul className="space-y-0.5 font-mono text-[11px] text-foreground-secondary">
          {gate.failedRuleIds.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SynthesisResult({ outcome }: { outcome: SynthesisOutcome }) {
  const { t } = useTranslation()
  const runnable = isRunnable(outcome)

  return (
    <div className="space-y-3" data-testid="synthesis-result" data-runnable={runnable} data-status={outcome.status}>
      {/*
        The status the harness reached, stated before the command itself: a command that runs but no longer
        matches the request is the failure most worth refusing loudly.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={runnable ? 'secondary' : 'outline'}>
          {t(`chemsmart_studio.synthesis.status.${outcome.status}`, { defaultValue: outcome.status })}
        </Badge>
        {outcome.project ? (
          <Badge variant="outline">{t('chemsmart_studio.synthesis.project', { project: outcome.project })}</Badge>
        ) : null}
      </div>

      {outcome.status === 'intentRejected' ? (
        <Alert message={t('chemsmart_studio.synthesis.intent_reject')} role="alert" showIcon type="error" />
      ) : null}

      {outcome.command ? (
        <div className="space-y-1">
          <p className="font-medium text-foreground text-xs">{t('chemsmart_studio.synthesis.command')}</p>
          <pre
            className={cn(
              'overflow-x-auto rounded-md border p-2.5 font-mono text-xs leading-5',
              runnable ? 'border-border bg-background-subtle' : 'border-warning/40 bg-warning/5'
            )}
            data-testid="synthesized-command">
            {outcome.command}
          </pre>
          {runnable ? null : <p className="text-warning text-xs">{t('chemsmart_studio.synthesis.not_runnable')}</p>}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <GateRow
          gate={outcome.semantic}
          label={t('chemsmart_studio.synthesis.semantic_gate')}
          question={t('chemsmart_studio.synthesis.semantic_question')}
        />
        <GateRow
          gate={outcome.intent}
          label={t('chemsmart_studio.synthesis.intent_gate')}
          question={t('chemsmart_studio.synthesis.intent_question')}
        />
      </div>

      {outcome.missingInfo.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium text-foreground text-xs">{t('chemsmart_studio.synthesis.missing_info')}</p>
          <ul className="space-y-0.5 text-foreground-secondary text-xs">
            {outcome.missingInfo.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {outcome.explanation ? (
        <p className="text-foreground-secondary text-xs leading-5">{outcome.explanation}</p>
      ) : null}

      {outcome.reasoning ? (
        <div className="space-y-1">
          <p className="font-medium text-foreground text-xs">{t('chemsmart_studio.synthesis.evidence')}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-background-subtle p-2.5 font-mono text-[11px] text-foreground-secondary leading-5">
            {outcome.reasoning}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Turns a research request into a chemsmart command through the harness. Nothing here runs chemistry: the
 * command is produced, gated, and shown, and executing it stays a separate approved action.
 */
export function CommandSynthesisPanel({
  modelId,
  sessionId,
  stacked
}: {
  modelId: UniqueModelId | null
  sessionId: string
  stacked: boolean
}) {
  const { t } = useTranslation()
  const [request, setRequest] = useState('')
  const { busy, failed, outcome, synthesize } = useCommandSynthesis(sessionId, modelId)

  return (
    <section
      aria-labelledby="chemsmart-synthesis-title"
      // The dock is wide and short, so the verdicts sit beside the request rather than below it, where they
      // would need scrolling to reach.
      className={cn(
        'grid h-full min-h-0 gap-3 p-3',
        stacked ? 'grid-rows-[auto_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(360px,1.1fr)]'
      )}
      data-testid="command-synthesis-panel">
      <form
        className="min-w-0 space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void synthesize(request)
        }}>
        <div className="flex items-center justify-between gap-3">
          <h2 id="chemsmart-synthesis-title" className="font-semibold text-foreground text-sm">
            {t('chemsmart_studio.synthesis.title')}
          </h2>
          <Badge className="gap-1.5" variant="outline">
            {t('chemsmart_studio.synthesis.no_execution')}
          </Badge>
        </div>
        <label className="sr-only" htmlFor="chemsmart-synthesis-request">
          {t('chemsmart_studio.synthesis.request_label')}
        </label>
        <Textarea.Input
          disabled={busy}
          id="chemsmart-synthesis-request"
          maxLength={8192}
          placeholder={t('chemsmart_studio.synthesis.request_placeholder')}
          rows={2}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
        />
        <Button disabled={!modelId || request.trim().length === 0} loading={busy} size="sm" type="submit">
          <Wand2 aria-hidden className="size-3.5" />
          {t('chemsmart_studio.synthesis.submit')}
        </Button>
      </form>

      <Scrollbar className="min-h-0 min-w-0">
        {failed ? <Alert message={t('chemsmart_studio.synthesis.failed')} role="alert" showIcon type="error" /> : null}
        {outcome ? (
          <SynthesisResult outcome={outcome} />
        ) : failed ? null : (
          <p
            className="rounded-md border border-border border-dashed px-3 py-6 text-center text-foreground-muted text-xs leading-5"
            data-testid="synthesis-empty">
            {t('chemsmart_studio.synthesis.empty')}
          </p>
        )}
      </Scrollbar>
    </section>
  )
}
