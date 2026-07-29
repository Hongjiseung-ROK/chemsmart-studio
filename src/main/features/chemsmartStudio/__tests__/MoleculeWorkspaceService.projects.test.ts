import { BaseService } from '@main/core/lifecycle'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appGet: vi.fn(),
  appGetPath: vi.fn(),
  activeProjectPath: '/projects/Untitled.cmsproj',
  agentImportMolecule: vi.fn(),
  agentRebindProject: vi.fn(),
  broadcast: vi.fn(),
  copyProject: vi.fn(),
  createProject: vi.fn(),
  dialogOpen: vi.fn(),
  dialogSave: vi.fn(),
  ensureDefaultProject: vi.fn(),
  inspectProject: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: mocks.appGet,
    getPath: mocks.appGetPath
  }
}))
vi.mock('@main/i18n', () => ({ t: (key: string) => key }))
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: mocks.dialogOpen,
    showSaveDialog: mocks.dialogSave
  }
}))
vi.mock('../projectFiles', () => ({
  projectDisplayName: (projectPath: string) =>
    projectPath
      .split('/')
      .at(-1)
      ?.replace(/\.cmsproj$/i, '') ?? '',
  // Same contract as the real digest — one stable opaque handle per path — but readable in failures.
  projectHandleId: (projectPath: string) => `project-${projectPath.replace(/[^A-Za-z0-9]/g, '-')}`
}))

const validDocument = {
  documentId: 'molecule-1',
  revision: 4,
  atoms: [],
  bonds: [],
  selections: [],
  frozenAxes: {},
  constraints: [],
  properties: { extensions: {} },
  extensions: {}
}

function projectBundle(projectPath: string, activeRunId: string | null = null) {
  return {
    projectPath,
    activeRunId,
    document: validDocument,
    manifest: {
      schemaVersion: '1.0.0' as const,
      protocolVersion: '1.0.0' as const,
      documentId: validDocument.documentId,
      currentRevision: validDocument.revision,
      activeRunId,
      extensions: {}
    }
  }
}

import { MoleculeDocumentService } from '../MoleculeDocumentService'
import { MoleculeWorkspaceService } from '../MoleculeWorkspaceService'

describe('MoleculeWorkspaceService project operations', () => {
  let documents: MoleculeDocumentService

  beforeEach(() => {
    vi.clearAllMocks()
    BaseService.resetInstances()
    documents = new MoleculeDocumentService()
    mocks.activeProjectPath = '/projects/Untitled.cmsproj'
    mocks.inspectProject.mockImplementation(async (candidate: string) => projectBundle(candidate))
    mocks.ensureDefaultProject.mockResolvedValue(projectBundle('/projects/Untitled.cmsproj'))
    mocks.agentImportMolecule.mockResolvedValue(validDocument)
    mocks.agentRebindProject.mockResolvedValue(undefined)
    mocks.createProject.mockImplementation(async (candidate: string) => projectBundle(candidate))
    mocks.copyProject.mockImplementation(async (_source: string, candidate: string) => projectBundle(candidate))
    mocks.appGet.mockImplementation((name: string) => {
      if (name === 'IpcApiService') return { broadcast: mocks.broadcast }
      if (name === 'MoleculeDocumentService') return documents
      if (name === 'ChemSmartAgentService') {
        return {
          importMoleculeFile: mocks.agentImportMolecule,
          rebindProject: mocks.agentRebindProject
        }
      }
      if (name === 'MoleculeProjectStore') {
        const complete = async (candidate: string) => {
          const result = await mocks.inspectProject(candidate)
          return {
            ...projectBundle((result as { projectPath?: string }).projectPath ?? candidate),
            ...result,
            document: (result as { document?: typeof validDocument }).document ?? validDocument,
            manifest:
              (result as { manifest?: ReturnType<typeof projectBundle>['manifest'] }).manifest ??
              projectBundle(candidate).manifest
          }
        }
        return {
          activateProject: (project: ReturnType<typeof projectBundle>) => {
            mocks.activeProjectPath = project.projectPath
          },
          copyProject: async (source: string, candidate: string) => {
            const result = await mocks.copyProject(source, candidate)
            return typeof result === 'string' ? projectBundle(result) : result
          },
          createProject: async (candidate: string, document: typeof validDocument) => {
            const result = await mocks.createProject(candidate, document)
            return typeof result === 'string' ? projectBundle(result) : result
          },
          ensureDefaultProject: mocks.ensureDefaultProject,
          getActiveProjectPath: () => mocks.activeProjectPath,
          inspectProject: complete,
          clearDraftJournal: vi.fn().mockResolvedValue(undefined),
          readDraftJournal: vi.fn().mockResolvedValue(null),
          writeDraftJournal: vi.fn().mockResolvedValue(undefined)
        }
      }
      throw new Error(`Unexpected application.get(${name})`)
    })
    mocks.appGetPath.mockImplementation((key: string, fileName?: string) => {
      if (key === 'feature.chemsmart_studio.projects') return `/projects/${fileName ?? ''}`.replace(/\/$/, '')
      throw new Error(`Unexpected application.getPath(${key})`)
    })
  })

  it('roots the explorer at the projects folder rather than the open bundle', async () => {
    const service = new MoleculeWorkspaceService()

    // The projects folder is auto-ensured by the registry; a `.cmsproj` package only exists once one
    // has been created. Rooting the tree at the folder is what keeps a fresh profile from scanning a
    // directory that is not there yet.
    expect(service.getWorkspaceRoots()).toEqual({
      projectsRoot: '/projects',
      activeProjectPath: '/projects/Untitled.cmsproj'
    })
  })

  it('accepts an add-atoms patch through the generated main-process boundary', async () => {
    const service = new MoleculeWorkspaceService()

    await expect(
      service.previewPatch({
        operationId: 'operation-human-add',
        baseRevision: 0,
        actor: 'human',
        previewOnly: true,
        operations: [
          {
            op: 'add_atoms',
            atoms: [
              {
                id: 'atom-human-add',
                atomicNumber: 6,
                position: [1.5, 0, 0],
                formalCharge: 0,
                extensions: {}
              }
            ]
          }
        ],
        extensions: {}
      })
    ).resolves.toMatchObject({
      operationId: 'operation-human-add',
      baseRevision: 0,
      affectedAtomIds: ['atom-human-add']
    })
  })

  it('reports the bundle the researcher opened as the active project', async () => {
    mocks.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ['/chosen/Ethanol.cmsproj'] })
    mocks.inspectProject.mockImplementation(async (candidate: string) => ({
      projectPath: candidate,
      activeRunId: null
    }))
    const service = new MoleculeWorkspaceService()

    await service.openProject()

    expect(service.getWorkspaceRoots().activeProjectPath).toBe('/chosen/Ethanol.cmsproj')
  })

  it('opens with a single tab for the project it started on', async () => {
    const service = new MoleculeWorkspaceService()

    const documents = service.listOpenDocuments()

    expect(documents.documents).toEqual([{ projectId: expect.any(String), projectName: 'Untitled' }])
    expect(documents.activeProjectId).toBe(documents.documents[0].projectId)
  })

  it('adds a tab for each project opened and keeps the active one marked', async () => {
    mocks.inspectProject.mockImplementation(async (candidate: string) => ({
      projectPath: candidate,
      activeRunId: null
    }))
    const service = new MoleculeWorkspaceService()
    const startingId = service.listOpenDocuments().activeProjectId

    mocks.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ['/chosen/Ethanol.cmsproj'] })
    await service.openProject()

    const documents = service.listOpenDocuments()
    expect(documents.documents.map((entry) => entry.projectName)).toEqual(['Untitled', 'Ethanol'])
    expect(documents.activeProjectId).not.toBe(startingId)
  })

  it('switches back to a project the researcher already opened', async () => {
    mocks.inspectProject.mockImplementation(async (candidate: string) => ({
      projectPath: candidate,
      activeRunId: null
    }))
    const service = new MoleculeWorkspaceService()
    const startingId = service.listOpenDocuments().activeProjectId

    mocks.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ['/chosen/Ethanol.cmsproj'] })
    await service.openProject()
    await expect(service.activateDocument(startingId)).resolves.toMatchObject({ canceled: false })

    expect(service.listOpenDocuments().activeProjectId).toBe(startingId)
    expect(service.getWorkspaceRoots().activeProjectPath).toBe('/projects/Untitled.cmsproj')
  })

  it('refuses a project handle this session never opened', async () => {
    const service = new MoleculeWorkspaceService()

    // The handle is a digest of a path, so guessing one must not become a way to reach a project.
    await expect(service.activateDocument('project-deadbeef')).rejects.toThrow(
      'That project is not open in this session'
    )
  })

  it('leaves the active project unchanged when it is reselected', async () => {
    const service = new MoleculeWorkspaceService()
    const startingId = service.listOpenDocuments().activeProjectId

    await expect(service.activateDocument(startingId)).resolves.toMatchObject({ canceled: false })

    expect(service.listOpenDocuments().activeProjectId).toBe(startingId)
  })

  it('opens a validated package and returns only its display name and molecule state', async () => {
    mocks.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ['/chosen/Ethanol.cmsproj'] })
    mocks.inspectProject.mockImplementation(async (candidate: string) => ({
      projectPath: candidate,
      activeRunId: null
    }))
    const service = new MoleculeWorkspaceService()

    await expect(service.openProject()).resolves.toEqual({
      canceled: false,
      molecule: { documentId: 'molecule-1', revision: 4 },
      documentName: 'Ethanol'
    })
    expect(mocks.agentRebindProject).toHaveBeenCalledWith('/chosen/Ethanol.cmsproj')
  })

  it('restores the previous project and sidecar binding when publication fails during a switch', async () => {
    mocks.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ['/chosen/Broken.cmsproj'] })
    mocks.broadcast.mockImplementationOnce(() => {
      throw new Error('simulated renderer publication failure')
    })
    const service = new MoleculeWorkspaceService()

    await expect(service.openProject()).rejects.toThrow('simulated renderer publication failure')

    expect(service.getWorkspaceRoots().activeProjectPath).toBe('/projects/Untitled.cmsproj')
    expect(mocks.agentRebindProject.mock.calls).toEqual([['/chosen/Broken.cmsproj'], ['/projects/Untitled.cmsproj']])
    expect(documents.getDocument()).toEqual(validDocument)
  })

  it('imports through the path-free Python capability', async () => {
    mocks.dialogOpen.mockResolvedValue({ canceled: false, filePaths: ['/chosen/ethanol.xyz'] })
    mocks.dialogSave.mockResolvedValue({ canceled: false, filePath: '/projects/Ethanol.cmsproj' })
    mocks.createProject.mockResolvedValue(projectBundle('/projects/Ethanol.cmsproj'))
    const service = new MoleculeWorkspaceService()

    await expect(service.importMolecule()).resolves.toMatchObject({
      canceled: false,
      documentName: 'Ethanol',
      molecule: { documentId: 'molecule-1', revision: 4 }
    })
    expect(mocks.agentImportMolecule).toHaveBeenCalledWith('/chosen/ethanol.xyz', expect.stringMatching(/^document-/))
    expect(mocks.createProject).toHaveBeenCalledWith('/projects/Ethanol.cmsproj', validDocument)
    expect(mocks.agentRebindProject).toHaveBeenCalledWith('/projects/Ethanol.cmsproj')
  })

  it('refuses Save As while a canonical run is active before copying any project data', async () => {
    mocks.inspectProject.mockResolvedValue({
      projectPath: '/projects/Untitled.cmsproj',
      activeRunId: 'run-1'
    })
    mocks.dialogSave.mockResolvedValue({ canceled: false, filePath: '/projects/Blocked.cmsproj' })
    const service = new MoleculeWorkspaceService()

    await expect(service.saveProjectAs()).rejects.toMatchObject({
      data: { studioCode: 'RUN_ACTIVE' }
    })
    expect(mocks.copyProject).not.toHaveBeenCalled()
  })
  it('creates the default project when a fresh profile has none', async () => {
    // The Qt helper used to create it as a side effect of --project; nothing else would.
    mocks.ensureDefaultProject.mockResolvedValue(projectBundle('/projects/Untitled.cmsproj'))
    const service = new MoleculeWorkspaceService()

    await expect(service.ensureDefaultProject()).resolves.toBe('/projects/Untitled.cmsproj')
    expect(mocks.ensureDefaultProject).toHaveBeenCalledWith(expect.objectContaining({ revision: 0 }))
  })

  it('leaves an existing project exactly as it is', async () => {
    mocks.ensureDefaultProject.mockResolvedValue(projectBundle('/projects/Untitled.cmsproj'))
    const service = new MoleculeWorkspaceService()

    await expect(service.ensureDefaultProject()).resolves.toBe('/projects/Untitled.cmsproj')
    expect(mocks.ensureDefaultProject).toHaveBeenCalledOnce()
  })

  it('does not mistake an unreadable project for an absent one', async () => {
    // EACCES means the package is there and we cannot read it. Creating over it would lose work.
    mocks.ensureDefaultProject.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const service = new MoleculeWorkspaceService()

    await expect(service.ensureDefaultProject()).rejects.toThrow('denied')
    expect(mocks.ensureDefaultProject).toHaveBeenCalledOnce()
  })
})
