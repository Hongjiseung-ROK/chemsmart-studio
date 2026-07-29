import type { MoleculeDocument } from '@chemsmart/studio-protocol'
import { describe, expect, it } from 'vitest'

import { angle, distance } from '../moleculeGeometry'
import { positionForNextCoordinationSite } from '../moleculePlacement'

function documentWithOneBond(): MoleculeDocument {
  return {
    documentId: 'document-water',
    revision: 0,
    atoms: [
      { id: 'O', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
      {
        id: 'H1',
        atomicNumber: 1,
        position: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
        formalCharge: 0,
        extensions: {}
      }
    ],
    bonds: [{ id: 'OH1', atomIds: ['O', 'H1'], order: 1, extensions: {} }],
    selections: [],
    frozenAxes: {},
    constraints: [],
    properties: { charge: 0, multiplicity: 1, extensions: {} },
    extensions: {}
  }
}

describe('positionForNextCoordinationSite', () => {
  it('uses a vacant tetrahedral direction for a second bonded atom', () => {
    const document = documentWithOneBond()
    const secondHydrogen = positionForNextCoordinationSite(document, 'O', 'tetrahedral', 1)

    expect(secondHydrogen).not.toEqual(document.atoms[1].position)
    expect(distance([0, 0, 0], secondHydrogen)).toBeCloseTo(1, 8)
    expect(angle(document.atoms[1].position, [0, 0, 0], secondHydrogen)).toBeCloseTo(109.47, 2)
  })

  it('places the second linear neighbor opposite the occupied bond', () => {
    const document = documentWithOneBond()
    document.atoms[1].position = [1, 0, 0]

    expect(positionForNextCoordinationSite(document, 'O', 'linear', 1.5)).toEqual([-1.5, 0, 0])
  })
})
