import { useCallback, useState } from 'react'

import type { InspectorTab } from './InspectorPanel'

export const workbenchModes = ['build', 'inspect', 'measure', 'constrain', 'run', 'replay'] as const
export type WorkbenchMode = (typeof workbenchModes)[number]

/** Patch operation discriminators, exactly as `schemas/v1/molecule-patch.schema.json` writes them on the wire. */
export type MoleculePatchOperation =
  | 'add_atoms'
  | 'add_bonds'
  | 'remove_atoms'
  | 'remove_bonds'
  | 'remove_constraints'
  | 'set_atomic_numbers'
  | 'set_bond_orders'
  | 'set_constraints'
  | 'set_frozen_axes'
  | 'set_positions'
  | 'set_selection'

/**
 * What a selection means in this mode. Modes disagree on this — building needs one anchor atom, measuring
 * needs an ordered pair, triple, or quadruple — so the meaning belongs to the mode, not to the viewer.
 */
export type SelectionMeaning = 'anchor' | 'constraint_target' | 'frame_cursor' | 'multiple' | 'ordered'

export interface WorkbenchModeContract {
  /** The only operations this mode may propose. Main re-validates; this keeps the UI from offering more. */
  allowedOperations: readonly MoleculePatchOperation[]
  /** Which inspector section this mode works in. */
  inspectorTab: InspectorTab
  /** True when entering the mode should reveal the ChemSmart command workbench. */
  opensCommandWorkbench: boolean
  selection: SelectionMeaning
}

/** Studio opens in Build, so the inspector opens on the section Build owns. */
export const initialWorkbenchMode: WorkbenchMode = 'build'

export const workbenchModeContracts: Record<WorkbenchMode, WorkbenchModeContract> = {
  build: {
    allowedOperations: [
      'add_atoms',
      'remove_atoms',
      'add_bonds',
      'remove_bonds',
      'set_positions',
      'set_atomic_numbers',
      'set_bond_orders'
    ],
    inspectorTab: 'properties',
    opensCommandWorkbench: false,
    selection: 'anchor'
  },
  inspect: {
    allowedOperations: [],
    inspectorTab: 'properties',
    opensCommandWorkbench: false,
    selection: 'multiple'
  },
  measure: {
    allowedOperations: ['set_positions'],
    inspectorTab: 'properties',
    opensCommandWorkbench: false,
    selection: 'ordered'
  },
  constrain: {
    allowedOperations: ['set_constraints', 'remove_constraints', 'set_frozen_axes'],
    inspectorTab: 'properties',
    opensCommandWorkbench: false,
    selection: 'constraint_target'
  },
  run: {
    allowedOperations: [],
    inspectorTab: 'decisions',
    opensCommandWorkbench: true,
    selection: 'multiple'
  },
  replay: {
    allowedOperations: [],
    inspectorTab: 'decisions',
    opensCommandWorkbench: false,
    selection: 'frame_cursor'
  }
}

interface WorkbenchModeHandlers {
  /** Called when the mode wants the command workbench revealed; entering a mode never closes it. */
  onRevealCommandWorkbench: () => void
  onSelectInspectorTab: (tab: InspectorTab) => void
}

/**
 * Single owner of the mode contract. Switching modes moves the inspector and the command workbench with
 * it, so the visible surface always matches the work the mode owns.
 */
export function useWorkbenchMode({ onRevealCommandWorkbench, onSelectInspectorTab }: WorkbenchModeHandlers) {
  const [mode, setModeState] = useState<WorkbenchMode>(initialWorkbenchMode)

  const setMode = useCallback(
    (next: WorkbenchMode) => {
      setModeState(next)
      const contract = workbenchModeContracts[next]
      onSelectInspectorTab(contract.inspectorTab)
      if (contract.opensCommandWorkbench) onRevealCommandWorkbench()
    },
    [onRevealCommandWorkbench, onSelectInspectorTab]
  )

  return { contract: workbenchModeContracts[mode], mode, setMode }
}
