import { MediaResolveError } from '@core/task/media-resolve-error'
import {
  MEDIA_PICK_WARN_ABOVE_PARTS,
  type MediaPreview,
  type MediaPreviewEntry,
  type MediaPreviewVariant,
} from '@shared/schemas/media-resolution'
import { planMediaFolderName } from './dispatch-variant'
import type { StoredResolution } from './resolution-store'
import { selectVariant, variantRequiresFfmpeg } from './select-variant'
import { isEntryDeferred, type MediaVariant } from './site-resolution'

/**
 * The renderer's view of a stored resolution. Built field by field from an
 * allowlist, so no stream URL, mirror or header can reach the renderer
 * whatever the resolver put in its result.
 */
export function toMediaPreview(
  record: StoredResolution,
  context: { pluginName: string; ffmpegAvailable: boolean }
): MediaPreview {
  const { media } = record
  const { resolution } = media
  const defaultEntry =
    resolution.entries.find((e) => e.current) ?? resolution.entries[0]
  const entries = resolution.entries.map((entry): MediaPreviewEntry => {
    let recommended: string | null = null
    if (!isEntryDeferred(entry) && !entry.unavailable) {
      try {
        const selection = selectVariant(
          media,
          { entryId: entry.id },
          context.ffmpegAvailable
        )
        if (selection.kind === 'ok') recommended = selection.variant.id
      } catch (error) {
        // Nothing in this entry can be downloaded now; none is recommended.
        if (!(error instanceof MediaResolveError)) throw error
      }
    }
    return {
      id: entry.id,
      ...(entry.index !== undefined ? { index: entry.index } : {}),
      title: entry.title,
      ...(entry.durationSec !== undefined
        ? { durationSec: entry.durationSec }
        : {}),
      current: entry.current === true,
      ...(entry.unavailable
        ? {
            unavailable: {
              reason: entry.unavailable.reason,
              ...(entry.unavailable.message
                ? { message: entry.unavailable.message }
                : {}),
            },
          }
        : {}),
      variants: isEntryDeferred(entry)
        ? null
        : (entry.variants ?? []).map((v) =>
            previewVariant(v, v.id === recommended)
          ),
    }
  })
  return {
    resolutionId: record.id,
    pluginId: media.pluginId,
    pluginName: context.pluginName,
    title: resolution.title,
    defaultEntryId: defaultEntry.id,
    ffmpegAvailable: context.ffmpegAvailable,
    expiresAt: record.expiresAt,
    ...(resolution.auth
      ? {
          auth: {
            state: resolution.auth.state,
            ...(resolution.auth.betterWithLogin !== undefined
              ? { betterWithLogin: resolution.auth.betterWithLogin }
              : {}),
          },
        }
      : {}),
    folderName: planMediaFolderName(media),
    warnAboveParts: MEDIA_PICK_WARN_ABOVE_PARTS,
    entries,
  }
}

function previewVariant(
  variant: MediaVariant,
  recommended: boolean
): MediaPreviewVariant {
  return {
    id: variant.id,
    label: variant.label,
    ...(variant.height !== undefined ? { height: variant.height } : {}),
    ...(variant.fps !== undefined ? { fps: variant.fps } : {}),
    ...(variant.videoCodec !== undefined
      ? { videoCodec: variant.videoCodec }
      : {}),
    ...(variant.audioCodec !== undefined
      ? { audioCodec: variant.audioCodec }
      : {}),
    container: variant.container,
    ...(variant.sizeBytes !== undefined
      ? { sizeBytes: variant.sizeBytes }
      : {}),
    ...(variant.locked ? { locked: variant.locked } : {}),
    requiresFfmpeg: variantRequiresFfmpeg(variant),
    recommended,
  }
}
