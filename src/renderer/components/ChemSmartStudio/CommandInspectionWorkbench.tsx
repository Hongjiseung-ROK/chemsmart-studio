import type { CommandInspectionResult } from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Input, Textarea } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { RotateCcw, Search, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('CommandInspectionWorkbench')

const inspectionStatusKeys = {
  ready_for_dry_run: 'chemsmart_studio.command.status.ready_for_dry_run',
  needs_clarification: 'chemsmart_studio.command.status.needs_clarification',
  intent_reject: 'chemsmart_studio.command.status.intent_reject',
  rejected: 'chemsmart_studio.command.status.rejected'
} as const

const verdictKeys = {
  ok: 'chemsmart_studio.command.verdict.ok',
  unavailable: 'chemsmart_studio.command.verdict.unavailable',
  warn: 'chemsmart_studio.command.verdict.warn',
  reject: 'chemsmart_studio.command.verdict.reject'
} as const

function displayValue(value: string | null) {
  return value ?? '—'
}

interface CommandInspectionWorkbenchProps {
  sessionId: string
  /** Below the compact tier the form and its verdicts stack instead of sharing a row. */
  stacked: boolean
}

export function CommandInspectionWorkbench({ sessionId, stacked }: CommandInspectionWorkbenchProps) {
  const { t } = useTranslation()
  const [command, setCommand] = useState('')
  const [intentDescription, setIntentDescription] = useState('')
  const [inspection, setInspection] = useState<CommandInspectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    requestRef.current += 1
    setCommand('')
    setIntentDescription('')
    setInspection(null)
    setBusy(false)
    setFailed(false)
  }, [sessionId])

  const inspectCommand = useCallback(async () => {
    const normalizedCommand = command.trim()
    const normalizedIntent = intentDescription.trim()
    if (!normalizedCommand || busy) return

    const requestId = ++requestRef.current
    setBusy(true)
    setFailed(false)
    try {
      const result = await ipcApi.request('chemsmart_studio.command.inspect', {
        sessionId,
        command: normalizedCommand,
        ...(normalizedIntent ? { intentDescription: normalizedIntent } : {})
      })
      if (requestRef.current !== requestId) return
      setInspection(result)
    } catch (error) {
      if (requestRef.current !== requestId) return
      setFailed(true)
      logger.error('ChemSmart command inspection failed', error as Error)
    } finally {
      if (requestRef.current === requestId) setBusy(false)
    }
  }, [busy, command, intentDescription, sessionId])

  const clearInspection = useCallback(() => {
    requestRef.current += 1
    setCommand('')
    setIntentDescription('')
    setInspection(null)
    setBusy(false)
    setFailed(false)
  }, [])

  return (
    <section
      aria-labelledby="chemsmart-command-workbench-title"
      className="flex min-h-0 flex-1 flex-col border-border border-t bg-background"
      data-testid="command-inspection-workbench"
      id="chemsmart-command-workbench">
      <div
        className={cn(
          'grid h-full min-h-0',
          stacked ? 'grid-cols-1 grid-rows-[auto_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1.05fr)_minmax(340px,0.95fr)]'
        )}>
        <form
          aria-label={t('chemsmart_studio.command.form')}
          className="grid min-h-0 content-start gap-2.5 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void inspectCommand()
          }}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="chemsmart-command-workbench-title" className="font-semibold text-foreground text-sm">
                {t('chemsmart_studio.command.title')}
              </h2>
              <p className="truncate text-foreground-muted text-xs">{t('chemsmart_studio.command.description')}</p>
            </div>
            <Badge className="gap-1.5" variant="outline">
              <ShieldCheck aria-hidden className="size-3.5 text-success" />
              {t('chemsmart_studio.command.static_only')}
            </Badge>
          </div>
          <div className="grid gap-1">
            <label className="font-medium text-foreground text-xs" htmlFor="chemsmart-command-input">
              {t('chemsmart_studio.command.command_label')}
            </label>
            <Textarea.Input
              id="chemsmart-command-input"
              maxLength={8192}
              placeholder={t('chemsmart_studio.command.command_placeholder')}
              rows={2}
              spellCheck={false}
              value={command}
              onChange={(event) => {
                setCommand(event.target.value)
                setInspection(null)
                setFailed(false)
              }}
            />
          </div>
          <div className="grid gap-1">
            <label className="font-medium text-foreground text-xs" htmlFor="chemsmart-command-intent">
              {t('chemsmart_studio.command.intent_label')}
            </label>
            <Input
              id="chemsmart-command-intent"
              maxLength={20_000}
              placeholder={t('chemsmart_studio.command.intent_placeholder')}
              value={intentDescription}
              onChange={(event) => {
                setIntentDescription(event.target.value)
                setInspection(null)
                setFailed(false)
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-foreground-muted text-xs">{t('chemsmart_studio.command.no_execution_notice')}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                disabled={busy && command.length === 0}
                size="sm"
                type="button"
                variant="ghost"
                onClick={clearInspection}>
                <RotateCcw aria-hidden className="size-3.5" />
                {t('chemsmart_studio.command.clear')}
              </Button>
              <Button
                aria-label={t('chemsmart_studio.command.inspect')}
                disabled={command.trim().length === 0}
                loading={busy}
                size="sm"
                type="submit">
                <Search aria-hidden className="size-3.5" />
                {t('chemsmart_studio.command.inspect')}
              </Button>
            </div>
          </div>
        </form>

        <div
          aria-live="polite"
          className={cn(
            'min-h-0 overflow-y-auto border-border bg-background-subtle p-3',
            stacked ? 'border-t' : 'border-l'
          )}>
          {failed ? (
            <Alert message={t('chemsmart_studio.command.inspection_failed')} role="alert" showIcon type="error" />
          ) : inspection ? (
            <div className="space-y-3" data-testid="command-inspection-result">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-foreground text-sm">{t('chemsmart_studio.command.result_title')}</p>
                  <p className="text-foreground-muted text-xs">
                    {t('chemsmart_studio.command.digest', { digest: inspection.commandDigest.slice(0, 12) })}
                  </p>
                </div>
                <Badge variant={inspection.status === 'rejected' ? 'destructive' : 'secondary'}>
                  {t(inspectionStatusKeys[inspection.status])}
                </Badge>
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">{t('chemsmart_studio.command.execution_not_started')}</Badge>
                <Badge variant="outline">{t('chemsmart_studio.command.dry_run_required')}</Badge>
                <Badge variant="outline">{t('chemsmart_studio.command.approval_required')}</Badge>
              </div>

              <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-xs max-[1099px]:grid-cols-2">
                <div>
                  <dt className="text-foreground-muted">{t('chemsmart_studio.command.program')}</dt>
                  <dd className="font-medium text-foreground">{displayValue(inspection.parse.program)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">{t('chemsmart_studio.command.job')}</dt>
                  <dd className="font-medium text-foreground">{displayValue(inspection.parse.job)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">{t('chemsmart_studio.command.input_name')}</dt>
                  <dd className="font-medium text-foreground">{displayValue(inspection.parse.inputName)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">{t('chemsmart_studio.command.charge')}</dt>
                  <dd className="font-medium text-foreground">{displayValue(inspection.parse.charge)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">{t('chemsmart_studio.command.multiplicity')}</dt>
                  <dd className="font-medium text-foreground">{displayValue(inspection.parse.multiplicity)}</dd>
                </div>
                <div>
                  <dt className="text-foreground-muted">{t('chemsmart_studio.command.action')}</dt>
                  <dd className="font-medium text-foreground">{displayValue(inspection.parse.action)}</dd>
                </div>
              </dl>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border border-border-subtle bg-background p-2.5">
                  <p className="text-foreground-muted">{t('chemsmart_studio.command.intent_gate')}</p>
                  <p className="mt-1 font-medium text-foreground">{t(verdictKeys[inspection.intent.verdict])}</p>
                  {inspection.intent.failedRuleIds.length > 0 ? (
                    <p className="mt-1 text-destructive">{inspection.intent.failedRuleIds.join(', ')}</p>
                  ) : null}
                </div>
                <div className="rounded-md border border-border-subtle bg-background p-2.5">
                  <p className="text-foreground-muted">{t('chemsmart_studio.command.semantic_gate')}</p>
                  <p className="mt-1 font-medium text-foreground">{t(verdictKeys[inspection.semantic.verdict])}</p>
                  {inspection.semantic.issues.at(0) ? (
                    <p className="mt-1 text-foreground-secondary">{inspection.semantic.issues[0].message}</p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-24 items-center justify-center rounded-md border border-border border-dashed p-5 text-center">
              <div>
                <ShieldCheck aria-hidden className="mx-auto size-5 text-foreground-muted" />
                <p className="mt-2 font-medium text-foreground text-sm">{t('chemsmart_studio.command.empty_title')}</p>
                <p className="mt-1 text-foreground-muted text-xs">{t('chemsmart_studio.command.empty_description')}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
