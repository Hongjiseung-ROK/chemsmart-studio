import type { StudioAgentTraceEvent, StudioUiEvent } from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Scrollbar, Textarea } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { useDefaultModel } from '@renderer/hooks/useModel'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { isMac } from '@renderer/utils/platform'
import type { UniqueModelId } from '@shared/data/types/model'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type {
  ChemSmartStudioControlSnapshot,
  ChemSmartStudioMoleculeSummary,
  ChemSmartStudioOpenDocuments,
  ChemSmartStudioProcessState,
  ChemSmartStudioProcessStatus,
  ChemSmartStudioReplayCatalog,
  ChemSmartStudioReplaySelection,
  ChemSmartStudioReplayTimeline
} from '@shared/ipc/schemas/chemsmartStudio'
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  Circle,
  LoaderCircle,
  MoreHorizontal,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  TriangleAlert
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'

import chemSmartLogo from '../../../../build/logo.png'
import { type AgentMode, AgentModeSwitch } from './AgentModeSwitch'
import { AgentTraceTimeline } from './AgentTraceTimeline'
import { AllowNoticeDialog } from './AllowNoticeDialog'
import { CommandConsole } from './CommandConsole'
import { InspectorPanel, type InspectorTab } from './InspectorPanel'
import { MoleculeDraftReviewDialog } from './MoleculeDraftReviewDialog'
import { MoleculeInspector } from './MoleculeInspector'
import { MoleculeStage } from './MoleculeStage'
import { MoleculeTabs } from './MoleculeTabs'
import { ResearchRail } from './ResearchRail'
import { StudioActivityBar } from './StudioActivityBar'
import { StudioCommandPalette } from './StudioCommandPalette'
import {
  EngineName,
  ExecutionApprovalSummary,
  isHighRiskApproval,
  type OptimizationReplayViewState,
  StudioControlSections,
  StudioDecisionList,
  SummaryField
} from './StudioControlSections'
import {
  defaultStudioRelativeLayout,
  isBottomPane,
  isInspectorPane,
  resolvePanePresentation,
  type StudioPaneId
} from './studioLayout'
import { StudioSettingsSheet } from './StudioSettingsSheet'
import { StudioToolkitMenu } from './StudioToolkitMenu'
import { StudioUiEventItem } from './StudioUiEventItem'
import { useAgentTouch } from './useAgentTouch'
import { useContainerTier } from './useContainerTier'
import { useMoleculeDocument } from './useMoleculeDocument'
import { useStudioPaneIntent } from './useStudioPaneIntent'
import { useWorkbenchMode, type WorkbenchMode, workbenchModes } from './useWorkbenchMode'
import { type WorkbenchTab, WorkbenchTabs } from './WorkbenchTabs'
import { WorkspaceDock } from './WorkspaceDock'

const logger = loggerService.withContext('ChemSmartWorkspace')
const MAX_ACTIVITY_EVENTS = 100
const MAX_AGENT_TRACE_EVENTS = 200
const REPLAY_CATALOG_LIMIT = 50
const REPLAY_TIMELINE_LIMIT = 500
const REPLAY_STEP_DELAY_MS = 700

type DisplayProcessState = ChemSmartStudioProcessState | 'loading'
type WorkspaceAction = 'activate_document' | 'import_molecule' | 'open_project' | 'save_as' | null
type ControlActionFailure = 'generic' | 'revision_conflict' | 'schema_invalid'
type StudioProblemKind = 'control' | 'replay' | 'status' | 'workspace'
type DraftReviewRequest =
  | { context: 'close' }
  | { context: 'run' }
  | { action: 'save_as'; context: 'save' }
  | { action: 'import_molecule' | 'open_project'; context: 'switch' }
  | { context: 'switch'; projectId: string }

const projectActionRoutes = {
  import_molecule: 'chemsmart_studio.editor.import_molecule',
  open_project: 'chemsmart_studio.editor.open_project',
  save_as: 'chemsmart_studio.editor.save_as'
} as const

const statePresentation = {
  loading: { Icon: LoaderCircle, className: 'text-info', animate: true },
  stopped: { Icon: Circle, className: 'text-foreground-muted', animate: false },
  starting: { Icon: LoaderCircle, className: 'text-info', animate: true },
  running: { Icon: CheckCircle2, className: 'text-success', animate: false },
  stopping: { Icon: LoaderCircle, className: 'text-warning', animate: true },
  failed: { Icon: TriangleAlert, className: 'text-destructive', animate: false }
} satisfies Record<
  DisplayProcessState,
  { Icon: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>; className: string; animate: boolean }
>

const stateTranslationKeys = {
  loading: 'chemsmart_studio.state.loading',
  stopped: 'chemsmart_studio.state.stopped',
  starting: 'chemsmart_studio.state.starting',
  running: 'chemsmart_studio.state.running',
  stopping: 'chemsmart_studio.state.stopping',
  failed: 'chemsmart_studio.state.failed'
} as const

const problemTranslationKeys = {
  control: 'chemsmart_studio.ide.problems.control',
  replay: 'chemsmart_studio.ide.problems.replay',
  status: 'chemsmart_studio.ide.problems.status',
  workspace: 'chemsmart_studio.ide.problems.workspace'
} as const

function mergeActivity(current: readonly StudioUiEvent[], event: StudioUiEvent): StudioUiEvent[] {
  if (current.some((item) => item.eventId === event.eventId || item.sequence === event.sequence)) return [...current]

  return [...current, event].sort((left, right) => left.sequence - right.sequence).slice(-MAX_ACTIVITY_EVENTS)
}

function mergeAgentTrace(
  current: readonly StudioAgentTraceEvent[],
  event: StudioAgentTraceEvent
): StudioAgentTraceEvent[] {
  if (current.some((item) => item.eventId === event.eventId || item.sequence === event.sequence)) return [...current]

  return [...current, event].sort((left, right) => left.sequence - right.sequence).slice(-MAX_AGENT_TRACE_EVENTS)
}

function classifyControlActionFailure(error: unknown): ControlActionFailure {
  if (!(error instanceof IpcError)) return 'generic'
  if (error.code === chemsmartStudioErrorCodes.REVISION_CONFLICT) return 'revision_conflict'
  if (error.code === chemsmartStudioErrorCodes.SCHEMA_INVALID) return 'schema_invalid'
  return 'generic'
}

function ProcessHealth({
  icon: ProcessIcon,
  label,
  status
}: {
  icon: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  label: string
  status: ChemSmartStudioProcessStatus | null
}) {
  const { t } = useTranslation()
  const state: DisplayProcessState = status?.state ?? 'loading'
  const { Icon, animate, className } = statePresentation[state]

  return (
    <div className="flex min-h-9 items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 font-medium text-foreground text-sm">
        <ProcessIcon aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
        <span className="truncate">{label}</span>
      </span>
      <Badge className="gap-1.5 border-transparent bg-secondary text-secondary-foreground" variant="secondary">
        <Icon aria-hidden className={cn('size-3.5', className, animate && 'animate-spin motion-reduce:animate-none')} />
        {t(stateTranslationKeys[state])}
      </Badge>
    </div>
  )
}

interface ChemSmartWorkspaceProps {
  active: boolean
  sessionId: string
}

export function ChemSmartWorkspace({ active, sessionId }: ChemSmartWorkspaceProps) {
  const { t } = useTranslation()
  const { defaultModel } = useDefaultModel()
  const workspaceRef = useRef<HTMLElement>(null)
  const tier = useContainerTier(workspaceRef)
  const [explorerOpen, setExplorerOpen] = useState(true)
  const inspectorPane = useStudioPaneIntent(true, defaultStudioRelativeLayout.horizontal.inspector)
  const bottomPane = useStudioPaneIntent(false, defaultStudioRelativeLayout.vertical.bottom)
  const setInspectorOpen = inspectorPane.setOpen
  const setBottomOpen = bottomPane.setOpen
  const [bottomTab, setBottomTab] = useState<WorkbenchTab>('console')
  const [consoleDraft, setConsoleDraft] = useState('')
  const molecule = useMoleculeDocument(sessionId, active)
  const [draftReview, setDraftReview] = useState<DraftReviewRequest | null>(null)
  const [draftReviewBusy, setDraftReviewBusy] = useState(false)
  const [sheetPane, setSheetPane] = useState<StudioPaneId | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('agent')
  /**
   * One place decides what "the workbench is open" means, so the header toggle, a mode that needs it, and a
   * panel the researcher dragged all land in the same state.
   */
  const applyBottomOpen = useCallback((open: boolean) => setBottomOpen(open), [setBottomOpen])
  const revealCommandWorkbench = useCallback(() => {
    setBottomTab('jobs')
    bottomPane.activate()
    if (tier === 'viewport-only') setSheetPane('jobs')
  }, [bottomPane, tier])
  const selectInspectorForMode = useCallback(
    (tab: InspectorTab) => {
      setInspectorTab(tab)
      if (tab !== 'properties') return
      inspectorPane.activate()
      if (tier === 'viewport-only') setSheetPane('properties')
    },
    [inspectorPane, tier]
  )
  const {
    contract: modeContract,
    mode: workbenchMode,
    setMode: setWorkbenchMode
  } = useWorkbenchMode({
    onRevealCommandWorkbench: revealCommandWorkbench,
    onSelectInspectorTab: selectInspectorForMode
  })
  const requestWorkbenchModeChange = useCallback(
    (next: WorkbenchMode) => {
      if (next === 'run' && molecule.draft?.dirty) {
        setDraftReview({ context: 'run' })
        return
      }
      setWorkbenchMode(next)
    },
    [molecule.draft?.dirty, setWorkbenchMode]
  )
  useHotkeys(
    workbenchModes.map((_, index) => `mod+${index + 1}`),
    (event) => {
      const next = workbenchModes[Number(event.key) - 1]
      if (next) requestWorkbenchModeChange(next)
    },
    { enabled: active, preventDefault: true },
    [active, requestWorkbenchModeChange]
  )
  const [dismissedNotices, setDismissedNotices] = useState<readonly string[]>([])
  const [agentStatus, setAgentStatus] = useState<ChemSmartStudioProcessStatus | null>(null)
  const [deterministicModelId, setDeterministicModelId] = useState<UniqueModelId | null>(null)
  const activeModelId = deterministicModelId ?? defaultModel?.id ?? null
  const [agentRequest, setAgentRequest] = useState('')
  const [agentTurnBusy, setAgentTurnBusy] = useState(false)
  const [agentTurnFailed, setAgentTurnFailed] = useState(false)
  const [moleculeSummary, setMoleculeSummary] = useState<ChemSmartStudioMoleculeSummary | null>(null)
  const [documentName, setDocumentName] = useState<string | null>(null)
  const [activity, setActivity] = useState<StudioUiEvent[]>([])
  const [agentTrace, setAgentTrace] = useState<StudioAgentTraceEvent[]>([])
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusFailed, setStatusFailed] = useState(false)
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceAction>(null)
  const [workspaceActionFailed, setWorkspaceActionFailed] = useState(false)
  const [problems, setProblems] = useState<StudioProblemKind[]>([])
  const [openDocuments, setOpenDocuments] = useState<ChemSmartStudioOpenDocuments | null>(null)
  // Allow is the default and the safe one: main reads an unset session the same way.
  const [agentMode, setAgentMode] = useState<AgentMode>('allow')
  const [agentModeBusy, setAgentModeBusy] = useState(false)
  const [controlSnapshot, setControlSnapshot] = useState<ChemSmartStudioControlSnapshot | null>(null)
  const [controlLoading, setControlLoading] = useState(true)
  const [controlFailed, setControlFailed] = useState(false)
  const [controlActionId, setControlActionId] = useState<string | null>(null)
  const [controlActionFailure, setControlActionFailure] = useState<ControlActionFailure | null>(null)
  const [replayCatalog, setReplayCatalog] = useState<ChemSmartStudioReplayCatalog | null>(null)
  const [replayTimeline, setReplayTimeline] = useState<ChemSmartStudioReplayTimeline | null>(null)
  const [replaySelection, setReplaySelection] = useState<ChemSmartStudioReplaySelection | null>(null)
  const [replaySelectedRunId, setReplaySelectedRunId] = useState<string | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayFailed, setReplayFailed] = useState(false)
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const activityRef = useRef<StudioUiEvent[]>([])
  const statusRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)
  const controlRequestRef = useRef(0)
  const controlActionRef = useRef<string | null>(null)
  const replayRequestRef = useRef(0)
  const replaySelectionRef = useRef<ChemSmartStudioReplaySelection | null>(null)
  const replaySelectedRunRef = useRef<string | null>(null)
  const replayBusyRef = useRef(false)
  const allowWindowCloseRef = useRef(false)
  const activeRef = useRef(active)
  const currentSessionRef = useRef(sessionId)
  const agentEventVersionRef = useRef(0)
  currentSessionRef.current = sessionId
  activeRef.current = active
  replaySelectionRef.current = replaySelection
  replaySelectedRunRef.current = replaySelectedRunId

  const recordProblem = useCallback((problem: StudioProblemKind) => {
    setProblems((current) => (current.includes(problem) ? current : [...current, problem]))
  }, [])

  const refreshMoleculeSummary = useCallback(async () => {
    const requestId = ++summaryRequestRef.current
    try {
      const summary = await ipcApi.request('chemsmart_studio.molecule.summary')
      if (summaryRequestRef.current === requestId) setMoleculeSummary(summary)
    } catch (error) {
      if (summaryRequestRef.current === requestId) setMoleculeSummary(null)
      if (error instanceof IpcError && error.code === chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE) return
      logger.error('Failed to load the molecule summary', error as Error)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current
    const agentEventVersion = agentEventVersionRef.current
    setStatusLoading(true)
    setStatusFailed(false)

    try {
      const [status, runtimeContext] = await Promise.all([
        ipcApi.request('chemsmart_studio.status'),
        ipcApi.request('chemsmart_studio.agent.runtime_context').catch(() => ({ deterministicModelId: null }))
      ])
      if (statusRequestRef.current !== requestId) return

      void refreshMoleculeSummary()
      if (agentEventVersionRef.current === agentEventVersion) setAgentStatus(status.agent)
      setDeterministicModelId(runtimeContext.deterministicModelId)
    } catch (error) {
      if (statusRequestRef.current !== requestId) return
      setStatusFailed(true)
      recordProblem('status')
      logger.error('Failed to load ChemSmart Studio status', error as Error)
    } finally {
      if (statusRequestRef.current === requestId) setStatusLoading(false)
    }
  }, [recordProblem, refreshMoleculeSummary])

  const runAgentTurn = useCallback(async () => {
    const request = agentRequest.trim()
    const modelId = activeModelId
    if (!request || !modelId || agentTurnBusy) return

    setAgentTurnBusy(true)
    setAgentTurnFailed(false)
    try {
      await ipcApi.request('chemsmart_studio.agent.run_turn', { sessionId, modelId, request })
      setAgentRequest('')
    } catch (error) {
      setAgentTurnFailed(true)
      logger.error('ChemSmart Agent turn failed', error as Error)
    } finally {
      setAgentTurnBusy(false)
    }
  }, [activeModelId, agentRequest, agentTurnBusy, sessionId])

  const refreshControlSnapshot = useCallback(async () => {
    const requestId = ++controlRequestRef.current
    setControlLoading(true)
    setControlFailed(false)
    setControlActionFailure(null)
    setReplayCatalog(null)
    setReplayTimeline(null)
    setReplaySelection(null)
    setReplaySelectedRunId(null)
    setReplayLoading(false)
    setReplayFailed(false)
    setReplayBusy(false)
    setReplayPlaying(false)

    try {
      const snapshot = await ipcApi.request('chemsmart_studio.control.snapshot', { sessionId })
      if (controlRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
      setControlSnapshot(snapshot)
    } catch (error) {
      if (controlRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
      setControlFailed(true)
      recordProblem('control')
      logger.error('Failed to load trusted Studio controls', error as Error)
    } finally {
      if (controlRequestRef.current === requestId && currentSessionRef.current === sessionId) setControlLoading(false)
    }
  }, [recordProblem, sessionId])

  const loadReplayTimeline = useCallback(
    async (runId: string, requestId = ++replayRequestRef.current) => {
      setReplayLoading(true)
      setReplayFailed(false)
      try {
        const timeline = await ipcApi.request('chemsmart_studio.optimization.replay_timeline', {
          sessionId,
          runId,
          offset: 0,
          limit: REPLAY_TIMELINE_LIMIT
        })
        if (replayRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
        setReplayTimeline(timeline)
      } catch (error) {
        if (replayRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
        setReplayFailed(true)
        recordProblem('replay')
        logger.error('Failed to load the optimization replay timeline', error as Error)
      } finally {
        if (replayRequestRef.current === requestId && currentSessionRef.current === sessionId) setReplayLoading(false)
      }
    },
    [recordProblem, sessionId]
  )

  const refreshReplay = useCallback(async () => {
    const requestId = ++replayRequestRef.current
    setReplayLoading(true)
    setReplayFailed(false)
    try {
      const catalog = await ipcApi.request('chemsmart_studio.optimization.replay_catalog', {
        sessionId,
        afterRunId: null,
        limit: REPLAY_CATALOG_LIMIT
      })
      if (replayRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
      setReplayCatalog(catalog)
      const replayable = catalog.runs.filter((record) => record.replayable && record.frameCount > 0)
      const selected =
        replayable.find((record) => record.run.runId === replaySelectedRunRef.current) ?? replayable.at(0) ?? null
      const runId = selected?.run.runId ?? null
      setReplaySelectedRunId(runId)
      replaySelectedRunRef.current = runId
      if (!runId) {
        setReplayTimeline(null)
        setReplaySelection(null)
        return
      }
      await loadReplayTimeline(runId, requestId)
    } catch (error) {
      if (replayRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
      setReplayFailed(true)
      recordProblem('replay')
      logger.error('Failed to load optimization replay', error as Error)
    } finally {
      if (replayRequestRef.current === requestId && currentSessionRef.current === sessionId) setReplayLoading(false)
    }
  }, [loadReplayTimeline, recordProblem, sessionId])

  useIpcOn('chemsmart_studio.agent.state_changed', (status) => {
    agentEventVersionRef.current += 1
    setAgentStatus(status)
    if (status.state === 'failed') logger.warn('The ChemSmart agent reported a failed state')
  })

  useIpcOn('chemsmart_studio.agent.trace', (event) => {
    if (event.sessionId !== sessionId) return
    setAgentTrace((current) => mergeAgentTrace(current, event))
  })

  useIpcOn('chemsmart_studio.molecule.changed', (summary) => {
    setMoleculeSummary(summary)
  })

  useIpcOn('chemsmart_studio.control.changed', (event) => {
    if (event.sessionId !== sessionId) return
    void refreshControlSnapshot()
  })

  useIpcOn('chemsmart_studio.optimization.replay_changed', (event) => {
    if (event.sessionId !== sessionId) return
    replaySelectionRef.current = event.selection
    setReplaySelection(event.selection)
    if (!event.selection.viewing) setReplayPlaying(false)
  })

  useIpcOn('chemsmart_studio.studio_ui.event', (event) => {
    if (event.sessionId !== sessionId) return
    setActivity((current) => {
      const next = mergeActivity(current, event)
      activityRef.current = next
      return next
    })
  })

  const changeAgentMode = useCallback(
    (mode: AgentMode) => {
      setAgentModeBusy(true)
      void ipcApi
        .request('chemsmart_studio.agent.set_mode', { sessionId, mode })
        .then((result) => setAgentMode(result.mode))
        .catch((error) => {
          // The mode main holds is the one that governs approvals, so a failed switch must leave the
          // control showing what main still believes rather than what the researcher clicked.
          logger.error('Failed to change the ChemSmart agent mode', error as Error)
        })
        .finally(() => setAgentModeBusy(false))
    },
    [sessionId]
  )

  const refreshOpenDocuments = useCallback(async () => {
    try {
      setOpenDocuments(await ipcApi.request('chemsmart_studio.editor.open_documents'))
    } catch (error) {
      // The tab strip is navigation, not authority: losing it must not disturb the open molecule.
      logger.error('Failed to list the open ChemSmart Studio projects', error as Error)
    }
  }, [])

  useEffect(() => {
    activityRef.current = []
    setActivity([])
    setAgentTrace([])
    setAgentStatus(null)
    setMoleculeSummary(null)
    setDocumentName(null)
    setWorkspaceAction(null)
    setWorkspaceActionFailed(false)
    setProblems([])
    // A session grant belongs to the session that granted it; a new topic starts by asking again.
    setAgentMode('allow')
    setAgentModeBusy(false)
    setControlSnapshot(null)
    setControlLoading(true)
    setControlFailed(false)
    setControlActionId(null)
    setControlActionFailure(null)
    controlActionRef.current = null
    agentEventVersionRef.current = 0
    void refreshStatus()
    void refreshControlSnapshot()
    void refreshOpenDocuments()

    return () => {
      statusRequestRef.current += 1
      summaryRequestRef.current += 1
      controlRequestRef.current += 1
      replayRequestRef.current += 1
      if (replaySelectionRef.current?.viewing) {
        void ipcApi
          .request('chemsmart_studio.optimization.stop_replay', { sessionId })
          .catch((error) => logger.error('Failed to release optimization replay', error as Error))
      }
    }
  }, [refreshControlSnapshot, refreshOpenDocuments, refreshStatus, sessionId])

  useEffect(() => {
    if (!active || !molecule.draft?.dirty) return

    const reviewBeforeClose = (event: BeforeUnloadEvent) => {
      if (allowWindowCloseRef.current) return
      event.preventDefault()
      event.returnValue = ''
      setDraftReview((current) => current ?? { context: 'close' })
    }

    window.addEventListener('beforeunload', reviewBeforeClose)
    return () => window.removeEventListener('beforeunload', reviewBeforeClose)
  }, [active, molecule.draft?.dirty])

  useEffect(() => {
    if (!active || agentStatus?.state !== 'running') return

    const afterSequence = activityRef.current.at(-1)?.sequence ?? -1
    void ipcApi
      .request('chemsmart_studio.agent.replay_studio_ui', { sessionId, afterSequence })
      .catch((error) => logger.error('Failed to replay ChemSmart Studio activity', error as Error))
  }, [active, agentStatus?.state, sessionId])

  const executeWorkspaceAction = useCallback(
    async (action: Exclude<WorkspaceAction, 'activate_document' | null>) => {
      setWorkspaceAction(action)
      setWorkspaceActionFailed(false)
      try {
        const result = await ipcApi.request(projectActionRoutes[action])
        setMoleculeSummary(result.molecule)
        setDocumentName(result.documentName)
        // A project that opened is a project that earned a tab.
        if (!result.canceled) void refreshOpenDocuments()
      } catch (error) {
        setWorkspaceActionFailed(true)
        recordProblem('workspace')
        logger.error(`Failed to ${action} in the molecule workspace`, error as Error)
      } finally {
        setWorkspaceAction(null)
      }
    },
    [recordProblem, refreshOpenDocuments]
  )

  const runWorkspaceAction = useCallback(
    (action: Exclude<WorkspaceAction, 'activate_document' | null>) => {
      if (molecule.draft?.dirty) {
        setDraftReview(action === 'save_as' ? { action, context: 'save' } : { action, context: 'switch' })
        return
      }
      void executeWorkspaceAction(action)
    },
    [executeWorkspaceAction, molecule.draft?.dirty]
  )

  const executeActivateDocument = useCallback(
    async (projectId: string) => {
      setWorkspaceAction('activate_document')
      setWorkspaceActionFailed(false)
      try {
        const result = await ipcApi.request('chemsmart_studio.editor.activate_document', { projectId })
        setMoleculeSummary(result.molecule)
        setDocumentName(result.documentName)
        await refreshOpenDocuments()
      } catch (error) {
        setWorkspaceActionFailed(true)
        recordProblem('workspace')
        logger.error('Failed to switch the active ChemSmart Studio project', error as Error)
      } finally {
        setWorkspaceAction(null)
      }
    },
    [recordProblem, refreshOpenDocuments]
  )

  const activateDocument = useCallback(
    (projectId: string) => {
      if (molecule.draft?.dirty) {
        setDraftReview({ context: 'switch', projectId })
        return
      }
      void executeActivateDocument(projectId)
    },
    [executeActivateDocument, molecule.draft?.dirty]
  )

  const continueDraftReview = useCallback(
    async (decision: 'apply' | 'discard') => {
      const request = draftReview
      if (!request || draftReviewBusy) return
      setDraftReviewBusy(true)
      try {
        const document = decision === 'apply' ? await molecule.commitDraft() : await molecule.discardDraft()
        if (!document) return
        setMoleculeSummary({ documentId: document.documentId, revision: document.revision })
        setDraftReview(null)

        if (request.context === 'close') {
          allowWindowCloseRef.current = true
          try {
            await ipcApi.request('window.close')
          } catch (error) {
            allowWindowCloseRef.current = false
            logger.error(
              'Failed to close the ChemSmart Studio window after resolving its molecule draft',
              error as Error
            )
          }
          return
        }

        // Save and Run deliberately stop after Discard: their three-way contracts say
        // "Discard Draft" and "Discard & Cancel Run", not "discard and continue".
        if (decision === 'discard' && (request.context === 'save' || request.context === 'run')) return
        if (request.context === 'run') {
          setWorkbenchMode('run')
          setBottomTab('jobs')
          bottomPane.activate()
          if (tier === 'viewport-only') setSheetPane('jobs')
        } else if ('projectId' in request) {
          await executeActivateDocument(request.projectId)
        } else {
          await executeWorkspaceAction(request.action)
        }
      } finally {
        setDraftReviewBusy(false)
      }
    },
    [
      bottomPane,
      draftReview,
      draftReviewBusy,
      executeActivateDocument,
      executeWorkspaceAction,
      molecule,
      setWorkbenchMode,
      tier
    ]
  )

  const performControlAction = useCallback(
    async (actionId: string) => {
      if (controlActionRef.current !== null) return

      const requestId = ++controlRequestRef.current
      controlActionRef.current = actionId
      setControlActionId(actionId)
      setControlActionFailure(null)
      try {
        const snapshot = await ipcApi.request('chemsmart_studio.control.perform_action', { sessionId, actionId })
        if (controlRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
        setControlSnapshot(snapshot)
        setControlFailed(false)
      } catch (error) {
        if (controlRequestRef.current !== requestId || currentSessionRef.current !== sessionId) return
        setControlActionFailure(classifyControlActionFailure(error))
        recordProblem('control')
        logger.error('Failed to perform the trusted Studio action', error as Error)
      } finally {
        if (currentSessionRef.current === sessionId && controlActionRef.current === actionId) {
          controlActionRef.current = null
          setControlActionId(null)
        }
      }
    },
    [recordProblem, sessionId]
  )

  const selectReplayFrame = useCallback(
    async (stepIndex: number): Promise<boolean> => {
      const runId = replaySelectedRunRef.current
      if (!runId || replayBusyRef.current) return false
      replayBusyRef.current = true
      setReplayBusy(true)
      setReplayFailed(false)
      try {
        const selection = await ipcApi.request('chemsmart_studio.optimization.replay_frame', {
          sessionId,
          runId,
          stepIndex
        })
        if (currentSessionRef.current !== sessionId || replaySelectedRunRef.current !== runId) return false
        if (!activeRef.current) {
          const stopped = await ipcApi.request('chemsmart_studio.optimization.stop_replay', { sessionId })
          if (currentSessionRef.current === sessionId) {
            replaySelectionRef.current = stopped
            setReplaySelection(stopped)
          }
          return false
        }
        replaySelectionRef.current = selection
        setReplaySelection(selection)
        return true
      } catch (error) {
        if (currentSessionRef.current !== sessionId) return false
        setReplayFailed(true)
        recordProblem('replay')
        setReplayPlaying(false)
        logger.error('Failed to select an optimization replay frame', error as Error)
        return false
      } finally {
        replayBusyRef.current = false
        if (currentSessionRef.current === sessionId) setReplayBusy(false)
      }
    },
    [recordProblem, sessionId]
  )

  const stopReplay = useCallback(async () => {
    if (!replaySelectionRef.current?.viewing || replayBusyRef.current) return
    replayBusyRef.current = true
    setReplayBusy(true)
    setReplayPlaying(false)
    try {
      const selection = await ipcApi.request('chemsmart_studio.optimization.stop_replay', { sessionId })
      if (currentSessionRef.current !== sessionId) return
      replaySelectionRef.current = selection
      setReplaySelection(selection)
    } catch (error) {
      if (currentSessionRef.current !== sessionId) return
      setReplayFailed(true)
      recordProblem('replay')
      logger.error('Failed to stop optimization replay', error as Error)
    } finally {
      replayBusyRef.current = false
      if (currentSessionRef.current === sessionId) setReplayBusy(false)
    }
  }, [recordProblem, sessionId])

  const changeReplayRun = useCallback(
    async (runId: string) => {
      setReplayPlaying(false)
      if (replaySelectionRef.current?.viewing) await stopReplay()
      replaySelectedRunRef.current = runId
      setReplaySelectedRunId(runId)
      replaySelectionRef.current = null
      setReplaySelection(null)
      void loadReplayTimeline(runId)
    },
    [loadReplayTimeline, stopReplay]
  )

  useEffect(() => {
    if (!active || moleculeSummary === null || replayCatalog !== null || replayLoading) return
    void refreshReplay()
  }, [active, moleculeSummary, refreshReplay, replayCatalog, replayLoading])

  useEffect(() => {
    if (active) return
    setReplayPlaying(false)
    if (replaySelectionRef.current?.viewing) void stopReplay()
  }, [active, stopReplay])

  const selectedReplayRecord = replayCatalog?.runs.find((record) => record.run.runId === replaySelectedRunId) ?? null
  const selectedReplayStep =
    replaySelection?.runId === replaySelectedRunId
      ? replaySelection.stepIndex
      : replayTimeline?.runId === replaySelectedRunId
        ? (replayTimeline.frames.at(0)?.stepIndex ?? selectedReplayRecord?.latestFrame?.stepIndex ?? null)
        : (selectedReplayRecord?.latestFrame?.stepIndex ?? null)

  const playReplay = useCallback(async () => {
    if (selectedReplayStep === null) return
    if (!replaySelectionRef.current?.viewing && !(await selectReplayFrame(selectedReplayStep))) return
    setReplayPlaying(true)
  }, [selectReplayFrame, selectedReplayStep])

  useEffect(() => {
    if (!active || !replayPlaying || selectedReplayStep === null || !selectedReplayRecord) return
    if (selectedReplayStep + 1 >= selectedReplayRecord.frameCount) {
      setReplayPlaying(false)
      return
    }
    const timeout = window.setTimeout(() => {
      void selectReplayFrame(selectedReplayStep + 1)
    }, REPLAY_STEP_DELAY_MS)
    return () => window.clearTimeout(timeout)
  }, [active, replayPlaying, selectReplayFrame, selectedReplayRecord, selectedReplayStep])

  const projectSwitchBlocked =
    controlSnapshot?.optimization?.run.status === 'running' ||
    controlSnapshot?.optimization?.run.status === 'awaiting_final_geometry'
  const panelBusy = statusLoading || controlLoading || workspaceAction !== null || controlActionId !== null
  const replayView: OptimizationReplayViewState = {
    available: moleculeSummary !== null,
    busy: replayBusy,
    catalog: replayCatalog,
    failed: replayFailed,
    loading: replayLoading,
    playing: replayPlaying,
    selectedRunId: replaySelectedRunId,
    selection: replaySelection,
    timeline: replayTimeline
  }
  const latestActivity = activity.at(-1) ?? null
  const visibleActivity = activity.filter((event) => event.kind !== 'agent_thought')
  const agentWorkflow = controlSnapshot?.agent ?? null
  const agentWorkflowActive =
    agentWorkflow !== null &&
    agentWorkflow.phase !== 'idle' &&
    agentWorkflow.phase !== 'completed' &&
    agentWorkflow.phase !== 'failed' &&
    agentWorkflow.phase !== 'recovering'
  const agentBadgeActive = agentWorkflow === null ? latestActivity !== null : agentWorkflowActive
  const approvalCount = controlSnapshot?.pendingApprovals.length ?? 0
  const activeRun = controlSnapshot?.optimization?.run ?? null
  const activeAgentModelId = deterministicModelId ?? defaultModel?.id ?? null
  const controlActionFailed = controlActionFailure !== null
  const controlActionFailureMessage =
    controlActionFailure === 'revision_conflict'
      ? t('chemsmart_studio.control.revision_conflict')
      : controlActionFailure === 'schema_invalid'
        ? t('chemsmart_studio.control.schema_invalid')
        : t('chemsmart_studio.control.action_failed')
  const paneIntentRef = useRef({
    bottom: bottomPane.intent,
    bottomTab,
    inspector: inspectorPane.intent,
    inspectorTab
  })
  paneIntentRef.current = {
    bottom: bottomPane.intent,
    bottomTab,
    inspector: inspectorPane.intent,
    inspectorTab
  }
  const previousTierRef = useRef(tier)
  useEffect(() => {
    const previous = previousTierRef.current
    if (tier === 'viewport-only' && previous !== 'viewport-only') {
      const current = paneIntentRef.current
      if (current.bottom.open && current.bottom.lastActivatedAt > current.inspector.lastActivatedAt) {
        setSheetPane(current.bottomTab)
      } else if (current.inspector.open) {
        setSheetPane(current.inspectorTab)
      } else if (current.bottom.open) {
        setSheetPane(current.bottomTab)
      } else {
        setInspectorTab('agent')
        inspectorPane.activate()
        setSheetPane('agent')
      }
    } else if (previous === 'viewport-only' && tier !== 'viewport-only') {
      setSheetPane(null)
    }
    previousTierRef.current = tier
  }, [inspectorPane, tier])

  const openPane = useCallback(
    (pane: StudioPaneId) => {
      if (tier === 'viewport-only' || (tier === 'focused' && pane === 'explorer')) {
        if (isInspectorPane(pane)) {
          setInspectorTab(pane)
          inspectorPane.activate()
        }
        if (isBottomPane(pane)) {
          setBottomTab(pane)
          bottomPane.activate()
        }
        setSheetPane(pane)
        return
      }
      setSheetPane(null)
      if (pane === 'explorer') {
        setExplorerOpen(true)
        return
      }
      if (isInspectorPane(pane)) {
        setInspectorTab(pane)
        inspectorPane.activate()
        return
      }
      setBottomTab(pane)
      bottomPane.activate()
      if (pane === 'jobs') requestWorkbenchModeChange('run')
    },
    [bottomPane, inspectorPane, requestWorkbenchModeChange, tier]
  )
  const compact = tier === 'viewport-only'
  const inspectorPresentation = resolvePanePresentation({
    compact,
    intent: inspectorPane.intent,
    sheetActive: sheetPane !== null && isInspectorPane(sheetPane)
  })
  const bottomPresentation = resolvePanePresentation({
    compact,
    intent: bottomPane.intent,
    sheetActive: sheetPane !== null && isBottomPane(sheetPane)
  })
  const workspaceEditorMode =
    workbenchMode === 'run' || workbenchMode === 'replay' ? ('inspect' as const) : workbenchMode
  useEffect(() => {
    if (!active || controlLoading) return

    const panes: StudioPaneId[] = []
    if ((tier === 'wide' && explorerOpen) || sheetPane === 'explorer') panes.push('explorer')
    if (inspectorPresentation !== 'hidden') panes.push(inspectorTab)
    if (bottomPresentation !== 'hidden') panes.push(bottomTab)
    void ipcApi
      .request('chemsmart_studio.agent.update_workspace_view', {
        sessionId,
        view: { editorMode: workspaceEditorMode, panes }
      })
      .catch((error) => logger.error('Failed to update the path-free Agent workspace view', error as Error))
  }, [
    active,
    bottomPresentation,
    bottomTab,
    controlLoading,
    explorerOpen,
    inspectorPresentation,
    inspectorTab,
    sessionId,
    sheetPane,
    tier,
    workspaceEditorMode
  ])
  const activePane: StudioPaneId | null =
    sheetPane ??
    (inspectorPresentation === 'docked' ? inspectorTab : null) ??
    (bottomPresentation === 'docked' ? bottomTab : null) ??
    (tier === 'wide' && explorerOpen ? 'explorer' : null)
  const toggleInspector = useCallback(() => {
    if (tier === 'viewport-only') {
      if (sheetPane !== null && isInspectorPane(sheetPane)) {
        setSheetPane(null)
        setInspectorOpen(false)
      } else {
        inspectorPane.activate()
        setSheetPane(inspectorTab)
      }
      return
    }
    setInspectorOpen((open) => !open)
  }, [inspectorPane, inspectorTab, setInspectorOpen, sheetPane, tier])
  const toggleBottom = useCallback(() => {
    if (tier === 'viewport-only') {
      if (sheetPane !== null && isBottomPane(sheetPane)) {
        setSheetPane(null)
        setBottomOpen(false)
      } else {
        bottomPane.activate()
        setSheetPane(bottomTab)
      }
      return
    }
    setBottomOpen((open) => !open)
  }, [bottomPane, bottomTab, setBottomOpen, sheetPane, tier])
  useHotkeys(
    'mod+b',
    () => {
      if (tier === 'wide') setExplorerOpen((open) => !open)
      else openPane('explorer')
    },
    { enabled: active, preventDefault: true },
    [active, openPane, tier]
  )
  useHotkeys('mod+j', toggleBottom, { enabled: active, preventDefault: true }, [active, toggleBottom])
  useHotkeys('mod+shift+p', () => setPaletteOpen(true), { enabled: active, preventDefault: true }, [active])
  useHotkeys(
    'escape',
    () => {
      if (sheetPane !== null) {
        if (isInspectorPane(sheetPane)) setInspectorOpen(false)
        if (isBottomPane(sheetPane)) setBottomOpen(false)
      }
      setSheetPane(null)
      setSettingsOpen(false)
      setPaletteOpen(false)
    },
    { enabled: active },
    [active, setBottomOpen, setInspectorOpen, sheetPane]
  )
  // The molecule is owned by main, not by the helper process. It stays readable and editable when
  // the helper is stopped or has crashed — losing the structure because a renderer died was the
  // whole point of moving the authority.
  const agentTouch = useAgentTouch(activity)
  useEffect(() => {
    // The Agent's only way to move the interface is this declared target.
    if (agentTouch.tab) setInspectorTab(agentTouch.tab)
  }, [agentTouch.tab])
  const moleculeEditable = approvalCount === 0 && activeRun === null
  const moleculeSelectable = approvalCount === 0
  const finalGeometry = controlSnapshot?.optimization?.finalGeometry ?? null
  const pendingDecisionCount = approvalCount + (finalGeometry ? 1 : 0)
  // The highest-risk waiting decision is announced with a blocking notice; preview commits are not.
  const highRiskApproval = controlSnapshot?.pendingApprovals.find(isHighRiskApproval) ?? null
  const noticeId = highRiskApproval
    ? highRiskApproval.approvalId
    : finalGeometry
      ? `final-geometry:${activeRun?.runId ?? 'run'}:${finalGeometry.expectedRevision}`
      : null
  const noticeOpen = noticeId !== null && !dismissedNotices.includes(noticeId)
  const activeDocumentName =
    documentName ??
    openDocuments?.documents.find((document) => document.projectId === openDocuments.activeProjectId)?.projectName ??
    null
  // Only gates the trusted snapshot actually reports; model confidence is never one of them.
  const passedGates = [
    t('chemsmart_studio.approval.gate.schema'),
    ...(controlSnapshot?.activity ?? [])
      .filter((item) => item.status === 'passed' && (item.kind === 'intent_gate' || item.kind === 'semantic_gate'))
      .map((item) => t(`chemsmart_studio.trusted_activity.kind.${item.kind}`))
  ]
  const reviewDecisions = useCallback(() => openPane('decisions'), [openPane])
  const dismissNotice = useCallback(() => {
    setDismissedNotices((current) =>
      noticeId === null || current.includes(noticeId) ? current : [...current, noticeId]
    )
  }, [noticeId])
  const inspectorExpanded = inspectorPresentation !== 'hidden'
  const bottomExpanded = bottomPresentation !== 'hidden'
  const lastFocusedControlIdRef = useRef<string | null>(null)
  const activatePaneForTarget = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) return
      if (target.closest('#chemsmart-inspector')) {
        inspectorPane.activate()
      } else if (target.closest('#chemsmart-workbench')) {
        bottomPane.activate()
      }
    },
    [bottomPane, inspectorPane]
  )
  useLayoutEffect(() => {
    const controlId = lastFocusedControlIdRef.current
    if (!controlId || document.activeElement?.id === controlId) return
    document.getElementById(controlId)?.focus({ preventScroll: true })
  }, [sheetPane, tier])

  return (
    <section
      aria-busy={panelBusy || undefined}
      aria-labelledby="chemsmart-workspace-title"
      className="flex h-full min-h-0 flex-col bg-background text-[13px]"
      data-testid="chemsmart-workspace"
      data-tier={tier}
      ref={workspaceRef}
      onFocusCapture={(event) => {
        activatePaneForTarget(event.target)
        const target = event.target
        if (target instanceof HTMLElement && target.id) lastFocusedControlIdRef.current = target.id
      }}
      onPointerDownCapture={(event) => activatePaneForTarget(event.target)}>
      <header
        className={cn(
          'flex h-11 shrink-0 items-center justify-between gap-3 border-border border-b pr-3 [-webkit-app-region:drag]',
          isMac ? 'pl-[env(titlebar-area-x)]' : 'pl-3'
        )}>
        <div className="flex min-w-0 items-center gap-2">
          <img
            alt={t('chemsmart_studio.workspace.brand_logo')}
            className={cn(
              'h-7 w-auto shrink-0 rounded-sm bg-white object-contain p-0.5',
              tier === 'viewport-only' && 'hidden'
            )}
            src={chemSmartLogo}
          />
          <h1 id="chemsmart-workspace-title" className="shrink-0 truncate font-semibold text-foreground text-sm">
            {t('chemsmart_studio.title')}
          </h1>
          <span aria-hidden className="text-foreground-muted">
            /
          </span>
          <span className="min-w-0 truncate font-medium text-foreground-secondary text-sm">
            {activeDocumentName ?? t('chemsmart_studio.workspace.no_molecule')}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          <dl
            aria-label={t('chemsmart_studio.workspace.status_strip')}
            className="flex min-w-0 items-center gap-1.5 text-xs">
            <div>
              <dt className="sr-only">{t('chemsmart_studio.document.revision')}</dt>
              <dd className="whitespace-nowrap text-foreground-secondary">
                {t('chemsmart_studio.workspace.revision_value', {
                  revision: moleculeSummary?.revision ?? t('chemsmart_studio.document.unavailable')
                })}
              </dd>
            </div>
            {tier === 'viewport-only' ? null : (
              <Badge variant={activeRun?.status === 'failed' ? 'destructive' : 'outline'}>
                {activeRun
                  ? t('chemsmart_studio.workspace.run_state', { state: activeRun.status })
                  : t('chemsmart_studio.workspace.no_active_run')}
              </Badge>
            )}
          </dl>
          {pendingDecisionCount > 0 ? (
            <Button className="h-8 gap-1.5" size="sm" variant="secondary" onClick={reviewDecisions}>
              {t('chemsmart_studio.approval.review')}
              <Badge className="px-1.5" variant="outline">
                {pendingDecisionCount}
              </Badge>
            </Button>
          ) : null}
          <Button
            aria-label={t('chemsmart_studio.ide.open_views')}
            className="size-8"
            size="icon-sm"
            variant="ghost"
            onClick={() => setPaletteOpen(true)}>
            <MoreHorizontal aria-hidden className="size-4" />
          </Button>
          <Button
            aria-controls="chemsmart-workbench"
            aria-expanded={bottomExpanded}
            aria-label={t(bottomExpanded ? 'chemsmart_studio.ide.bottom.hide' : 'chemsmart_studio.ide.bottom.show')}
            className="size-8"
            size="icon-sm"
            variant="ghost"
            onClick={toggleBottom}>
            {bottomExpanded ? (
              <PanelBottomClose aria-hidden className="size-4" />
            ) : (
              <PanelBottomOpen aria-hidden className="size-4" />
            )}
          </Button>
          <Button
            aria-controls="chemsmart-inspector"
            aria-expanded={inspectorExpanded}
            aria-label={t(inspectorExpanded ? 'chemsmart_studio.inspector.hide' : 'chemsmart_studio.inspector.show')}
            className="size-8"
            size="icon-sm"
            variant="ghost"
            onClick={toggleInspector}>
            {inspectorExpanded ? (
              <PanelRightClose aria-hidden className="size-4" />
            ) : (
              <PanelRightOpen aria-hidden className="size-4" />
            )}
          </Button>
        </div>
      </header>
      <StudioToolkitMenu
        isPaneExpanded={(pane) => {
          if (pane === 'explorer') return tier === 'wide' && explorerOpen
          if (isInspectorPane(pane)) return inspectorPresentation !== 'hidden' && inspectorTab === pane
          return bottomPresentation !== 'hidden' && bottomTab === pane
        }}
        onCommandPaletteOpen={() => setPaletteOpen(true)}
        onPaneSelect={openPane}
        onSettingsOpen={() => setSettingsOpen(true)}
      />

      <WorkspaceDock
        bottomIntent={bottomPane.intent}
        bottomPresentation={bottomPresentation}
        inspectorIntent={inspectorPane.intent}
        inspectorPresentation={inspectorPresentation}
        railExpanded={explorerOpen}
        sheetPane={sheetPane}
        tier={tier}
        onBottomOpenChange={applyBottomOpen}
        onBottomSizeChange={bottomPane.setNormalizedSize}
        onInspectorOpenChange={setInspectorOpen}
        onInspectorSizeChange={inspectorPane.setNormalizedSize}
        onSheetOpenChange={(open) => {
          if (open || sheetPane === null) return
          if (isInspectorPane(sheetPane)) setInspectorOpen(false)
          if (isBottomPane(sheetPane)) setBottomOpen(false)
          setSheetPane(null)
        }}
        bottom={
          <WorkbenchTabs
            activeTab={bottomTab}
            onTabChange={setBottomTab}
            content={{
              console: <CommandConsole draft={consoleDraft} onDraftChange={setConsoleDraft} />,
              jobs: (
                <Scrollbar className="min-h-0 flex-1">
                  <section className="space-y-3 p-3" data-testid="studio-jobs-panel">
                    <StudioControlSections
                      actionId={controlActionId}
                      actionsDisabled={controlActionFailed || controlFailed}
                      failed={controlFailed}
                      loading={controlLoading}
                      replay={replayView}
                      snapshot={controlSnapshot}
                      onAction={(actionId) => void performControlAction(actionId)}
                      onReplayFrame={(stepIndex) => {
                        setReplayPlaying(false)
                        void selectReplayFrame(stepIndex)
                      }}
                      onReplayPause={() => setReplayPlaying(false)}
                      onReplayPlay={() => void playReplay()}
                      onReplayRetry={() => void refreshReplay()}
                      onReplayRunChange={(runId) => void changeReplayRun(runId)}
                      onReplayStop={() => void stopReplay()}
                      onRetry={() => void refreshControlSnapshot()}
                    />
                  </section>
                </Scrollbar>
              ),
              problems: (
                <Scrollbar className="min-h-0 flex-1">
                  <section className="space-y-2 p-3" data-testid="studio-problems-panel">
                    {problems.length === 0 ? (
                      <p className="rounded-md border border-border border-dashed px-3 py-6 text-center text-foreground-muted text-sm">
                        {t('chemsmart_studio.ide.problems.empty')}
                      </p>
                    ) : null}
                    {problems.map((problem) => {
                      const action =
                        problem === 'status' && statusFailed ? (
                          <Button
                            loading={statusLoading}
                            size="sm"
                            variant="outline"
                            onClick={() => void refreshStatus()}>
                            <RotateCcw aria-hidden className="size-3.5" />
                            {t('common.retry')}
                          </Button>
                        ) : problem === 'control' && controlActionFailed ? (
                          <Button size="sm" variant="outline" onClick={() => void refreshControlSnapshot()}>
                            <RotateCcw aria-hidden className="size-3.5" />
                            {t('common.retry')}
                          </Button>
                        ) : undefined
                      const message =
                        problem === 'control' && controlActionFailed
                          ? controlActionFailureMessage
                          : t(problemTranslationKeys[problem])
                      return (
                        <Alert key={problem} action={action} message={message} role="alert" showIcon type="error" />
                      )
                    })}
                  </section>
                </Scrollbar>
              )
            }}
          />
        }
        rail={
          <div className="flex min-h-0 flex-1">
            <StudioActivityBar
              activePane={activePane}
              onPaneSelect={openPane}
              onSettingsOpen={() => setSettingsOpen(true)}
            />
            {tier === 'wide' && explorerOpen ? (
              <ResearchRail
                actionsDisabled={projectSwitchBlocked}
                busyAction={workspaceAction === 'activate_document' ? null : workspaceAction}
                onAction={(action) => runWorkspaceAction(action)}
              />
            ) : null}
          </div>
        }
        sheetExplorer={
          <ResearchRail
            actionsDisabled={projectSwitchBlocked}
            busyAction={workspaceAction === 'activate_document' ? null : workspaceAction}
            onAction={(action) => runWorkspaceAction(action)}
          />
        }
        center={
          <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="molecule-workspace-view">
            {(statusFailed || workspaceActionFailed || controlActionFailed) && (
              <div
                className="flex shrink-0 items-center gap-2 border-border border-b bg-error-bg px-3 py-1.5 text-error-text text-xs"
                data-testid="workspace-inline-error"
                role="alert">
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {controlActionFailed
                    ? controlActionFailureMessage
                    : workspaceActionFailed
                      ? t('chemsmart_studio.error.action')
                      : t('chemsmart_studio.error.status_title')}
                </span>
                <Button className="h-8" size="sm" variant="ghost" onClick={() => openPane('problems')}>
                  {t('chemsmart_studio.ide.pane.problems')}
                </Button>
              </div>
            )}
            <div className={cn('flex min-h-0 flex-1 flex-col', tier === 'viewport-only' ? 'p-0' : 'p-2')}>
              <MoleculeTabs
                busy={workspaceAction !== null}
                documents={openDocuments}
                onActivate={(projectId) => activateDocument(projectId)}
              />
              <MoleculeStage
                compact={tier === 'viewport-only'}
                contract={modeContract}
                editable={moleculeEditable}
                mode={workbenchMode}
                molecule={molecule}
                onModeChange={requestWorkbenchModeChange}
                selectable={moleculeSelectable}
              />
            </div>
          </main>
        }
        inspector={
          <InspectorPanel
            activeTab={inspectorTab}
            decisionCount={pendingDecisionCount}
            onTabChange={setInspectorTab}
            content={{
              properties: (
                <MoleculeInspector
                  agentAtomIds={agentTouch.atomIds}
                  contract={modeContract}
                  editable={moleculeEditable}
                  mode={workbenchMode}
                  molecule={molecule}
                  selectable={moleculeSelectable}
                  tier={tier}
                />
              ),
              agent: (
                <aside
                  aria-labelledby="chemsmart-agent-workspace-title"
                  className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-border border-l bg-background"
                  id="chemsmart-agent-workspace"
                  data-testid="agent-workspace-view">
                  <Scrollbar
                    className="min-h-0 shrink space-y-3 border-border border-b p-3"
                    data-testid="agent-status-region">
                    <div className="flex items-center justify-between gap-3">
                      <h2 id="chemsmart-agent-workspace-title" className="font-semibold text-base text-foreground">
                        {t('chemsmart_studio.workspace.agent_workspace')}
                      </h2>
                      <div className="flex items-center gap-1.5">
                        {molecule.draft?.dirty ? (
                          <Badge data-testid="agent-draft-count" variant="outline">
                            {t('chemsmart_studio.draft.change_count', { count: molecule.draft.cursor })}
                          </Badge>
                        ) : null}
                        <Badge variant={agentBadgeActive ? 'secondary' : 'outline'}>
                          {agentWorkflow?.requiresUserInput
                            ? t('chemsmart_studio.trusted_activity.status.needs_user')
                            : agentBadgeActive
                              ? t('chemsmart_studio.workspace.agent_active')
                              : t('chemsmart_studio.workspace.agent_idle')}
                        </Badge>
                      </div>
                    </div>
                    <AgentModeSwitch disabled={agentModeBusy} mode={agentMode} onChange={changeAgentMode} />
                    <ProcessHealth
                      icon={Bot}
                      label={t('chemsmart_studio.workspace.chemsmart_agent')}
                      status={agentStatus}
                    />
                    <div
                      aria-atomic="true"
                      aria-live="polite"
                      className="rounded-lg border border-border-subtle bg-background-subtle p-3"
                      data-phase={agentWorkflow?.phase ?? 'idle'}
                      data-testid="agent-workflow-state"
                      role="status">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-foreground-muted text-xs">
                          {t('chemsmart_studio.workspace.current_activity')}
                        </p>
                        {agentWorkflow ? (
                          <span className="flex items-center gap-1.5 text-foreground-secondary text-xs">
                            <span
                              aria-hidden
                              className={cn(
                                'size-1.5 rounded-full',
                                agentWorkflowActive ? 'animate-pulse bg-info motion-reduce:animate-none' : 'bg-border'
                              )}
                            />
                            {t(`chemsmart_studio.workspace.agent_object.${agentWorkflow.currentObject}`)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 font-medium text-foreground text-sm">
                        {agentWorkflow?.statusSummary ??
                          latestActivity?.payload.message ??
                          t('chemsmart_studio.workspace.agent_ready')}
                      </p>
                      {agentWorkflow?.progress !== null && agentWorkflow?.progress !== undefined ? (
                        <div
                          aria-label={t('chemsmart_studio.workspace.agent_progress')}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={Math.round(agentWorkflow.progress * 100)}
                          className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"
                          role="progressbar">
                          <div
                            className="h-full rounded-full bg-info transition-[width] motion-reduce:transition-none"
                            style={{ width: `${Math.round(agentWorkflow.progress * 100)}%` }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </Scrollbar>
                  <Scrollbar className="min-h-0 flex-1 p-3">
                    <section aria-labelledby="chemsmart-studio-activity-title" className="space-y-3">
                      <AgentTraceTimeline events={agentTrace} />
                      <h3 id="chemsmart-studio-activity-title" className="font-medium text-foreground text-sm">
                        {t('chemsmart_studio.activity.title')}
                      </h3>
                      {visibleActivity.length === 0 ? (
                        <p className="rounded-md border border-border border-dashed px-3 py-6 text-center text-foreground-muted text-sm leading-5">
                          {t('chemsmart_studio.activity.empty')}
                        </p>
                      ) : (
                        <ol className="space-y-2" data-testid="chemsmart-studio-activity">
                          {visibleActivity.map((event, index) => (
                            <li data-event-id={event.eventId} key={event.eventId}>
                              <StudioUiEventItem event={event} live={index === visibleActivity.length - 1} />
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  </Scrollbar>
                  <form
                    aria-label={t('chemsmart_studio.workspace.agent_composer')}
                    className="shrink-0 space-y-2 border-border border-t p-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void runAgentTurn()
                    }}>
                    {agentTurnFailed ? (
                      <Alert
                        message={t('chemsmart_studio.workspace.agent_turn_failed')}
                        role="alert"
                        showIcon
                        type="error"
                      />
                    ) : null}
                    <label className="sr-only" htmlFor="chemsmart-agent-request">
                      {t('chemsmart_studio.workspace.agent_request')}
                    </label>
                    <Textarea.Input
                      aria-describedby="chemsmart-agent-model"
                      disabled={agentTurnBusy}
                      id="chemsmart-agent-request"
                      maxLength={100000}
                      placeholder={t('chemsmart_studio.workspace.agent_request_placeholder')}
                      rows={3}
                      value={agentRequest}
                      onChange={(event) => setAgentRequest(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          event.currentTarget.form?.requestSubmit()
                        }
                      }}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-foreground-muted text-xs" id="chemsmart-agent-model">
                        {deterministicModelId
                          ? t('chemsmart_studio.workspace.deterministic_validation_model')
                          : (defaultModel?.name ?? t('chemsmart_studio.workspace.no_agent_model'))}
                      </p>
                      <Button
                        aria-label={t('chemsmart_studio.workspace.send_agent_request')}
                        disabled={!activeAgentModelId || agentRequest.trim().length === 0}
                        loading={agentTurnBusy}
                        size="icon"
                        type="submit">
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                    </div>
                  </form>
                </aside>
              ),
              decisions: (
                <StudioDecisionList
                  actionId={controlActionId}
                  actionsDisabled={controlActionFailed || controlFailed}
                  snapshot={controlSnapshot}
                  onAction={(actionId) => void performControlAction(actionId)}
                />
              )
            }}
          />
        }
      />
      <footer
        className="flex h-6 shrink-0 items-center justify-between gap-3 border-border border-t px-3 text-foreground-muted text-xs"
        data-testid="studio-status-bar"
        role="status">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {agentWorkflowActive ? <Bot aria-hidden className="size-3 text-info" /> : null}
          {agentWorkflowActive
            ? (agentWorkflow?.statusSummary ?? t('chemsmart_studio.workspace.agent_driving'))
            : t('chemsmart_studio.ide.status.ready')}
        </span>
        <span className="shrink-0">
          {molecule.displayBinding.state === 'committed' && molecule.draft?.dirty
            ? t('chemsmart_studio.draft.status', { count: molecule.draft.cursor })
            : t(`chemsmart_studio.stage.display.${molecule.displayBinding.state}`, {
                frame: molecule.displayBinding.state === 'committed' ? 0 : molecule.displayBinding.frameIndex + 1
              })}
        </span>
      </footer>
      {paletteOpen ? (
        <StudioCommandPalette
          open
          onOpenChange={setPaletteOpen}
          onPaneSelect={openPane}
          onProjectAction={(action) => {
            if (!projectSwitchBlocked) runWorkspaceAction(action)
          }}
          onSettingsOpen={() => setSettingsOpen(true)}
        />
      ) : null}
      <StudioSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      <MoleculeDraftReviewDialog
        busy={draftReviewBusy}
        context={draftReview?.context ?? 'save'}
        open={draftReview !== null}
        snapshot={molecule.draft}
        onApply={() => void continueDraftReview('apply')}
        onCancel={() => setDraftReview(null)}
        onDiscard={() => void continueDraftReview('discard')}
      />
      {highRiskApproval ? (
        <AllowNoticeDialog
          actionId={controlActionId}
          approveActionId={highRiskApproval.allowActionId}
          approveLabel={t(
            highRiskApproval.kind === 'execution_tool'
              ? 'chemsmart_studio.approval.execution.approve'
              : 'chemsmart_studio.approval.calculation.start'
          )}
          denyActionId={highRiskApproval.denyActionId}
          denyLabel={t(
            highRiskApproval.kind === 'execution_tool'
              ? 'chemsmart_studio.approval.execution.deny'
              : 'chemsmart_studio.approval.calculation.deny'
          )}
          description={t(
            highRiskApproval.kind === 'execution_tool'
              ? 'chemsmart_studio.approval.execution.description'
              : 'chemsmart_studio.approval.calculation.description'
          )}
          gates={passedGates}
          open={noticeOpen}
          requester="agent"
          title={t(
            highRiskApproval.kind === 'execution_tool'
              ? 'chemsmart_studio.approval.execution.title'
              : 'chemsmart_studio.approval.calculation.title'
          )}
          details={
            highRiskApproval.kind === 'execution_tool' ? (
              <ExecutionApprovalSummary approval={highRiskApproval} />
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <SummaryField label={t('chemsmart_studio.document.id')} value={highRiskApproval.documentId} />
                <SummaryField
                  label={t('chemsmart_studio.approval.expected_revision')}
                  value={highRiskApproval.expectedRevision}
                />
                <SummaryField
                  label={t('chemsmart_studio.optimization.engine')}
                  value={<EngineName engine={highRiskApproval.engine} />}
                />
                <SummaryField label={t('chemsmart_studio.optimization.method')} value={highRiskApproval.method} />
              </dl>
            )
          }
          onAction={(actionId) => void performControlAction(actionId)}
          onDismiss={dismissNotice}
        />
      ) : finalGeometry ? (
        <AllowNoticeDialog
          actionId={controlActionId}
          approveActionId={finalGeometry.acceptActionId}
          approveLabel={t('chemsmart_studio.optimization.final_geometry.accept')}
          denyActionId={finalGeometry.rejectActionId}
          denyLabel={t('chemsmart_studio.optimization.final_geometry.reject')}
          description={t('chemsmart_studio.optimization.final_geometry.description', {
            revision: finalGeometry.expectedRevision
          })}
          gates={passedGates}
          open={noticeOpen}
          requester="agent"
          title={t('chemsmart_studio.optimization.final_geometry.title')}
          details={
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <SummaryField
                label={t('chemsmart_studio.approval.expected_revision')}
                value={finalGeometry.expectedRevision}
              />
              <SummaryField label={t('chemsmart_studio.optimization.frame')} value={finalGeometry.frame.stepIndex} />
            </dl>
          }
          onAction={(actionId) => void performControlAction(actionId)}
          onDismiss={dismissNotice}
        />
      ) : null}
    </section>
  )
}
