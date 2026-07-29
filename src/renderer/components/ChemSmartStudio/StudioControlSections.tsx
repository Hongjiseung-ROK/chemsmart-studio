import type { StudioControlSnapshot, StudioPendingApproval, TrustedToolActivity } from '@chemsmart/studio-protocol'
import {
  Alert,
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider
} from '@cherrystudio/ui'
import type {
  ChemSmartStudioReplayCatalog,
  ChemSmartStudioReplaySelection,
  ChemSmartStudioReplayTimeline
} from '@shared/ipc/schemas/chemsmartStudio'
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Gauge,
  Pause,
  Play,
  ShieldCheck,
  ShieldQuestion,
  Square
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { elementSymbol } from './elementSymbols'

interface StudioControlSectionsProps {
  actionId: string | null
  actionsDisabled: boolean
  failed: boolean
  loading: boolean
  snapshot: StudioControlSnapshot | null
  replay: OptimizationReplayViewState
  onAction: (actionId: string) => void
  onReplayFrame: (stepIndex: number) => void
  onReplayPause: () => void
  onReplayPlay: () => void
  onReplayRetry: () => void
  onReplayRunChange: (runId: string) => void
  onReplayStop: () => void
  onRetry: () => void
}

export interface OptimizationReplayViewState {
  available: boolean
  busy: boolean
  catalog: ChemSmartStudioReplayCatalog | null
  failed: boolean
  loading: boolean
  playing: boolean
  selectedRunId: string | null
  selection: ChemSmartStudioReplaySelection | null
  timeline: ChemSmartStudioReplayTimeline | null
}

export function SummaryField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="break-words font-medium text-foreground">{value}</dd>
    </div>
  )
}

function summarizeIdentifiers(ids: readonly string[]): string {
  const visible = ids.slice(0, 6).join(', ')
  const remaining = ids.length - 6
  return remaining > 0 ? `${visible} +${remaining}` : visible
}

function ApprovalActions({
  actionId,
  disabled,
  approveActionId,
  approveLabel,
  denyActionId,
  denyLabel,
  onAction
}: {
  actionId: string | null
  disabled: boolean
  approveActionId: string
  approveLabel: string
  denyActionId: string
  denyLabel: string
  onAction: (nextActionId: string) => void
}) {
  const busy = actionId !== null || disabled

  return (
    <div className="-mx-3 -mb-3 sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-border border-t bg-card px-3 py-2">
      <Button
        disabled={busy}
        loading={actionId === denyActionId}
        size="sm"
        variant="outline"
        onClick={() => onAction(denyActionId)}>
        {denyLabel}
      </Button>
      <Button
        disabled={busy}
        loading={actionId === approveActionId}
        size="sm"
        onClick={() => onAction(approveActionId)}>
        {approveLabel}
      </Button>
    </div>
  )
}

function PreviewApprovalCard({
  actionId,
  disabled,
  approval,
  onAction
}: {
  actionId: string | null
  disabled: boolean
  approval: Extract<StudioPendingApproval, { kind: 'preview_commit' }>
  onAction: (nextActionId: string) => void
}) {
  const { t } = useTranslation()
  const { diff, summary } = approval.receipt
  const elementChanges =
    summary?.elementChanges
      .map((change) => {
        const before = change.beforeAtomicNumber === undefined ? null : elementSymbol(change.beforeAtomicNumber)
        const after = change.afterAtomicNumber === undefined ? null : elementSymbol(change.afterAtomicNumber)
        if (change.kind === 'added') return `${change.atomId}: +${after}`
        if (change.kind === 'removed') return `${change.atomId}: −${before}`
        return `${change.atomId}: ${before} → ${after}`
      })
      .join(', ') ?? ''

  return (
    <article className="space-y-3 rounded-lg border border-warning bg-card p-3" data-testid="preview-approval">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h4 className="font-medium text-foreground text-sm">{t('chemsmart_studio.approval.preview.title')}</h4>
          <p className="text-foreground-secondary text-xs leading-5">
            {t('chemsmart_studio.approval.preview.description')}
          </p>
        </div>
        <Badge variant="outline">{t('chemsmart_studio.approval.risk.molecule')}</Badge>
      </div>
      <p className="rounded-md bg-warning/10 px-2.5 py-2 font-medium text-foreground text-xs leading-5">
        {t('chemsmart_studio.approval.preview.not_displayed')}
      </p>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <SummaryField label={t('chemsmart_studio.approval.base_revision')} value={approval.receipt.baseRevision} />
        <SummaryField label={t('chemsmart_studio.approval.operation_count')} value={diff.operationCount ?? 0} />
        {summary ? (
          <>
            <SummaryField
              label={t('chemsmart_studio.approval.preview.operations')}
              value={summary.operationKinds
                .map((kind) => t(`chemsmart_studio.approval.preview.operation.${kind}`))
                .join(', ')}
            />
            <SummaryField
              label={t('chemsmart_studio.approval.preview.elements')}
              value={elementChanges || t('chemsmart_studio.approval.preview.none')}
            />
            <SummaryField
              label={t('chemsmart_studio.approval.preview.coordinates')}
              value={summary.coordinateChangeCount}
            />
            <SummaryField label={t('chemsmart_studio.approval.preview.bonds')} value={summary.bondChangeCount} />
            <SummaryField
              label={t('chemsmart_studio.approval.preview.constraints')}
              value={summary.constraintChangeCount}
            />
          </>
        ) : null}
        <SummaryField
          label={t('chemsmart_studio.approval.affected_atoms')}
          value={
            (summary?.affectedAtomIds ?? approval.receipt.affectedAtomIds).length === 0
              ? t('chemsmart_studio.document.unavailable')
              : summarizeIdentifiers(summary?.affectedAtomIds ?? approval.receipt.affectedAtomIds)
          }
        />
        <SummaryField
          label={t('chemsmart_studio.approval.affected_bonds')}
          value={
            (summary?.affectedBondIds ?? approval.receipt.affectedBondIds).length === 0
              ? t('chemsmart_studio.document.unavailable')
              : summarizeIdentifiers(summary?.affectedBondIds ?? approval.receipt.affectedBondIds)
          }
        />
        {summary && summary.affectedConstraintIds.length > 0 ? (
          <SummaryField
            label={t('chemsmart_studio.approval.preview.affected_constraints')}
            value={summarizeIdentifiers(summary.affectedConstraintIds)}
          />
        ) : null}
      </dl>
      <ApprovalActions
        actionId={actionId}
        disabled={disabled}
        approveActionId={approval.commitActionId}
        approveLabel={t('chemsmart_studio.approval.preview.commit')}
        denyActionId={approval.discardActionId}
        denyLabel={t('chemsmart_studio.approval.preview.discard')}
        onAction={onAction}
      />
    </article>
  )
}

function SettingsSummary({ settings }: { settings: CalculationApproval['settings'] }) {
  const { t } = useTranslation()
  const values: Array<[string, unknown]> = [
    ['chemsmart_studio.optimization.settings.max_steps', settings.maxSteps],
    ['chemsmart_studio.optimization.settings.force_threshold', settings.forceThreshold],
    ['chemsmart_studio.optimization.settings.charge', settings.charge],
    ['chemsmart_studio.optimization.settings.multiplicity', settings.multiplicity],
    ['chemsmart_studio.optimization.settings.solvent', settings.solvent]
  ]
  if ('maxRuntimeSeconds' in settings) {
    values.splice(1, 0, ['chemsmart_studio.optimization.settings.max_runtime_seconds', settings.maxRuntimeSeconds])
    values.splice(2, 0, ['chemsmart_studio.optimization.settings.threads', settings.threads])
  }
  const visible = values.filter(([, value]) => value !== undefined)

  if (visible.length === 0) {
    return <span className="text-foreground-muted">{t('chemsmart_studio.approval.calculation.default_settings')}</span>
  }

  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {visible.map(([translationKey, value]) => (
        <span key={translationKey}>
          {t(translationKey)}:{' '}
          {typeof value === 'object' && value && 'value' in value && 'unit' in value
            ? `${value.value} ${value.unit}`
            : String(value)}
        </span>
      ))}
    </span>
  )
}

type CalculationApproval = Extract<
  StudioPendingApproval,
  { kind: 'calculation_start' | 'controlled_calculation_start' }
>
export type ExecutionApproval = Extract<StudioPendingApproval, { kind: 'execution_tool' }>
export type HighRiskApproval = Exclude<StudioPendingApproval, { kind: 'preview_commit' }>

export function EngineName({ engine }: { engine: string }) {
  const { t } = useTranslation()

  return (
    <>
      {engine === 'avogadro'
        ? t('chemsmart_studio.optimization.engine_name.unsupported_legacy')
        : engine === 'xtb'
          ? t('chemsmart_studio.optimization.engine_name.xtb')
          : engine}
    </>
  )
}

function CalculationApprovalCard({
  actionId,
  approval,
  disabled,
  onAction
}: {
  actionId: string | null
  approval: CalculationApproval
  disabled: boolean
  onAction: (nextActionId: string) => void
}) {
  const { t } = useTranslation()

  return (
    <article className="space-y-3 rounded-lg border border-warning bg-card p-3" data-testid="calculation-approval">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h4 className="font-medium text-foreground text-sm">{t('chemsmart_studio.approval.calculation.title')}</h4>
          <p className="text-foreground-secondary text-xs leading-5">
            {t('chemsmart_studio.approval.calculation.description')}
          </p>
        </div>
        <Badge variant="outline">{t('chemsmart_studio.approval.risk.calculation')}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <SummaryField label={t('chemsmart_studio.approval.identity')} value={approval.approvalId} />
        <SummaryField
          label={t('chemsmart_studio.optimization.engine')}
          value={<EngineName engine={approval.engine} />}
        />
        <SummaryField label={t('chemsmart_studio.optimization.method')} value={approval.method} />
        <SummaryField label={t('chemsmart_studio.approval.expected_revision')} value={approval.expectedRevision} />
        <SummaryField
          label={t('chemsmart_studio.optimization.settings.title')}
          value={<SettingsSummary settings={approval.settings} />}
        />
      </dl>
      {approval.kind === 'controlled_calculation_start' ? (
        <details className="rounded-md border border-border-subtle px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">
            {t('chemsmart_studio.approval.technical_details')}
          </summary>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <SummaryField
              label={t('chemsmart_studio.approval.plan')}
              value={<code className="break-all text-[11px]">{approval.planId}</code>}
            />
            <SummaryField
              label={t('chemsmart_studio.approval.plan_digest')}
              value={<code className="break-all text-[11px]">{approval.planDigest}</code>}
            />
            <SummaryField
              label={t('chemsmart_studio.approval.runtime_fingerprint')}
              value={<code className="break-all text-[11px]">{approval.runtimeFingerprint}</code>}
            />
          </dl>
        </details>
      ) : null}
      <ApprovalActions
        actionId={actionId}
        disabled={disabled}
        approveActionId={approval.allowActionId}
        approveLabel={t('chemsmart_studio.approval.calculation.start')}
        denyActionId={approval.denyActionId}
        denyLabel={t('chemsmart_studio.approval.calculation.deny')}
        onAction={onAction}
      />
    </article>
  )
}

export function ExecutionApprovalSummary({ approval }: { approval: ExecutionApproval }) {
  const { t } = useTranslation()
  const booleanValue = (value: boolean) =>
    value ? t('chemsmart_studio.approval.execution.enabled') : t('chemsmart_studio.approval.execution.disabled')
  const toolLabel =
    approval.tool === 'run_local'
      ? t('chemsmart_studio.approval.execution.tools.run_local')
      : approval.tool === 'submit_hpc'
        ? t('chemsmart_studio.approval.execution.tools.submit_hpc')
        : t('chemsmart_studio.approval.execution.tools.execute_chemsmart_command')

  return (
    <dl className="grid grid-cols-2 gap-3 text-xs">
      <SummaryField label={t('chemsmart_studio.approval.identity')} value={approval.approvalId} />
      <SummaryField label={t('chemsmart_studio.approval.execution.tool')} value={toolLabel} />
      {'job' in approval.arguments ? (
        <SummaryField label={t('chemsmart_studio.approval.execution.job')} value={approval.arguments.job} />
      ) : null}
      {'server' in approval.arguments && approval.arguments.server ? (
        <SummaryField label={t('chemsmart_studio.approval.execution.server')} value={approval.arguments.server} />
      ) : null}
      {'execute' in approval.arguments && approval.arguments.execute !== undefined ? (
        <SummaryField
          label={t('chemsmart_studio.approval.execution.submit')}
          value={booleanValue(approval.arguments.execute)}
        />
      ) : null}
      {'command' in approval.arguments ? (
        <SummaryField
          label={t('chemsmart_studio.approval.execution.command')}
          value={<code className="break-all text-[11px]">{approval.arguments.command}</code>}
        />
      ) : null}
      {'test' in approval.arguments && approval.arguments.test !== undefined ? (
        <SummaryField
          label={t('chemsmart_studio.approval.execution.test')}
          value={booleanValue(approval.arguments.test)}
        />
      ) : null}
      {'timeout_s' in approval.arguments && approval.arguments.timeout_s !== undefined ? (
        <SummaryField label={t('chemsmart_studio.approval.execution.timeout')} value={approval.arguments.timeout_s} />
      ) : null}
    </dl>
  )
}

function ExecutionApprovalCard({
  actionId,
  approval,
  disabled,
  onAction
}: {
  actionId: string | null
  approval: ExecutionApproval
  disabled: boolean
  onAction: (nextActionId: string) => void
}) {
  const { t } = useTranslation()

  return (
    <article className="space-y-3 rounded-lg border border-warning bg-card p-3" data-testid="execution-approval">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h4 className="font-medium text-foreground text-sm">{t('chemsmart_studio.approval.execution.title')}</h4>
          <p className="text-foreground-secondary text-xs leading-5">
            {t('chemsmart_studio.approval.execution.description')}
          </p>
        </div>
        <Badge variant="outline">{t('chemsmart_studio.approval.risk.calculation')}</Badge>
      </div>
      <ExecutionApprovalSummary approval={approval} />
      <ApprovalActions
        actionId={actionId}
        disabled={disabled}
        approveActionId={approval.allowActionId}
        approveLabel={t('chemsmart_studio.approval.execution.approve')}
        denyActionId={approval.denyActionId}
        denyLabel={t('chemsmart_studio.approval.execution.deny')}
        onAction={onAction}
      />
    </article>
  )
}

function FinalGeometryDecision({
  actionId,
  disabled,
  finalGeometry,
  onAction
}: {
  actionId: string | null
  disabled: boolean
  finalGeometry: NonNullable<NonNullable<StudioControlSnapshot['optimization']>['finalGeometry']>
  onAction: (nextActionId: string) => void
}) {
  const { t } = useTranslation()

  return (
    <article className="space-y-3 rounded-lg border border-warning bg-card p-3" data-testid="final-geometry-control">
      <div className="flex items-start gap-2">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <h3 className="font-medium text-foreground text-sm">
            {t('chemsmart_studio.optimization.final_geometry.title')}
          </h3>
          <p className="text-foreground-secondary text-xs leading-5">
            {t('chemsmart_studio.optimization.final_geometry.description', {
              revision: finalGeometry.expectedRevision
            })}
          </p>
        </div>
      </div>
      <ApprovalActions
        actionId={actionId}
        disabled={disabled}
        approveActionId={finalGeometry.acceptActionId}
        approveLabel={t('chemsmart_studio.optimization.final_geometry.accept')}
        denyActionId={finalGeometry.rejectActionId}
        denyLabel={t('chemsmart_studio.optimization.final_geometry.reject')}
        onAction={onAction}
      />
    </article>
  )
}

const activityKindKeys = {
  intent_gate: 'chemsmart_studio.trusted_activity.kind.intent_gate',
  runtime: 'chemsmart_studio.trusted_activity.kind.runtime',
  semantic_gate: 'chemsmart_studio.trusted_activity.kind.semantic_gate',
  tool_call: 'chemsmart_studio.trusted_activity.kind.tool_call',
  tool_result: 'chemsmart_studio.trusted_activity.kind.tool_result'
} as const

const activityStatusKeys = {
  completed: 'chemsmart_studio.trusted_activity.status.completed',
  denied: 'chemsmart_studio.trusted_activity.status.denied',
  failed: 'chemsmart_studio.trusted_activity.status.failed',
  needs_user: 'chemsmart_studio.trusted_activity.status.needs_user',
  passed: 'chemsmart_studio.trusted_activity.status.passed',
  pending: 'chemsmart_studio.trusted_activity.status.pending'
} as const

function TrustedActivityItem({ item }: { item: TrustedToolActivity }) {
  const { t } = useTranslation()

  return (
    <li className="flex items-start gap-3 rounded-md border border-border-subtle p-3">
      <Activity aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-foreground text-xs">{t(activityKindKeys[item.kind])}</span>
          <Badge variant="secondary">{t(activityStatusKeys[item.status])}</Badge>
        </div>
      </div>
    </li>
  )
}

const optimizationStatusKeys = {
  awaiting_final_geometry: 'chemsmart_studio.optimization.status.awaiting_final_geometry',
  cancelled: 'chemsmart_studio.optimization.status.cancelled',
  completed: 'chemsmart_studio.optimization.status.completed',
  failed: 'chemsmart_studio.optimization.status.failed',
  pending_approval: 'chemsmart_studio.optimization.status.pending_approval',
  queued: 'chemsmart_studio.optimization.status.queued',
  running: 'chemsmart_studio.optimization.status.running'
} as const

function OptimizationSection({
  actionId,
  disabled,
  optimization,
  showFinalGeometry,
  onAction
}: {
  actionId: string | null
  disabled: boolean
  optimization: NonNullable<StudioControlSnapshot['optimization']>
  showFinalGeometry: boolean
  onAction: (nextActionId: string) => void
}) {
  const { t } = useTranslation()
  const { finalGeometry, latestFrame, run } = optimization
  const busy = actionId !== null || disabled

  return (
    <section aria-labelledby="chemsmart-studio-optimization-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3
          id="chemsmart-studio-optimization-title"
          className="flex items-center gap-2 font-medium text-foreground text-sm">
          <FlaskConical aria-hidden className="size-4 text-foreground-secondary" />
          {t('chemsmart_studio.optimization.title')}
        </h3>
        <Badge variant={run.status === 'failed' ? 'destructive' : 'secondary'}>
          {t(optimizationStatusKeys[run.status])}
        </Badge>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-3">
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <SummaryField label={t('chemsmart_studio.optimization.run')} value={run.runId} />
          <SummaryField label={t('chemsmart_studio.optimization.engine')} value={<EngineName engine={run.engine} />} />
          <SummaryField label={t('chemsmart_studio.optimization.method')} value={run.method} />
          <SummaryField label={t('chemsmart_studio.optimization.input_revision')} value={run.inputRevision} />
          <SummaryField label={t('chemsmart_studio.optimization.frames')} value={optimization.frameCount} />
        </dl>

        {run.status === 'failed' ? (
          <Alert message={t('chemsmart_studio.optimization.failed')} showIcon type="error" />
        ) : null}

        {run.status === 'running' && optimization.cancelActionId ? (
          <div className="flex justify-end">
            <Button
              disabled={busy}
              loading={actionId === optimization.cancelActionId}
              size="sm"
              variant="outline"
              onClick={() => onAction(optimization.cancelActionId!)}>
              {t('chemsmart_studio.optimization.cancel')}
            </Button>
          </div>
        ) : null}

        {latestFrame ? (
          <section
            aria-labelledby="chemsmart-studio-timeline-title"
            className="space-y-2 border-border-muted border-t pt-3">
            <h4
              id="chemsmart-studio-timeline-title"
              className="flex items-center gap-2 font-medium text-foreground text-xs">
              <Gauge aria-hidden className="size-4 text-info" />
              {t('chemsmart_studio.optimization.timeline')}
            </h4>
            <ol data-testid="optimization-timeline">
              <li className="rounded-md bg-background-subtle p-3">
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <SummaryField label={t('chemsmart_studio.optimization.step')} value={latestFrame.stepIndex} />
                  <SummaryField
                    label={t('chemsmart_studio.optimization.energy')}
                    value={`${latestFrame.energy.value} ${latestFrame.energy.unit}`}
                  />
                  {latestFrame.gradientNorm ? (
                    <SummaryField
                      label={t('chemsmart_studio.optimization.gradient_norm')}
                      value={`${latestFrame.gradientNorm.value} ${latestFrame.gradientNorm.unit}`}
                    />
                  ) : (
                    <SummaryField
                      label={t('chemsmart_studio.optimization.max_force')}
                      value={
                        latestFrame.forceMetrics?.max === undefined
                          ? t('chemsmart_studio.document.unavailable')
                          : `${latestFrame.forceMetrics.max} ${latestFrame.forceMetrics.unit}`
                      }
                    />
                  )}
                  <SummaryField
                    label={t('chemsmart_studio.optimization.convergence')}
                    value={
                      latestFrame.convergence === undefined
                        ? t('chemsmart_studio.document.unavailable')
                        : latestFrame.convergence.converged
                          ? t('chemsmart_studio.optimization.converged')
                          : t('chemsmart_studio.optimization.not_converged')
                    }
                  />
                </dl>
              </li>
            </ol>
          </section>
        ) : null}

        {showFinalGeometry && finalGeometry ? (
          <FinalGeometryDecision
            actionId={actionId}
            disabled={disabled}
            finalGeometry={finalGeometry}
            onAction={onAction}
          />
        ) : null}
      </div>
    </section>
  )
}

function OptimizationReplaySection({
  replay,
  onFrame,
  onPause,
  onPlay,
  onRetry,
  onRunChange,
  onStop
}: {
  replay: OptimizationReplayViewState
  onFrame: (stepIndex: number) => void
  onPause: () => void
  onPlay: () => void
  onRetry: () => void
  onRunChange: (runId: string) => void
  onStop: () => void
}) {
  const { t } = useTranslation()
  if (!replay.available) return null

  if (replay.loading && replay.catalog === null) {
    return (
      <div
        aria-busy="true"
        className="flex items-center justify-center gap-2 rounded-md border border-border border-dashed px-3 py-5 text-foreground-muted text-xs">
        <Gauge aria-hidden className="size-4 animate-pulse motion-reduce:animate-none" />
        {t('chemsmart_studio.optimization.playback.loading')}
      </div>
    )
  }

  if (replay.failed && replay.catalog === null) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        }
        message={t('chemsmart_studio.optimization.playback.error')}
        showIcon
        type="error"
      />
    )
  }

  const records = replay.catalog?.runs.filter((record) => record.replayable && record.frameCount > 0) ?? []
  const record = records.find((candidate) => candidate.run.runId === replay.selectedRunId) ?? null
  if (!record) {
    return (
      <div className="rounded-md border border-border border-dashed px-3 py-5 text-center text-foreground-muted text-xs">
        {t('chemsmart_studio.optimization.playback.empty')}
      </div>
    )
  }

  const selectedFrame =
    replay.selection?.runId === record.run.runId
      ? replay.selection.frame
      : replay.timeline?.runId === record.run.runId
        ? (replay.timeline.frames.at(0) ?? record.latestFrame)
        : record.latestFrame
  const selectedStep = selectedFrame?.stepIndex ?? 0
  const disabled = replay.busy || replay.loading
  const canMoveBack = selectedStep > 0
  const canMoveForward = selectedStep + 1 < record.frameCount

  return (
    <section aria-labelledby="chemsmart-studio-replay-title" className="space-y-2" data-testid="optimization-replay">
      <div className="flex items-center justify-between gap-3">
        <h3 id="chemsmart-studio-replay-title" className="flex items-center gap-2 font-medium text-foreground text-sm">
          <Gauge aria-hidden className="size-4 text-info" />
          {t('chemsmart_studio.optimization.playback.title')}
        </h3>
        <Badge variant="secondary">
          {replay.playing
            ? t('chemsmart_studio.optimization.playback.playing')
            : t('chemsmart_studio.optimization.playback.paused')}
        </Badge>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-3">
        {replay.failed ? (
          <Alert
            action={
              <Button size="sm" variant="outline" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            }
            message={t('chemsmart_studio.optimization.playback.refresh_failed')}
            showIcon
            type="warning"
          />
        ) : null}

        {records.length > 1 ? (
          <Select disabled={disabled} value={record.run.runId} onValueChange={onRunChange}>
            <SelectTrigger aria-label={t('chemsmart_studio.optimization.playback.run')} className="w-full" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {records.map((candidate) => (
                <SelectItem key={candidate.run.runId} value={candidate.run.runId}>
                  {candidate.run.runId} ·{' '}
                  {candidate.run.engine === 'avogadro'
                    ? t('chemsmart_studio.optimization.engine_name.unsupported_legacy')
                    : candidate.run.engine === 'xtb'
                      ? t('chemsmart_studio.optimization.engine_name.xtb')
                      : candidate.run.engine}{' '}
                  · {candidate.run.method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="truncate text-foreground-secondary">{record.run.runId}</span>
          <span className="shrink-0 font-medium text-foreground">
            {t('chemsmart_studio.optimization.playback.frame_position', {
              current: selectedStep + 1,
              total: record.frameCount
            })}
          </span>
        </div>

        <Slider
          aria-label={t('chemsmart_studio.optimization.playback.scrubber')}
          disabled={disabled || record.frameCount < 2}
          max={Math.max(0, record.frameCount - 1)}
          min={0}
          size="sm"
          step={1}
          value={[selectedStep]}
          onValueCommit={(values) => onFrame(values[0] ?? 0)}
        />

        {selectedFrame ? (
          <dl className="grid grid-cols-2 gap-3 rounded-md bg-background-subtle p-3 text-xs">
            <SummaryField
              label={t('chemsmart_studio.optimization.energy')}
              value={`${selectedFrame.energy.value} ${selectedFrame.energy.unit}`}
            />
            {selectedFrame.gradientNorm ? (
              <SummaryField
                label={t('chemsmart_studio.optimization.gradient_norm')}
                value={`${selectedFrame.gradientNorm.value} ${selectedFrame.gradientNorm.unit}`}
              />
            ) : (
              <SummaryField
                label={t('chemsmart_studio.optimization.max_force')}
                value={
                  selectedFrame.forceMetrics?.max === undefined
                    ? t('chemsmart_studio.document.unavailable')
                    : `${selectedFrame.forceMetrics.max} ${selectedFrame.forceMetrics.unit}`
                }
              />
            )}
          </dl>
        ) : null}

        <div
          className="flex items-center justify-center gap-1"
          role="group"
          aria-label={t('chemsmart_studio.optimization.playback.controls')}>
          <Button
            disabled={disabled || !canMoveBack}
            size="icon-sm"
            variant="ghost"
            onClick={() => onFrame(selectedStep - 1)}>
            <ChevronLeft aria-hidden className="size-4" />
            <span className="sr-only">{t('chemsmart_studio.optimization.playback.previous')}</span>
          </Button>
          {replay.playing ? (
            <Button disabled={disabled} size="icon-sm" variant="ghost" onClick={onPause}>
              <Pause aria-hidden className="size-4" />
              <span className="sr-only">{t('chemsmart_studio.optimization.playback.pause')}</span>
            </Button>
          ) : (
            <Button disabled={disabled || !canMoveForward} size="icon-sm" variant="ghost" onClick={onPlay}>
              <Play aria-hidden className="size-4" />
              <span className="sr-only">{t('chemsmart_studio.optimization.playback.play')}</span>
            </Button>
          )}
          <Button
            disabled={disabled || !canMoveForward}
            size="icon-sm"
            variant="ghost"
            onClick={() => onFrame(selectedStep + 1)}>
            <ChevronRight aria-hidden className="size-4" />
            <span className="sr-only">{t('chemsmart_studio.optimization.playback.next')}</span>
          </Button>
          {replay.selection?.viewing ? (
            <Button disabled={disabled} size="icon-sm" variant="ghost" onClick={onStop}>
              <Square aria-hidden className="size-3.5" />
              <span className="sr-only">{t('chemsmart_studio.optimization.playback.stop')}</span>
            </Button>
          ) : null}
        </div>
        <p aria-live="polite" className="sr-only" role="status">
          {replay.playing
            ? t('chemsmart_studio.optimization.playback.playing')
            : t('chemsmart_studio.optimization.playback.paused')}
        </p>
      </div>
    </section>
  )
}

/** Highest-risk decisions block execution behind an allow notice; the rest are reviewed in the inspector. */
export function isHighRiskApproval(approval: StudioPendingApproval): approval is HighRiskApproval {
  return approval.kind !== 'preview_commit'
}

export function StudioDecisionList({
  actionId,
  actionsDisabled,
  snapshot,
  onAction
}: Pick<StudioControlSectionsProps, 'actionId' | 'actionsDisabled' | 'snapshot' | 'onAction'>) {
  const { t } = useTranslation()
  const finalGeometry = snapshot?.optimization?.finalGeometry ?? null

  if (!snapshot || (snapshot.pendingApprovals.length === 0 && !finalGeometry)) {
    return (
      <p className="rounded-md border border-border border-dashed px-3 py-6 text-center text-foreground-muted text-sm leading-5">
        {t('chemsmart_studio.approval.empty')}
      </p>
    )
  }

  return (
    <div className="grid gap-2" data-testid="trusted-decision-list">
      {snapshot.pendingApprovals.map((approval) =>
        approval.kind === 'preview_commit' ? (
          <PreviewApprovalCard
            actionId={actionId}
            approval={approval}
            disabled={actionsDisabled}
            key={approval.approvalId}
            onAction={onAction}
          />
        ) : approval.kind === 'execution_tool' ? (
          <ExecutionApprovalCard
            actionId={actionId}
            approval={approval}
            disabled={actionsDisabled}
            key={approval.approvalId}
            onAction={onAction}
          />
        ) : (
          <CalculationApprovalCard
            actionId={actionId}
            approval={approval}
            disabled={actionsDisabled}
            key={approval.approvalId}
            onAction={onAction}
          />
        )
      )}
      {finalGeometry ? (
        <FinalGeometryDecision
          actionId={actionId}
          disabled={actionsDisabled}
          finalGeometry={finalGeometry}
          onAction={onAction}
        />
      ) : null}
    </div>
  )
}

/**
 * One quiet line of chrome: it states that decisions are waiting and routes to them. It never grows with
 * the number of decisions, so it cannot squeeze the molecule workspace the way the old banner did.
 */
export function StudioDecisionStrip({ count, onReview }: { count: number; onReview: () => void }) {
  const { t } = useTranslation()
  if (count === 0) return null

  return (
    <div
      className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-warning border-b bg-warning/5 px-4 py-1.5"
      data-testid="trusted-decision-strip"
      role="status">
      <p className="flex min-w-0 items-center gap-2 font-medium text-foreground text-sm">
        <ShieldQuestion aria-hidden className="size-4 shrink-0 text-warning" />
        <span className="truncate">{t('chemsmart_studio.approval.pending_count', { count })}</span>
      </p>
      <Button size="sm" variant="outline" onClick={onReview}>
        {t('chemsmart_studio.approval.review')}
      </Button>
    </div>
  )
}

export function StudioControlSections({
  actionId,
  actionsDisabled,
  failed,
  loading,
  snapshot,
  replay,
  onAction,
  onReplayFrame,
  onReplayPause,
  onReplayPlay,
  onReplayRetry,
  onReplayRunChange,
  onReplayStop,
  onRetry
}: StudioControlSectionsProps) {
  const { t } = useTranslation()

  if (loading && snapshot === null) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border border-border border-dashed px-3 py-6 text-foreground-muted text-xs">
        <Gauge aria-hidden className="size-4 animate-pulse motion-reduce:animate-none" />
        {t('chemsmart_studio.control.loading')}
      </div>
    )
  }

  if (failed && snapshot === null) {
    return (
      <Alert
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        }
        description={t('chemsmart_studio.control.error_description')}
        message={t('chemsmart_studio.control.error_title')}
        showIcon
        type="error"
      />
    )
  }

  if (!snapshot) return null

  const empty =
    snapshot.pendingApprovals.length === 0 && snapshot.activity.length === 0 && snapshot.optimization === null

  return (
    <div className="space-y-5">
      {failed ? (
        <Alert
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          }
          message={t('chemsmart_studio.control.refresh_failed')}
          showIcon
          type="warning"
        />
      ) : null}

      {actionId ? (
        <p aria-live="polite" className="sr-only" role="status">
          {t('chemsmart_studio.control.action_in_progress')}
        </p>
      ) : null}

      {snapshot.optimization ? (
        <OptimizationSection
          actionId={actionId}
          disabled={actionsDisabled}
          optimization={snapshot.optimization}
          showFinalGeometry={false}
          onAction={onAction}
        />
      ) : null}

      <OptimizationReplaySection
        replay={replay}
        onFrame={onReplayFrame}
        onPause={onReplayPause}
        onPlay={onReplayPlay}
        onRetry={onReplayRetry}
        onRunChange={onReplayRunChange}
        onStop={onReplayStop}
      />

      {snapshot.activity.length > 0 ? (
        <section aria-labelledby="chemsmart-studio-trusted-activity-title" className="space-y-2">
          <h3 id="chemsmart-studio-trusted-activity-title" className="font-medium text-foreground text-sm">
            {t('chemsmart_studio.trusted_activity.title')}
          </h3>
          <ol className="space-y-2" data-testid="trusted-activity">
            {snapshot.activity.map((item) => (
              <TrustedActivityItem item={item} key={item.activityId} />
            ))}
          </ol>
        </section>
      ) : null}

      {empty ? (
        <div className="flex items-start gap-2 rounded-md border border-border border-dashed px-3 py-5 text-foreground-muted text-xs leading-5">
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          {t('chemsmart_studio.control.empty')}
        </div>
      ) : null}
    </div>
  )
}
