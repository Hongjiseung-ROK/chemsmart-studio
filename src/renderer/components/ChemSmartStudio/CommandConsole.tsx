import { Badge, Button, Input } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { TERMINAL_SURFACE_CLASS } from '@renderer/components/chat/messages/tools/agent'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import type {
  ChemSmartStudioConsoleCompletions,
  ChemSmartStudioConsoleCompletionSelection,
  ChemSmartStudioConsolePreflight
} from '@shared/ipc/schemas/chemsmartStudio'
import {
  AlertTriangle,
  CheckCircle2,
  CornerDownLeft,
  File,
  FolderKanban,
  ListTree,
  Play,
  Server,
  Square,
  Terminal,
  Variable,
  XCircle
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('CommandConsole')

/** Enough scrollback to read a failed run without letting a chatty job grow the DOM without bound. */
const MAX_OUTPUT_CHARS = 200_000
const MAX_COMPLETIONS = 8

interface ConsoleLine {
  stream: 'stdout' | 'stderr'
  chunk: string
}

/**
 * The ChemSmart command console.
 *
 * This is the researcher's own shell surface: what they type runs without an approval, because it is
 * their machine and their command. The agent cannot reach it — agent execution goes through the
 * approval-gated tool path — so the two never share a way to run things.
 *
 * The completion popover exists because chemsmart's short flags mean different things at different
 * command levels: `-m` is memory under `run` and multiplicity under `gaussian`. Every candidate is
 * explained in chemsmart's own words, resolved from the installed CLI's schema.
 */
interface CommandConsoleProps {
  draft?: string
  onDraftChange?: (draft: string) => void
  /**
   * The owning workspace turns a verified, path-free selection into a molecule or YAML tab.
   * The Console itself never receives a filesystem path.
   */
  onOpenCompletion?: (selection: ChemSmartStudioConsoleCompletionSelection) => void
}

export function CommandConsole({ draft, onDraftChange, onOpenCompletion }: CommandConsoleProps = {}) {
  const { t } = useTranslation()
  const [localCommand, setLocalCommand] = useState('')
  const command = draft ?? localCommand
  const setCommand = useCallback(
    (next: string) => {
      if (onDraftChange) onDraftChange(next)
      else setLocalCommand(next)
    },
    [onDraftChange]
  )
  const [runId, setRunId] = useState<string | null>(null)
  const [lines, setLines] = useState<ConsoleLine[]>([])
  const [exit, setExit] = useState<{ code: number | null; signal: string | null } | null>(null)
  const [completions, setCompletions] = useState<ChemSmartStudioConsoleCompletions | null>(null)
  const [selectedCompletion, setSelectedCompletion] = useState(0)
  const [preflight, setPreflight] = useState<ChemSmartStudioConsolePreflight | null>(null)
  const [pendingWarning, setPendingWarning] = useState<{ command: string; digest: string } | null>(null)
  const [history, setHistory] = usePersistCache('ui.studio.console.history')
  const [historyCursor, setHistoryCursor] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLSpanElement>(null)
  const runIdRef = useRef<string | null>(null)
  const completionGenerationRef = useRef(0)
  runIdRef.current = runId

  const recent = useMemo<string[]>(() => (Array.isArray(history) ? history : []), [history])

  useIpcOn('chemsmart_studio.console.output', (event) => {
    // A late chunk from a cancelled run must not appear under the next one.
    if (event.runId !== runIdRef.current) return
    setLines((current) => {
      const next = [...current, { stream: event.stream, chunk: event.chunk }]
      let total = 0
      for (let index = next.length - 1; index >= 0; index -= 1) {
        total += next[index].chunk.length
        if (total > MAX_OUTPUT_CHARS) return next.slice(index + 1)
      }
      return next
    })
  })

  useIpcOn('chemsmart_studio.console.exited', (event) => {
    if (event.runId !== runIdRef.current) return
    setExit({ code: event.code, signal: event.signal })
    setRunId(null)
  })

  useEffect(() => {
    // Optional-called: jsdom has no layout, so it does not implement scrollIntoView.
    bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [lines])

  const refreshCompletions = useCallback(async (line: string, cursor: number) => {
    const generation = completionGenerationRef.current + 1
    completionGenerationRef.current = generation
    if (line.trim().length === 0) {
      setSelectedCompletion(0)
      setCompletions(null)
      return
    }
    try {
      const result = await ipcApi.request('chemsmart_studio.console.complete', { line, cursor })
      if (completionGenerationRef.current !== generation) return
      setSelectedCompletion(0)
      setCompletions(result)
    } catch (error) {
      if (completionGenerationRef.current !== generation) return
      // Advice is optional; the console still runs commands without it.
      logger.error('Failed to resolve chemsmart CLI completions', error as Error)
      setCompletions(null)
    }
  }, [])

  const startRun = useCallback(
    async (line: string, preflightDigest: string) => {
      setLines([{ stream: 'stdout', chunk: `$ ${line}\n` }])
      setExit(null)
      completionGenerationRef.current += 1
      setCompletions(null)
      setHistory([line, ...recent.filter((entry) => entry !== line)].slice(0, 50))
      setHistoryCursor(null)
      try {
        const result = await ipcApi.request('chemsmart_studio.console.run', {
          command: line,
          preflightDigest
        })
        setRunId(result.runId)
        setCommand('')
        setPendingWarning(null)
      } catch (error) {
        logger.error('Failed to run a console command', error as Error)
        setLines((current) => [...current, { stream: 'stderr', chunk: t('chemsmart_studio.console.run_failed') }])
      }
    },
    [recent, setCommand, setHistory, t]
  )

  const submit = useCallback(async () => {
    const line = command.trim()
    if (line.length === 0 || runId !== null) return
    if (pendingWarning?.command === line) {
      await startRun(line, pendingWarning.digest)
      return
    }
    try {
      const receipt = await ipcApi.request('chemsmart_studio.console.preflight', { command: line })
      setPreflight(receipt)
      if (receipt.verdict === 'rejected') {
        setPendingWarning(null)
        return
      }
      if (receipt.verdict === 'warning') {
        setPendingWarning({ command: line, digest: receipt.commandDigest })
        return
      }
      await startRun(line, receipt.commandDigest)
    } catch (error) {
      logger.error('Failed to inspect a console command', error as Error)
      setPreflight(null)
      setLines((current) => [...current, { stream: 'stderr', chunk: t('chemsmart_studio.console.run_failed') }])
    }
  }, [command, pendingWarning, runId, startRun, t])

  const cancel = useCallback(async () => {
    if (!runId) return
    try {
      await ipcApi.request('chemsmart_studio.console.cancel', { runId })
    } catch (error) {
      logger.error('Failed to cancel a console command', error as Error)
    }
  }, [runId])

  const applyCompletion = useCallback(
    (entry: ChemSmartStudioConsoleCompletions['items'][number]) => {
      if (!completions) return
      const insertion = `${entry.insertText}${entry.appendSpace ? ' ' : ''}`
      const next = `${command.slice(0, completions.replaceRange.start)}${insertion}${command.slice(
        completions.replaceRange.end
      )}`
      const nextCursor = completions.replaceRange.start + insertion.length
      setCommand(next)
      completionGenerationRef.current += 1
      setCompletions(null)
      setPreflight(null)
      setPendingWarning(null)
      if (entry.contextRef && entry.openAction) {
        void ipcApi
          .request('chemsmart_studio.console.accept_completion', { contextRef: entry.contextRef })
          .then((selection) => onOpenCompletion?.(selection))
          .catch((error) => logger.error('Failed to open a selected console context', error as Error))
      }
      queueMicrotask(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(nextCursor, nextCursor)
        void refreshCompletions(next, nextCursor)
      })
    },
    [command, completions, onOpenCompletion, refreshCompletions, setCommand]
  )

  const focusPreviousRequired = useCallback(() => {
    const missing = completions?.semantic.slots.find(
      (slot) => slot.required && !slot.consumed && slot.kind === 'option' && slot.insertText
    )
    if (!missing) {
      const cursor = inputRef.current?.selectionStart ?? command.length
      void refreshCompletions(command, cursor)
      return
    }
    const before = command.slice(0, missing.insertAt)
    const after = command.slice(missing.insertAt)
    const separatorBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const separatorAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
    const insertion = `${separatorBefore}${missing.insertText}${separatorAfter}`
    const next = `${before}${insertion}${after}`
    const nextCursor = before.length + insertion.length - separatorAfter.length
    setCommand(next)
    setPreflight(null)
    setPendingWarning(null)
    queueMicrotask(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
      void refreshCompletions(next, nextCursor)
    })
  }, [command, completions, refreshCompletions, setCommand])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const visibleItems = completions?.items.slice(0, MAX_COMPLETIONS) ?? []
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault()
        focusPreviousRequired()
        return
      }
      if (event.code === 'Space' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void refreshCompletions(command, event.currentTarget.selectionStart ?? command.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && visibleItems.length > 0) {
        event.preventDefault()
        applyCompletion(visibleItems[selectedCompletion] ?? visibleItems[0])
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        void submit()
        return
      }
      if (event.key === 'Escape') {
        if (visibleItems.length > 0) event.preventDefault()
        completionGenerationRef.current += 1
        setCompletions(null)
        return
      }
      if (visibleItems.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        setSelectedCompletion((current) => {
          const direction = event.key === 'ArrowDown' ? 1 : -1
          return (current + direction + visibleItems.length) % visibleItems.length
        })
        return
      }
      // History walks the researcher's own past commands, newest first.
      if (event.key === 'ArrowUp' && recent.length > 0) {
        event.preventDefault()
        const next = historyCursor === null ? 0 : Math.min(historyCursor + 1, recent.length - 1)
        setHistoryCursor(next)
        setCommand(recent[next])
        return
      }
      if (event.key === 'ArrowDown' && historyCursor !== null) {
        event.preventDefault()
        const next = historyCursor - 1
        setHistoryCursor(next < 0 ? null : next)
        setCommand(next < 0 ? '' : recent[next])
      }
    },
    [
      applyCompletion,
      command,
      completions,
      focusPreviousRequired,
      historyCursor,
      recent,
      refreshCompletions,
      selectedCompletion,
      setCommand,
      submit
    ]
  )

  const visible = command.trim().length > 0 ? (completions?.items.slice(0, MAX_COMPLETIONS) ?? []) : []
  const completionGroupLabels = useMemo(
    () => ({
      commands: t('chemsmart_studio.console.group.commands'),
      files: t('chemsmart_studio.console.group.files'),
      options: t('chemsmart_studio.console.group.options'),
      projects: t('chemsmart_studio.console.group.projects'),
      servers: t('chemsmart_studio.console.group.servers'),
      values: t('chemsmart_studio.console.group.values')
    }),
    [t]
  )
  const preflightSummary = useMemo(() => {
    if (!preflight) return ''
    if (preflight.summary.kind === 'shell') return t('chemsmart_studio.console.shell_command')
    return [
      preflight.summary.program,
      preflight.summary.job,
      preflight.summary.inputName,
      preflight.summary.charge === null
        ? null
        : t('chemsmart_studio.console.charge', { charge: preflight.summary.charge }),
      preflight.summary.multiplicity === null
        ? null
        : t('chemsmart_studio.console.multiplicity', { multiplicity: preflight.summary.multiplicity })
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(' · ')
  }, [preflight, t])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="command-console">
      {/* The surface class is shared with the agent's terminal output so both read the same in either
          theme. The container itself stays local: the console is spawned with `TERM=dumb` and no tty,
          so there is no ANSI to decode and nothing to gain from the heavier renderer. */}
      <div
        className={cn(
          'm-0 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all rounded-md px-2.5 py-2',
          "font-['Menlo','Monaco','Courier_New',monospace] text-xs leading-normal",
          TERMINAL_SURFACE_CLASS
        )}
        data-testid="console-output">
        {lines.length === 0 ? (
          <p className="text-foreground-muted">{t('chemsmart_studio.console.empty')}</p>
        ) : (
          lines.map((line, index) => (
            <span
              className={cn(line.stream === 'stderr' && 'text-destructive')}
              // Output is append-only and never reordered, so the index is the identity.
              key={index}>
              {line.chunk}
            </span>
          ))
        )}
        {/* Scrolling a sentinel into view keeps the follow behaviour inside this scroll container
            rather than needing a second one wrapped around it. */}
        <span aria-hidden ref={bottomRef} />
      </div>

      {completions?.semantic.breadcrumb.length ? (
        <div
          aria-label={t('chemsmart_studio.console.guide')}
          className="flex min-h-8 shrink-0 items-center gap-1 overflow-x-auto rounded-md border border-border/70 bg-background/50 px-2 text-xs"
          data-testid="console-semantic-guide">
          <span className="flex shrink-0 items-center gap-1 font-medium text-foreground">
            {completions.semantic.breadcrumb.map((part, index) => (
              <Fragment key={`${part}-${index}`}>
                {index > 0 ? <span className="text-foreground-muted">›</span> : null}
                <code>{part}</code>
              </Fragment>
            ))}
          </span>
          {completions.semantic.ghostSuffix ? (
            <span className="truncate text-foreground-muted/70" data-testid="console-ghost-suffix">
              {completions.semantic.ghostSuffix}
            </span>
          ) : null}
        </div>
      ) : null}

      {preflight ? (
        <div
          className={cn(
            'shrink-0 rounded-md border px-2.5 py-2 text-xs',
            preflight.verdict === 'green' && 'border-success/40 bg-success/10 text-success',
            preflight.verdict === 'warning' && 'border-warning/50 bg-warning/10 text-warning',
            preflight.verdict === 'rejected' && 'border-destructive/50 bg-destructive/10 text-destructive'
          )}
          data-testid="console-preflight"
          role={preflight.verdict === 'rejected' ? 'alert' : 'status'}>
          <div className="flex items-center gap-2 font-medium">
            {preflight.verdict === 'green' ? <CheckCircle2 aria-hidden className="size-3.5" /> : null}
            {preflight.verdict === 'warning' ? <AlertTriangle aria-hidden className="size-3.5" /> : null}
            {preflight.verdict === 'rejected' ? <XCircle aria-hidden className="size-3.5" /> : null}
            <span>
              {preflight.verdict === 'green'
                ? t('chemsmart_studio.console.preflight_ready')
                : preflight.verdict === 'warning'
                  ? t('chemsmart_studio.console.preflight_warning')
                  : t('chemsmart_studio.console.preflight_rejected')}
            </span>
            <span className="font-normal text-foreground-muted">{preflightSummary}</span>
          </div>
          {preflight.issues.length > 0 ? (
            <details className="mt-1 text-foreground">
              <summary>{t('chemsmart_studio.console.preflight_details')}</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {preflight.issues.map((issue) => (
                  <li key={issue.ruleId}>{issue.message}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {exit ? (
        <p className="shrink-0 text-xs" data-testid="console-exit" role="status">
          <Badge variant={exit.code === 0 ? 'outline' : 'destructive'}>
            {exit.signal
              ? t('chemsmart_studio.console.exit_signal', { signal: exit.signal })
              : t('chemsmart_studio.console.exit_code', { code: exit.code ?? -1 })}
          </Badge>
        </p>
      ) : null}

      <div className="flex shrink-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          {visible.length > 0 ? (
            <ul
              aria-label={t('chemsmart_studio.console.completions')}
              className="absolute right-0 bottom-[calc(100%+0.375rem)] left-0 z-50 max-h-64 overflow-y-auto rounded-md border border-border/80 bg-popover py-1 shadow-xl"
              data-testid="console-completions"
              id="chemsmart-console-completions"
              role="listbox">
              {visible.map((entry, index) => {
                const KindIcon =
                  entry.kind === 'file'
                    ? File
                    : entry.kind === 'project'
                      ? FolderKanban
                      : entry.kind === 'server'
                        ? Server
                        : entry.kind === 'option'
                          ? Variable
                          : entry.kind === 'choice' || entry.kind === 'argument'
                            ? ListTree
                            : Terminal
                return (
                  <Fragment key={entry.id}>
                    {index === 0 || visible[index - 1].group !== entry.group ? (
                      <li
                        className="border-border/60 border-b px-2.5 py-1 font-medium text-[10px] text-foreground-muted uppercase tracking-wide"
                        role="presentation">
                        {completionGroupLabels[entry.group]}
                      </li>
                    ) : null}
                    <li
                      aria-selected={index === selectedCompletion}
                      id={`console-completion-${entry.id}`}
                      role="option">
                      <button
                        className={cn(
                          'grid min-h-8 w-full grid-cols-[1rem_minmax(7rem,auto)_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1 text-left text-xs outline-none',
                          'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                          index === selectedCompletion && 'bg-primary/20 text-primary'
                        )}
                        type="button"
                        onClick={() => applyCompletion(entry)}>
                        <KindIcon aria-hidden className="size-3.5" />
                        <code className="truncate font-semibold">{entry.label}</code>
                        <span
                          className={cn(
                            'truncate',
                            index === selectedCompletion ? 'text-primary/80' : 'text-foreground-muted'
                          )}>
                          {entry.detail}
                        </span>
                        {entry.valueHint ? (
                          <span className="shrink-0 font-mono text-[10px] text-foreground-muted">
                            {entry.valueHint}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  </Fragment>
                )
              })}
            </ul>
          ) : null}
          <Input
            aria-activedescendant={
              visible[selectedCompletion] ? `console-completion-${visible[selectedCompletion].id}` : undefined
            }
            aria-autocomplete="list"
            aria-controls={visible.length > 0 ? 'chemsmart-console-completions' : undefined}
            aria-expanded={visible.length > 0}
            aria-label={t('chemsmart_studio.console.command')}
            className="w-full font-mono text-xs"
            data-testid="console-input"
            id="chemsmart-console-input"
            placeholder={t('chemsmart_studio.console.placeholder')}
            ref={inputRef}
            value={command}
            onChange={(event) => {
              const next = event.target.value
              completionGenerationRef.current += 1
              setCompletions(null)
              setSelectedCompletion(0)
              setCommand(next)
              setPreflight(null)
              setPendingWarning(null)
              if (next.trim().length > 0) {
                void refreshCompletions(next, event.target.selectionStart ?? next.length)
              }
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {runId ? (
          <Button
            aria-label={t('chemsmart_studio.console.cancel')}
            data-testid="console-cancel"
            size="sm"
            variant="destructive"
            onClick={() => void cancel()}>
            <Square aria-hidden className="size-3.5" />
            {t('chemsmart_studio.console.cancel')}
          </Button>
        ) : (
          <Button
            aria-label={t('chemsmart_studio.console.run')}
            data-testid="console-run"
            disabled={command.trim().length === 0}
            size="sm"
            variant="outline"
            onClick={() => void submit()}>
            <Play aria-hidden className="size-3.5" />
            {t('chemsmart_studio.console.run')}
          </Button>
        )}
      </div>
      <p className="shrink-0 text-foreground-muted text-xs">
        <CornerDownLeft aria-hidden className="mr-1 inline size-3" />
        {pendingWarning ? t('chemsmart_studio.console.warning_hint') : t('chemsmart_studio.console.hint')}
      </p>
    </div>
  )
}
