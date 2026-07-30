import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, type FileHandle, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import type {
  ProjectWorkspaceCandidateDecisionResult,
  ProjectWorkspaceCandidateResult,
  ProjectWorkspaceCandidateStatus,
  ProjectWorkspaceCandidateSummary,
  ProjectWorkspaceDocumentResult,
  ProjectWorkspaceRegisterCandidateRequest
} from '@chemsmart/studio-protocol'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { type ChemSmartStudioErrorCode, chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { parse } from 'yaml'

const MAX_YAML_BYTES = 256 * 1024
const CANDIDATE_LIFETIME_MS = 5 * 60 * 1000

interface CandidateRecord {
  activeProjectPath: string
  candidate: ProjectWorkspaceCandidateSummary
  document: ProjectWorkspaceDocumentResult
  documentId: string
  sessionId: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function failure(code: ChemSmartStudioErrorCode, message: string): IpcError {
  return new IpcError(code, message)
}

function topLevelKeys(yamlText: string): string[] {
  try {
    const value = parse(yamlText)
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
  } catch {
    return []
  }
}

@Injectable('ProjectYamlService')
@DependsOn(['MoleculeDocumentService', 'MoleculeWorkspaceService'])
@ServicePhase(Phase.WhenReady)
export class ProjectYamlService extends BaseService {
  private readonly candidates = new Map<string, CandidateRecord>()
  private readonly deciding = new Set<string>()

  async registerCandidate(
    sessionId: string,
    request: ProjectWorkspaceRegisterCandidateRequest
  ): Promise<ProjectWorkspaceCandidateSummary> {
    const { document } = request
    if (document.program !== 'gaussian' && document.program !== 'orca') {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Agent YAML candidates support Gaussian and ORCA only')
    }
    if (sha256(document.yamlText) !== document.digest) {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML candidate digest is inconsistent')
    }

    const documents = application.get('MoleculeDocumentService')
    const committed = documents.getDocument()
    const activeProjectPath = application.get('MoleculeWorkspaceService').getActiveProjectPath()
    const target = await this.targetPath(document.program, document.projectName)
    const existing = await this.readTarget(target)
    const baseDigest = existing === null ? null : sha256(existing)
    const changedSections = [...new Set([...topLevelKeys(existing ?? ''), ...topLevelKeys(document.yamlText)])].filter(
      (section) => {
        const prior = this.sectionValue(existing, section)
        const next = this.sectionValue(document.yamlText, section)
        return JSON.stringify(prior) !== JSON.stringify(next)
      }
    )
    const now = Date.now()
    const candidate: ProjectWorkspaceCandidateSummary = {
      schemaVersion: '2',
      previewId: `yaml-preview-${randomUUID()}`,
      projectName: document.projectName,
      program: document.program,
      baseDigest,
      candidateDigest: document.digest,
      expectedRevision: committed.revision,
      overwrite: existing !== null,
      changedSections,
      verdict: document.validation.verdict,
      issueRuleIds: document.validation.issues.map((issue) => issue.ruleId),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CANDIDATE_LIFETIME_MS).toISOString(),
      extensions: {}
    }
    this.candidates.set(candidate.previewId, {
      activeProjectPath,
      candidate,
      document: structuredClone(document),
      documentId: committed.documentId,
      sessionId
    })
    return structuredClone(candidate)
  }

  getCandidate(sessionId: string, previewId: string): ProjectWorkspaceCandidateResult {
    const record = this.candidates.get(previewId)
    if (!record || record.sessionId !== sessionId) {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML candidate was not found')
    }
    this.expire(record)
    return {
      candidate: structuredClone(record.candidate),
      document: structuredClone(record.document),
      extensions: {}
    }
  }

  async decideCandidate(
    sessionId: string,
    decision: {
      previewId: string
      baseDigest: string | null
      candidateDigest: string
      expectedRevision: number
      decision: 'allow_once' | 'deny'
    }
  ): Promise<ProjectWorkspaceCandidateDecisionResult> {
    const record = this.candidates.get(decision.previewId)
    if (!record || record.sessionId !== sessionId) {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML candidate was not found')
    }
    this.expire(record)
    const candidate = record.candidate
    if (candidate.status === 'expired') return this.finish(record, 'expired')
    if (
      candidate.status !== 'pending' ||
      candidate.baseDigest !== decision.baseDigest ||
      candidate.candidateDigest !== decision.candidateDigest ||
      candidate.expectedRevision !== decision.expectedRevision
    ) {
      throw failure(chemsmartStudioErrorCodes.REVISION_CONFLICT, 'Project YAML decision no longer matches its preview')
    }
    if (decision.decision === 'deny') {
      return this.finish(record, 'denied')
    }
    if (candidate.verdict === 'reject') {
      return this.finish(record, 'failed')
    }
    if (this.deciding.has(candidate.previewId)) {
      throw failure(chemsmartStudioErrorCodes.APPROVAL_REQUIRED, 'Project YAML decision is already being applied')
    }
    this.deciding.add(candidate.previewId)

    try {
      const committed = application.get('MoleculeDocumentService').getDocument()
      const activeProjectPath = application.get('MoleculeWorkspaceService').getActiveProjectPath()
      if (
        committed.documentId !== record.documentId ||
        committed.revision !== candidate.expectedRevision ||
        activeProjectPath !== record.activeProjectPath
      ) {
        return this.finish(record, 'stale')
      }
      const target = await this.targetPath(candidate.program, candidate.projectName)
      const existing = await this.readTarget(target)
      const currentDigest = existing === null ? null : sha256(existing)
      if (currentDigest !== candidate.baseDigest) {
        return this.finish(record, 'stale')
      }
      await this.ensureTargetDirectory(candidate.program)
      await this.atomicWrite(target, record.document.yamlText)
      return this.finish(record, 'written')
    } catch {
      return this.finish(record, 'failed')
    } finally {
      this.deciding.delete(candidate.previewId)
    }
  }

  private finish(
    record: CandidateRecord,
    status: Exclude<ProjectWorkspaceCandidateStatus, 'pending'>
  ): ProjectWorkspaceCandidateDecisionResult {
    record.candidate = { ...record.candidate, status }
    return {
      previewId: record.candidate.previewId,
      candidateDigest: record.candidate.candidateDigest,
      status,
      extensions: {}
    }
  }

  private expire(record: CandidateRecord): void {
    if (record.candidate.status === 'pending' && Date.parse(record.candidate.expiresAt) <= Date.now()) {
      record.candidate = { ...record.candidate, status: 'expired' }
    }
  }

  private sectionValue(yamlText: string | null, section: string): unknown {
    if (yamlText === null) return undefined
    try {
      const value = parse(yamlText)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[section]
        : undefined
    } catch {
      return undefined
    }
  }

  private async targetPath(program: 'gaussian' | 'orca', projectName: string): Promise<string> {
    const root = application.getPath('feature.chemsmart_studio.workspace')
    const metadata = await lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML workspace is unsafe')
    }
    return path.join(root, '.chemsmart', program, `${projectName}.yaml`)
  }

  private async ensureTargetDirectory(program: 'gaussian' | 'orca'): Promise<void> {
    const root = application.getPath('feature.chemsmart_studio.workspace')
    const chemsmart = path.join(root, '.chemsmart')
    const directory = path.join(chemsmart, program)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const owned of [root, chemsmart, directory]) {
      const metadata = await lstat(owned)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML workspace is unsafe')
      }
      await chmod(owned, 0o700)
    }
  }

  private async readTarget(target: string): Promise<string | null> {
    let metadata
    try {
      metadata = await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_YAML_BYTES) {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML target is unsafe')
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.size > MAX_YAML_BYTES
      ) {
        throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML target changed while being read')
      }
      const bytes = Buffer.alloc(opened.size)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== opened.size) {
        throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML target changed while being read')
      }
      return bytes.toString('utf8')
    } finally {
      await handle.close()
    }
  }

  private async atomicWrite(target: string, yamlText: string): Promise<void> {
    const payload = Buffer.from(yamlText, 'utf8')
    if (payload.length === 0 || payload.length > MAX_YAML_BYTES) {
      throw failure(chemsmartStudioErrorCodes.SCHEMA_INVALID, 'Project YAML candidate size is invalid')
    }
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    let handle: FileHandle | null = null
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await handle.writeFile(payload)
      await handle.chmod(0o600)
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporary, target)
      await chmod(target, 0o600)
      const directory = await open(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      if (handle) await handle.close()
      await rm(temporary, { force: true })
    }
  }
}
