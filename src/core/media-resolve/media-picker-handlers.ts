import { getLogger } from '@core/logger'
import { MediaResolveError } from '@core/task/media-resolve-error'
import { admitDownloadSources } from '@core/task/source-admission'
import {
  type CancelMediaResolveResult,
  cancelMediaResolveRequestSchema,
  type MatchMediaResolversResult,
  matchMediaResolversRequestSchema,
  type ResolveMediaResult,
  resolveMediaRequestSchema,
} from '@shared/schemas/media-resolution'
import { toMediaPreview } from './media-preview'
import {
  type MediaResolveService,
  mergeResolvedEntries,
  type ResolvedMedia,
} from './media-resolve-service'
import type { MediaResolutionStore, StoredResolution } from './resolution-store'
import { isEntryDeferred } from './site-resolution'
import {
  type SiteResolverRegistry,
  siteResolverCandidates,
} from './site-resolver-candidates'

const log = getLogger('media-picker')

/** The client a resolve belongs to (a renderer window, a Web session). */
export interface MediaPickerOwner {
  id: string
  eligible(): boolean
}

export interface MediaPickerDeps {
  service: MediaResolveService
  store: MediaResolutionStore
  isFfmpegAvailable: () => Promise<boolean>
}

export interface MediaPicker {
  /** `ResolveMedia`: resolve a page and return its redacted preview. */
  resolve(owner: MediaPickerOwner, value: unknown): Promise<ResolveMediaResult>
  /** `CancelMediaResolve`: abort the owner's running resolve. */
  cancel(owner: MediaPickerOwner, value: unknown): CancelMediaResolveResult
}

/**
 * Shell-neutral media picker commands. Each takes the caller's owner
 * principal first: a resolution and a running resolve belong to the client
 * that started them.
 */
export function createMediaPicker(deps: MediaPickerDeps): MediaPicker {
  return {
    resolve: (owner, value) => resolveMediaPreview(deps, owner, value),
    cancel: (owner, value) => {
      const { requestId } = cancelMediaResolveRequestSchema.parse(value)
      return { cancelled: deps.store.cancel(requestId, owner.id) }
    },
  }
}

/** `MatchMediaResolvers`: the resolver that would answer each URL. */
export function matchMediaResolvers(
  registry: SiteResolverRegistry,
  value: unknown
): MatchMediaResolversResult {
  const { urls } = matchMediaResolversRequestSchema.parse(value)
  return {
    matches: urls.map((url) => {
      const page = admitPageUrl(url)
      const [first] = page ? siteResolverCandidates(registry, page) : []
      return first
        ? { pluginId: first.manifest.id, pluginName: first.manifest.name }
        : null
    }),
  }
}

async function resolveMediaPreview(
  deps: MediaPickerDeps,
  owner: MediaPickerOwner,
  value: unknown
): Promise<ResolveMediaResult> {
  const request = resolveMediaRequestSchema.parse(value)
  // The same normalization a CreateTask applies, so a pick's page URL and
  // the stored resolution's compare equal.
  const url = admitPageUrl(request.url)
  if (!url) return { status: 'declined' }
  if (!owner.eligible()) return { status: 'cancelled' }

  const slot = deps.store.begin(request.requestId, owner.id)
  if (slot.kind !== 'started') return { status: slot.kind }
  const { signal } = slot
  let pluginId: string | null = null
  try {
    const stored = request.resolutionId
      ? deps.store.get(request.resolutionId, owner.id)
      : null
    // Extend a resolution only while it describes this page and its
    // resolver is still enabled; otherwise resolve afresh.
    const previous =
      stored?.media.sourceUrl === url &&
      deps.service.eligibleResolver(url, stored.media.pluginId)
        ? stored
        : null
    let media: ResolvedMedia
    if (previous) {
      media = previous.media
    } else {
      const outcome = await deps.service.resolve(url, { signal })
      if (signal.aborted) return { status: 'cancelled' }
      if (outcome.kind === 'declined') return { status: 'declined' }
      if (outcome.kind === 'unavailable') {
        return {
          status: 'unavailable',
          pluginId: outcome.pluginId,
          pluginName: pluginName(deps, url, outcome.pluginId),
          reason: outcome.reason,
          ...(outcome.message ? { message: outcome.message } : {}),
        }
      }
      media = outcome.media
    }
    pluginId = media.pluginId

    const deferred = new Set(
      media.resolution.entries.filter(isEntryDeferred).map((e) => e.id)
    )
    const entryIds = (request.entryIds ?? []).filter((id) => deferred.has(id))
    if (entryIds.length > 0) {
      const followUp = await deps.service.resolve(url, {
        entryIds,
        pluginId: media.pluginId,
        signal,
      })
      if (signal.aborted) return { status: 'cancelled' }
      if (followUp.kind === 'unavailable') {
        return {
          status: 'unavailable',
          pluginId: media.pluginId,
          pluginName: pluginName(deps, url, media.pluginId),
          reason: followUp.reason,
          ...(followUp.message ? { message: followUp.message } : {}),
        }
      }
      if (followUp.kind === 'declined') {
        throw new MediaResolveError(media.pluginId, 'invalid-result')
      }
      media = mergeResolvedEntries(media, followUp.media)
    }

    const ffmpegAvailable = await deps.isFfmpegAvailable()
    if (signal.aborted) return { status: 'cancelled' }
    let record: StoredResolution
    if (!previous) record = deps.store.put(media, owner.id)
    else if (media === previous.media) record = previous
    else {
      record =
        deps.store.replace(previous.id, media) ??
        deps.store.put(media, owner.id)
    }
    log.info(
      {
        pluginId: media.pluginId,
        host: safeHost(url),
        entries: media.resolution.entries.length,
        deferred: media.resolution.entries.filter(isEntryDeferred).length,
        extended: entryIds.length,
      },
      'media resolve preview'
    )
    return {
      status: 'ok',
      preview: toMediaPreview(record, {
        pluginName: pluginName(deps, url, media.pluginId),
        ffmpegAvailable,
      }),
    }
  } catch (error) {
    if (signal.aborted) return { status: 'cancelled' }
    if (!(error instanceof MediaResolveError)) throw error
    return {
      status: 'failed',
      pluginId: error.pluginId || pluginId || '',
      pluginName: pluginName(deps, url, error.pluginId || pluginId || ''),
      failure: error.failure,
    }
  } finally {
    slot.end()
  }
}

function pluginName(
  deps: MediaPickerDeps,
  url: string,
  pluginId: string
): string {
  return deps.service.eligibleResolver(url, pluginId)?.pluginName ?? pluginId
}

function admitPageUrl(url: string): string | null {
  try {
    return (
      admitDownloadSources([url], 'input', ['http', 'https'])[0]?.sourceUrl ??
      null
    )
  } catch {
    return null
  }
}

/** Host of a URL for diagnostics; page and stream URLs are never logged. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
