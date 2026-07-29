import type { StudioAgentTraceEvent } from '@chemsmart/studio-protocol'
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
  Scrollbar,
  Textarea,
  Tooltip
} from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import {
  ArrowUp,
  AtSign,
  Bot,
  ChevronRight,
  FilePlus2,
  History,
  MoreHorizontal,
  Plus,
  ShieldQuestion,
  Slash,
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

import { AgentTraceTimeline, type AgentConversationRequest } from './AgentTraceTimeline'

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
  descriptionKey: string
  id: string
  insertText: string
  labelKey: string
  trigger: DiscoveryTrigger
}

/**
 * Renderer-only discovery metadata shaped like the future capability manifest.
 * Selecting an item edits the request text; it never invokes a tool, commits a molecule, or starts a run.
 */
const composerCapabilities: readonly AgentComposerCapability[] = [
  {
    descriptionKey: 'chemsmart_studio.agent_workbench.discovery.current_molecule_description',
    id: 'reference.current-molecule',
    insertText: '@current-molecule',
    labelKey: 'chemsmart_studio.agent_workbench.discovery.current_molecule',
    trigger: '@'
  },
  {
    descriptionKey: 'chemsmart_studio.agent_workbench.discovery.draft_snapshot_description',
    id: 'attach.draft-snapshot',
    insertText: '+draft-snapshot',
    labelKey: 'chemsmart_studio.agent_workbench.discovery.draft_snapshot',
    trigger: '+'
  },
  {
    descriptionKey: 'chemsmart_studio.agent_workbench.discovery.inspect_description',
    id: 'command.inspect',
    insertText: '/inspect',
    labelKey: 'chemsmart_studio.agent_workbench.discovery.inspect',
    trigger: '/'
  },
  {
    descriptionKey: 'chemsmart_studio.agent_workbench.discovery.preflight_description',
    id: 'command.xtb-preflight',
    insertText: '/xtb-preflight',
    labelKey: 'chemsmart_studio.agent_workbench.discovery.preflight',
    trigger: '/'
  }
] as const

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
  artifacts: readonly AgentWorkbenchArtifact[]
  available: boolean
  busy: boolean
  composer: AgentComposerSnapshot
  failed: boolean
  pendingDecisionCount: number
  reviewRequestId: number
  requests: readonly AgentConversationRequest[]
  reviewContent: ReactNode
  threadTitle: string
  traceEvents: readonly StudioAgentTraceEvent[]
  onClose: () => void
  onComposerChange: (snapshot: AgentComposerSnapshot) => void
  onOpenProperties: () => void
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
  artifacts,
  available,
  busy,
  composer,
  failed,
  pendingDecisionCount,
  reviewRequestId,
  requests,
  reviewContent,
  threadTitle,
  traceEvents,
  onClose,
  onComposerChange,
  onOpenProperties,
  onSubmit
}: ChemSmartAgentPaneProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<ComponentRef<typeof Textarea.Input>>(null)
  const reviewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [reviewArtifactId, setReviewArtifactId] = useState<string | null>(null)
  const [reviewMode, setReviewMode] = useState<'artifact' | 'decisions' | 'history' | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const discovery = useMemo(
    () => findDiscovery(composer.value, composer.selectionStart),
    [composer.selectionStart, composer.value]
  )
  const suggestions = useMemo(() => {
    if (!discovery) return []
    return composerCapabilities.filter(
      (capability) =>
        capability.trigger === discovery.trigger &&
        (capability.insertText.toLocaleLowerCase().includes(discovery.query) ||
          t(capability.labelKey).toLocaleLowerCase().includes(discovery.query))
    )
  }, [discovery, t])
  const selectedArtifact = artifacts.find((artifact) => artifact.id === reviewArtifactId) ?? null
  const reviewOpen = reviewMode !== null

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

  const updateComposer = useCallback(
    (element: HTMLTextAreaElement) => onComposerChange(snapshotFromTextarea(element)),
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
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [composer, discovery, onComposerChange]
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
        <Tooltip content={t('chemsmart_studio.agent_workbench.new_unavailable')}>
          <span>
            <Button
              aria-label={t('chemsmart_studio.agent_workbench.new')}
              className="size-8"
              disabled
              size="icon-sm"
              variant="ghost">
              <FilePlus2 aria-hidden className="size-4" />
            </Button>
          </span>
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

      <Scrollbar className="min-h-0 flex-1" data-testid="agent-conversation">
        <div className="space-y-3 p-3">
          {requests.length === 0 && traceEvents.length === 0 ? (
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
            <AgentTraceTimeline events={traceEvents} requests={requests} />
          )}

          {artifacts.length > 0 ? (
            <section aria-labelledby="chemsmart-agent-artifacts-title" className="space-y-2">
              <h3 className="font-medium text-foreground-secondary text-xs" id="chemsmart-agent-artifacts-title">
                {t('chemsmart_studio.agent_workbench.artifacts')}
              </h3>
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
        {suggestions.length > 0 ? (
          <div
            aria-label={t('chemsmart_studio.agent_workbench.discovery.label')}
            className="absolute right-3 bottom-full left-3 z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
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
                  key={capability.id}
                  role="option"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(capability)}>
                  <Icon aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground text-sm">{t(capability.labelKey)}</span>
                    <span className="block truncate text-foreground-muted text-xs">{t(capability.descriptionKey)}</span>
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
          aria-describedby="chemsmart-agent-composer-help"
          disabled={busy}
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
                const cursor = event.currentTarget.selectionStart
                const next = `${composer.value.slice(0, cursor)} ${composer.value.slice(cursor)}`
                onComposerChange({
                  selectionEnd: cursor + 1,
                  selectionStart: cursor + 1,
                  scrollTop: event.currentTarget.scrollTop,
                  value: next
                })
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
          <Button
            aria-label={t('chemsmart_studio.workspace.send_agent_request')}
            className="size-8 shrink-0"
            disabled={!available || composer.value.trim().length === 0}
            loading={busy}
            size="icon-sm"
            type="submit">
            <ArrowUp aria-hidden className="size-4" />
          </Button>
        </div>
      </form>

      <Drawer
        direction="right"
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
                requests.length === 0 && traceEvents.length === 0 ? (
                  <p className="text-foreground-muted text-sm">{t('chemsmart_studio.agent_workbench.history_empty')}</p>
                ) : (
                  <AgentTraceTimeline events={traceEvents} requests={requests} />
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
