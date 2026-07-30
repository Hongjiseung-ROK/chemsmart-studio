import type {
  ProjectWorkspaceCandidateResult,
  ProjectWorkspaceDocumentResult,
  ProjectWorkspaceUnknownNode
} from '@chemsmart/studio-protocol'
import { Alert, Badge, Button, Scrollbar } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { FileWarning, FolderOpen, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type ProjectYamlDocumentPresentation,
  type ProjectYamlProgram,
  type ProjectYamlUnknownNodePresentation,
  ProjectYamlWorkspace
} from './ProjectYamlWorkspace'
import { useProjectWorkspace } from './useHarnessWorkbench'

const logger = loggerService.withContext('ProjectYamlPanel')

interface ProjectYamlPanelProps {
  /** Load automatically only when the local bridge is already running; direct actions remain available. */
  autoLoad: boolean
  initialSelection?: { program: ProjectYamlProgram; project: string } | null
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

function presentDocument(detail: ProjectWorkspaceDocumentResult): ProjectYamlDocumentPresentation {
  return {
    projectName: detail.projectName,
    program: detail.program as ProjectYamlProgram,
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
}

/**
 * The workspace's method projects. Gaussian and ORCA cannot run without one; xTB can. Projects are named,
 * never located: no filesystem path reaches this panel by contract.
 */
export function ProjectYamlPanel({ autoLoad, initialSelection = null }: ProjectYamlPanelProps) {
  const { t } = useTranslation()
  const { detail, failed, list, loading, read, refresh } = useProjectWorkspace(autoLoad)
  const [selected, setSelected] = useState<{ program: ProjectYamlProgram; project: string } | null>(null)
  useEffect(() => {
    if (!initialSelection) return
    setSelected(initialSelection)
    void read(initialSelection.project, initialSelection.program)
  }, [initialSelection, read])
  const selectedDocument: ProjectYamlDocumentPresentation | null =
    selected && detail && detail.projectName === selected.project && detail.program === selected.program
      ? presentDocument(detail)
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

export function ProjectYamlCandidateReview({
  sessionId,
  previewId,
  onStatusChange
}: {
  sessionId: string
  previewId: string
  onStatusChange?: (previewId: string, status: ProjectWorkspaceCandidateResult['candidate']['status']) => void
}) {
  const { t } = useTranslation()
  const [result, setResult] = useState<ProjectWorkspaceCandidateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setFailed(false)
    void ipcApi
      .request('chemsmart_studio.project.candidate', { sessionId, previewId, extensions: {} })
      .then((next) => {
        if (active) {
          setResult(next)
          onStatusChange?.(previewId, next.candidate.status)
        }
      })
      .catch((error) => {
        if (!active) return
        logger.error('Failed to load the Project YAML candidate', error as Error)
        setFailed(true)
      })
    return () => {
      active = false
    }
  }, [onStatusChange, previewId, sessionId])

  const decide = async (decision: 'allow_once' | 'deny') => {
    if (!result || busy || result.candidate.status !== 'pending') return
    setBusy(true)
    setFailed(false)
    try {
      const outcome = await ipcApi.request('chemsmart_studio.project.candidate_decide', {
        sessionId,
        previewId: result.candidate.previewId,
        baseDigest: result.candidate.baseDigest,
        candidateDigest: result.candidate.candidateDigest,
        expectedRevision: result.candidate.expectedRevision,
        decision,
        extensions: {}
      })
      setResult((current) =>
        current
          ? {
              ...current,
              candidate: { ...current.candidate, status: outcome.status }
            }
          : current
      )
      onStatusChange?.(previewId, outcome.status)
    } catch (error) {
      logger.error('Failed to decide the Project YAML candidate', error as Error)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (failed && !result) {
    return <Alert message={t('chemsmart_studio.project.candidate.load_failed')} role="alert" showIcon type="error" />
  }
  if (!result) {
    return <p className="text-foreground-muted text-sm">{t('common.loading')}</p>
  }

  const candidate = result.candidate
  return (
    <div className="space-y-3" data-testid="project-yaml-candidate-review">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-lg border border-border p-3 text-xs">
        <dt className="text-foreground-muted">{t('chemsmart_studio.project.candidate.program')}</dt>
        <dd className="text-foreground-secondary">{candidate.program.toUpperCase()}</dd>
        <dt className="text-foreground-muted">{t('chemsmart_studio.project.candidate.project')}</dt>
        <dd className="font-mono text-foreground-secondary">{candidate.projectName}</dd>
        <dt className="text-foreground-muted">{t('chemsmart_studio.project.candidate.changes')}</dt>
        <dd className="text-foreground-secondary">{candidate.changedSections.join(' · ') || '—'}</dd>
        <dt className="text-foreground-muted">{t('chemsmart_studio.project.candidate.digest')}</dt>
        <dd className="break-all font-mono text-foreground-secondary">{candidate.candidateDigest}</dd>
        <dt className="text-foreground-muted">{t('chemsmart_studio.project.candidate.status')}</dt>
        <dd>
          <Badge variant={candidate.status === 'failed' || candidate.status === 'stale' ? 'destructive' : 'outline'}>
            {t(`chemsmart_studio.project.candidate.statuses.${candidate.status}`)}
          </Badge>
        </dd>
      </dl>
      <ProjectYamlWorkspace document={presentDocument(result.document)} />
      {failed ? (
        <Alert message={t('chemsmart_studio.project.candidate.decision_failed')} role="alert" showIcon type="error" />
      ) : null}
      {candidate.status === 'pending' ? (
        <div className="flex justify-end gap-2 border-border border-t pt-3">
          <Button disabled={busy} variant="outline" onClick={() => void decide('deny')}>
            {t('chemsmart_studio.project.candidate.deny')}
          </Button>
          <Button loading={busy} onClick={() => void decide('allow_once')}>
            {t('chemsmart_studio.project.candidate.apply')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
