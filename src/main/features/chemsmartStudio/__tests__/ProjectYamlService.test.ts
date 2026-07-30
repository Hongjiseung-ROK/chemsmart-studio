import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ProjectWorkspaceDocumentResult } from '@chemsmart/studio-protocol'
import { BaseService } from '@main/core/lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appGet: vi.fn(),
  appGetPath: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: mocks.appGet,
    getPath: mocks.appGetPath
  }
}))

import { ProjectYamlService } from '../ProjectYamlService'

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

describe('ProjectYamlService', () => {
  let root: string
  let revision: number
  let activeProjectPath: string
  let service: ProjectYamlService

  const yamlText = 'gas:\n  functional: b3lyp\n  basis: def2svp\n'
  const document = (): ProjectWorkspaceDocumentResult => ({
    schemaVersion: '2',
    projectName: 'water',
    program: 'gaussian',
    digest: digest(yamlText),
    yamlText,
    sections: [],
    validation: {
      verdict: 'ok',
      issues: [],
      message: 'Project YAML passed validation.',
      extensions: {}
    },
    unknownNodes: [],
    extensions: {}
  })
  const register = () =>
    service.registerCandidate('thread-1', {
      document: document(),
      unsupportedFeatures: [],
      extensions: {}
    })

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chemsmart-project-yaml-'))
    revision = 2
    activeProjectPath = path.join(root, 'Water.cmsproj')
    mocks.appGetPath.mockImplementation((key: string) => {
      if (key === 'feature.chemsmart_studio.workspace') return root
      throw new Error(`Unexpected application.getPath(${key})`)
    })
    mocks.appGet.mockImplementation((name: string) => {
      if (name === 'MoleculeDocumentService') {
        return {
          getDocument: () => ({
            documentId: 'molecule-water',
            revision
          })
        }
      }
      if (name === 'MoleculeWorkspaceService') {
        return { getActiveProjectPath: () => activeProjectPath }
      }
      throw new Error(`Unexpected application.get(${name})`)
    })
    BaseService.resetInstances()
    service = new ProjectYamlService()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a candidate path-free and denial performs no write', async () => {
    const candidate = await register()

    expect(JSON.stringify(candidate)).not.toContain(root)
    const result = await service.decideCandidate('thread-1', {
      previewId: candidate.previewId,
      baseDigest: candidate.baseDigest,
      candidateDigest: candidate.candidateDigest,
      expectedRevision: candidate.expectedRevision,
      decision: 'deny'
    })

    expect(result.status).toBe('denied')
    await expect(readFile(path.join(root, '.chemsmart', 'gaussian', 'water.yaml'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(stat(path.join(root, '.chemsmart'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes exactly once with a private mode after an exact allow decision', async () => {
    const candidate = await register()
    const result = await service.decideCandidate('thread-1', {
      previewId: candidate.previewId,
      baseDigest: candidate.baseDigest,
      candidateDigest: candidate.candidateDigest,
      expectedRevision: candidate.expectedRevision,
      decision: 'allow_once'
    })
    const target = path.join(root, '.chemsmart', 'gaussian', 'water.yaml')

    expect(result.status).toBe('written')
    expect(await readFile(target, 'utf8')).toBe(yamlText)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    await expect(
      service.decideCandidate('thread-1', {
        previewId: candidate.previewId,
        baseDigest: candidate.baseDigest,
        candidateDigest: candidate.candidateDigest,
        expectedRevision: candidate.expectedRevision,
        decision: 'allow_once'
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('fails stale when the base YAML or molecule revision changes', async () => {
    const target = path.join(root, '.chemsmart', 'gaussian', 'water.yaml')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'gas:\n  functional: pbe0\n', { mode: 0o600 })
    const candidate = await register()
    await writeFile(target, 'gas:\n  functional: m062x\n', { mode: 0o600 })
    revision += 1

    const result = await service.decideCandidate('thread-1', {
      previewId: candidate.previewId,
      baseDigest: candidate.baseDigest,
      candidateDigest: candidate.candidateDigest,
      expectedRevision: candidate.expectedRevision,
      decision: 'allow_once'
    })

    expect(result.status).toBe('stale')
    expect(await readFile(target, 'utf8')).toContain('m062x')
  })
})
