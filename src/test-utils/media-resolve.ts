import type {
  MediaResolveService,
  ResolveOutcome,
} from '@core/media-resolve/media-resolve-service'
import { parseSiteResolveResult } from '@core/media-resolve/site-resolution'
import { MediaResolveError } from '@core/task/media-resolve-error'
import { vi } from 'vitest'

export const FIXTURE_RESOLVER_ID = 'example.media-resolver'

/**
 * A MediaResolveService whose resolver answers `raw` (or what `raw(url)`
 * returns) — validated by the real contract, so a test states the plugin's
 * wire result. `null` declines; a thrown Error becomes `command-failed`.
 */
export function fakeMediaResolve(
  raw: unknown | ((url: string) => unknown),
  pluginId = FIXTURE_RESOLVER_ID
) {
  const resolve = vi.fn(async (url: string): Promise<ResolveOutcome> => {
    let value: unknown
    try {
      value = typeof raw === 'function' ? await raw(url) : raw
    } catch (error) {
      if (error instanceof MediaResolveError) throw error
      throw new MediaResolveError(pluginId, 'command-failed', error)
    }
    const parsed = parseSiteResolveResult(value)
    if (parsed.kind === 'declined') return { kind: 'declined' }
    if (parsed.kind === 'invalid')
      throw new MediaResolveError(pluginId, 'invalid-result')
    if (parsed.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        pluginId,
        reason: parsed.reason,
        ...(parsed.message ? { message: parsed.message } : {}),
      }
    }
    return {
      kind: 'resolved',
      media: {
        pluginId,
        sourceUrl: url,
        resolvedAt: 0,
        resolution: parsed.resolution,
      },
    }
  })
  const service: MediaResolveService = {
    match: (urls) => urls.map(() => null),
    eligibleResolver: (_url, id) =>
      id === pluginId ? { pluginId, pluginName: 'Example resolver' } : null,
    resolve,
  }
  return Object.assign(service, { resolve })
}

/** A one-entry versioned resolution offering `variants`, best first. */
export function mediaResolution(title: string, ...variants: unknown[]) {
  return {
    kind: 'media',
    schemaVersion: 1,
    title,
    entries: [{ id: 'default', title, current: true, variants }],
  }
}

export function directVariant(
  url: string,
  extra: { headers?: Record<string, string>; mirrors?: string[] } = {}
) {
  return {
    id: 'direct',
    label: 'Direct',
    container: 'mp4',
    source: { kind: 'direct', stream: { url, ...extra } },
  }
}

export function muxVariant(
  videoUrl: string,
  audioUrl: string,
  headers?: Record<string, string>
) {
  return {
    id: 'mux',
    label: 'Mux',
    container: 'mp4',
    source: {
      kind: 'mux',
      video: { url: videoUrl, ...(headers ? { headers } : {}) },
      audio: { url: audioUrl },
    },
  }
}

export function manifestVariant(
  kind: 'hls' | 'dash',
  url: string,
  headers?: Record<string, string>
) {
  return {
    id: kind,
    label: kind.toUpperCase(),
    container: kind === 'hls' ? 'ts' : 'mp4',
    source: { kind, manifest: { url, ...(headers ? { headers } : {}) } },
  }
}

/** Dispatch spies shaped like the process media runtime. */
export function fakeMediaTarget(ffmpegAvailable = true) {
  return {
    mux: {
      dispatch: vi.fn(async (_adapted: unknown) => ({ taskId: 'mux-task' })),
    },
    hlsDash: {
      dispatch: vi.fn(async (_adapted: unknown) => ({
        taskId: 'hls-dash-task',
      })),
    },
    isFfmpegAvailable: vi.fn(async () => ffmpegAvailable),
  }
}

/**
 * One pasted page and the mux dispatch it must produce. Both shells' command
 * tests run it through their CreateTask handler, so the Electron and server
 * wiring cannot drift apart.
 */
export function pastedMediaPage() {
  const page = 'https://video.example/watch/1'
  const video = 'https://cdn.example/v/1080.m4s'
  const audio = 'https://cdn.example/a/hi.m4s'
  return {
    page,
    mediaResolve: fakeMediaResolve(
      mediaResolution(
        'Example clip',
        muxVariant(video, audio, { Referer: 'https://video.example/' })
      )
    ),
    media: fakeMediaTarget(),
    expectedDispatch: {
      kind: 'mux',
      videoUrl: video,
      audioUrl: audio,
      container: 'mp4',
      finalName: 'Example clip.mp4',
      sanitizedHeaders: { Referer: 'https://video.example/' },
      sourceMeta: null,
    },
  }
}
