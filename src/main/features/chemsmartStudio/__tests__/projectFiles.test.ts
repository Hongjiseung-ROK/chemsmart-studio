import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HistoricalProjectManifestV1, MoleculeDocument } from '@chemsmart/studio-protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeProjectPath, projectDisplayName, validateImportFile, validateProjectBundle } from '../projectFiles'

const roots: string[] = []

async function testRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chemsmart-project-files-'))
  roots.push(root)
  return root
}

async function createProject(
  root: string,
  name = 'Source.cmsproj',
  activeRunId: string | null = null
): Promise<string> {
  const project = path.join(root, name)
  await mkdir(path.join(project, 'receipts'), { recursive: true })
  const document = moleculeDocument()
  const manifest: HistoricalProjectManifestV1 = {
    schemaVersion: '1.0.0',
    protocolVersion: '1.0.0',
    documentId: document.documentId,
    currentRevision: document.revision,
    activeRunId,
    createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z',
    extensions: {}
  }
  await writeFile(path.join(project, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  await writeFile(path.join(project, 'molecule.json'), JSON.stringify(document), 'utf8')
  await writeFile(path.join(project, 'receipts', 'receipt.json'), '{"ok":true}', 'utf8')
  return project
}

function moleculeDocument(documentId = 'molecule-1', revision = 0): MoleculeDocument {
  return {
    documentId,
    revision,
    atoms: [{ id: 'atom-1', atomicNumber: 1, position: [0, 0, 0], formalCharge: 0, extensions: {} }],
    bonds: [],
    selections: [],
    frozenAxes: {},
    constraints: [],
    properties: { charge: 0, multiplicity: 1, extensions: {} },
    extensions: {}
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ChemSmart Studio project files', () => {
  it('normalizes and displays project names without exposing their parent path', () => {
    expect(normalizeProjectPath('/tmp/Example')).toBe('/tmp/Example.cmsproj')
    expect(normalizeProjectPath('/tmp/Example.cmsproj')).toBe('/tmp/Example.cmsproj')
    expect(projectDisplayName('/private/user/Example.cmsproj')).toBe('Example')
  })

  it('validates a canonical package and reports whether work is active', async () => {
    const root = await testRoot()
    const idle = await createProject(root)
    const active = await createProject(root, 'Active.cmsproj', 'run-1')

    await expect(validateProjectBundle(idle)).resolves.toMatchObject({
      projectPath: await realpath(idle),
      activeRunId: null
    })
    await expect(validateProjectBundle(active)).resolves.toMatchObject({
      projectPath: await realpath(active),
      activeRunId: 'run-1'
    })
  })

  it('rejects a package symlink and malformed active-run identity', async () => {
    const root = await testRoot()
    const source = await createProject(root)
    const linked = path.join(root, 'Linked.cmsproj')
    await symlink(source, linked)

    await expect(validateProjectBundle(linked)).rejects.toThrow('real directory')
    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ ...manifest, activeRunId: '../run' }), 'utf8')
    await expect(validateProjectBundle(source)).rejects.toThrow('does not match the protocol')
  })

  it('rejects manifest drift and molecule references that are only shape-valid', async () => {
    const root = await testRoot()
    const source = await createProject(root)
    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ ...manifest, currentRevision: 4 }), 'utf8')
    await expect(validateProjectBundle(source)).rejects.toThrow('different revisions')

    await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    const document = moleculeDocument()
    document.bonds = [{ id: 'bond-bad', atomIds: ['atom-1', 'atom-missing'], order: 1, extensions: {} }]
    await writeFile(path.join(source, 'molecule.json'), JSON.stringify(document), 'utf8')
    await expect(validateProjectBundle(source)).rejects.toThrow('invalid atom references')
  })

  it('accepts only bounded regular molecule imports supported by the native editor', async () => {
    const root = await testRoot()
    const xyz = path.join(root, 'ethanol.xyz')
    const unsupported = path.join(root, 'ethanol.pdb')
    await writeFile(xyz, '1\nfixture\nH 0 0 0\n', 'utf8')
    await writeFile(unsupported, 'ATOM\n', 'utf8')
    const linked = path.join(root, 'linked.xyz')
    await symlink(xyz, linked)

    await expect(validateImportFile(xyz)).resolves.toBe(await realpath(xyz))
    await expect(validateImportFile(unsupported)).rejects.toThrow('unsupported')
    await expect(validateImportFile(linked)).rejects.toThrow('regular file')
  })
})
