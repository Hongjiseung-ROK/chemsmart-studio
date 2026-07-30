import type { ResearchThreadSummary, StudioAgentCapability, StudioAgentTurnEvent } from '@chemsmart/studio-protocol'
import {
  Badge,
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Scrollbar,
  Textarea,
  Tooltip
} from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Bot,
  ChevronRight,
  FilePlus2,
  Forward,
  History,
  ListPlus,
  MoreHorizontal,
  Plus,
  ShieldQuestion,
  Slash,
  Square,
  X
} from 'lucide-react'
import {
  type ComponentRef,
  type ReactNode,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import { AgentTraceTimeline, type StudioAgentLiveProjection } from './AgentTraceTimeline'

export interface AgentComposerSnapshot {
  selectionEnd: number
  selectionStart: number
  scrollTop: number
  value: string
}

export interface AgentWorkbenchArtifact {
  id: string
  review: ReactNode
  status: 'draft' | 'ready' | 'waiting'
  summary: string
  title: string
}

type DiscoveryTrigger = '+' | '/' | '@'

interface AgentComposerCapability {
  capability: StudioAgentCapability
  description: string
  id: string
  insertText: string
  label: string
  trigger: DiscoveryTrigger
}

const triggerIcons = {
  '+': Plus,
  '/': Slash,
  '@': AtSign
} as const

const artifactStatusKeys = {
  draft: 'chemsmart_studio.agent_workbench.artifact.draft',
  ready: 'chemsmart_studio.agent_workbench.artifact.ready',
  waiting: 'chemsmart_studio.agent_workbench.artifact.waiting'
} as const

const artifactStatusClasses = {
  draft: 'border-border text-foreground-secondary',
  ready: 'border-success text-success',
  waiting: 'border-warning text-warning'
} as const

interface ChemSmartAgentPaneProps {
  activeThreadId: string
  artifacts: readonly AgentWorkbenchArtifact[]
  available: boolean
  busy: boolean
  capabilities: readonly StudioAgentCapability[]
  composer: AgentComposerSnapshot
  failed: boolean
  pendingDecisionCount: number
  reviewRequestId: number
  reviewContent: ReactNode
  threadTitle: string
  threads: readonly ResearchThreadSummary[]
  turnEvents: readonly StudioAgentTurnEvent[]
  liveEvents?: readonly StudioAgentLiveProjection[]
  onClose: () => void
  onComposerChange: (snapshot: AgentComposerSnapshot) => void
  onCreateThread: () => void
  onOpenProperties: () => void
  onQueue: () => void
  onRenameThread: (threadId: string, title: string) => void
  onSelectThread: (threadId: string) => void
  onSteer: () => void
  onStop: () => void
  onSubmit: () => void
}

function snapshotFromTextarea(element: HTMLTextAreaElement): AgentComposerSnapshot {
  return {
    selectionEnd: element.selectionEnd,
    selectionStart: element.selectionStart,
    scrollTop: element.scrollTop,
    value: element.value
  }
}

function findDiscovery(value: string, cursor: number) {
  const match = value.slice(0, cursor).match(/(?:^|\s)([+/@])([^\s]*)$/)
  if (!match) return null
  const trigger = match[1] as DiscoveryTrigger
  const query = match[2].toLocaleLowerCase()
  const tokenStart = cursor - trigger.length - query.length
  return { query, tokenStart, trigger }
}

/**
 * One trustworthy Agent surface: conversation, host-emitted tool lifecycle, contextual reviews, and composer.
 * The pane never renders provider payloads, raw arguments, filesystem paths, or model chain-of-thought.
 */
export function ChemSmartAgentPane({
  activeThreadId,
  artifacts,
  available,
  busy,
  capabilities,
  composer,
  failed,
  pendingDecisionCount,
  reviewRequestId,
  reviewContent,
  threadTitle,
  threads,
  turnEvents,
  liveEvents = [],
  onClose,
  onComposerChange,
  onCreateThread,
  onOpenProperties,
  onQueue,
  onRenameThread,
  onSelectThread,
  onSteer,
  onStop,
  onSubmit
}: ChemSmartAgentPaneProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<ComponentRef<typeof Textarea.Input>>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const reviewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [reviewArtifactId, setReviewArtifactId] = useState<string | null>(null)
  const [reviewMode, setReviewMode] = useState<'artifact' | 'decisions' | 'history' | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [dismissedDiscoveryKey, setDismissedDiscoveryKey] = useState<string | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [renameTitle, setRenameTitle] = useState(threadTitle)
  const [followingConversation, setFollowingConversation] = useState(true)
  const discovery = useMemo(
    () => findDiscovery(composer.value, composer.selectionStart),
    [composer.selectionStart, composer.value]
  )
  const composerCapabilities = useMemo<AgentComposerCapability[]>(
    () =>
      capabilities.map((capability) => {
        const trigger = capability.discovery === 'plus' ? '+' : capability.discovery === 'mention' ? '@' : '/'
        return {
          capability,
          description: capability.description,
          id: `${capability.discovery}.${capability.key}`,
          insertText: `${trigger}${capability.key}`,
          label: capability.label,
          trigger
        }
      }),
    [capabilities]
  )
  const discoveryKey = discovery ? `${composer.value}:${composer.selectionStart}` : null
  const suggestions = useMemo(() => {
    if (!discovery || discoveryKey === dismissedDiscoveryKey) return []
    return composerCapabilities.filter(
      (capability) =>
        capability.trigger === discovery.trigger &&
        (capability.insertText.toLocaleLowerCase().includes(discovery.query) ||
          capability.label.toLocaleLowerCase().includes(discovery.query))
    )
  }, [composerCapabilities, discovery, discoveryKey, dismissedDiscoveryKey])
  const selectedCapabilities = useMemo(
    () =>
      composerCapabilities.filter((capability) =>
        composer.value.split(/\s+/).some((token) => token === capability.insertText)
      ),
    [composer.value, composerCapabilities]
  )
  const visibleThreads = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase()
    if (!query) return threads
    return threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query))
  }, [historyQuery, threads])
  const selectedArtifact = artifacts.find((artifact) => artifact.id === reviewArtifactId) ?? null
  const reviewOpen = reviewMode !== null
  const liveTailKey = liveEvents.at(-1)?.sequence ?? -1
  const canonicalTailKey = turnEvents.at(-1)?.sequence ?? -1

  useEffect(() => setRenameTitle(threadTitle), [threadTitle])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || document.activeElement !== textarea) return
    textarea.setSelectionRange(composer.selectionStart, composer.selectionEnd)
    textarea.scrollTop = composer.scrollTop
  }, [composer.selectionEnd, composer.selectionStart, composer.scrollTop, composer.value])

  useEffect(() => {
    if (reviewRequestId <= 0) return
    setReviewMode('decisions')
    setReviewArtifactId(null)
  }, [reviewRequestId])

  useLayoutEffect(() => {
    if (!followingConversation) return
    const conversation = conversationRef.current
    if (!conversation) return
    conversation.scrollTop = conversation.scrollHeight
  }, [canonicalTailKey, followingConversation, liveTailKey])

  const updateConversationFollow = useCallback(() => {
    const conversation = conversationRef.current
    if (!conversation) return
    const distanceFromBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight
    setFollowingConversation(distanceFromBottom <= 48)
  }, [])

  const jumpToLatest = useCallback(() => {
    const conversation = conversationRef.current
    if (!conversation) return
    setFollowingConversation(true)
    conversation.scrollTop = conversation.scrollHeight
  }, [])

  const updateComposer = useCallback(
    (element: HTMLTextAreaElement) => {
      setDismissedDiscoveryKey(null)
      onComposerChange(snapshotFromTextarea(element))
    },
    [onComposerChange]
  )

  const selectSuggestion = useCallback(
    (capability: AgentComposerCapability) => {
      if (!discovery) return
      const suffix = composer.value.slice(composer.selectionEnd)
      const nextValue = `${composer.value.slice(0, discovery.tokenStart)}${capability.insertText} ${suffix}`
      const nextCursor = discovery.tokenStart + capability.insertText.length + 1
      onComposerChange({
        selectionEnd: nextCursor,
        selectionStart: nextCursor,
        scrollTop: composer.scrollTop,
        value: nextValue
      })
      setDismissedDiscoveryKey(null)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [composer, discovery, onComposerChange]
  )

  const removeSelectedCapability = useCallback(
    (capability: AgentComposerCapability) => {
      const token = [...composer.value.matchAll(/\S+/g)].find((match) => match[0] === capability.insertText)
      if (token?.index === undefined) return
      let start = token.index
      let end = start + token[0].length
      if (end < composer.value.length && /\s/.test(composer.value[end])) end += 1
      else if (start > 0 && /\s/.test(composer.value[start - 1])) start -= 1
      const value = `${composer.value.slice(0, start)}${composer.value.slice(end)}`
      const cursor = Math.min(start, value.length)
      onComposerChange({
        selectionEnd: cursor,
        selectionStart: cursor,
        scrollTop: composer.scrollTop,
        value
      })
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [composer, onComposerChange]
  )

  const openReview = (
    mode: Exclude<typeof reviewMode, null>,
    trigger: HTMLButtonElement,
    artifactId: string | null = null
  ) => {
    reviewTriggerRef.current = trigger
    setReviewArtifactId(artifactId)
    setReviewMode(mode)
  }

  const closeReview = () => {
    setReviewMode(null)
    setReviewArtifactId(null)
    requestAnimationFrame(() => reviewTriggerRef.current?.focus())
  }

  return (
    <aside
      aria-labelledby="chemsmart-agent-pane-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-border border-l bg-background"
      data-testid="chemsmart-agent-pane"
      id="chemsmart-agent-pane">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-border border-b px-2">
        <Bot aria-hidden className="size-4 shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-foreground text-sm" id="chemsmart-agent-pane-title">
            {t('chemsmart_studio.agent_workbench.title')}
          </h2>
          <p className="truncate text-foreground-muted text-xs">{threadTitle}</p>
        </div>
        <Tooltip content={t('chemsmart_studio.agent_workbench.new')}>
          <Button
            aria-label={t('chemsmart_studio.agent_workbench.new')}
            className="size-8"
            size="icon-sm"
            variant="ghost"
            onClick={onCreateThread}>
            <FilePlus2 aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t('chemsmart_studio.agent_workbench.history')}>
          <Button
            aria-label={t('chemsmart_studio.agent_workbench.history')}
            className="size-8"
            size="icon-sm"
            variant="ghost"
            onClick={(event) => openReview('history', event.currentTarget)}>
            <History aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={t('chemsmart_studio.agent_workbench.more')}
              className="size-8"
              ref={moreTriggerRef}
              size="icon-sm"
              variant="ghost">
              <MoreHorizontal aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpenProperties}>{t('chemsmart_studio.ide.pane.properties')}</DropdownMenuItem>
            <DropdownMenuItem
              disabled={pendingDecisionCount === 0}
              onSelect={() => {
                const trigger = moreTriggerRef.current
                if (trigger) openReview('decisions', trigger)
              }}>
              {t('chemsmart_studio.approval.review')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip content={t('common.close')}>
          <Button aria-label={t('common.close')} className="size-8" size="icon-sm" variant="ghost" onClick={onClose}>
            <X aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      </header>

      <div className="relative min-h-0 flex-1">
        <Scrollbar
          className="h-full min-h-0"
          data-testid="agent-conversation"
          ref={conversationRef}
          onScroll={updateConversationFollow}>
          <div className="space-y-3 p-3">
            {turnEvents.length === 0 ? (
              <div className="rounded-lg border border-border border-dashed px-3 py-8 text-center">
                <Bot aria-hidden className="mx-auto size-5 text-foreground-muted" />
                <p className="mt-2 font-medium text-foreground text-sm">
                  {t('chemsmart_studio.agent_workbench.empty_title')}
                </p>
                <p className="mt-1 text-foreground-muted text-xs leading-5">
                  {t('chemsmart_studio.agent_workbench.empty_description')}
                </p>
              </div>
            ) : (
              <AgentTraceTimeline events={turnEvents} liveEvents={liveEvents} />
            )}

            {artifacts.length > 0 ? (
              <section aria-label={t('chemsmart_studio.agent_workbench.artifacts')} className="space-y-2">
                {artifacts.map((artifact) => (
                  <article
                    className={cn(
                      'rounded-lg border bg-background-subtle p-2.5',
                      artifact.status === 'waiting' ? 'border-warning' : 'border-border-subtle'
                    )}
                    key={artifact.id}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h4 className="font-medium text-foreground text-sm">{artifact.title}</h4>
                          <Badge className={artifactStatusClasses[artifact.status]} variant="outline">
                            {t(artifactStatusKeys[artifact.status])}
                          </Badge>
                        </div>
                        <p className="mt-1 text-foreground-muted text-xs leading-5">{artifact.summary}</p>
                      </div>
                      <Button
                        className="h-8 shrink-0 gap-1"
                        size="sm"
                        variant="ghost"
                        onClick={(event) => openReview('artifact', event.currentTarget, artifact.id)}>
                        {t('chemsmart_studio.agent_workbench.review')}
                        <ChevronRight aria-hidden className="size-3.5" />
                      </Button>
                    </div>
                  </article>
                ))}
              </section>
            ) : null}

            {pendingDecisionCount > 0 ? (
              <article
                className="rounded-lg border border-warning bg-background-subtle p-3"
                data-testid="agent-inline-approval">
                <div className="flex items-start gap-2">
                  <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-foreground text-sm">
                      {t('chemsmart_studio.agent_workbench.approval_title')}
                    </h3>
                    <p className="mt-1 text-foreground-secondary text-xs leading-5">
                      {t('chemsmart_studio.approval.pending_count', { count: pendingDecisionCount })}
                    </p>
                  </div>
                  <Button
                    className="h-8 shrink-0"
                    size="sm"
                    variant="outline"
                    onClick={(event) => openReview('decisions', event.currentTarget)}>
                    {t('chemsmart_studio.approval.review')}
                  </Button>
                </div>
              </article>
            ) : null}
          </div>
        </Scrollbar>
        {!followingConversation && turnEvents.length > 0 ? (
          <Button
            className="absolute right-3 bottom-3 h-8 gap-1.5 rounded-full border border-border bg-popover px-3 shadow-md"
            size="sm"
            type="button"
            variant="outline"
            onClick={jumpToLatest}>
            <ArrowDown aria-hidden className="size-3.5" />
            {t('chemsmart_studio.agent_trace.jump_latest')}
          </Button>
        ) : null}
      </div>

      <form
        aria-label={t('chemsmart_studio.workspace.agent_composer')}
        className="relative shrink-0 border-border border-t bg-background p-3"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}>
        {failed ? (
          <p
            className="mb-2 rounded-md border border-error-border bg-error-bg px-2.5 py-2 text-error-text text-xs"
            role="alert">
            {t('chemsmart_studio.workspace.agent_turn_failed')}
          </p>
        ) : null}
        {selectedCapabilities.length > 0 ? (
          <div
            aria-label={t('chemsmart_studio.agent_workbench.discovery.selected')}
            className="mb-2 flex flex-wrap gap-1.5">
            {selectedCapabilities.map((capability) => (
              <Button
                aria-label={t('chemsmart_studio.agent_workbench.discovery.remove', {
                  label: capability.label
                })}
                className="h-8 max-w-full gap-1.5 rounded-full px-2.5"
                key={capability.id}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => removeSelectedCapability(capability)}>
                <span className="truncate">{capability.label}</span>
                <X aria-hidden className="size-3.5 shrink-0" />
              </Button>
            ))}
          </div>
        ) : null}
        {suggestions.length > 0 ? (
          <div
            aria-label={t('chemsmart_studio.agent_workbench.discovery.label')}
            className="absolute right-3 bottom-full left-3 z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
            id="chemsmart-agent-suggestions"
            role="listbox">
            {suggestions.map((capability, index) => {
              const Icon = triggerIcons[capability.trigger]
              return (
                <button
                  aria-selected={activeSuggestion === index}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left outline-none',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    activeSuggestion === index && 'bg-accent'
                  )}
                  id={`chemsmart-agent-suggestion-${index}`}
                  key={capability.id}
                  role="option"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(capability)}>
                  <Icon aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground text-sm">{capability.label}</span>
                    <span className="block truncate text-foreground-muted text-xs">{capability.description}</span>
                  </span>
                  <code className="shrink-0 text-foreground-muted text-xs">{capability.insertText}</code>
                </button>
              )
            })}
          </div>
        ) : null}
        <label className="sr-only" htmlFor="chemsmart-agent-request">
          {t('chemsmart_studio.workspace.agent_request')}
        </label>
        <Textarea.Input
          aria-activedescendant={suggestions.length > 0 ? `chemsmart-agent-suggestion-${activeSuggestion}` : undefined}
          aria-controls={suggestions.length > 0 ? 'chemsmart-agent-suggestions' : undefined}
          aria-describedby="chemsmart-agent-composer-help"
          aria-expanded={suggestions.length > 0}
          aria-haspopup="listbox"
          id="chemsmart-agent-request"
          maxLength={100000}
          placeholder={t('chemsmart_studio.workspace.agent_request_placeholder')}
          ref={textareaRef}
          rows={3}
          value={composer.value}
          onChange={(event) => updateComposer(event.currentTarget)}
          onKeyDown={(event) => {
            if (suggestions.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setActiveSuggestion((index) => (index + direction + suggestions.length) % suggestions.length)
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                selectSuggestion(suggestions[activeSuggestion] ?? suggestions[0])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (discoveryKey) setDismissedDiscoveryKey(discoveryKey)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          onScroll={(event: UIEvent<HTMLTextAreaElement>) => updateComposer(event.currentTarget)}
          onSelect={(event) => updateComposer(event.currentTarget)}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-foreground-muted text-xs" id="chemsmart-agent-composer-help">
            {t('chemsmart_studio.agent_workbench.discovery.hint')}
          </p>
          {busy ? (
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip content={t('chemsmart_studio.agent_workbench.control.stop')}>
                <Button
                  aria-label={t('chemsmart_studio.agent_workbench.control.stop')}
                  className="size-8"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={onStop}>
                  <Square aria-hidden className="size-3.5 fill-current" />
                </Button>
              </Tooltip>
              <Tooltip content={t('chemsmart_studio.agent_workbench.control.steer')}>
                <Button
                  aria-label={t('chemsmart_studio.agent_workbench.control.steer')}
                  className="size-8"
                  disabled={!available || composer.value.trim().length === 0}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={onSteer}>
                  <Forward aria-hidden className="size-4" />
                </Button>
              </Tooltip>
              <Tooltip content={t('chemsmart_studio.agent_workbench.control.queue')}>
                <Button
                  aria-label={t('chemsmart_studio.agent_workbench.control.queue')}
                  className="size-8"
                  disabled={!available || composer.value.trim().length === 0}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  onClick={onQueue}>
                  <ListPlus aria-hidden className="size-4" />
                </Button>
              </Tooltip>
            </div>
          ) : (
            <Button
              aria-label={t('chemsmart_studio.workspace.send_agent_request')}
              className="size-8 shrink-0"
              disabled={!available || composer.value.trim().length === 0}
              size="icon-sm"
              type="submit">
              <ArrowUp aria-hidden className="size-4" />
            </Button>
          )}
        </div>
      </form>

      <Drawer
        direction="right"
        handleOnly
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open) closeReview()
        }}>
        <DrawerContent
          aria-describedby="chemsmart-agent-review-description"
          className="w-[min(92vw,440px)] sm:max-w-none"
          data-testid="agent-review-sheet">
          <DrawerHeader className="flex-row items-center justify-between border-border border-b">
            <div className="min-w-0">
              <DrawerTitle>
                {reviewMode === 'history'
                  ? t('chemsmart_studio.agent_workbench.history')
                  : reviewMode === 'decisions'
                    ? t('chemsmart_studio.approval.title')
                    : (selectedArtifact?.title ?? t('chemsmart_studio.agent_workbench.review'))}
              </DrawerTitle>
              <DrawerDescription id="chemsmart-agent-review-description">
                {reviewMode === 'history'
                  ? t('chemsmart_studio.agent_workbench.history_description')
                  : reviewMode === 'decisions'
                    ? t('chemsmart_studio.agent_workbench.approval_description')
                    : (selectedArtifact?.summary ?? t('chemsmart_studio.agent_workbench.review_description'))}
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <Button aria-label={t('common.close')} className="size-8 shrink-0" size="icon-sm" variant="ghost">
                <X aria-hidden className="size-4" />
              </Button>
            </DrawerClose>
          </DrawerHeader>
          <Scrollbar className="min-h-0 flex-1">
            <div className="space-y-3 p-4">
              {reviewMode === 'history' ? (
                threads.length === 0 ? (
                  <p className="text-foreground-muted text-sm">{t('chemsmart_studio.agent_workbench.history_empty')}</p>
                ) : (
                  <>
                    <Input
                      aria-label={t('chemsmart_studio.agent_workbench.history_search')}
                      autoComplete="off"
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.currentTarget.value)}
                    />
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const title = renameTitle.trim()
                        if (title) onRenameThread(activeThreadId, title)
                      }}>
                      <Input
                        aria-label={t('chemsmart_studio.agent_workbench.rename')}
                        maxLength={120}
                        value={renameTitle}
                        onChange={(event) => setRenameTitle(event.currentTarget.value)}
                      />
                      <Button className="h-8 shrink-0" size="sm" type="submit" variant="outline">
                        {t('common.save')}
                      </Button>
                    </form>
                    {visibleThreads.length === 0 ? (
                      <p className="text-foreground-muted text-sm">
                        {t('chemsmart_studio.agent_workbench.history_no_results')}
                      </p>
                    ) : (
                      <ol className="space-y-2">
                        {visibleThreads.map((thread) => (
                          <li key={thread.threadId}>
                            <Button
                              aria-current={thread.threadId === activeThreadId ? 'page' : undefined}
                              className="h-auto min-h-10 w-full justify-start px-3 py-2 text-left"
                              variant={thread.threadId === activeThreadId ? 'secondary' : 'ghost'}
                              onClick={() => {
                                onSelectThread(thread.threadId)
                                closeReview()
                              }}>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-sm">{thread.title}</span>
                                <span className="block text-foreground-muted text-xs">
                                  {thread.imported
                                    ? t('chemsmart_studio.agent_workbench.imported')
                                    : t('chemsmart_studio.agent_workbench.turn_count', {
                                        count: thread.activityCount
                                      })}
                                </span>
                              </span>
                            </Button>
                          </li>
                        ))}
                      </ol>
                    )}
                  </>
                )
              ) : reviewMode === 'decisions' ? (
                reviewContent
              ) : (
                selectedArtifact?.review
              )}
            </div>
          </Scrollbar>
        </DrawerContent>
      </Drawer>
    </aside>
  )
}
