import { MediaResolveError } from '@core/task/media-resolve-error'
import type { MediaPick } from '@shared/schemas/media-resolution'
import {
  type MediaResolveService,
  mergeResolvedEntries,
  type ResolvedMedia,
} from './media-resolve-service'
import type { MediaResolutionStore } from './resolution-store'
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
      outcome.reason,
      outcome.message
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
        followUp.reason,
        followUp.message
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

export interface ResolvePickedMediaVariantOptions {
  isFfmpegAvailable: () => Promise<boolean>
  /** Previewed resolutions; without it every pick resolves the page again. */
  store?: Pick<MediaResolutionStore, 'get' | 'refresh' | 'replace'>
}

/**
 * The variant a media picker pick names. The preview's stored resolution
 * is reused while it is fresh, describes this page and its resolver is
 * still enabled; otherwise the page is resolved again (by the same
 * resolver, when known) and the pick is matched by its stable ids.
 *
 * Never returns null: a pick never degrades to downloading the page. Throws
 * MediaResolveError — `variant-gone` when the picked entry or variant is no
 * longer offered, and the usual failures otherwise.
 */
export async function resolvePickedMediaVariant(
  service: MediaResolveService,
  url: string,
  pick: MediaPick,
  options: ResolvePickedMediaVariantOptions
): Promise<ResolvedMediaVariant> {
  const { resolutionId } = pick
  const store = options.store
  const stored = resolutionId ? store?.get(resolutionId) : null
  const pinnedPluginId = stored?.media.pluginId
  let media =
    stored?.media.sourceUrl === url &&
    service.eligibleResolver(url, stored.media.pluginId)
      ? stored.media
      : null
  if (!media) {
    const load = async (): Promise<ResolvedMedia> => {
      const outcome = await service.resolve(
        url,
        pinnedPluginId ? { pluginId: pinnedPluginId } : {}
      )
      if (outcome.kind === 'declined') {
        throw new MediaResolveError(pinnedPluginId ?? '', 'variant-gone')
      }
      if (outcome.kind === 'unavailable') {
        throw new MediaResolveError(
          outcome.pluginId,
          'unavailable',
          undefined,
          outcome.reason,
          outcome.message
        )
      }
      return outcome.media
    }
    media =
      resolutionId && store
        ? await store.refresh(resolutionId, url, load)
        : await load()
  }

  const ffmpegAvailable = await options.isFfmpegAvailable()
  const select = {
    entryId: pick.entryId,
    ...(pick.variantId ? { variantId: pick.variantId } : {}),
    ...(pick.maxHeight !== undefined ? { maxHeight: pick.maxHeight } : {}),
  }
  let selection = selectVariant(media, select, ffmpegAvailable)
  if (selection.kind === 'needs-entries') {
    const followUp = await service.resolve(url, {
      entryIds: [selection.entryId],
      pluginId: media.pluginId,
    })
    if (followUp.kind === 'unavailable') {
      throw new MediaResolveError(
        media.pluginId,
        'unavailable',
        undefined,
        followUp.reason,
        followUp.message
      )
    }
    if (followUp.kind === 'declined') {
      throw new MediaResolveError(media.pluginId, 'invalid-result')
    }
    media = mergeResolvedEntries(media, followUp.media)
    // Merge into the record as it is now: sibling picks may have loaded
    // their own entries meanwhile.
    const current = resolutionId ? store?.get(resolutionId) : null
    if (resolutionId && current?.media.sourceUrl === url) {
      store?.replace(
        resolutionId,
        mergeResolvedEntries(current.media, followUp.media)
      )
    }
    selection = selectVariant(media, select, ffmpegAvailable)
    if (selection.kind === 'needs-entries') {
      throw new MediaResolveError(media.pluginId, 'invalid-result')
    }
  }
  return { media, entry: selection.entry, variant: selection.variant }
}
