import { useSortable } from '@dnd-kit/sortable'

import { ItemRenderer } from './item-renderer'
import type { RenderItemType } from './types'

interface SortableItemProps<T> {
  item: T
  getItemLabel?: (item: T) => string
  id: string | number
  index: number
  renderItem: RenderItemType<T>
  disabled?: boolean
  useDragOverlay?: boolean
  showGhost?: boolean
  itemStyle?: React.CSSProperties
  /** Route the drag activator to a handle (via renderItem's dragHandleProps) instead of the whole row. */
  dragHandle?: boolean
}

export function SortableItem<T>({
  item,
  getItemLabel,
  id,
  index,
  renderItem,
  disabled = false,
  useDragOverlay = true,
  showGhost = true,
  itemStyle,
  dragHandle = false
}: SortableItemProps<T>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled
  })

  const itemLabel = getItemLabel?.(item).trim()
  const labeledAttributes = itemLabel ? { ...attributes, 'aria-label': itemLabel } : attributes

  // Handle mode: keep the activator attributes/listeners off the row and hand them to
  // renderItem so a dedicated handle carries them; the row stays non-interactive.
  const dragHandleProps = dragHandle
    ? { ref: setActivatorNodeRef, attributes: labeledAttributes, listeners }
    : undefined

  return (
    <ItemRenderer
      ref={setNodeRef}
      item={item}
      index={index}
      renderItem={renderItem}
      dragging={isDragging}
      dragOverlay={!useDragOverlay && isDragging}
      ghost={showGhost && useDragOverlay && isDragging}
      transform={transform}
      transition={transition}
      listeners={dragHandle ? undefined : listeners}
      dragHandleProps={dragHandleProps}
      itemStyle={itemStyle}
      {...(dragHandle ? {} : labeledAttributes)}
    />
  )
}
