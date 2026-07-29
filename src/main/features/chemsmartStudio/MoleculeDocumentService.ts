import { randomUUID } from 'node:crypto'

import { application } from '@application'
import type {
  MoleculeCommitReceipt,
  MoleculeDocument,
  MoleculeOperation,
  MoleculePatch,
  PreviewReceipt,
  StageGestureIntent,
  StudioDraftEntry,
  StudioDraftSnapshot,
  StudioPreviewSummary
} from '@chemsmart/studio-protocol'
import { moleculeDocumentRuntimeSchema, studioDraftRuntimeSchema } from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Emitter, type Event, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'

import {
  applyOperations,
  cloneState,
  fromDocument,
  geometryHash,
  MoleculeOperationError,
  type MoleculeState,
  orderedSelectedAtomIds,
  toDocument,
  trustedMoleculeStateHash
} from './moleculeDocumentState'

const logger = loggerService.withContext('MoleculeDocumentService')

/** Matches the helper's selection bound. */
const MAX_SELECTION_ATOMS = 4096
/** Bounds the undo history so a long session cannot grow without limit. */
const MAX_UNDO_DEPTH = 128

interface PreviewSlot {
  previewId: string
  operationId: string
  baseRevision: number
  state: MoleculeState
  /** Re-derived at commit; a mismatch means the approved preview was mutated behind the approval. */
  approvedStateHash: string
  affectedAtomIds: readonly string[]
  affectedBondIds: readonly string[]
  beforeHash: string
  operationCount: number
}

interface DraftSlot {
  draftId: string
  baseRevision: number
  history: MoleculeState[]
  entries: StudioDraftEntry[]
  cursor: number
  createdAt: string
  updatedAt: string
}

interface DraftJournalPayload {
  version: 1
  snapshot: StudioDraftSnapshot
  history: MoleculeDocument[]
}

export interface MoleculeDiscardReceipt {
  discarded: true
  previewId: string
}

export interface CommittedMutation {
  documentId: string
  revision: number
}

function fail(code: keyof typeof chemsmartStudioErrorCodes, message: string): IpcError {
  return new IpcError(chemsmartStudioErrorCodes[code], message)
}

const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const runtimeRootValidator = <Output>(schema: object) => {
  const isolated = JSON.parse(JSON.stringify(schema)) as JsonSchemaType & { $id?: string }
  // CfWorker validates the cloned document under its own root URI. A generated canonical $id
  // would send local #/$defs references to a different, unregistered document.
  delete isolated.$id
  const validate = runtimeValidator.getValidator<Output>(isolated)
  return (value: unknown): value is Output => {
    try {
      return validate(value).valid
    } catch {
      return false
    }
  }
}
const isDraftSnapshot = runtimeRootValidator<StudioDraftSnapshot>(studioDraftRuntimeSchema)
const isMoleculeDocument = runtimeRootValidator<MoleculeDocument>(moleculeDocumentRuntimeSchema)

function emptyState(documentId: string): MoleculeState {
  return {
    documentId,
    atoms: new Map(),
    bonds: new Map(),
    selected: new Set(),
    selectionOrder: [],
    frozenAxes: new Map(),
    constraints: [],
    properties: { extensions: {} },
    extensions: {}
  }
}

function studioPreviewSummary(
  before: MoleculeState,
  after: MoleculeState,
  operations: readonly MoleculeOperation[],
  affectedAtomIds: ReadonlySet<string>,
  affectedBondIds: ReadonlySet<string>
): StudioPreviewSummary {
  const elementChanges: StudioPreviewSummary['elementChanges'] = []
  const atomIds = new Set([...before.atoms.keys(), ...after.atoms.keys()])
  for (const atomId of [...atomIds].sort()) {
    const beforeAtomicNumber = before.atoms.get(atomId)?.atomicNumber
    const afterAtomicNumber = after.atoms.get(atomId)?.atomicNumber
    if (beforeAtomicNumber === afterAtomicNumber) continue
    if (beforeAtomicNumber === undefined) {
      elementChanges.push({ atomId, kind: 'added', afterAtomicNumber })
    } else if (afterAtomicNumber === undefined) {
      elementChanges.push({ atomId, kind: 'removed', beforeAtomicNumber })
    } else {
      elementChanges.push({ atomId, kind: 'changed', beforeAtomicNumber, afterAtomicNumber })
    }
  }

  let coordinateChangeCount = 0
  let bondChangeCount = 0
  let constraintChangeCount = 0
  const affectedConstraintIds = new Set<string>()
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_atoms':
        coordinateChangeCount += operation.atoms.length
        break
      case 'set_positions':
        coordinateChangeCount += operation.positions.length
        break
      case 'add_bonds':
        bondChangeCount += operation.bonds.length
        break
      case 'remove_bonds':
        bondChangeCount += operation.bondIds.length
        break
      case 'set_bond_orders':
        bondChangeCount += operation.bonds.length
        break
      case 'set_constraints':
        constraintChangeCount += operation.constraints.length
        for (const constraint of operation.constraints) affectedConstraintIds.add(constraint.id)
        break
      case 'remove_constraints':
        constraintChangeCount += operation.constraintIds.length
        for (const constraintId of operation.constraintIds) affectedConstraintIds.add(constraintId)
        break
      case 'set_frozen_axes':
        constraintChangeCount += operation.masks.length
        break
      case 'remove_atoms':
      case 'set_atomic_numbers':
      case 'set_selection':
        break
    }
  }

  return {
    operationKinds: [...new Set(operations.map((operation) => operation.op))],
    elementChanges,
    coordinateChangeCount,
    bondChangeCount,
    constraintChangeCount,
    affectedAtomIds: [...affectedAtomIds].sort(),
    affectedBondIds: [...affectedBondIds].sort(),
    affectedConstraintIds: [...affectedConstraintIds].sort()
  }
}

/**
 * The authoritative molecule document. The renderer draws from what this service publishes
 * and never mutates it.
 *
 * Two invariants carried over from the helper:
 *
 *   - `revision` is monotonic. Undo does not rewind it — it publishes a *new* revision whose
 *     content is the previous state, so no two distinct states ever share a revision and
 *     `expectedRevision` stays a sound conflict check.
 *   - A preview is inert until committed, and commit re-derives the approved state hash. If it
 *     no longer matches what was approved, the commit fails closed rather than writing.
 *
 * Undo is snapshot-based rather than the helper's `RWMolecule` stack plus `CommittedSideState`
 * keyed on `undoStack().index()`. That pairing could fall out of sync, which is why the helper
 * needed a redo-the-undo rollback path; a snapshot either exists or it does not.
 */
@Injectable('MoleculeDocumentService')
@DependsOn(['MoleculeProjectStore'])
@ServicePhase(Phase.WhenReady)
export class MoleculeDocumentService extends BaseService {
  private committed: MoleculeState = emptyState(`document-${randomUUID()}`)
  private revision = 0
  private preview: PreviewSlot | null = null
  private draft: DraftSlot | null = null
  private undoStack: MoleculeState[] = []
  private redoStack: MoleculeState[] = []
  /** Exact run that owns geometry mutation while executing or awaiting a final decision. */
  private mutationLock: { runId: string; reason: string } | null = null
  private durableMutationInFlight = false

  private readonly committedEmitter = new Emitter<CommittedMutation>()
  /** Fires after every revision bump so persistence and notification stay out of this service. */
  readonly onCommitted: Event<CommittedMutation> = this.committedEmitter.event

  protected async onInit(): Promise<void> {
    const project = await application.get('MoleculeProjectStore').ensureDefaultProject(this.getDocument())
    this.loadDocument(project.document)
    await this.recoverDraft()
  }

  getDocument(): MoleculeDocument {
    return toDocument(this.committed, this.revision)
  }

  getRevision(): number {
    return this.revision
  }

  getDocumentId(): string {
    return this.committed.documentId
  }

  hasActivePreview(): boolean {
    return this.preview !== null
  }

  hasActiveDraft(): boolean {
    return this.draft !== null
  }

  getDraftSnapshot(): StudioDraftSnapshot | null {
    return this.draft ? this.toDraftSnapshot(this.draft) : null
  }

  /** Replaces the whole document, as an import or project open does. Resets history. */
  loadDocument(document: MoleculeDocument): void {
    this.committed = fromDocument(document)
    // Selection belongs to the current view, never the persisted project or undo history.
    this.committed.selected.clear()
    this.committed.selectionOrder = []
    this.revision = document.revision
    this.preview = null
    this.draft = null
    this.undoStack = []
    this.redoStack = []
    logger.info('Loaded molecule document', {
      documentId: this.committed.documentId,
      revision: this.revision,
      atomCount: this.committed.atoms.size
    })
  }

  acquireMutationLock(runId: string, documentId: string, expectedRevision: number): void {
    if (this.mutationLock && this.mutationLock.runId !== runId) {
      throw fail('RUN_ACTIVE', 'Another optimization owns molecule mutation')
    }
    if (documentId !== this.committed.documentId || expectedRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Optimization mutation lock targets a stale molecule revision')
    }
    if (this.preview || this.draft) {
      throw fail('APPROVAL_REQUIRED', 'Apply or discard the active molecule draft before running')
    }
    this.mutationLock = {
      runId,
      reason: 'Molecule edits are locked while an optimization is active'
    }
  }

  releaseMutationLock(runId: string): void {
    if (!this.mutationLock) return
    if (this.mutationLock.runId !== runId) {
      throw fail('RUN_ACTIVE', 'Another optimization owns molecule mutation')
    }
    this.mutationLock = null
  }

  getMutationLockOwner(): string | null {
    return this.mutationLock?.runId ?? null
  }

  private assertEditable(): void {
    if (this.mutationLock) {
      throw fail('APPROVAL_REQUIRED', this.mutationLock.reason)
    }
  }

  /** Selection is transient view state and follows the visible draft without entering its history. */
  setSelection(documentId: string, expectedRevision: number, atomIds: readonly string[]): MoleculeDocument {
    if (atomIds.length > MAX_SELECTION_ATOMS) {
      throw fail('SCHEMA_INVALID', 'Molecule selection request is invalid')
    }
    if (documentId !== this.committed.documentId || expectedRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Molecule selection targets a stale revision')
    }
    if (this.preview) throw fail('APPROVAL_REQUIRED', 'Molecule selection requires the committed or draft view')
    const visible = this.draft?.history[this.draft.cursor] ?? this.committed
    for (const atomId of atomIds) {
      if (!visible.atoms.has(atomId)) {
        throw fail('SCHEMA_INVALID', 'Molecule selection references an unknown atom')
      }
    }
    visible.selected = new Set(atomIds)
    visible.selectionOrder = [...atomIds]
    return toDocument(visible, this.revision)
  }

  /**
   * Appends one validated researcher or Agent edit to the recoverable draft. The journal reaches
   * disk before the in-memory draft becomes visible, so an interrupted edit is either absent or
   * recoverable in full.
   */
  async applyDraftPatch(request: {
    actor: 'human' | 'agent'
    expectedRevision: number
    mode: StudioDraftEntry['mode']
    operations: readonly MoleculeOperation[]
    gesture?: StageGestureIntent
  }): Promise<StudioDraftSnapshot> {
    this.assertEditable()
    if (this.preview) throw fail('APPROVAL_REQUIRED', 'Commit or discard the active agent preview')
    if (request.expectedRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Draft edit targets a stale committed revision')
    }
    if (request.operations.length === 0 || request.operations.length > 64) {
      throw fail('SCHEMA_INVALID', 'Draft edit operation count is invalid')
    }

    const current = this.draft?.history[this.draft.cursor] ?? this.committed
    const candidate = cloneState(current)
    let outcome: ReturnType<typeof applyOperations>
    try {
      outcome = applyOperations(candidate, request.operations)
    } catch (error) {
      if (error instanceof MoleculeOperationError) throw fail('SCHEMA_INVALID', error.message)
      throw error
    }
    candidate.selectionOrder = orderedSelectedAtomIds(candidate)

    const now = new Date().toISOString()
    const existing = this.draft
    const entries = existing ? existing.entries.slice(0, existing.cursor) : []
    const history = existing ? existing.history.slice(0, existing.cursor + 1) : [cloneState(this.committed)]
    if (entries.length >= MAX_UNDO_DEPTH) {
      throw fail('APPROVAL_REQUIRED', 'Apply or discard the molecule draft before adding more changes')
    }
    const entry: StudioDraftEntry = {
      entryId: `draft-entry-${randomUUID()}`,
      actor: request.actor,
      mode: request.mode,
      operations: [...request.operations],
      summary: studioPreviewSummary(
        current,
        candidate,
        request.operations,
        outcome.affectedAtomIds,
        outcome.affectedBondIds
      ),
      beforeHash: trustedMoleculeStateHash(current),
      afterHash: trustedMoleculeStateHash(candidate),
      ...(request.gesture ? { gesture: request.gesture } : {}),
      createdAt: now,
      extensions: {}
    }
    entries.push(entry)
    history.push(candidate)
    const next: DraftSlot = {
      draftId: existing?.draftId ?? `draft-${randomUUID()}`,
      baseRevision: this.revision,
      history,
      entries,
      cursor: entries.length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await this.persistDraft(next)
    this.draft = next
    return this.toDraftSnapshot(next)
  }

  async undoDraft(): Promise<StudioDraftSnapshot | null> {
    const draft = this.draft
    if (!draft) return null
    if (draft.cursor === 0) return this.toDraftSnapshot(draft)
    const next = { ...draft, cursor: draft.cursor - 1, updatedAt: new Date().toISOString() }
    await this.persistDraft(next)
    this.draft = next
    return this.toDraftSnapshot(next)
  }

  async redoDraft(): Promise<StudioDraftSnapshot | null> {
    const draft = this.draft
    if (!draft) return null
    if (draft.cursor >= draft.entries.length) return this.toDraftSnapshot(draft)
    const next = { ...draft, cursor: draft.cursor + 1, updatedAt: new Date().toISOString() }
    await this.persistDraft(next)
    this.draft = next
    return this.toDraftSnapshot(next)
  }

  async commitDraft(expectedRevision: number): Promise<MoleculeDocument> {
    this.assertEditable()
    if (this.preview) throw fail('APPROVAL_REQUIRED', 'Commit or discard the active agent preview')
    const draft = this.draft
    if (!draft) return this.getDocument()
    if (expectedRevision !== this.revision || draft.baseRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Molecule draft no longer matches the committed revision')
    }
    if (draft.cursor === 0) {
      await application.get('MoleculeProjectStore').clearDraftJournal()
      this.draft = null
      return this.getDocument()
    }

    return this.withDurableMutation(async () => {
      const candidate = draft.history[draft.cursor]
      const nextRevision = this.revision + 1
      await application.get('MoleculeProjectStore').commitDocument(toDocument(candidate, nextRevision))
      this.pushUndo()
      this.committed = candidate
      this.revision = nextRevision
      this.draft = null
      try {
        await application.get('MoleculeProjectStore').clearDraftJournal()
      } catch (error) {
        // A stale journal cannot reapply: recovery requires its base revision to match the committed
        // document. Keep the successful durable commit visible and clean the stale file next start.
        logger.warn('Committed molecule draft left a stale recovery journal', error as Error)
      }
      this.committedEmitter.fire({ documentId: this.committed.documentId, revision: this.revision })
      return this.getDocument()
    })
  }

  async discardDraft(): Promise<MoleculeDocument> {
    if (!this.draft) return this.getDocument()
    await application.get('MoleculeProjectStore').clearDraftJournal()
    this.draft = null
    return this.getDocument()
  }

  /**
   * Applies the patch to a clone and holds it as the pending preview. Nothing about the
   * committed document changes until `commitPreview` succeeds.
   */
  previewPatch(patch: MoleculePatch): PreviewReceipt {
    this.assertEditable()
    if (this.draft) throw fail('APPROVAL_REQUIRED', 'Apply or discard the active molecule draft')
    if (patch.previewOnly !== true) {
      throw fail('SCHEMA_INVALID', 'Patch must be preview-only at the current revision')
    }
    if (patch.baseRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Patch must be preview-only at the current revision')
    }

    const beforeHash = trustedMoleculeStateHash(this.committed)
    const candidate = cloneState(this.committed)
    let outcome: ReturnType<typeof applyOperations>
    try {
      outcome = applyOperations(candidate, patch.operations)
    } catch (error) {
      if (error instanceof MoleculeOperationError) throw fail('SCHEMA_INVALID', error.message)
      throw error
    }
    // Drop any selected id the operations removed, so the preview's selection is realisable.
    candidate.selectionOrder = orderedSelectedAtomIds(candidate)

    const approvedStateHash = trustedMoleculeStateHash(candidate)
    const previewId = `preview-${randomUUID()}`
    this.preview = {
      previewId,
      operationId: patch.operationId,
      baseRevision: this.revision,
      state: candidate,
      approvedStateHash,
      affectedAtomIds: [...outcome.affectedAtomIds].sort(),
      affectedBondIds: [...outcome.affectedBondIds].sort(),
      beforeHash,
      operationCount: patch.operations.length
    }

    return {
      previewId,
      operationId: patch.operationId,
      baseRevision: this.revision,
      affectedAtomIds: [...this.preview.affectedAtomIds],
      affectedBondIds: [...this.preview.affectedBondIds],
      beforeHash,
      afterHash: approvedStateHash,
      diff: { operationCount: patch.operations.length },
      summary: studioPreviewSummary(
        this.committed,
        candidate,
        patch.operations,
        outcome.affectedAtomIds,
        outcome.affectedBondIds
      ),
      createdAt: new Date().toISOString(),
      extensions: {}
    }
  }

  async commitPreview(previewId: string, expectedRevision: number): Promise<MoleculeCommitReceipt> {
    this.assertEditable()
    const preview = this.preview
    if (!preview || preview.previewId !== previewId) {
      throw fail('APPROVAL_REQUIRED', 'Preview is missing or does not match')
    }
    if (expectedRevision !== this.revision || preview.baseRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Committed molecule changed after preview creation')
    }
    // What is written must be exactly what was approved.
    if (trustedMoleculeStateHash(preview.state) !== preview.approvedStateHash) {
      throw fail('SCHEMA_INVALID', 'Approved molecule preview state is inconsistent')
    }

    return this.withDurableMutation(async () => {
      const nextRevision = this.revision + 1
      const nextDocument = toDocument(preview.state, nextRevision)
      await application.get('MoleculeProjectStore').commitDocument(nextDocument)

      this.pushUndo()
      this.committed = preview.state
      this.preview = null
      this.revision = nextRevision
      this.committedEmitter.fire({ documentId: this.committed.documentId, revision: this.revision })

      return {
        type: 'molecule_commit',
        previewId,
        revision: this.revision,
        timestamp: new Date().toISOString(),
        geometryHash: geometryHash(this.committed),
        stateHash: preview.approvedStateHash
      }
    })
  }

  discardPreview(previewId: string): MoleculeDiscardReceipt {
    if (!this.preview || this.preview.previewId !== previewId) {
      throw fail('APPROVAL_REQUIRED', 'Preview is missing or does not match')
    }
    this.preview = null
    return { discarded: true, previewId }
  }

  async undo(): Promise<MoleculeDocument> {
    return this.travel('undo')
  }

  async redo(): Promise<MoleculeDocument> {
    return this.travel('redo')
  }

  /**
   * Commits a verified engine geometry through the same durable revision transaction as a human
   * edit. Topology and element identity cannot change at this boundary; P3 uses it only after the
   * final frame has been matched to the approved run and current document.
   */
  async commitFinalGeometry(
    runId: string,
    geometry: Pick<MoleculeDocument, 'documentId' | 'atoms'>,
    expectedRevision: number
  ): Promise<MoleculeDocument> {
    if (this.mutationLock?.runId !== runId) {
      throw fail('APPROVAL_REQUIRED', 'Final geometry does not own the molecule mutation lock')
    }
    if (this.preview || this.draft) {
      throw fail('APPROVAL_REQUIRED', 'Apply or discard active molecule changes before final geometry')
    }
    if (geometry.documentId !== this.committed.documentId || expectedRevision !== this.revision) {
      throw fail('REVISION_CONFLICT', 'Final geometry targets a stale molecule revision')
    }
    if (geometry.atoms.length !== this.committed.atoms.size) {
      throw fail('SCHEMA_INVALID', 'Final geometry changed the molecule topology')
    }
    const candidate = cloneState(this.committed)
    const seen = new Set<string>()
    for (const atom of geometry.atoms) {
      const current = candidate.atoms.get(atom.id)
      if (!current || current.atomicNumber !== atom.atomicNumber || seen.has(atom.id)) {
        throw fail('SCHEMA_INVALID', 'Final geometry changed atom identity')
      }
      seen.add(atom.id)
      current.position = [atom.position[0], atom.position[1], atom.position[2]]
    }
    return this.withDurableMutation(async () => {
      const nextRevision = this.revision + 1
      await application.get('MoleculeProjectStore').commitDocument(toDocument(candidate, nextRevision))
      this.pushUndo()
      this.committed = candidate
      this.revision = nextRevision
      this.committedEmitter.fire({ documentId: this.committed.documentId, revision: this.revision })
      return this.getDocument()
    })
  }

  private async travel(direction: 'undo' | 'redo'): Promise<MoleculeDocument> {
    this.assertEditable()
    if (this.preview || this.draft) {
      throw fail('APPROVAL_REQUIRED', 'Apply or discard active molecule changes before history travel')
    }
    const source = direction === 'undo' ? this.undoStack : this.redoStack
    const target = direction === 'undo' ? this.redoStack : this.undoStack
    const restored = source.at(-1)
    // The helper returned the unchanged document rather than faulting at the end of history.
    if (!restored) return this.getDocument()

    return this.withDurableMutation(async () => {
      const nextRevision = this.revision + 1
      const nextState = this.snapshotWithoutSelection(restored)
      await application.get('MoleculeProjectStore').commitDocument(toDocument(nextState, nextRevision))

      source.pop()
      target.push(this.snapshotWithoutSelection(this.committed))
      this.committed = nextState
      this.revision = nextRevision
      this.committedEmitter.fire({ documentId: this.committed.documentId, revision: this.revision })
      return this.getDocument()
    })
  }

  private pushUndo(): void {
    this.undoStack.push(this.snapshotWithoutSelection(this.committed))
    if (this.undoStack.length > MAX_UNDO_DEPTH) this.undoStack.shift()
    // A fresh commit invalidates the redo branch.
    this.redoStack = []
  }

  private snapshotWithoutSelection(state: MoleculeState): MoleculeState {
    const snapshot = cloneState(state)
    snapshot.selected.clear()
    snapshot.selectionOrder = []
    return snapshot
  }

  private toDraftSnapshot(draft: DraftSlot): StudioDraftSnapshot {
    return {
      draftId: draft.draftId,
      documentId: this.committed.documentId,
      baseRevision: draft.baseRevision,
      document: toDocument(draft.history[draft.cursor], draft.baseRevision),
      entries: structuredClone(draft.entries),
      cursor: draft.cursor,
      dirty: draft.cursor > 0,
      canUndo: draft.cursor > 0,
      canRedo: draft.cursor < draft.entries.length,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      extensions: {}
    }
  }

  private async persistDraft(draft: DraftSlot): Promise<void> {
    const snapshot = this.toDraftSnapshot(draft)
    snapshot.document.selections = []
    const payload: DraftJournalPayload = {
      version: 1,
      snapshot,
      history: draft.history.map((state) => {
        const document = toDocument(state, draft.baseRevision)
        document.selections = []
        return document
      })
    }
    await application.get('MoleculeProjectStore').writeDraftJournal(payload)
  }

  async recoverDraft(): Promise<StudioDraftSnapshot | null> {
    const value = await application.get('MoleculeProjectStore').readDraftJournal()
    if (value === null) return null
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Molecule draft journal payload is malformed')
    }
    const record = value as Partial<DraftJournalPayload>
    if (
      record.version !== 1 ||
      !isDraftSnapshot(record.snapshot) ||
      !Array.isArray(record.history) ||
      record.history.some((document) => !isMoleculeDocument(document))
    ) {
      throw new Error('Molecule draft journal payload is schema-invalid')
    }
    const snapshot = record.snapshot
    const history = record.history
    // A crash after the committed transaction but before journal cleanup leaves a stale draft.
    // It can never be replayed onto the new revision, so recovery removes it idempotently.
    if (snapshot.baseRevision !== this.revision) {
      await application.get('MoleculeProjectStore').clearDraftJournal()
      logger.info('Removed a stale molecule draft journal after committed recovery', {
        documentId: snapshot.documentId,
        baseRevision: snapshot.baseRevision,
        committedRevision: this.revision
      })
      return null
    }
    if (
      snapshot.documentId !== this.committed.documentId ||
      snapshot.document.documentId !== this.committed.documentId ||
      history.length !== snapshot.entries.length + 1 ||
      snapshot.cursor > snapshot.entries.length ||
      snapshot.dirty !== snapshot.cursor > 0 ||
      snapshot.canUndo !== snapshot.cursor > 0 ||
      snapshot.canRedo !== snapshot.cursor < snapshot.entries.length ||
      history.some(
        (document) => document.documentId !== this.committed.documentId || document.revision !== snapshot.baseRevision
      )
    ) {
      throw new Error('Molecule draft journal identity is inconsistent')
    }
    const states = history.map(fromDocument)
    if (
      trustedMoleculeStateHash(states[0]) !== trustedMoleculeStateHash(this.committed) ||
      trustedMoleculeStateHash(states[snapshot.cursor]) !== trustedMoleculeStateHash(fromDocument(snapshot.document))
    ) {
      throw new Error('Molecule draft journal geometry is inconsistent')
    }
    snapshot.entries.forEach((entry, index) => {
      if (
        entry.beforeHash !== trustedMoleculeStateHash(states[index]) ||
        entry.afterHash !== trustedMoleculeStateHash(states[index + 1])
      ) {
        throw new Error('Molecule draft history hash is inconsistent')
      }
    })
    this.draft = {
      draftId: snapshot.draftId,
      baseRevision: snapshot.baseRevision,
      history: states,
      entries: structuredClone(snapshot.entries),
      cursor: snapshot.cursor,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt
    }
    logger.info('Recovered molecule draft', {
      documentId: snapshot.documentId,
      baseRevision: snapshot.baseRevision,
      entryCount: snapshot.entries.length,
      cursor: snapshot.cursor
    })
    return this.toDraftSnapshot(this.draft)
  }

  private async withDurableMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.durableMutationInFlight) {
      throw fail('APPROVAL_REQUIRED', 'A molecule project transaction is already in progress')
    }
    this.durableMutationInFlight = true
    try {
      return await operation()
    } finally {
      this.durableMutationInFlight = false
    }
  }
}
