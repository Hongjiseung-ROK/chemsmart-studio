import type { MoleculeDocument } from '@chemsmart/studio-protocol'

import { ballRadius, elementColor } from '../elements'

/**
 * Turns a `MoleculeDocument` into flat draw instructions. Deliberately free of three.js so the
 * chemically meaningful part — which atom is where, which bond is which order, what is selected —
 * can be tested without a GPU or a DOM.
 *
 * This is the only ingress to the renderer. Nothing downstream reads the document directly, and
 * nothing here reads anything but the document.
 */

export type Vec3 = readonly [number, number, number]

export interface AtomInstance {
  atomId: string
  position: Vec3
  radius: number
  color: number
  selected: boolean
}

/**
 * Half a bond: from one atom to the bond midpoint, carrying that atom's colour. Two of these make
 * the familiar two-tone stick. A bond of order n contributes 2n segments.
 */
export interface BondSegment {
  bondId: string
  atomId: string
  start: Vec3
  end: Vec3
  radius: number
  color: number
}

export interface MoleculeScene {
  atoms: AtomInstance[]
  bonds: BondSegment[]
  /** Centre of the atom bounding box, for framing the camera. */
  center: Vec3
  /** Distance from `center` to the furthest atom, minimum 1 angstrom so a lone atom still frames. */
  extent: number
}

const BOND_RADIUS = 0.09
/** Perpendicular separation between the parallel sticks of a multiple bond, in angstrom. */
const MULTIPLE_BOND_SPACING = 0.16

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale(v: Vec3, factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

function normalize(v: Vec3): Vec3 {
  const magnitude = length(v)
  return magnitude === 0 ? [0, 0, 0] : scale(v, 1 / magnitude)
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

/**
 * A unit vector perpendicular to `axis`, chosen deterministically so a given bond always splays
 * its multiple-bond sticks the same way between renders.
 */
function perpendicular(axis: Vec3): Vec3 {
  // Cross with whichever cardinal axis is least aligned, so the result is never degenerate.
  const reference: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return normalize(cross(axis, reference))
}

/** Offsets, in units of `MULTIPLE_BOND_SPACING`, for each stick of a bond of the given order. */
function stickOffsets(order: number): number[] {
  if (order <= 1) return [0]
  if (order === 2) return [-0.5, 0.5]
  return [-1, 0, 1]
}

export function buildMoleculeScene(document: MoleculeDocument): MoleculeScene {
  const selected = new Set(document.selections)
  const positions = new Map<string, Vec3>()

  const atoms: AtomInstance[] = document.atoms.map((atom) => {
    const position: Vec3 = [atom.position[0], atom.position[1], atom.position[2]]
    positions.set(atom.id, position)
    return {
      atomId: atom.id,
      position,
      radius: ballRadius(atom.atomicNumber),
      color: elementColor(atom.atomicNumber),
      selected: selected.has(atom.id)
    }
  })

  const colors = new Map<string, number>(atoms.map((atom) => [atom.atomId, atom.color]))
  const bonds: BondSegment[] = []

  for (const bond of document.bonds) {
    const [firstId, secondId] = bond.atomIds
    const first = positions.get(firstId)
    const second = positions.get(secondId)
    // A validated document cannot dangle a bond, but drawing one would be worse than skipping it.
    if (!first || !second) continue

    const axis = normalize(subtract(second, first))
    const offsetDirection = perpendicular(axis)
    const centre = midpoint(first, second)

    for (const step of stickOffsets(bond.order)) {
      const shift = scale(offsetDirection, step * MULTIPLE_BOND_SPACING)
      const from = add(first, shift)
      const to = add(second, shift)
      const middle = add(centre, shift)
      bonds.push(
        {
          bondId: bond.id,
          atomId: firstId,
          start: from,
          end: middle,
          radius: BOND_RADIUS,
          color: colors.get(firstId) ?? 0
        },
        {
          bondId: bond.id,
          atomId: secondId,
          start: middle,
          end: to,
          radius: BOND_RADIUS,
          color: colors.get(secondId) ?? 0
        }
      )
    }
  }

  return { atoms, bonds, ...framing(atoms) }
}

function framing(atoms: readonly AtomInstance[]): { center: Vec3; extent: number } {
  if (atoms.length === 0) return { center: [0, 0, 0], extent: 1 }

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const atom of atoms) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], atom.position[axis])
      max[axis] = Math.max(max[axis], atom.position[axis])
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]

  let extent = 0
  for (const atom of atoms) {
    extent = Math.max(extent, length(subtract(atom.position, center)) + atom.radius)
  }
  return { center, extent: Math.max(extent, 1) }
}

/**
 * Translates an atom `InstancedMesh` instance index back to the stable atom id it draws. The
 * renderer only ever holds an instance index from a raycast; nothing outside this package sees one,
 * so this is the single ingress for a pick. An index that does not map to an atom — a miss, a
 * negative, a fractional value, or a stale index from a rebuilt mesh — yields null rather than a guess.
 */
export function pickAtom(scene: MoleculeScene, instanceId: number): string | null {
  if (!Number.isInteger(instanceId) || instanceId < 0) return null
  return scene.atoms[instanceId]?.atomId ?? null
}

/**
 * Rounds a gesture-produced position to a fixed decimal precision so a drag does not publish
 * sub-0.0001 angstrom noise as a distinct revision. The four-decimal default is a tenth of a
 * thousandth of an angstrom, far below chemical significance. Negative zero collapses to zero so a
 * quantized coordinate reads cleanly.
 */
export function quantizePosition(position: Vec3, precision = 4): Vec3 {
  const factor = 10 ** precision
  const quantize = (value: number): number => {
    const quantized = Math.round(value * factor) / factor
    return Object.is(quantized, -0) ? 0 : quantized
  }
  return [quantize(position[0]), quantize(position[1]), quantize(position[2])]
}
