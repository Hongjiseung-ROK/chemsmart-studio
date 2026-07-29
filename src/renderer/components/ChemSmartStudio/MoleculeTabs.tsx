import { Button } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import type { ChemSmartStudioOpenDocuments } from '@shared/ipc/schemas/chemsmartStudio'
import { FileText, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface MoleculeTabsProps {
  /** True while a project switch is in flight; every tab is inert until it settles. */
  busy: boolean
  documents: ChemSmartStudioOpenDocuments | null
  onActivate: (projectId: string) => void
}

/**
 * The open-project strip above the stage.
 *
 * Studio holds one molecule authority, so a tab is a way to *reach* a project rather than a second
 * live document: selecting one switches the single active document. That keeps the stage, the
 * coordinate table and the inspector reading the same `MoleculeDocument` — the invariant the whole
 * editor rests on — while still letting the researcher move between the projects they have opened.
 *
 * Tabs are named by opaque handle: the renderer never learns where a project lives. Opening and
 * importing stay with the document section's own controls; this strip only switches.
 */
export function MoleculeTabs({ busy, documents, onActivate }: MoleculeTabsProps) {
  const { t } = useTranslation()

  return (
    <div
      aria-label={t('chemsmart_studio.tabs.label')}
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-border border-b px-2 py-1"
      data-testid="molecule-tabs"
      role="tablist">
      {documents?.documents.map((entry) => {
        const active = entry.projectId === documents.activeProjectId
        return (
          <Button
            aria-selected={active}
            className={cn('shrink-0 gap-1.5', active && 'font-medium')}
            data-testid={`molecule-tab-${entry.projectId}`}
            disabled={busy}
            key={entry.projectId}
            role="tab"
            size="sm"
            variant={active ? 'secondary' : 'ghost'}
            onClick={() => {
              if (!active) onActivate(entry.projectId)
            }}>
            {busy && active ? (
              <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <FileText aria-hidden className="size-3.5" />
            )}
            {entry.projectName}
          </Button>
        )
      })}
    </div>
  )
}
