import { createHash } from 'node:crypto'

import type {
  AxisMask,
  Extensions,
  MoleculeConstraint,
  MoleculeDocument,
  MoleculeOperation
} from '@chemsmart/studio-protocol'

/**
 * The authoritative in-process molecule model. Stable IDs are primary keys rather than
 * renderer indexes, so atom removal cannot silently reassign identity. Insertion-ordered
 * `Map`s preserve the atom and bond ordering emitted in each document revision.
 */

export type Vector3 = readonly [number, number, number]
export type BondOrder = 1 | 2 | 3

export interface AtomRecord {
  atomicNumber: number
  position: Vector3
  formalCharge: number
  isotope?: number
  label?: string
  extensions: Extensions
}

export interface BondRecord {
  atomIds: readonly [string, string]
  order: BondOrder
  extensions: Extensions
}

export interface MoleculeState {
  documentId: string
  atoms: Map<string, AtomRecord>
  bonds: Map<string, BondRecord>
  selected: Set<string>
  /** Researcher pick order; the document emits selections in this order where it still applies. */
  selectionOrder: string[]
  frozenAxes: Map<string, AxisMask>
  constraints: MoleculeConstraint[]
  properties: MoleculeDocument['properties']
  extensions: Extensions
}

export interface OperationOutcome {
  affectedAtomIds: Set<string>
  affectedBondIds: Set<string>
}

/** Thrown for any operation the helper would have refused with `SCHEMA_INVALID`. */
export class MoleculeOperationError extends Error {}

function refuse(message: string): never {
  throw new MoleculeOperationError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mirrors the helper's `onlyKeys(obj, keys) && obj.size() == keys.size()` exact-shape check. */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const present = Object.keys(value)
  return present.length === keys.length && present.every((key) => keys.includes(key))
}

function isFiniteInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function isBondOrder(value: unknown): value is BondOrder {
  return value === 1 || value === 2 || value === 3
}

function readVector(value: unknown): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) refuse('A position must be three finite numbers')
  const vector = value.map((component) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      refuse('A position must be three finite numbers')
    }
    return component
  })
  return [vector[0], vector[1], vector[2]] as const
}

function readExtensions(value: unknown): Extensions {
  if (value === undefined) return {}
  if (!isPlainObject(value)) refuse('extensions must be an object')
  return { ...value } as Extensions
}

function readNonEmptyArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) refuse(message)
  return value
}

function readStableId(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse(message)
  return value
}

/**
 * Selection in researcher pick order, then any remaining selected atoms in document order.
 * Ported from `orderedSelectedAtomIds`.
 */
export function orderedSelectedAtomIds(state: MoleculeState): string[] {
  const ordered: string[] = []
  const included = new Set<string>()
  const append = (atomId: string): void => {
    if (included.has(atomId) || !state.atoms.has(atomId) || !state.selected.has(atomId)) return
    ordered.push(atomId)
    included.add(atomId)
  }
  for (const atomId of state.selectionOrder) append(atomId)
  for (const atomId of state.atoms.keys()) append(atomId)
  return ordered
}

/**
 * Deterministic JSON with object keys sorted, matching the ordering `QJsonObject` gave the
 * helper's digests. Hashes are session-internal identity, never compared across a process
 * boundary, so byte parity with the Qt encoder is not required — only stability.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function sha256(payload: string): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

/** Ported from `geometryHash` — atom identity and coordinates only, sorted by stable id. */
export function geometryHash(state: MoleculeState): string {
  const rows = [...state.atoms.keys()]
    .sort()
    .map((atomId) => {
      const atom = state.atoms.get(atomId)
      if (!atom) return null
      return [atomId, atom.atomicNumber, atom.position]
    })
    .filter((row) => row !== null)
  return sha256(canonicalJson(rows))
}

/** Ported from `trustedMoleculeStateHash` — the full committed meaning of the document. */
export function trustedMoleculeStateHash(state: MoleculeState): string {
  const atoms = [...state.atoms.keys()].sort().map((atomId) => {
    const atom = state.atoms.get(atomId)
    if (!atom) return null
    return [
      atomId,
      atom.atomicNumber,
      atom.position,
      atom.formalCharge,
      atom.isotope ?? 0,
      atom.label ?? '',
      atom.extensions
    ]
  })
  const bonds = [...state.bonds.keys()].sort().map((bondId) => {
    const bond = state.bonds.get(bondId)
    if (!bond) return null
    // The helper ordered the endpoints so an equivalent bond hashes identically either way round.
    const [first, second] = [...bond.atomIds].sort()
    return [bondId, first, second, bond.order, bond.extensions]
  })
  const frozenAxes = [...state.frozenAxes.keys()].sort().map((atomId) => [atomId, state.frozenAxes.get(atomId)])
  const constraints = [...state.constraints].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )
  return sha256(
    canonicalJson({
      atoms: atoms.filter((row) => row !== null),
      bonds: bonds.filter((row) => row !== null),
      selections: orderedSelectedAtomIds(state),
      frozenAxes,
      constraints,
      properties: state.properties,
      extensions: state.extensions
    })
  )
}

export function cloneState(state: MoleculeState): MoleculeState {
  return {
    documentId: state.documentId,
    atoms: new Map([...state.atoms].map(([id, atom]) => [id, { ...atom, position: [...atom.position] as Vector3 }])),
    bonds: new Map(
      [...state.bonds].map(([id, bond]) => [id, { ...bond, atomIds: [...bond.atomIds] as [string, string] }])
    ),
    selected: new Set(state.selected),
    selectionOrder: [...state.selectionOrder],
    frozenAxes: new Map([...state.frozenAxes].map(([id, axes]) => [id, [...axes] as AxisMask])),
    constraints: state.constraints.map((constraint) => ({ ...constraint, atomIds: [...constraint.atomIds] })),
    properties: { ...state.properties, extensions: { ...state.properties.extensions } },
    extensions: { ...state.extensions }
  }
}

export function toDocument(state: MoleculeState, revision: number): MoleculeDocument {
  return {
    documentId: state.documentId,
    revision,
    atoms: [...state.atoms].map(([id, atom]) => ({
      id,
      atomicNumber: atom.atomicNumber,
      position: [...atom.position],
      formalCharge: atom.formalCharge,
      ...(atom.isotope === undefined ? {} : { isotope: atom.isotope }),
      ...(atom.label === undefined ? {} : { label: atom.label }),
      extensions: atom.extensions
    })),
    bonds: [...state.bonds].map(([id, bond]) => ({
      id,
      atomIds: [...bond.atomIds],
      order: bond.order,
      extensions: bond.extensions
    })),
    selections: orderedSelectedAtomIds(state),
    frozenAxes: Object.fromEntries([...state.frozenAxes].map(([id, axes]) => [id, [...axes]])),
    constraints: state.constraints.map((constraint) => ({ ...constraint, atomIds: [...constraint.atomIds] })),
    properties: state.properties,
    extensions: state.extensions
  } as MoleculeDocument
}

export function fromDocument(document: MoleculeDocument): MoleculeState {
  const state: MoleculeState = {
    documentId: document.documentId,
    atoms: new Map(),
    bonds: new Map(),
    selected: new Set(document.selections),
    selectionOrder: [...document.selections],
    frozenAxes: new Map(),
    constraints: document.constraints.map((constraint) => ({ ...constraint })),
    properties: document.properties,
    extensions: document.extensions ?? {}
  }
  for (const atom of document.atoms) {
    state.atoms.set(atom.id, {
      atomicNumber: atom.atomicNumber,
      position: [atom.position[0], atom.position[1], atom.position[2]],
      formalCharge: atom.formalCharge,
      ...(atom.isotope === undefined ? {} : { isotope: atom.isotope }),
      ...(atom.label === undefined ? {} : { label: atom.label }),
      extensions: atom.extensions ?? {}
    })
  }
  for (const bond of document.bonds) {
    state.bonds.set(bond.id, {
      atomIds: [bond.atomIds[0], bond.atomIds[1]],
      order: bond.order,
      extensions: bond.extensions ?? {}
    })
  }
  for (const [atomId, axes] of Object.entries(document.frozenAxes ?? {})) {
    state.frozenAxes.set(atomId, [Boolean(axes[0]), Boolean(axes[1]), Boolean(axes[2])])
  }
  return state
}

/** Ported from `validConstraint`. */
function readConstraint(value: unknown, state: MoleculeState): MoleculeConstraint {
  if (!hasExactKeys(value, ['id', 'type', 'atomIds', 'target', 'unit', 'extensions'])) {
    refuse('Invalid constraint definition')
  }
  const id = readStableId(value.id, 'Invalid constraint definition')
  const type = value.type
  const expectedAtoms = type === 'distance' ? 2 : type === 'angle' ? 3 : type === 'dihedral' ? 4 : 0
  const unitValid = type === 'distance' ? value.unit === 'angstrom' : value.unit === 'degree'
  const target = value.target
  if (expectedAtoms === 0 || !unitValid || typeof target !== 'number' || !Number.isFinite(target)) {
    refuse('Invalid constraint definition')
  }
  if (type === 'distance' && target <= 0) refuse('Invalid constraint definition')
  if (type === 'angle' && (target <= 0 || target > 180)) refuse('Invalid constraint definition')
  if (type === 'dihedral' && (target < -360 || target > 360)) refuse('Invalid constraint definition')
  if (!Array.isArray(value.atomIds) || value.atomIds.length !== expectedAtoms) refuse('Invalid constraint definition')
  const seen = new Set<string>()
  for (const atomId of value.atomIds) {
    if (typeof atomId !== 'string' || !state.atoms.has(atomId) || seen.has(atomId)) {
      refuse('Invalid constraint definition')
    }
    seen.add(atomId)
  }
  return {
    id,
    type,
    atomIds: [...value.atomIds],
    target,
    unit: value.unit,
    extensions: readExtensions(value.extensions)
  } as MoleculeConstraint
}

/** Removes every bond incident to `atomId`, recording each as affected. */
function removeIncidentBonds(state: MoleculeState, atomId: string, affectedBondIds: Set<string>): void {
  for (const [bondId, bond] of state.bonds) {
    if (bond.atomIds[0] === atomId || bond.atomIds[1] === atomId) {
      state.bonds.delete(bondId)
      affectedBondIds.add(bondId)
    }
  }
}

/**
 * Applies a patch's operations to `state` in place. Throws `MoleculeOperationError` on the
 * first refusal, so callers must apply to a clone and discard it on failure — the helper
 * had the same all-or-nothing contract.
 */
export function applyOperations(state: MoleculeState, operations: readonly MoleculeOperation[]): OperationOutcome {
  const affectedAtomIds = new Set<string>()
  const affectedBondIds = new Set<string>()

  for (const rawOperation of operations) {
    const operation = rawOperation as unknown as Record<string, unknown>
    switch (operation.op) {
      case 'add_atoms': {
        for (const value of readNonEmptyArray(operation.atoms, 'Invalid add_atoms operation')) {
          if (!isPlainObject(value)) refuse('Invalid add_atoms operation')
          const atomId = readStableId(value.id, 'Invalid add_atoms operation')
          if (state.atoms.has(atomId)) refuse('Invalid add_atoms operation')
          if (!isFiniteInteger(value.atomicNumber, 1, 118)) refuse('Invalid add_atoms operation')
          const position = readVector(value.position)
          const formalCharge = value.formalCharge === undefined ? 0 : value.formalCharge
          if (!isFiniteInteger(formalCharge, -128, 127)) refuse('Invalid add_atoms operation')
          state.atoms.set(atomId, {
            atomicNumber: value.atomicNumber,
            position,
            formalCharge,
            ...(isFiniteInteger(value.isotope, 0, 65535) ? { isotope: value.isotope } : {}),
            ...(typeof value.label === 'string' ? { label: value.label } : {}),
            extensions: readExtensions(value.extensions)
          })
          affectedAtomIds.add(atomId)
        }
        break
      }

      case 'remove_atoms': {
        for (const value of readNonEmptyArray(operation.atomIds, 'Invalid remove_atoms operation')) {
          const atomId = readStableId(value, 'remove_atoms references an unknown atom')
          if (!state.atoms.has(atomId)) refuse('remove_atoms references an unknown atom')
          // The helper cascaded a removal through bonds, frozen axes and constraints so no
          // side table could outlive the atom it referenced.
          removeIncidentBonds(state, atomId, affectedBondIds)
          state.atoms.delete(atomId)
          state.selected.delete(atomId)
          state.frozenAxes.delete(atomId)
          state.constraints = state.constraints.filter((constraint) => !constraint.atomIds.includes(atomId))
          affectedAtomIds.add(atomId)
        }
        break
      }

      case 'add_bonds': {
        for (const value of readNonEmptyArray(operation.bonds, 'Invalid add_bonds operation')) {
          if (!isPlainObject(value)) refuse('Invalid add_bonds operation')
          const bondId = readStableId(value.id, 'Invalid add_bonds operation')
          if (state.bonds.has(bondId)) refuse('Invalid add_bonds operation')
          if (!Array.isArray(value.atomIds) || value.atomIds.length !== 2) refuse('Invalid add_bonds operation')
          const [first, second] = value.atomIds
          if (typeof first !== 'string' || typeof second !== 'string') {
            refuse('add_bonds references an unknown atom')
          }
          if (!state.atoms.has(first) || !state.atoms.has(second) || first === second) {
            refuse('add_bonds references an unknown atom')
          }
          if (!isBondOrder(value.order)) refuse('add_bonds references an unknown atom')
          state.bonds.set(bondId, {
            atomIds: [first, second],
            order: value.order,
            extensions: readExtensions(value.extensions)
          })
          affectedBondIds.add(bondId)
        }
        break
      }

      case 'remove_bonds': {
        for (const value of readNonEmptyArray(operation.bondIds, 'Invalid remove_bonds operation')) {
          const bondId = readStableId(value, 'remove_bonds references an unknown bond')
          if (!state.bonds.has(bondId)) refuse('remove_bonds references an unknown bond')
          state.bonds.delete(bondId)
          affectedBondIds.add(bondId)
        }
        break
      }

      case 'set_positions': {
        for (const value of readNonEmptyArray(operation.positions, 'Invalid set_positions operation')) {
          if (!isPlainObject(value)) refuse('Invalid set_positions operation')
          const atomId = readStableId(value.atomId, 'Invalid set_positions operation')
          const atom = state.atoms.get(atomId)
          if (!atom) refuse('Invalid set_positions operation')
          atom.position = readVector(value.position)
          affectedAtomIds.add(atomId)
        }
        break
      }

      case 'set_atomic_numbers': {
        // Exact-shape operation in the helper: no extra keys, no duplicate atom ids.
        if (!hasExactKeys(operation, ['op', 'atoms'])) refuse('Invalid set_atomic_numbers operation')
        const changed = new Set<string>()
        for (const value of readNonEmptyArray(operation.atoms, 'Invalid set_atomic_numbers operation')) {
          if (!hasExactKeys(value, ['atomId', 'atomicNumber'])) refuse('Invalid set_atomic_numbers operation')
          const atomId = readStableId(value.atomId, 'Invalid set_atomic_numbers operation')
          const atom = state.atoms.get(atomId)
          if (!atom || changed.has(atomId) || !isFiniteInteger(value.atomicNumber, 1, 118)) {
            refuse('Invalid set_atomic_numbers operation')
          }
          atom.atomicNumber = value.atomicNumber
          changed.add(atomId)
          affectedAtomIds.add(atomId)
        }
        break
      }

      case 'set_bond_orders': {
        if (!hasExactKeys(operation, ['op', 'bonds'])) refuse('Invalid set_bond_orders operation')
        const changed = new Set<string>()
        for (const value of readNonEmptyArray(operation.bonds, 'Invalid set_bond_orders operation')) {
          if (!hasExactKeys(value, ['bondId', 'order'])) refuse('Invalid set_bond_orders operation')
          const bondId = readStableId(value.bondId, 'Invalid set_bond_orders operation')
          const bond = state.bonds.get(bondId)
          if (!bond || changed.has(bondId) || !isBondOrder(value.order)) {
            refuse('Invalid set_bond_orders operation')
          }
          bond.order = value.order
          changed.add(bondId)
          affectedBondIds.add(bondId)
        }
        break
      }

      case 'set_selection': {
        if (!Array.isArray(operation.atomIds)) refuse('Invalid set_selection operation')
        // Deselecting counts as affecting the atom, so a cleared selection still reports.
        for (const atomId of state.selected) affectedAtomIds.add(atomId)
        state.selected.clear()
        for (const value of operation.atomIds) {
          const atomId = readStableId(value, 'set_selection references an unknown atom')
          if (!state.atoms.has(atomId)) refuse('set_selection references an unknown atom')
          state.selected.add(atomId)
          affectedAtomIds.add(atomId)
        }
        state.selectionOrder = operation.atomIds.map((atomId) => String(atomId))
        break
      }

      case 'set_frozen_axes': {
        if (!hasExactKeys(operation, ['op', 'masks'])) refuse('Invalid set_frozen_axes operation')
        for (const value of readNonEmptyArray(operation.masks, 'Invalid set_frozen_axes operation')) {
          if (!hasExactKeys(value, ['atomId', 'axes'])) refuse('Invalid set_frozen_axes operation')
          const atomId = readStableId(value.atomId, 'Invalid set_frozen_axes operation')
          const axes = value.axes
          if (!state.atoms.has(atomId) || !Array.isArray(axes) || axes.length !== 3) {
            refuse('Invalid set_frozen_axes operation')
          }
          if (!axes.every((axis) => typeof axis === 'boolean')) refuse('Invalid set_frozen_axes operation')
          state.frozenAxes.set(atomId, [axes[0], axes[1], axes[2]])
          affectedAtomIds.add(atomId)
        }
        break
      }

      case 'set_constraints': {
        if (!hasExactKeys(operation, ['op', 'constraints'])) refuse('Invalid constraint definition')
        for (const value of readNonEmptyArray(operation.constraints, 'Invalid constraint definition')) {
          const constraint = readConstraint(value, state)
          for (const atomId of constraint.atomIds) affectedAtomIds.add(atomId)
          // Replace by id so re-setting a constraint never accumulates duplicates.
          state.constraints = state.constraints.filter((existing) => existing.id !== constraint.id)
          state.constraints.push(constraint)
        }
        break
      }

      case 'remove_constraints': {
        // The helper was deliberately tolerant here: removing an absent id is not an error.
        if (!Array.isArray(operation.constraintIds)) refuse('Invalid remove_constraints operation')
        const removing = new Set(operation.constraintIds.map((id) => String(id)))
        state.constraints = state.constraints.filter((constraint) => !removing.has(constraint.id))
        break
      }

      default:
        refuse(`Unsupported patch operation: ${String(operation.op)}`)
    }
  }

  return { affectedAtomIds, affectedBondIds }
}
