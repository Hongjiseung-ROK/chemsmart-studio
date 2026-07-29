import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import {
  type ResearchProjectContext,
  researchProjectSessionRuntimeSchema,
  type ResearchThreadIndex,
  type ResearchThreadSummary
} from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'

import { projectDisplayName, projectHandleId } from './projectFiles'

const logger = loggerService.withContext('ResearchProjectSessionService')

/** The sidecar lives beside manifest.json so it travels with project Save As. */
const AGENT_DIRECTORY = 'agent'
const THREAD_INDEX_NAME = 'threads.json'
/** Matches the schema's `researchThreadList` bound. */
const MAX_THREADS = 64
const MAX_INDEX_BYTES = 256 * 1024
/** The single legacy Studio session id that predates named threads. */
const LEGACY_SESSION_ID = 'workspace-main'
const IMPORTED_THREAD_TITLE = 'Imported workspace'
// The schema forbids C0 controls and DEL in a title.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const validateThreadIndex = runtimeValidator.getValidator<ResearchThreadIndex>({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: researchProjectSessionRuntimeSchema.$defs,
  $ref: '#/$defs/threadIndex'
} as JsonSchemaType)

function invalid(message: string): IpcError {
  return new IpcError(chemsmartStudioErrorCodes.SCHEMA_INVALID, message)
}

function normalizeTitle(candidate: string): string {
  const title = candidate.trim()
  // The schema forbids control characters; rejecting here keeps the fault at the boundary
  // that received it rather than at the write.
  if (title.length === 0 || title.length > 120 || CONTROL_CHARACTERS.test(title)) {
    throw invalid('A research thread title must be 1 to 120 printable characters')
  }
  return title
}

function newThread(title: string, now: string, imported: boolean, agentBound: boolean): ResearchThreadSummary {
  return {
    threadId: `thread-${randomUUID()}`,
    title,
    createdAt: now,
    updatedAt: now,
    activityCount: 0,
    agentBound,
    imported
  }
}

/**
 * Owns which project and which named research thread are active, and persists the thread
 * set inside the canonical `.cmsproj` package.
 *
 * It is deliberately **not** a revision authority. The native helper owns molecule
 * revisions and geometry hashes, `MoleculeWorkspaceService` forwards them, and
 * `StudioControlService` holds the pre-flight predicate. Nothing here reads or writes a
 * revision, so a second source of truth cannot appear.
 *
 * Persistence is a sidecar: `<project>.cmsproj/agent/threads.json`. `manifest.json`,
 * `molecule.json`, and the native C++ loader are untouched, which is why this needs no
 * schema version bump. Provider payloads, credentials, model identifiers, and filesystem
 * paths are never stored or returned.
 */
@Injectable('ResearchProjectSessionService')
@DependsOn(['MoleculeWorkspaceService'])
@ServicePhase(Phase.WhenReady)
export class ResearchProjectSessionService extends BaseService {
  /** Serializes read-modify-write so two renderers cannot interleave an index update. */
  private queue: Promise<unknown> = Promise.resolve()

  async getContext(): Promise<ResearchProjectContext> {
    return this.enqueue(async () => {
      const projectPath = this.projectPath()
      const index = await this.loadIndex(projectPath)
      return this.toContext(projectPath, index)
    })
  }

  async createThread(title: string): Promise<ResearchProjectContext> {
    const normalized = normalizeTitle(title)
    return this.enqueue(async () => {
      const projectPath = this.projectPath()
      const index = await this.loadIndex(projectPath)
      if (index.threads.length >= MAX_THREADS) {
        throw invalid(`A project holds at most ${MAX_THREADS} research threads`)
      }
      const thread = newThread(normalized, new Date().toISOString(), false, false)
      const next: ResearchThreadIndex = {
        schemaVersion: 1,
        activeThreadId: thread.threadId,
        threads: [...index.threads, thread]
      }
      await this.writeIndex(projectPath, next)
      return this.toContext(projectPath, next)
    })
  }

  async renameThread(threadId: string, title: string): Promise<ResearchProjectContext> {
    const normalized = normalizeTitle(title)
    return this.enqueue(async () => {
      const projectPath = this.projectPath()
      const index = await this.loadIndex(projectPath)
      const now = new Date().toISOString()
      let found = false
      const threads = index.threads.map((thread) => {
        if (thread.threadId !== threadId) return thread
        found = true
        return { ...thread, title: normalized, updatedAt: now }
      })
      if (!found) throw invalid('The research thread does not exist in this project')
      const next: ResearchThreadIndex = { ...index, threads }
      await this.writeIndex(projectPath, next)
      return this.toContext(projectPath, next)
    })
  }

  async selectThread(threadId: string): Promise<ResearchProjectContext> {
    return this.enqueue(async () => {
      const projectPath = this.projectPath()
      const index = await this.loadIndex(projectPath)
      if (!index.threads.some((thread) => thread.threadId === threadId)) {
        throw invalid('The research thread does not exist in this project')
      }
      const next: ResearchThreadIndex = { ...index, activeThreadId: threadId }
      await this.writeIndex(projectPath, next)
      return this.toContext(projectPath, next)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private projectPath(): string {
    return application.get('MoleculeWorkspaceService').getActiveProjectPath()
  }

  private toContext(projectPath: string, index: ResearchThreadIndex): ResearchProjectContext {
    return {
      projectId: projectHandleId(projectPath),
      projectName: projectDisplayName(projectPath),
      activeThreadId: index.activeThreadId,
      threads: index.threads.map((thread) => ({ ...thread }))
    }
  }

  private indexPath(projectPath: string): string {
    return path.join(projectPath, AGENT_DIRECTORY, THREAD_INDEX_NAME)
  }

  private async loadIndex(projectPath: string): Promise<ResearchThreadIndex> {
    const indexPath = this.indexPath(projectPath)
    let raw: string
    try {
      const stat = await lstat(indexPath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw invalid('The research thread index must be a regular file')
      }
      if (stat.size > MAX_INDEX_BYTES) throw invalid('The research thread index is too large')
      raw = await readFile(indexPath, 'utf8')
    } catch (error) {
      if (error instanceof IpcError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return this.seedIndex(projectPath)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw invalid('The research thread index is malformed')
    }
    // Fail closed on a corrupt index rather than silently discarding a researcher's
    // threads by reseeding over them.
    if (!validateThreadIndex(parsed).valid) {
      throw invalid('The research thread index does not match its contract')
    }
    return parsed as ResearchThreadIndex
  }

  /**
   * First read of a project that has no sidecar yet. If the single legacy
   * `workspace-main` agent session exists, it becomes one imported thread so the
   * researcher's earlier conversation stays reachable. The legacy directory itself is
   * never moved, rewritten, or deleted.
   */
  private async seedIndex(projectPath: string): Promise<ResearchThreadIndex> {
    const now = new Date().toISOString()
    const legacy = await this.legacySessionExists()
    const threads = legacy
      ? [newThread(IMPORTED_THREAD_TITLE, now, true, true)]
      : [newThread('Research thread 1', now, false, false)]
    const index: ResearchThreadIndex = {
      schemaVersion: 1,
      activeThreadId: threads[0].threadId,
      threads
    }
    await this.writeIndex(projectPath, index)
    if (legacy) logger.info('Imported the legacy Studio workspace as a named research thread')
    return index
  }

  private async legacySessionExists(): Promise<boolean> {
    const candidate = path.join(
      application.getPath('feature.chemsmart_studio.agent_sessions'),
      LEGACY_SESSION_ID,
      'agent-session.json'
    )
    try {
      const stat = await lstat(candidate)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async writeIndex(projectPath: string, index: ResearchThreadIndex): Promise<void> {
    if (!validateThreadIndex(index).valid) {
      throw invalid('Refusing to write a research thread index that does not match its contract')
    }
    const indexPath = this.indexPath(projectPath)
    await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 })
    const temporary = `${indexPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, indexPath)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}
