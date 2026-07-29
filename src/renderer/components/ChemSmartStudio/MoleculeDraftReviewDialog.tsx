import type { StudioDraftSnapshot } from '@chemsmart/studio-protocol'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Scrollbar
} from '@cherrystudio/ui'
import { useTranslation } from 'react-i18next'

export type MoleculeDraftReviewContext = 'close' | 'run' | 'save' | 'switch'

interface MoleculeDraftReviewDialogProps {
  busy: boolean
  context: MoleculeDraftReviewContext
  onApply: () => void
  onCancel: () => void
  onDiscard: () => void
  open: boolean
  snapshot: StudioDraftSnapshot | null
}

export function MoleculeDraftReviewDialog({
  busy,
  context,
  onApply,
  onCancel,
  onDiscard,
  open,
  snapshot
}: MoleculeDraftReviewDialogProps) {
  const { t } = useTranslation()
  const entries = snapshot?.entries.slice(0, snapshot.cursor) ?? []

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-lg" data-testid="molecule-draft-review">
        <DialogHeader>
          <DialogTitle>{t(`chemsmart_studio.draft.review.${context}.title`)}</DialogTitle>
          <DialogDescription>
            {t('chemsmart_studio.draft.review.description', {
              count: entries.length,
              revision: snapshot?.baseRevision ?? 0
            })}
          </DialogDescription>
        </DialogHeader>
        <Scrollbar className="max-h-72">
          <ol className="space-y-2 pr-2" aria-label={t('chemsmart_studio.draft.history')}>
            {entries.map((entry, index) => (
              <li className="rounded-md border border-border-subtle bg-background-subtle p-2.5" key={entry.entryId}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">
                    {t('chemsmart_studio.draft.history_entry', { index: index + 1 })}
                  </span>
                  <div className="flex items-center gap-1">
                    <Badge variant="outline">{t(`chemsmart_studio.draft.actor.${entry.actor}`)}</Badge>
                    <Badge variant="outline">{t(`chemsmart_studio.workspace.mode.${entry.mode}`)}</Badge>
                  </div>
                </div>
                <p className="mt-1 text-foreground-secondary text-xs">
                  {entry.summary.operationKinds
                    .map((kind) => t(`chemsmart_studio.approval.preview.operation.${kind}`))
                    .join(' · ')}
                </p>
                <p className="mt-1 text-foreground-muted text-xs">
                  {t('chemsmart_studio.draft.change_summary', {
                    atoms: entry.summary.affectedAtomIds.length,
                    bonds: entry.summary.affectedBondIds.length,
                    coordinates: entry.summary.coordinateChangeCount,
                    constraints: entry.summary.constraintChangeCount
                  })}
                </p>
              </li>
            ))}
          </ol>
        </Scrollbar>
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy} variant="outline" onClick={onDiscard}>
            {t(`chemsmart_studio.draft.review.${context}.discard`)}
          </Button>
          <Button loading={busy} onClick={onApply}>
            {t(`chemsmart_studio.draft.review.${context}.apply`)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
