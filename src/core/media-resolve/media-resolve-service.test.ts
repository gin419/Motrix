import { describe, expect, it, vi } from 'vitest'
import {
  makeMediaResolveService,
  mergeResolvedEntries,
  type ResolvedMedia,
} from './media-resolve-service'

function resolver(id: string, name = id) {
  return {
    manifest: {
      id,
      name,
      categories: ['site-resolver'],
      hostPermissions: ['*://*.media.test/*'],
      contributes: {
        commands: [
          {
            id: `${id}.resolve`,
            title: 'resolve',
            public: true,
            argsSchema: {},
            resultSchema: {},
          },
        ],
      },
    },
    origin: 'community' as const,
    enabled: true,
  }
}

const PAGE = 'https://www.media.test/watch/abc123'

function service(
  invokeCommand: (...args: any[]) => Promise<unknown>,
  ...plugins: ReturnType<typeof resolver>[]
) {
  const pluginWarn = vi.fn()
  const svc = makeMediaResolveService({
    registry: { entries: () => plugins } as any,
    host: {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand: vi.fn(invokeCommand),
    } as any,
    pluginLog: () => ({ warn: pluginWarn }),
    now: () => 1_000,
  })
  return { svc, pluginWarn }
}

describe('makeMediaResolveService', () => {
  it('matches from the registry alone', () => {
    const invoke = vi.fn()
    const { svc } = service(invoke, resolver('example.media-resolver', 'Media'))
    expect(svc.match([PAGE, 'https://elsewhere.test/x'])).toEqual([
      { pluginId: 'example.media-resolver', pluginName: 'Media' },
      null,
    ])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns the resolution with its plugin and source url', async () => {
    const { svc } = service(
      async () => ({
        kind: 'mux',
        video: { url: 'https://cdn.media.test/v.m4s' },
        audio: { url: 'https://cdn.media.test/a.m4s' },
      }),
      resolver('example.media-resolver')
    )
    const outcome = await svc.resolve(PAGE)
    expect(outcome).toMatchObject({
      kind: 'resolved',
      media: {
        pluginId: 'example.media-resolver',
        sourceUrl: PAGE,
        resolvedAt: 1_000,
      },
    })
  })

  it('stops at an unavailable result without trying the next candidate', async () => {
    const invoke = vi.fn(async () => ({
      kind: 'unavailable',
      reason: 'geo-restricted',
      message: 'Not in your region',
    }))
    const { svc } = service(
      invoke,
      resolver('example.a-resolver'),
      resolver('example.b-resolver')
    )
    expect(await svc.resolve(PAGE)).toEqual({
      kind: 'unavailable',
      pluginId: 'example.a-resolver',
      reason: 'geo-restricted',
      message: 'Not in your region',
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('writes rejected-result issue paths to the plugin log, without values', async () => {
    const { svc, pluginWarn } = service(
      async () => ({
        kind: 'media',
        schemaVersion: 1,
        title: 'Example',
        entries: [
          {
            id: 'only',
            title: 'Only',
            variants: [
              {
                id: 'q1',
                label: 'Q1',
                container: 'mp4',
                source: {
                  kind: 'mux',
                  video: {
                    url: 'https://cdn.media.test/v.m4s',
                    headers: { Cookie: 'secret-value' },
                  },
                  audio: { url: 'https://cdn.media.test/a.m4s' },
                },
              },
            ],
          },
        ],
      }),
      resolver('example.media-resolver')
    )
    await expect(svc.resolve(PAGE)).rejects.toMatchObject({
      failure: 'invalid-result',
    })
    expect(pluginWarn).toHaveBeenCalledWith(
      'resolve result rejected by the host',
      {
        issues: [
          'entries.0.variants.0.source.video.headers: header not allowed',
        ],
      }
    )
    expect(JSON.stringify(pluginWarn.mock.calls)).not.toContain('secret')
  })

  it('pins a follow-up to one plugin and uses the entries budget', async () => {
    const invoke = vi.fn(async () => null)
    const { svc } = service(
      invoke,
      resolver('example.a-resolver'),
      resolver('example.b-resolver')
    )
    await svc.resolve(PAGE, {
      entryIds: ['p2'],
      pluginId: 'example.b-resolver',
    })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'example.b-resolver',
      'example.b-resolver.resolve',
      { url: PAGE, entryIds: ['p2'] },
      { timeoutMs: 30_000 }
    )
  })

  it('passes the signal through and ends the resolve once it aborts', async () => {
    const controller = new AbortController()
    const invoke = vi.fn(async () => {
      controller.abort()
      throw new Error('cancelled')
    })
    const { svc } = service(
      invoke,
      resolver('example.a-resolver'),
      resolver('example.b-resolver')
    )
    await expect(
      svc.resolve(PAGE, { signal: controller.signal, timeoutMs: 5 })
    ).rejects.toMatchObject({ failure: 'command-failed' })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'example.a-resolver',
      'example.a-resolver.resolve',
      { url: PAGE },
      { timeoutMs: 5, signal: controller.signal }
    )
  })
})

describe('mergeResolvedEntries', () => {
  const base: ResolvedMedia = {
    pluginId: 'example.media-resolver',
    sourceUrl: PAGE,
    resolvedAt: 1,
    resolution: {
      kind: 'media',
      schemaVersion: 1,
      title: 'Collection',
      entries: [
        { id: 'p1', title: 'Part 1', current: true },
        { id: 'p2', title: 'Part 2' },
      ],
    },
  }

  it('replaces only entries that came back with variants or as unavailable', () => {
    const merged = mergeResolvedEntries(base, {
      ...base,
      resolvedAt: 2,
      resolution: {
        ...base.resolution,
        expiresAt: 99,
        entries: [
          {
            id: 'p1',
            title: 'Part 1',
            variants: [
              { id: 'a', label: 'A', container: 'mp4', locked: 'login' },
            ],
          },
          { id: 'p2', title: 'Part 2' },
        ],
      },
    })
    expect(merged.resolvedAt).toBe(2)
    expect(merged.resolution.expiresAt).toBe(99)
    expect(merged.resolution.entries[0]).toMatchObject({
      id: 'p1',
      current: true,
      variants: [{ id: 'a' }],
    })
    expect(merged.resolution.entries[1]).toBe(base.resolution.entries[1])
  })
})
