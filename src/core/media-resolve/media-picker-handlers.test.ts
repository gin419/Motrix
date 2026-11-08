import type { ResolveMediaResult } from '@shared/schemas/media-resolution'
import { afterEach, describe, expect, it, vi } from 'vitest'

const info = vi.fn()
vi.mock('@core/logger', () => ({
  getLogger: () => ({ info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const { createMediaPicker, matchMediaResolvers } = await import(
  './media-picker-handlers'
)
const { makeMediaResolveService } = await import('./media-resolve-service')
const { createMediaResolutionStore } = await import('./resolution-store')

afterEach(() => vi.clearAllMocks())

const RESOLVER = 'example.media-resolver'
const PAGE = 'https://www.media.test/watch/1'
const OWNER = { id: 'session:a', eligible: () => true }
const OTHER = { id: 'session:b', eligible: () => true }
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function registry(enabled = true) {
  return {
    entries: () => [
      {
        manifest: {
          id: RESOLVER,
          name: 'Example resolver',
          categories: ['site-resolver'],
          hostPermissions: ['*://*.media.test/*'],
          contributes: {
            commands: [
              {
                id: `${RESOLVER}.resolve`,
                title: 'resolve',
                public: true,
                argsSchema: {},
                resultSchema: {},
              },
            ],
          },
        },
        origin: 'community',
        enabled,
      },
    ],
  } as never
}

const stream = (name: string) => ({
  url: `https://cdn.example/${name}?sig=secret`,
  headers: { Referer: 'https://www.media.test/' },
})

function series(deferSecond = true) {
  return {
    kind: 'media',
    schemaVersion: 1,
    title: 'Series',
    entries: [
      {
        id: 'p1',
        index: 1,
        title: 'One',
        current: true,
        variants: [
          {
            id: 'v720',
            label: '720P',
            height: 720,
            container: 'mp4',
            source: { kind: 'direct', stream: stream('p1.mp4') },
          },
        ],
      },
      deferSecond
        ? { id: 'p2', index: 2, title: 'Two' }
        : {
            id: 'p2',
            index: 2,
            title: 'Two',
            variants: [
              {
                id: 'v720',
                label: '720P',
                height: 720,
                container: 'mp4',
                source: { kind: 'direct', stream: stream('p2.mp4') },
              },
            ],
          },
    ],
  }
}

function setup(
  answer: (args: Record<string, unknown>, signal?: AbortSignal) => unknown
) {
  const invokeCommand = vi.fn(
    async (
      _id: string,
      _command: string,
      args: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) => answer(args, options?.signal)
  )
  const host = { activate: vi.fn(async () => undefined), invokeCommand }
  const service = makeMediaResolveService({ registry: registry(), host })
  const store = createMediaResolutionStore()
  const picker = createMediaPicker({
    service,
    store,
    isFfmpegAvailable: async () => true,
  })
  return { picker, store, invokeCommand }
}

function ok(result: ResolveMediaResult) {
  if (result.status !== 'ok') throw new Error(`status ${result.status}`)
  return result.preview
}

describe('ResolveMedia', () => {
  it('stores the resolution and returns a preview without stream data or cookies', async () => {
    const { picker, store, invokeCommand } = setup(() => series())
    const preview = ok(
      await picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    )
    // The picker sends the resolver no cookies.
    expect(invokeCommand.mock.calls[0]?.[2]).toEqual({ url: PAGE })
    expect(preview).toMatchObject({
      pluginId: RESOLVER,
      pluginName: 'Example resolver',
      defaultEntryId: 'p1',
      folderName: 'Series',
    })
    expect(preview.entries.map((e) => e.variants === null)).toEqual([
      false,
      true,
    ])
    expect(JSON.stringify(preview)).not.toMatch(/cdn\.example|sig=|Referer/)
    expect(store.get(preview.resolutionId, OWNER.id)?.media.sourceUrl).toBe(
      PAGE
    )
    // Logs name the host and counts, never a URL.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'www.media.test', entries: 2 }),
      'media resolve preview'
    )
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/https?:\/\//)
  })

  it('loads deferred entries into the same resolution, pinned to its resolver', async () => {
    const { picker, invokeCommand } = setup((args) =>
      args.entryIds ? series(false) : series()
    )
    const first = ok(
      await picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    )
    const extended = ok(
      await picker.resolve(OWNER, {
        requestId: uuid(2),
        url: PAGE,
        resolutionId: first.resolutionId,
        entryIds: ['p2', 'p1', 'unknown'],
      })
    )
    expect(extended.resolutionId).toBe(first.resolutionId)
    // Only entries still deferred are asked for.
    expect(invokeCommand.mock.calls[1]?.[2]).toEqual({
      url: PAGE,
      entryIds: ['p2'],
    })
    expect(extended.entries[1].variants?.map((v) => v.id)).toEqual(['v720'])
  })

  it('keeps entries loaded by concurrent extensions of one resolution', async () => {
    const loaded = (id: string) => ({
      id,
      title: id,
      variants: [
        {
          id: 'v720',
          label: '720P',
          height: 720,
          container: 'mp4',
          source: { kind: 'direct', stream: stream(`${id}.mp4`) },
        },
      ],
    })
    const page = (ids: string[] = []) => ({
      kind: 'media',
      schemaVersion: 1,
      title: 'Series',
      entries: ['p1', 'p2', 'p3'].map((id) =>
        id === 'p1' || ids.includes(id) ? loaded(id) : { id, title: id }
      ),
    })
    let releaseP2 = () => {}
    const p2Gate = new Promise<void>((resolve) => {
      releaseP2 = resolve
    })
    const { picker, store } = setup(async (args) => {
      const ids = (args.entryIds as string[] | undefined) ?? []
      if (ids.includes('p2')) await p2Gate
      return page(ids)
    })
    const first = ok(
      await picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    )
    const extend = (n: number, entryId: string) =>
      picker.resolve(OWNER, {
        requestId: uuid(n),
        url: PAGE,
        resolutionId: first.resolutionId,
        entryIds: [entryId],
      })
    const slowP2 = extend(2, 'p2')
    const p3 = ok(await extend(3, 'p3'))
    expect(p3.entries[2].variants).not.toBeNull()
    releaseP2()
    const p2 = ok(await slowP2)
    // The later reply still shows the entry the earlier one loaded.
    expect(p2.entries.map((e) => e.variants !== null)).toEqual([
      true,
      true,
      true,
    ])
    const stored = store.get(first.resolutionId, OWNER.id)
    expect(
      stored?.media.resolution.entries.map((e) => e.variants !== undefined)
    ).toEqual([true, true, true])
  })

  it('does not extend a resolution owned by another client', async () => {
    const { picker, invokeCommand } = setup(() => series())
    const first = ok(
      await picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    )
    const other = ok(
      await picker.resolve(OTHER, {
        requestId: uuid(2),
        url: PAGE,
        resolutionId: first.resolutionId,
      })
    )
    // Resolved afresh under a new id instead of reading the owner's record.
    expect(invokeCommand).toHaveBeenCalledTimes(2)
    expect(other.resolutionId).not.toBe(first.resolutionId)
  })

  it('reports a decline, an unavailable page and a failed resolver', async () => {
    const declined = setup(() => null)
    expect(
      await declined.picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    ).toEqual({ status: 'declined' })

    const paid = setup(() => ({
      kind: 'unavailable',
      reason: 'paid-content',
      message: 'Members only',
    }))
    expect(
      await paid.picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    ).toEqual({
      status: 'unavailable',
      pluginId: RESOLVER,
      pluginName: 'Example resolver',
      reason: 'paid-content',
      message: 'Members only',
    })

    const broken = setup(() => ({ kind: 'media', schemaVersion: 1 }))
    expect(
      await broken.picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    ).toEqual({
      status: 'failed',
      pluginId: RESOLVER,
      pluginName: 'Example resolver',
      failure: 'invalid-result',
    })
  })

  it('declines a URL that is not an http page', async () => {
    const { picker, invokeCommand } = setup(() => series())
    expect(
      await picker.resolve(OWNER, {
        requestId: uuid(1),
        url: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000',
      })
    ).toEqual({ status: 'declined' })
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('rejects a malformed request', async () => {
    const { picker } = setup(() => series())
    await expect(
      picker.resolve(OWNER, { requestId: 'not-a-uuid', url: PAGE })
    ).rejects.toThrow()
  })
})

describe('CancelMediaResolve', () => {
  function pendingResolver() {
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const answer = (_args: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        started()
        signal?.addEventListener('abort', () =>
          reject(new Error('plugin.command.cancelled'))
        )
      })
    return { running, answer }
  }

  it('aborts the owner’s resolve, which then stores nothing', async () => {
    const { running, answer } = pendingResolver()
    const { picker, invokeCommand } = setup(answer)
    const result = picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    await running
    expect(invokeCommand.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal)
    expect(picker.cancel(OTHER, { requestId: uuid(1) })).toEqual({
      cancelled: false,
    })
    expect(picker.cancel(OWNER, { requestId: uuid(1) })).toEqual({
      cancelled: true,
    })
    expect(await result).toEqual({ status: 'cancelled' })
  })

  it('cancels a resolve whose cancel arrived first', async () => {
    const { picker, invokeCommand } = setup(() => series())
    expect(picker.cancel(OWNER, { requestId: uuid(1) })).toEqual({
      cancelled: false,
    })
    expect(
      await picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    ).toEqual({ status: 'cancelled' })
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('reports busy beyond two concurrent resolves', async () => {
    const { running, answer } = pendingResolver()
    const { picker } = setup(answer)
    const first = picker.resolve(OWNER, { requestId: uuid(1), url: PAGE })
    const second = picker.resolve(OTHER, { requestId: uuid(2), url: PAGE })
    await running
    expect(
      await picker.resolve(OWNER, { requestId: uuid(3), url: PAGE })
    ).toEqual({ status: 'busy' })
    picker.cancel(OWNER, { requestId: uuid(1) })
    picker.cancel(OTHER, { requestId: uuid(2) })
    await Promise.all([first, second])
  })
})

describe('MatchMediaResolvers', () => {
  it('names the resolver that claims each URL, without starting it', () => {
    expect(
      matchMediaResolvers(registry(), {
        urls: [PAGE, 'https://elsewhere.test/x', 'not a url'],
      })
    ).toEqual({
      matches: [
        { pluginId: RESOLVER, pluginName: 'Example resolver' },
        null,
        null,
      ],
    })
    expect(matchMediaResolvers(registry(false), { urls: [PAGE] })).toEqual({
      matches: [null],
    })
  })
})
