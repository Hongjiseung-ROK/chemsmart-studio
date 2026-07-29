import type { MoleculeDocument, MoleculeOperation } from '@chemsmart/studio-protocol'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Alert, Badge, Button } from '@cherrystudio/ui'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { ConstraintPanel } from './ConstraintPanel'
import { type CoordinateEdit, CoordinateTable } from './CoordinateTable'
import { elementSymbol } from './elementSymbols'
import { MeasurePanel } from './MeasurePanel'
import type { StudioLayoutTier } from './useContainerTier'
import type { useMoleculeDocument } from './useMoleculeDocument'
import type { WorkbenchMode, WorkbenchModeContract } from './useWorkbenchMode'

function trustedXyz(document: MoleculeDocument): string {
  return [
    String(document.atoms.length),
    `ChemSmart Studio document=${document.documentId} revision=${document.revision}`,
    ...document.atoms.map(
      (atom) => `${elementSymbol(atom.atomicNumber)} ${atom.position.map((coordinate) => String(coordinate)).join(' ')}`
    )
  ].join('\n')
}

interface MoleculeInspectorProps {
  /** Atoms the Agent last pointed at; the table marks them. */
  agentAtomIds: readonly string[]
  contract: WorkbenchModeContract
  /** False while a preview or a run owns the molecule; the geometry is then read-only. */
  editable: boolean
  mode: WorkbenchMode
  molecule: ReturnType<typeof useMoleculeDocument>
  /** Selection remains safe while a run owns only the displayed coordinates. */
  selectable: boolean
  tier: StudioLayoutTier
}

/**
 * The researcher's own editing surface: committed coordinates, elements, bonds, and canonical selection,
 * with no agent involved. Structural changes leave as approval-bound previews; selection never advances
 * the molecule revision.
 */
export function MoleculeInspector({
  agentAtomIds,
  contract,
  editable,
  mode,
  molecule,
  selectable,
  tier
}: MoleculeInspectorProps) {
  const { t } = useTranslation()
  const document = molecule.document
  const selection = molecule.selection
  const interactionBusy = molecule.proposing || molecule.selecting
  const canPropose = editable && !interactionBusy
  const allows = (operation: MoleculeOperation['op']) => contract.allowedOperations.includes(operation)
  const canMove = canPropose && allows('set_positions')
  const canFreeze = canPropose && allows('set_frozen_axes')
  const canConstrain = canPropose && allows('set_constraints') && allows('remove_constraints')
  const canSelect = selectable && !interactionBusy && mode !== 'replay'
  const patchMode = mode === 'run' || mode === 'replay' ? null : mode

  const propose = useCallback(
    (operations: readonly MoleculeOperation[]) => {
      if (!patchMode) return
      void molecule.proposePatch(patchMode, operations)
    },
    [molecule, patchMode]
  )

  const changePosition = useCallback(
    ({ atomId, axis, value }: CoordinateEdit) => {
      const atom = document?.atoms.find((candidate) => candidate.id === atomId)
      if (!atom) return
      const position: [number, number, number] = [...atom.position]
      position[axis] = value
      propose([{ op: 'set_positions', positions: [{ atomId, position }] }])
    },
    [document, propose]
  )

  const freezeAxis = useCallback(
    ({ atomId, axis, frozen }: { atomId: string; axis: 0 | 1 | 2; frozen: boolean }) => {
      const current = document?.frozenAxes[atomId] ?? [false, false, false]
      const axes: [boolean, boolean, boolean] = [...current]
      axes[axis] = frozen
      propose([{ op: 'set_frozen_axes', masks: [{ atomId, axes }] }])
    },
    [document, propose]
  )

  if (molecule.loading && !document) {
    return (
      <div
        aria-live="polite"
        className="flex cursor-progress items-center gap-2 p-3 text-foreground-secondary text-sm"
        data-loading="true"
        role="status">
        <LoaderCircle aria-hidden className="size-4 animate-spin text-info motion-reduce:animate-none" />
        <span>{t('chemsmart_studio.coordinates.loading')}</span>
      </div>
    )
  }

  if (!document) {
    return (
      <div className="space-y-2 p-3">
        <p className="text-foreground-secondary text-sm">{t('chemsmart_studio.coordinates.unavailable')}</p>
        <Button size="sm" variant="outline" onClick={() => void molecule.refresh()}>
          <RotateCcw aria-hidden className="size-3.5" />
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 p-3" data-testid="molecule-inspector">
      {molecule.failed ? (
        <Alert message={t('chemsmart_studio.coordinates.proposal_failed')} role="alert" showIcon type="error" />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{document.documentId}</Badge>
        <Badge variant="outline">
          {t('chemsmart_studio.workspace.revision_value', { revision: document.revision })}
        </Badge>
      </div>

      {mode === 'measure' ? (
        <MeasurePanel document={document} editable={canMove} selection={selection} onPropose={propose} />
      ) : null}

      {mode === 'constrain' ? (
        <ConstraintPanel document={document} editable={canConstrain} selection={selection} onPropose={propose} />
      ) : null}

      <CoordinateTable
        agentAtomIds={agentAtomIds}
        document={document}
        freezeEditable={canFreeze}
        positionEditable={canMove}
        selectable={canSelect}
        selection={selection}
        tier={tier}
        onFreezeAxis={freezeAxis}
        onPositionChange={changePosition}
        onSelectionChange={(atomIds) => void molecule.setSelection(atomIds)}
      />

      <div className="rounded-md border border-border px-2">
        <Accordion collapsible type="single">
          <AccordionItem className="border-0" value="trusted-xyz">
            <AccordionTrigger className="py-2.5 font-medium">
              {t('chemsmart_studio.coordinates.xyz_title')}
            </AccordionTrigger>
            <AccordionContent className="pb-2" contentClassName="motion-reduce:animate-none">
              <p className="mb-2 text-foreground-secondary text-xs">
                {t('chemsmart_studio.coordinates.xyz_description')}
              </p>
              <pre
                aria-label={t('chemsmart_studio.coordinates.xyz_title')}
                className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-foreground text-xs"
                data-testid="trusted-xyz-preview">
                <code>{trustedXyz(document)}</code>
              </pre>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  )
}
