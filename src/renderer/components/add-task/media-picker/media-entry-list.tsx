import { CheckIcon } from '@renderer/components/icons'
import { Badge } from '@renderer/components/ui/badge'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { formatDurationHMS } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type {
  MediaPreview,
  MediaPreviewEntry,
} from '@shared/schemas/media-resolution'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  entryPosition,
  isEntrySelectable,
  type MediaText,
  unavailableText,
} from './media-pick-plan'

export type EntryRowStatus =
  | { kind: 'created' }
  | { kind: 'failed'; message: string }

interface MediaEntryListProps {
  preview: MediaPreview
  selected: ReadonlySet<string>
  status: ReadonlyMap<string, EntryRowStatus>
  /** Parts found unavailable after the preview, with the reason. */
  blocked: ReadonlyMap<string, MediaText>
  disabled?: boolean
  onSelectionChange: (next: Set<string>) => void
}

function canPick(
  entry: MediaPreviewEntry,
  status: ReadonlyMap<string, EntryRowStatus>,
  blocked: ReadonlyMap<string, MediaText>
): boolean {
  return (
    isEntrySelectable(entry) &&
    !blocked.has(entry.id) &&
    status.get(entry.id)?.kind !== 'created'
  )
}

/**
 * The parts of a resolved page, each with a checkbox. Shift-click checks or
 * clears the range from the previously clicked row, as in the torrent file
 * list.
 */
export function MediaEntryList({
  preview,
  selected,
  status,
  blocked,
  disabled,
  onSelectionChange,
}: MediaEntryListProps) {
  const { t } = useTranslation()
  const anchor = useRef<number | null>(null)
  const shift = useRef(false)
  const pickable = preview.entries.filter((entry) =>
    canPick(entry, status, blocked)
  )
  const pickedCount = pickable.filter((entry) => selected.has(entry.id)).length
  const allPicked = pickable.length > 0 && pickedCount === pickable.length
  const translate = (text: MediaText) => t(text.key, text.values)

  const toggle = (index: number, checked: boolean) => {
    const next = new Set(selected)
    const from =
      shift.current && anchor.current !== null ? anchor.current : index
    const [start, end] = from <= index ? [from, index] : [index, from]
    for (const entry of preview.entries.slice(start, end + 1)) {
      if (!canPick(entry, status, blocked)) continue
      if (checked) next.add(entry.id)
      else next.delete(entry.id)
    }
    anchor.current = index
    shift.current = false
    onSelectionChange(next)
  }

  return (
    <div className="flex min-h-24 flex-1 flex-col overflow-hidden rounded-md border border-border">
      {preview.entries.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
          <Checkbox
            aria-label={t('task.add.media.picker.selectAll')}
            checked={allPicked}
            indeterminate={pickedCount > 0 && !allPicked}
            disabled={disabled || pickable.length === 0}
            onCheckedChange={(checked) =>
              onSelectionChange(
                new Set([
                  ...[...selected].filter(
                    (id) => !pickable.some((entry) => entry.id === id)
                  ),
                  ...(checked ? pickable.map((entry) => entry.id) : []),
                ])
              )
            }
          />
          <span className="font-medium">
            {t('task.add.media.picker.selectAll')}
          </span>
          <span className="ms-auto tabular-nums text-muted-foreground">
            {t('task.add.media.picker.selectedCount', {
              selected: pickedCount,
              total: pickable.length,
            })}
          </span>
        </div>
      )}
      <ul
        aria-label={t('task.add.media.picker.parts')}
        className="min-h-0 flex-1 overflow-auto"
      >
        {preview.entries.map((entry, index) => {
          const position = entryPosition(preview, entry)
          const rowStatus = status.get(entry.id)
          const pickableRow = canPick(entry, status, blocked)
          const unavailable = entry.unavailable
            ? unavailableText(
                entry.unavailable.reason,
                entry.unavailable.message
              )
            : blocked.get(entry.id)
          const name = position
            ? t('task.add.media.picker.partName', {
                index: position,
                title: entry.title,
              })
            : entry.title
          return (
            <li
              key={entry.id}
              data-entry-id={entry.id}
              className={cn(
                'flex items-start gap-2 border-b border-border/60 px-3 py-2 last:border-b-0',
                !pickableRow && 'text-muted-foreground'
              )}
            >
              <Checkbox
                aria-label={name}
                className="mt-0.5"
                checked={selected.has(entry.id) && pickableRow}
                disabled={disabled || !pickableRow}
                onClick={(event) => {
                  shift.current = event.shiftKey
                }}
                onCheckedChange={(checked) => toggle(index, checked)}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate" title={name}>
                    {name}
                  </span>
                  {entry.current && preview.entries.length > 1 && (
                    <Badge variant="secondary">
                      {t('task.add.media.picker.currentPage')}
                    </Badge>
                  )}
                  {entry.durationSec !== undefined && (
                    <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatDurationHMS(entry.durationSec)}
                    </span>
                  )}
                </div>
                {unavailable && (
                  <p className="text-xs text-muted-foreground">
                    {translate(unavailable)}
                  </p>
                )}
                {rowStatus?.kind === 'created' && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckIcon className="size-3" aria-hidden="true" />
                    {t('task.add.media.picker.rowCreated')}
                  </p>
                )}
                {rowStatus?.kind === 'failed' && (
                  <p className="text-xs text-destructive">
                    {rowStatus.message}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
