import { z } from 'zod'

/**
 * Renderer-facing contract of the site media picker. Nothing here ever
 * carries a stream URL, mirror, header or cookie: the host keeps the full
 * resolution and hands the renderer a redacted preview keyed by an opaque
 * `resolutionId`.
 */

const URL_CHARS = 8192
const ID_CHARS = 128

/**
 * A pick of more parts than this deserves a warning before the tasks are
 * created: stream URLs a resolver hands out expire within hours, and parts
 * still queued by then fail.
 */
export const MEDIA_PICK_WARN_ABOVE_PARTS = 50

/** Every failure a site resolution can end in (see `MediaResolveError`). */
export const MEDIA_RESOLVE_FAILURES = [
  'command-failed',
  'timeout',
  'invalid-result',
  'unavailable',
  'no-playable-variant',
  'ffmpeg-required',
  'stream-unavailable',
  'variant-gone',
] as const
export type MediaResolveFailure = (typeof MEDIA_RESOLVE_FAILURES)[number]

export const matchMediaResolversRequestSchema = z.object({
  urls: z.array(z.string().max(URL_CHARS)).max(64),
})

export interface MediaResolverMatch {
  pluginId: string
  pluginName: string
}

/** One match per requested URL, in order; null where no resolver claims it. */
export interface MatchMediaResolversResult {
  matches: Array<MediaResolverMatch | null>
}

export const resolveMediaRequestSchema = z.object({
  /** Client-chosen; names the call for `CancelMediaResolve`. */
  requestId: z.uuid(),
  url: z.string().min(1).max(URL_CHARS),
  /** A previous preview of the same URL, to extend with `entryIds`. */
  resolutionId: z.uuid().optional(),
  /** Entries whose variants the preview left out (`variants: null`). */
  entryIds: z.array(z.string().min(1).max(ID_CHARS)).min(1).max(50).optional(),
})
export type ResolveMediaRequest = z.infer<typeof resolveMediaRequestSchema>

export const cancelMediaResolveRequestSchema = z.object({
  requestId: z.uuid(),
})

export interface CancelMediaResolveResult {
  /** False when no resolve with that id was running for this caller. */
  cancelled: boolean
}

export interface MediaPreviewVariant {
  id: string
  label: string
  height?: number
  fps?: number
  videoCodec?: string
  audioCodec?: string
  container: 'mp4' | 'mkv' | 'ts'
  sizeBytes?: number
  /** Shown but not downloadable until the user signs in or subscribes. */
  locked?: 'login' | 'premium'
  requiresFfmpeg: boolean
  /** The variant a create without `variantId` would download right now. */
  recommended: boolean
}

export interface MediaPreviewEntry {
  id: string
  index?: number
  title: string
  durationSec?: number
  /** The entry the pasted page points at. */
  current: boolean
  unavailable?: { reason: string; message?: string }
  /** Null while deferred: resolve again with this entry's id to load them. */
  variants: MediaPreviewVariant[] | null
}

export interface MediaPreview {
  resolutionId: string
  pluginId: string
  pluginName: string
  title: string
  defaultEntryId: string
  ffmpegAvailable: boolean
  /** Until then a pick reuses this resolution; later it is resolved again. */
  expiresAt: number
  auth?: { state: 'anonymous' | 'authenticated'; betterWithLogin?: boolean }
  /**
   * Folder a multi-part pick is saved into by default, or null when the
   * resolver gave no usable title.
   */
  folderName: string | null
  /** See {@link MEDIA_PICK_WARN_ABOVE_PARTS}. */
  warnAboveParts: number
  entries: MediaPreviewEntry[]
}

export type ResolveMediaResult =
  | { status: 'ok'; preview: MediaPreview }
  /** No installed resolver claims the URL. */
  | { status: 'declined' }
  | {
      status: 'unavailable'
      pluginId: string
      pluginName: string
      reason: string
      message?: string
    }
  | {
      status: 'failed'
      pluginId: string
      pluginName: string
      failure: MediaResolveFailure
    }
  | { status: 'cancelled' }
  /** Too many resolves are running; try again once one finishes. */
  | { status: 'busy' }

/**
 * A create's choice from a preview (`CreateTask.mediaPick`). Without
 * `variantId`, the best variant that fits `maxHeight` and can run now is
 * downloaded, as for a plain paste.
 */
export const mediaPickSchema = z
  .object({
    /** The preview the pick came from; reused while it is still fresh. */
    resolutionId: z.uuid().optional(),
    entryId: z.string().min(1).max(ID_CHARS),
    variantId: z.string().min(1).max(ID_CHARS).optional(),
    maxHeight: z.number().int().positive().max(100_000).optional(),
    /**
     * Save into a folder named after the collection title (see
     * `MediaPreview.folderName`). Multi-part picks are meant to set it by
     * default; no picker UI sends a pick yet.
     */
    saveToFolder: z.boolean().optional(),
  })
  .strict()
export type MediaPick = z.infer<typeof mediaPickSchema>
