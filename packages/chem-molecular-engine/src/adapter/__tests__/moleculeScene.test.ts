import type { MoleculeAtom, MoleculeBond, MoleculeDocument } from '@chemsmart/studio-protocol'
import { describe, expect, it } from 'vitest'

import { ballRadius, elementColor } from '../../elements'
import { buildMoleculeScene, pickAtom, quantizePosition } from '../moleculeScene'

function atom(id: string, atomicNumber: number, position: [number, number, number]): MoleculeAtom {
  return { id, atomicNumber, position, formalCharge: 0, extensions: {} }
}

function bond(id: string, atomIds: [string, string], order: 1 | 2 | 3): MoleculeBond {
  return { id, atomIds, order, extensions: {} }
}

function document(overrides: Partial<MoleculeDocument> = {}): MoleculeDocument {
  return {
    documentId: 'document-1',
    revision: 0,
    atoms: [atom('atom-c1', 6, [0, 0, 0]), atom('atom-c2', 6, [1.5, 0, 0])],
    bonds: [bond('bond-1', ['atom-c1', 'atom-c2'], 1)],
    selections: [],
    frozenAxes: {},
    constraints: [],
    properties: { extensions: {} },
    extensions: {},
    ...overrides
  }
}

describe('buildMoleculeScene', () => {
  it('draws one instance per atom, coloured and sized by element', () => {
    const scene = buildMoleculeScene(
      document({ atoms: [atom('atom-o', 8, [0, 0, 0]), atom('atom-h', 1, [0.96, 0, 0])], bonds: [] })
    )

    expect(scene.atoms).toHaveLength(2)
    expect(scene.atoms[0]).toMatchObject({
      atomId: 'atom-o',
      color: elementColor(8),
      radius: ballRadius(8)
    })
    expect(scene.atoms[1].color).toBe(elementColor(1))
    // Oxygen must not render at hydrogen's size.
    expect(scene.atoms[0].radius).toBeGreaterThan(scene.atoms[1].radius)
  })

  it('takes bonds only from the document, never from interatomic distance', () => {
    // Two atoms well inside bonding distance, with no bond recorded. A viewer would guess a bond
    // here; an editor must not — the researcher's topology is the calculation input.
    const scene = buildMoleculeScene(
      document({ atoms: [atom('atom-c1', 6, [0, 0, 0]), atom('atom-c2', 6, [1.2, 0, 0])], bonds: [] })
    )

    expect(scene.atoms).toHaveLength(2)
    expect(scene.bonds).toHaveLength(0)
  })

  it('splits each bond into two half-segments that meet at the midpoint', () => {
    const scene = buildMoleculeScene(document())

    expect(scene.bonds).toHaveLength(2)
    const [first, second] = scene.bonds
    expect(first.atomId).toBe('atom-c1')
    expect(second.atomId).toBe('atom-c2')
    // Both halves end where the other begins.
    expect(first.end).toEqual(second.start)
    expect(first.end).toEqual([0.75, 0, 0])
  })

  it('gives each half the colour of its own atom', () => {
    const scene = buildMoleculeScene(
      document({
        atoms: [atom('atom-c', 6, [0, 0, 0]), atom('atom-o', 8, [1.2, 0, 0])],
        bonds: [bond('bond-1', ['atom-c', 'atom-o'], 1)]
      })
    )

    expect(scene.bonds[0].color).toBe(elementColor(6))
    expect(scene.bonds[1].color).toBe(elementColor(8))
  })

  it.each([
    [1, 2],
    [2, 4],
    [3, 6]
  ])('draws bond order %i as %i segments', (order, expected) => {
    const scene = buildMoleculeScene(document({ bonds: [bond('bond-1', ['atom-c1', 'atom-c2'], order as 1 | 2 | 3)] }))
    expect(scene.bonds).toHaveLength(expected)
  })

  it('separates the sticks of a multiple bond so the order is visible', () => {
    const scene = buildMoleculeScene(document({ bonds: [bond('bond-1', ['atom-c1', 'atom-c2'], 2)] }))

    // The two sticks of a double bond must not be coincident, or it reads as a single bond.
    const firstStick = scene.bonds[0].start
    const secondStick = scene.bonds[2].start
    expect(firstStick).not.toEqual(secondStick)
  })

  it('marks selected atoms without changing anyone else', () => {
    const scene = buildMoleculeScene(document({ selections: ['atom-c2'] }))

    expect(scene.atoms.find((item) => item.atomId === 'atom-c1')?.selected).toBe(false)
    expect(scene.atoms.find((item) => item.atomId === 'atom-c2')?.selected).toBe(true)
  })

  it('skips a bond whose endpoint is missing rather than drawing it wrong', () => {
    const scene = buildMoleculeScene(document({ bonds: [bond('bond-1', ['atom-c1', 'atom-absent'], 1)] }))
    expect(scene.bonds).toHaveLength(0)
  })

  it('frames on the centre of the structure', () => {
    const scene = buildMoleculeScene(
      document({ atoms: [atom('atom-a', 6, [-2, 0, 0]), atom('atom-b', 6, [4, 0, 0])], bonds: [] })
    )

    expect(scene.center).toEqual([1, 0, 0])
    expect(scene.extent).toBeGreaterThan(3)
  })

  it('still frames an empty document', () => {
    const scene = buildMoleculeScene(document({ atoms: [], bonds: [] }))

    expect(scene.atoms).toHaveLength(0)
    expect(scene.center).toEqual([0, 0, 0])
    // A zero extent would put the camera inside the origin and divide by zero when framing.
    expect(scene.extent).toBe(1)
  })
})

describe('pickAtom', () => {
  const scene = buildMoleculeScene(document())

  it('translates an instance index to the stable atom id it draws', () => {
    expect(pickAtom(scene, 0)).toBe('atom-c1')
    expect(pickAtom(scene, 1)).toBe('atom-c2')
  })

  it.each<[string, number]>([
    ['past the last instance', 2],
    ['a negative index', -1],
    ['a fractional index', 0.5],
    ['not a number', Number.NaN]
  ])('returns null for %s', (_label, instanceId) => {
    // A pick must never guess: a miss or a stale index from a rebuilt mesh is null, not a wrong atom.
    expect(pickAtom(scene, instanceId)).toBeNull()
  })

  it('returns null when the scene has no atoms', () => {
    expect(pickAtom(buildMoleculeScene(document({ atoms: [], bonds: [] })), 0)).toBeNull()
  })
})

describe('quantizePosition', () => {
  it('rounds to four decimals by default', () => {
    expect(quantizePosition([0.123456, 1.99999, -2.5])).toEqual([0.1235, 2, -2.5])
  })

  it('honours a custom precision', () => {
    expect(quantizePosition([1.234, 5.678, 9.012], 2)).toEqual([1.23, 5.68, 9.01])
  })

  it('leaves exact coordinates unchanged', () => {
    expect(quantizePosition([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('collapses negative zero so a coordinate reads cleanly', () => {
    const result = quantizePosition([-0.00001, 0.00001, 0])
    expect(result).toEqual([0, 0, 0])
    expect(Object.is(result[0], -0)).toBe(false)
  })
})
