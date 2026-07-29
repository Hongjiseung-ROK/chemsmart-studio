import { MoleculeCanvas, type Vec3 } from '@chemsmart/molecular-engine'
import type { MoleculeOperation, StageGestureIntent } from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Tooltip } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { Atom, Frame, Lock, type LucideIcon, MousePointer2, Move3D, Redo2, Rotate3D, Ruler, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type CoordinationGeometry, MoleculeBuildTools } from './MoleculeBuildTools'
import { positionForNextCoordinationSite } from './moleculePlacement'
import type { useMoleculeDocument } from './useMoleculeDocument'
import type { WorkbenchMode, WorkbenchModeContract } from './useWorkbenchMode'

const logger = loggerService.withContext('MoleculeStage')

/** The two things a pointer can mean on the canvas. Both reuse the existing molecule-tool wording. */
const STAGE_TOOLS = ['select', 'manipulate', 'rotate'] as const
type StageTool = (typeof STAGE_TOOLS)[number]

const TOOL_ICONS: Record<StageTool, LucideIcon> = {
  select: MousePointer2,
  manipulate: Move3D,
  rotate: Rotate3D
}
const INSERT_BOND_LENGTH = 1.5

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
  selectable
}: MoleculeStageProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<MoleculeCanvas | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [tool, setTool] = useState<StageTool>('select')
  const [atomicNumber, setAtomicNumber] = useState(6)
  const [bondOrder, setBondOrder] = useState<1 | 2 | 3>(1)
  const [coordination, setCoordination] = useState<CoordinationGeometry>('tetrahedral')
  const [insertionMode, setInsertionMode] = useState(true)

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
  const canSelect = selectable && !busy && mode !== 'replay' && tool === 'select' && !insertionMode
  const canTravel = editable && !busy && document !== null
  const gizmoActive = tool === 'manipulate' && canMove

  const handlePick = useCallback(
    (atomId: string | null, additive: boolean, emptyPosition: Vec3 | null) => {
      if (canInsert && insertionMode && document) {
        const anchor = atomId ? document.atoms.find((atom) => atom.id === atomId) : undefined
        const base = anchor?.position ?? emptyPosition ?? [0, 0, 0]
        const position: Vec3 = anchor
          ? [...positionForNextCoordinationSite(document, anchor.id, coordination, INSERT_BOND_LENGTH)]
          : [base[0], base[1], base[2]]
        const insertedAtomId = `atom-${crypto.randomUUID()}`
        const operations: MoleculeOperation[] = [
          {
            op: 'add_atoms',
            atoms: [
              {
                id: insertedAtomId,
                atomicNumber,
                position,
                formalCharge: 0,
                extensions: {}
              }
            ]
          }
        ]
        if (anchor && contract.allowedOperations.includes('add_bonds')) {
          operations.push({
            op: 'add_bonds',
            bonds: [
              {
                id: `bond-${crypto.randomUUID()}`,
                atomIds: [anchor.id, insertedAtomId],
                order: bondOrder,
                extensions: {}
              }
            ]
          })
        }
        const gesture: StageGestureIntent = {
          gestureId: `gesture-${crypto.randomUUID()}`,
          kind: 'insert_atom',
          atomicNumber,
          ...(anchor ? { anchorAtomId: anchor.id, bondOrder } : {}),
          position,
          createdAt: new Date().toISOString(),
          extensions: {}
        }
        void molecule.proposePatch('build', operations, gesture).then((draft) => {
          if (draft) void molecule.setSelection([insertedAtomId])
        })
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
      selection
    ]
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
  const gesturesRef = useRef({ handleAtomMoved, handlePick })
  useEffect(() => {
    gesturesRef.current = { handleAtomMoved, handlePick }
  }, [handleAtomMoved, handlePick])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    let engine: MoleculeCanvas
    try {
      engine = new MoleculeCanvas(canvas, {
        onAtomMoved: (atomId, position) => gesturesRef.current.handleAtomMoved(atomId, position),
        onPick: (atomId, additive, emptyPosition) => gesturesRef.current.handlePick(atomId, additive, emptyPosition)
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
    // One atom moves at a time: a gizmo over a multi-atom pick would have no single origin to drag.
    engineRef.current?.setGizmoTarget(selection.length === 1 ? selection[0] : null)
  }, [gizmoActive, selection])

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
        <Tooltip title={t('chemsmart_studio.workspace.mode.build')}>
          <Button
            aria-label={t('chemsmart_studio.workspace.mode.build')}
            aria-pressed={mode === 'build'}
            className="size-8 shrink-0"
            disabled={!editable}
            size="icon-sm"
            variant={mode === 'build' ? 'secondary' : 'ghost'}
            onClick={() => {
              setTool('select')
              setInsertionMode(false)
              onModeChange('build')
            }}>
            <Atom aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        {STAGE_TOOLS.map((stageTool) => {
          const ToolIcon = TOOL_ICONS[stageTool]
          const label = t(`chemsmart_studio.stage.tools.${stageTool}.label`)
          const active = tool === stageTool
          return (
            <Tooltip key={stageTool} title={t(`chemsmart_studio.stage.tools.${stageTool}.description`)}>
              <Button
                aria-label={label}
                aria-pressed={active}
                className="size-8 shrink-0"
                data-testid={`stage-tool-${stageTool}`}
                disabled={stageTool === 'manipulate' && !canMove}
                size="icon-sm"
                variant={active ? 'secondary' : 'ghost'}
                onClick={() => {
                  setTool(stageTool)
                  setInsertionMode(false)
                }}>
                <ToolIcon aria-hidden className="size-4" />
              </Button>
            </Tooltip>
          )
        })}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border-muted" />
        <Tooltip title={t('chemsmart_studio.workspace.mode.measure')}>
          <Button
            aria-label={t('chemsmart_studio.workspace.mode.measure')}
            aria-pressed={mode === 'measure'}
            className="size-8 shrink-0"
            size="icon-sm"
            variant={mode === 'measure' ? 'secondary' : 'ghost'}
            onClick={() => {
              setTool('select')
              setInsertionMode(false)
              onModeChange('measure')
            }}>
            <Ruler aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip title={t('chemsmart_studio.workspace.mode.constrain')}>
          <Button
            aria-label={t('chemsmart_studio.workspace.mode.constrain')}
            aria-pressed={mode === 'constrain'}
            className="size-8 shrink-0"
            size="icon-sm"
            variant={mode === 'constrain' ? 'secondary' : 'ghost'}
            onClick={() => {
              setTool('select')
              setInsertionMode(false)
              onModeChange('constrain')
            }}>
            <Lock aria-hidden className="size-4" />
          </Button>
        </Tooltip>
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
            setInsertionMode(active)
            if (active) setTool('select')
          }}
          onPropose={proposeOperations}
        />
      ) : null}

      <div ref={containerRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block size-full" data-testid="molecule-canvas" />

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
