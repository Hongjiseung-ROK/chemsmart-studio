import { Badge, Button, Input, Popover, PopoverContent, PopoverTrigger, Scrollbar } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import { Atom } from 'lucide-react'
import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { elementPillClassName, elementSymbol, MAX_ATOMIC_NUMBER } from './elementSymbols'

const PERIODS: ReadonlyArray<ReadonlyArray<number | null>> = [
  [1, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 2],
  [3, 4, null, null, null, null, null, null, null, null, null, null, 5, 6, 7, 8, 9, 10],
  [11, 12, null, null, null, null, null, null, null, null, null, null, 13, 14, 15, 16, 17, 18],
  Array.from({ length: 18 }, (_, index) => 19 + index),
  Array.from({ length: 18 }, (_, index) => 37 + index),
  [55, 56, null, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86],
  [87, 88, null, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118]
]
const LANTHANIDES = Array.from({ length: 15 }, (_, index) => 57 + index)
const ACTINIDES = Array.from({ length: 15 }, (_, index) => 89 + index)

interface PeriodicTablePopoverProps {
  /** Element staged for insertion, kept visible so the researcher knows what a click will add. */
  atomicNumber: number
  disabled: boolean
  onSelect: (atomicNumber: number) => void
}

/**
 * Element selection for building. The common building elements come first, and the full element list is
 * searchable by symbol or atomic number so nothing is unreachable.
 */
export function PeriodicTablePopover({ atomicNumber, disabled, onSelect }: PeriodicTablePopoverProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const tableRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const all = Array.from({ length: MAX_ATOMIC_NUMBER }, (_, index) => index + 1)
    if (!normalized) return all
    return all.filter(
      (number) => String(number) === normalized || elementSymbol(number).toLowerCase().startsWith(normalized)
    )
  }, [query])
  const matchSet = useMemo(() => new Set(matches), [matches])

  const choose = (next: number) => {
    onSelect(next)
    setOpen(false)
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? 18
            : event.key === 'ArrowUp'
              ? -18
              : 0
    if (delta === 0) return
    const current = Number((event.target as HTMLElement).dataset.atomicNumber)
    const index = matches.indexOf(current)
    if (index < 0) return
    event.preventDefault()
    const next = matches[(index + delta + matches.length) % matches.length]
    tableRef.current?.querySelector<HTMLButtonElement>(`[data-atomic-number="${next}"]`)?.focus()
  }

  const elementButton = (number: number) => (
    <Button
      aria-label={`${elementSymbol(number)} ${number}`}
      aria-pressed={number === atomicNumber}
      className={cn('size-8 min-w-0 p-0 text-[11px]', !matchSet.has(number) && 'invisible')}
      data-atomic-number={number}
      disabled={!matchSet.has(number)}
      key={number}
      size="icon-sm"
      tabIndex={
        (number === atomicNumber && matchSet.has(atomicNumber)) ||
        (!matchSet.has(atomicNumber) && number === matches[0])
          ? 0
          : -1
      }
      variant={number === atomicNumber ? 'secondary' : 'outline'}
      onClick={() => choose(number)}>
      {elementSymbol(number)}
    </Button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button data-testid="element-picker" disabled={disabled} size="sm" variant="outline">
          <Atom aria-hidden className="size-3.5" />
          {t('chemsmart_studio.build.element')}
          <Badge className={cn('ml-1 px-1.5', elementPillClassName(atomicNumber))} variant="secondary">
            {elementSymbol(atomicNumber)}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(44rem,calc(100vw-2rem))] space-y-3 p-3">
        <Input
          aria-label={t('chemsmart_studio.build.search_element')}
          placeholder={t('chemsmart_studio.build.search_element')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Scrollbar className="max-h-[60vh]">
          <div
            ref={tableRef}
            aria-label={t('chemsmart_studio.build.elements')}
            className="min-w-[37rem] space-y-2"
            role="grid"
            onKeyDown={moveFocus}>
            <div className="grid grid-cols-18 gap-1">
              {PERIODS.flatMap((period, row) =>
                period.map((number, column) =>
                  number === null ? (
                    <span aria-hidden className="size-8" key={`${row}-${column}`} />
                  ) : (
                    elementButton(number)
                  )
                )
              )}
            </div>
            <div className="ml-16 flex gap-1">
              <span className="sr-only">{t('chemsmart_studio.build.lanthanides')}</span>
              {LANTHANIDES.map(elementButton)}
            </div>
            <div className="ml-16 flex gap-1">
              <span className="sr-only">{t('chemsmart_studio.build.actinides')}</span>
              {ACTINIDES.map(elementButton)}
            </div>
          </div>
        </Scrollbar>
      </PopoverContent>
    </Popover>
  )
}
