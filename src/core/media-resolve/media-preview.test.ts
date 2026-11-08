import { describe, expect, it } from 'vitest'
import { toMediaPreview } from './media-preview'
import type { ResolvedMedia } from './media-resolve-service'
import type { StoredResolution } from './resolution-store'
import { parseSiteResolveResult } from './site-resolution'

const SECRET_HOSTS = ['cdn.example', 'mirror.example', 'keys.example']

function stored(raw: unknown): StoredResolution {
  const parsed = parseSiteResolveResult(raw)
  if (parsed.kind !== 'media') throw new Error(`fixture is ${parsed.kind}`)
  const media: ResolvedMedia = {
    pluginId: 'example.media-resolver',
    sourceUrl: 'https://video.example/watch/1',
    resolvedAt: 0,
    resolution: parsed.resolution,
  }
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ownerId: 'owner',
    media,
    expiresAt: 123,
  }
}

const headers = {
  Referer: 'https://video.example/watch/1?token=page-secret',
  'User-Agent': 'UA/secret',
}

const series = {
  kind: 'media',
  schemaVersion: 1,
  title: 'Series: one/two',
  expiresAt: 9_999_999_999_999,
  auth: { state: 'anonymous', betterWithLogin: true },
  entries: [
    {
      id: 'p1',
      index: 1,
      title: 'Opening',
      durationSec: 61,
      variants: [
        {
          id: 'hd',
          label: '1080P',
          height: 1080,
          container: 'mp4',
          locked: 'premium',
        },
        {
          id: 'mux-720',
          label: '720P',
          height: 720,
          fps: 30,
          videoCodec: 'avc1',
          audioCodec: 'mp4a',
          sizeBytes: 1000,
          container: 'mp4',
          source: {
            kind: 'mux',
            video: {
              url: 'https://cdn.example/v/720.m4s?sig=video-secret',
              mirrors: ['https://mirror.example/v/720.m4s?sig=video-secret'],
              headers,
            },
            audio: {
              url: 'https://cdn.example/a/hi.m4s?sig=audio-secret',
              headers,
            },
          },
        },
        {
          id: 'hls-480',
          label: '480P',
          height: 480,
          container: 'ts',
          source: {
            kind: 'hls',
            manifest: {
              url: 'https://keys.example/480/index.m3u8?sig=hls-secret',
              headers,
            },
          },
        },
        {
          id: 'direct-360',
          label: '360P',
          height: 360,
          container: 'mp4',
          source: {
            kind: 'direct',
            stream: {
              url: 'https://cdn.example/360.mp4?sig=direct-secret',
              mirrors: ['https://mirror.example/360.mp4?sig=direct-secret'],
              headers,
            },
          },
        },
      ],
    },
    { id: 'p2', index: 2, title: 'Middle', current: true },
    {
      id: 'p3',
      index: 3,
      title: 'Members only',
      unavailable: { reason: 'paid-content', message: 'Join to watch' },
    },
  ],
}

describe('toMediaPreview', () => {
  it('never carries a stream URL, mirror, header or signature', () => {
    const preview = toMediaPreview(stored(series), {
      pluginName: 'Example resolver',
      ffmpegAvailable: true,
    })
    const text = JSON.stringify(preview)
    for (const host of SECRET_HOSTS) expect(text).not.toContain(host)
    expect(text).not.toMatch(/secret|sig=|token=|referer|user-agent/i)
  })

  it('describes entries and variants for the picker', () => {
    const preview = toMediaPreview(stored(series), {
      pluginName: 'Example resolver',
      ffmpegAvailable: true,
    })
    expect(preview).toMatchObject({
      resolutionId: '00000000-0000-4000-8000-000000000001',
      pluginId: 'example.media-resolver',
      pluginName: 'Example resolver',
      title: 'Series: one/two',
      defaultEntryId: 'p2',
      ffmpegAvailable: true,
      expiresAt: 123,
      auth: { state: 'anonymous', betterWithLogin: true },
      folderName: 'Series_ one_two',
      warnAboveParts: 50,
    })
    const [first, second, third] = preview.entries
    expect(first).toMatchObject({
      id: 'p1',
      index: 1,
      title: 'Opening',
      durationSec: 61,
      current: false,
    })
    expect(first.variants).toEqual([
      {
        id: 'hd',
        label: '1080P',
        height: 1080,
        container: 'mp4',
        locked: 'premium',
        requiresFfmpeg: false,
        recommended: false,
      },
      {
        id: 'mux-720',
        label: '720P',
        height: 720,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'mp4a',
        sizeBytes: 1000,
        container: 'mp4',
        requiresFfmpeg: true,
        recommended: true,
      },
      expect.objectContaining({ id: 'hls-480', requiresFfmpeg: true }),
      expect.objectContaining({ id: 'direct-360', requiresFfmpeg: false }),
    ])
    // Deferred entries load later; unavailable ones explain why.
    expect(second).toMatchObject({ id: 'p2', current: true, variants: null })
    expect(third).toMatchObject({
      unavailable: { reason: 'paid-content', message: 'Join to watch' },
      variants: [],
    })
  })

  it('recommends the variant a create would download without FFmpeg', () => {
    const preview = toMediaPreview(stored(series), {
      pluginName: 'Example resolver',
      ffmpegAvailable: false,
    })
    const recommended = preview.entries[0].variants?.filter(
      (v) => v.recommended
    )
    expect(recommended?.map((v) => v.id)).toEqual(['direct-360'])
  })

  it('has no folder name when the resolver gave no usable title', () => {
    const untitled = toMediaPreview(stored({ ...series, title: '' }), {
      pluginName: 'Example resolver',
      ffmpegAvailable: true,
    })
    expect(untitled.folderName).toBeNull()
  })
})
