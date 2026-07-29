import { Button } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { compactStudioRelativeLayout, isBottomPane, type StudioPaneId } from './studioLayout'

interface StudioPaneSheetProps {
  children: ReactNode
  onOpenChange: (open: boolean) => void
  open: boolean
  pane: StudioPaneId
}

/**
 * A workspace-relative Sheet rather than a window-modal dialog. The title-bar Agent and Console toggles
 * remain directly operable, while Tab is contained once focus enters the Sheet.
 */
export function StudioPaneSheet({ children, onOpenChange, open, pane }: StudioPaneSheetProps) {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)
  const bottom = isBottomPane(pane)
  const titleId = `studio-pane-sheet-${pane}-title`

  if (!open) return null

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="absolute inset-0 z-40" data-testid="studio-pane-sheet-layer">
      <button
        aria-hidden
        className="absolute inset-0 cursor-default bg-black/35"
        tabIndex={-1}
        type="button"
        onClick={() => onOpenChange(false)}
      />
      <div
        aria-labelledby={titleId}
        aria-modal="false"
        className={cn(
          'absolute flex min-h-0 flex-col border-border bg-background shadow-xl',
          'transition-[width,height,transform] duration-[160ms] ease-out motion-reduce:transition-none',
          bottom ? 'inset-x-0 bottom-0 border-t' : 'inset-y-0 right-0 border-l'
        )}
        data-pane={pane}
        data-testid="studio-pane-sheet"
        ref={contentRef}
        role="dialog"
        style={
          bottom
            ? { height: `${compactStudioRelativeLayout.bottom * 100}%` }
            : { width: `${compactStudioRelativeLayout.inspector * 100}%` }
        }
        onKeyDown={trapFocus}>
        <header className="flex shrink-0 items-center justify-between border-border border-b px-3 py-2">
          <h2 className="font-semibold text-foreground" id={titleId}>
            {t(`chemsmart_studio.ide.pane.${pane}`)}
          </h2>
          <Button
            aria-label={t('common.close')}
            className="size-8 text-foreground-muted hover:text-foreground"
            size="icon-sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}>
            <X aria-hidden className="size-4" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
