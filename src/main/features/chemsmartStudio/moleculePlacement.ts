import { covalentRadius } from '@chemsmart/molecular-engine'
import type {
  CoordinationGeometry,
  MoleculeDocument,
  StagePlacementIntent,
  StagePlacementPreview,
  Vector3
} from '@chemsmart/studio-protocol'

type Matrix3 = readonly [Vector3, Vector3, Vector3]

const SQRT_THREE_OVER_TWO = Math.sqrt(3) / 2
const ONE_OVER_SQRT_THREE = 1 / Math.sqrt(3)
const IDENTITY: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]

const COORDINATION_SITES: Readonly<Record<CoordinationGeometry, readonly Vector3[]>> = {
  linear: [
    [1, 0, 0],
    [-1, 0, 0]
  ],
  trigonal_planar: [
    [1, 0, 0],
    [-0.5, SQRT_THREE_OVER_TWO, 0],
    [-0.5, -SQRT_THREE_OVER_TWO, 0]
  ],
  tetrahedral: [
    [ONE_OVER_SQRT_THREE, ONE_OVER_SQRT_THREE, ONE_OVER_SQRT_THREE],
    [ONE_OVER_SQRT_THREE, -ONE_OVER_SQRT_THREE, -ONE_OVER_SQRT_THREE],
    [-ONE_OVER_SQRT_THREE, ONE_OVER_SQRT_THREE, -ONE_OVER_SQRT_THREE],
    [-ONE_OVER_SQRT_THREE, -ONE_OVER_SQRT_THREE, ONE_OVER_SQRT_THREE]
  ],
  trigonal_bipyramidal: [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [-0.5, SQRT_THREE_OVER_TWO, 0],
    [-0.5, -SQRT_THREE_OVER_TWO, 0]
  ],
  square_planar: [
    [1, 0, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [0, -1, 0]
  ],
  octahedral: [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ]
}

function add(left: Vector3, right: Vector3): Vector3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function scale(vector: Vector3, factor: number): Vector3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ]
}

function magnitude(vector: Vector3): number {
  return Math.hypot(vector[0], vector[1], vector[2])
}

function normalize(vector: Vector3): Vector3 {
  const length = magnitude(vector)
  if (length <= 1e-10) throw new Error('A bonded atom overlaps its anchor')
  return scale(vector, 1 / length)
}

function applyMatrix(matrix: Matrix3, vector: Vector3): Vector3 {
  return [dot(matrix[0], vector), dot(matrix[1], vector), dot(matrix[2], vector)]
}

function columns(first: Vector3, second: Vector3, third: Vector3): Matrix3 {
  return [
    [first[0], second[0], third[0]],
    [first[1], second[1], third[1]],
    [first[2], second[2], third[2]]
  ]
}

function transpose(matrix: Matrix3): Matrix3 {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]]
  ]
}

function multiply(left: Matrix3, right: Matrix3): Matrix3 {
  const rightColumns = transpose(right)
  return [
    [dot(left[0], rightColumns[0]), dot(left[0], rightColumns[1]), dot(left[0], rightColumns[2])],
    [dot(left[1], rightColumns[0]), dot(left[1], rightColumns[1]), dot(left[1], rightColumns[2])],
    [dot(left[2], rightColumns[0]), dot(left[2], rightColumns[1]), dot(left[2], rightColumns[2])]
  ]
}

function basis(first: Vector3, second: Vector3): Matrix3 | null {
  const x = normalize(first)
  const inPlane = subtract(second, scale(x, dot(second, x)))
  if (magnitude(inPlane) <= 1e-8) return null
  const y = normalize(inPlane)
  return columns(x, y, normalize(cross(x, y)))
}

function pairRotation(sourceFirst: Vector3, sourceSecond: Vector3, targetFirst: Vector3, targetSecond: Vector3) {
  const source = basis(sourceFirst, sourceSecond)
  const target = basis(targetFirst, targetSecond)
  return source && target ? multiply(target, transpose(source)) : null
}

function rotationFromTo(source: Vector3, target: Vector3): Matrix3 {
  const from = normalize(source)
  const to = normalize(target)
  const cosine = Math.max(-1, Math.min(1, dot(from, to)))
  if (cosine > 1 - 1e-10) return IDENTITY
  let axis = cross(from, to)
  let scalar = 1 + cosine
  if (cosine < -1 + 1e-10) {
    const reference: Vector3 = Math.abs(from[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]
    axis = normalize(cross(from, reference))
    scalar = 0
  }
  const quaternionLength = Math.hypot(axis[0], axis[1], axis[2], scalar)
  const normalizedAxis = scale(axis, 1 / quaternionLength)
  const [x, y, z] = normalizedAxis
  const w = scalar / quaternionLength
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
  ]
}

interface SiteAssignment {
  score: number
  siteIndexes: number[]
}

function bestAssignment(sites: readonly Vector3[], neighbors: readonly Vector3[]): SiteAssignment {
  let best: SiteAssignment = { score: Number.NEGATIVE_INFINITY, siteIndexes: [] }
  const visit = (neighborIndex: number, used: Set<number>, siteIndexes: number[], score: number): void => {
    if (neighborIndex === neighbors.length) {
      const key = siteIndexes.join(',')
      const bestKey = best.siteIndexes.join(',')
      if (score > best.score + 1e-10 || (Math.abs(score - best.score) <= 1e-10 && key < bestKey)) {
        best = { score, siteIndexes: [...siteIndexes] }
      }
      return
    }
    sites.forEach((site, siteIndex) => {
      if (used.has(siteIndex)) return
      used.add(siteIndex)
      siteIndexes.push(siteIndex)
      visit(neighborIndex + 1, used, siteIndexes, score + dot(site, neighbors[neighborIndex]))
      siteIndexes.pop()
      used.delete(siteIndex)
    })
  }
  visit(0, new Set(), [], 0)
  return best
}

function orientedSites(
  canonical: readonly Vector3[],
  neighbors: readonly Vector3[]
): {
  sites: Vector3[]
  occupied: Set<number>
} {
  if (neighbors.length === 0) return { sites: canonical.map((site) => [...site]), occupied: new Set() }
  const rotations: Array<{ key: string; value: Matrix3 }> = canonical.map((site, index) => ({
    key: `single-${index}`,
    value: rotationFromTo(site, neighbors[0])
  }))
  if (neighbors.length > 1) {
    canonical.forEach((first, firstIndex) => {
      canonical.forEach((second, secondIndex) => {
        if (firstIndex === secondIndex) return
        const rotation = pairRotation(first, second, neighbors[0], neighbors[1])
        if (rotation) rotations.push({ key: `pair-${firstIndex}-${secondIndex}`, value: rotation })
      })
    })
  }

  let best: { key: string; sites: Vector3[]; assignment: SiteAssignment } | undefined
  for (const rotation of rotations) {
    const sites = canonical.map((site) => normalize(applyMatrix(rotation.value, site)))
    const assignment = bestAssignment(sites, neighbors)
    if (
      !best ||
      assignment.score > best.assignment.score + 1e-10 ||
      (Math.abs(assignment.score - best.assignment.score) <= 1e-10 && rotation.key < best.key)
    ) {
      best = { key: rotation.key, sites, assignment }
    }
  }
  if (!best) return { sites: canonical.map((site) => [...site]), occupied: new Set() }
  return { sites: best.sites, occupied: new Set(best.assignment.siteIndexes) }
}

function rounded(position: Vector3): Vector3 {
  return position.map((value) => {
    const result = Math.round(value * 10_000) / 10_000
    return Object.is(result, -0) ? 0 : result
  }) as unknown as Vector3
}

function stableNeighbors(
  document: MoleculeDocument,
  anchorAtomId: string
): Array<{
  atomId: string
  direction: Vector3
}> {
  const anchor = document.atoms.find((atom) => atom.id === anchorAtomId)
  if (!anchor) throw new Error('Placement anchor is unknown')
  const atoms = new Map(document.atoms.map((atom) => [atom.id, atom]))
  return document.bonds
    .flatMap((bond) => {
      const atomId =
        bond.atomIds[0] === anchorAtomId ? bond.atomIds[1] : bond.atomIds[1] === anchorAtomId ? bond.atomIds[0] : null
      if (!atomId) return []
      const atom = atoms.get(atomId)
      if (!atom) throw new Error('Placement anchor has a dangling bond')
      return [{ bondId: bond.id, atomId, direction: normalize(subtract(atom.position, anchor.position)) }]
    })
    .sort((left, right) => left.bondId.localeCompare(right.bondId) || left.atomId.localeCompare(right.atomId))
}

/**
 * Builds deterministic, collision-checked placement candidates without mutating the document.
 * This is a coordination guide selected by the researcher; it never infers lone pairs or claims
 * that the template is an automatic VSEPR assignment.
 */
export function buildStagePlacementPreview(
  document: MoleculeDocument,
  geometryHash: string,
  intent: StagePlacementIntent
): StagePlacementPreview {
  const anchor = intent.anchorAtomId ? document.atoms.find((atom) => atom.id === intent.anchorAtomId) : undefined
  if (intent.anchorAtomId && !anchor) throw new Error('Placement anchor is unknown')
  const canonical = anchor ? COORDINATION_SITES[intent.coordinationGeometry] : ([[0, 0, 0]] as const)
  const neighbors = anchor ? stableNeighbors(document, anchor.id) : []
  const orientation = orientedSites(
    canonical,
    neighbors.slice(0, canonical.length).map((neighbor) => neighbor.direction)
  )
  const occupied =
    neighbors.length >= canonical.length ? new Set(canonical.map((_, index) => index)) : orientation.occupied
  const bondLength = anchor
    ? covalentRadius(anchor.atomicNumber) + covalentRadius(intent.atomicNumber)
    : covalentRadius(intent.atomicNumber)
  const origin = anchor?.position ?? intent.origin ?? [0, 0, 0]
  const otherAtoms = document.atoms.filter((atom) => atom.id !== anchor?.id)
  const candidates = orientation.sites.map((direction, siteIndex) => {
    const position = rounded(anchor ? add(origin, scale(direction, bondLength)) : origin)
    let minimumClearance = 999
    for (const atom of otherAtoms) {
      const distance = magnitude(subtract(position, atom.position))
      const requiredClearance = 0.65 * (covalentRadius(intent.atomicNumber) + covalentRadius(atom.atomicNumber))
      minimumClearance = Math.min(minimumClearance, distance - requiredClearance)
    }
    minimumClearance = Math.round(minimumClearance * 10_000) / 10_000
    const isOccupied = occupied.has(siteIndex)
    return {
      siteIndex,
      position,
      bondLength,
      minimumClearance,
      occupied: isOccupied,
      safe: !isOccupied && minimumClearance >= 0
    }
  })
  const safe = candidates.filter((candidate) => candidate.safe).sort((left, right) => left.siteIndex - right.siteIndex)
  const selected = safe.find((candidate) => candidate.siteIndex === intent.siteIndex) ?? safe[0]
  const status =
    neighbors.length >= canonical.length ? 'coordination_full' : safe.length === 0 ? 'steric_collision' : 'ready'
  return {
    documentId: document.documentId,
    revision: document.revision,
    geometryHash,
    ...(anchor ? { anchorAtomId: anchor.id } : {}),
    atomicNumber: intent.atomicNumber,
    bondOrder: intent.bondOrder,
    coordinationGeometry: intent.coordinationGeometry,
    candidates,
    ...(selected ? { selectedSiteIndex: selected.siteIndex } : {}),
    status
  }
}
