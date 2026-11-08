import {
  type MediaResolveMessage,
  mediaResolveMessage,
  mediaResolveMessageKey,
  parseMediaResolveMessage,
} from '@shared/errors'
import type {
  MediaPick,
  MediaPreview,
  MediaPreviewEntry,
  MediaPreviewVariant,
  ResolveMediaResult,
} from '@shared/schemas/media-resolution'
import { rejectionOffersPageAsFile } from '../task-create-failure'

/** An i18n key plus the values it interpolates. */
export interface MediaText {
  key: string
  values?: Record<string, string | number>
}

function toText(message: MediaResolveMessage): MediaText {
  return message.detail
    ? { key: message.key, values: { detail: message.detail } }
    : { key: message.key }
}

/** The localized explanation of an unavailable entry or resolution. */
export function unavailableText(reason: string, message?: string): MediaText {
  const composed = mediaResolveMessage('unavailable', reason, message)
  const parsed = parseMediaResolveMessage(composed)
  return parsed ? toText(parsed) : { key: composed }
}

type ResolveProblem = Extract<
  ResolveMediaResult,
  { status: 'unavailable' | 'failed' }
>

/** Why a resolve did not produce a preview, as text for the dialog. */
export function resolveProblemText(result: ResolveProblem): MediaText {
  return result.status === 'unavailable'
    ? unavailableText(result.reason, result.message)
    : { key: mediaResolveMessageKey(result.failure) }
}

/**
 * Whether "download the page as a file" makes sense after this outcome;
 * the same rule as for a rejected CreateTask, so never for DRM or encrypted
 * media.
 */
export function resolveProblemOffersPageAsFile(result: ResolveProblem) {
  return (
    result.status === 'failed' ||
    rejectionOffersPageAsFile(
      mediaResolveMessageKey('unavailable', result.reason)
    )
  )
}

/** An entry the user may pick: not marked unavailable by the resolver. */
export function isEntrySelectable(entry: MediaPreviewEntry): boolean {
  return entry.unavailable === undefined
}

/** The entries checked when the preview first opens: the pasted page's part. */
export function initialSelection(preview: MediaPreview): Set<string> {
  const entry =
    preview.entries.find((e) => e.id === preview.defaultEntryId) ??
    preview.entries.find((e) => e.current)
  return entry && isEntrySelectable(entry) ? new Set([entry.id]) : new Set()
}

export type QualityChoice =
  | { kind: 'best' }
  | { kind: 'variant'; variantId: string }
  | { kind: 'maxHeight'; height: number }

export type QualityBlock = 'login' | 'premium' | 'ffmpeg'

export interface QualityOption {
  value: string
  choice: QualityChoice
  /** The variant's own label (or height) without any suffix. */
  label: string
  /** Why the option can't be picked now, if it can't. */
  blocked?: QualityBlock
  recommended?: boolean
}

export interface QualityPlan {
  options: QualityOption[]
  /** The value preselected for this selection. */
  defaultValue: string
}

const BEST: QualityOption = {
  value: 'best',
  choice: { kind: 'best' },
  label: '',
}

function variantBlock(
  variant: MediaPreviewVariant,
  ffmpegAvailable: boolean
): QualityBlock | undefined {
  if (variant.locked) return variant.locked
  if (variant.requiresFfmpeg && !ffmpegAvailable) return 'ffmpeg'
  return undefined
}

/**
 * The quality choices for the picked entries. One entry with loaded
 * variants offers its exact variants; several entries share one ladder of
 * heights applied as `maxHeight`, so each part gets its best variant at or
 * below the choice. Entries whose variants are not loaded yet borrow the
 * heights of the preview's loaded entries, as parts of one collection
 * usually come in the same qualities.
 */
export function planQualities(
  preview: MediaPreview,
  selected: ReadonlySet<string>
): QualityPlan {
  const entries = preview.entries.filter((e) => selected.has(e.id))
  if (entries.length === 1 && entries[0].variants) {
    const options = entries[0].variants.map(
      (variant): QualityOption => ({
        value: `variant:${variant.id}`,
        choice: { kind: 'variant', variantId: variant.id },
        label: variant.label,
        blocked: variantBlock(variant, preview.ffmpegAvailable),
        recommended: variant.recommended,
      })
    )
    const preferred =
      options.find((o) => o.recommended && !o.blocked) ??
      options.find((o) => !o.blocked)
    if (!preferred) return { options: [BEST, ...options], defaultValue: 'best' }
    return { options, defaultValue: preferred.value }
  }
  const heights = new Map<number, string>()
  const ladderSources = entries.some((entry) => entry.variants === null)
    ? [...entries, ...preview.entries.filter((e) => e.variants !== null)]
    : entries
  for (const entry of ladderSources) {
    for (const variant of entry.variants ?? []) {
      if (variant.height === undefined) continue
      if (variantBlock(variant, preview.ffmpegAvailable)) continue
      if (!heights.has(variant.height))
        heights.set(variant.height, variant.label)
    }
  }
  const ladder = [...heights.entries()]
    .sort(([a], [b]) => b - a)
    .map(
      ([height, label]): QualityOption => ({
        value: `height:${height}`,
        choice: { kind: 'maxHeight', height },
        label,
      })
    )
  return { options: [BEST, ...ladder], defaultValue: 'best' }
}

/** Whether a variant of the given entries needs FFmpeg that is missing. */
export function needsFfmpegHint(
  preview: MediaPreview,
  selected: ReadonlySet<string>
): boolean {
  if (preview.ffmpegAvailable) return false
  return preview.entries.some(
    (entry) =>
      selected.has(entry.id) &&
      (entry.variants ?? []).some((v) => v.requiresFfmpeg && !v.locked)
  )
}

/** Whether a locked tier among the given entries would open by signing in. */
export function hasLockedVariants(
  preview: MediaPreview,
  selected: ReadonlySet<string>
): boolean {
  return preview.entries.some(
    (entry) =>
      selected.has(entry.id) &&
      (entry.variants ?? []).some((v) => v.locked !== undefined)
  )
}

/** The `mediaPick` of one picked entry. */
export function buildMediaPick(
  preview: MediaPreview,
  entryId: string,
  choice: QualityChoice,
  saveToFolder: boolean
): MediaPick {
  return {
    resolutionId: preview.resolutionId,
    entryId,
    ...(choice.kind === 'variant' ? { variantId: choice.variantId } : {}),
    ...(choice.kind === 'maxHeight' ? { maxHeight: choice.height } : {}),
    ...(saveToFolder ? { saveToFolder: true } : {}),
  }
}

/** "P3" or nothing, for an entry's position in the collection. */
export function entryPosition(
  preview: MediaPreview,
  entry: MediaPreviewEntry
): number | null {
  if (preview.entries.length < 2) return null
  return entry.index ?? preview.entries.indexOf(entry) + 1
}
