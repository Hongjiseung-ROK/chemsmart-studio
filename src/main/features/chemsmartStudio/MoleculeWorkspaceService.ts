import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { application } from '@application'
import {
  type MoleculeCommitReceipt,
  type MoleculeDocument,
  type MoleculeOperation,
  type MoleculePatch,
  moleculePatchRuntimeSchema,
  type OptimizationReplayCatalogQuery,
  type OptimizationReplayFrameQuery,
  type OptimizationReplayFrameResponse,
  optimizationReplayRuntimeSchema,
  type OptimizationReplayTimeline,
  type OptimizationReplayTimelineQuery,
  type PreviewReceipt,
  type StageGestureIntent,
  type StudioDraftEntry,
  type StudioDraftSnapshot,
  type StudioMoleculeRequest
} from '@chemsmart/studio-protocol'
import { BaseService, DependsOn, Emitter, type Event, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { t } from '@main/i18n'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import type {
  ChemSmartStudioMoleculeSummary,
  ChemSmartStudioOpenDocuments,
  ChemSmartStudioWorkspaceProjectResult
} from '@shared/ipc/schemas/chemsmartStudio'
import { dialog } from 'electron'
import * as z from 'zod'

import { JsonRpcFault } from './JsonRpcPeer'
import type { MoleculeDiscardReceipt, MoleculeDocumentService } from './MoleculeDocumentService'
import { type ProjectBundleInfo, projectDisplayName, projectHandleId } from './projectFiles'
import type { LedgerReplayCatalog } from './replayComposition'

type MoleculeRequestParams<Method extends StudioMoleculeRequest['method']> = Extract<
  StudioMoleculeRequest,
  { method: Method }
>['params']

/** Re-exported from the authority that now produces it, so existing importers keep working. */
export type { MoleculeDiscardReceipt } from './MoleculeDocumentService'

const runtimeValidator = new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
const runtimeRootSchema = <Output>(runtimeSchema: object): z.ZodType<Output> => {
  // @cfworker/json-schema annotates schemas with non-enumerable absolute-reference metadata.
  // Generated runtime schemas are shared module objects, so another validator can otherwise pin
  // their local refs to its own synthetic root before this service sees them.
  const isolatedSchema = JSON.parse(JSON.stringify(runtimeSchema)) as JsonSchemaType
  const validate = runtimeValidator.getValidator<Output>(isolatedSchema)
  return z.custom<Output>((value) => {
    try {
      return validate(value).valid
    } catch {
      return false
    }
  })
}
const replayDefinitionSchema = <Output>(runtimeSchema: { $defs: object }, definition: string): z.ZodType<Output> => {
  const validate = runtimeValidator.getValidator<Output>({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: runtimeSchema.$defs,
    $ref: `#/$defs/${definition}`
  } as JsonSchemaType)
  return z.custom<Output>((value) => validate(value).valid)
}

// Keep the generated validator responsible for bundled nested references. z.fromJSONSchema resolves
// the bundled atom definition as the molecule document root, which makes valid add_atoms operations
// fail only at runtime.
const moleculePatchSchema = runtimeRootSchema<MoleculePatch>(moleculePatchRuntimeSchema)
const replayCatalogQuerySchema = replayDefinitionSchema<OptimizationReplayCatalogQuery>(
  optimizationReplayRuntimeSchema,
  'catalogQuery'
)
const replayTimelineQuerySchema = replayDefinitionSchema<OptimizationReplayTimelineQuery>(
  optimizationReplayRuntimeSchema,
  'timelineQuery'
)
const replayFrameQuerySchema = replayDefinitionSchema<OptimizationReplayFrameQuery>(
  optimizationReplayRuntimeSchema,
  'frameQuery'
)
const ledgerCatalogSchema = replayDefinitionSchema<LedgerReplayCatalog>(
  optimizationReplayRuntimeSchema,
  'ledgerCatalogResponse'
)
const replayTimelineSchema = replayDefinitionSchema<OptimizationReplayTimeline>(
  optimizationReplayRuntimeSchema,
  'timelineResponse'
)
const replayFrameResponseSchema = replayDefinitionSchema<OptimizationReplayFrameResponse>(
  optimizationReplayRuntimeSchema,
  'frameResponse'
)
const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const revisionSchema = z.number().int().nonnegative()
const selectionParamsSchema = z.strictObject({
  documentId: stableIdSchema,
  expectedRevision: revisionSchema,
  atomIds: z
    .array(stableIdSchema)
    .max(4096)
    .refine((atomIds) => new Set(atomIds).size === atomIds.length)
})
const commitPreviewParamsSchema = z.strictObject({ previewId: stableIdSchema, expectedRevision: revisionSchema })
const discardPreviewParamsSchema = z.strictObject({ previewId: stableIdSchema })
@Injectable('MoleculeWorkspaceService')
@DependsOn(['MoleculeProjectStore', 'MoleculeDocumentService'])
@ServicePhase(Phase.WhenReady)
export class MoleculeWorkspaceService extends BaseService {
  private cachedMoleculeSummary: ChemSmartStudioMoleculeSummary | null = null
  private projectOperationInFlight = false
  /**
   * Every project opened this session, keyed by its opaque handle. The renderer's tab strip names a
   * project by handle alone; main keeps the only map back to a path, so switching tabs never requires
   * the renderer to hold — or send — a filesystem location.
   */
  private readonly openProjects = new Map<string, string>()
  private readonly moleculeChangedEmitter: Emitter<ChemSmartStudioMoleculeSummary>

  public readonly onMoleculeChanged: Event<ChemSmartStudioMoleculeSummary>

  constructor() {
    super()
    this.moleculeChangedEmitter = this.registerDisposable(new Emitter<ChemSmartStudioMoleculeSummary>())
    this.onMoleculeChanged = this.moleculeChangedEmitter.event
  }

  /**
   * The molecule document authority. Since the port off Avogadro this is a main-process
   * TypeScript service, so molecule reads and edits no longer require a running helper.
   */
  private get documents(): MoleculeDocumentService {
    return application.get('MoleculeDocumentService')
  }

  private get projects() {
    return application.get('MoleculeProjectStore')
  }

  protected onInit(): void {
    // Every committed revision — including undo and redo — republishes the summary.
    this.registerDisposable(this.documents.onCommitted((summary) => this.publishMoleculeSummary(summary, true)))
  }

  getCachedMoleculeSummary(): ChemSmartStudioMoleculeSummary | null {
    return this.cachedMoleculeSummary ? { ...this.cachedMoleculeSummary } : null
  }

  private getProjectPath(): string {
    return this.projects.getActiveProjectPath()
  }

  /**
   * Makes sure the default project exists on disk.
   *
   * The Qt helper used to create it as a side effect of being handed `--project`. Once that helper
   * is gone nothing else would, so a fresh profile would show a projects folder with nothing in it.
   * Creating it here is idempotent: an existing package is left exactly as it is.
   */
  async ensureDefaultProject(): Promise<string> {
    return (await this.projects.ensureDefaultProject(this.documents.getDocument())).projectPath
  }

  /**
   * The active `.cmsproj` package for other main-process services that keep their own
   * sidecar state inside it. This is a raw filesystem path and must never reach a
   * renderer, an agent, or a receipt.
   */
  getActiveProjectPath(): string {
    return this.getProjectPath()
  }

  /**
   * The run the project manifest records as active, or null when nothing is recorded. This is the
   * persisted active run — read back on recovery before any session has adopted the run — not a run
   * a session is currently driving. A bundle that does not exist yet reads as null.
   */
  async getPersistedActiveRunId(): Promise<string | null> {
    try {
      const project = await this.projects.inspectProject(this.getProjectPath())
      return project.activeRunId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * The filesystem roots the project explorer displays. This is a human surface: agent-facing
   * schemas stay path-free.
   *
   * The tree roots at the projects folder rather than the open bundle so the researcher can see and
   * switch between projects. That folder is also auto-ensured by the path registry, whereas a
   * `.cmsproj` package does not exist until one is created — rooting at the bundle would show a
   * scan failure on a fresh profile.
   */
  getWorkspaceRoots(): { projectsRoot: string; activeProjectPath: string } {
    return {
      projectsRoot: application.getPath('feature.chemsmart_studio.projects'),
      activeProjectPath: this.getProjectPath()
    }
  }

  /** Records a project so a tab can name it later. Idempotent: the handle is derived from the path. */
  private rememberProject(projectPath: string): string {
    const projectId = projectHandleId(projectPath)
    this.openProjects.set(projectId, projectPath)
    return projectId
  }

  /**
   * The tab strip's contents: every project opened this session, and which one is live.
   *
   * Only handles and display names cross the boundary. The active project is always present, so a
   * freshly started Studio shows one tab rather than none.
   */
  listOpenDocuments(): ChemSmartStudioOpenDocuments {
    const activeProjectId = this.rememberProject(this.getProjectPath())
    return {
      activeProjectId,
      documents: [...this.openProjects].map(([projectId, projectPath]) => ({
        projectId,
        projectName: projectDisplayName(projectPath)
      }))
    }
  }

  /**
   * Switches to an already-opened project named by its handle.
   *
   * An unknown handle is refused rather than resolved: the map is the only authority on which
   * projects this session has opened, so a renderer cannot reach a project by guessing a digest.
   */
  async activateDocument(projectId: string): Promise<ChemSmartStudioWorkspaceProjectResult> {
    return this.withProjectOperation(async () => {
      const projectPath = this.openProjects.get(projectId)
      if (!projectPath) {
        throw new JsonRpcFault(-32602, 'That project is not open in this session', {
          studioCode: chemsmartStudioErrorCodes.SCHEMA_INVALID
        })
      }
      if (projectPath === this.getProjectPath()) return this.currentProjectResult(false)
      return this.switchProject(await this.projects.inspectProject(projectPath))
    })
  }

  async openProject(): Promise<ChemSmartStudioWorkspaceProjectResult> {
    return this.withProjectOperation(async () => {
      const result = await dialog.showOpenDialog({
        title: t('dialog.open_file'),
        defaultPath: application.getPath('feature.chemsmart_studio.projects'),
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return this.currentProjectResult(true)
      const project = await this.projects.inspectProject(result.filePaths[0])
      return this.switchProject(project)
    })
  }

  async importMolecule(): Promise<ChemSmartStudioWorkspaceProjectResult> {
    return this.withProjectOperation(async () => {
      const selected = await dialog.showOpenDialog({
        title: t('dialog.open_file'),
        defaultPath: application.getPath('feature.chemsmart_studio.projects'),
        filters: [{ name: t('dialog.molecule_files'), extensions: ['cjson', 'sdf', 'xyz'] }],
        properties: ['openFile']
      })
      if (selected.canceled || selected.filePaths.length === 0) return this.currentProjectResult(true)
      const importPath = selected.filePaths[0]
      const suggestedName = `${path.basename(importPath, path.extname(importPath))}.cmsproj`
      const target = await dialog.showSaveDialog({
        title: t('dialog.save_file'),
        defaultPath: application.getPath('feature.chemsmart_studio.projects', suggestedName),
        filters: [{ name: t('dialog.chemsmart_project'), extensions: ['cmsproj'] }]
      })
      if (target.canceled || !target.filePath) return this.currentProjectResult(true)
      const imported = await application
        .get('ChemSmartAgentService')
        .importMoleculeFile(importPath, `document-${randomUUID()}`)
      const project = await this.projects.createProject(target.filePath, imported)
      return this.switchProject(project)
    })
  }

  async saveProjectAs(): Promise<ChemSmartStudioWorkspaceProjectResult> {
    return this.withProjectOperation(async () => {
      const source = await this.projects.inspectProject(this.getProjectPath())
      const target = await dialog.showSaveDialog({
        title: t('dialog.save_file'),
        defaultPath: application.getPath(
          'feature.chemsmart_studio.projects',
          `${projectDisplayName(source.projectPath)} Copy.cmsproj`
        ),
        filters: [{ name: t('dialog.chemsmart_project'), extensions: ['cmsproj'] }]
      })
      if (target.canceled || !target.filePath) return this.currentProjectResult(true)
      await this.assertProjectCanClose()
      const project = await this.projects.copyProject(source.projectPath, target.filePath)
      return this.switchProject(project, true)
    })
  }

  async getMoleculeDocument(): Promise<MoleculeDocument> {
    const document = this.documents.getDocument()
    this.publishMoleculeSummary({ documentId: document.documentId, revision: document.revision })
    return document
  }

  getMoleculeDraft(): StudioDraftSnapshot | null {
    return this.documents.getDraftSnapshot()
  }

  async applyDraftPatch(request: {
    actor: 'human' | 'agent'
    expectedRevision: number
    mode: StudioDraftEntry['mode']
    operations: readonly MoleculeOperation[]
    gesture?: StageGestureIntent
  }): Promise<StudioDraftSnapshot> {
    return this.documents.applyDraftPatch(request)
  }

  async undoDraft(): Promise<StudioDraftSnapshot | null> {
    return this.documents.undoDraft()
  }

  async redoDraft(): Promise<StudioDraftSnapshot | null> {
    return this.documents.redoDraft()
  }

  async commitDraft(expectedRevision: number): Promise<MoleculeDocument> {
    return this.documents.commitDraft(expectedRevision)
  }

  async discardDraft(): Promise<MoleculeDocument> {
    return this.documents.discardDraft()
  }

  async getRunningMoleculeSummary(): Promise<ChemSmartStudioMoleculeSummary> {
    const summary = { documentId: this.documents.getDocumentId(), revision: this.documents.getRevision() }
    this.publishMoleculeSummary(summary)
    return summary
  }

  async setSelection(
    documentId: string,
    expectedRevision: number,
    atomIds: readonly string[]
  ): Promise<MoleculeDocument> {
    // Still validated at the boundary: the shape contract does not weaken just because the
    // authority moved in-process.
    const params = this.parseBoundary<MoleculeRequestParams<'molecule.set_selection'>>(
      selectionParamsSchema,
      { documentId, expectedRevision, atomIds: [...atomIds] },
      'selection parameters'
    )
    return this.documents.setSelection(params.documentId, params.expectedRevision, params.atomIds)
  }

  async previewPatch(patch: MoleculePatch): Promise<PreviewReceipt> {
    const verifiedPatch = this.parseBoundary<MoleculePatch>(moleculePatchSchema, patch, 'molecule patch')
    return this.documents.previewPatch(verifiedPatch)
  }

  async commitPreview(previewId: string, expectedRevision: number): Promise<MoleculeCommitReceipt> {
    const params = this.parseBoundary<MoleculeRequestParams<'molecule.commit_preview'>>(
      commitPreviewParamsSchema,
      { previewId, expectedRevision },
      'commit parameters'
    )
    return this.documents.commitPreview(params.previewId, params.expectedRevision)
  }

  async discardPreview(previewId: string): Promise<MoleculeDiscardReceipt> {
    const params = this.parseBoundary<MoleculeRequestParams<'molecule.discard_preview'>>(
      discardPreviewParamsSchema,
      { previewId },
      'discard parameters'
    )
    return this.documents.discardPreview(params.previewId)
  }

  async undo(): Promise<MoleculeDocument> {
    // The authority publishes the restored revision through `onCommitted`, which already republishes
    // the summary and broadcasts the change, so undo and redo only need to delegate.
    return this.documents.undo()
  }

  async redo(): Promise<MoleculeDocument> {
    return this.documents.redo()
  }

  async getOptimizationReplayCatalog(query: OptimizationReplayCatalogQuery): Promise<LedgerReplayCatalog> {
    const params = this.parseBoundary<OptimizationReplayCatalogQuery>(
      replayCatalogQuerySchema,
      query,
      'optimization replay catalog parameters'
    )
    const result = await application
      .get('ChemSmartAgentService')
      .requestTrajectory('optimization.replay_catalog', params)
    return this.parseBoundary<LedgerReplayCatalog>(ledgerCatalogSchema, result, 'optimization replay catalog')
  }

  async getOptimizationReplayTimeline(query: OptimizationReplayTimelineQuery): Promise<OptimizationReplayTimeline> {
    const params = this.parseBoundary<OptimizationReplayTimelineQuery>(
      replayTimelineQuerySchema,
      query,
      'optimization replay timeline parameters'
    )
    const result = await application
      .get('ChemSmartAgentService')
      .requestTrajectory('optimization.replay_timeline', params)
    const timeline = this.parseBoundary<OptimizationReplayTimeline>(
      replayTimelineSchema,
      result,
      'optimization replay timeline'
    )
    if (
      timeline.runId !== params.runId ||
      timeline.offset !== params.offset ||
      timeline.limit !== params.limit ||
      timeline.frames.some((frame, index) => frame.runId !== params.runId || frame.stepIndex !== params.offset + index)
    ) {
      this.throwSchemaInvalid('optimization replay timeline identity')
    }
    return timeline
  }

  async getOptimizationReplayFrame(query: OptimizationReplayFrameQuery): Promise<OptimizationReplayFrameResponse> {
    const params = this.parseBoundary<OptimizationReplayFrameQuery>(
      replayFrameQuerySchema,
      query,
      'optimization replay frame parameters'
    )
    const result = await application.get('ChemSmartAgentService').requestTrajectory('optimization.replay_frame', params)
    const response = this.parseBoundary<OptimizationReplayFrameResponse>(
      replayFrameResponseSchema,
      result,
      'optimization replay frame'
    )
    if (
      response.runId !== params.runId ||
      response.frame.runId !== params.runId ||
      response.frame.frameIndex !== params.stepIndex ||
      response.frameCount <= params.stepIndex
    ) {
      this.throwSchemaInvalid('optimization replay frame identity')
    }
    return response
  }

  private parseBoundary<Result>(schema: z.ZodType, value: unknown, name: string): Result {
    const result = schema.safeParse(value)
    if (!result.success) this.throwSchemaInvalid(name)
    return result.data as Result
  }

  private throwSchemaInvalid(name: string): never {
    throw new JsonRpcFault(-32602, `Molecule workspace returned schema-invalid ${name}`, {
      studioCode: chemsmartStudioErrorCodes.SCHEMA_INVALID
    })
  }

  private publishMoleculeSummary(summary: ChemSmartStudioMoleculeSummary, forceRendererRefresh = false): void {
    const changed = !isDeepStrictEqual(this.cachedMoleculeSummary, summary)
    if (changed) {
      this.cachedMoleculeSummary = { ...summary }
      this.moleculeChangedEmitter.fire({ ...summary })
    }
    if (changed || forceRendererRefresh) {
      application.get('IpcApiService').broadcast('chemsmart_studio.molecule.changed', { ...summary })
    }
  }

  private currentProjectResult(canceled: boolean): ChemSmartStudioWorkspaceProjectResult {
    const molecule = this.getCachedMoleculeSummary()
    return {
      canceled,
      molecule,
      documentName: molecule ? projectDisplayName(this.getProjectPath()) : null
    }
  }

  private async withProjectOperation(
    operation: () => Promise<ChemSmartStudioWorkspaceProjectResult>
  ): Promise<ChemSmartStudioWorkspaceProjectResult> {
    if (this.projectOperationInFlight) {
      throw new JsonRpcFault(-32001, 'A molecule project operation is already in progress', {
        studioCode: chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE
      })
    }
    this.projectOperationInFlight = true
    try {
      return await operation()
    } finally {
      this.projectOperationInFlight = false
    }
  }

  private async assertProjectCanClose(): Promise<void> {
    if (this.documents.hasActiveDraft()) {
      throw new JsonRpcFault(-32003, 'Apply or discard the molecule draft before changing projects', {
        studioCode: chemsmartStudioErrorCodes.APPROVAL_REQUIRED
      })
    }
    const project = await this.projects.inspectProject(this.getProjectPath())
    if (project.activeRunId) {
      throw new JsonRpcFault(-32003, 'The active optimization must finish or be cancelled before changing projects', {
        studioCode: chemsmartStudioErrorCodes.RUN_ACTIVE
      })
    }
  }

  private async switchProject(
    project: ProjectBundleInfo,
    alreadyChecked = false
  ): Promise<ChemSmartStudioWorkspaceProjectResult> {
    if (!alreadyChecked) await this.assertProjectCanClose()
    if (project.activeRunId) {
      throw new JsonRpcFault(-32003, 'The selected project has an active optimization that must be recovered first', {
        studioCode: chemsmartStudioErrorCodes.RUN_ACTIVE
      })
    }
    const previous = await this.projects.inspectProject(this.getProjectPath())
    let sidecarRebound = false

    try {
      await application.get('ChemSmartAgentService').rebindProject(project.projectPath)
      sidecarRebound = true
      await this.projects.activateProject(project)
      this.documents.loadDocument(project.document)
      await this.documents.recoverDraft()
      const document = this.documents.getDocument()
      this.publishMoleculeSummary({ documentId: document.documentId, revision: document.revision })
      // Only a validated and sidecar-bound project earns a tab.
      this.rememberProject(project.projectPath)
      return {
        canceled: false,
        molecule: { documentId: document.documentId, revision: document.revision },
        documentName: projectDisplayName(project.projectPath)
      }
    } catch (error) {
      await this.projects.activateProject(previous)
      this.documents.loadDocument(previous.document)
      await this.documents.recoverDraft()
      this.publishMoleculeSummary({
        documentId: previous.document.documentId,
        revision: previous.document.revision
      })
      if (sidecarRebound) {
        try {
          await application.get('ChemSmartAgentService').rebindProject(previous.projectPath)
        } catch {
          throw new Error(
            'The selected project failed to open and the previous sidecar binding could not be restored',
            {
              cause: error
            }
          )
        }
      }
      throw error
    }
  }
}
