import type { MoleculeDocument, StudioAgentActionCue } from '@chemsmart/studio-protocol'
import { describe, expect, it } from 'vitest'

import { buildMoleculeOverlayScene } from '../moleculeOverlay'

const document: MoleculeDocument = {
  documentId: 'document-1',
  revision: 4,
  atoms: [
    { id: 'atom-o', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
    { id: 'atom-h', atomicNumber: 1, position: [1, 0, 0], formalCharge: 0, extensions: {} }
  ],
  bonds: [{ id: 'bond-oh', atomIds: ['atom-o', 'atom-h'], order: 1, extensions: {} }],
  selections: ['atom-h'],
  frozenAxes: { 'atom-o': [true, false, true] },
  constraints: [
    {
      id: 'constraint-oh',
      type: 'distance',
      atomIds: ['atom-o', 'atom-h'],
      target: 0.96,
      unit: 'angstrom',
      extensions: {}
    }
  ],
  properties: { extensions: {} },
  extensions: {}
}

const cue: StudioAgentActionCue = {
  cueId: 'cue-1',
  turnId: 'turn-1',
  documentId: 'document-1',
  revision: 4,
  geometryHash: `sha256:${'a'.repeat(64)}`,
  kind: 'freeze',
  phase: 'running',
  atomIds: ['atom-o'],
  bondIds: ['bond-oh'],
  constraintIds: ['constraint-oh'],
  label: 'Freezing O-H distance'
}

describe('buildMoleculeOverlayScene', () => {
  it('projects constraints, frozen axes and stable-id Agent cues', () => {
    const overlay = buildMoleculeOverlayScene(document, [cue])

    expect(overlay.segments.filter((segment) => segment.kind === 'frozen-axis')).toHaveLength(2)
    expect(overlay.segments.find((segment) => segment.kind === 'distance')).toMatchObject({ dashed: true })
    expect(overlay.segments.find((segment) => segment.kind === 'action')).toBeDefined()
    expect(overlay.markers).toEqual([expect.objectContaining({ atomId: 'atom-o', position: [0, 0, 0], running: true })])
    expect(overlay.labels).toEqual([expect.objectContaining({ id: 'label-constraint-oh', text: '0.96 Å' })])
  })

  it('does not mutate the document selection while projecting Agent activity', () => {
    const before = structuredClone(document)

    buildMoleculeOverlayScene(document, [cue])

    expect(document).toEqual(before)
    expect(document.selections).toEqual(['atom-h'])
  })

  it('ignores stale stable ids instead of guessing a target', () => {
    const overlay = buildMoleculeOverlayScene(document, [
      { ...cue, atomIds: ['atom-absent'], bondIds: ['bond-absent'] }
    ])

    expect(overlay.markers).toHaveLength(0)
    expect(overlay.segments.filter((segment) => segment.kind === 'action')).toHaveLength(0)
  })
})
