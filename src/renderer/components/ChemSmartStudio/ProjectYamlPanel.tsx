import type { ProjectWorkspaceUnknownNode } from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Scrollbar } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { FileWarning, FolderOpen, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type ProjectYamlDocumentPresentation,
  type ProjectYamlProgram,
  type ProjectYamlUnknownNodePresentation,
  ProjectYamlWorkspace
} from './ProjectYamlWorkspace'
import { useProjectWorkspace } from './useHarnessWorkbench'

interface ProjectYamlPanelProps {
  /** Load automatically only when the local bridge is already running; direct actions remain available. */
  autoLoad: boolean
}

function displayYamlScalar(value: boolean | number | string | null): string {
  if (value === null) return 'null'
  return String(value)
}

function presentUnknownNode(node: ProjectWorkspaceUnknownNode): ProjectYamlUnknownNodePresentation {
  return {
    children: node.children.map(presentUnknownNode),
    id: node.id,
    kind: node.kind,
    path: node.path,
    source: node.source,
    value: node.kind === 'scalar' ? displayYamlScalar(node.value) : undefined
  }
}

/**
 * The workspace's method projects. Gaussian and ORCA cannot run without one; xTB can. Projects are named,
 * never located: no filesystem path reaches this panel by contract.
 */
export function ProjectYamlPanel({ autoLoad }: ProjectYamlPanelProps) {
  const { t } = useTranslation()
  const { detail, failed, list, loading, read, refresh } = useProjectWorkspace(autoLoad)
  const [selected, setSelected] = useState<{ program: ProjectYamlProgram; project: string } | null>(null)
  const selectedDocument: ProjectYamlDocumentPresentation | null =
    selected && detail && detail.projectName === selected.project && detail.program === selected.program
      ? {
          projectName: detail.projectName,
          program: selected.program,
          digest: detail.digest,
          rawText: detail.yamlText,
          sections: detail.sections.map((section) => ({
            fields: section.fields.map((field) => ({
              id: field.id,
              label: field.label,
              source: field.source,
              value: displayYamlScalar(field.value)
            })),
            id: section.id,
            label: section.label,
            source: section.source
          })),
          unknownNodes: detail.unknownNodes.map(presentUnknownNode),
          validation: {
            issues: detail.validation.issues.map((issue) => ({
              message: issue.message,
              ruleId: issue.ruleId,
              severity: issue.severity
            })),
            verdict: detail.validation.verdict
          }
        }
      : null

  return (
    <section
      aria-labelledby="chemsmart-project-yaml-title"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-3"
      data-testid="project-yaml-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="chemsmart-project-yaml-title" className="font-semibold text-foreground text-sm">
            {t('chemsmart_studio.project.title')}
          </h2>
          <p className="truncate text-foreground-muted text-xs">{t('chemsmart_studio.project.description')}</p>
        </div>
        <Button loading={loading} size="sm" variant="outline" onClick={() => void refresh()}>
          <RotateCcw aria-hidden className="size-3.5" />
          {t('common.refresh')}
        </Button>
      </div>

      <Scrollbar className="min-h-0">
        {failed ? (
          <Alert message={t('chemsmart_studio.project.failed')} role="alert" showIcon type="error" />
        ) : (
          <div className="space-y-3">
            {(list?.programs ?? []).map((entry) => (
              <div className="space-y-1.5" key={entry.program}>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground text-xs uppercase">{entry.program}</span>
                  <Badge variant={entry.projectRequired ? 'secondary' : 'outline'}>
                    {t(
                      entry.projectRequired
                        ? 'chemsmart_studio.project.required'
                        : 'chemsmart_studio.project.not_required'
                    )}
                  </Badge>
                </div>
                {entry.projectNames.length === 0 ? (
                  <p className="flex items-center gap-1.5 text-foreground-muted text-xs">
                    {entry.projectRequired ? <FileWarning aria-hidden className="size-3.5 text-warning" /> : null}
                    {t(
                      entry.projectRequired
                        ? 'chemsmart_studio.project.none_but_required'
                        : 'chemsmart_studio.project.none_needed'
                    )}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {entry.projectNames.map((project) => (
                      <li key={`${entry.program}:${project}`}>
                        <Button
                          className={cn(
                            'font-mono',
                            selected?.project === project && selected.program === entry.program && 'border-primary'
                          )}
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (entry.program === 'xtb') return
                            setSelected({ program: entry.program, project })
                            void read(project, entry.program)
                          }}>
                          <FolderOpen aria-hidden className="size-3.5" />
                          {project}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            {selectedDocument ? <ProjectYamlWorkspace document={selectedDocument} /> : null}
          </div>
        )}
      </Scrollbar>
    </section>
  )
}
