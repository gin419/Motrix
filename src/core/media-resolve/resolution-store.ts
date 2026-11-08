import { randomUUID } from 'node:crypto'
import type { ResolvedMedia } from './media-resolve-service'

/**
 * Resolutions the media picker previewed, kept so a pick reuses them instead
 * of asking the resolver again, plus the resolves still running so they can
 * be cancelled.
 *
 * Records hold stream URLs and their headers, but never cookies: picker
 * resolves send the resolver none. Keys are random UUIDs, so a resolution
 * can be named only by a client that was handed its preview.
 */
export interface MediaResolutionStore {
  /** Store `media` for `ownerId` and return its new id. */
  put(media: ResolvedMedia, ownerId: string | null): StoredResolution
  /**
   * The live record `id` names, or null when it is unknown, expired, or
   * belongs to another owner. `ownerId` undefined accepts any owner.
   */
  get(id: string, ownerId?: string | null): StoredResolution | null
  /**
   * Replace the media of live record `id` with an extended copy (entries
   * loaded later), keeping its owner and lifetime: loading more entries
   * makes the earlier entries' stream URLs no fresher. Null when the record
   * is gone or expired.
   */
  replace(id: string, media: ResolvedMedia): StoredResolution | null
  /** Claim a slot for a running resolve. */
  begin(requestId: string, ownerId: string): ResolveSlot
  /** Abort the owner's running resolve `requestId`; false if none ran. */
  cancel(requestId: string, ownerId: string): boolean
}

export interface StoredResolution {
  id: string
  ownerId: string | null
  media: ResolvedMedia
  /** Epoch ms after which a pick resolves the page again. */
  expiresAt: number
}

export type ResolveSlot =
  | { kind: 'started'; signal: AbortSignal; end(): void }
  /** The owner cancelled this request id before it arrived. */
  | { kind: 'cancelled' }
  /** Too many resolves are running, or this request id already is. */
  | { kind: 'busy' }

export interface MediaResolutionStoreOptions {
  now?: () => number
  newId?: () => string
}

export const MEDIA_RESOLUTION_STORE_LIMITS = {
  records: 32,
  /** Longest a resolution is reused, even when its URLs live longer. */
  maxTtlMs: 10 * 60_000,
  /** Stop reusing a resolution this long before its URLs expire. */
  expirySkewMs: 60_000,
  /** Records, expired or not, are dropped after this long. */
  retainMs: 60 * 60_000,
  inFlight: 2,
  /** Cancels that arrived before their resolve, remembered this long. */
  cancelMemoryMs: 60_000,
  cancelMemory: 64,
} as const

const LIMITS = MEDIA_RESOLUTION_STORE_LIMITS

interface Running {
  ownerId: string
  controller: AbortController
}

export function createMediaResolutionStore(
  options: MediaResolutionStoreOptions = {}
): MediaResolutionStore {
  const now = options.now ?? Date.now
  const newId = options.newId ?? randomUUID
  // Insertion order is age order: re-set entries move to the end.
  const records = new Map<string, StoredResolution & { storedAt: number }>()
  const running = new Map<string, Running>()
  const earlyCancels = new Map<string, { ownerId: string; at: number }>()

  const lifetimeEnd = (media: ResolvedMedia, at: number): number => {
    const urlsExpireAt = media.resolution.expiresAt
    const cap = at + LIMITS.maxTtlMs
    return urlsExpireAt === undefined
      ? cap
      : Math.min(cap, urlsExpireAt - LIMITS.expirySkewMs)
  }

  const prune = (at: number): void => {
    for (const [id, record] of records) {
      if (at - record.storedAt > LIMITS.retainMs) records.delete(id)
    }
    if (records.size < LIMITS.records) return
    // Make room: expired records go first, then the oldest.
    for (const [id, record] of records) {
      if (record.expiresAt <= at) records.delete(id)
    }
    for (const id of records.keys()) {
      if (records.size < LIMITS.records) break
      records.delete(id)
    }
  }

  const save = (
    id: string,
    ownerId: string | null,
    media: ResolvedMedia
  ): StoredResolution => {
    const at = now()
    const record = {
      id,
      ownerId,
      media,
      expiresAt: lifetimeEnd(media, at),
      storedAt: at,
    }
    records.delete(id)
    records.set(id, record)
    return publicRecord(record)
  }

  const store: MediaResolutionStore = {
    put(media, ownerId) {
      prune(now())
      return save(newId(), ownerId, media)
    },

    get(id, ownerId) {
      const record = records.get(id)
      if (!record || record.expiresAt <= now()) return null
      if (ownerId !== undefined && record.ownerId !== ownerId) return null
      return publicRecord(record)
    },

    replace(id, media) {
      const at = now()
      const record = records.get(id)
      if (!record || record.expiresAt <= at) return null
      const updated = {
        ...record,
        media,
        expiresAt: Math.min(record.expiresAt, lifetimeEnd(media, at)),
      }
      records.set(id, updated)
      return publicRecord(updated)
    },

    begin(requestId, ownerId) {
      const at = now()
      for (const [key, cancel] of earlyCancels) {
        if (at - cancel.at > LIMITS.cancelMemoryMs) earlyCancels.delete(key)
      }
      const early = earlyCancels.get(requestId)
      if (early?.ownerId === ownerId) {
        earlyCancels.delete(requestId)
        return { kind: 'cancelled' }
      }
      if (running.has(requestId) || running.size >= LIMITS.inFlight) {
        return { kind: 'busy' }
      }
      const controller = new AbortController()
      const entry = { ownerId, controller }
      running.set(requestId, entry)
      return {
        kind: 'started',
        signal: controller.signal,
        end: () => {
          if (running.get(requestId) === entry) running.delete(requestId)
        },
      }
    },

    cancel(requestId, ownerId) {
      const entry = running.get(requestId)
      if (entry) {
        if (entry.ownerId !== ownerId) return false
        entry.controller.abort()
        return true
      }
      // The cancel may overtake its resolve on the Web transport, where the
      // two travel as separate HTTP requests.
      earlyCancels.delete(requestId)
      earlyCancels.set(requestId, { ownerId, at: now() })
      while (earlyCancels.size > LIMITS.cancelMemory) {
        const oldest = earlyCancels.keys().next().value
        if (oldest === undefined) break
        earlyCancels.delete(oldest)
      }
      return false
    },
  }
  return store
}

function publicRecord(
  record: StoredResolution & { storedAt: number }
): StoredResolution {
  return {
    id: record.id,
    ownerId: record.ownerId,
    media: record.media,
    expiresAt: record.expiresAt,
  }
}
