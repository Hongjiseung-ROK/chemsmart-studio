import type {
  ResearchProjectContext,
  StudioAgentActionCue,
  StudioAgentCapability,
  StudioAgentComposerIntent,
  StudioAgentLiveEvent,
  StudioAgentTurnEvent
} from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Scrollbar } from '@cherrystudio/ui'
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
  ChemSmartStudioReplayCatalog,
  ChemSmartStudioReplaySelection,
  ChemSmartStudioReplayTimeline
} from '@shared/ipc/schemas/chemsmartStudio'
import {
  Bot,
  MoreHorizontal,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  TriangleAlert
} from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'

import chemSmartLogo from '../../../../build/logo.png'
import { type AgentComposerSnapshot, type AgentWorkbenchArtifact, ChemSmartAgentPane } from './ChemSmartAgentPane'
import { CommandConsole } from './CommandConsole'
import { MoleculeDraftReviewDialog } from './MoleculeDraftReviewDialog'
import { MoleculeInspector } from './MoleculeInspector'
import { MoleculeStage } from './MoleculeStage'
import { MoleculeTabs } from './MoleculeTabs'
import { ResearchRail } from './ResearchRail'
import { StudioActivityBar } from './StudioActivityBar'
import { StudioCommandPalette } from './StudioCommandPalette'
import { type OptimizationReplayViewState, StudioControlSections, StudioDecisionList } from './StudioControlSections'
import { defaultStudioRelativeLayout, isBottomPane, resolvePanePresentation, type StudioPaneId } from './studioLayout'
import { StudioSettingsSheet } from './StudioSettingsSheet'
import { StudioToolkitMenu } from './StudioToolkitMenu'
import { useContainerTier } from './useContainerTier'
import { useMoleculeDocument } from './useMoleculeDocument'
import { useStudioPaneIntent } from './useStudioPaneIntent'
import { useWorkbenchMode, type WorkbenchContextPane, type WorkbenchMode, workbenchModes } from './useWorkbenchMode'
import { type WorkbenchTab, WorkbenchTabs } from './WorkbenchTabs'
import { WorkspaceDock } from './WorkspaceDock'

const logger = loggerService.withContext('ChemSmartWorkspace')
const MAX_AGENT_LIVE_EVENTS = 4_000
const MAX_AGENT_TURN_EVENTS = 2_000
const REPLAY_CATALOG_LIMIT = 50
const REPLAY_TIMELINE_LIMIT = 500
const REPLAY_STEP_DELAY_MS = 700

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

const problemTranslationKeys = {
  control: 'chemsmart_studio.ide.problems.control',
  replay: 'chemsmart_studio.ide.problems.replay',
  status: 'chemsmart_studio.ide.problems.status',
  workspace: 'chemsmart_studio.ide.problems.workspace'
} as const

function mergeAgentTurnEvent(
  current: readonly StudioAgentTurnEvent[],
  event: StudioAgentTurnEvent
): StudioAgentTurnEvent[] {
  if (current.some((item) => item.eventId === event.eventId || item.sequence === event.sequence)) return [...current]

  return [...current, event].sort((left, right) => left.sequence - right.sequence).slice(-MAX_AGENT_TURN_EVENTS)
}

function mergeAgentLiveEvent(
  current: readonly StudioAgentLiveEvent[],
  event: StudioAgentLiveEvent
): StudioAgentLiveEvent[] {
  const latestSequence = current.reduce(
    (sequence, item) => (item.turnId === event.turnId ? Math.max(sequence, item.sequence) : sequence),
    -1
  )
  if (event.sequence <= latestSequence) return [...current]
  return [...current, event].slice(-MAX_AGENT_LIVE_EVENTS)
}

function classifyControlActionFailure(error: unknown): ControlActionFailure {
  if (!(error instanceof IpcError)) return 'generic'
  if (error.code === chemsmartStudioErrorCodes.REVISION_CONFLICT) return 'revision_conflict'
  if (error.code === chemsmartStudioErrorCodes.SCHEMA_INVALID) return 'schema_invalid'
  return 'generic'
}

function composerIntent(request: string, manifest: readonly StudioAgentCapability[]): StudioAgentComposerIntent | null {
  const selected = manifest.filter((item) => {
    const prefix = item.discovery === 'plus' ? '+' : item.discovery === 'mention' ? '@' : '/'
    return request.split(/\s+/).includes(`${prefix}${item.key}`)
  })
  if (selected.length === 0) return null
  const command = selected.findLast((item) => item.discovery === 'command')
  const contextRefs = [...new Set(selected.flatMap((item) => (item.contextRef === undefined ? [] : [item.contextRef])))]
  const capability = selected.reduce<'inspect' | 'plan' | 'act' | 'navigation'>((current, item) => {
    const rank = { inspect: 0, navigation: 0, plan: 1, act: 2 } as const
    return rank[item.capability] > rank[current] ? item.capability : current
  }, 'inspect')
  const kind =
    command?.key === 'dry-run'
      ? 'dry_run'
      : command?.key === 'run'
        ? 'run'
        : command?.key === 'plan'
          ? 'plan'
          : command?.key === 'review'
            ? 'review'
            : command?.key === 'history'
              ? 'history'
              : command?.key === 'new'
                ? 'new'
                : contextRefs.length > 0
                  ? 'context'
                  : 'inspect'
  return {
    intentId: `intent-${crypto.randomUUID()}`,
    kind,
    capability,
    contextRefs,
    requiresExecutionApproval: capability === 'act',
    extensions: {}
  }
}

interface ChemSmartWorkspaceProps {
  active: boolean
  researchContext?: ResearchProjectContext | null
  sessionId: string
  onCreateThread?: (title: string) => Promise<void>
  onRenameThread?: (threadId: string, title: string) => Promise<void>
  onSelectThread?: (threadId: string) => Promise<void>
}

export function ChemSmartWorkspace({
  active,
  researchContext = null,
  sessionId,
  onCreateThread,
  onRenameThread,
  onSelectThread
}: ChemSmartWorkspaceProps) {
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
  const selectContextForMode = useCallback(
    (pane: WorkbenchContextPane) => {
      if (pane === 'properties') {
        setSheetPane('properties')
        return
      }
      inspectorPane.activate()
      if (tier === 'viewport-only') setSheetPane('agent')
    },
    [inspectorPane, tier]
  )
  const {
    contract: modeContract,
    mode: workbenchMode,
    setMode: setWorkbenchMode
  } = useWorkbenchMode({
    onRevealCommandWorkbench: revealCommandWorkbench,
    onSelectContextPane: selectContextForMode
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
  const [deterministicModelId, setDeterministicModelId] = useState<UniqueModelId | null>(null)
  const activeModelId = deterministicModelId ?? defaultModel?.id ?? null
  const [agentComposer, setAgentComposer] = useState<AgentComposerSnapshot>({
    selectionEnd: 0,
    selectionStart: 0,
    scrollTop: 0,
    value: ''
  })
  const [agentReviewRequestId, setAgentReviewRequestId] = useState(0)
  const [agentTurnBusy, setAgentTurnBusy] = useState(false)
  const [agentTurnFailed, setAgentTurnFailed] = useState(false)
  const agentTurnControlRef = useRef<'stop' | 'steer' | null>(null)
  const [moleculeSummary, setMoleculeSummary] = useState<ChemSmartStudioMoleculeSummary | null>(null)
  const [documentName, setDocumentName] = useState<string | null>(null)
  const [agentCapabilities, setAgentCapabilities] = useState<StudioAgentCapability[]>([])
  const [agentLiveEvents, setAgentLiveEvents] = useState<StudioAgentLiveEvent[]>([])
  const [agentTurnEvents, setAgentTurnEvents] = useState<StudioAgentTurnEvent[]>([])
  const [agentActionCues, setAgentActionCues] = useState<StudioAgentActionCue[]>([])
  const actionCueTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const reduceMotion = useReducedMotion()
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusFailed, setStatusFailed] = useState(false)
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceAction>(null)
  const [workspaceActionFailed, setWorkspaceActionFailed] = useState(false)
  const [problems, setProblems] = useState<StudioProblemKind[]>([])
  const [openDocuments, setOpenDocuments] = useState<ChemSmartStudioOpenDocuments | null>(null)
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
    setStatusLoading(true)
    setStatusFailed(false)

    try {
      const [, runtimeContext] = await Promise.all([
        ipcApi.request('chemsmart_studio.status'),
        ipcApi.request('chemsmart_studio.agent.runtime_context').catch(() => ({ deterministicModelId: null }))
      ])
      if (statusRequestRef.current !== requestId) return

      void refreshMoleculeSummary()
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
    const request = agentComposer.value.trim()
    const modelId = activeModelId
    if (!request || !modelId || agentTurnBusy) return
    const intent = composerIntent(request, agentCapabilities)
    if (intent?.kind === 'new') {
      await onCreateThread?.(t('chemsmart_studio.agent_workbench.new_title'))
      return
    }
    if (intent?.kind === 'history' || intent?.kind === 'review') {
      setAgentReviewRequestId((current) => current + 1)
      return
    }

    setAgentTurnBusy(true)
    setAgentTurnFailed(false)
    agentTurnControlRef.current = null
    try {
      await ipcApi.request('chemsmart_studio.agent.run_turn', { sessionId, modelId, request, intent })
      setAgentComposer((current) =>
        current.value.trim() === request ? { selectionEnd: 0, selectionStart: 0, scrollTop: 0, value: '' } : current
      )
    } catch (error) {
      if (agentTurnControlRef.current === null) {
        setAgentTurnFailed(true)
        logger.error('ChemSmart Agent turn failed', error as Error)
      }
    } finally {
      setAgentTurnBusy(false)
      agentTurnControlRef.current = null
    }
  }, [activeModelId, agentCapabilities, agentComposer.value, agentTurnBusy, onCreateThread, sessionId, t])

  const controlAgentTurn = useCallback(
    async (action: 'stop' | 'steer' | 'queue') => {
      const request = agentComposer.value.trim()
      if (action !== 'stop' && request.length === 0) return
      const intent = action === 'stop' ? null : composerIntent(request, agentCapabilities)
      if (intent?.capability === 'navigation') return
      if (action === 'stop' || action === 'steer') agentTurnControlRef.current = action
      setAgentTurnFailed(false)
      try {
        await ipcApi.request(
          'chemsmart_studio.agent.control_turn',
          action === 'stop' ? { sessionId, action } : { sessionId, action, request, intent }
        )
        if (action !== 'stop') {
          setAgentComposer({ selectionEnd: 0, selectionStart: 0, scrollTop: 0, value: '' })
        }
      } catch (error) {
        if (action === 'stop' || action === 'steer') agentTurnControlRef.current = null
        setAgentTurnFailed(true)
        logger.error('ChemSmart Agent turn control failed', error as Error)
      }
    },
    [agentCapabilities, agentComposer.value, sessionId]
  )

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
    if (status.state === 'failed') logger.warn('The ChemSmart agent reported a failed state')
  })

  useIpcOn('chemsmart_studio.agent.turn_event', (event) => {
    if (event.threadId !== sessionId) return
    setAgentTurnEvents((current) => mergeAgentTurnEvent(current, event))
  })

  useIpcOn('chemsmart_studio.agent.live_event', (event) => {
    if (event.threadId !== sessionId) return
    setAgentLiveEvents((current) => mergeAgentLiveEvent(current, event))
  })

  useIpcOn('chemsmart_studio.agent.action_cue', (event) => {
    const existingTimer = actionCueTimersRef.current.get(event.cueId)
    if (existingTimer) clearTimeout(existingTimer)
    actionCueTimersRef.current.delete(event.cueId)
    if (event.phase === 'failed' || event.phase === 'cancelled') {
      setAgentActionCues((current) => current.filter((cue) => cue.cueId !== event.cueId))
      return
    }
    setAgentActionCues((current) => [...current.filter((cue) => cue.cueId !== event.cueId), event])
    if (event.phase === 'succeeded') {
      const timer = setTimeout(() => {
        setAgentActionCues((current) => current.filter((cue) => cue.cueId !== event.cueId))
        actionCueTimersRef.current.delete(event.cueId)
      }, 900)
      actionCueTimersRef.current.set(event.cueId, timer)
    }
  })

  const projectedAgentBusy = useMemo(() => {
    const terminalTurns = new Set(
      agentTurnEvents.filter((event) => event.kind === 'turn_terminal').map((event) => event.turnId)
    )
    return agentTurnEvents.some((event) => event.kind === 'user_message' && !terminalTurns.has(event.turnId))
  }, [agentTurnEvents])
  const agentBusy = agentTurnBusy || projectedAgentBusy
  const visibleActionCues = useMemo(
    () =>
      agentActionCues.filter(
        (cue) =>
          cue.documentId === molecule.displayDocument?.documentId && cue.revision === molecule.displayDocument?.revision
      ),
    [agentActionCues, molecule.displayDocument?.documentId, molecule.displayDocument?.revision]
  )

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

  const refreshOpenDocuments = useCallback(async () => {
    try {
      setOpenDocuments(await ipcApi.request('chemsmart_studio.editor.open_documents'))
    } catch (error) {
      // The tab strip is navigation, not authority: losing it must not disturb the open molecule.
      logger.error('Failed to list the open ChemSmart Studio projects', error as Error)
    }
  }, [])

  useEffect(() => {
    setAgentCapabilities([])
    setAgentLiveEvents([])
    setAgentTurnEvents([])
    setAgentActionCues([])
    actionCueTimersRef.current.forEach(clearTimeout)
    actionCueTimersRef.current.clear()
    setAgentComposer({ selectionEnd: 0, selectionStart: 0, scrollTop: 0, value: '' })
    setAgentReviewRequestId(0)
    setMoleculeSummary(null)
    setDocumentName(null)
    setWorkspaceAction(null)
    setWorkspaceActionFailed(false)
    setProblems([])
    setControlSnapshot(null)
    setControlLoading(true)
    setControlFailed(false)
    setControlActionId(null)
    setControlActionFailure(null)
    controlActionRef.current = null
    void refreshStatus()
    void refreshControlSnapshot()
    void refreshOpenDocuments()
    void Promise.all([
      ipcApi.request('chemsmart_studio.agent.capabilities', { sessionId, threadId: sessionId }),
      ipcApi.request('chemsmart_studio.agent.turns', {
        threadId: sessionId,
        beforeSequence: null,
        limit: 100
      })
    ])
      .then(([manifest, page]) => {
        if (currentSessionRef.current !== sessionId) return
        setAgentCapabilities(manifest.items)
        setAgentTurnEvents(page.events)
      })
      .catch((error) => {
        recordProblem('status')
        logger.error('Failed to load the Agent workbench projection', error as Error)
      })

    return () => {
      actionCueTimersRef.current.forEach(clearTimeout)
      actionCueTimersRef.current.clear()
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
  }, [recordProblem, refreshControlSnapshot, refreshOpenDocuments, refreshStatus, sessionId])

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
  const agentWorkflow = controlSnapshot?.agent ?? null
  const agentWorkflowActive =
    agentWorkflow !== null &&
    agentWorkflow.phase !== 'idle' &&
    agentWorkflow.phase !== 'completed' &&
    agentWorkflow.phase !== 'failed' &&
    agentWorkflow.phase !== 'recovering'
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
    inspector: inspectorPane.intent
  })
  paneIntentRef.current = {
    bottom: bottomPane.intent,
    bottomTab,
    inspector: inspectorPane.intent
  }
  const previousTierRef = useRef(tier)
  useEffect(() => {
    const previous = previousTierRef.current
    if (tier === 'viewport-only' && previous !== 'viewport-only') {
      const current = paneIntentRef.current
      if (current.bottom.open && current.bottom.lastActivatedAt > current.inspector.lastActivatedAt) {
        setSheetPane(current.bottomTab)
      } else if (current.inspector.open) {
        setSheetPane('agent')
      } else if (current.bottom.open) {
        setSheetPane(current.bottomTab)
      } else {
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
        if (pane === 'agent') {
          inspectorPane.activate()
        }
        if (pane === 'properties') {
          setSheetPane(pane)
          return
        }
        if (pane === 'decisions') {
          inspectorPane.activate()
          setSheetPane('agent')
          return
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
      if (pane === 'agent') {
        inspectorPane.activate()
        return
      }
      if (pane === 'properties') {
        setSheetPane(pane)
        return
      }
      if (pane === 'decisions') {
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
    sheetActive: sheetPane === 'agent'
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
    if (inspectorPresentation !== 'hidden') panes.push('agent')
    if (sheetPane === 'properties' || sheetPane === 'decisions') panes.push(sheetPane)
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
    sessionId,
    sheetPane,
    tier,
    workspaceEditorMode
  ])
  const activePane: StudioPaneId | null =
    sheetPane ??
    (inspectorPresentation === 'docked' ? 'agent' : null) ??
    (bottomPresentation === 'docked' ? bottomTab : null) ??
    (tier === 'wide' && explorerOpen ? 'explorer' : null)
  const toggleInspector = useCallback(() => {
    if (tier === 'viewport-only') {
      if (sheetPane === 'agent') {
        setSheetPane(null)
        setInspectorOpen(false)
      } else {
        inspectorPane.activate()
        setSheetPane('agent')
      }
      return
    }
    setInspectorOpen((open) => !open)
  }, [inspectorPane, setInspectorOpen, sheetPane, tier])
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
      setSheetPane(null)
      setSettingsOpen(false)
      setPaletteOpen(false)
    },
    { enabled: active },
    [active]
  )
  // The molecule is owned by main, not by the helper process. It stays readable and editable when
  // the helper is stopped or has crashed — losing the structure because a renderer died was the
  // whole point of moving the authority.
  const moleculeEditable = approvalCount === 0 && activeRun === null
  const moleculeSelectable = approvalCount === 0
  const finalGeometry = controlSnapshot?.optimization?.finalGeometry ?? null
  const pendingDecisionCount = approvalCount + (finalGeometry ? 1 : 0)
  // The highest-risk waiting decision is announced with a blocking notice; preview commits are not.
  const activeDocumentName =
    documentName ??
    openDocuments?.documents.find((document) => document.projectId === openDocuments.activeProjectId)?.projectName ??
    null
  const activeResearchThread = researchContext?.threads.find((thread) => thread.threadId === sessionId) ?? null
  const reviewDecisions = useCallback(() => {
    inspectorPane.activate()
    if (tier === 'viewport-only') setSheetPane('agent')
    else setSheetPane(null)
    setAgentReviewRequestId((current) => current + 1)
  }, [inspectorPane, tier])
  const draftEntries = molecule.draft?.entries.slice(0, molecule.draft.cursor) ?? []
  const agentArtifacts: AgentWorkbenchArtifact[] = []
  const publishedArtifacts = agentTurnEvents
    .flatMap((event) => (event.artifact ? [event.artifact] : []))
    .filter(
      (artifact, index, artifacts) =>
        artifacts.findIndex((candidate) => candidate.artifactId === artifact.artifactId) === index
    )
  for (const artifact of publishedArtifacts) {
    agentArtifacts.push({
      id: artifact.artifactId,
      status: 'ready',
      title: artifact.heading,
      summary: artifact.summary,
      review: (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-foreground-muted">{t('chemsmart_studio.agent_workbench.science.molecule')}</dt>
          <dd className="break-all font-mono text-foreground-secondary">
            {artifact.documentId} · r{artifact.revision} · {artifact.geometryHash}
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
    })
  }
  if (molecule.draft?.dirty) {
    agentArtifacts.push({
      id: molecule.draft.draftId,
      status: 'draft',
      title: t('chemsmart_studio.draft.history'),
      summary: t('chemsmart_studio.draft.change_count', { count: draftEntries.length }),
      review: (
        <ol aria-label={t('chemsmart_studio.draft.history')} className="space-y-2">
          {draftEntries.map((entry, index) => (
            <li className="rounded-md border border-border-subtle bg-background-subtle p-2.5" key={entry.entryId}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground text-sm">
                  {t('chemsmart_studio.draft.history_entry', { index: index + 1 })}
                </span>
                <Badge variant="outline">{t(`chemsmart_studio.draft.actor.${entry.actor}`)}</Badge>
              </div>
              <p className="mt-1 text-foreground-secondary text-xs">
                {entry.summary.operationKinds
                  .map((kind) => t(`chemsmart_studio.approval.preview.operation.${kind}`))
                  .join(' · ')}
              </p>
              <p className="mt-1 text-foreground-muted text-xs">
                {t('chemsmart_studio.draft.change_summary', {
                  atoms: entry.summary.affectedAtomIds.length,
                  bonds: entry.summary.affectedBondIds.length,
                  coordinates: entry.summary.coordinateChangeCount,
                  constraints: entry.summary.constraintChangeCount
                })}
              </p>
            </li>
          ))}
        </ol>
      )
    })
  }
  if (activeRun) {
    agentArtifacts.push({
      id: activeRun.runId,
      status: activeRun.status === 'pending_approval' ? 'waiting' : 'ready',
      title: t('chemsmart_studio.optimization.title'),
      summary: t('chemsmart_studio.workspace.run_state', { state: activeRun.status }),
      review: (
        <dl className="grid grid-cols-2 gap-3 rounded-md border border-border-subtle bg-background-subtle p-3 text-xs">
          <div>
            <dt className="text-foreground-muted">{t('chemsmart_studio.optimization.run')}</dt>
            <dd className="mt-1 break-words text-foreground">{activeRun.runId}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">{t('chemsmart_studio.optimization.engine')}</dt>
            <dd className="mt-1 text-foreground">{activeRun.engine}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">{t('chemsmart_studio.optimization.method')}</dt>
            <dd className="mt-1 text-foreground">{activeRun.method}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">{t('chemsmart_studio.optimization.input_revision')}</dt>
            <dd className="mt-1 text-foreground">{activeRun.inputRevision}</dd>
          </div>
        </dl>
      )
    })
  }
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
            aria-label={t(
              inspectorExpanded ? 'chemsmart_studio.agent_workbench.hide' : 'chemsmart_studio.agent_workbench.show'
            )}
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
          if (pane === 'agent') return inspectorPresentation !== 'hidden'
          if (pane === 'properties') return sheetPane === 'properties'
          if (pane === 'decisions') return pendingDecisionCount > 0
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
        sheetContexts={{
          properties: (
            <MoleculeInspector
              agentAtomIds={[]}
              contract={modeContract}
              editable={moleculeEditable}
              mode={workbenchMode}
              molecule={molecule}
              selectable={moleculeSelectable}
              tier={tier}
            />
          )
        }}
        tier={tier}
        onBottomOpenChange={applyBottomOpen}
        onBottomSizeChange={bottomPane.setNormalizedSize}
        onInspectorOpenChange={setInspectorOpen}
        onInspectorSizeChange={inspectorPane.setNormalizedSize}
        onSheetOpenChange={(open) => {
          if (open || sheetPane === null) return
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
                actionCues={visibleActionCues}
                compact={tier === 'viewport-only'}
                contract={modeContract}
                editable={moleculeEditable}
                mode={workbenchMode}
                molecule={molecule}
                onModeChange={requestWorkbenchModeChange}
                reduceMotion={reduceMotion ?? false}
                selectable={moleculeSelectable}
              />
            </div>
          </main>
        }
        inspector={
          <ChemSmartAgentPane
            activeThreadId={sessionId}
            artifacts={agentArtifacts}
            available={activeAgentModelId !== null}
            busy={agentBusy}
            capabilities={agentCapabilities}
            composer={agentComposer}
            failed={agentTurnFailed}
            pendingDecisionCount={pendingDecisionCount}
            reviewContent={
              <StudioDecisionList
                actionId={controlActionId}
                actionsDisabled={controlActionFailed || controlFailed}
                snapshot={controlSnapshot}
                onAction={(actionId) => void performControlAction(actionId)}
              />
            }
            reviewRequestId={agentReviewRequestId}
            threads={researchContext?.threads ?? []}
            threadTitle={
              activeResearchThread?.title ?? activeDocumentName ?? t('chemsmart_studio.agent_workbench.current_session')
            }
            turnEvents={agentTurnEvents}
            liveEvents={agentLiveEvents}
            onClose={() => {
              if (tier === 'viewport-only') setSheetPane(null)
              else setInspectorOpen(false)
            }}
            onComposerChange={setAgentComposer}
            onCreateThread={() =>
              void onCreateThread?.(
                t('chemsmart_studio.agent_workbench.new_title_numbered', {
                  index: (researchContext?.threads.length ?? 0) + 1
                })
              )
            }
            onOpenProperties={() => openPane('properties')}
            onQueue={() => void controlAgentTurn('queue')}
            onRenameThread={(threadId, title) => void onRenameThread?.(threadId, title)}
            onSelectThread={(threadId) => void onSelectThread?.(threadId)}
            onSteer={() => void controlAgentTurn('steer')}
            onStop={() => void controlAgentTurn('stop')}
            onSubmit={() => void runAgentTurn()}
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
    </section>
  )
}
