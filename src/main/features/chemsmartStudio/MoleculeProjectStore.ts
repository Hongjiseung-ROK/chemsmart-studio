import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, opendir, readFile, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import type { MoleculeDocument, ProjectManifest } from '@chemsmart/studio-protocol'
import { loggerService } from '@logger'
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'

import {
  normalizeProjectPath,
  prepareNewProjectPath,
  type ProjectBundleInfo,
  validateProjectBundle,
  validateProjectState
} from './projectFiles'

const logger = loggerService.withContext('MoleculeProjectStore')
const MANIFEST_SCHEMA_VERSION = '1.0.0'
const MANIFEST_PROTOCOL_VERSION = '1.0.0'
const JOURNAL_NAME = '.chemsmart-molecule-transaction.json'
const DRAFT_JOURNAL_NAME = '.chemsmart-molecule-draft.json'
const MAX_PROJECT_FILES = 10_000
const MAX_PROJECT_BYTES = 1024 * 1024 * 1024
const MAX_ACTIVE_PROJECT_MARKER_BYTES = 64 * 1024
const MAX_DRAFT_JOURNAL_BYTES = 64 * 1024 * 1024

interface ActiveProjectMarker {
  version: 1
  projectPath: string
}

interface DurableTransactionFile {
  target: 'manifest.json' | 'molecule.json'
  temporary: string
  sha256: string
}

interface DurableTransactionJournal {
  version: 1
  transactionId: string
  createdAt: string
  files: [DurableTransactionFile, DurableTransactionFile]
}

interface DurableDraftJournal {
  version: 1
  payload: unknown
  sha256: string
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function serialized(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function withoutTransientSelection(document: MoleculeDocument): MoleculeDocument {
  return { ...document, selections: [] }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY)
  try {
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

async function writeSynced(filePath: string, bytes: Uint8Array): Promise<void> {
  const descriptor = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await descriptor.writeFile(bytes)
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

async function regularFileHash(filePath: string): Promise<string | null> {
  try {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return hashBytes(await readFile(filePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseJournal(value: unknown): DurableTransactionJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project journal is malformed')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.transactionId !== 'string' ||
    typeof record.createdAt !== 'string' ||
    !Array.isArray(record.files) ||
    record.files.length !== 2
  ) {
    throw new Error('Project journal is malformed')
  }
  const files = record.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Project journal is malformed')
    const file = entry as Record<string, unknown>
    if (
      (file.target !== 'manifest.json' && file.target !== 'molecule.json') ||
      typeof file.temporary !== 'string' ||
      path.basename(file.temporary) !== file.temporary ||
      !file.temporary.startsWith('.chemsmart-') ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error('Project journal is malformed')
    }
    return file as unknown as DurableTransactionFile
  })
  if (new Set(files.map((file) => file.target)).size !== 2) throw new Error('Project journal is malformed')
  return {
    version: 1,
    transactionId: record.transactionId,
    createdAt: record.createdAt,
    files
  } as DurableTransactionJournal
}

@Injectable('MoleculeProjectStore')
@ServicePhase(Phase.WhenReady)
export class MoleculeProjectStore extends BaseService {
  private activeProjectPath: string | null = null
  private writeInFlight = false

  protected async onInit(): Promise<void> {
    const markerPath = application.getPath('feature.chemsmart_studio.active_project_file')
    try {
      const stat = await lstat(markerPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ACTIVE_PROJECT_MARKER_BYTES) {
        throw new Error('The active-project marker is not a bounded regular file')
      }
      const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).version !== 1 ||
        typeof (parsed as Record<string, unknown>).projectPath !== 'string'
      ) {
        throw new Error('The active-project marker is malformed')
      }
      const project = await this.inspectProject((parsed as ActiveProjectMarker).projectPath)
      this.activeProjectPath = project.projectPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      logger.warn('Ignoring an invalid ChemSmart Studio active-project marker', error as Error)
    }
  }

  getActiveProjectPath(): string {
    this.activeProjectPath ??= application.getPath('feature.chemsmart_studio.projects', 'Untitled.cmsproj')
    return this.activeProjectPath
  }

  async ensureDefaultProject(document: MoleculeDocument): Promise<ProjectBundleInfo> {
    const projectPath = this.getActiveProjectPath()
    try {
      const project = await this.inspectProject(projectPath)
      this.activeProjectPath = project.projectPath
      return project
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const created = await this.createProject(projectPath, document)
    this.activeProjectPath = created.projectPath
    return created
  }

  async inspectProject(projectPath: string): Promise<ProjectBundleInfo> {
    const normalized = normalizeProjectPath(projectPath)
    await this.recoverProject(normalized)
    return validateProjectBundle(normalized)
  }

  async activateProject(project: ProjectBundleInfo): Promise<void> {
    const markerPath = application.getPath('feature.chemsmart_studio.active_project_file')
    const temporary = `${markerPath}.${randomUUID()}.tmp`
    try {
      await writeSynced(
        temporary,
        serialized({
          version: 1,
          projectPath: project.projectPath
        } satisfies ActiveProjectMarker)
      )
      await rename(temporary, markerPath)
      await syncDirectory(path.dirname(markerPath))
    } finally {
      await rm(temporary, { force: true })
    }
    this.activeProjectPath = project.projectPath
  }

  async createProject(requestedPath: string, document: MoleculeDocument): Promise<ProjectBundleInfo> {
    const target = await prepareNewProjectPath(requestedPath)
    const temporaryPackage = path.join(path.dirname(target), `.${path.basename(target)}.chemsmart-new-${randomUUID()}`)
    try {
      await mkdir(temporaryPackage, { mode: 0o700 })
      await this.writeProjectState(temporaryPackage, document, null, {
        createdAt: new Date().toISOString(),
        extensions: {}
      })
      await validateProjectBundle(temporaryPackage)
      await rename(temporaryPackage, target)
      await syncDirectory(path.dirname(target))
      return validateProjectBundle(target)
    } catch (error) {
      await rm(temporaryPackage, { recursive: true, force: true })
      throw error
    }
  }

  async copyProject(sourcePath: string, requestedTargetPath: string): Promise<ProjectBundleInfo> {
    const source = await this.inspectProject(sourcePath)
    const target = await prepareNewProjectPath(requestedTargetPath)
    if (source.projectPath === target) throw new Error('Choose a different project name')
    const temporaryPackage = path.join(path.dirname(target), `.${path.basename(target)}.chemsmart-copy-${randomUUID()}`)
    let fileCount = 0
    let totalBytes = 0

    const copyDirectory = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
      await mkdir(targetDirectory, { mode: 0o700 })
      const directory = await opendir(sourceDirectory)
      for await (const entry of directory) {
        if (entry.name === JOURNAL_NAME || entry.name.startsWith('.chemsmart-')) continue
        const sourceEntry = path.join(sourceDirectory, entry.name)
        const targetEntry = path.join(targetDirectory, entry.name)
        const stat = await lstat(sourceEntry)
        if (stat.isSymbolicLink()) throw new Error('Invalid ChemSmart Studio project: symbolic links are not allowed')
        if (stat.isDirectory()) {
          await copyDirectory(sourceEntry, targetEntry)
          continue
        }
        if (!stat.isFile()) {
          throw new Error('Invalid ChemSmart Studio project: special filesystem entries are not allowed')
        }
        fileCount += 1
        totalBytes += stat.size
        if (fileCount > MAX_PROJECT_FILES || totalBytes > MAX_PROJECT_BYTES) {
          throw new Error('Invalid ChemSmart Studio project: the package exceeds the copy limits')
        }
        await copyFile(sourceEntry, targetEntry, constants.COPYFILE_EXCL)
      }
    }

    try {
      await copyDirectory(source.projectPath, temporaryPackage)
      await validateProjectBundle(temporaryPackage)
      await rename(temporaryPackage, target)
      await syncDirectory(path.dirname(target))
      return validateProjectBundle(target)
    } catch (error) {
      await rm(temporaryPackage, { recursive: true, force: true })
      throw error
    }
  }

  async commitDocument(document: MoleculeDocument): Promise<ProjectBundleInfo> {
    const projectPath = this.getActiveProjectPath()
    const current = await this.inspectProject(projectPath)
    return this.withWrite(async () => {
      await this.writeProjectState(projectPath, document, current.manifest.activeRunId, {
        createdAt: current.manifest.createdAt,
        extensions: current.manifest.extensions
      })
      return this.inspectProject(projectPath)
    })
  }

  /**
   * Persists the main-owned molecule draft beside the active project. The project store remains
   * the only filesystem writer; the document service owns and schema-validates the payload.
   */
  async writeDraftJournal(payload: unknown): Promise<void> {
    const projectPath = this.getActiveProjectPath()
    await this.inspectProject(projectPath)
    await this.withWrite(async () => {
      const payloadBytes = serialized(payload)
      const journal: DurableDraftJournal = {
        version: 1,
        payload,
        sha256: hashBytes(payloadBytes)
      }
      const target = path.join(projectPath, DRAFT_JOURNAL_NAME)
      const temporary = path.join(projectPath, `.chemsmart-draft-${randomUUID()}.tmp`)
      try {
        await writeSynced(temporary, serialized(journal))
        await rename(temporary, target)
        await syncDirectory(projectPath)
      } finally {
        await rm(temporary, { force: true })
      }
    })
  }

  async readDraftJournal(): Promise<unknown | null> {
    const projectPath = this.getActiveProjectPath()
    const journalPath = path.join(projectPath, DRAFT_JOURNAL_NAME)
    try {
      const stat = await lstat(journalPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DRAFT_JOURNAL_BYTES) {
        throw new Error('Molecule draft journal is not a bounded regular file')
      }
      const parsed: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Molecule draft journal is malformed')
      }
      const journal = parsed as Partial<DurableDraftJournal>
      if (journal.version !== 1 || typeof journal.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(journal.sha256)) {
        throw new Error('Molecule draft journal is malformed')
      }
      if (hashBytes(serialized(journal.payload)) !== journal.sha256) {
        throw new Error('Molecule draft journal hash does not match its payload')
      }
      return journal.payload
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async clearDraftJournal(): Promise<void> {
    const projectPath = this.getActiveProjectPath()
    await this.withWrite(async () => {
      try {
        await unlink(path.join(projectPath, DRAFT_JOURNAL_NAME))
        await syncDirectory(projectPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }

  async setActiveRunId(activeRunId: string | null): Promise<ProjectBundleInfo> {
    const projectPath = this.getActiveProjectPath()
    const current = await this.inspectProject(projectPath)
    return this.withWrite(async () => {
      await this.writeProjectState(projectPath, current.document, activeRunId, {
        createdAt: current.manifest.createdAt,
        extensions: current.manifest.extensions
      })
      return this.inspectProject(projectPath)
    })
  }

  async compareAndSetActiveRunId(
    expectedActiveRunId: string | null,
    nextActiveRunId: string | null
  ): Promise<ProjectBundleInfo> {
    const projectPath = this.getActiveProjectPath()
    return this.withWrite(async () => {
      const current = await this.inspectProject(projectPath)
      if (current.manifest.activeRunId !== expectedActiveRunId) {
        throw new Error('The active molecule run changed during the project transaction')
      }
      await this.writeProjectState(projectPath, current.document, nextActiveRunId, {
        createdAt: current.manifest.createdAt,
        extensions: current.manifest.extensions
      })
      return this.inspectProject(projectPath)
    })
  }

  /**
   * Completes run cleanup idempotently after a terminal or final-decision journal is durable.
   * A null value means an earlier recovery already performed the same cleanup; any other run id
   * is a conflicting owner and fails closed.
   */
  async releaseActiveRunId(runId: string): Promise<ProjectBundleInfo> {
    const projectPath = this.getActiveProjectPath()
    return this.withWrite(async () => {
      const current = await this.inspectProject(projectPath)
      if (current.manifest.activeRunId === null) return current
      if (current.manifest.activeRunId !== runId) {
        throw new Error('Another optimization owns the active molecule project')
      }
      await this.writeProjectState(projectPath, current.document, null, {
        createdAt: current.manifest.createdAt,
        extensions: current.manifest.extensions
      })
      return this.inspectProject(projectPath)
    })
  }

  private async withWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.writeInFlight) throw new Error('A molecule project transaction is already in progress')
    this.writeInFlight = true
    try {
      return await operation()
    } finally {
      this.writeInFlight = false
    }
  }

  private async writeProjectState(
    projectPath: string,
    document: MoleculeDocument,
    activeRunId: string | null,
    existing: { createdAt?: string; extensions: ProjectManifest['extensions'] }
  ): Promise<void> {
    const now = new Date().toISOString()
    const persistedDocument = withoutTransientSelection(document)
    const manifest: ProjectManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      protocolVersion: MANIFEST_PROTOCOL_VERSION,
      documentId: persistedDocument.documentId,
      currentRevision: persistedDocument.revision,
      activeRunId,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
      extensions: existing.extensions
    }
    validateProjectState(manifest, persistedDocument)
    const transactionId = randomUUID()
    const files = [
      {
        target: 'molecule.json' as const,
        temporary: `.chemsmart-molecule-${transactionId}.tmp`,
        bytes: serialized(persistedDocument)
      },
      {
        target: 'manifest.json' as const,
        temporary: `.chemsmart-manifest-${transactionId}.tmp`,
        bytes: serialized(manifest)
      }
    ]
    const journal: DurableTransactionJournal = {
      version: 1,
      transactionId,
      createdAt: now,
      files: files.map(({ target, temporary, bytes }) => ({
        target,
        temporary,
        sha256: hashBytes(bytes)
      })) as DurableTransactionJournal['files']
    }
    const journalTemporary = path.join(projectPath, `.chemsmart-journal-${transactionId}.tmp`)
    try {
      for (const file of files) await writeSynced(path.join(projectPath, file.temporary), file.bytes)
      await writeSynced(journalTemporary, serialized(journal))
      await rename(journalTemporary, path.join(projectPath, JOURNAL_NAME))
      await syncDirectory(projectPath)
      for (const file of files) {
        await rename(path.join(projectPath, file.temporary), path.join(projectPath, file.target))
      }
      await syncDirectory(projectPath)
      await unlink(path.join(projectPath, JOURNAL_NAME))
      await syncDirectory(projectPath)
    } catch (error) {
      logger.error('Molecule project transaction did not complete', { projectPath, transactionId, error })
      // Once the journal itself is durable, the operation has a single legal recovery direction.
      // Complete it now when possible so callers never keep the old in-memory revision beside a
      // project that will roll forward on the next read.
      if (await exists(path.join(projectPath, JOURNAL_NAME))) {
        try {
          await this.recoverProject(projectPath)
          return
        } catch (recoveryError) {
          throw new Error('Molecule project transaction failed and could not be recovered', {
            cause: recoveryError
          })
        }
      }
      await Promise.all([
        ...files.map((file) => unlink(path.join(projectPath, file.temporary)).catch(() => undefined)),
        unlink(journalTemporary).catch(() => undefined)
      ])
      throw error
    }
  }

  private async recoverProject(projectPath: string): Promise<void> {
    const journalPath = path.join(projectPath, JOURNAL_NAME)
    if (!(await exists(journalPath))) return
    let journal: DurableTransactionJournal
    try {
      journal = parseJournal(JSON.parse(await readFile(journalPath, 'utf8')))
    } catch (error) {
      throw new Error('ChemSmart Studio project recovery failed closed: the journal is invalid', { cause: error })
    }

    const actions: Array<{ temporary: string; target: string } | null> = []
    for (const file of journal.files) {
      const targetPath = path.join(projectPath, file.target)
      if ((await regularFileHash(targetPath)) === file.sha256) {
        actions.push(null)
        continue
      }
      const temporaryPath = path.join(projectPath, file.temporary)
      if ((await regularFileHash(temporaryPath)) !== file.sha256) {
        throw new Error('ChemSmart Studio project recovery failed closed: journal content hash mismatch')
      }
      actions.push({ temporary: temporaryPath, target: targetPath })
    }
    for (const action of actions) {
      if (action) await rename(action.temporary, action.target)
    }
    await syncDirectory(projectPath)
    await unlink(journalPath)
    await syncDirectory(projectPath)
    logger.info('Recovered a durable molecule project transaction', {
      projectPath,
      transactionId: journal.transactionId
    })
  }
}
