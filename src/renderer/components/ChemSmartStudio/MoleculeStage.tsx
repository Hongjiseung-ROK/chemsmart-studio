import { MoleculeCanvas, type Vec3 } from '@chemsmart/molecular-engine'
import type {
  MoleculeOperation,
  StageGestureIntent,
  StagePlacementPreview,
  StudioAgentActionCue
} from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Tooltip } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { Atom, Frame, Lock, type LucideIcon, MousePointer2, Move3D, Redo2, Rotate3D, Ruler, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type CoordinationGeometry, MoleculeBuildTools } from './MoleculeBuildTools'
import { cyclePlacementSite } from './moleculePlacement'
import type { useMoleculeDocument } from './useMoleculeDocument'
import type { WorkbenchMode, WorkbenchModeContract } from './useWorkbenchMode'

const logger = loggerService.withContext('MoleculeStage')

/** The two things a pointer can mean on the canvas. Both reuse the existing molecule-tool wording. */
const STAGE_TOOLS = ['build', 'select', 'move', 'rotate', 'measure', 'constrain'] as const
type StageTool = (typeof STAGE_TOOLS)[number]

const TOOL_ICONS: Record<StageTool, LucideIcon> = {
  build: Atom,
  select: MousePointer2,
  move: Move3D,
  rotate: Rotate3D,
  measure: Ruler,
  constrain: Lock
}

interface MoleculeStageProps {
  compact?: boolean
  contract: WorkbenchModeContract
  /** False while a preview, a run or an approval owns the molecule; gestures are then read-only. */
  editable: boolean
  mode: WorkbenchMode
  molecule: ReturnType<typeof useMoleculeDocument>
  onModeChange: (mode: WorkbenchMode) => void
  /** Selection remains safe while a run owns only the displayed coordinates. */
  selectable: boolean
  actionCues?: readonly StudioAgentActionCue[]
  reduceMotion?: boolean
}

/**
 * Draws the committed molecule or its main-owned draft with the in-renderer Three.js engine, and
 * turns pointer gestures into typed draft intents.
 *
 * This replaces the composited native surface: there is no process to attach, no transport to
 * negotiate, no window to keep on top, and no frame to trust — the stage renders the same
 * `MoleculeDocument` the coordinate table and the inspector already read, so they cannot disagree.
 *
 * A gesture is never applied here. Main validates and journals the resulting operation before the
 * draft document comes back to the renderer.
 */
export function MoleculeStage({
  compact = false,
  contract,
  editable,
  mode,
  molecule,
  onModeChange,
  selectable,
  actionCues = [],
  reduceMotion = false
}: MoleculeStageProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<MoleculeCanvas | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [tool, setTool] = useState<StageTool>('build')
  const [atomicNumber, setAtomicNumber] = useState(6)
  const [bondOrder, setBondOrder] = useState<1 | 2 | 3>(1)
  const [coordination, setCoordination] = useState<CoordinationGeometry>('tetrahedral')
  const [insertionMode, setInsertionMode] = useState(true)
  const [placementPreview, setPlacementPreview] = useState<StagePlacementPreview | null>(null)
  const [moveTargetAtomId, setMoveTargetAtomId] = useState<string | null>(null)

  const document = molecule.displayDocument
  const importProvenance = molecule.document?.extensions['chemsmart.import']
  const inferredImport =
    importProvenance?.topology === 'inferred' && typeof importProvenance.algorithm === 'string'
      ? importProvenance
      : null
  const selection = molecule.selection
  const busy = molecule.proposing || molecule.selecting || molecule.traveling
  // Run and replay own the molecule; neither has a patch mode to propose in.
  const patchMode = mode === 'run' || mode === 'replay' ? null : mode
  const canMove = editable && !busy && patchMode !== null && contract.allowedOperations.includes('set_positions')
  const canInsert = editable && !busy && mode === 'build' && contract.allowedOperations.includes('add_atoms')
  const canSelect =
    selectable &&
    !busy &&
    mode !== 'replay' &&
    (tool === 'select' || tool === 'measure' || tool === 'constrain') &&
    !insertionMode
  const canTravel = editable && !busy && document !== null
  const gizmoActive = tool === 'move' && canMove

  const activateStageTool = useCallback(
    (nextTool: StageTool) => {
      setTool(nextTool)
      setPlacementPreview(null)
      setMoveTargetAtomId(null)
      setInsertionMode(nextTool === 'build')
      if (selection.length > 0) void molecule.setSelection([])
      if (nextTool === 'measure' || nextTool === 'constrain' || nextTool === 'build') {
        onModeChange(nextTool)
      } else if (mode === 'measure' || mode === 'constrain') {
        onModeChange('build')
      }
    },
    [mode, molecule, onModeChange, selection.length]
  )

  const handlePick = useCallback(
    (atomId: string | null, additive: boolean, emptyPosition: Vec3 | null) => {
      if (canInsert && insertionMode && document && !placementPreview) {
        void molecule
          .previewPlacement({
            ...(atomId ? { anchorAtomId: atomId } : emptyPosition ? { origin: emptyPosition } : {}),
            atomicNumber,
            bondOrder,
            coordinationGeometry: coordination
          })
          .then(setPlacementPreview)
        return
      }
      if (tool === 'move' && canMove) {
        setMoveTargetAtomId(atomId)
        void molecule.setSelection(atomId ? [atomId] : [])
        return
      }
      if (!canSelect) return
      if (atomId === null) {
        if (selection.length > 0) void molecule.setSelection([])
        return
      }
      if (additive) {
        // Appending keeps click order, which measure mode reads as the atom sequence.
        void molecule.setSelection(
          selection.includes(atomId) ? selection.filter((id) => id !== atomId) : [...selection, atomId]
        )
        return
      }
      // A plain click means "only this atom"; clicking the lone selected atom again clears it.
      void molecule.setSelection(selection.length === 1 && selection[0] === atomId ? [] : [atomId])
    },
    [
      atomicNumber,
      bondOrder,
      canInsert,
      canSelect,
      contract.allowedOperations,
      coordination,
      document,
      insertionMode,
      molecule,
      placementPreview,
      tool,
      selection
    ]
  )

  const handlePlacementPick = useCallback(
    (siteIndex: number) => {
      const preview = placementPreview
      if (!preview) return
      void molecule.applyPlacement(preview, siteIndex).then((insertedAtomId) => {
        if (!insertedAtomId) return
        setPlacementPreview(null)
        void molecule.setSelection([insertedAtomId])
      })
    },
    [molecule, placementPreview]
  )

  const proposeOperations = useCallback(
    (operations: readonly MoleculeOperation[], gesture?: StageGestureIntent) => {
      if (!patchMode) return
      void molecule.proposePatch(patchMode, operations, gesture)
    },
    [molecule, patchMode]
  )

  const handleAtomMoved = useCallback(
    (atomId: string, position: Vec3) => {
      if (!canMove || !patchMode) return
      const operation: MoleculeOperation = {
        op: 'set_positions',
        positions: [{ atomId, position: [position[0], position[1], position[2]] }]
      }
      void molecule.proposePatch(patchMode, [operation], {
        gestureId: `gesture-${crypto.randomUUID()}`,
        kind: 'move_atom',
        anchorAtomId: atomId,
        position,
        createdAt: new Date().toISOString(),
        extensions: {}
      })
    },
    [canMove, molecule, patchMode]
  )

  // The engine is built once, so it reads the current gesture handlers through a ref rather than
  // closing over the first render's copies.
  const gesturesRef = useRef({ handleAtomMoved, handlePick, handlePlacementPick })
  useEffect(() => {
    gesturesRef.current = { handleAtomMoved, handlePick, handlePlacementPick }
  }, [handleAtomMoved, handlePick, handlePlacementPick])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    let engine: MoleculeCanvas
    try {
      engine = new MoleculeCanvas(canvas, {
        onAtomMoved: (atomId, position) => gesturesRef.current.handleAtomMoved(atomId, position),
        onPick: (atomId, additive, emptyPosition) => gesturesRef.current.handlePick(atomId, additive, emptyPosition),
        onPlacementPick: (siteIndex) => gesturesRef.current.handlePlacementPick(siteIndex)
      })
    } catch (error) {
      // A machine without a usable WebGL context must say so rather than show a blank rectangle.
      logger.error('Failed to start the molecule renderer', error as Error)
      setUnavailable(true)
      return
    }
    engineRef.current = engine

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      engine.resize(width, height)
    })
    observer.observe(container)
    engine.resize(container.clientWidth, container.clientHeight)

    return () => {
      observer.disconnect()
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    if (document) engineRef.current?.setDocument(document)
  }, [document])

  useEffect(() => {
    engineRef.current?.setTransformEnabled(gizmoActive)
  }, [gizmoActive])

  useEffect(() => {
    engineRef.current?.setGizmoTarget(gizmoActive ? moveTargetAtomId : null)
  }, [gizmoActive, moveTargetAtomId])

  useEffect(() => {
    engineRef.current?.setPlacementPreview(placementPreview)
  }, [placementPreview])

  useEffect(() => {
    engineRef.current?.setActionCues(actionCues, reduceMotion)
  }, [actionCues, reduceMotion])

  useEffect(() => {
    if (!placementPreview) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPlacementPreview(null)
        return
      }
      if (event.key !== 'Tab') return
      event.preventDefault()
      setPlacementPreview((current) => (current ? cyclePlacementSite(current, event.shiftKey ? -1 : 1) : current))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [placementPreview])

  const frameAll = useCallback(() => engineRef.current?.frameAll(), [])
  const displayLabel =
    molecule.displayBinding.state === 'committed'
      ? molecule.draft?.dirty
        ? t('chemsmart_studio.stage.draft_revision', {
            count: molecule.draft.cursor,
            revision: molecule.draft.baseRevision
          })
        : t('chemsmart_studio.stage.committed_revision', { revision: document?.revision ?? 0 })
      : t(`chemsmart_studio.stage.display.${molecule.displayBinding.state}`, {
          frame: molecule.displayBinding.frameIndex + 1
        })

  return (
    <section
      aria-labelledby="chemsmart-studio-stage-title"
      data-testid="molecule-stage"
      className={cn(
        'relative flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-card',
        compact ? 'rounded-none' : 'rounded-xl'
      )}>
      <header
        className={cn(
          'items-center justify-between gap-2 border-border border-b px-3 py-2',
          compact ? 'hidden' : 'flex'
        )}>
        <div className="flex items-center gap-2">
          <h3 id="chemsmart-studio-stage-title" className="font-medium text-foreground text-sm">
            {t('chemsmart_studio.stage.title')}
          </h3>
          <Badge data-testid="viewport-identity" variant="secondary">
            {document ? displayLabel : t('chemsmart_studio.stage.no_identity')}
          </Badge>
          {inferredImport ? (
            <Badge data-testid="molecule-import-inference" variant="outline">
              {t('chemsmart_studio.stage.import_inference', {
                algorithm: inferredImport.algorithm,
                version:
                  typeof inferredImport.algorithmVersion === 'string'
                    ? inferredImport.algorithmVersion
                    : t('common.unknown')
              })}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip title={t('chemsmart_studio.stage.undo')}>
            <Button
              aria-label={t('chemsmart_studio.stage.undo')}
              data-testid="molecule-undo"
              disabled={!canTravel}
              size="sm"
              variant="ghost"
              onClick={() => void molecule.undo()}>
              <Undo2 aria-hidden className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip title={t('chemsmart_studio.stage.redo')}>
            <Button
              aria-label={t('chemsmart_studio.stage.redo')}
              data-testid="molecule-redo"
              disabled={!canTravel}
              size="sm"
              variant="ghost"
              onClick={() => void molecule.redo()}>
              <Redo2 aria-hidden className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </header>

      <div
        aria-label={t('chemsmart_studio.stage.viewport_toolbar')}
        className={cn(
          'flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1',
          compact
            ? 'absolute top-2 right-2 left-2 z-20 rounded-md border border-border bg-card/95 shadow-sm backdrop-blur'
            : 'border-border border-b'
        )}
        data-testid="viewport-toolbar"
        role="toolbar">
        {STAGE_TOOLS.map((stageTool) => {
          const ToolIcon = TOOL_ICONS[stageTool]
          const translationKey =
            stageTool === 'build'
              ? 'chemsmart_studio.workspace.mode.build'
              : stageTool === 'measure' || stageTool === 'constrain'
                ? `chemsmart_studio.workspace.mode.${stageTool}`
                : stageTool === 'move'
                  ? 'chemsmart_studio.stage.tools.manipulate.label'
                  : `chemsmart_studio.stage.tools.${stageTool}.label`
          const label = t(translationKey)
          const active = tool === stageTool
          return (
            <Tooltip key={stageTool} title={label}>
              <Button
                aria-label={label}
                aria-pressed={active}
                className={cn('h-8 min-w-8 shrink-0 gap-1.5 px-2', compact && !active && 'w-8 px-0')}
                data-testid={stageTool === 'move' ? 'stage-tool-manipulate' : `stage-tool-${stageTool}`}
                disabled={(stageTool === 'move' && !canMove) || (stageTool === 'build' && !editable)}
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                onClick={() => activateStageTool(stageTool)}>
                <ToolIcon aria-hidden className="size-4" />
                {!compact || active ? <span>{label}</span> : null}
              </Button>
            </Tooltip>
          )
        })}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border-muted" />
        <Tooltip title={t('chemsmart_studio.stage.frame_all')}>
          <Button
            aria-label={t('chemsmart_studio.stage.frame_all')}
            className="size-8 shrink-0"
            disabled={!document || unavailable}
            size="icon-sm"
            variant="ghost"
            onClick={frameAll}>
            <Frame aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      </div>

      {molecule.failed ? (
        <div className="px-3 pt-2">
          <Alert message={t('chemsmart_studio.coordinates.proposal_failed')} role="alert" showIcon type="error" />
        </div>
      ) : null}

      {document && mode === 'build' ? (
        <MoleculeBuildTools
          atomicNumber={atomicNumber}
          bondOrder={bondOrder}
          compact={compact}
          coordination={coordination}
          contract={contract}
          document={document}
          editable={editable && !busy}
          insertionMode={insertionMode}
          selection={selection}
          onAtomicNumberChange={setAtomicNumber}
          onBondOrderChange={setBondOrder}
          onCoordinationChange={setCoordination}
          onInsertionModeChange={(active) => {
            if (active) activateStageTool('build')
            else setInsertionMode(false)
          }}
          onPropose={proposeOperations}
        />
      ) : null}

      <div ref={containerRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block size-full" data-testid="molecule-canvas" />
        {placementPreview ? (
          <div
            className={cn(
              'absolute right-3 bottom-3 rounded-md border px-3 py-2 text-xs shadow-sm backdrop-blur',
              placementPreview.status === 'ready'
                ? 'border-info/40 bg-info-bg text-info'
                : 'border-warning/40 bg-warning-bg text-warning'
            )}
            data-testid="placement-guide-status"
            role="status">
            {t(`chemsmart_studio.build.placement.${placementPreview.status}`)}
          </div>
        ) : null}

        {unavailable || !document ? (
          <div className="absolute inset-0 flex items-center justify-center bg-card/80 p-6 text-center">
            <p className="max-w-sm text-foreground-secondary text-sm">
              {unavailable ? t('chemsmart_studio.stage.unavailable') : t('chemsmart_studio.stage.empty')}
            </p>
          </div>
        ) : null}
      </div>

      {document && !compact ? (
        <footer
          className={cn(
            'flex items-center justify-between gap-2 border-border border-t px-3 py-1.5',
            'text-foreground-muted text-xs'
          )}>
          <span>{t('chemsmart_studio.stage.atom_count', { count: document.atoms.length })}</span>
          <span data-testid="stage-selection-count">
            {t('chemsmart_studio.coordinates.selected_count', { count: selection.length })}
          </span>
        </footer>
      ) : null}
    </section>
  )
}
