import { Badge, Button, Input } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { TERMINAL_SURFACE_CLASS } from '@renderer/components/chat/messages/tools/agent'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import type { ChemSmartStudioConsoleCompletions } from '@shared/ipc/schemas/chemsmartStudio'
import { CornerDownLeft, Play, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
}

export function CommandConsole({ draft, onDraftChange }: CommandConsoleProps = {}) {
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

  const submit = useCallback(async () => {
    const line = command.trim()
    if (line.length === 0 || runId !== null) return
    setLines([{ stream: 'stdout', chunk: `$ ${line}\n` }])
    setExit(null)
    completionGenerationRef.current += 1
    setCompletions(null)
    setHistory([line, ...recent.filter((entry) => entry !== line)].slice(0, 50))
    setHistoryCursor(null)
    try {
      const result = await ipcApi.request('chemsmart_studio.console.run', { command: line })
      setRunId(result.runId)
      setCommand('')
    } catch (error) {
      logger.error('Failed to run a console command', error as Error)
      setLines((current) => [...current, { stream: 'stderr', chunk: t('chemsmart_studio.console.run_failed') }])
    }
  }, [command, recent, runId, setCommand, setHistory, t])

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
      queueMicrotask(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [command, completions, setCommand]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const visibleItems = completions?.items.slice(0, MAX_COMPLETIONS) ?? []
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
    [applyCompletion, completions, historyCursor, recent, selectedCompletion, setCommand, submit]
  )

  const visible = completions?.items.slice(0, MAX_COMPLETIONS) ?? []

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

      {exit ? (
        <p className="shrink-0 text-xs" data-testid="console-exit" role="status">
          <Badge variant={exit.code === 0 ? 'outline' : 'destructive'}>
            {exit.signal
              ? t('chemsmart_studio.console.exit_signal', { signal: exit.signal })
              : t('chemsmart_studio.console.exit_code', { code: exit.code ?? -1 })}
          </Badge>
        </p>
      ) : null}

      {visible.length > 0 ? (
        <ul
          aria-label={t('chemsmart_studio.console.completions')}
          className="max-h-40 shrink-0 overflow-y-auto rounded-md border border-border bg-card"
          data-testid="console-completions"
          id="chemsmart-console-completions"
          role="listbox">
          {visible.map((entry, index) => (
            <li
              aria-selected={index === selectedCompletion}
              id={`console-completion-${entry.id}`}
              key={entry.id}
              role="option">
              <button
                className={cn(
                  'flex min-h-8 w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-accent',
                  index === selectedCompletion && 'bg-accent'
                )}
                type="button"
                onClick={() => applyCompletion(entry)}>
                <code className="shrink-0 font-medium text-foreground">{entry.label}</code>
                <span className="truncate text-foreground-muted">{entry.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex shrink-0 items-center gap-2">
        <Input
          aria-activedescendant={
            visible[selectedCompletion] ? `console-completion-${visible[selectedCompletion].id}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={visible.length > 0 ? 'chemsmart-console-completions' : undefined}
          aria-expanded={visible.length > 0}
          aria-label={t('chemsmart_studio.console.command')}
          className="flex-1 font-mono text-xs"
          data-testid="console-input"
          id="chemsmart-console-input"
          placeholder={t('chemsmart_studio.console.placeholder')}
          ref={inputRef}
          value={command}
          onChange={(event) => {
            const next = event.target.value
            setCommand(next)
            void refreshCompletions(next, event.target.selectionStart ?? next.length)
          }}
          onKeyDown={onKeyDown}
        />
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
        {t('chemsmart_studio.console.hint')}
      </p>
    </div>
  )
}
