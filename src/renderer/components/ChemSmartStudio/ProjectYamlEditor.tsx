import { Alert, Badge, Button, Input, SegmentedControl, Textarea } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import type { ChemSmartStudioProjectProgram } from '@shared/ipc/schemas/chemsmartStudio'
import { CircleCheck, CircleSlash, ShieldQuestion, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type ProjectCheck, useProjectAuthoring } from './useHarnessWorkbench'

const authorablePrograms = ['gaussian', 'orca'] as const

const verdictPresentation = {
  ok: { Icon: CircleCheck, className: 'text-success' },
  warn: { Icon: TriangleAlert, className: 'text-warning' },
  reject: { Icon: CircleSlash, className: 'text-destructive' }
} as const

function CheckReport({ check, title }: { check: ProjectCheck; title: string }) {
  const { t } = useTranslation()
  const presentation = verdictPresentation[check.verdict as keyof typeof verdictPresentation]
  const Icon = presentation?.Icon ?? ShieldQuestion

  return (
    <div className="space-y-1.5 rounded-md border border-border-subtle p-2.5" data-testid="project-check">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground text-xs">{title}</span>
        <Badge className="gap-1.5" variant="outline">
          <Icon aria-hidden className={cn('size-3', presentation?.className ?? 'text-foreground-muted')} />
          {t(`chemsmart_studio.synthesis.verdict.${check.verdict}`, { defaultValue: check.verdict })}
        </Badge>
      </div>
      {check.issues.length > 0 ? (
        <ul className="space-y-1">
          {check.issues.map((issue) => (
            <li className="text-xs leading-5" key={`${issue.ruleId}:${issue.message}`}>
              <span className="font-mono text-[11px] text-foreground-muted">{issue.ruleId}</span>{' '}
              <span className={issue.severity === 'reject' ? 'text-destructive' : 'text-foreground-secondary'}>
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Inspects a Gaussian or ORCA method-project draft. Persistence remains unavailable until it can be
 * represented by a revision-bound trusted action rather than a direct renderer file-write route.
 */
export function ProjectYamlEditor() {
  const { t } = useTranslation()
  const [program, setProgram] = useState<ChemSmartStudioProjectProgram>('gaussian')
  const [project, setProject] = useState('')
  const [yaml, setYaml] = useState('')
  const { busy, check, criticise, critique, failed, reset, validate } = useProjectAuthoring(program)

  const hasYaml = yaml.trim().length > 0

  return (
    <section
      aria-labelledby="chemsmart-project-editor-title"
      className="space-y-2 rounded-md border border-border p-2.5"
      data-testid="project-yaml-editor">
      <h3 id="chemsmart-project-editor-title" className="font-medium text-foreground text-xs">
        {t('chemsmart_studio.project.author')}
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          options={authorablePrograms.map((option) => ({ label: option, value: option }))}
          size="sm"
          value={program}
          onValueChange={(value) => {
            setProgram(value)
            reset()
          }}
        />
        <label className="sr-only" htmlFor="chemsmart-project-name">
          {t('chemsmart_studio.project.name')}
        </label>
        <Input
          className="w-44 font-mono"
          id="chemsmart-project-name"
          maxLength={128}
          placeholder={t('chemsmart_studio.project.name')}
          value={project}
          onChange={(event) => {
            setProject(event.target.value)
            reset()
          }}
        />
      </div>

      <label className="sr-only" htmlFor="chemsmart-project-yaml">
        {t('chemsmart_studio.project.yaml_label')}
      </label>
      <Textarea.Input
        className="font-mono text-xs"
        id="chemsmart-project-yaml"
        maxLength={20_000}
        placeholder={t('chemsmart_studio.project.yaml_placeholder')}
        rows={6}
        spellCheck={false}
        value={yaml}
        onChange={(event) => {
          setYaml(event.target.value)
          reset()
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!hasYaml || busy}
          loading={busy}
          size="sm"
          variant="outline"
          onClick={() => void validate(project || 'candidate', yaml)}>
          {t('chemsmart_studio.project.validate')}
        </Button>
        <Button
          disabled={!hasYaml || busy}
          size="sm"
          variant="outline"
          onClick={() => void criticise(project || 'candidate', yaml)}>
          {t('chemsmart_studio.project.critique')}
        </Button>
      </div>

      {failed ? <Alert message={t('chemsmart_studio.project.failed')} role="alert" showIcon type="error" /> : null}
      {check ? <CheckReport check={check} title={t('chemsmart_studio.project.validation')} /> : null}
      {critique ? <CheckReport check={critique} title={t('chemsmart_studio.project.critique')} /> : null}
    </section>
  )
}
