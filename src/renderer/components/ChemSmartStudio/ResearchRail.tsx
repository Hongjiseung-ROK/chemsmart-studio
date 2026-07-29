import { Button, Tooltip } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { FileTree, type FileTreeNode } from '@renderer/components/FileTree'
import { useDirectoryTree } from '@renderer/hooks/useDirectoryTree'
import { ipcApi } from '@renderer/ipc'
import type { ChemSmartStudioWorkspaceRoots } from '@shared/ipc/schemas/chemsmartStudio'
import type { TreeDir, TreeDirRoot } from '@shared/utils/file'
import { FileInput, Folder, FolderOpen, LoaderCircle, Save, TriangleAlert } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('ResearchRail')

interface RailSectionProps {
  children: ReactNode
  className?: string
  icon: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>
  label: string
}

function RailSection({ children, className, icon: SectionIcon, label }: RailSectionProps) {
  return (
    <div className={className} role="group">
      <h3 className="flex items-center gap-2 px-3 py-2 font-medium text-sidebar-foreground text-xs">
        <SectionIcon aria-hidden className="size-3.5 shrink-0" />
        {label}
      </h3>
      {children}
    </div>
  )
}

/**
 * The tree mirror normalizes separators but keeps paths otherwise absolute, so a path that arrives
 * from main has to take the same treatment before it can be compared against a node id.
 */
function normalizeSeparators(candidate: string): string {
  return candidate.replace(/\\/g, '/')
}

function toFileNodes(dir: TreeDir | TreeDirRoot): FileTreeNode[] {
  const out: FileTreeNode[] = []
  for (const child of Object.values(dir.children)) {
    // The mirror already carries an absolute, normalized path on every node, and keeps it correct
    // through renames. Rebuilding it from the parent would desynchronize on the next rename event.
    const childPath = child.path
    if (child.isTreeDir()) {
      out.push({ id: childPath, name: child.basename, kind: 'folder', path: childPath, children: toFileNodes(child) })
    } else {
      out.push({ id: childPath, name: child.basename, kind: 'file', path: childPath })
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Keep nodes whose name matches; a folder that matches keeps all of its contents. */
function filterNodes(nodes: FileTreeNode[], lowered: string): FileTreeNode[] {
  const out: FileTreeNode[] = []
  for (const node of nodes) {
    const selfMatches = node.name.toLowerCase().includes(lowered)
    if (node.kind === 'file') {
      if (selfMatches) out.push(node)
      continue
    }
    if (selfMatches) {
      out.push(node)
      continue
    }
    const children = node.children ? filterNodes(node.children, lowered) : []
    if (children.length > 0) out.push({ ...node, children })
  }
  return out
}

interface ResearchRailProps {
  actionsDisabled: boolean
  busyAction: 'import_molecule' | 'open_project' | 'save_as' | null
  onAction: (action: 'import_molecule' | 'open_project' | 'save_as') => void
}

/**
 * Left research navigation. The projects section is a live, read-only view of the folder holding every
 * `.cmsproj` bundle, so the researcher can see and reach the other projects rather than only the open
 * one. Paths are shown here deliberately — this is a human surface, and agent-facing contracts stay
 * path-free. Project actions live in this human-only header rather than consuming space above the stage.
 */
export function ResearchRail({ actionsDisabled, busyAction, onAction }: ResearchRailProps) {
  const { t } = useTranslation()

  const [roots, setRoots] = useState<ChemSmartStudioWorkspaceRoots | null>(null)
  const [rootsFailed, setRootsFailed] = useState(false)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')

  useEffect(() => {
    let cancelled = false
    void ipcApi.request('chemsmart_studio.workspace.roots').then(
      (result) => {
        if (!cancelled) setRoots(result)
      },
      (error) => {
        if (cancelled) return
        logger.error('Failed to load ChemSmart Studio workspace roots', error as Error)
        setRootsFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const projectsRoot = roots?.projectsRoot
  const activeProjectPath = roots ? normalizeSeparators(roots.activeProjectPath) : null
  const { root, isLoading: treeLoading, error: treeError, version } = useDirectoryTree(projectsRoot)

  useEffect(() => {
    if (activeProjectPath) {
      setExpandedIds(new Set([activeProjectPath]))
      setSelectedId(activeProjectPath)
    }
  }, [activeProjectPath])

  // A live run appends to `runs/<runId>/events.ndjson` continuously, and every append is one watcher
  // event. Deferring the version collapses that burst into a single rebuild instead of one per write.
  const settledVersion = useDeferredValue(version)
  const treeNodes = useMemo(() => {
    void settledVersion
    return root ? toFileNodes(root) : []
  }, [root, settledVersion])

  const visibleNodes = useMemo(() => {
    const lowered = searchKeyword.trim().toLowerCase()
    if (!lowered) return treeNodes
    return filterNodes(treeNodes, lowered)
  }, [treeNodes, searchKeyword])

  const treeFailed = rootsFailed || treeError !== null
  const treeBusy = !rootsFailed && (roots === null || treeLoading)

  return (
    <nav
      aria-label={t('chemsmart_studio.workspace.project_navigation')}
      className="flex min-h-0 flex-1 flex-col gap-1 border-border border-r bg-sidebar px-2 py-3"
      data-testid="research-rail">
      <RailSection
        className="flex min-h-0 flex-1 flex-col"
        icon={FolderOpen}
        label={t('chemsmart_studio.workspace.projects')}>
        <div
          aria-label={t('chemsmart_studio.editor.actions')}
          className="mb-2 flex items-center gap-1 px-1"
          role="group">
          <Tooltip content={t('chemsmart_studio.editor.open_project')}>
            <Button
              aria-label={t('chemsmart_studio.editor.open_project')}
              className="size-8"
              disabled={actionsDisabled}
              loading={busyAction === 'open_project'}
              size="icon-sm"
              variant="ghost"
              onClick={() => onAction('open_project')}>
              <FolderOpen aria-hidden className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content={t('chemsmart_studio.editor.import_molecule')}>
            <Button
              aria-label={t('chemsmart_studio.editor.import_molecule')}
              className="size-8 text-foreground-muted hover:text-foreground"
              disabled={actionsDisabled}
              loading={busyAction === 'import_molecule'}
              size="icon-sm"
              variant="ghost"
              onClick={() => onAction('import_molecule')}>
              <FileInput aria-hidden className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content={t('chemsmart_studio.editor.save_as')}>
            <Button
              aria-label={t('chemsmart_studio.editor.save_as')}
              className="size-8 text-foreground-muted hover:text-foreground"
              disabled={actionsDisabled}
              loading={busyAction === 'save_as'}
              size="icon-sm"
              variant="ghost"
              onClick={() => onAction('save_as')}>
              <Save aria-hidden className="size-4" />
            </Button>
          </Tooltip>
        </div>
        {treeBusy ? (
          <div className="flex items-center gap-2 px-3 py-2 text-foreground-secondary text-sm" role="status">
            <LoaderCircle aria-hidden className="size-4 animate-spin text-info motion-reduce:animate-none" />
            <span>{t('chemsmart_studio.workspace.loading_project_tree')}</span>
          </div>
        ) : treeFailed ? (
          <div className="flex items-center gap-2 px-3 py-2 text-destructive text-sm" role="alert">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            <span>{t('chemsmart_studio.workspace.project_tree_error')}</span>
          </div>
        ) : (
          // `FileTree`'s virtualizer owns its own scroll container, so this must not add another one.
          // `isolation` keeps its sticky folder headers under the surrounding chrome.
          <div className="isolate flex min-h-0 flex-1 flex-col" data-testid="research-rail-projects">
            <FileTree
              emptyState={
                <p className="px-3 py-2 text-foreground-muted text-sm">{t('chemsmart_studio.workspace.no_projects')}</p>
              }
              expandedIds={expandedIds}
              folderIcon={(node) =>
                node.path === activeProjectPath ? (
                  <FolderOpen
                    aria-label={t('chemsmart_studio.workspace.active_project')}
                    className="size-4 text-primary"
                  />
                ) : (
                  <Folder aria-hidden className="size-4 text-muted-foreground" />
                )
              }
              nodes={visibleNodes}
              onExpandedChange={setExpandedIds}
              onSearchKeywordChange={setSearchKeyword}
              onSelectedChange={setSelectedId}
              searchClearLabel={t('common.clear')}
              searchKeyword={searchKeyword}
              searchPlaceholder={t('chemsmart_studio.workspace.search_project_files')}
              selectedId={selectedId}
              showSearch
            />
          </div>
        )}
      </RailSection>
    </nav>
  )
}
