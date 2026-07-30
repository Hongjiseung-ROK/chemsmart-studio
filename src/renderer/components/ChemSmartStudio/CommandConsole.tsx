import { Badge, Button, Input, Popover, PopoverAnchor, PopoverContent } from '@cherrystudio/ui'
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
  ChevronRight,
  CornerDownLeft,
  File,
  FileInput,
  FolderKanban,
  ListTree,
  MoreHorizontal,
  Play,
  Server,
  Square,
  Terminal,
  Variable,
  XCircle
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('CommandConsole')

/** Enough scrollback to read a failed run without letting a chatty job grow the DOM without bound. */
const MAX_OUTPUT_CHARS = 200_000
const SUPPORTED_DROP_FILE = /\.(?:cjson|sdf|xyz)$/i

type CompletionDisclosure = 'primary' | 'all'
type CompletionItem = ChemSmartStudioConsoleCompletions['items'][number]

interface CompletionRequestSnapshot {
  cursor: number
  disclosure: CompletionDisclosure
  generation: number
  line: string
}

interface EditorSnapshot {
  cursor: number
  line: string
}

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
  /** Return true when the workspace deferred opening until its current draft is resolved. */
  onOpenCompletionRequest?: (contextRef: string) => boolean
}

export function CommandConsole({
  draft,
  onDraftChange,
  onOpenCompletion,
  onOpenCompletionRequest
}: CommandConsoleProps = {}) {
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
  const [selectedCompletion, setSelectedCompletion] = useState(-1)
  const [preflight, setPreflight] = useState<ChemSmartStudioConsolePreflight | null>(null)
  const [pendingWarning, setPendingWarning] = useState<{ command: string; digest: string } | null>(null)
  const [history, setHistory] = usePersistCache('ui.studio.console.history')
  const [historyCursor, setHistoryCursor] = useState<number | null>(null)
  const [dropMessage, setDropMessage] = useState<string | null>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLSpanElement>(null)
  const runIdRef = useRef<string | null>(null)
  const completionGenerationRef = useRef(0)
  const dropGenerationRef = useRef(0)
  const editorSnapshotRef = useRef<EditorSnapshot>({ line: command, cursor: command.length })
  const activeCompletionRequestRef = useRef<CompletionRequestSnapshot | null>(null)
  const publishedCompletionRequestRef = useRef<CompletionRequestSnapshot | null>(null)
  const completionRowRefs = useRef(new Map<string, HTMLLIElement>())
  const pendingSelectionRef = useRef<number | null>(null)
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

  const clearCompletionGuidance = useCallback(() => {
    const generation = completionGenerationRef.current + 1
    completionGenerationRef.current = generation
    activeCompletionRequestRef.current = null
    publishedCompletionRequestRef.current = null
    setSelectedCompletion(-1)
    setCompletions(null)
    return generation
  }, [])

  const refreshCompletions = useCallback(
    async (line: string, cursor: number, disclosure: CompletionDisclosure = 'primary', allowEmpty = false) => {
      const generation = clearCompletionGuidance()
      const request: CompletionRequestSnapshot = { line, cursor, disclosure, generation }
      activeCompletionRequestRef.current = request
      if (!allowEmpty && line.trim().length === 0) return
      try {
        const result = await ipcApi.request('chemsmart_studio.console.complete', { line, cursor, disclosure })
        const activeRequest = activeCompletionRequestRef.current
        const editor = editorSnapshotRef.current
        if (
          completionGenerationRef.current !== generation ||
          activeRequest?.generation !== generation ||
          activeRequest.line !== line ||
          activeRequest.cursor !== cursor ||
          activeRequest.disclosure !== disclosure ||
          editor.line !== line ||
          editor.cursor !== cursor ||
          result.disclosure !== disclosure
        ) {
          return
        }
        publishedCompletionRequestRef.current = request
        setSelectedCompletion(result.items.length > 0 ? 0 : -1)
        setCompletions(result)
      } catch (error) {
        if (completionGenerationRef.current !== generation) return
        // Advice is optional; the console still runs commands without it.
        logger.error('Failed to resolve chemsmart CLI completions', error as Error)
        clearCompletionGuidance()
      }
    },
    [clearCompletionGuidance]
  )

  const mutateCommand = useCallback(
    (next: string, cursor: number, options: { disclosure?: CompletionDisclosure; restoreSelection?: boolean } = {}) => {
      dropGenerationRef.current += 1
      editorSnapshotRef.current = { line: next, cursor }
      if (options.restoreSelection) pendingSelectionRef.current = cursor
      setCommand(next)
      setHistoryCursor(null)
      setPreflight(null)
      setPendingWarning(null)
      setDropMessage(null)
      void refreshCompletions(next, cursor, options.disclosure ?? 'primary')
    },
    [refreshCompletions, setCommand]
  )

  useLayoutEffect(() => {
    const cursor = pendingSelectionRef.current
    if (cursor === null || inputRef.current?.value !== command) return
    pendingSelectionRef.current = null
    inputRef.current.focus()
    inputRef.current.setSelectionRange(cursor, cursor)
  }, [command])

  useEffect(() => {
    const editor = editorSnapshotRef.current
    if (editor.line === command) return
    const cursor = inputRef.current?.selectionStart ?? command.length
    dropGenerationRef.current += 1
    editorSnapshotRef.current = { line: command, cursor }
    setPreflight(null)
    setPendingWarning(null)
    setDropMessage(null)
    void refreshCompletions(command, cursor)
  }, [command, refreshCompletions])

  useEffect(() => {
    if (selectedCompletion < 0 || !completions?.items[selectedCompletion]) return
    completionRowRefs.current.get(completions.items[selectedCompletion].id)?.scrollIntoView?.({ block: 'nearest' })
  }, [completions, selectedCompletion])

  const startRun = useCallback(
    async (line: string, preflightDigest: string) => {
      setLines([{ stream: 'stdout', chunk: `$ ${line}\n` }])
      setExit(null)
      clearCompletionGuidance()
      setHistory([line, ...recent.filter((entry) => entry !== line)].slice(0, 50))
      setHistoryCursor(null)
      try {
        const result = await ipcApi.request('chemsmart_studio.console.run', {
          command: line,
          preflightDigest
        })
        setRunId(result.runId)
        mutateCommand('', 0, { restoreSelection: true })
      } catch (error) {
        logger.error('Failed to run a console command', error as Error)
        setLines((current) => [...current, { stream: 'stderr', chunk: t('chemsmart_studio.console.run_failed') }])
      }
    },
    [clearCompletionGuidance, mutateCommand, recent, setHistory, t]
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

  const acceptCompletionContext = useCallback(
    (entry: CompletionItem) => {
      if (!entry.contextRef || !entry.openAction) return
      if (onOpenCompletionRequest?.(entry.contextRef)) return
      void ipcApi
        .request('chemsmart_studio.console.accept_completion', { contextRef: entry.contextRef })
        .then((selection) => onOpenCompletion?.(selection))
        .catch((error) => logger.error('Failed to open a selected console context', error as Error))
    },
    [onOpenCompletion, onOpenCompletionRequest]
  )

  const insertCompletion = useCallback(
    (line: string, replaceRange: { start: number; end: number }, entry: CompletionItem) => {
      if (replaceRange.start > replaceRange.end || replaceRange.end > line.length) return false
      const insertion = `${entry.insertText}${entry.appendSpace ? ' ' : ''}`
      const next = `${line.slice(0, replaceRange.start)}${insertion}${line.slice(replaceRange.end)}`
      const nextCursor = replaceRange.start + insertion.length
      mutateCommand(next, nextCursor, { restoreSelection: true })
      acceptCompletionContext(entry)
      return true
    },
    [acceptCompletionContext, mutateCommand]
  )

  const applyCompletion = useCallback(
    (entry: CompletionItem) => {
      const request = publishedCompletionRequestRef.current
      const editor = editorSnapshotRef.current
      if (!completions || !request || editor.line !== request.line || completions.disclosure !== request.disclosure) {
        return
      }
      insertCompletion(request.line, completions.replaceRange, entry)
    },
    [completions, insertCompletion]
  )

  const focusPreviousRequired = useCallback(() => {
    const cursor = editorSnapshotRef.current.cursor
    const requiredSlots = completions?.semantic.slots.filter((slot) => slot.required && !slot.consumed) ?? []
    let missing = requiredSlots[0]
    for (const slot of requiredSlots) {
      if (slot.insertAt <= cursor && (!missing || slot.insertAt >= missing.insertAt)) missing = slot
    }
    if (!missing) {
      const editor = editorSnapshotRef.current
      void refreshCompletions(editor.line, editor.cursor)
      return
    }
    if (!missing.insertText) {
      dropGenerationRef.current += 1
      editorSnapshotRef.current = { line: editorSnapshotRef.current.line, cursor: missing.insertAt }
      void refreshCompletions(editorSnapshotRef.current.line, missing.insertAt)
      queueMicrotask(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(missing.insertAt, missing.insertAt)
      })
      return
    }
    const line = editorSnapshotRef.current.line
    const before = line.slice(0, missing.insertAt)
    const after = line.slice(missing.insertAt)
    const separatorBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const separatorAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
    const insertion = `${separatorBefore}${missing.insertText}${separatorAfter}`
    const next = `${before}${insertion}${after}`
    const nextCursor = before.length + insertion.length - separatorAfter.length
    mutateCommand(next, nextCursor, { restoreSelection: true })
  }, [completions, mutateCommand, refreshCompletions])

  const showAllCompletions = useCallback(() => {
    const editor = editorSnapshotRef.current
    dropGenerationRef.current += 1
    void refreshCompletions(editor.line, editor.cursor, 'all', true)
    queueMicrotask(() => inputRef.current?.focus())
  }, [refreshCompletions])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const visibleItems = completions?.items ?? []
      const isPopupOpen = Boolean(completions && (visibleItems.length > 0 || completions.hasMore))
      if (event.key === 'Tab' && event.shiftKey) {
        event.preventDefault()
        focusPreviousRequired()
        return
      }
      if (event.code === 'Space' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length
        editorSnapshotRef.current = { line: event.currentTarget.value, cursor }
        showAllCompletions()
        return
      }
      if (isPopupOpen && (event.key === 'Enter' || event.key === 'Tab') && visibleItems.length > 0) {
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
        if (!isPopupOpen) return
        event.preventDefault()
        clearCompletionGuidance()
        return
      }
      if (isPopupOpen && visibleItems.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        setSelectedCompletion((current) => {
          if (event.key === 'ArrowDown') return Math.min(Math.max(current, 0) + 1, visibleItems.length - 1)
          return Math.max(current <= 0 ? 0 : current - 1, 0)
        })
        return
      }
      if (isPopupOpen && visibleItems.length > 0 && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault()
        setSelectedCompletion(event.key === 'Home' ? 0 : visibleItems.length - 1)
        return
      }
      // History walks the researcher's own past commands, newest first.
      if (!isPopupOpen && event.key === 'ArrowUp' && recent.length > 0) {
        event.preventDefault()
        const next = historyCursor === null ? 0 : Math.min(historyCursor + 1, recent.length - 1)
        const nextCommand = recent[next]
        mutateCommand(nextCommand, nextCommand.length, { restoreSelection: true })
        setHistoryCursor(next)
        return
      }
      if (!isPopupOpen && event.key === 'ArrowDown' && historyCursor !== null) {
        event.preventDefault()
        const next = historyCursor - 1
        const nextCommand = next < 0 ? '' : recent[next]
        mutateCommand(nextCommand, nextCommand.length, { restoreSelection: true })
        setHistoryCursor(next < 0 ? null : next)
      }
    },
    [
      applyCompletion,
      clearCompletionGuidance,
      completions,
      focusPreviousRequired,
      historyCursor,
      mutateCommand,
      recent,
      selectedCompletion,
      showAllCompletions,
      submit
    ]
  )

  const onCursorChange = useCallback(
    (event: React.SyntheticEvent<HTMLInputElement>) => {
      const line = event.currentTarget.value
      const cursor = event.currentTarget.selectionStart ?? line.length
      const editor = editorSnapshotRef.current
      if (editor.line === line && editor.cursor === cursor) return
      dropGenerationRef.current += 1
      editorSnapshotRef.current = { line, cursor }
      setHistoryCursor(null)
      setDropMessage(null)
      void refreshCompletions(line, cursor)
    },
    [refreshCompletions]
  )

  const restoreEditorFocus = useCallback((cursor: number) => {
    queueMicrotask(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(cursor, cursor)
    })
  }, [])

  const handleFileDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setIsDraggingFile(false)
      const editor = editorSnapshotRef.current
      const generation = dropGenerationRef.current + 1
      dropGenerationRef.current = generation
      clearCompletionGuidance()
      const files = Array.from(event.dataTransfer.files)
      const rejectDrop = (message: string) => {
        setDropMessage(message)
        restoreEditorFocus(editor.cursor)
      }
      if (files.length !== 1) {
        rejectDrop(t('chemsmart_studio.console.drop_multiple'))
        return
      }
      const entry = event.dataTransfer.items[0]?.webkitGetAsEntry?.()
      if (entry?.isDirectory) {
        rejectDrop(t('chemsmart_studio.console.drop_directory'))
        return
      }
      const file = files[0]
      if (!SUPPORTED_DROP_FILE.test(file.name)) {
        rejectDrop(t('chemsmart_studio.console.drop_unsupported'))
        return
      }
      try {
        const filePath = window.api.file.getPathForFile(file)
        if (!filePath) {
          rejectDrop(t('chemsmart_studio.console.drop_failed'))
          return
        }
        const result = await ipcApi.request('chemsmart_studio.console.prepare_file_drop', {
          line: editor.line,
          cursor: editor.cursor,
          filePath
        })
        const currentEditor = editorSnapshotRef.current
        if (
          dropGenerationRef.current !== generation ||
          currentEditor.line !== editor.line ||
          currentEditor.cursor !== editor.cursor
        ) {
          return
        }
        if (!result.item.contextRef || !result.item.openAction) {
          rejectDrop(t('chemsmart_studio.console.drop_failed'))
          return
        }
        if (!insertCompletion(editor.line, result.replaceRange, result.item)) {
          rejectDrop(t('chemsmart_studio.console.drop_failed'))
        }
      } catch (error) {
        logger.error('Failed to prepare a Console file drop', error as Error)
        if (dropGenerationRef.current === generation) rejectDrop(t('chemsmart_studio.console.drop_failed'))
      }
    },
    [clearCompletionGuidance, insertCompletion, restoreEditorFocus, t]
  )

  const visible = completions?.items ?? []
  const completionOpen = Boolean(completions && (visible.length > 0 || completions.hasMore))
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
  const completionStageLabels = useMemo(
    () => ({
      complete: t('chemsmart_studio.console.stage.complete'),
      option: t('chemsmart_studio.console.stage.option'),
      required_value: t('chemsmart_studio.console.stage.required_value'),
      root: t('chemsmart_studio.console.stage.root'),
      subcommand: t('chemsmart_studio.console.stage.subcommand')
    }),
    [t]
  )
  const remainingOptions =
    completions?.semantic.slots.filter((slot) => slot.kind === 'option' && !slot.consumed).length ?? 0
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
    <div
      className={cn(
        'relative flex min-h-0 flex-1 flex-col gap-2 p-3',
        isDraggingFile && 'ring-2 ring-primary ring-inset'
      )}
      data-testid="command-console"
      onDragEnter={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setIsDraggingFile(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setIsDraggingFile(false)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        setIsDraggingFile(true)
      }}
      onDrop={(event) => void handleFileDrop(event)}>
      {isDraggingFile ? (
        <div
          className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-lg border border-primary bg-popover text-sm shadow-lg"
          data-testid="console-drop-overlay">
          <FileInput aria-hidden className="mr-2 size-4" />
          {t('chemsmart_studio.console.drop_prompt')}
        </div>
      ) : null}
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

      {completions ? (
        <div
          aria-label={t('chemsmart_studio.console.guide')}
          className="flex min-h-8 shrink-0 items-center gap-2 overflow-x-auto rounded-md border border-border-muted bg-background-subtle px-2 text-xs"
          data-stage={completions.stage}
          data-testid="console-semantic-guide">
          <Badge className="shrink-0" variant="outline">
            {completionStageLabels[completions.stage]}
          </Badge>
          <span className="flex shrink-0 items-center gap-1 font-medium text-foreground">
            {completions.semantic.breadcrumb.length > 0
              ? completions.semantic.breadcrumb.map((part, index) => (
                  <Fragment key={`${part}-${index}`}>
                    {index > 0 ? <span className="text-foreground-muted">›</span> : null}
                    <code>{part}</code>
                  </Fragment>
                ))
              : t('chemsmart_studio.console.root_command')}
          </span>
          {completions.semantic.slots.map((slot) => (
            <code
              className={cn(
                'shrink-0 rounded-sm px-1 py-0.5',
                slot.required ? 'font-medium text-foreground' : 'text-foreground-muted',
                slot.consumed && 'line-through opacity-60'
              )}
              data-consumed={slot.consumed}
              data-required={slot.required}
              key={slot.id}>
              {slot.required ? `⟨${slot.label}⟩` : `[${slot.label}]`}
            </code>
          ))}
          {remainingOptions > 0 ? (
            <span className="shrink-0 text-foreground-muted">
              {t('chemsmart_studio.console.remaining_options', { count: remainingOptions })}
            </span>
          ) : null}
          {completions.semantic.ghostSuffix ? (
            <span className="truncate text-foreground-muted" data-testid="console-ghost-suffix">
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
        <Popover
          open={completionOpen}
          onOpenChange={(open) => {
            if (!open && completionOpen) clearCompletionGuidance()
          }}>
          <PopoverAnchor asChild>
            <div className="min-w-0 flex-1">
              <Input
                aria-activedescendant={
                  visible[selectedCompletion] ? `console-completion-${visible[selectedCompletion].id}` : undefined
                }
                aria-autocomplete="list"
                aria-controls={completionOpen ? 'chemsmart-console-completions' : undefined}
                aria-expanded={completionOpen}
                aria-haspopup="listbox"
                aria-label={t('chemsmart_studio.console.command')}
                autoComplete="off"
                className="w-full font-mono text-xs"
                data-testid="console-input"
                id="chemsmart-console-input"
                placeholder={t('chemsmart_studio.console.placeholder')}
                ref={inputRef}
                role="combobox"
                value={command}
                onChange={(event) => {
                  const next = event.target.value
                  mutateCommand(next, event.target.selectionStart ?? next.length)
                }}
                onKeyDown={onKeyDown}
                onSelect={onCursorChange}
              />
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            avoidCollisions
            className="w-[clamp(26.25rem,64vw,45rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
            collisionPadding={12}
            data-testid="console-completion-popover"
            side="top"
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              inputRef.current?.focus()
            }}
            onInteractOutside={(event) => {
              if (inputRef.current?.contains(event.target as Node)) event.preventDefault()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              inputRef.current?.focus()
            }}>
            <ul
              aria-label={t('chemsmart_studio.console.completions')}
              className="max-h-[20rem] overflow-y-auto py-1"
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
                const isSelected = index === selectedCompletion
                return (
                  <Fragment key={entry.id}>
                    {index === 0 || visible[index - 1].group !== entry.group ? (
                      <li
                        className="sticky top-0 border-border-muted border-b bg-popover px-2.5 py-1 font-medium text-[10px] text-foreground-muted uppercase tracking-wide"
                        role="presentation">
                        {completionGroupLabels[entry.group]}
                      </li>
                    ) : null}
                    <li
                      aria-selected={isSelected}
                      className={cn(
                        'grid min-h-8 cursor-default grid-cols-[0.75rem_1rem_minmax(7rem,auto)_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1 text-left text-xs outline-none',
                        'hover:bg-accent',
                        isSelected && 'bg-accent text-accent-foreground'
                      )}
                      data-testid={`console-completion-${index}`}
                      id={`console-completion-${entry.id}`}
                      ref={(element) => {
                        if (element) completionRowRefs.current.set(entry.id, element)
                        else completionRowRefs.current.delete(entry.id)
                      }}
                      role="option"
                      onClick={() => applyCompletion(entry)}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setSelectedCompletion(index)}>
                      <ChevronRight
                        aria-hidden
                        className={cn('size-3', isSelected ? 'opacity-100' : 'opacity-0')}
                        data-testid={isSelected ? 'console-selection-marker' : undefined}
                      />
                      <KindIcon aria-hidden className="size-3.5 text-foreground-muted" />
                      <code className="truncate font-semibold">{entry.label}</code>
                      <span className="truncate text-foreground-muted">{entry.detail}</span>
                      {entry.valueHint ? (
                        <span className="shrink-0 rounded-sm border border-border-muted bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted">
                          {entry.valueHint}
                        </span>
                      ) : null}
                    </li>
                  </Fragment>
                )
              })}
            </ul>
            {completions?.hasMore ? (
              <button
                className="flex h-8 w-full items-center gap-2 border-border-muted border-t px-2.5 text-left text-foreground-muted text-xs hover:bg-accent hover:text-accent-foreground"
                data-testid="console-more-completions"
                type="button"
                onClick={showAllCompletions}
                onMouseDown={(event) => event.preventDefault()}>
                <MoreHorizontal aria-hidden className="size-3.5" />
                {t('chemsmart_studio.console.more')}
                <kbd className="ml-auto font-mono text-[10px]">Ctrl+Space</kbd>
              </button>
            ) : null}
          </PopoverContent>
        </Popover>
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
      {dropMessage ? (
        <p className="shrink-0 text-destructive text-xs" data-testid="console-drop-message" role="alert">
          {dropMessage}
        </p>
      ) : null}
      <p className="shrink-0 text-foreground-muted text-xs">
        <CornerDownLeft aria-hidden className="mr-1 inline size-3" />
        {pendingWarning ? t('chemsmart_studio.console.warning_hint') : t('chemsmart_studio.console.hint')}
      </p>
    </div>
  )
}
