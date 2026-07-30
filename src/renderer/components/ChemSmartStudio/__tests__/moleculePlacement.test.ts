import type { MoleculeDocument, StagePlacementPreview } from '@chemsmart/studio-protocol'
import { describe, expect, it } from 'vitest'

import { cyclePlacementSite, moleculeGeometryHash } from '../moleculePlacement'

const document: MoleculeDocument = {
  documentId: 'document-water',
  revision: 2,
  atoms: [
    { id: 'O', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
    { id: 'H', atomicNumber: 1, position: [1, 0, 0], formalCharge: 0, extensions: {} }
  ],
  bonds: [{ id: 'OH', atomIds: ['O', 'H'], order: 1, extensions: {} }],
  selections: [],
  frozenAxes: {},
  constraints: [],
  properties: { extensions: {} },
  extensions: {}
}

const preview: StagePlacementPreview = {
  documentId: document.documentId,
  revision: document.revision,
  geometryHash: `sha256:${'a'.repeat(64)}`,
  anchorAtomId: 'O',
  atomicNumber: 1,
  bondOrder: 1,
  coordinationGeometry: 'tetrahedral',
  candidates: [
    { siteIndex: 0, position: [1, 0, 0], bondLength: 1, minimumClearance: 0, occupied: true, safe: false },
    { siteIndex: 1, position: [0, 1, 0], bondLength: 1, minimumClearance: 1, occupied: false, safe: true },
    { siteIndex: 2, position: [0, 0, 1], bondLength: 1, minimumClearance: 1, occupied: false, safe: true }
  ],
  selectedSiteIndex: 1,
  status: 'ready'
}

describe('molecule placement renderer helpers', () => {
  it('hashes geometry independently of selection and atom order', async () => {
    const reordered = {
      ...document,
      atoms: [...document.atoms].reverse(),
      selections: ['O']
    }

    expect(await moleculeGeometryHash(reordered)).toBe(await moleculeGeometryHash(document))
  })

  it('changes identity when visible coordinates change', async () => {
    const moved = structuredClone(document)
    moved.atoms[1].position = [1.1, 0, 0]

    expect(await moleculeGeometryHash(moved)).not.toBe(await moleculeGeometryHash(document))
  })

  it('cycles only through safe main-validated sites', () => {
    expect(cyclePlacementSite(preview, 1).selectedSiteIndex).toBe(2)
    expect(cyclePlacementSite({ ...preview, selectedSiteIndex: 2 }, 1).selectedSiteIndex).toBe(1)
    expect(cyclePlacementSite(preview, -1).selectedSiteIndex).toBe(2)
  })
})
