import type {
  MoleculeDocument,
  MoleculeOperation,
  StageGestureIntent,
  StudioDraftSnapshot
} from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type {
  ChemSmartStudioMoleculeDisplayChanged,
  ChemSmartStudioPatchMode
} from '@shared/ipc/schemas/chemsmartStudio'
import { useCallback, useEffect, useRef, useState } from 'react'

const logger = loggerService.withContext('useMoleculeDocument')

interface MoleculeDocumentState {
  document: MoleculeDocument | null
  /** Recoverable edits layered over the committed document until Save or Run review. */
  draft: StudioDraftSnapshot | null
  /** What Three.js draws. Run and replay frames never replace the committed `document`. */
  displayDocument: MoleculeDocument | null
  displayBinding: ChemSmartStudioMoleculeDisplayChanged['binding']
  /** True when the last read or proposal failed; the caller offers an explicit retry. */
  failed: boolean
  loading: boolean
  proposing: boolean
  /** Ordered researcher picks from the authoritative native document. */
  selection: readonly string[]
  selecting: boolean
  /** True while an undo or redo is in flight; history travel is not re-entrant. */
  traveling: boolean
}

/**
 * Reads the committed molecule document for the researcher and proposes their edits as previews. Every
 * proposal carries the mode it came from and the revision it targets, so main can refuse a stale or
 * out-of-mode change instead of applying it.
 */
export function useMoleculeDocument(sessionId: string, enabled: boolean) {
  const [state, setState] = useState<MoleculeDocumentState>({
    document: null,
    draft: null,
    displayDocument: null,
    displayBinding: { state: 'committed' },
    failed: false,
    loading: false,
    proposing: false,
    selection: [],
    selecting: false,
    traveling: false
  })
  const requestRef = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current
    setState((current) => ({ ...current, failed: false, loading: true }))
    try {
      const [document, draft] = await Promise.all([
        ipcApi.request('chemsmart_studio.molecule.document', { sessionId }),
        ipcApi.request('chemsmart_studio.molecule.draft_snapshot', { sessionId })
      ])
      if (requestRef.current !== requestId) return
      setState((current) => ({
        ...current,
        document,
        draft,
        displayDocument:
          current.displayBinding.state === 'committed' ? (draft?.document ?? document) : current.displayDocument,
        loading: false,
        selection: draft?.document.selections ?? document.selections
      }))
    } catch (error) {
      if (requestRef.current !== requestId) return
      const unavailable = error instanceof IpcError && error.code === chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE
      setState((current) => ({
        ...current,
        document: null,
        draft: null,
        displayDocument: current.displayBinding.state === 'committed' ? null : current.displayDocument,
        failed: !unavailable,
        loading: false,
        selection: []
      }))
      if (!unavailable) logger.error('Failed to read the molecule document', error as Error)
    }
  }, [sessionId])

  useEffect(() => {
    requestRef.current += 1
    setState({
      document: null,
      draft: null,
      displayDocument: null,
      displayBinding: { state: 'committed' },
      failed: false,
      loading: false,
      proposing: false,
      selection: [],
      selecting: false,
      traveling: false
    })
    if (enabled) void refresh()
  }, [enabled, refresh])

  useIpcOn('chemsmart_studio.molecule.changed', () => {
    if (enabled) void refresh()
  })

  useIpcOn('chemsmart_studio.molecule.display_changed', (event) => {
    if (!enabled || event.sessionId !== sessionId) return
    setState((current) => ({
      ...current,
      displayDocument:
        event.binding.state === 'committed' ? (current.draft?.document ?? event.document) : event.document,
      displayBinding: event.binding,
      selection:
        event.binding.state === 'committed'
          ? (current.draft?.document.selections ?? event.document.selections)
          : current.selection
    }))
  })

  useIpcOn('chemsmart_studio.molecule.draft_changed', (event) => {
    if (!enabled || event.sessionId !== sessionId) return
    setState((current) => ({
      ...current,
      draft: event.snapshot,
      displayDocument:
        current.displayBinding.state === 'committed'
          ? (event.snapshot?.document ?? current.document)
          : current.displayDocument,
      selection: event.snapshot?.document.selections ?? current.document?.selections ?? []
    }))
  })

  const setSelection = useCallback(
    async (atomIds: readonly string[]): Promise<MoleculeDocument | null> => {
      const document = state.document
      if (!document || state.selecting || new Set(atomIds).size !== atomIds.length) return null

      setState((current) => ({ ...current, failed: false, selecting: true }))
      try {
        const selectedDocument = await ipcApi.request('chemsmart_studio.molecule.set_selection', {
          sessionId,
          documentId: document.documentId,
          expectedRevision: document.revision,
          atomIds: [...atomIds]
        })
        setState((current) => ({
          ...current,
          document: current.draft ? current.document : selectedDocument,
          draft: current.draft ? { ...current.draft, document: selectedDocument } : current.draft,
          displayDocument: current.displayBinding.state === 'committed' ? selectedDocument : current.displayDocument,
          selection: selectedDocument.selections,
          selecting: false
        }))
        return selectedDocument
      } catch (error) {
        setState((current) => ({ ...current, failed: true, selecting: false }))
        logger.error('Failed to set the molecule selection', error as Error)
        return null
      }
    },
    [sessionId, state.document, state.selecting]
  )

  const proposePatch = useCallback(
    async (
      mode: ChemSmartStudioPatchMode,
      operations: readonly MoleculeOperation[],
      gesture?: StageGestureIntent
    ): Promise<StudioDraftSnapshot | null> => {
      const revision = state.document?.revision
      if (revision === undefined || state.proposing || operations.length === 0) return null

      setState((current) => ({ ...current, failed: false, proposing: true }))
      try {
        const draft = await ipcApi.request('chemsmart_studio.molecule.draft_apply', {
          sessionId,
          expectedRevision: revision,
          mode,
          operations: [...operations],
          ...(gesture ? { gesture } : {})
        })
        setState((current) => ({
          ...current,
          draft,
          displayDocument: current.displayBinding.state === 'committed' ? draft.document : current.displayDocument,
          selection: draft.document.selections
        }))
        return draft
      } catch (error) {
        setState((current) => ({ ...current, failed: true }))
        logger.error('Failed to propose a molecule change', error as Error)
        return null
      } finally {
        setState((current) => ({ ...current, proposing: false }))
      }
    },
    [sessionId, state.document?.revision, state.proposing]
  )

  /**
   * Walks the researcher's own history. Main publishes the restored geometry as a *new* revision
   * rather than rewinding to an old number, so the document returned here is safe to propose against
   * immediately — nothing downstream has to know an undo happened.
   */
  const travel = useCallback(
    async (direction: 'undo' | 'redo'): Promise<MoleculeDocument | null> => {
      if (state.traveling) return null

      setState((current) => ({ ...current, failed: false, traveling: true }))
      try {
        if (state.draft) {
          const draft =
            direction === 'undo'
              ? await ipcApi.request('chemsmart_studio.molecule.draft_undo', { sessionId })
              : await ipcApi.request('chemsmart_studio.molecule.draft_redo', { sessionId })
          setState((current) => ({
            ...current,
            draft,
            displayDocument:
              current.displayBinding.state === 'committed'
                ? (draft?.document ?? current.document)
                : current.displayDocument,
            selection: draft?.document.selections ?? current.document?.selections ?? [],
            traveling: false
          }))
          return draft?.document ?? state.document
        }
        const document =
          direction === 'undo'
            ? await ipcApi.request('chemsmart_studio.molecule.undo', { sessionId })
            : await ipcApi.request('chemsmart_studio.molecule.redo', { sessionId })
        setState((current) => ({
          ...current,
          document,
          displayDocument: current.displayBinding.state === 'committed' ? document : current.displayDocument,
          selection: document.selections,
          traveling: false
        }))
        return document
      } catch (error) {
        setState((current) => ({ ...current, failed: true, traveling: false }))
        logger.error(`Failed to ${direction} the molecule`, error as Error)
        return null
      }
    },
    [sessionId, state.document, state.draft, state.traveling]
  )

  const undo = useCallback(() => travel('undo'), [travel])
  const redo = useCallback(() => travel('redo'), [travel])

  const commitDraft = useCallback(async (): Promise<MoleculeDocument | null> => {
    const revision = state.document?.revision
    if (revision === undefined || state.traveling) return null
    setState((current) => ({ ...current, failed: false, traveling: true }))
    try {
      const document = await ipcApi.request('chemsmart_studio.molecule.draft_commit', {
        sessionId,
        expectedRevision: revision
      })
      setState((current) => ({
        ...current,
        document,
        draft: null,
        displayDocument: current.displayBinding.state === 'committed' ? document : current.displayDocument,
        selection: document.selections,
        traveling: false
      }))
      return document
    } catch (error) {
      setState((current) => ({ ...current, failed: true, traveling: false }))
      logger.error('Failed to apply the molecule draft', error as Error)
      return null
    }
  }, [sessionId, state.document?.revision, state.traveling])

  const discardDraft = useCallback(async (): Promise<MoleculeDocument | null> => {
    if (state.traveling) return null
    setState((current) => ({ ...current, failed: false, traveling: true }))
    try {
      const document = await ipcApi.request('chemsmart_studio.molecule.draft_discard', { sessionId })
      setState((current) => ({
        ...current,
        document,
        draft: null,
        displayDocument: current.displayBinding.state === 'committed' ? document : current.displayDocument,
        selection: document.selections,
        traveling: false
      }))
      return document
    } catch (error) {
      setState((current) => ({ ...current, failed: true, traveling: false }))
      logger.error('Failed to discard the molecule draft', error as Error)
      return null
    }
  }, [sessionId, state.traveling])

  return { ...state, commitDraft, discardDraft, proposePatch, redo, refresh, setSelection, undo }
}
