import type { MoleculeAtom, MoleculeDocument, StagePlacementIntent, Vector3 } from '@chemsmart/studio-protocol'
import { describe, expect, it } from 'vitest'

import { buildStagePlacementPreview } from '../moleculePlacement'

const hash = `sha256:${'a'.repeat(64)}`

function atom(id: string, atomicNumber: number, position: Vector3): MoleculeAtom {
  return { id, atomicNumber, position, formalCharge: 0, extensions: {} }
}

function document(atoms: MoleculeAtom[], bonds: MoleculeDocument['bonds']): MoleculeDocument {
  return {
    documentId: 'document-placement',
    revision: 7,
    atoms,
    bonds,
    selections: [],
    frozenAxes: {},
    constraints: [],
    properties: { charge: 0, multiplicity: 1, extensions: {} },
    extensions: {}
  }
}

function intent(overrides: Partial<StagePlacementIntent> = {}): StagePlacementIntent {
  return {
    documentId: 'document-placement',
    expectedRevision: 7,
    geometryHash: hash,
    anchorAtomId: 'anchor',
    atomicNumber: 1,
    bondOrder: 1,
    coordinationGeometry: 'tetrahedral',
    ...overrides
  }
}

function normalized(vector: Vector3): Vector3 {
  const length = Math.hypot(...vector)
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function direction(from: Vector3, to: Vector3): Vector3 {
  return normalized([to[0] - from[0], to[1] - from[1], to[2] - from[2]])
}

describe('buildStagePlacementPreview', () => {
  it('rotates the tetrahedral guide against an arbitrarily oriented O-H bond', () => {
    const existing = normalized([1, 2, 3])
    const molecule = document(
      [
        atom('anchor', 8, [2, -1, 0.5]),
        atom('H1', 1, [2 + existing[0] * 0.97, -1 + existing[1] * 0.97, 0.5 + existing[2] * 0.97])
      ],
      [{ id: 'bond-oh1', atomIds: ['anchor', 'H1'], order: 1, extensions: {} }]
    )

    const preview = buildStagePlacementPreview(molecule, hash, intent())
    const selected = preview.candidates.find((candidate) => candidate.siteIndex === preview.selectedSiteIndex)

    expect(preview.status).toBe('ready')
    expect(selected?.bondLength).toBeCloseTo(0.97, 8)
    expect(dot(existing, direction([2, -1, 0.5], selected!.position))).toBeCloseTo(-1 / 3, 3)
  })

  it('recovers the vacant site from a rotated, three-coordinate methane guide', () => {
    const sites = [
      normalized([1, 1, 1]),
      normalized([1, -1, -1]),
      normalized([-1, 1, -1]),
      normalized([-1, -1, 1])
    ] as const
    const rotate = ([x, y, z]: Vector3): Vector3 => [z, x, y]
    const rotated = sites.map(rotate)
    const molecule = document(
      [atom('anchor', 6, [0, 0, 0]), atom('H1', 1, rotated[0]), atom('H2', 1, rotated[1]), atom('H3', 1, rotated[2])],
      [0, 1, 2].map((index) => ({
        id: `bond-${index + 1}`,
        atomIds: ['anchor', `H${index + 1}`] as [string, string],
        order: 1 as const,
        extensions: {}
      }))
    )

    const preview = buildStagePlacementPreview(molecule, hash, intent())
    const selected = preview.candidates.find((candidate) => candidate.siteIndex === preview.selectedSiteIndex)

    expect(preview.status).toBe('ready')
    expect(dot(direction([0, 0, 0], selected!.position), rotated[3])).toBeGreaterThan(0.999)
  })

  it('fails closed when the selected coordination is already full', () => {
    const molecule = document(
      [atom('anchor', 6, [0, 0, 0]), atom('left', 1, [-1, 0, 0]), atom('right', 1, [1, 0, 0])],
      [
        { id: 'bond-left', atomIds: ['anchor', 'left'], order: 1, extensions: {} },
        { id: 'bond-right', atomIds: ['anchor', 'right'], order: 1, extensions: {} }
      ]
    )

    const preview = buildStagePlacementPreview(molecule, hash, intent({ coordinationGeometry: 'linear' }))

    expect(preview.status).toBe('coordination_full')
    expect(preview.selectedSiteIndex).toBeUndefined()
    expect(preview.candidates.every((candidate) => candidate.occupied && !candidate.safe)).toBe(true)
  })

  it('selects an alternate site when one vacant direction has a steric collision', () => {
    const base = document(
      [atom('anchor', 6, [0, 0, 0]), atom('H1', 1, normalized([1, 1, 1]))],
      [{ id: 'bond-1', atomIds: ['anchor', 'H1'], order: 1, extensions: {} }]
    )
    const first = buildStagePlacementPreview(base, hash, intent())
    const blocked = first.candidates.find((candidate) => candidate.safe)!
    const molecule = document([...base.atoms, atom('blocker', 8, blocked.position)], base.bonds)

    const preview = buildStagePlacementPreview(molecule, hash, intent())

    expect(preview.status).toBe('ready')
    expect(preview.candidates.find((candidate) => candidate.siteIndex === blocked.siteIndex)?.safe).toBe(false)
    expect(preview.selectedSiteIndex).not.toBe(blocked.siteIndex)
  })

  it('reports steric_collision when every vacant site is blocked', () => {
    const base = document(
      [atom('anchor', 6, [0, 0, 0]), atom('H1', 1, normalized([1, 1, 1]))],
      [{ id: 'bond-1', atomIds: ['anchor', 'H1'], order: 1, extensions: {} }]
    )
    const first = buildStagePlacementPreview(base, hash, intent())
    const blockers = first.candidates
      .filter((candidate) => candidate.safe)
      .map((candidate, index) => atom(`blocker-${index}`, 8, candidate.position))
    const molecule = document([...base.atoms, ...blockers], base.bonds)

    const preview = buildStagePlacementPreview(molecule, hash, intent())

    expect(preview.status).toBe('steric_collision')
    expect(preview.selectedSiteIndex).toBeUndefined()
  })

  it('uses stable site indexes and results across repeated previews', () => {
    const molecule = document(
      [atom('anchor', 8, [0, 0, 0]), atom('H1', 1, normalized([3, -2, 1]))],
      [{ id: 'bond-stable', atomIds: ['anchor', 'H1'], order: 1, extensions: {} }]
    )

    expect(buildStagePlacementPreview(molecule, hash, intent())).toEqual(
      buildStagePlacementPreview(molecule, hash, intent())
    )
  })
})
