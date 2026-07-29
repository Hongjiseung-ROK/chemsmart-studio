import type { MoleculeDocument, MoleculeOperation } from '@chemsmart/studio-protocol'
import { Badge, Button, EditableNumber, Slider } from '@cherrystudio/ui'
import { Ruler } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { measureSelection, positionForMeasurement } from './moleculeGeometry'

const ANGLE_RANGE = 180
const DISTANCE_MAX = 5

interface MeasurePanelProps {
  document: MoleculeDocument
  /** False while a preview or a run owns the molecule, so a measurement stays read-only. */
  editable: boolean
  /** Ordered selection: two atoms measure a distance, three an angle, four a dihedral. */
  selection: readonly string[]
  onPropose: (operations: readonly MoleculeOperation[]) => void
}

/**
 * Distance, angle, and dihedral for the ordered selection, with the value editable. Adjusting it moves
 * only the last selected atom, and the change leaves as a preview like every other edit.
 */
export function MeasurePanel({ document: molecule, editable, selection, onPropose }: MeasurePanelProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<number | null>(null)
  const measurement = measureSelection(molecule.atoms, selection)

  if (!measurement) {
    return (
      <p className="rounded-md border border-border border-dashed px-3 py-6 text-center text-foreground-muted text-sm">
        {t('chemsmart_studio.measure.empty')}
      </p>
    )
  }

  const isDistance = measurement.kind === 'distance'
  const unit = isDistance ? t('chemsmart_studio.measure.angstrom') : t('chemsmart_studio.measure.degree')
  const target = draft ?? measurement.value
  const movedAtomId = measurement.atomIds[measurement.atomIds.length - 1]

  const apply = () => {
    const moved = positionForMeasurement(molecule.atoms, measurement, target)
    if (!moved) return
    onPropose([{ op: 'set_positions', positions: [{ atomId: moved.atomId, position: [...moved.position] }] }])
    setDraft(null)
  }

  return (
    <div className="space-y-3" data-testid="measure-panel">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge className="gap-1.5" variant="outline">
          <Ruler aria-hidden className="size-3.5" />
          {t(`chemsmart_studio.measure.kind.${measurement.kind}`)}
        </Badge>
        <Badge variant="outline">{measurement.atomIds.join(' → ')}</Badge>
      </div>

      <p className="font-medium text-foreground text-sm">
        <span className="font-mono">{measurement.value.toFixed(isDistance ? 4 : 2)}</span> {unit}
      </p>

      <div className="space-y-2">
        <p className="font-medium text-foreground text-xs">{t('chemsmart_studio.measure.target', { unit })}</p>
        <div className="flex items-center gap-2">
          <Slider
            aria-label={t('chemsmart_studio.measure.target', { unit })}
            className="flex-1"
            disabled={!editable}
            max={isDistance ? DISTANCE_MAX : ANGLE_RANGE}
            min={isDistance ? 0.5 : measurement.kind === 'angle' ? 0 : -ANGLE_RANGE}
            step={isDistance ? 0.01 : 0.1}
            value={[target]}
            onValueChange={([next]) => setDraft(next)}
          />
          <EditableNumber
            aria-label={t('chemsmart_studio.measure.target', { unit })}
            disabled={!editable}
            precision={isDistance ? 4 : 2}
            size="small"
            step={isDistance ? 0.01 : 0.1}
            value={target}
            onChange={(next) => setDraft(next)}
          />
        </div>
        <p className="text-foreground-muted text-xs">
          {t('chemsmart_studio.measure.moves_only', { atomId: movedAtomId })}
        </p>
        <div className="flex justify-end gap-2">
          <Button disabled={draft === null} size="sm" variant="ghost" onClick={() => setDraft(null)}>
            {t('chemsmart_studio.measure.reset')}
          </Button>
          <Button disabled={!editable || draft === null} size="sm" onClick={apply}>
            {t('chemsmart_studio.measure.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}
