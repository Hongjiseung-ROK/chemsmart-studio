import type * as CherryStudioUi from '@cherrystudio/ui'
import type { SerializedTreeNode } from '@shared/utils/file'
import { rootFromSerialized } from '@shared/utils/file'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The rail renders a real `FileTree`, so the UI barrel has to be the real one — the global renderer
// mock in tests/renderer.setup.ts does not carry `TreeView`.
vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof CherryStudioUi>())
vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />
}))
// `DynamicVirtualList` needs a sized scroll container that jsdom does not provide, so it would
// render zero rows. Standing it in with a plain list keeps `FileTree` and `TreeView` real.
vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: <T,>({
    list,
    children
  }: {
    list: readonly T[]
    children: (item: T, index: number) => ReactNode
  }) => <div data-testid="virtual-list">{list.map((item, index) => children(item, index))}</div>
}))

import { ResearchRail } from '../ResearchRail'

const ipcMocks = vi.hoisted(() => ({ request: vi.fn() }))
const loggerMocks = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }))
const treeMocks = vi.hoisted(() => ({
  state: {
    root: null as ReturnType<typeof rootFromSerialized> | null,
    isLoading: false,
    error: null as Error | null,
    version: 0,
    treeId: null as string | null,
    getNode: () => null
  },
  rootPaths: [] as (string | undefined)[]
}))

vi.mock('@logger', () => ({ loggerService: { withContext: () => loggerMocks } }))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: (route: string, ...args: unknown[]) => ipcMocks.request(route, ...args) }
}))
vi.mock('@renderer/hooks/useDirectoryTree', () => ({
  useDirectoryTree: (rootPath: string | undefined) => {
    treeMocks.rootPaths.push(rootPath)
    return treeMocks.state
  }
}))
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

const PROJECTS_ROOT = '/private/user/Projects'
const ACTIVE_PROJECT = `${PROJECTS_ROOT}/Ethanol.cmsproj`

function dir(path: string, children: SerializedTreeNode[] = []): SerializedTreeNode {
  return {
    kind: 'directory',
    path,
    basename: path.split('/').pop() ?? path,
    children: Object.fromEntries(children.map((child) => [child.basename, child]))
  }
}

function file(path: string): SerializedTreeNode {
  return { kind: 'file', path, basename: path.split('/').pop() ?? path }
}

/** Two `.cmsproj` bundles side by side, the first holding the package files a real project has. */
function twoProjects() {
  return rootFromSerialized(
    dir(PROJECTS_ROOT, [
      dir(ACTIVE_PROJECT, [
        file(`${ACTIVE_PROJECT}/manifest.json`),
        file(`${ACTIVE_PROJECT}/molecule.json`),
        dir(`${ACTIVE_PROJECT}/runs`)
      ]),
      dir(`${PROJECTS_ROOT}/Water dimer.cmsproj`, [file(`${PROJECTS_ROOT}/Water dimer.cmsproj/manifest.json`)])
    ])
  )
}

function renderRail(onOpenProjectYaml = vi.fn()) {
  return render(
    <ResearchRail actionsDisabled={false} busyAction={null} onAction={vi.fn()} onOpenProjectYaml={onOpenProjectYaml} />
  )
}

describe('ResearchRail project explorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    treeMocks.rootPaths.length = 0
    treeMocks.state = {
      root: null,
      isLoading: false,
      error: null,
      version: 0,
      treeId: null,
      getNode: () => null
    }
    ipcMocks.request.mockResolvedValue({ projectsRoot: PROJECTS_ROOT, activeProjectPath: ACTIVE_PROJECT })
  })

  it('opens the read-only project YAML workspace from the explorer header', async () => {
    const onOpenProjectYaml = vi.fn()
    renderRail(onOpenProjectYaml)

    await userEvent.click(screen.getByRole('button', { name: 'chemsmart_studio.project.open_renderer' }))

    expect(onOpenProjectYaml).toHaveBeenCalledOnce()
  })

  it('watches the projects folder, not the open bundle', async () => {
    treeMocks.state.root = twoProjects()
    renderRail()

    await waitFor(() => expect(treeMocks.rootPaths).toContain(PROJECTS_ROOT))
    expect(treeMocks.rootPaths).not.toContain(ACTIVE_PROJECT)
  })

  it('lists every project bundle and marks the open one', async () => {
    treeMocks.state.root = twoProjects()
    renderRail()

    expect(await screen.findByText('Ethanol.cmsproj')).toBeInTheDocument()
    expect(screen.getByText('Water dimer.cmsproj')).toBeInTheDocument()
    // The open bundle is the only one carrying the active-project affordance.
    expect(screen.getAllByLabelText('chemsmart_studio.workspace.active_project')).toHaveLength(1)
  })

  it('expands the open bundle so its package contents are reachable', async () => {
    treeMocks.state.root = twoProjects()
    renderRail()

    expect(await screen.findByText('manifest.json')).toBeInTheDocument()
    expect(screen.getByText('molecule.json')).toBeInTheDocument()
    expect(screen.getByText('runs')).toBeInTheDocument()
    // The other bundle stays collapsed, so its own manifest is not in the flattened list.
    expect(screen.getAllByText('manifest.json')).toHaveLength(1)
  })

  it('filters to matching names and keeps a matched folder whole', async () => {
    const user = userEvent.setup()
    treeMocks.state.root = twoProjects()
    renderRail()

    const search = await screen.findByPlaceholderText('chemsmart_studio.workspace.search_project_files')
    await user.type(search, 'molecule')

    expect(screen.getByText('molecule.json')).toBeInTheDocument()
    expect(screen.queryByText('manifest.json')).toBeNull()
    expect(screen.queryByText('Water dimer.cmsproj')).toBeNull()
  })

  it('shows an empty projects folder as empty, not as a failure', async () => {
    treeMocks.state.root = rootFromSerialized(dir(PROJECTS_ROOT))
    renderRail()

    expect(await screen.findByText('chemsmart_studio.workspace.no_projects')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a scan failure instead of rendering a silently empty tree', async () => {
    treeMocks.state.error = new Error('EACCES')
    renderRail()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('chemsmart_studio.workspace.project_tree_error')).toBeInTheDocument()
  })

  it('reports a failed roots request and logs it', async () => {
    ipcMocks.request.mockRejectedValue(new Error('FORBIDDEN_SENDER'))
    renderRail()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(loggerMocks.error).toHaveBeenCalled()
    // With no roots there is nothing to watch, so no directory tree is ever created.
    expect(treeMocks.rootPaths.every((path) => path === undefined)).toBe(true)
  })

  it('waits on the roots request before claiming the folder is empty', () => {
    ipcMocks.request.mockReturnValue(new Promise(() => {}))
    renderRail()

    expect(screen.getByRole('status')).toHaveTextContent('chemsmart_studio.workspace.loading_project_tree')
    expect(screen.queryByText('chemsmart_studio.workspace.no_projects')).toBeNull()
  })
})
