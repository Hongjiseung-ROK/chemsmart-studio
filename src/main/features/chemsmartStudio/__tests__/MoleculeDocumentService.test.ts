import { application } from '@application'
import type {
  MoleculeDocument,
  MoleculeOperation,
  MoleculePatch,
  StagePlacementIntent
} from '@chemsmart/studio-protocol'
import { BaseService } from '@main/core/lifecycle/BaseService'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@application', () => ({ application: { get: vi.fn(), getPath: vi.fn() } }))

import { MoleculeDocumentService } from '../MoleculeDocumentService'
import { fromDocument, geometryHash } from '../moleculeDocumentState'

/** Water: O at the origin with two hydrogens, one bond each. */
function waterDocument(): MoleculeDocument {
  return {
    documentId: 'document-water',
    revision: 0,
    atoms: [
      { id: 'atom-o', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
      { id: 'atom-h1', atomicNumber: 1, position: [0.757, 0.586, 0], formalCharge: 0, extensions: {} },
      { id: 'atom-h2', atomicNumber: 1, position: [-0.757, 0.586, 0], formalCharge: 0, extensions: {} }
    ],
    bonds: [
      { id: 'bond-1', atomIds: ['atom-o', 'atom-h1'], order: 1, extensions: {} },
      { id: 'bond-2', atomIds: ['atom-o', 'atom-h2'], order: 1, extensions: {} }
    ],
    selections: [],
    frozenAxes: {},
    constraints: [],
    properties: { charge: 0, multiplicity: 1, extensions: {} },
    extensions: {}
  }
}

function patch(baseRevision: number, ...operations: MoleculeOperation[]): MoleculePatch {
  return {
    operationId: `operation-${baseRevision}-${operations[0]?.op ?? 'none'}`,
    baseRevision,
    actor: 'human',
    previewOnly: true,
    operations,
    extensions: {}
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof IpcError ? error.code : undefined
}

describe('MoleculeDocumentService', () => {
  let service: MoleculeDocumentService
  const commitDocument = vi.fn()
  const clearDraftJournal = vi.fn()
  const readDraftJournal = vi.fn()
  const writeDraftJournal = vi.fn()
  let draftJournal: unknown = null

  beforeEach(() => {
    BaseService.resetInstances()
    commitDocument.mockReset()
    commitDocument.mockResolvedValue(undefined)
    clearDraftJournal.mockReset()
    clearDraftJournal.mockImplementation(async () => {
      draftJournal = null
    })
    readDraftJournal.mockReset()
    readDraftJournal.mockImplementation(async () => structuredClone(draftJournal))
    writeDraftJournal.mockReset()
    writeDraftJournal.mockImplementation(async (payload) => {
      draftJournal = structuredClone(payload)
    })
    draftJournal = null
    vi.mocked(application.get).mockReturnValue({
      clearDraftJournal,
      commitDocument,
      readDraftJournal,
      writeDraftJournal
    } as never)
    service = new MoleculeDocumentService()
    service.loadDocument(waterDocument())
  })

  /** Applies a patch through the full preview -> commit path and returns the new document. */
  async function commit(...operations: MoleculeOperation[]): Promise<MoleculeDocument> {
    const receipt = service.previewPatch(patch(service.getRevision(), ...operations))
    await service.commitPreview(receipt.previewId, service.getRevision())
    return service.getDocument()
  }

  describe('all 11 patch operations', () => {
    it('add_atoms appends an atom with its identity intact', async () => {
      const document = await commit({
        op: 'add_atoms',
        atoms: [{ id: 'atom-x', atomicNumber: 6, position: [1, 2, 3], formalCharge: -1, extensions: {} }]
      })
      const added = document.atoms.find((atom) => atom.id === 'atom-x')
      expect(added).toMatchObject({ atomicNumber: 6, position: [1, 2, 3], formalCharge: -1 })
    })

    it('remove_atoms cascades through bonds, frozen axes and constraints', async () => {
      await commit(
        { op: 'set_frozen_axes', masks: [{ atomId: 'atom-h1', axes: [true, false, false] }] },
        {
          op: 'set_constraints',
          constraints: [
            {
              id: 'constraint-1',
              type: 'distance',
              atomIds: ['atom-o', 'atom-h1'],
              target: 0.96,
              unit: 'angstrom',
              extensions: {}
            }
          ]
        }
      )
      const document = await commit({ op: 'remove_atoms', atomIds: ['atom-h1'] })

      expect(document.atoms.map((atom) => atom.id)).toEqual(['atom-o', 'atom-h2'])
      // The bond, the frozen axis and the constraint all referenced atom-h1 and must be gone.
      expect(document.bonds.map((bond) => bond.id)).toEqual(['bond-2'])
      expect(document.frozenAxes).toEqual({})
      expect(document.constraints).toEqual([])
    })

    it('add_bonds and remove_bonds round-trip', async () => {
      const added = await commit({
        op: 'add_bonds',
        bonds: [{ id: 'bond-hh', atomIds: ['atom-h1', 'atom-h2'], order: 1, extensions: {} }]
      })
      expect(added.bonds.map((bond) => bond.id)).toContain('bond-hh')

      const removed = await commit({ op: 'remove_bonds', bondIds: ['bond-hh'] })
      expect(removed.bonds.map((bond) => bond.id)).not.toContain('bond-hh')
    })

    it('set_positions moves only the named atom', async () => {
      const document = await commit({
        op: 'set_positions',
        positions: [{ atomId: 'atom-h1', position: [9, 9, 9] }]
      })
      expect(document.atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([9, 9, 9])
      expect(document.atoms.find((atom) => atom.id === 'atom-h2')?.position).toEqual([-0.757, 0.586, 0])
    })

    it('set_atomic_numbers changes the element while keeping the stable id', async () => {
      const document = await commit({
        op: 'set_atomic_numbers',
        atoms: [{ atomId: 'atom-h1', atomicNumber: 9 }]
      })
      expect(document.atoms.find((atom) => atom.id === 'atom-h1')?.atomicNumber).toBe(9)
    })

    it('set_bond_orders changes the order', async () => {
      const document = await commit({ op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 2 }] })
      expect(document.bonds.find((bond) => bond.id === 'bond-1')?.order).toBe(2)
    })

    it('set_selection replaces the selection in researcher pick order', async () => {
      const document = await commit({ op: 'set_selection', atomIds: ['atom-h2', 'atom-o'] })
      expect(document.selections).toEqual(['atom-h2', 'atom-o'])
    })

    it('set_frozen_axes records the mask', async () => {
      const document = await commit({
        op: 'set_frozen_axes',
        masks: [{ atomId: 'atom-o', axes: [true, true, false] }]
      })
      expect(document.frozenAxes['atom-o']).toEqual([true, true, false])
    })

    it('set_constraints replaces by id instead of accumulating duplicates', async () => {
      const constraint = {
        id: 'constraint-1',
        type: 'distance' as const,
        atomIds: ['atom-o', 'atom-h1'],
        target: 0.96,
        unit: 'angstrom' as const,
        extensions: {}
      }
      await commit({ op: 'set_constraints', constraints: [constraint] })
      const document = await commit({ op: 'set_constraints', constraints: [{ ...constraint, target: 1.2 }] })

      expect(document.constraints).toHaveLength(1)
      expect(document.constraints[0].target).toBe(1.2)
    })

    it('remove_constraints tolerates an unknown id', async () => {
      const document = await commit({ op: 'remove_constraints', constraintIds: ['constraint-absent'] })
      expect(document.constraints).toEqual([])
    })
  })

  describe('revision discipline', () => {
    it('advances exactly one revision per committed gesture', async () => {
      const revisions: number[] = [service.getRevision()]
      await commit({ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1, 0, 0] }] })
      revisions.push(service.getRevision())
      await commit({ op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-h1', atomicNumber: 9 }] })
      revisions.push(service.getRevision())
      await commit({ op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 2 }] })
      revisions.push(service.getRevision())

      expect(revisions).toEqual([0, 1, 2, 3])
    })

    it('does not advance the revision for a selection', () => {
      const before = service.getRevision()
      service.setSelection('document-water', before, ['atom-o'])
      expect(service.getRevision()).toBe(before)
      expect(service.getDocument().selections).toEqual(['atom-o'])
    })

    it('refuses a patch built against a stale revision', async () => {
      await commit({ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1, 0, 0] }] })
      expect.assertions(1)
      try {
        service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h2'] }))
      } catch (error) {
        expect(codeOf(error)).toBe(chemsmartStudioErrorCodes.REVISION_CONFLICT)
      }
    })

    it('refuses a commit whose expected revision moved', async () => {
      const receipt = service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h2'] }))
      await expect(service.commitPreview(receipt.previewId, 7)).rejects.toMatchObject({
        code: chemsmartStudioErrorCodes.REVISION_CONFLICT
      })
    })
  })

  describe('undo and redo', () => {
    it('restores the original stable ids and coordinates, on a new revision', async () => {
      const original = service.getDocument()
      await commit({ op: 'remove_atoms', atomIds: ['atom-h1'] })
      expect(service.getDocument().atoms.map((atom) => atom.id)).toEqual(['atom-o', 'atom-h2'])

      const restored = await service.undo()

      expect(restored.atoms.map((atom) => atom.id)).toEqual(original.atoms.map((atom) => atom.id))
      expect(restored.atoms.map((atom) => atom.position)).toEqual(original.atoms.map((atom) => atom.position))
      expect(restored.bonds.map((bond) => bond.id)).toEqual(original.bonds.map((bond) => bond.id))
      // Monotonic: undo publishes a new revision rather than rewinding to the old number.
      expect(restored.revision).toBe(2)
    })

    it('redo re-applies the undone gesture', async () => {
      await commit({ op: 'remove_atoms', atomIds: ['atom-h1'] })
      await service.undo()
      const redone = await service.redo()

      expect(redone.atoms.map((atom) => atom.id)).toEqual(['atom-o', 'atom-h2'])
      expect(redone.revision).toBe(3)
    })

    it('returns the document unchanged at the end of history', async () => {
      const before = service.getDocument()
      await expect(service.undo()).resolves.toEqual(before)
    })

    it('a fresh commit invalidates the redo branch', async () => {
      await commit({ op: 'remove_atoms', atomIds: ['atom-h1'] })
      await service.undo()
      await commit({ op: 'set_positions', positions: [{ atomId: 'atom-h2', position: [5, 5, 5] }] })

      const afterRedo = await service.redo()
      expect(afterRedo.atoms.find((atom) => atom.id === 'atom-h2')?.position).toEqual([5, 5, 5])
    })
  })

  describe('recoverable draft editing', () => {
    const draftRequest = (operations: readonly MoleculeOperation[]) => ({
      actor: 'human' as const,
      expectedRevision: 0,
      mode: 'build' as const,
      operations
    })

    it('stacks edits without changing the committed revision, then publishes one revision', async () => {
      await service.applyDraftPatch(
        draftRequest([{ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1, 0, 0] }] }])
      )
      const draft = await service.applyDraftPatch(
        draftRequest([{ op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-h2', atomicNumber: 9 }] }])
      )

      expect(service.getRevision()).toBe(0)
      expect(service.getDocument().atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([0.757, 0.586, 0])
      expect(draft.cursor).toBe(2)
      expect(draft.document.atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([1, 0, 0])
      expect(draft.document.atoms.find((atom) => atom.id === 'atom-h2')?.atomicNumber).toBe(9)
      expect(writeDraftJournal).toHaveBeenCalledTimes(2)
      expect(commitDocument).not.toHaveBeenCalled()

      const committed = await service.commitDraft(0)
      expect(committed.revision).toBe(1)
      expect(committed.atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([1, 0, 0])
      expect(committed.atoms.find((atom) => atom.id === 'atom-h2')?.atomicNumber).toBe(9)
      expect(commitDocument).toHaveBeenCalledTimes(1)
      expect(clearDraftJournal).toHaveBeenCalledTimes(1)
      expect(service.hasActiveDraft()).toBe(false)
    })

    it('undoes and redoes inside the draft without publishing committed revisions', async () => {
      await service.applyDraftPatch(
        draftRequest([{ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1, 0, 0] }] }])
      )
      await service.applyDraftPatch(
        draftRequest([{ op: 'set_positions', positions: [{ atomId: 'atom-h2', position: [2, 0, 0] }] }])
      )

      const undone = await service.undoDraft()
      expect(undone?.cursor).toBe(1)
      expect(undone?.document.atoms.find((atom) => atom.id === 'atom-h2')?.position).toEqual([-0.757, 0.586, 0])
      const redone = await service.redoDraft()
      expect(redone?.cursor).toBe(2)
      expect(redone?.document.atoms.find((atom) => atom.id === 'atom-h2')?.position).toEqual([2, 0, 0])
      expect(service.getRevision()).toBe(0)
      expect(commitDocument).not.toHaveBeenCalled()
    })

    it('recovers a hash-checked draft journal on the same committed revision', async () => {
      const expected = await service.applyDraftPatch(
        draftRequest([{ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [3, 2, 1] }] }])
      )
      BaseService.resetInstances()
      const recovered = new MoleculeDocumentService()
      recovered.loadDocument(waterDocument())

      await expect(recovered.recoverDraft()).resolves.toEqual(expected)
      expect(recovered.getDraftSnapshot()?.document.atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([
        3, 2, 1
      ])
    })

    it('excludes transient selection from recoverable draft hashes', async () => {
      service.setSelection('document-water', 0, ['atom-o'])
      await service.applyDraftPatch(
        draftRequest([{ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [3, 2, 1] }] }])
      )
      BaseService.resetInstances()
      const recovered = new MoleculeDocumentService()
      recovered.loadDocument(waterDocument())

      await expect(recovered.recoverDraft()).resolves.toMatchObject({
        document: { selections: [] },
        cursor: 1,
        dirty: true
      })
    })

    it('discards the draft without changing committed geometry', async () => {
      await service.applyDraftPatch(draftRequest([{ op: 'remove_atoms', atomIds: ['atom-h1'] }]))
      const document = await service.discardDraft()
      expect(document.revision).toBe(0)
      expect(document.atoms).toHaveLength(3)
      expect(clearDraftJournal).toHaveBeenCalledTimes(1)
    })
  })

  it('commits a verified final geometry durably and keeps it undoable', async () => {
    const geometry = {
      documentId: 'document-water',
      atoms: waterDocument().atoms.map((atom) =>
        atom.id === 'atom-h1' ? { ...atom, position: [1.1, 0, 0] as [number, number, number] } : atom
      )
    }

    service.acquireMutationLock('run-1', 'document-water', 0)
    const committed = await service.commitFinalGeometry('run-1', geometry, 0)
    service.releaseMutationLock('run-1')

    expect(committed.revision).toBe(1)
    expect(committed.atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([1.1, 0, 0])
    expect(commitDocument).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }))
    const restored = await service.undo()
    expect(restored.atoms.find((atom) => atom.id === 'atom-h1')?.position).toEqual([0.757, 0.586, 0])
  })

  describe('preview lifecycle', () => {
    it('keeps the old revision and approved preview when durable publication fails', async () => {
      commitDocument.mockRejectedValueOnce(new Error('simulated fsync failure'))
      const receipt = service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h1'] }))

      await expect(service.commitPreview(receipt.previewId, 0)).rejects.toThrow('simulated fsync failure')

      expect(service.getRevision()).toBe(0)
      expect(service.getDocument().atoms).toHaveLength(3)
      expect(service.hasActivePreview()).toBe(true)
    })

    it('leaves the committed document untouched until commit', () => {
      service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h1'] }))
      expect(service.getDocument().atoms).toHaveLength(3)
      expect(service.getRevision()).toBe(0)
    })

    it('refuses a commit for an unknown preview id', async () => {
      service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h1'] }))
      await expect(service.commitPreview('preview-does-not-exist', 0)).rejects.toMatchObject({
        code: chemsmartStudioErrorCodes.APPROVAL_REQUIRED
      })
    })

    it('discards a preview without touching the document', () => {
      const receipt = service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h1'] }))
      expect(service.discardPreview(receipt.previewId)).toEqual({ discarded: true, previewId: receipt.previewId })
      expect(service.getDocument().atoms).toHaveLength(3)
      expect(service.hasActivePreview()).toBe(false)
    })

    it('refuses a selection while a preview is open', () => {
      service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h1'] }))
      expect.assertions(1)
      try {
        service.setSelection('document-water', 0, ['atom-o'])
      } catch (error) {
        expect(codeOf(error)).toBe(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
      }
    })

    it('refuses undo while a preview is open', async () => {
      await commit({ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1, 0, 0] }] })
      service.previewPatch(patch(1, { op: 'remove_atoms', atomIds: ['atom-h2'] }))
      await expect(service.undo()).rejects.toMatchObject({
        code: chemsmartStudioErrorCodes.APPROVAL_REQUIRED
      })
    })

    it('reports affected atom and bond ids in the receipt', () => {
      const receipt = service.previewPatch(patch(0, { op: 'remove_atoms', atomIds: ['atom-h1'] }))
      expect(receipt.affectedAtomIds).toEqual(['atom-h1'])
      expect(receipt.affectedBondIds).toEqual(['bond-1'])
      expect(receipt.summary).toEqual({
        operationKinds: ['remove_atoms'],
        elementChanges: [{ atomId: 'atom-h1', kind: 'removed', beforeAtomicNumber: 1 }],
        coordinateChangeCount: 0,
        bondChangeCount: 0,
        constraintChangeCount: 0,
        affectedAtomIds: ['atom-h1'],
        affectedBondIds: ['bond-1'],
        affectedConstraintIds: []
      })
      expect(receipt.beforeHash).not.toBe(receipt.afterHash)
    })

    it('derives a path-free human summary for element, coordinate, bond, and constraint changes', () => {
      const receipt = service.previewPatch(
        patch(
          0,
          { op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-o', atomicNumber: 7 }] },
          { op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1.2, 0, 0] }] },
          { op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 2 }] },
          {
            op: 'set_constraints',
            constraints: [
              {
                id: 'constraint-oh',
                type: 'distance',
                atomIds: ['atom-o', 'atom-h1'],
                target: 1.2,
                unit: 'angstrom',
                extensions: {}
              }
            ]
          }
        )
      )

      expect(receipt.summary).toEqual({
        operationKinds: ['set_atomic_numbers', 'set_positions', 'set_bond_orders', 'set_constraints'],
        elementChanges: [{ atomId: 'atom-o', kind: 'changed', beforeAtomicNumber: 8, afterAtomicNumber: 7 }],
        coordinateChangeCount: 1,
        bondChangeCount: 1,
        constraintChangeCount: 1,
        affectedAtomIds: ['atom-h1', 'atom-o'],
        affectedBondIds: ['bond-1'],
        affectedConstraintIds: ['constraint-oh']
      })
      expect(JSON.stringify(receipt.summary)).not.toContain('/')
    })
  })

  describe('operation validation', () => {
    const rejected: Array<[string, MoleculeOperation]> = [
      ['an unknown atom id', { op: 'set_positions', positions: [{ atomId: 'atom-absent', position: [0, 0, 0] }] }],
      [
        'a duplicate atom id',
        {
          op: 'add_atoms',
          atoms: [{ id: 'atom-o', atomicNumber: 6, position: [0, 0, 0], formalCharge: 0, extensions: {} }]
        }
      ],
      ['an out-of-range element', { op: 'set_atomic_numbers', atoms: [{ atomId: 'atom-o', atomicNumber: 0 }] }],
      [
        'a duplicate id inside one operation',
        {
          op: 'set_atomic_numbers',
          atoms: [
            { atomId: 'atom-o', atomicNumber: 7 },
            { atomId: 'atom-o', atomicNumber: 8 }
          ]
        }
      ],
      ['an out-of-range bond order', { op: 'set_bond_orders', bonds: [{ bondId: 'bond-1', order: 9 as 1 }] }],
      [
        'a self bond',
        { op: 'add_bonds', bonds: [{ id: 'bond-self', atomIds: ['atom-o', 'atom-o'], order: 1, extensions: {} }] }
      ],
      ['a selection of an unknown atom', { op: 'set_selection', atomIds: ['atom-absent'] }],
      [
        'a frozen axis mask of the wrong arity',
        {
          op: 'set_frozen_axes',
          masks: [{ atomId: 'atom-o', axes: [true, false] as unknown as [boolean, boolean, boolean] }]
        }
      ],
      [
        'a constraint over an unknown atom',
        {
          op: 'set_constraints',
          constraints: [
            {
              id: 'constraint-bad',
              type: 'distance',
              atomIds: ['atom-o', 'atom-absent'],
              target: 1,
              unit: 'angstrom',
              extensions: {}
            }
          ]
        }
      ],
      [
        'an angle constraint beyond 180 degrees',
        {
          op: 'set_constraints',
          constraints: [
            {
              id: 'constraint-bad',
              type: 'angle',
              atomIds: ['atom-h1', 'atom-o', 'atom-h2'],
              target: 240,
              unit: 'degree',
              extensions: {}
            }
          ]
        }
      ]
    ]

    it.each(rejected)('refuses %s with SCHEMA_INVALID', (_label, operation) => {
      expect.assertions(2)
      try {
        service.previewPatch(patch(0, operation))
      } catch (error) {
        expect(codeOf(error)).toBe(chemsmartStudioErrorCodes.SCHEMA_INVALID)
      }
      // A refused patch must leave no preview behind.
      expect(service.hasActivePreview()).toBe(false)
    })

    it('refuses a patch that is not preview-only', () => {
      expect.assertions(1)
      try {
        service.previewPatch({ ...patch(0, { op: 'set_selection', atomIds: [] }), previewOnly: false as true })
      } catch (error) {
        expect(codeOf(error)).toBe(chemsmartStudioErrorCodes.SCHEMA_INVALID)
      }
    })

    it('refuses every edit while the geometry is locked by a run', () => {
      service.acquireMutationLock('run-1', 'document-water', 0)
      expect.assertions(1)
      try {
        service.previewPatch(patch(0, { op: 'set_selection', atomIds: [] }))
      } catch (error) {
        expect(codeOf(error)).toBe(chemsmartStudioErrorCodes.APPROVAL_REQUIRED)
      }
    })
  })

  describe('main-owned coordination placement', () => {
    const intent = (overrides: Partial<StagePlacementIntent> = {}): StagePlacementIntent => ({
      documentId: 'document-water',
      expectedRevision: 0,
      geometryHash: geometryHash(fromDocument(waterDocument())),
      anchorAtomId: 'atom-o',
      atomicNumber: 1,
      bondOrder: 1,
      coordinationGeometry: 'tetrahedral',
      ...overrides
    })

    it('journals a safe site using main-issued atom and bond ids', async () => {
      const preview = service.previewStagePlacement(intent())
      const result = await service.applyStagePlacement(intent({ siteIndex: preview.selectedSiteIndex }))

      expect(result.insertedAtomId).toMatch(/^atom-/)
      expect(result.snapshot.document.atoms).toContainEqual(
        expect.objectContaining({ id: result.insertedAtomId, atomicNumber: 1 })
      )
      expect(result.snapshot.document.bonds).toContainEqual(
        expect.objectContaining({ atomIds: ['atom-o', result.insertedAtomId] })
      )
      expect(writeDraftJournal).toHaveBeenCalledOnce()
    })

    it('fails closed when the visible draft geometry hash is stale', async () => {
      await service.applyDraftPatch({
        actor: 'human',
        expectedRevision: 0,
        mode: 'build',
        operations: [{ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [2, 0, 0] }] }]
      })

      expect(() => service.previewStagePlacement(intent())).toThrow(
        expect.objectContaining({ code: chemsmartStudioErrorCodes.REVISION_CONFLICT })
      )
    })

    it('reports a saturated coordination guide without guessing a site', () => {
      const preview = service.previewStagePlacement(intent({ coordinationGeometry: 'linear' }))

      expect(preview.status).toBe('coordination_full')
      expect(preview.selectedSiteIndex).toBeUndefined()
    })
  })

  it('notifies listeners once per committed revision', async () => {
    const seen: number[] = []
    service.onCommitted(({ revision }) => seen.push(revision))

    await commit({ op: 'set_positions', positions: [{ atomId: 'atom-h1', position: [1, 0, 0] }] })
    await commit({ op: 'set_positions', positions: [{ atomId: 'atom-h2', position: [2, 0, 0] }] })
    await service.undo()

    expect(seen).toEqual([1, 2, 3])
  })
})
