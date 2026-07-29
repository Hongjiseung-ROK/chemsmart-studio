import type { MoleculeAtom, MoleculeDocument } from '@chemsmart/studio-protocol'
import { Badge, Checkbox, EditableNumber } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { useTranslation } from 'react-i18next'

import { elementPillClassName, elementSymbol } from './elementSymbols'
import type { StudioLayoutTier } from './useContainerTier'

/** Coordinates are angstrom throughout the protocol; four decimals is the usual reporting precision. */
const POSITION_PRECISION = 4
const AXES = [0, 1, 2] as const

export interface CoordinateEdit {
  atomId: string
  axis: 0 | 1 | 2
  value: number
}

interface CoordinateTableProps {
  /** Atoms the Agent last pointed at, marked with text and a bar so colour is never the only signal. */
  agentAtomIds: readonly string[]
  document: MoleculeDocument
  /** True only when this mode may propose frozen-axis changes. */
  freezeEditable: boolean
  /** True only when this mode may propose coordinate changes. */
  positionEditable: boolean
  /** False while a preview/replay owns the view or the mode has no committed-selection surface. */
  selectable: boolean
  /** Atom ids the researcher has selected, mirrored from trusted molecule state. */
  selection: readonly string[]
  tier: StudioLayoutTier
  onFreezeAxis: (edit: { atomId: string; axis: 0 | 1 | 2; frozen: boolean }) => void
  onPositionChange: (edit: CoordinateEdit) => void
  onSelectionChange: (atomIds: readonly string[]) => void
}

function axisLabel(axis: 0 | 1 | 2): 'x' | 'y' | 'z' {
  return axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'
}

/**
 * The committed geometry as checkable, copyable rows: stable atom id, element, angstrom coordinates,
 * formal charge, and per-axis freezing. Row selection and native selection are the same selection, so
 * picking a row here is picking the atom in the editor.
 */
export function CoordinateTable({
  agentAtomIds,
  document: molecule,
  freezeEditable,
  positionEditable,
  selectable,
  selection,
  tier,
  onFreezeAxis,
  onPositionChange,
  onSelectionChange
}: CoordinateTableProps) {
  const { t } = useTranslation()
  const showCharge = tier !== 'viewport-only'
  const showFrozen = tier !== 'viewport-only'
  const selected = new Set(selection)
  const agentTouched = new Set(agentAtomIds)

  const toggleAtom = (atom: MoleculeAtom, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(atom.id)
    else next.delete(atom.id)
    onSelectionChange([...next])
  }

  if (molecule.atoms.length === 0) {
    return (
      <p className="rounded-md border border-border border-dashed px-3 py-6 text-center text-foreground-muted text-sm">
        {t('chemsmart_studio.coordinates.empty')}
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="coordinate-table">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">
          {t('chemsmart_studio.coordinates.atom_count', { count: molecule.atoms.length })}
        </Badge>
        <Badge variant="outline">{t('chemsmart_studio.coordinates.selected_count', { count: selection.length })}</Badge>
        <Badge variant="outline">{t('chemsmart_studio.coordinates.unit_notice')}</Badge>
        {positionEditable || freezeEditable ? null : (
          <Badge variant="secondary">{t('chemsmart_studio.workspace.read_only')}</Badge>
        )}
      </div>
      {/*
        Coordinates are the measurement, so they are never squeezed: the table keeps its natural width and
        the container scrolls instead of clipping digits off a number.
      */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-left text-xs">
          <caption className="sr-only">{t('chemsmart_studio.coordinates.caption')}</caption>
          <thead>
            <tr className="border-border border-b text-foreground-muted">
              <th className="w-8 px-1 py-1.5 font-medium" scope="col">
                <span className="sr-only">{t('chemsmart_studio.coordinates.select')}</span>
              </th>
              <th className="px-1 py-1.5 font-medium" scope="col">
                {t('chemsmart_studio.coordinates.atom')}
              </th>
              {AXES.map((axis) => (
                <th className="px-1 py-1.5 font-medium" key={axis} scope="col">
                  {axisLabel(axis)}
                </th>
              ))}
              {showCharge ? (
                <th className="px-1 py-1.5 font-medium" scope="col">
                  {t('chemsmart_studio.coordinates.charge')}
                </th>
              ) : null}
              {showFrozen ? (
                <th className="px-1 py-1.5 font-medium" scope="col">
                  {t('chemsmart_studio.coordinates.frozen')}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="font-mono">
            {molecule.atoms.map((atom) => {
              const frozen = molecule.frozenAxes[atom.id] ?? [false, false, false]
              const isSelected = selected.has(atom.id)
              const isAgentTouched = agentTouched.has(atom.id)
              return (
                <tr
                  className={cn(
                    'border-border-muted border-b',
                    isSelected && 'bg-secondary/40',
                    isAgentTouched && 'border-l-2 border-l-info bg-info/8'
                  )}
                  data-agent-touched={isAgentTouched || undefined}
                  data-atom-id={atom.id}
                  data-selected={isSelected}
                  key={atom.id}>
                  <td className="px-1 py-1">
                    <Checkbox
                      aria-label={t('chemsmart_studio.coordinates.select_atom', { atomId: atom.id })}
                      checked={isSelected}
                      disabled={!selectable}
                      onCheckedChange={(checked) => toggleAtom(atom, checked === true)}
                    />
                  </td>
                  <th className="px-1 py-1 font-medium" scope="row">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-sans text-[11px]',
                          elementPillClassName(atom.atomicNumber)
                        )}>
                        {elementSymbol(atom.atomicNumber)}
                      </span>
                      <span className="text-foreground">{atom.id}</span>
                      {isAgentTouched ? (
                        <span className="font-sans text-[11px] text-info">
                          {t('chemsmart_studio.coordinates.agent_touched')}
                        </span>
                      ) : null}
                    </span>
                  </th>
                  {AXES.map((axis) => (
                    <td className="px-1 py-1" key={axis}>
                      <EditableNumber
                        align="end"
                        aria-label={t('chemsmart_studio.coordinates.position_field', {
                          atomId: atom.id,
                          axis: axisLabel(axis)
                        })}
                        // Wide enough for a signed four-decimal angstrom value, in figure-width digits.
                        className="w-[86px] tabular-nums"
                        disabled={!positionEditable || frozen[axis]}
                        precision={POSITION_PRECISION}
                        size="small"
                        step={0.01}
                        value={atom.position[axis]}
                        onChange={(value) => {
                          if (value === null || value === atom.position[axis]) return
                          onPositionChange({ atomId: atom.id, axis, value })
                        }}
                      />
                    </td>
                  ))}
                  {showCharge ? <td className="px-1 py-1 text-foreground-secondary">{atom.formalCharge}</td> : null}
                  {showFrozen ? (
                    <td className="px-1 py-1">
                      <span className="flex items-center gap-1">
                        {AXES.map((axis) => (
                          <Checkbox
                            aria-label={t('chemsmart_studio.coordinates.freeze_axis', {
                              atomId: atom.id,
                              axis: axisLabel(axis)
                            })}
                            checked={frozen[axis]}
                            disabled={!freezeEditable}
                            key={axis}
                            onCheckedChange={(checked) =>
                              onFreezeAxis({ atomId: atom.id, axis, frozen: checked === true })
                            }
                          />
                        ))}
                      </span>
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
