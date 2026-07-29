import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { MoleculeDocument, ProjectManifest } from '@chemsmart/studio-protocol'
import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock('@application', () => ({ application: { getPath } }))

import { moleculeGeometryHash } from '../ControlledCalculationIdentity'
import { MoleculeProjectStore } from '../MoleculeProjectStore'

const roots: string[] = []

function document(revision = 0, selections: string[] = []): MoleculeDocument {
  return {
    documentId: 'document-water',
    revision,
    atoms: [
      { id: 'atom-o', atomicNumber: 8, position: [0, 0, 0], formalCharge: 0, extensions: {} },
      { id: 'atom-h', atomicNumber: 1, position: [0.96, 0, 0], formalCharge: 0, extensions: {} }
    ],
    bonds: [{ id: 'bond-oh', atomIds: ['atom-o', 'atom-h'], order: 1, extensions: {} }],
    selections,
    frozenAxes: {},
    constraints: [],
    properties: { name: 'water fragment', charge: 0, multiplicity: 1, extensions: {} },
    extensions: {}
  }
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chemsmart-project-store-'))
  roots.push(directory)
  return directory
}

describe('MoleculeProjectStore', () => {
  beforeEach(() => {
    BaseService.resetInstances()
    getPath.mockReset()
  })

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('creates and validates a complete private project without persisting selection', async () => {
    const directory = await root()
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document(0, ['atom-o']))

    expect(project.projectPath).toBe(await realpath(path.join(directory, 'Water.cmsproj')))
    expect(project.document).toEqual(document())
    expect(project.manifest).toMatchObject({
      schemaVersion: '1.0.0',
      protocolVersion: '1.0.0',
      documentId: 'document-water',
      currentRevision: 0,
      activeRunId: null
    })
    expect((await stat(path.join(project.projectPath, 'manifest.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(project.projectPath, 'molecule.json'))).mode & 0o777).toBe(0o600)
  })

  it('publishes a new revision only after both canonical files are durable', async () => {
    const directory = await root()
    getPath.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.active_project_file') {
        return path.join(directory, 'active-project.json')
      }
      throw new Error(`Unexpected path key: ${key}`)
    })
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document())
    await store.activateProject(project)

    const next = document(1)
    next.atoms[1] = { ...next.atoms[1], position: [1.2, 0, 0] }
    const committed = await store.commitDocument(next)

    expect(committed.document).toEqual(next)
    expect(committed.manifest.currentRevision).toBe(1)
    await expect(access(path.join(project.projectPath, '.chemsmart-molecule-transaction.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('materializes the visible molecule as one private parser input and retires stale inputs', async () => {
    const directory = await root()
    getPath.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.active_project_file') {
        return path.join(directory, 'active-project.json')
      }
      throw new Error(`Unexpected path key: ${key}`)
    })
    const store = new MoleculeProjectStore()
    const initial = document()
    const project = await store.createProject(path.join(directory, 'Water'), initial)
    await store.activateProject(project)

    const first = await store.materializeCommandInput(initial, moleculeGeometryHash(initial))
    const firstPath = path.join(project.projectPath, first.basename)

    expect(await readFile(firstPath, 'utf8')).toBe(
      ['2', 'ChemSmart Studio generated molecule input', 'O 0 0 0', 'H 0.96 0 0', ''].join('\n')
    )
    expect((await stat(firstPath)).mode & 0o777).toBe(0o600)
    expect(first.sha256).toBe(hash(Buffer.from(await readFile(firstPath))))

    const moved = document()
    moved.atoms[1] = { ...moved.atoms[1], position: [1.2, 0, 0] }
    const second = await store.materializeCommandInput(moved, moleculeGeometryHash(moved))

    expect(second.basename).not.toBe(first.basename)
    await expect(access(firstPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(project.projectPath, second.basename), 'utf8')).resolves.toContain('H 1.2 0 0')
  })

  it('writes, verifies, and clears a private draft recovery journal', async () => {
    const directory = await root()
    getPath.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.active_project_file') {
        return path.join(directory, 'active-project.json')
      }
      throw new Error(`Unexpected path key: ${key}`)
    })
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document())
    await store.activateProject(project)
    const payload = { version: 1, draftId: 'draft-1', entries: [{ operation: 'move' }] }

    await store.writeDraftJournal(payload)

    expect(await store.readDraftJournal()).toEqual(payload)
    expect((await stat(path.join(project.projectPath, '.chemsmart-molecule-draft.json'))).mode & 0o777).toBe(0o600)
    await store.clearDraftJournal()
    await expect(store.readDraftJournal()).resolves.toBeNull()
  })

  it('fails closed when a draft journal payload no longer matches its hash', async () => {
    const directory = await root()
    getPath.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.active_project_file') {
        return path.join(directory, 'active-project.json')
      }
      throw new Error(`Unexpected path key: ${key}`)
    })
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document())
    await store.activateProject(project)
    await writeFile(
      path.join(project.projectPath, '.chemsmart-molecule-draft.json'),
      bytes({ version: 1, payload: { draftId: 'tampered' }, sha256: 'a'.repeat(64) }),
      { mode: 0o600 }
    )

    await expect(store.readDraftJournal()).rejects.toThrow('hash does not match')
  })

  it('restores the last active validated project from a private atomic marker', async () => {
    const directory = await root()
    const markerPath = path.join(directory, 'active-project.json')
    getPath.mockImplementation((key: string, fileName?: string) => {
      if (key === 'feature.chemsmart_studio.active_project_file') return markerPath
      if (key === 'feature.chemsmart_studio.projects') {
        return path.join(directory, fileName ?? '')
      }
      throw new Error(`Unexpected path key: ${key}`)
    })
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document(3))

    await store.activateProject(project)

    expect((await stat(markerPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual({
      version: 1,
      projectPath: project.projectPath
    })

    BaseService.resetInstances()
    const restored = new MoleculeProjectStore()
    await (
      restored as unknown as {
        onInit(): Promise<void>
      }
    ).onInit()

    expect(restored.getActiveProjectPath()).toBe(project.projectPath)
  })

  it('save-as copies the complete validated bundle and rejects symbolic links', async () => {
    const directory = await root()
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document())
    await mkdir(path.join(project.projectPath, 'receipts'))
    await writeFile(path.join(project.projectPath, 'receipts', 'receipt.json'), '{"passed":true}', 'utf8')

    const copied = await store.copyProject(project.projectPath, path.join(directory, 'Water Copy'))

    await expect(readFile(path.join(copied.projectPath, 'receipts', 'receipt.json'), 'utf8')).resolves.toBe(
      '{"passed":true}'
    )
    await symlink(
      path.join(project.projectPath, 'molecule.json'),
      path.join(project.projectPath, 'linked-molecule.json')
    )
    await expect(store.copyProject(project.projectPath, path.join(directory, 'Rejected Copy'))).rejects.toThrow(
      'symbolic links are not allowed'
    )
    await expect(access(path.join(directory, 'Rejected Copy.cmsproj'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls a hash-valid interrupted transaction forward before validating the bundle', async () => {
    const directory = await root()
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document())
    const nextDocument = document(1)
    const oldManifest = JSON.parse(await readFile(path.join(project.projectPath, 'manifest.json'), 'utf8'))
    const nextManifest: ProjectManifest = { ...oldManifest, currentRevision: 1, updatedAt: '2026-07-28T12:00:00Z' }
    const moleculeBytes = bytes(nextDocument)
    const manifestBytes = bytes(nextManifest)
    const moleculeTemporary = '.chemsmart-molecule-recovery.tmp'
    const manifestTemporary = '.chemsmart-manifest-recovery.tmp'
    await writeFile(path.join(project.projectPath, moleculeTemporary), moleculeBytes, { mode: 0o600 })
    await writeFile(path.join(project.projectPath, manifestTemporary), manifestBytes, { mode: 0o600 })
    await writeFile(
      path.join(project.projectPath, '.chemsmart-molecule-transaction.json'),
      bytes({
        version: 1,
        transactionId: 'recovery-test',
        createdAt: '2026-07-28T12:00:00Z',
        files: [
          { target: 'molecule.json', temporary: moleculeTemporary, sha256: hash(moleculeBytes) },
          { target: 'manifest.json', temporary: manifestTemporary, sha256: hash(manifestBytes) }
        ]
      }),
      { mode: 0o600 }
    )

    const recovered = await store.inspectProject(project.projectPath)

    expect(recovered.document.revision).toBe(1)
    expect(recovered.manifest.currentRevision).toBe(1)
    await expect(access(path.join(project.projectPath, '.chemsmart-molecule-transaction.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('fails closed without changing canonical files when journal content does not match its hash', async () => {
    const directory = await root()
    const store = new MoleculeProjectStore()
    const project = await store.createProject(path.join(directory, 'Water'), document())
    const before = await readFile(path.join(project.projectPath, 'molecule.json'), 'utf8')
    await writeFile(path.join(project.projectPath, '.chemsmart-molecule-bad.tmp'), 'tampered', { mode: 0o600 })
    await writeFile(path.join(project.projectPath, '.chemsmart-manifest-bad.tmp'), 'tampered', { mode: 0o600 })
    await writeFile(
      path.join(project.projectPath, '.chemsmart-molecule-transaction.json'),
      bytes({
        version: 1,
        transactionId: 'bad-test',
        createdAt: '2026-07-28T12:00:00Z',
        files: [
          { target: 'molecule.json', temporary: '.chemsmart-molecule-bad.tmp', sha256: 'a'.repeat(64) },
          { target: 'manifest.json', temporary: '.chemsmart-manifest-bad.tmp', sha256: 'b'.repeat(64) }
        ]
      }),
      { mode: 0o600 }
    )

    await expect(store.inspectProject(project.projectPath)).rejects.toThrow('hash mismatch')
    await expect(readFile(path.join(project.projectPath, 'molecule.json'), 'utf8')).resolves.toBe(before)
    await expect(
      access(path.join(project.projectPath, '.chemsmart-molecule-transaction.json'))
    ).resolves.toBeUndefined()
  })
})
