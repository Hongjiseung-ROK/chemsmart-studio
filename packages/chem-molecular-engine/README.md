# @chemsmart/molecular-engine

The molecular renderer. It draws a `MoleculeDocument` and nothing else.

## The one rule

`MoleculeDocument` is the only authority. This package is a **pure function of the document**:
data flows document → scene, never scene → document. Nothing here mutates molecule state, caches
a second copy of it, or infers chemistry the document did not state.

Concretely:

- **Bonds come from `document.bonds`.** Never from distance heuristics. A viewer may guess where
  bonds probably are; an editor for computational chemistry may not — the researcher's topology is
  the input to the calculation, so inventing a bond would silently change the science.
- **Interaction produces intent, not mutation.** A drag reports "atom `a-7` moved to (x, y, z)".
  Turning that into a `MoleculePatch`, previewing it and approving it belongs to main.
- **Stable ids are the currency.** Nothing outside this package sees an instance index; the adapter
  translates in both directions.

This is why WEAS was not taken as a dependency despite being MIT and capable: it owns its own
`atoms` model internally, which would put a second molecule state in the process and recreate
exactly the two-authorities problem the Avogadro removal exists to end.

## Layout

| Path | Holds |
|---|---|
| `elements.ts` | CPK colours and covalent radii, keyed by atomic number |
| `adapter/moleculeScene.ts` | Pure `MoleculeDocument` → draw instructions. No WebGL, unit tested. |
| `renderer/MoleculeCanvas.ts` | The three.js binding: scene, camera, instanced meshes, resize |

The split is deliberate: everything chemically meaningful lives in the pure layer where it can be
tested without a GPU, and `MoleculeCanvas` stays a thin translation into three.js calls.

## Rendering notes

Atoms and bonds are each one `InstancedMesh`, so a structure costs two draw calls regardless of
size. A bond renders as two half-cylinders meeting at the midpoint, each taking its atom's colour —
the standard ball-and-stick reading. Bond order draws as `order` parallel sticks, because a double
bond that looks single is a misreport of the document.
