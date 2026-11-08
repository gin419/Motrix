import { MediaResolveError } from '@core/task/media-resolve-error'
import type { ResolvedMedia } from './media-resolve-service'
import {
  isEntryDeferred,
  type MediaEntry,
  type MediaVariant,
} from './site-resolution'

export interface MediaPick {
  entryId?: string
  variantId?: string
  maxHeight?: number
}

export type VariantSelection =
  | { kind: 'ok'; entry: MediaEntry; variant: MediaVariant }
  /** The entry's variants were deferred; resolve again with this entry id. */
  | { kind: 'needs-entries'; entryId: string }

/** Whether a variant's source needs FFmpeg to become one output file. */
export function variantRequiresFfmpeg(variant: MediaVariant): boolean {
  return variant.source !== undefined && variant.source.kind !== 'direct'
}

/**
 * Default policy: the picked entry, else the `current` entry, else the
 * first. Within it, the picked variant, else the first (best-first) variant
 * that is not locked, fits `maxHeight` when given, and can run now — a
 * direct source always, mux/hls/dash only with FFmpeg.
 *
 * Throws MediaResolveError: `unavailable` for an unavailable entry,
 * `ffmpeg-required` when only FFmpeg-dependent variants were usable, and
 * `no-playable-variant` otherwise.
 */
export function selectVariant(
  media: ResolvedMedia,
  pick: MediaPick | undefined,
  ffmpegAvailable: boolean
): VariantSelection {
  const { pluginId, resolution } = media
  const entries = resolution.entries
  const entry = pick?.entryId
    ? entries.find((e) => e.id === pick.entryId)
    : (entries.find((e) => e.current) ?? entries[0])
  if (!entry) throw new MediaResolveError(pluginId, 'no-playable-variant')
  if (entry.unavailable) {
    throw new MediaResolveError(
      pluginId,
      'unavailable',
      undefined,
      entry.unavailable.reason
    )
  }
  if (isEntryDeferred(entry))
    return { kind: 'needs-entries', entryId: entry.id }

  const variants = entry.variants ?? []
  let skippedForFfmpeg = false
  const usable = (variant: MediaVariant): boolean => {
    if (variant.locked || !variant.source) return false
    if (variantRequiresFfmpeg(variant) && !ffmpegAvailable) {
      skippedForFfmpeg = true
      return false
    }
    return true
  }

  if (pick?.variantId) {
    const variant = variants.find((v) => v.id === pick.variantId)
    if (variant && usable(variant)) return { kind: 'ok', entry, variant }
  } else {
    const maxHeight = pick?.maxHeight
    const variant = variants.find(
      (v) =>
        (maxHeight === undefined ||
          v.height === undefined ||
          v.height <= maxHeight) &&
        usable(v)
    )
    if (variant) return { kind: 'ok', entry, variant }
  }
  throw new MediaResolveError(
    pluginId,
    skippedForFfmpeg ? 'ffmpeg-required' : 'no-playable-variant'
  )
}
