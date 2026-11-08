import { MediaResolveError } from '@core/task/media-resolve-error'
import {
  type MediaResolveService,
  mergeResolvedEntries,
  type ResolvedMedia,
} from './media-resolve-service'
import { selectVariant } from './select-variant'
import type { MediaEntry, MediaVariant } from './site-resolution'

export interface ResolvedMediaVariant {
  media: ResolvedMedia
  entry: MediaEntry
  variant: MediaVariant
}

export interface ResolveMediaVariantOptions {
  /** Forwarded to the resolver only; never placed on stream requests. */
  cookieHeader?: string
  /**
   * Asked only once a resolver has answered, so a URL no resolver claims
   * never probes for FFmpeg.
   */
  isFfmpegAvailable: () => Promise<boolean>
}

/**
 * Resolve `url` and pick the variant a non-interactive create downloads: the
 * default entry (fetched once more if its variants were deferred) and its
 * best variant that can run now — so without FFmpeg a direct variant wins.
 *
 * Returns null when no resolver claims the URL. Throws MediaResolveError
 * when a resolver claimed it and failed, reported it unavailable, or offered
 * nothing this host can download.
 */
export async function resolveMediaVariant(
  service: MediaResolveService,
  url: string,
  options: ResolveMediaVariantOptions
): Promise<ResolvedMediaVariant | null> {
  const resolveOptions = options.cookieHeader
    ? { cookieHeader: options.cookieHeader }
    : {}
  const outcome = await service.resolve(url, resolveOptions)
  if (outcome.kind === 'declined') return null
  if (outcome.kind === 'unavailable') {
    throw new MediaResolveError(
      outcome.pluginId,
      'unavailable',
      undefined,
      outcome.reason
    )
  }

  let media = outcome.media
  const ffmpegAvailable = await options.isFfmpegAvailable()
  let selection = selectVariant(media, undefined, ffmpegAvailable)
  if (selection.kind === 'needs-entries') {
    const followUp = await service.resolve(url, {
      ...resolveOptions,
      entryIds: [selection.entryId],
      pluginId: media.pluginId,
    })
    if (followUp.kind === 'unavailable') {
      throw new MediaResolveError(
        media.pluginId,
        'unavailable',
        undefined,
        followUp.reason
      )
    }
    if (followUp.kind === 'declined') {
      throw new MediaResolveError(media.pluginId, 'invalid-result')
    }
    media = mergeResolvedEntries(media, followUp.media)
    selection = selectVariant(media, undefined, ffmpegAvailable)
    if (selection.kind === 'needs-entries') {
      throw new MediaResolveError(media.pluginId, 'invalid-result')
    }
  }
  return { media, entry: selection.entry, variant: selection.variant }
}
