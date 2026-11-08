import { BridgeReceiverError } from '@core/bridge-receiver/errors'
import { ensureMediaExtension } from '@core/bridge-receiver/pipelines/media-final-name'
import {
  type AdaptedDash,
  type AdaptedHls,
  type AdaptedMux,
  sanitizeFilename,
} from '@core/bridge-receiver/submit-download-adapter'
import type { CreateRequestReceipt } from '@core/task/create-request-id'
import { sanitizeRemoteFilename } from '@core/task/direct-resource-validator'
import type { SourceMeta } from '@shared/types/task'
import type { ResolvedMedia } from './media-resolve-service'
import type { MediaRuntime } from './media-runtime'
import type { MediaEntry, MediaVariant, StreamRef } from './site-resolution'

/** The part of the process media runtime a variant dispatch needs. */
export interface MediaDispatchTarget {
  mux: Pick<MediaRuntime['mux'], 'dispatch'>
  hlsDash: Pick<MediaRuntime['hlsDash'], 'dispatch'>
  isFfmpegAvailable: MediaRuntime['isFfmpegAvailable']
}

export interface MediaDispatchBase {
  taskId: string
  saveDir: string
  /** Final on-disk name, already picked; the pipeline adds a media extension. */
  finalName: string
  sourceMeta: SourceMeta
  receipt?: CreateRequestReceipt
  durationSec?: number
  /**
   * Headers for a stream that declares none, already allowlisted by the
   * caller (an extension submit's browser headers). Absent, such a stream
   * is requested without headers.
   */
  fallbackHeaders?: Record<string, string>
}

export type MediaDispatchOutcome =
  /** Routed to the mux or HLS/DASH pipeline, which now owns the task. */
  | { kind: 'dispatched'; taskId: string }
  /**
   * A progressive file: the caller continues its own HTTP path with these
   * sources and headers. Headers are already allowlisted by the contract.
   */
  | {
      kind: 'rewriteDirect'
      uris: string[]
      headers: Record<string, string>
    }

/**
 * Route one selected variant to the pipeline its source kind needs. The
 * resolution contract has already admitted every URL and filtered headers.
 * Pipeline errors (FFmpeg gone, manifest fetch, unsupported playlist)
 * propagate unchanged for the caller to map; without a runtime, a pipeline
 * kind fails with `unsupported-kind` like any media submit would.
 */
export async function dispatchMediaVariant(
  variant: MediaVariant,
  base: MediaDispatchBase,
  target: MediaDispatchTarget | undefined
): Promise<MediaDispatchOutcome> {
  const source = variant.source
  if (!source) throw new Error('a locked variant cannot be dispatched')
  const headersFor = (declared: Record<string, string> | undefined) =>
    hasHeaders(declared) ? { ...declared } : { ...(base.fallbackHeaders ?? {}) }
  if (source.kind === 'direct') {
    return {
      kind: 'rewriteDirect',
      uris: streamUris(source.stream),
      headers: headersFor(source.stream.headers),
    }
  }
  if (!target) {
    throw new BridgeReceiverError(
      'unsupported-kind',
      'media pipelines are not active'
    )
  }
  const common = {
    taskId: base.taskId,
    saveDir: base.saveDir,
    finalName: base.finalName,
    sourceMeta: base.sourceMeta,
    ...(base.receipt ? { receipt: base.receipt } : {}),
    ...(base.durationSec !== undefined
      ? { durationSec: base.durationSec }
      : {}),
  }
  if (source.kind === 'mux') {
    // aria2 gets each leg's mirrors with its URL as one job.
    const videoMirrors = streamUris(source.video).slice(1)
    const audioMirrors = streamUris(source.audio).slice(1)
    const adapted: AdaptedMux = {
      ...common,
      kind: 'mux',
      videoUrl: source.video.url,
      audioUrl: source.audio.url,
      ...(videoMirrors.length > 0 ? { videoMirrors } : {}),
      ...(audioMirrors.length > 0 ? { audioMirrors } : {}),
      sanitizedHeaders: headersFor(source.video.headers),
      // An audio leg that declares no headers keeps the video leg's, as a
      // legacy mux pair always did.
      ...(hasHeaders(source.audio.headers)
        ? { audioHeaders: { ...source.audio.headers } }
        : {}),
      // The contract rejects a ts mux variant.
      container: variant.container === 'mkv' ? 'mkv' : 'mp4',
    }
    return { kind: 'dispatched', ...(await target.mux.dispatch(adapted)) }
  }
  const manifest = {
    manifestUrl: source.manifest.url,
    sanitizedHeaders: headersFor(source.manifest.headers),
  }
  const adapted: AdaptedHls | AdaptedDash =
    source.kind === 'hls'
      ? { ...common, ...manifest, kind: 'hls', container: variant.container }
      : {
          ...common,
          ...manifest,
          kind: 'dash',
          // DASH output is always remuxed; ts is not an output container.
          container: variant.container === 'mkv' ? 'mkv' : 'mp4',
        }
  return { kind: 'dispatched', ...(await target.hlsDash.dispatch(adapted)) }
}

function hasHeaders(
  headers: Record<string, string> | undefined
): headers is Record<string, string> {
  return headers !== undefined && Object.keys(headers).length > 0
}

function streamUris(stream: StreamRef): string[] {
  return [...new Set([stream.url, ...(stream.mirrors ?? [])])]
}

/**
 * The on-disk name for a variant, before deduplication: "<title>.<ext>" for
 * a single entry, "<title> - P<index> <entry title>.<ext>" when the
 * resolution has several (the entry title is dropped when it repeats the
 * collection title). Null when the resolver gave no usable title, so the
 * caller keeps its own name.
 *
 * A direct variant keeps a ts container as .ts (the file is saved as is);
 * mux/HLS/DASH output is remuxed to mp4 or mkv.
 *
 * The title is untrusted plugin text: the name goes through the same rule
 * as a URL-derived HTTP name once the extension is on, so it fits the
 * filesystem's byte limit with room for the incomplete and dedup suffixes,
 * keeps its extension through truncation, and never names a Windows device.
 */
export function planMediaName(
  media: ResolvedMedia,
  entry: MediaEntry,
  variant: MediaVariant
): string | null {
  const { title, entries } = media.resolution
  const collection = title.trim()
  const part = entry.title.trim()
  let base = collection || part
  if (entries.length > 1) {
    const index = entry.index ?? entries.indexOf(entry) + 1
    const label = part && part !== collection ? ` ${part}` : ''
    base = collection ? `${collection} - P${index}${label}` : part
  }
  const name = sanitizeFilename(base).trim()
  if (!name) return null
  let withExtension: string
  if (variant.source?.kind === 'direct') {
    const ext = `.${variant.container}`
    withExtension = name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`
  } else {
    withExtension = ensureMediaExtension(name, variant.container)
  }
  return sanitizeRemoteFilename(withExtension)
}

/**
 * The folder a multi-part pick is saved into: the collection title, under
 * the same rule as a planned file name. Null without a usable title.
 */
export function planMediaFolderName(media: ResolvedMedia): string | null {
  const name = sanitizeFilename(media.resolution.title).trim()
  return name ? sanitizeRemoteFilename(name) : null
}
