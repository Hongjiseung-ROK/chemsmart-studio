import type { MoleculeAtom } from '@chemsmart/studio-protocol'
import { describe, expect, it } from 'vitest'

import { angle, dihedral, distance, measureSelection, positionForMeasurement, wrapDegrees } from '../moleculeGeometry'

function atom(id: string, position: [number, number, number]): MoleculeAtom {
  return { id, atomicNumber: 1, position, formalCharge: 0, extensions: {} }
}

/** Experimental water geometry: O–H 0.9584 angstrom, H–O–H 104.45 degrees. */
const water = [atom('O1', [0, 0, 0]), atom('H2', [0.9584, 0, 0]), atom('H3', [-0.2396, 0.9279, 0])]

describe('moleculeGeometry', () => {
  it('measures a known bond length and bond angle', () => {
    expect(distance([0, 0, 0], [0.9584, 0, 0])).toBeCloseTo(0.9584, 6)
    expect(
      angle(
        water[1].position as [number, number, number],
        water[0].position as [number, number, number],
        water[2].position as [number, number, number]
      )
    ).toBeCloseTo(104.45, 1)
  })

  it('measures a dihedral and keeps it inside a single turn', () => {
    // Perfect anti conformation: the two end atoms sit on opposite sides of the central bond.
    expect(dihedral([1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(0, 6)
    expect(Math.abs(dihedral([1, 1, 0], [0, 1, 0], [0, 0, 0], [-1, 0, 0]))).toBeCloseTo(180, 6)
    expect(wrapDegrees(190)).toBeCloseTo(-170, 6)
    expect(wrapDegrees(-190)).toBeCloseTo(170, 6)
    expect(wrapDegrees(180)).toBe(180)
    expect(wrapDegrees(-180)).toBe(180)
  })

  it('reads the measurement an ordered selection defines, and nothing else', () => {
    expect(measureSelection(water, ['O1', 'H2'])).toMatchObject({ kind: 'distance' })
    expect(measureSelection(water, ['H2', 'O1', 'H3'])).toMatchObject({ kind: 'angle' })
    expect(measureSelection(water, ['O1'])).toBeNull()
    expect(measureSelection(water, ['O1', 'missing'])).toBeNull()
  })

  it('moves only the last atom to reach a target distance', () => {
    const measurement = measureSelection(water, ['O1', 'H2'])
    const moved = positionForMeasurement(water, measurement!, 1.2)

    expect(moved?.atomId).toBe('H2')
    expect(distance(water[0].position as [number, number, number], moved!.position)).toBeCloseTo(1.2, 6)
  })

  it('rotates the last atom to reach a target angle without changing its bond length', () => {
    const measurement = measureSelection(water, ['H2', 'O1', 'H3'])
    const moved = positionForMeasurement(water, measurement!, 120)

    expect(moved?.atomId).toBe('H3')
    const rotated = water.map((candidate) =>
      candidate.id === 'H3' ? atom('H3', [...moved!.position] as [number, number, number]) : candidate
    )
    expect(measureSelection(rotated, ['H2', 'O1', 'H3'])?.value).toBeCloseTo(120, 4)
    // The bond it rotates about keeps its length, so only the angle changed.
    expect(distance(water[0].position as [number, number, number], moved!.position)).toBeCloseTo(
      distance(water[0].position as [number, number, number], water[2].position as [number, number, number]),
      6
    )
  })

  it('rotates the last atom to reach a target dihedral', () => {
    const chain = [atom('C1', [1, 1, 0]), atom('C2', [0, 1, 0]), atom('C3', [0, 0, 0]), atom('C4', [1, 0, 0])]
    const measurement = measureSelection(chain, ['C1', 'C2', 'C3', 'C4'])
    const moved = positionForMeasurement(chain, measurement!, 60)

    expect(moved?.atomId).toBe('C4')
    const rotated = chain.map((candidate) =>
      candidate.id === 'C4' ? atom('C4', [...moved!.position] as [number, number, number]) : candidate
    )
    expect(Math.abs(measureSelection(rotated, ['C1', 'C2', 'C3', 'C4'])!.value)).toBeCloseTo(60, 4)
  })
})
