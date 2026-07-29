import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@cherrystudio/ui'
import { ShieldQuestion } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface AllowNoticeDialogProps {
  /** Action currently in flight, so both buttons stay busy until the decision lands. */
  actionId: string | null
  approveActionId: string
  approveLabel: string
  denyActionId: string
  denyLabel: string
  description: string
  /** Exact request summary: what would change, on which document and revision. */
  details: ReactNode
  /** Deterministic gates that already passed. Model confidence is not one of them. */
  gates: readonly string[]
  open: boolean
  requester: 'agent' | 'human'
  title: string
  onAction: (actionId: string) => void
  /** Dismiss without deciding — the request stays pending and reachable from the decision strip. */
  onDismiss: () => void
}

/**
 * A blocking notice for the highest-risk trusted actions: starting a real calculation or resolving a
 * final geometry. Denial is the default choice, dismissing decides nothing, and one approval authorises
 * exactly one action.
 */
export function AllowNoticeDialog({
  actionId,
  approveActionId,
  approveLabel,
  denyActionId,
  denyLabel,
  description,
  details,
  gates,
  open,
  requester,
  title,
  onAction,
  onDismiss
}: AllowNoticeDialogProps) {
  const { t } = useTranslation()
  const denyRef = useRef<HTMLButtonElement>(null)
  const busy = actionId !== null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent
        aria-modal
        className="gap-4"
        closeOnOverlayClick={false}
        data-testid="allow-notice"
        role="alertdialog"
        showCloseButton={false}
        size="lg"
        onOpenAutoFocus={(event) => {
          // Deny is the safe default, so focus never lands on the approving button.
          event.preventDefault()
          denyRef.current?.focus()
        }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestion aria-hidden className="size-4 shrink-0 text-warning" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Badge className="gap-1.5" variant="outline">
            {t(
              requester === 'agent'
                ? 'chemsmart_studio.approval.requested_by_agent'
                : 'chemsmart_studio.approval.requested_by_human'
            )}
          </Badge>
          {details}
          <div className="rounded-md border border-border-subtle bg-background-subtle p-3">
            <p className="font-medium text-foreground text-xs">{t('chemsmart_studio.approval.gates_passed')}</p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {gates.map((gate) => (
                <li key={gate}>
                  <Badge variant="secondary">{gate}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-foreground-secondary text-xs leading-5">
              {t('chemsmart_studio.approval.single_use_notice')}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} size="sm" variant="ghost" onClick={onDismiss}>
            {t('chemsmart_studio.approval.decide_later')}
          </Button>
          <Button
            disabled={busy}
            loading={actionId === denyActionId}
            ref={denyRef}
            size="sm"
            variant="outline"
            onClick={() => onAction(denyActionId)}>
            {denyLabel}
          </Button>
          <Button
            disabled={busy}
            loading={actionId === approveActionId}
            size="sm"
            variant="destructive"
            onClick={() => onAction(approveActionId)}>
            {approveLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
