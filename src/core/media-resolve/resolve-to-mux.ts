import { MediaResolveError } from '@core/task/media-resolve-error'
import {
  type MediaResolveService,
  mergeResolvedEntries,
} from './media-resolve-service'
import { selectVariant } from './select-variant'

export interface ResolvedMuxPair {
  videoUrl: string
  audioUrl: string
  container: 'mp4' | 'mkv'
  headers?: Record<string, string>
  title?: string
}

/**
 * Resolve `url` and return a mux pair, `null` when no resolver claims the
 * URL, or throw MediaResolveError when a resolver claimed it and failed.
 */
export type ResolveToMux = (
  url: string,
  cookieHeader?: string
) => Promise<ResolvedMuxPair | null>

/**
 * Adapter for consumers that can only route a mux pair: it selects the
 * default variant of the default entry (fetching that entry once if its
 * variants were deferred) and fails with `no-playable-variant` when the
 * selection is any other source kind.
 *
 * FFmpeg availability is not judged here; the mux pipeline checks it when
 * the job is dispatched, exactly as for any other mux task.
 */
export function makeResolveToMux(service: MediaResolveService): ResolveToMux {
  return async (url, cookieHeader) => {
    const options = cookieHeader ? { cookieHeader } : {}
    const outcome = await service.resolve(url, options)
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
    let selection = selectVariant(media, undefined, true)
    if (selection.kind === 'needs-entries') {
      const followUp = await service.resolve(url, {
        ...options,
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
      selection = selectVariant(media, undefined, true)
      if (selection.kind === 'needs-entries') {
        throw new MediaResolveError(media.pluginId, 'invalid-result')
      }
    }

    const { entry, variant } = selection
    const source = variant.source
    if (source?.kind !== 'mux' || variant.container === 'ts') {
      throw new MediaResolveError(media.pluginId, 'no-playable-variant')
    }
    const title = media.resolution.title || entry.title
    return {
      videoUrl: source.video.url,
      audioUrl: source.audio.url,
      container: variant.container,
      ...(source.video.headers ? { headers: source.video.headers } : {}),
      ...(title ? { title } : {}),
    }
  }
}
