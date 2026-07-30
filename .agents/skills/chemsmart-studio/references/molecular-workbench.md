# Molecular workbench

## State and display truth

- Main owns one committed `MoleculeDocument` and a separate crash-recoverable draft. Stable atom, bond, and constraint IDs are identities; array indexes are not.
- Accumulate researcher and Agent edits in validated draft history without per-edit approval. Undo and redo operate within the draft.
- Save and Run show the ordered draft summary. Applying produces one durable revision; discarding restores the committed display.
- Label display state explicitly as committed, draft, run, or replay. Run and replay coordinates never mutate committed geometry.
- Render only explicit document bonds. Do not infer topology in Three.js.

## Builder interaction

- Open a complete searchable, keyboard-navigable periodic table when selecting an element. Selecting an element immediately activates placement.
- Clicking empty space places an independent atom. Clicking an existing atom creates an explicit bond using the chosen order and coordination guide.
- Keep replacement a separate tool and hydrogens explicit.
- Name geometry assistance `Coordination guide`; do not claim automatic VSEPR inference or infer lone pairs.
- Rotate canonical linear, trigonal-planar, tetrahedral, trigonal-bipyramidal, square-planar, or octahedral sites onto the anchor geometry in main.
- Use element covalent radii for bond length, deterministic site ordering, global non-anchor clearance, and fail-closed `coordination_full` or `steric_collision` outcomes.
- Let Tab and Shift+Tab cycle only main-validated sites. Revalidate document revision, geometry hash, and coordinates at commit.

## Tools, selection, and overlays

- Activate Build, Select, Move, Rotate, Measure, and Constrain through one tool transition. Clear the previous selection and tool anchor when changing tools.
- After activation, let the next picked atom or bond become the tool target. Preserve the inserted atom as the next anchor only for continuous building.
- Show tool names with icons at normal width; retain the active name plus tooltip and accessible label in compact layouts.
- Keep constraint, measurement, frozen-axis, placement-ghost, and Agent-action overlays separate from topology.
- Agent cues highlight stable IDs without changing researcher selection. Clear transient cues on terminal tool state; keep committed or draft constraints visible.
- Replace pulse animation with a static outline under Reduce Motion.

## Rendering discipline

- Reconcile complete validated documents by stable ID and reject stale picking maps.
- Keep camera, hover, local selection decoration, and controls as transient view state.
- Publish a run frame only after main verifies it and Python has durably appended it.
- Dispose Three.js geometry, materials, textures, controls, listeners, and overlays deterministically.
