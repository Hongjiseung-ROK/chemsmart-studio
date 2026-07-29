import { Alert, Badge, Button, Scrollbar } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import type { ChemSmartStudioProjectProgram } from '@shared/ipc/schemas/chemsmartStudio'
import { FileWarning, FolderOpen, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ProjectYamlEditor } from './ProjectYamlEditor'
import { useProjectWorkspace } from './useHarnessWorkbench'

interface ProjectYamlPanelProps {
  /** Load automatically only when the local bridge is already running; direct actions remain available. */
  autoLoad: boolean
}

/**
 * The workspace's method projects. Gaussian and ORCA cannot run without one; xTB can. Projects are named,
 * never located: no filesystem path reaches this panel by contract.
 */
export function ProjectYamlPanel({ autoLoad }: ProjectYamlPanelProps) {
  const { t } = useTranslation()
  const { detail, failed, list, loading, read, refresh } = useProjectWorkspace(autoLoad)
  const [selected, setSelected] = useState<{ program: ChemSmartStudioProjectProgram; project: string } | null>(null)

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
            <ProjectYamlEditor />
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

            {selected && detail ? (
              <div className="space-y-1.5 rounded-md border border-border p-2.5" data-testid="project-detail">
                <p className="font-medium text-foreground text-xs">
                  {t('chemsmart_studio.project.settings', { project: selected.project })}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-background-subtle p-2.5 font-mono text-foreground-secondary text-xs leading-5">
                  {detail.yamlText}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      </Scrollbar>
    </section>
  )
}
