import { describe, expect, it } from 'vitest'
import type { ResolvedMedia } from './media-resolve-service'
import {
  createMediaResolutionStore,
  MEDIA_RESOLUTION_STORE_LIMITS as LIMITS,
} from './resolution-store'

function media(title = 'Clip', expiresAt?: number): ResolvedMedia {
  return {
    pluginId: 'example.media-resolver',
    sourceUrl: 'https://video.example/watch/1',
    resolvedAt: 0,
    resolution: {
      kind: 'media',
      schemaVersion: 1,
      title,
      entries: [{ id: 'e1', title, current: true }],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  }
}

function setup() {
  let clock = 1_000_000
  let seq = 0
  const store = createMediaResolutionStore({
    now: () => clock,
    newId: () => `id-${++seq}`,
  })
  return {
    store,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

describe('media resolution store lifetime', () => {
  it('reuses a resolution for at most ten minutes', () => {
    const { store, advance, now } = setup()
    const record = store.put(media(), 'owner-a')
    expect(record.expiresAt).toBe(now() + LIMITS.maxTtlMs)
    advance(LIMITS.maxTtlMs - 1)
    expect(store.get(record.id)).not.toBeNull()
    advance(1)
    expect(store.get(record.id)).toBeNull()
  })

  it('stops reusing a resolution a minute before its stream URLs expire', () => {
    const { store, advance, now } = setup()
    const record = store.put(media('Clip', now() + 5 * 60_000), 'owner-a')
    expect(record.expiresAt).toBe(now() + 4 * 60_000)
    advance(4 * 60_000)
    expect(store.get(record.id)).toBeNull()
  })

  it('treats URLs that expire within the skew as already stale', () => {
    const { store, now } = setup()
    const record = store.put(media('Clip', now() + 30_000), 'owner-a')
    expect(store.get(record.id)).toBeNull()
  })

  it('extends a live record in place, keeping its owner and lifetime', () => {
    const { store, advance } = setup()
    const record = store.put(media('Old'), 'owner-a')
    advance(60_000)
    const replaced = store.replace(record.id, media('New'))
    expect(replaced).toMatchObject({
      id: record.id,
      ownerId: 'owner-a',
      expiresAt: record.expiresAt,
    })
    expect(store.get(record.id, 'owner-a')?.media.resolution.title).toBe('New')
    // Never past the expiry of the URLs it now holds.
    const sooner = store.replace(
      record.id,
      media('Sooner', record.expiresAt - 5 * 60_000)
    )
    expect(sooner?.expiresAt).toBe(record.expiresAt - 6 * 60_000)
  })

  it('does not extend an expired record', () => {
    const { store, advance } = setup()
    const record = store.put(media('Old'), 'owner-a')
    advance(LIMITS.maxTtlMs)
    expect(store.replace(record.id, media('New'))).toBeNull()
  })

  it('does not resurrect a record that is gone', () => {
    const { store } = setup()
    expect(store.replace('never-stored', media())).toBeNull()
    expect(store.get('never-stored')).toBeNull()
  })
})

describe('media resolution store capacity', () => {
  it('holds at most 32 records, evicting expired ones before the oldest live one', () => {
    const { store, advance, now } = setup()
    const stale = store.put(media('stale', now() + 2 * 60_000), 'owner-a')
    advance(1)
    const ids = Array.from(
      { length: LIMITS.records - 1 },
      (_, i) => store.put(media(`live-${i}`), 'owner-a').id
    )
    // Full: the next put drops the expired record, not the oldest live one.
    advance(60_000)
    store.put(media('next'), 'owner-a')
    expect(store.get(stale.id)).toBeNull()
    expect(store.get(ids[0])).not.toBeNull()
    // Full again with nothing expired: the oldest live record goes.
    store.put(media('another'), 'owner-a')
    expect(store.get(ids[0])).toBeNull()
    expect(store.get(ids[1])).not.toBeNull()
  })
})

describe('media resolution store ownership', () => {
  it('returns a record only to its owner when an owner is given', () => {
    const { store } = setup()
    const record = store.put(media(), 'owner-a')
    expect(store.get(record.id, 'owner-a')?.id).toBe(record.id)
    expect(store.get(record.id, 'owner-b')).toBeNull()
    // Lookups that name no owner (a task create) accept any.
    expect(store.get(record.id)?.id).toBe(record.id)
  })
})

describe('media resolution store running resolves', () => {
  it('runs at most two resolves at once and refuses a request id already running', () => {
    const { store } = setup()
    const first = store.begin('r1', 'owner-a')
    expect(first.kind).toBe('started')
    expect(store.begin('r1', 'owner-a')).toEqual({ kind: 'busy' })
    const second = store.begin('r2', 'owner-b')
    expect(second.kind).toBe('started')
    expect(store.begin('r3', 'owner-a')).toEqual({ kind: 'busy' })
    if (first.kind === 'started') first.end()
    expect(store.begin('r3', 'owner-a').kind).toBe('started')
  })

  it('aborts a running resolve only for its owner', () => {
    const { store } = setup()
    const slot = store.begin('r1', 'owner-a')
    if (slot.kind !== 'started') throw new Error('not started')
    expect(store.cancel('r1', 'owner-b')).toBe(false)
    expect(slot.signal.aborted).toBe(false)
    expect(store.cancel('r1', 'owner-a')).toBe(true)
    expect(slot.signal.aborted).toBe(true)
  })

  it('honors a cancel that overtook its resolve, for the same owner only', () => {
    const { store, advance } = setup()
    expect(store.cancel('r1', 'owner-a')).toBe(false)
    expect(store.begin('r1', 'owner-b').kind).toBe('started')
    expect(store.cancel('r2', 'owner-a')).toBe(false)
    expect(store.begin('r2', 'owner-a')).toEqual({ kind: 'cancelled' })
    // Remembered once, and only briefly.
    store.cancel('r3', 'owner-a')
    advance(LIMITS.cancelMemoryMs + 1)
    expect(store.begin('r3', 'owner-a').kind).toBe('started')
  })

  it('frees the slot of a finished resolve even after a later reuse of its id', () => {
    const { store } = setup()
    const first = store.begin('r1', 'owner-a')
    if (first.kind !== 'started') throw new Error('not started')
    first.end()
    const again = store.begin('r1', 'owner-a')
    if (again.kind !== 'started') throw new Error('not started')
    // A stale end() must not release the newer run.
    first.end()
    expect(store.begin('r1', 'owner-a')).toEqual({ kind: 'busy' })
    again.end()
  })
})
