import type { MoleculeConstraint, MoleculeDocument, MoleculeOperation } from '@chemsmart/studio-protocol'
import { Badge, Button, EditableNumber } from '@cherrystudio/ui'
import { Lock, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { measureSelection } from './moleculeGeometry'

interface ConstraintPanelProps {
  document: MoleculeDocument
  editable: boolean
  /** Ordered selection: its length decides which constraint kind can be added. */
  selection: readonly string[]
  onPropose: (operations: readonly MoleculeOperation[]) => void
}

function constraintUnitKey(constraint: MoleculeConstraint): string {
  return constraint.unit === 'angstrom' ? 'chemsmart_studio.measure.angstrom' : 'chemsmart_studio.measure.degree'
}

/**
 * Holds a distance, angle, or torsion at a value, and lists the constraints the committed molecule
 * already carries. The selection decides which kind can be added, so a constraint always matches its
 * atom count.
 */
export function ConstraintPanel({ document: molecule, editable, selection, onPropose }: ConstraintPanelProps) {
  const { t } = useTranslation()
  const measurement = measureSelection(molecule.atoms, selection)
  const [target, setTarget] = useState<number | null>(null)

  const addConstraint = () => {
    if (!measurement) return
    const value = target ?? measurement.value
    // The unit belongs to the constraint kind, so a distance can never be recorded in degrees.
    const constraint = {
      id: `constraint-${crypto.randomUUID()}`,
      type: measurement.kind,
      atomIds: [...measurement.atomIds],
      target: value,
      unit: measurement.kind === 'distance' ? 'angstrom' : 'degree',
      extensions: {}
    } as MoleculeConstraint
    onPropose([{ op: 'set_constraints', constraints: [constraint] }])
    setTarget(null)
  }

  return (
    <div className="space-y-3" data-testid="constraint-panel">
      <section aria-labelledby="chemsmart-constraint-add" className="space-y-2">
        <h4 className="font-medium text-foreground text-xs" id="chemsmart-constraint-add">
          {t('chemsmart_studio.constraints.add_title')}
        </h4>
        {measurement ? (
          <div className="flex flex-wrap items-end gap-2">
            <Badge className="gap-1.5" variant="outline">
              <Lock aria-hidden className="size-3.5" />
              {t(`chemsmart_studio.measure.kind.${measurement.kind}`)}
            </Badge>
            <Badge variant="outline">{measurement.atomIds.join(' → ')}</Badge>
            <EditableNumber
              aria-label={t('chemsmart_studio.constraints.target')}
              disabled={!editable}
              precision={measurement.kind === 'distance' ? 4 : 2}
              size="small"
              step={measurement.kind === 'distance' ? 0.01 : 0.1}
              value={target ?? measurement.value}
              onChange={setTarget}
            />
            <Button disabled={!editable} size="sm" onClick={addConstraint}>
              {t('chemsmart_studio.constraints.add')}
            </Button>
          </div>
        ) : (
          <p className="text-foreground-muted text-xs">{t('chemsmart_studio.constraints.select_first')}</p>
        )}
      </section>

      <section aria-labelledby="chemsmart-constraint-list" className="space-y-2">
        <h4 className="font-medium text-foreground text-xs" id="chemsmart-constraint-list">
          {t('chemsmart_studio.constraints.list_title', { count: molecule.constraints.length })}
        </h4>
        {molecule.constraints.length === 0 ? (
          <p className="text-foreground-muted text-xs">{t('chemsmart_studio.constraints.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {molecule.constraints.map((constraint) => (
              <li
                className="flex items-center justify-between gap-2 rounded-md border border-border-subtle px-2 py-1.5 text-xs"
                key={constraint.id}>
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{t(`chemsmart_studio.measure.kind.${constraint.type}`)}</Badge>
                  <span className="font-mono text-foreground">{constraint.atomIds.join(' → ')}</span>
                  <span className="font-mono text-foreground-secondary">
                    {constraint.target} {t(constraintUnitKey(constraint))}
                  </span>
                </span>
                <Button
                  aria-label={t('chemsmart_studio.constraints.remove', { id: constraint.id })}
                  disabled={!editable}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => onPropose([{ op: 'remove_constraints', constraintIds: [constraint.id] }])}>
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
