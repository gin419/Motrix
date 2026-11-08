import { MediaResolveError } from '@core/task/media-resolve-error'
import { AppError, ErrorCode } from '@shared/errors'
import { describe, expect, it, vi } from 'vitest'
import { makeResolveToMux } from './index'

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

function fakeRegistry(...plugins: ReturnType<typeof plugin>[]) {
  return { entries: () => plugins } as any
}

const BILI = 'https://www.bilibili.com/video/BV1xx411c7mD'
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

describe('makeResolveToMux — generalized multi-resolver routing', () => {
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
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toEqual({
      videoUrl: 'https://cdn/v.m4s',
      audioUrl: 'https://cdn/a.m4s',
      container: 'mp4',
      headers: { Referer: 'https://x' },
      title: 'T',
    })
    expect(pluginHost.activate).toHaveBeenCalledWith(
      'community.bilibili-resolver'
    )
    expect(invokeCommand).toHaveBeenCalledWith(
      'community.bilibili-resolver',
      'community.bilibili-resolver.resolve',
      { url: BILI }
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
    expect(await resolve(BILI)).toBeNull()
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
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('skips a disabled resolver even if its hostPermissions match', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
          enabled: false,
        })
      ),
      pluginHost
    )
    expect(await resolve(BILI)).toBeNull()
    expect(invokeCommand).not.toHaveBeenCalled()
  })

  it('returns null when no enabled resolver hostPermissions admit the url', async () => {
    const invokeCommand = vi.fn()
    const pluginHost = { activate: vi.fn(), invokeCommand } as any
    const resolve = makeResolveToMux(
      fakeRegistry(
        plugin({
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    expect(await resolve(YT)).toBeNull()
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
    expect(await resolve(BILI)).toBeNull()
    expect(await resolve(YT)).toBeNull()
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
          id: 'community.bilibili-resolver',
          hostPermissions: ['*://*.bilibili.com/*'],
        })
      ),
      pluginHost
    )
    await resolve(BILI, 'SESSDATA=x')
    expect(invokeCommand).toHaveBeenCalledWith(
      'community.bilibili-resolver',
      'community.bilibili-resolver.resolve',
      { url: BILI, cookies: 'SESSDATA=x' }
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
