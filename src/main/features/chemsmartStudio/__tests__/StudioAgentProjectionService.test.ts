import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { BaseService } from '@main/core/lifecycle/BaseService'
import { getDependencies, getPhase } from '@main/core/lifecycle/decorators'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetMock, getPathMock, broadcastMock, recordActivityMock } = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  getPathMock: vi.fn(),
  broadcastMock: vi.fn(),
  recordActivityMock: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: appGetMock, getPath: getPathMock } }))

import { StudioAgentProjectionService } from '../StudioAgentProjectionService'

describe('StudioAgentProjectionService', () => {
  let root: string
  let service: StudioAgentProjectionService
  const threadId = 'thread-1'
  const secondThreadId = 'thread-2'
  const importedThreadId = 'thread-imported'
  const projectId = 'project-1'

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chemsmart-agent-projection-'))
    getPathMock.mockReturnValue(root)
    appGetMock.mockImplementation((name: string) => {
      if (name === 'ResearchProjectSessionService') {
        return {
          getContext: vi.fn().mockResolvedValue({
            projectId,
            projectName: 'Water',
            activeThreadId: threadId,
            threads: [
              {
                threadId,
                title: 'Water inspection',
                createdAt: '2026-07-29T00:00:00Z',
                updatedAt: '2026-07-29T00:00:00Z',
                activityCount: 0,
                agentBound: false,
                imported: false
              },
              {
                threadId: secondThreadId,
                title: 'Independent optimization',
                createdAt: '2026-07-29T00:00:00Z',
                updatedAt: '2026-07-29T00:00:00Z',
                activityCount: 0,
                agentBound: false,
                imported: false
              },
              {
                threadId: importedThreadId,
                title: 'Imported legacy conversation',
                createdAt: '2026-07-29T00:00:00Z',
                updatedAt: '2026-07-29T00:00:00Z',
                activityCount: 0,
                agentBound: true,
                imported: true
              }
            ]
          }),
          recordActivity: recordActivityMock
        }
      }
      if (name === 'MoleculeWorkspaceService') {
        return { getCachedMoleculeSummary: () => ({ documentId: 'molecule-1', revision: 2 }) }
      }
      if (name === 'CalculationRuntimeService') {
        return {
          getWorkspaceContext: vi.fn().mockResolvedValue({
            type: 'studio_context',
            sessionId: 'session-1',
            project: { projectHandleId: projectId, projectName: 'Water' },
            document: {
              documentId: 'molecule-1',
              revision: 2,
              geometryHash: `sha256:${'1'.repeat(64)}`
            },
            display: {
              state: 'committed',
              documentId: 'molecule-1',
              revision: 2,
              geometryHash: `sha256:${'1'.repeat(64)}`
            },
            draft: null,
            selection: { atomIds: ['atom-o'], bondIds: [] },
            editorMode: 'inspect',
            panes: ['explorer', 'agent'],
            activeRun: {
              runId: 'run-1',
              state: 'running',
              frameCount: 1
            },
            extensions: {}
          })
        }
      }
      if (name === 'IpcApiService') return { broadcast: broadcastMock }
      throw new Error(`unexpected service ${name}`)
    })
    BaseService.resetInstances()
    service = new StudioAgentProjectionService()
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('registers after project-session and molecule workspace authority', () => {
    expect(getPhase(StudioAgentProjectionService)).toBe('whenReady')
    expect(getDependencies(StudioAgentProjectionService)).toEqual([
      'ResearchProjectSessionService',
      'MoleculeWorkspaceService',
      'CalculationRuntimeService'
    ])
  })

  it('persists a normalized turn with monotonic identity and exactly one terminal event', async () => {
    const started = await service.beginTurn(threadId, '/inspect the current molecule')
    const reasoning = await service.appendTurnEvent(threadId, started.turnId, {
      kind: 'reasoning_summary',
      status: 'running',
      summary: 'Checking the visible molecule identity.'
    })
    const terminal = await service.terminalize(threadId, started.turnId, 'completed', 'Inspection completed.')

    expect([started.sequence, reasoning.sequence, terminal.sequence]).toEqual([0, 1, 2])
    expect(terminal).toMatchObject({ kind: 'turn_terminal', outcome: 'completed', status: 'succeeded' })
    await expect(
      service.terminalize(threadId, started.turnId, 'completed', 'Duplicate terminal.')
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    expect(recordActivityMock).toHaveBeenCalledOnce()
    expect(broadcastMock).toHaveBeenCalledTimes(3)

    const page = await service.getPage(threadId, null, 2)
    expect(page.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(page.nextBeforeSequence).toBe(1)

    const directory = path.join(root, projectId)
    const file = path.join(directory, `${threadId}.json`)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const stored = await readFile(file, 'utf8')
    expect(stored).not.toContain('providerPayload')
    expect(stored).not.toContain('reasoning_content')
  })

  it('keeps project threads isolated and does not inject the legacy archive into a new projection', async () => {
    expect((await service.getPage(importedThreadId, null, 20)).events).toEqual([])

    const first = await service.beginTurn(threadId, 'Inspect the first molecule state.')
    await service.terminalize(threadId, first.turnId, 'completed', 'First inspection completed.')
    const second = await service.beginTurn(secondThreadId, 'Plan an independent optimization.')
    await service.terminalize(secondThreadId, second.turnId, 'completed', 'Independent plan completed.')

    const firstPage = await service.getPage(threadId, null, 20)
    const secondPage = await service.getPage(secondThreadId, null, 20)
    expect(firstPage.events.every((event) => event.threadId === threadId)).toBe(true)
    expect(secondPage.events.every((event) => event.threadId === secondThreadId)).toBe(true)
    expect(firstPage.events.map((event) => event.summary)).not.toContain('Plan an independent optimization.')
    expect(secondPage.events.map((event) => event.summary)).not.toContain('Inspect the first molecule state.')

    const directory = path.join(root, projectId)
    expect((await stat(path.join(directory, `${threadId}.json`))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(directory, `${secondThreadId}.json`))).mode & 0o777).toBe(0o600)
    await expect(stat(path.join(directory, `${importedThreadId}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('tracks trusted tool order and rejects completion without an active tool', async () => {
    const started = await service.beginTurn(threadId, 'Prepare a safe plan.')
    const tool = {
      toolCallId: 'call-1',
      toolName: 'analyze_current_molecule',
      purpose: 'Inspect the visible molecule.'
    }
    await expect(
      service.appendTurnEvent(threadId, started.turnId, {
        kind: 'tool_succeeded',
        status: 'succeeded',
        summary: 'Finished.',
        tool
      })
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await service.appendTurnEvent(threadId, started.turnId, {
      kind: 'tool_started',
      status: 'running',
      summary: 'Inspecting the molecule.',
      tool
    })
    await service.appendTurnEvent(threadId, started.turnId, {
      kind: 'tool_succeeded',
      status: 'succeeded',
      summary: 'Inspection completed.',
      tool: { ...tool, durationMs: 5, resultKeys: ['atomCount'] }
    })
  })

  it.each([
    '/Users/researcher/private.xyz',
    'Authorization: Bearer hidden',
    'sk-example-secret-value',
    'reasoning_content is private',
    '| Field | Value |'
  ])('refuses private or unstructured projection text: %s', async (summary) => {
    await expect(service.beginTurn(threadId, summary)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('returns only path-free capabilities that are available for the active project', async () => {
    const manifest = await service.getCapabilityManifest(threadId, 'session-1')

    expect(manifest.projectId).toBe(projectId)
    expect(manifest.items.some((item) => item.key === 'current_molecule')).toBe(true)
    expect(manifest.items.some((item) => item.key === 'selection')).toBe(true)
    expect(manifest.items.some((item) => item.key === 'current_run_frame')).toBe(true)
    expect(manifest.items.filter((item) => item.discovery === 'command').map((item) => item.key)).toEqual([
      'inspect',
      'plan',
      'dry-run',
      'review',
      'history',
      'new'
    ])
    expect(JSON.stringify(manifest)).not.toContain('/Users/')
    expect(JSON.stringify(manifest)).not.toContain('/private/')
    for (const item of manifest.items.filter((candidate) => candidate.discovery === 'mention')) {
      expect(item.contextRef).toMatch(/^context-[0-9a-f]{32}$/)
      expect(service.resolveContextReference(item.contextRef!)).not.toBeNull()
    }
  })

  it('fails closed on a corrupt or out-of-order durable transcript', async () => {
    const directory = path.join(root, projectId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, `${threadId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        events: [
          {
            eventId: 'event-1',
            threadId,
            turnId: 'turn-1',
            sequence: 9,
            timestamp: '2026-07-29T00:00:00Z',
            kind: 'user_message',
            status: 'running',
            summary: 'Inspect the molecule.',
            extensions: {}
          }
        ]
      })
    )

    await expect(service.getPage(threadId, null, 20)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })
})
