import type { MoleculeDocument } from '@chemsmart/studio-protocol'

import type { CoordinationGeometry } from './MoleculeBuildTools'

export type PlacementVector = readonly [number, number, number]

const ROOT_THREE_OVER_TWO = Math.sqrt(3) / 2

const COORDINATION_DIRECTIONS: Readonly<Record<CoordinationGeometry, readonly PlacementVector[]>> = {
  linear: [
    [1, 0, 0],
    [-1, 0, 0]
  ],
  trigonal_planar: [
    [ROOT_THREE_OVER_TWO, 0.5, 0],
    [-ROOT_THREE_OVER_TWO, 0.5, 0],
    [0, -1, 0]
  ],
  tetrahedral: [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1]
  ],
  square_planar: [
    [0, 1, 0],
    [1, 0, 0],
    [0, -1, 0],
    [-1, 0, 0]
  ],
  octahedral: [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0]
  ]
}

function normalized(vector: PlacementVector): PlacementVector {
  const magnitude = Math.hypot(vector[0], vector[1], vector[2]) || 1
  return [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude]
}

function dot(left: PlacementVector, right: PlacementVector): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

/**
 * Selects the coordination direction furthest from every bond already attached to the anchor.
 * Repeated insertion therefore occupies a vacant direction instead of stacking atoms at one point.
 */
export function positionForNextCoordinationSite(
  document: MoleculeDocument,
  anchorId: string,
  coordination: CoordinationGeometry,
  bondLength: number
): PlacementVector {
  const anchor = document.atoms.find((atom) => atom.id === anchorId)
  if (!anchor) throw new Error(`Unknown anchor atom: ${anchorId}`)

  const neighborDirections = document.bonds.flatMap((bond) => {
    const neighborId =
      bond.atomIds[0] === anchorId ? bond.atomIds[1] : bond.atomIds[1] === anchorId ? bond.atomIds[0] : null
    if (!neighborId) return []
    const neighbor = document.atoms.find((atom) => atom.id === neighborId)
    if (!neighbor) return []
    return [
      normalized([
        neighbor.position[0] - anchor.position[0],
        neighbor.position[1] - anchor.position[1],
        neighbor.position[2] - anchor.position[2]
      ])
    ]
  })

  const direction = COORDINATION_DIRECTIONS[coordination].map(normalized).reduce(
    (best, candidate) => {
      const crowding = neighborDirections.reduce(
        (maximum, neighborDirection) => Math.max(maximum, dot(candidate, neighborDirection)),
        -1
      )
      return crowding < best.crowding ? { direction: candidate, crowding } : best
    },
    { direction: normalized(COORDINATION_DIRECTIONS[coordination][0]), crowding: Number.POSITIVE_INFINITY }
  ).direction

  return [
    anchor.position[0] + direction[0] * bondLength,
    anchor.position[1] + direction[1] * bondLength,
    anchor.position[2] + direction[2] * bondLength
  ]
}
