import type { MoleculeDocument, MoleculeOperation, StageGestureIntent } from '@chemsmart/studio-protocol'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@cherrystudio/ui'
import { ChevronDown, Pencil, Shapes, Trash2, Unlink } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { PeriodicTablePopover } from './PeriodicTablePopover'
import type { WorkbenchModeContract } from './useWorkbenchMode'

const BOND_ORDERS = [1, 2, 3] as const
export const coordinationGeometries = [
  'linear',
  'trigonal_planar',
  'tetrahedral',
  'square_planar',
  'octahedral'
] as const
export type CoordinationGeometry = (typeof coordinationGeometries)[number]
type BuilderFragment = 'water' | 'methane' | 'benzene'

const alternatingBondOrder = (index: number): 1 | 2 => (index % 2 === 0 ? 2 : 1)

interface FragmentTemplate {
  atoms: ReadonlyArray<{ atomicNumber: number; position: readonly [number, number, number] }>
  bonds: ReadonlyArray<{ atomIndexes: readonly [number, number]; order: 1 | 2 }>
}

const FRAGMENT_TEMPLATES: Readonly<Record<BuilderFragment, FragmentTemplate>> = {
  water: {
    atoms: [
      { atomicNumber: 8, position: [0, 0, 0] },
      { atomicNumber: 1, position: [0.9572, 0, 0] },
      { atomicNumber: 1, position: [-0.239, 0.927, 0] }
    ],
    bonds: [
      { atomIndexes: [0, 1], order: 1 },
      { atomIndexes: [0, 2], order: 1 }
    ]
  },
  methane: {
    atoms: [
      { atomicNumber: 6, position: [0, 0, 0] },
      { atomicNumber: 1, position: [0.63, 0.63, 0.63] },
      { atomicNumber: 1, position: [0.63, -0.63, -0.63] },
      { atomicNumber: 1, position: [-0.63, 0.63, -0.63] },
      { atomicNumber: 1, position: [-0.63, -0.63, 0.63] }
    ],
    bonds: [0, 1, 2, 3].map((hydrogenIndex) => ({
      atomIndexes: [0, hydrogenIndex + 1] as const,
      order: 1 as const
    }))
  },
  benzene: {
    atoms: [
      ...Array.from({ length: 6 }, (_, index) => {
        const angle = (index * Math.PI) / 3
        return { atomicNumber: 6, position: [1.397 * Math.cos(angle), 1.397 * Math.sin(angle), 0] as const }
      }),
      ...Array.from({ length: 6 }, (_, index) => {
        const angle = (index * Math.PI) / 3
        return { atomicNumber: 1, position: [2.487 * Math.cos(angle), 2.487 * Math.sin(angle), 0] as const }
      })
    ],
    bonds: [
      ...Array.from({ length: 6 }, (_, index) => ({
        atomIndexes: [index, (index + 1) % 6] as const,
        order: alternatingBondOrder(index)
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        atomIndexes: [index, index + 6] as const,
        order: 1 as const
      }))
    ]
  }
}

interface MoleculeBuildToolsProps {
  compact?: boolean
  contract: WorkbenchModeContract
  document: MoleculeDocument
  /** False while a run, replay, or final-geometry decision owns the molecule. */
  editable: boolean
  atomicNumber: number
  bondOrder: (typeof BOND_ORDERS)[number]
  coordination: CoordinationGeometry
  insertionMode: boolean
  selection: readonly string[]
  onAtomicNumberChange: (atomicNumber: number) => void
  onBondOrderChange: (order: (typeof BOND_ORDERS)[number]) => void
  onCoordinationChange: (coordination: CoordinationGeometry) => void
  onInsertionModeChange: (active: boolean) => void
  onPropose: (operations: readonly MoleculeOperation[], gesture?: StageGestureIntent) => void
}

/**
 * Structural editing for the recoverable molecule draft: place an atom or explicit-hydrogen
 * fragment, retype it, delete it, and set or clear the bond between two selected atoms.
 *
 * These live beside the 3D view because that is where the researcher is looking when they build. Every
 * action becomes a validated draft entry without publishing a revision. The mode contract — not
 * this component — decides which operations are offered at all; main re-validates regardless, so
 * the disabled states here are an honesty measure, not the gate.
 */
export function MoleculeBuildTools({
  atomicNumber,
  bondOrder,
  compact = false,
  coordination,
  contract,
  document,
  editable,
  insertionMode,
  selection,
  onAtomicNumberChange,
  onBondOrderChange,
  onCoordinationChange,
  onInsertionModeChange,
  onPropose
}: MoleculeBuildToolsProps) {
  const { t } = useTranslation()

  const allows = (operation: MoleculeOperation['op']) => contract.allowedOperations.includes(operation)
  const canInsertAtom = editable && allows('add_atoms')
  const canRemoveAtom = editable && allows('remove_atoms')
  const canChangeElement = editable && allows('set_atomic_numbers')
  const canAddBond = editable && allows('add_bonds')
  const canRemoveBond = editable && allows('remove_bonds')
  const canSetBondOrder = editable && allows('set_bond_orders')

  const selectedBond =
    selection.length === 2
      ? document.bonds.find(
          (bond) =>
            (bond.atomIds[0] === selection[0] && bond.atomIds[1] === selection[1]) ||
            (bond.atomIds[0] === selection[1] && bond.atomIds[1] === selection[0])
        )
      : undefined

  const removeSelected = useCallback(() => {
    if (selection.length === 0) return
    onPropose([{ op: 'remove_atoms', atomIds: [...selection] }], {
      gestureId: `gesture-${crypto.randomUUID()}`,
      kind: 'delete_selection',
      createdAt: new Date().toISOString(),
      extensions: {}
    })
  }, [onPropose, selection])

  const changeSelectedElements = useCallback(() => {
    if (selection.length === 0) return
    const atoms = selection.flatMap((atomId) => {
      const atom = document.atoms.find((candidate) => candidate.id === atomId)
      return atom && atom.atomicNumber !== atomicNumber ? [{ atomId: atom.id, atomicNumber }] : []
    })
    if (atoms.length > 0) {
      onPropose([{ op: 'set_atomic_numbers', atoms }], {
        gestureId: `gesture-${crypto.randomUUID()}`,
        kind: 'replace_atom',
        atomicNumber,
        anchorAtomId: atoms[0]?.atomId,
        createdAt: new Date().toISOString(),
        extensions: {}
      })
    }
  }, [atomicNumber, document, onPropose, selection])

  const setBondOrder = useCallback(
    (order: (typeof BOND_ORDERS)[number]) => {
      onBondOrderChange(order)
      if (selection.length !== 2) return
      const [first, second] = selection
      if (selectedBond) {
        if (selectedBond.order !== order) {
          onPropose([{ op: 'set_bond_orders', bonds: [{ bondId: selectedBond.id, order }] }], {
            gestureId: `gesture-${crypto.randomUUID()}`,
            kind: 'set_bond',
            anchorAtomId: selection[0],
            bondOrder: order,
            createdAt: new Date().toISOString(),
            extensions: {}
          })
        }
        return
      }
      onPropose(
        [
          {
            op: 'add_bonds',
            bonds: [{ id: `bond-${crypto.randomUUID()}`, atomIds: [first, second], order, extensions: {} }]
          }
        ],
        {
          gestureId: `gesture-${crypto.randomUUID()}`,
          kind: 'set_bond',
          anchorAtomId: first,
          bondOrder: order,
          createdAt: new Date().toISOString(),
          extensions: {}
        }
      )
    },
    [onBondOrderChange, onPropose, selectedBond, selection]
  )

  const removeSelectedBond = useCallback(() => {
    if (selectedBond) onPropose([{ op: 'remove_bonds', bondIds: [selectedBond.id] }])
  }, [onPropose, selectedBond])

  const insertFragment = useCallback(
    (fragmentName: BuilderFragment) => {
      if (!canInsertAtom || !canAddBond) return
      const template = FRAGMENT_TEMPLATES[fragmentName]
      const maxX = document.atoms.reduce((value, atom) => Math.max(value, atom.position[0]), -2.5)
      const origin: readonly [number, number, number] = [maxX + 2.5, 0, 0]
      const atomIds = template.atoms.map(() => `atom-${crypto.randomUUID()}`)
      const atoms = template.atoms.map((atom, index) => ({
        id: atomIds[index],
        atomicNumber: atom.atomicNumber,
        position: [atom.position[0] + origin[0], atom.position[1] + origin[1], atom.position[2] + origin[2]] as [
          number,
          number,
          number
        ],
        formalCharge: 0,
        extensions: {}
      }))
      const bonds = template.bonds.map(({ atomIndexes, order }) => ({
        id: `bond-${crypto.randomUUID()}`,
        atomIds: [atomIds[atomIndexes[0]], atomIds[atomIndexes[1]]] as [string, string],
        order,
        extensions: {}
      }))
      onPropose(
        [
          { op: 'add_atoms', atoms },
          { op: 'add_bonds', bonds }
        ],
        {
          gestureId: `gesture-${crypto.randomUUID()}`,
          kind: fragmentName === 'benzene' ? 'insert_ring' : 'insert_fragment',
          fragmentName,
          position: origin,
          createdAt: new Date().toISOString(),
          extensions: {}
        }
      )
    },
    [canAddBond, canInsertAtom, document.atoms, onPropose]
  )

  return (
    <div
      aria-label={t('chemsmart_studio.build.tools')}
      className={
        compact
          ? 'absolute top-12 right-2 left-2 z-20 flex max-h-24 flex-wrap items-center gap-2 overflow-auto rounded-md border border-border bg-card/95 px-2 py-1.5 text-xs shadow-sm backdrop-blur'
          : 'flex flex-wrap items-center gap-2 border-border border-b px-3 py-2 text-xs'
      }
      data-testid="molecule-build-tools"
      role="group">
      <PeriodicTablePopover
        atomicNumber={atomicNumber}
        disabled={!canInsertAtom && !canChangeElement}
        onSelect={(next) => {
          onAtomicNumberChange(next)
          onInsertionModeChange(true)
        }}
      />
      {insertionMode ? <Badge variant="secondary">{t('chemsmart_studio.build.insertion_mode')}</Badge> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={!canInsertAtom || !canAddBond} size="sm" variant="outline">
            <Shapes aria-hidden className="size-3.5" />
            {t('chemsmart_studio.build.fragments')}
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(['water', 'methane', 'benzene'] as const).map((fragmentName) => (
            <DropdownMenuItem key={fragmentName} onSelect={() => insertFragment(fragmentName)}>
              {t(`chemsmart_studio.build.fragment.${fragmentName}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select value={coordination} onValueChange={(value) => onCoordinationChange(value as CoordinationGeometry)}>
        <SelectTrigger
          aria-label={t('chemsmart_studio.build.coordination')}
          className="h-8 w-36 text-xs"
          disabled={!canInsertAtom}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {coordinationGeometries.map((geometry) => (
            <SelectItem key={geometry} value={geometry}>
              {t(`chemsmart_studio.build.coordination_geometry.${geometry}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        disabled={!canChangeElement || selection.length === 0}
        size="sm"
        variant="outline"
        onClick={changeSelectedElements}>
        <Pencil aria-hidden className="size-3.5" />
        {t('chemsmart_studio.build.change_selected_element')}
      </Button>
      <Button disabled={!canRemoveAtom || selection.length === 0} size="sm" variant="outline" onClick={removeSelected}>
        <Trash2 aria-hidden className="size-3.5" />
        {t('chemsmart_studio.build.delete_selected')}
      </Button>
      <div className="flex items-center gap-1.5">
        <span className="text-foreground-muted">{t('chemsmart_studio.build.bond_order')}</span>
        <SegmentedControl
          aria-label={t('chemsmart_studio.build.bond_order')}
          disabled={selection.length !== 2 || (selectedBond ? !canSetBondOrder : !canAddBond)}
          options={BOND_ORDERS.map((order) => ({ label: String(order), value: String(order) }))}
          size="sm"
          // Empty is deliberately controlled: otherwise SegmentedControl selects its first internal
          // option and clicking "1" cannot create a missing single bond.
          value={selection.length === 2 && selectedBond ? String(selectedBond.order) : String(bondOrder)}
          onValueChange={(value) => setBondOrder(Number(value) as (typeof BOND_ORDERS)[number])}
        />
      </div>
      <Button disabled={!canRemoveBond || !selectedBond} size="sm" variant="outline" onClick={removeSelectedBond}>
        <Unlink aria-hidden className="size-3.5" />
        {t('chemsmart_studio.build.delete_selected_bond')}
      </Button>
    </div>
  )
}
