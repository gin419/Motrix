import { MediaResolveError } from '@core/task/media-resolve-error'
import { AppError, ErrorCode } from '@shared/errors'
import { describe, expect, it, vi } from 'vitest'
import { makeMediaResolveService } from './media-resolve-service'
import { createMediaResolutionStore } from './resolution-store'
import {
  type ResolvedMediaVariant,
  resolveMediaVariant,
  resolvePickedMediaVariant,
} from './resolve-media-variant'

// Build a fake registry entry shaped like PluginRegistry.entries() rows:
// { manifest, origin, enabled }. A site-resolver contributes to the mux seam
// only when it declares a PUBLIC command whose id is `${manifest.id}.resolve`
// (the resolve-command marker); pass `resolveCommand: false` to omit it.
function plugin(spec: {
  id: string
  hostPermissions?: string[]
  categories?: string[]
  enabled?: boolean
  origin?: 'builtin' | 'community'
  resolveCommand?: boolean
}) {
  const commands =
    spec.resolveCommand === false
      ? []
      : [
          {
            id: `${spec.id}.resolve`,
            title: 'resolve',
            public: true,
            argsSchema: {},
            resultSchema: {},
          },
        ]
  return {
    manifest: {
      id: spec.id,
      categories: spec.categories ?? ['site-resolver'],
      hostPermissions: spec.hostPermissions ?? [],
      contributes: { commands },
    },
    origin: spec.origin ?? 'community',
    enabled: spec.enabled ?? true,
  }
}

// Mux selections are flattened to the pair shape the pre-variant seam
// returned, so the routing cases below read as before; any other source
// kind is returned as `{ kind, variantId }`.
function toRoute(picked: ResolvedMediaVariant | null) {
  if (!picked) return null
  const { media, entry, variant } = picked
  const source = variant.source
  if (source?.kind !== 'mux')
    return { kind: source?.kind, variantId: variant.id }
  const title = media.resolution.title || entry.title
  return {
    videoUrl: source.video.url,
    audioUrl: source.audio.url,
    container: variant.container,
    ...(source.video.headers ? { headers: source.video.headers } : {}),
    ...(title ? { title } : {}),
  }
}

function makeResolveToMux(
  registry: any,
  host: any,
  isFfmpegAvailable: () => Promise<boolean> = async () => true
) {
  const service = makeMediaResolveService({ registry, host })
  return async (url: string, cookieHeader?: string) =>
    toRoute(
      await resolveMediaVariant(service, url, {
        ...(cookieHeader ? { cookieHeader } : {}),
        isFfmpegAvailable,
      })
    )
}

function fakeRegistry(...plugins: ReturnType<typeof plugin>[]) {
  return { entries: () => plugins } as any
}

const PAGE = 'https://www.media.test/watch/abc123'
const OTHER_PAGE = 'https://www.other-media.test/watch?v=xyz'

describe('resolveMediaVariant — multi-resolver routing', () => {
  it('routes to an enabled site-resolver that declares <id>.resolve and whose hostPermissions admit the url', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      kind: 'mux',
      video: { url: 'https://cdn/v.m4s', headers: { Referer: 'https://x' } },
      audio: { url: 'https://cdn/a.m4s' },
      container: 'mp4',
      title: 'T',
    })
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'example.media-resolver',
          hostPermissions: ['*://*.media.test/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(PAGE)).toEqual({
      videoUrl: 'https://cdn/v.m4s',
      audioUrl: 'https://cdn/a.m4s',
      container: 'mp4',
      headers: { Referer: 'https://x' },
      title: 'T',
    })
    expect(pluginHost.activate).toHaveBeenCalledWith('example.media-resolver')
    expect(invokeCommand).toHaveBeenCalledWith(
      'example.media-resolver',
      'example.media-resolver.resolve',
      { url: PAGE },
      { timeoutMs: 45_000 }
    )
  })

  // Regression lock (carried from A1): motrix.scraper-hook — a builtin at the
  // time, since retired from the shipped set — was a 'site-resolver' with
  // hostPermissions ['*://*/*'] and NO resolve command. Routing keyed off the
  // resolve-command marker (not the site-resolver category) must NEVER invoke
  // such a plugin, so a broad co-installed site-resolver cannot collapse the
  // seam to match-everything. The id stays as the historical fixture.
  it('never routes to a broad site-resolver that has no <id>.resolve command', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'motrix.scraper-hook',
          hostPermissions: ['*://*/*'],
          origin: 'builtin',
          resolveCommand: false,
        })
      ),
      pluginHost
    )
    expect(await resolve('https://example.com/file.zip')).toBeNull()
    expect(await resolve(PAGE)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('ignores a plugin that declares <id>.resolve but is not categorized site-resolver', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.thing',
          categories: ['post-action'],
          hostPermissions: ['*://*.media.test/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(PAGE)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('skips a disabled resolver even if its hostPermissions match', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'example.media-resolver',
          hostPermissions: ['*://*.media.test/*'],
          enabled: false,
        })
      ),
      pluginHost
    )
    expect(await resolve(PAGE)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('returns null when no enabled resolver hostPermissions admit the url', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'example.media-resolver',
          hostPermissions: ['*://*.media.test/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(OTHER_PAGE)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('empty official resolvable set: with only a stripped resolver (no hostPermissions), nothing is routed', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'motrix.url-resolver',
          hostPermissions: [],
          origin: 'builtin',
        })
      ),
      pluginHost
    )
    expect(await resolve(PAGE)).toBeNull()
    expect(await resolve(OTHER_PAGE)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('tries builtin-origin resolvers before community and falls through a null result to the next', async () => {
    const invokeCommand = vi.fn(async (id: string) =>
      id === 'community.b-resolver'
        ? {
            kind: 'mux',
            video: { url: 'https://c/v' },
            audio: { url: 'https://c/a' },
            container: 'mp4',
          }
        : null
    )
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.b-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'community',
        }),
        plugin({
          id: 'motrix.a-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'builtin',
        })
      ),
      pluginHost
    )
    expect(await resolve('https://www.site.com/x')).toEqual({
      videoUrl: 'https://c/v',
      audioUrl: 'https://c/a',
      container: 'mp4',
    })
    // builtin tried first (returned null), then community produced the mux
    expect(invokeCommand.mock.calls.map((c) => c[0])).toEqual([
      'motrix.a-resolver',
      'community.b-resolver',
    ])
  })

  it('falls through to the next resolver when one throws', async () => {
    const invokeCommand = vi.fn(async (id: string) => {
      if (id === 'motrix.a-resolver') throw new Error('boom')
      return {
        kind: 'mux',
        video: { url: 'https://c/v' },
        audio: { url: 'https://c/a' },
        container: 'mkv',
      }
    })
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.b-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'community',
        }),
        plugin({
          id: 'motrix.a-resolver',
          hostPermissions: ['*://*.site.com/*'],
          origin: 'builtin',
        })
      ),
      pluginHost
    )
    expect(await resolve('https://www.site.com/x')).toEqual({
      videoUrl: 'https://c/v',
      audioUrl: 'https://c/a',
      container: 'mkv',
    })
  })

  it('passes cookies to the resolve command when a cookie header is provided', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({
      kind: 'mux',
      video: { url: 'https://c/v' },
      audio: { url: 'https://c/a' },
      container: 'mp4',
    })
    const pluginHost = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'example.media-resolver',
          hostPermissions: ['*://*.media.test/*'],
        })
      ),
      pluginHost
    )
    await resolve(PAGE, 'session=x')
    expect(invokeCommand).toHaveBeenCalledWith(
      'example.media-resolver',
      'example.media-resolver.resolve',
      { url: PAGE, cookies: 'session=x' },
      { timeoutMs: 45_000 }
    )
  })

  describe('a matching resolver that fails never degrades to a plain download', () => {
    const site = (spec: { id: string; origin?: 'builtin' | 'community' }) =>
      plugin({ ...spec, hostPermissions: ['*://*.site.com/*'] })

    it('throws MediaResolveError when the only matching resolver throws', async () => {
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand: vi.fn().mockRejectedValue(new Error('boom')),
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      const rejection = resolve('https://www.site.com/x')
      await expect(rejection).rejects.toBeInstanceOf(MediaResolveError)
      await expect(rejection).rejects.toMatchObject({
        code: ErrorCode.MediaResolveFailed,
        pluginId: 'community.site-resolver',
        failure: 'command-failed',
      })
    })

    it('treats a command timeout as a failure', async () => {
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand: vi
          .fn()
          .mockRejectedValue(
            new AppError(ErrorCode.PluginTimeout, 'command timed out')
          ),
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      await expect(resolve('https://www.site.com/x')).rejects.toMatchObject({
        failure: 'command-failed',
      })
    })

    it('treats a failed activation as a failure', async () => {
      const invokeCommand = vi.fn()
      const pluginHost = {
        activate: vi.fn().mockRejectedValue(new Error('circuit open')),
        invokeCommand,
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      await expect(resolve('https://www.site.com/x')).rejects.toBeInstanceOf(
        MediaResolveError
      )
      expect(invokeCommand).not.toHaveBeenCalled()
    })

    it.each([
      ['an unsupported kind', { kind: 'hls', url: 'https://c/x.m3u8' }],
      [
        'a mux result without an audio url',
        { kind: 'mux', video: { url: 'https://c/v' }, audio: {} },
      ],
      [
        'an unsupported container',
        {
          kind: 'mux',
          video: { url: 'https://c/v' },
          audio: { url: 'https://c/a' },
          container: 'avi',
        },
      ],
      ['a non-object', 'https://c/v'],
    ])('throws invalid-result for %s', async (_label, result) => {
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand: vi.fn().mockResolvedValue(result),
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      await expect(resolve('https://www.site.com/x')).rejects.toMatchObject({
        pluginId: 'community.site-resolver',
        failure: 'invalid-result',
      })
    })

    it('accepts null for the optional title, container and headers', async () => {
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand: vi.fn().mockResolvedValue({
          kind: 'mux',
          video: { url: 'https://c/v.m4s', headers: null },
          audio: { url: 'https://c/a.m4s' },
          container: null,
          title: null,
        }),
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      expect(await resolve('https://www.site.com/x')).toEqual({
        videoUrl: 'https://c/v.m4s',
        audioUrl: 'https://c/a.m4s',
        container: 'mp4',
      })
    })

    it.each([
      [
        'a null video url',
        { video: { url: null }, audio: { url: 'https://c/a' } },
      ],
      ['a null audio leg', { video: { url: 'https://c/v' }, audio: null }],
    ])('still throws invalid-result for %s', async (_label, legs) => {
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand: vi.fn().mockResolvedValue({ kind: 'mux', ...legs }),
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      await expect(resolve('https://www.site.com/x')).rejects.toMatchObject({
        failure: 'invalid-result',
      })
    })

    it('reports the first failure when a later candidate only declines', async () => {
      const invokeCommand = vi.fn(async (id: string) => {
        if (id === 'motrix.a-resolver') throw new Error('boom')
        return null
      })
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand,
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(
          site({ id: 'community.b-resolver', origin: 'community' }),
          site({ id: 'motrix.a-resolver', origin: 'builtin' })
        ),
        pluginHost
      )
      await expect(resolve('https://www.site.com/x')).rejects.toMatchObject({
        pluginId: 'motrix.a-resolver',
      })
      expect(invokeCommand).toHaveBeenCalledTimes(2)
    })

    it('returns null when every matching resolver declines', async () => {
      const pluginHost = {
        activate: vi.fn().mockResolvedValue(undefined),
        invokeCommand: vi.fn().mockResolvedValue(null),
      } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      expect(await resolve('https://www.site.com/x')).toBeNull()
    })

    it('does not consult a failing resolver for URLs outside its hostPermissions', async () => {
      const invokeCommand = vi.fn().mockRejectedValue(new Error('boom'))
      const pluginHost = { activate: vi.fn(), invokeCommand } as any
      const resolve = makeResolveToMux(
        fakeRegistry(site({ id: 'community.site-resolver' })),
        pluginHost
      )
      expect(await resolve('https://example.com/file.zip')).toBeNull()
      expect(invokeCommand).not.toHaveBeenCalled()
    })
  })
})

describe('resolveMediaVariant over versioned results', () => {
  const site = plugin({
    id: 'example.media-resolver',
    hostPermissions: ['*://*.media.test/*'],
  })
  const mux = (tag: string) => ({
    kind: 'mux',
    video: { url: `https://cdn.media.test/${tag}/v.m4s` },
    audio: { url: `https://cdn.media.test/${tag}/a.m4s` },
  })
  const hostReturning = (...results: unknown[]) => {
    const invokeCommand = vi.fn()
    for (const result of results) invokeCommand.mockResolvedValueOnce(result)
    return {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand,
    } as any
  }

  it('routes the best variant of the current entry', async () => {
    const host = hostReturning({
      kind: 'media',
      schemaVersion: 1,
      title: 'Collection',
      entries: [
        {
          id: 'p1',
          title: 'Part 1',
          variants: [
            { id: 'a', label: 'A', container: 'mp4', source: mux('p1') },
          ],
        },
        {
          id: 'p2',
          title: 'Part 2',
          current: true,
          variants: [
            { id: 'hi', label: '4K', container: 'mkv', locked: 'premium' },
            { id: 'mid', label: '1080P', container: 'mkv', source: mux('p2') },
          ],
        },
      ],
    })
    expect(await makeResolveToMux(fakeRegistry(site), host)(PAGE)).toEqual({
      videoUrl: 'https://cdn.media.test/p2/v.m4s',
      audioUrl: 'https://cdn.media.test/p2/a.m4s',
      container: 'mkv',
      title: 'Collection',
    })
  })

  it('fetches a deferred current entry once, pinned to the same plugin', async () => {
    const host = hostReturning(
      {
        kind: 'media',
        schemaVersion: 1,
        title: 'Collection',
        entries: [{ id: 'p1', title: 'Part 1', current: true }],
      },
      {
        kind: 'media',
        schemaVersion: 1,
        title: 'Collection',
        entries: [
          {
            id: 'p1',
            title: 'Part 1',
            variants: [
              { id: 'a', label: 'A', container: 'mp4', source: mux('p1') },
            ],
          },
        ],
      }
    )
    const other = plugin({
      id: 'example.second-resolver',
      hostPermissions: ['*://*.media.test/*'],
    })
    const result = await makeResolveToMux(fakeRegistry(site, other), host)(
      PAGE,
      'session=x'
    )
    expect(result).toMatchObject({
      videoUrl: 'https://cdn.media.test/p1/v.m4s',
    })
    expect(host.invokeCommand).toHaveBeenCalledTimes(2)
    expect(host.invokeCommand.mock.calls[1]).toEqual([
      'example.media-resolver',
      'example.media-resolver.resolve',
      { url: PAGE, cookies: 'session=x', entryIds: ['p1'] },
      { timeoutMs: 30_000 },
    ])
  })

  const hlsVariant = {
    id: 'hls',
    label: 'HLS',
    container: 'ts',
    source: {
      kind: 'hls',
      manifest: { url: 'https://cdn.media.test/master.m3u8' },
    },
  }
  const directVariant = {
    id: 'sd',
    label: '360P',
    container: 'mp4',
    source: {
      kind: 'direct',
      stream: { url: 'https://cdn.media.test/p1/360.mp4' },
    },
  }
  const oneEntry = (...variants: unknown[]) => ({
    kind: 'media',
    schemaVersion: 1,
    title: 'Collection',
    entries: [{ id: 'p1', title: 'Part 1', variants }],
  })

  it('selects the best variant whatever its source kind', async () => {
    const host = hostReturning(
      oneEntry(hlsVariant, {
        id: 'mux',
        label: 'Mux',
        container: 'mp4',
        source: mux('p1'),
      })
    )
    expect(await makeResolveToMux(fakeRegistry(site), host)(PAGE)).toEqual({
      kind: 'hls',
      variantId: 'hls',
    })
  })

  it('prefers a direct variant when FFmpeg is missing', async () => {
    const host = hostReturning(oneEntry(hlsVariant, directVariant))
    expect(
      await makeResolveToMux(fakeRegistry(site), host, async () => false)(PAGE)
    ).toEqual({ kind: 'direct', variantId: 'sd' })
  })

  it('fails with ffmpeg-required when only FFmpeg variants exist and FFmpeg is missing', async () => {
    const host = hostReturning(
      oneEntry(hlsVariant, {
        id: 'mux',
        label: 'Mux',
        container: 'mp4',
        source: mux('p1'),
      })
    )
    await expect(
      makeResolveToMux(fakeRegistry(site), host, async () => false)(PAGE)
    ).rejects.toMatchObject({
      pluginId: 'example.media-resolver',
      failure: 'ffmpeg-required',
    })
  })

  it('does not look for FFmpeg when no resolver claims the URL', async () => {
    const isFfmpegAvailable = vi.fn(async () => true)
    const host = hostReturning(null)
    expect(
      await makeResolveToMux(fakeRegistry(site), host, isFfmpegAvailable)(PAGE)
    ).toBeNull()
    expect(isFfmpegAvailable).not.toHaveBeenCalled()
  })

  it('turns an unavailable result into an unavailable failure with its reason', async () => {
    const host = hostReturning({ kind: 'unavailable', reason: 'paid-content' })
    await expect(
      makeResolveToMux(fakeRegistry(site), host)(PAGE)
    ).rejects.toMatchObject({ failure: 'unavailable', reason: 'paid-content' })
  })

  it.each([
    [
      'the result',
      [{ kind: 'unavailable', reason: 'age-gated', message: 'Confirm age' }],
    ],
    [
      'the current entry',
      [
        {
          kind: 'media',
          schemaVersion: 1,
          title: 'Collection',
          entries: [
            {
              id: 'p1',
              title: 'Part 1',
              unavailable: { reason: 'age-gated', message: 'Confirm age' },
            },
          ],
        },
      ],
    ],
    [
      'the deferred-entry follow-up',
      [
        {
          kind: 'media',
          schemaVersion: 1,
          title: 'Collection',
          entries: [{ id: 'p1', title: 'Part 1', current: true }],
        },
        { kind: 'unavailable', reason: 'age-gated', message: 'Confirm age' },
      ],
    ],
  ])(
    'carries the resolver message of an unavailable %s',
    async (_where, results) => {
      const host = hostReturning(...results)
      await expect(
        makeResolveToMux(fakeRegistry(site), host)(PAGE)
      ).rejects.toMatchObject({
        failure: 'unavailable',
        reason: 'age-gated',
        detail: 'Confirm age',
        message:
          'task.add.media.unavailable.unsupportedWithDetail: Confirm age',
      })
    }
  )

  it('reports a host command timeout as a timeout failure', async () => {
    const timeout = Object.assign(new Error('timed out'), {
      code: 'plugin.command.timeout',
    })
    const host = {
      activate: vi.fn().mockResolvedValue(undefined),
      invokeCommand: vi.fn().mockRejectedValue(timeout),
    } as any
    await expect(
      makeResolveToMux(fakeRegistry(site), host)(PAGE)
    ).rejects.toMatchObject({ failure: 'timeout' })
  })
})

describe('resolvePickedMediaVariant', () => {
  const RESOLVER = 'example.media-resolver'
  const site = () =>
    plugin({ id: RESOLVER, hostPermissions: ['*://*.media.test/*'] })
  const variant = (id: string, height: number, entry: string) => ({
    id,
    label: `${height}P`,
    height,
    container: 'mp4',
    source: {
      kind: 'direct',
      stream: { url: `https://cdn.media.test/${entry}/${id}.mp4` },
    },
  })
  const series = (opts: { deferP2?: boolean; p1Variants?: string[] } = {}) => ({
    kind: 'media',
    schemaVersion: 1,
    title: 'Series',
    entries: [
      {
        id: 'p1',
        index: 1,
        title: 'One',
        current: true,
        variants: (opts.p1Variants ?? ['v1080', 'v480']).map((id) =>
          variant(id, Number(id.slice(1)), 'p1')
        ),
      },
      opts.deferP2
        ? { id: 'p2', index: 2, title: 'Two' }
        : {
            id: 'p2',
            index: 2,
            title: 'Two',
            variants: [
              variant('v1080', 1080, 'p2'),
              variant('v480', 480, 'p2'),
            ],
          },
    ],
  })

  function setup(
    answer: (args: Record<string, unknown>, pluginId: string) => unknown,
    registry = fakeRegistry(site())
  ) {
    const invokeCommand = vi.fn(
      async (id: string, _cmd: string, args: Record<string, unknown>) =>
        answer(args, id)
    )
    const host = { activate: vi.fn(async () => undefined), invokeCommand }
    let clock = 1_000_000
    const service = makeMediaResolveService({
      registry,
      host,
      now: () => clock,
    })
    const store = createMediaResolutionStore({ now: () => clock })
    const preview = async () => {
      const outcome = await service.resolve(PAGE)
      if (outcome.kind !== 'resolved') throw new Error(outcome.kind)
      return store.put(outcome.media, 'owner').id
    }
    const pick = (p: Parameters<typeof resolvePickedMediaVariant>[2]) =>
      resolvePickedMediaVariant(service, PAGE, p, {
        isFfmpegAvailable: async () => true,
        store,
      })
    return {
      invokeCommand,
      store,
      preview,
      pick,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }
  const pickedIds = (r: ResolvedMediaVariant) => `${r.entry.id}/${r.variant.id}`

  it('reuses a fresh preview without asking the resolver again', async () => {
    const t = setup(() => series())
    const resolutionId = await t.preview()
    t.invokeCommand.mockClear()
    const picked = await t.pick({
      resolutionId,
      entryId: 'p2',
      variantId: 'v480',
    })
    expect(pickedIds(picked)).toBe('p2/v480')
    expect(t.invokeCommand).not.toHaveBeenCalled()
    // Without a variant id, the best one under maxHeight.
    expect(
      pickedIds(await t.pick({ resolutionId, entryId: 'p1', maxHeight: 720 }))
    ).toBe('p1/v480')
  })

  it('resolves an expired preview again once for concurrent picks and matches stable ids', async () => {
    const t = setup(() => series())
    const resolutionId = await t.preview()
    t.advance(11 * 60_000)
    t.invokeCommand.mockClear()
    const picks = await Promise.all([
      t.pick({ resolutionId, entryId: 'p1', variantId: 'v1080' }),
      t.pick({ resolutionId, entryId: 'p2', variantId: 'v1080' }),
    ])
    expect(picks.map(pickedIds)).toEqual(['p1/v1080', 'p2/v1080'])
    expect(t.invokeCommand).toHaveBeenCalledOnce()
    // The refresh is kept for later picks from the same preview.
    await t.pick({ resolutionId, entryId: 'p2', variantId: 'v480' })
    expect(t.invokeCommand).toHaveBeenCalledOnce()
  })

  describe('an expired preview stays with the resolver that answered it', () => {
    const FIRST = 'example.first-resolver'
    const SECOND = 'example.second-resolver'
    const claimants = () => {
      const first = plugin({
        id: FIRST,
        origin: 'builtin',
        hostPermissions: ['*://*.media.test/*'],
      })
      const second = plugin({
        id: SECOND,
        hostPermissions: ['*://*.media.test/*'],
      })
      return { first, second, registry: fakeRegistry(first, second) }
    }

    it('refreshes with the second resolver even once the first answers again', async () => {
      const { registry } = claimants()
      let firstFails = true
      const t = setup((_args, pluginId) => {
        if (pluginId === FIRST && firstFails) throw new Error('timed out')
        return series()
      }, registry)
      const resolutionId = await t.preview()
      expect(t.store.get(resolutionId)?.media.pluginId).toBe(SECOND)
      firstFails = false
      t.advance(11 * 60_000)
      t.invokeCommand.mockClear()
      const picked = await t.pick({
        resolutionId,
        entryId: 'p1',
        variantId: 'v1080',
      })
      expect(picked.media.pluginId).toBe(SECOND)
      expect(t.invokeCommand.mock.calls.map(([id]) => id)).toEqual([SECOND])
      expect(t.store.get(resolutionId)?.media.pluginId).toBe(SECOND)
    })

    it('fails as variant-gone rather than asking another resolver once the original is disabled', async () => {
      const { first, registry } = claimants()
      const t = setup(() => series(), registry)
      const resolutionId = await t.preview()
      expect(t.store.get(resolutionId)?.media.pluginId).toBe(FIRST)
      first.enabled = false
      t.advance(11 * 60_000)
      t.invokeCommand.mockClear()
      await expect(
        t.pick({ resolutionId, entryId: 'p1', variantId: 'v1080' })
      ).rejects.toMatchObject({ failure: 'variant-gone', pluginId: FIRST })
      expect(t.invokeCommand).not.toHaveBeenCalled()
    })
  })

  it('fails as variant-gone when a refreshed resolution no longer offers the pick', async () => {
    let p1Variants = ['v1080', 'v480']
    const t = setup(() => series({ p1Variants }))
    const resolutionId = await t.preview()
    t.advance(11 * 60_000)
    p1Variants = ['v480']
    await expect(
      t.pick({ resolutionId, entryId: 'p1', variantId: 'v1080' })
    ).rejects.toMatchObject({ failure: 'variant-gone' })
    await expect(t.pick({ resolutionId, entryId: 'p9' })).rejects.toMatchObject(
      { failure: 'variant-gone' }
    )
  })

  it('resolves the page when the pick names no stored preview', async () => {
    const t = setup(() => series())
    const picked = await t.pick({
      resolutionId: '00000000-0000-4000-8000-000000000009',
      entryId: 'p2',
      variantId: 'v480',
    })
    expect(pickedIds(picked)).toBe('p2/v480')
    expect(t.invokeCommand).toHaveBeenCalledExactlyOnceWith(
      RESOLVER,
      `${RESOLVER}.resolve`,
      { url: PAGE },
      expect.anything()
    )
  })

  it('does not reuse a preview of another page', async () => {
    const t = setup(() => series())
    const resolutionId = await t.preview()
    t.invokeCommand.mockClear()
    const other = 'https://www.media.test/watch/other'
    await resolvePickedMediaVariant(
      makeMediaResolveService({
        registry: fakeRegistry(site()),
        host: {
          activate: vi.fn(async () => undefined),
          invokeCommand: t.invokeCommand,
        },
      }),
      other,
      { resolutionId, entryId: 'p1' },
      { isFfmpegAvailable: async () => true, store: t.store }
    )
    expect(t.invokeCommand.mock.calls[0]?.[2]).toEqual({ url: other })
    // The owner's preview of the first page is untouched.
    expect(t.store.get(resolutionId)?.media.sourceUrl).toBe(PAGE)
  })

  it('re-checks that the preview’s resolver is still enabled', async () => {
    const entry = site()
    const t = setup(() => series(), fakeRegistry(entry))
    const resolutionId = await t.preview()
    entry.enabled = false
    t.invokeCommand.mockClear()
    await expect(
      t.pick({ resolutionId, entryId: 'p1', variantId: 'v1080' })
    ).rejects.toMatchObject({ failure: 'variant-gone', pluginId: RESOLVER })
    expect(t.invokeCommand).not.toHaveBeenCalled()
  })

  it('loads a deferred entry once and keeps it in the preview', async () => {
    const t = setup((args) =>
      args.entryIds ? series() : series({ deferP2: true })
    )
    const resolutionId = await t.preview()
    t.invokeCommand.mockClear()
    const picked = await t.pick({
      resolutionId,
      entryId: 'p2',
      variantId: 'v480',
    })
    expect(pickedIds(picked)).toBe('p2/v480')
    expect(t.invokeCommand.mock.calls[0]?.[2]).toEqual({
      url: PAGE,
      entryIds: ['p2'],
    })
    await t.pick({ resolutionId, entryId: 'p2', variantId: 'v1080' })
    expect(t.invokeCommand).toHaveBeenCalledOnce()
  })

  it('reports an entry the resolver now calls unavailable', async () => {
    const t = setup(() => ({
      kind: 'unavailable',
      reason: 'removed',
    }))
    await expect(t.pick({ entryId: 'p1' })).rejects.toMatchObject({
      failure: 'unavailable',
      reason: 'removed',
    })
  })
})
