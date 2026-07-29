import type { MoleculeAtom } from '@chemsmart/studio-protocol'

/** Positions are angstrom; angles are degrees. Both units are stated wherever a value is shown. */
export type Vector3 = readonly [number, number, number]

export type MeasurementKind = 'distance' | 'angle' | 'dihedral'

export interface Measurement {
  atomIds: readonly string[]
  kind: MeasurementKind
  /** Angstrom for a distance, degrees for an angle or a dihedral. */
  value: number
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ]
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function norm(vector: Vector3): number {
  return Math.hypot(vector[0], vector[1], vector[2])
}

export function distance(first: Vector3, second: Vector3): number {
  return norm(subtract(second, first))
}

/** Angle at `vertex` between the two bonds, in degrees. */
export function angle(first: Vector3, vertex: Vector3, second: Vector3): number {
  const left = subtract(first, vertex)
  const right = subtract(second, vertex)
  const lengths = norm(left) * norm(right)
  if (lengths === 0) return 0
  const cosine = Math.min(1, Math.max(-1, dot(left, right) / lengths))
  return (Math.acos(cosine) * 180) / Math.PI
}

function scale(vector: Vector3, factor: number): Vector3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

/** Signed dihedral across the second and third atoms, in degrees, wrapped to (-180, 180]. */
export function dihedral(first: Vector3, second: Vector3, third: Vector3, fourth: Vector3): number {
  const toSecond = subtract(second, first)
  const axis = subtract(third, second)
  const toFourth = subtract(fourth, third)
  const axisLength = norm(axis) || 1
  const firstNormal = cross(toSecond, axis)
  const secondNormal = cross(axis, toFourth)
  const inPlane = cross(firstNormal, scale(axis, 1 / axisLength))
  const x = dot(firstNormal, secondNormal)
  const y = dot(inPlane, secondNormal)
  if (x === 0 && y === 0) return 0
  return (Math.atan2(y, x) * 180) / Math.PI
}

/** Wraps any angle into (-180, 180] so a dihedral never reads as 190 degrees. */
export function wrapDegrees(value: number): number {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/**
 * The measurement an ordered selection defines: two atoms are a distance, three an angle, four a
 * dihedral. Anything else is not a measurement, so nothing is reported.
 */
export function measureSelection(atoms: readonly MoleculeAtom[], atomIds: readonly string[]): Measurement | null {
  const picked = atomIds
    .map((atomId) => atoms.find((atom) => atom.id === atomId))
    .filter((atom): atom is MoleculeAtom => atom !== undefined)
  if (picked.length !== atomIds.length) return null

  const positions = picked.map((atom) => atom.position as Vector3)
  if (positions.length === 2) {
    return { atomIds, kind: 'distance', value: distance(positions[0], positions[1]) }
  }
  if (positions.length === 3) {
    return { atomIds, kind: 'angle', value: angle(positions[0], positions[1], positions[2]) }
  }
  if (positions.length === 4) {
    return {
      atomIds,
      kind: 'dihedral',
      value: wrapDegrees(dihedral(positions[0], positions[1], positions[2], positions[3]))
    }
  }
  return null
}

/**
 * Moves the last atom of a measurement so the measurement reaches `target`, and returns its new
 * position. Only that atom moves, which keeps the change small enough to review in the preview diff.
 */
export function positionForMeasurement(
  atoms: readonly MoleculeAtom[],
  measurement: Measurement,
  target: number
): { atomId: string; position: Vector3 } | null {
  const picked = measurement.atomIds.map((atomId) => atoms.find((atom) => atom.id === atomId))
  if (picked.some((atom) => atom === undefined)) return null
  const positions = (picked as MoleculeAtom[]).map((atom) => atom.position as Vector3)
  const movedId = measurement.atomIds[measurement.atomIds.length - 1]

  if (measurement.kind === 'distance') {
    const [anchor, moved] = positions
    const direction = subtract(moved, anchor)
    const length = norm(direction)
    if (length === 0) return null
    const scale = target / length
    return {
      atomId: movedId,
      position: [anchor[0] + direction[0] * scale, anchor[1] + direction[1] * scale, anchor[2] + direction[2] * scale]
    }
  }

  if (measurement.kind === 'angle') {
    const [first, vertex, moved] = positions
    const reference = subtract(first, vertex)
    const arm = subtract(moved, vertex)
    const axis = cross(reference, arm)
    const axisLength = norm(axis)
    if (axisLength === 0) return null
    const unitAxis: Vector3 = [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength]
    const delta = ((target - measurement.value) * Math.PI) / 180
    return { atomId: movedId, position: rotateAround(arm, unitAxis, delta, vertex) }
  }

  const [, second, third, moved] = positions
  const axis = subtract(third, second)
  const axisLength = norm(axis)
  if (axisLength === 0) return null
  const unitAxis: Vector3 = [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength]
  const delta = ((wrapDegrees(target) - measurement.value) * Math.PI) / 180
  return { atomId: movedId, position: rotateAround(subtract(moved, third), unitAxis, delta, third) }
}

/** Rodrigues rotation of `arm` about `unitAxis` by `radians`, expressed back in absolute coordinates. */
function rotateAround(arm: Vector3, unitAxis: Vector3, radians: number, origin: Vector3): Vector3 {
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const scaled = cross(unitAxis, arm)
  const projection = dot(unitAxis, arm) * (1 - cosine)
  return [
    origin[0] + arm[0] * cosine + scaled[0] * sine + unitAxis[0] * projection,
    origin[1] + arm[1] * cosine + scaled[1] * sine + unitAxis[1] * projection,
    origin[2] + arm[2] * cosine + scaled[2] * sine + unitAxis[2] * projection
  ]
}
