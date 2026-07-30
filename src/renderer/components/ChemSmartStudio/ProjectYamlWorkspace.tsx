import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { CircleCheck, CircleSlash, FileCode2, ShieldQuestion, TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

export type ProjectYamlProgram = 'gaussian' | 'orca'
export type ProjectYamlSource = 'explicit' | 'inherited'
export type ProjectYamlVerdict = 'ok' | 'warn' | 'reject'

export interface ProjectYamlFieldPresentation {
  id: string
  label: string
  value: string
  source: ProjectYamlSource
}

export interface ProjectYamlSectionPresentation {
  id: string
  label: string
  source: ProjectYamlSource
  fields: readonly ProjectYamlFieldPresentation[]
}

export interface ProjectYamlValidationIssuePresentation {
  ruleId: string
  severity: string
  message: string
}

export interface ProjectYamlUnknownNodePresentation {
  children?: readonly ProjectYamlUnknownNodePresentation[]
  id: string
  path: readonly string[]
  kind: 'mapping' | 'sequence' | 'scalar'
  value?: string
  source: ProjectYamlSource
}

function UnknownNodeRow({ node, depth = 0 }: { node: ProjectYamlUnknownNodePresentation; depth?: number }) {
  const { t } = useTranslation()
  return (
    <li className="py-2" data-depth={depth}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3" style={{ paddingInlineStart: `${depth * 12}px` }}>
        <div className="min-w-0">
          <code className="break-words font-mono text-foreground text-xs">{node.path.at(-1)}</code>
          {node.value === undefined ? null : (
            <code className="mt-0.5 block break-words font-mono text-foreground-secondary text-xs">{node.value}</code>
          )}
        </div>
        <div className="flex items-start gap-1.5">
          <Badge variant="secondary">{t(`chemsmart_studio.project.renderer.node_kind.${node.kind}`)}</Badge>
          <SourceBadge source={node.source} />
        </div>
      </div>
      {node.children && node.children.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {node.children.map((child) => (
            <UnknownNodeRow depth={depth + 1} key={child.id} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * Renderer-only projection of the v2 ProjectWorkspaceDocumentResult. Raw YAML remains authoritative;
 * this shape only determines how a validated document is presented.
 */
export interface ProjectYamlDocumentPresentation {
  projectName: string
  program: ProjectYamlProgram
  digest?: string
  rawText: string
  sections: readonly ProjectYamlSectionPresentation[]
  validation?: {
    verdict: ProjectYamlVerdict
    issues: readonly ProjectYamlValidationIssuePresentation[]
  }
  unknownNodes: readonly ProjectYamlUnknownNodePresentation[]
}

const verdictPresentation = {
  ok: { Icon: CircleCheck, className: 'text-success' },
  warn: { Icon: TriangleAlert, className: 'text-warning' },
  reject: { Icon: CircleSlash, className: 'text-destructive' }
} as const

function SourceBadge({ source }: { source: ProjectYamlSource }) {
  const { t } = useTranslation()

  return (
    <Badge className="shrink-0" variant="outline">
      {t(`chemsmart_studio.project.renderer.source.${source}`)}
    </Badge>
  )
}

function ValidationSummary({ validation }: { validation: NonNullable<ProjectYamlDocumentPresentation['validation']> }) {
  const { t } = useTranslation()
  const titleId = useId()
  const presentation = verdictPresentation[validation.verdict]
  const Icon = presentation?.Icon ?? ShieldQuestion

  return (
    <section
      aria-labelledby={titleId}
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="project-yaml-validation">
      <div className="flex items-center justify-between gap-3">
        <h3 id={titleId} className="font-medium text-foreground text-sm">
          {t('chemsmart_studio.project.renderer.validation')}
        </h3>
        <Badge className="gap-1.5" variant="outline">
          <Icon aria-hidden className={cn('size-3.5', presentation.className)} />
          {t(`chemsmart_studio.synthesis.verdict.${validation.verdict}`)}
        </Badge>
      </div>
      {validation.issues.length === 0 ? (
        <p className="text-foreground-secondary text-xs">{t('chemsmart_studio.project.renderer.validation_clear')}</p>
      ) : (
        <ul className="space-y-1.5">
          {validation.issues.map((issue) => (
            <li
              className={cn(
                'rounded-md border border-border-subtle px-2.5 py-2 text-xs',
                issue.severity === 'reject' && 'border-error-border bg-error-bg text-error-text'
              )}
              key={`${issue.ruleId}:${issue.message}`}>
              <span className="font-mono text-[11px] text-foreground-muted">{issue.ruleId}</span>
              <span className="mt-0.5 block leading-5">{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProjectSection({ section }: { section: ProjectYamlSectionPresentation }) {
  const { t } = useTranslation()
  const titleId = useId()

  return (
    <section
      aria-labelledby={titleId}
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="project-yaml-section">
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate font-medium text-foreground text-sm" id={titleId}>
          {section.label}
        </h3>
        <SourceBadge source={section.source} />
      </div>
      {section.fields.length === 0 ? (
        <p className="text-foreground-muted text-xs">{t('chemsmart_studio.project.renderer.section_empty')}</p>
      ) : (
        <dl className="divide-y divide-border-subtle">
          {section.fields.map((field) => (
            <div className="grid grid-cols-[minmax(7rem,0.8fr)_minmax(0,1.2fr)] gap-3 py-2" key={field.id}>
              <dt className="min-w-0 text-foreground-secondary text-xs">{field.label}</dt>
              <dd className="flex min-w-0 items-start justify-between gap-2 text-right">
                <code className="min-w-0 break-words font-mono text-foreground text-xs">{field.value}</code>
                <SourceBadge source={field.source} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function UnknownNodes({ nodes }: { nodes: readonly ProjectYamlUnknownNodePresentation[] }) {
  const { t } = useTranslation()
  const titleId = useId()
  if (nodes.length === 0) return null

  return (
    <section
      aria-labelledby={titleId}
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="project-yaml-unknown">
      <div>
        <h3 id={titleId} className="font-medium text-foreground text-sm">
          {t('chemsmart_studio.project.renderer.unrecognized')}
        </h3>
        <p className="text-foreground-muted text-xs">
          {t('chemsmart_studio.project.renderer.unrecognized_description')}
        </p>
      </div>
      <ul className="divide-y divide-border-subtle">
        {nodes.map((node) => (
          <UnknownNodeRow key={node.id} node={node} />
        ))}
      </ul>
    </section>
  )
}

/**
 * A lossless, read-only project view. It deliberately owns no editable state and exposes no write callback;
 * Project YAML review and approval can reuse the same projection without creating a second data authority.
 */
export function ProjectYamlWorkspace({ document }: { document: ProjectYamlDocumentPresentation }) {
  const { t } = useTranslation()
  const titleId = useId()

  return (
    <article aria-labelledby={titleId} className="space-y-3" data-testid="project-yaml-workspace">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileCode2 aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
            <h2 id={titleId} className="truncate font-semibold text-foreground text-sm">
              {document.projectName}
            </h2>
          </div>
          <p className="mt-1 text-foreground-muted text-xs">{t('chemsmart_studio.project.renderer.read_only')}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Badge variant="secondary">{document.program}</Badge>
          {document.digest ? (
            <Badge className="font-mono" title={document.digest} variant="outline">
              {t('chemsmart_studio.project.renderer.digest', { digest: document.digest.slice(0, 12) })}
            </Badge>
          ) : null}
        </div>
      </header>

      {document.validation ? <ValidationSummary validation={document.validation} /> : null}

      {document.sections.length === 0 ? (
        <p className="rounded-lg border border-border border-dashed px-3 py-5 text-center text-foreground-muted text-xs">
          {t('chemsmart_studio.project.renderer.structured_unavailable')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {document.sections.map((section) => (
            <ProjectSection key={section.id} section={section} />
          ))}
        </div>
      )}

      <UnknownNodes nodes={document.unknownNodes} />

      <Accordion className="rounded-lg border border-border px-3" collapsible type="single">
        <AccordionItem className="border-0" value="raw-yaml">
          <AccordionTrigger className="py-3 text-sm hover:no-underline">
            {t('chemsmart_studio.project.renderer.raw_yaml')}
          </AccordionTrigger>
          <AccordionContent className="pb-3">
            <pre
              className="max-h-80 overflow-auto whitespace-pre rounded-md bg-background-subtle p-3 font-mono text-foreground-secondary text-xs leading-5"
              data-testid="project-yaml-raw">
              {document.rawText}
            </pre>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </article>
  )
}
