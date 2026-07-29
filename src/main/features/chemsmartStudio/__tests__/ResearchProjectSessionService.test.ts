import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { BaseService } from '@main/core/lifecycle/BaseService'
import { getDependencies, getPhase } from '@main/core/lifecycle/decorators'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock, getPathMock } = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  getPathMock: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: appGetMock, getPath: getPathMock } }))

import { ResearchProjectSessionService } from '../ResearchProjectSessionService'

describe('ResearchProjectSessionService', () => {
  let root: string
  let projectPath: string
  let agentSessionsRoot: string
  let service: ResearchProjectSessionService

  const indexPath = (): string => path.join(projectPath, 'agent', 'threads.json')
  const readIndex = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(indexPath(), 'utf8')) as Record<string, unknown>

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chemsmart-research-session-'))
    projectPath = path.join(root, 'Water dimer.cmsproj')
    agentSessionsRoot = path.join(root, 'AgentSessions')
    await mkdir(projectPath, { recursive: true })
    await mkdir(agentSessionsRoot, { recursive: true })
    getPathMock.mockImplementation((key: string) =>
      key === 'feature.chemsmart_studio.agent_sessions' ? agentSessionsRoot : root
    )
    appGetMock.mockImplementation((name: string) => {
      if (name === 'MoleculeWorkspaceService') return { getActiveProjectPath: () => projectPath }
      throw new Error(`unexpected service ${name}`)
    })
    BaseService.resetInstances()
    service = new ResearchProjectSessionService()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  /** A restart: the same project read by a service that holds no in-memory state. */
  function freshService(): ResearchProjectSessionService {
    BaseService.resetInstances()
    return new ResearchProjectSessionService()
  }

  async function seedLegacySession(): Promise<void> {
    const legacy = path.join(agentSessionsRoot, 'workspace-main')
    await mkdir(legacy, { recursive: true })
    await writeFile(
      path.join(legacy, 'agent-session.json'),
      JSON.stringify({ agentSessionId: '20260727T000000Z-abcdef01', schemaVersion: 1 })
    )
  }

  it('registers as a WhenReady service that depends on the molecule editor', () => {
    expect(getPhase(ResearchProjectSessionService)).toBe('whenReady')
    expect(getDependencies(ResearchProjectSessionService)).toContain('MoleculeWorkspaceService')
  })

  it('seeds one thread inside the project package without touching the manifest', async () => {
    const context = await service.getContext()

    expect(context.threads).toHaveLength(1)
    expect(context.activeThreadId).toBe(context.threads[0].threadId)
    expect(context.threads[0]).toMatchObject({ activityCount: 0, agentBound: false, imported: false })
    expect(context.projectName).toBe('Water dimer')
    expect(await readIndex()).toMatchObject({ schemaVersion: 1 })
    // manifest.json and molecule.json stay absent: this slice adds only a sidecar.
    await expect(readFile(path.join(projectPath, 'manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never exposes the project path or any fragment a renderer could rejoin', async () => {
    const context = await service.getContext()

    const serialized = JSON.stringify(context)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain(projectPath)
    expect(serialized).not.toContain('.cmsproj')
    expect(context.projectId).toMatch(/^project-[0-9a-f]{32}$/)
  })

  it('gives the same project the same opaque id across service instances', async () => {
    const first = await service.getContext()
    const second = await freshService().getContext()

    expect(second.projectId).toBe(first.projectId)
    expect(second.threads.map((thread) => thread.threadId)).toEqual(first.threads.map((thread) => thread.threadId))
  })

  it('imports the legacy workspace-main session once and leaves the original in place', async () => {
    await seedLegacySession()

    const context = await service.getContext()

    expect(context.threads).toHaveLength(1)
    expect(context.threads[0]).toMatchObject({
      title: 'Imported legacy conversation',
      agentBound: true,
      imported: true
    })
    // The legacy directory is a record of what happened and is never rewritten.
    const legacy = await readFile(path.join(agentSessionsRoot, 'workspace-main', 'agent-session.json'), 'utf8')
    expect(JSON.parse(legacy)).toEqual({ agentSessionId: '20260727T000000Z-abcdef01', schemaVersion: 1 })
  })

  it('creates, renames, and selects named threads durably', async () => {
    const seeded = await service.getContext()
    const created = await service.createThread('Transition-state search')

    expect(created.threads).toHaveLength(2)
    expect(created.activeThreadId).toBe(created.threads[1].threadId)
    const createdId = created.threads[1].threadId

    const renamed = await service.renameThread(createdId, 'TS search, def2-SVP')
    expect(renamed.threads[1].title).toBe('TS search, def2-SVP')
    expect(renamed.threads[1].updatedAt >= renamed.threads[1].createdAt).toBe(true)

    const selected = await service.selectThread(seeded.threads[0].threadId)
    expect(selected.activeThreadId).toBe(seeded.threads[0].threadId)

    // Durability: a fresh instance reads the same set and the same active thread.
    const reloaded = await freshService().getContext()
    expect(reloaded.activeThreadId).toBe(seeded.threads[0].threadId)
    expect(reloaded.threads.map((thread) => thread.title)).toEqual(['Research thread 1', 'TS search, def2-SVP'])
  })

  it('records only durable thread metadata and enforces private file modes', async () => {
    const context = await service.getContext()
    const threadId = context.threads[0].threadId

    await service.recordActivity(threadId)

    const reloaded = await freshService().getContext()
    expect(reloaded.threads[0]).toMatchObject({ activityCount: 1, agentBound: true })
    expect((await stat(path.dirname(indexPath()))).mode & 0o777).toBe(0o700)
    expect((await stat(indexPath())).mode & 0o777).toBe(0o600)
    const stored = await readFile(indexPath(), 'utf8')
    expect(stored).not.toContain('message')
    expect(stored).not.toContain('provider')
  })

  it('refuses a blank, oversized, or control-character title', async () => {
    await expect(service.createThread('   ')).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(service.createThread('x'.repeat(121))).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(service.createThread('line\nbreak')).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('refuses to rename or select a thread that is not in this project', async () => {
    await service.getContext()

    await expect(service.renameThread('thread-missing', 'Anything')).rejects.toMatchObject({
      code: 'SCHEMA_INVALID'
    })
    await expect(service.selectThread('thread-missing')).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('fails closed on a corrupt index instead of reseeding over the researcher threads', async () => {
    await service.getContext()
    await writeFile(indexPath(), '{ "schemaVersion": 1, "threads": "not-a-list" }')

    await expect(service.getContext()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    // The bad bytes are still there for inspection rather than replaced by an empty set.
    expect(await readFile(indexPath(), 'utf8')).toContain('not-a-list')
  })

  it('refuses an index that is a symbolic link', async () => {
    const decoy = path.join(root, 'decoy-threads.json')
    await writeFile(decoy, JSON.stringify({ schemaVersion: 1, activeThreadId: null, threads: [] }))
    await mkdir(path.join(projectPath, 'agent'), { recursive: true })
    await symlink(decoy, indexPath())

    await expect(service.getContext()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('serializes concurrent thread creation so no update is lost', async () => {
    await service.getContext()

    const contexts = await Promise.all([
      service.createThread('First'),
      service.createThread('Second'),
      service.createThread('Third')
    ])

    const longest = contexts.reduce((best, next) => (next.threads.length > best.threads.length ? next : best))
    expect(longest.threads).toHaveLength(4)
    const reloaded = await freshService().getContext()
    expect(reloaded.threads.map((thread) => thread.title).sort()).toEqual([
      'First',
      'Research thread 1',
      'Second',
      'Third'
    ])
  })
})
