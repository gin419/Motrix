import { BridgeReceiverError } from '@core/bridge-receiver/errors'
import {
  directVariant,
  fakeMediaTarget,
  manifestVariant,
  muxVariant,
} from '@test-utils/media-resolve'
import { describe, expect, it } from 'vitest'
import { dispatchMediaVariant, planMediaName } from './dispatch-variant'
import type { ResolvedMedia } from './media-resolve-service'
import type { MediaEntry, MediaVariant } from './site-resolution'

const base = {
  taskId: 'task-1',
  saveDir: '/downloads',
  finalName: 'Clip.mp4',
  sourceMeta: null,
}

const variant = (raw: unknown) => raw as MediaVariant

describe('dispatchMediaVariant', () => {
  it('returns a direct variant as uris and headers for the caller’s HTTP path', async () => {
    const target = fakeMediaTarget()
    const outcome = await dispatchMediaVariant(
      variant(
        directVariant('https://cdn.example/a.mp4', {
          mirrors: ['https://cdn.example/a.mp4', 'https://m.example/a.mp4'],
          headers: { Referer: 'https://video.example/' },
        })
      ),
      base,
      undefined
    )
    expect(outcome).toEqual({
      kind: 'rewriteDirect',
      uris: ['https://cdn.example/a.mp4', 'https://m.example/a.mp4'],
      headers: { Referer: 'https://video.example/' },
    })
    expect(target.mux.dispatch).not.toHaveBeenCalled()
  })

  it('dispatches a mux variant with the receipt and duration', async () => {
    const target = fakeMediaTarget()
    const receipt = { createRequestId: 'r', createRequestFingerprint: 'f' }
    const outcome = await dispatchMediaVariant(
      variant(
        muxVariant('https://cdn.example/v', 'https://cdn.example/a', {
          Referer: 'https://video.example/',
        })
      ),
      { ...base, receipt: receipt as never, durationSec: 12 },
      target
    )
    expect(outcome).toEqual({ kind: 'dispatched', taskId: 'mux-task' })
    expect(target.mux.dispatch).toHaveBeenCalledExactlyOnceWith({
      kind: 'mux',
      taskId: 'task-1',
      saveDir: '/downloads',
      finalName: 'Clip.mp4',
      sourceMeta: null,
      receipt,
      durationSec: 12,
      videoUrl: 'https://cdn.example/v',
      audioUrl: 'https://cdn.example/a',
      sanitizedHeaders: { Referer: 'https://video.example/' },
      container: 'mp4',
    })
  })

  it.each([
    ['hls', 'ts', 'ts'],
    ['dash', 'ts', 'mp4'],
    ['dash', 'mkv', 'mkv'],
  ] as const)(
    'dispatches a %s variant (%s) to the HLS/DASH pipeline as %s',
    async (kind, container, expected) => {
      const target = fakeMediaTarget()
      const raw = {
        ...manifestVariant(kind, `https://cdn.example/${kind}`),
        container,
      }
      await dispatchMediaVariant(variant(raw), base, target)
      expect(target.hlsDash.dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind,
          manifestUrl: `https://cdn.example/${kind}`,
          container: expected,
        })
      )
    }
  )

  it('uses the fallback headers only for a stream that declares none', async () => {
    const fallbackHeaders = { Referer: 'https://video.example/page' }
    const declared = await dispatchMediaVariant(
      variant(
        directVariant('https://cdn.example/a.mp4', {
          headers: { Origin: 'https://video.example' },
        })
      ),
      { ...base, fallbackHeaders },
      undefined
    )
    expect(declared).toMatchObject({
      headers: { Origin: 'https://video.example' },
    })
    const bare = await dispatchMediaVariant(
      variant(directVariant('https://cdn.example/a.mp4')),
      { ...base, fallbackHeaders },
      undefined
    )
    expect(bare).toMatchObject({ headers: fallbackHeaders })
  })

  it('rejects a pipeline variant without a media runtime as unsupported-kind', async () => {
    await expect(
      dispatchMediaVariant(
        variant(manifestVariant('hls', 'https://cdn.example/x')),
        base,
        undefined
      )
    ).rejects.toEqual(expect.any(BridgeReceiverError))
  })
})

describe('planMediaName', () => {
  const entry = (raw: Partial<MediaEntry>): MediaEntry =>
    ({ id: 'e', title: '', ...raw }) as MediaEntry
  const media = (title: string, entries: MediaEntry[]): ResolvedMedia => ({
    pluginId: 'example.media-resolver',
    sourceUrl: 'https://video.example/watch/1',
    resolvedAt: 0,
    resolution: { kind: 'media', schemaVersion: 1, title, entries },
  })
  const mux = variant(muxVariant('https://c/v', 'https://c/a'))

  it('names a single entry after the collection title', () => {
    const only = entry({ title: 'Clip' })
    expect(planMediaName(media('Clip', [only]), only, mux)).toBe('Clip.mp4')
  })

  it('numbers an entry of a multi-part resolution', () => {
    const first = entry({ id: 'a', index: 1, title: 'Intro' })
    const second = entry({ id: 'b', title: 'Show' })
    const m = media('Show', [first, second])
    expect(planMediaName(m, first, mux)).toBe('Show - P1 Intro.mp4')
    // No index: the position; a title equal to the collection is dropped.
    expect(planMediaName(m, second, mux)).toBe('Show - P2.mp4')
  })

  it('keeps a direct ts file as .ts and does not repeat an extension', () => {
    const only = entry({ title: 'Clip.mp4' })
    const ts = variant({
      ...directVariant('https://c/x.ts'),
      container: 'ts',
    })
    expect(planMediaName(media('Clip', [only]), only, ts)).toBe('Clip.ts')
    expect(
      planMediaName(
        media('', [only]),
        only,
        variant(directVariant('https://c/x'))
      )
    ).toBe('Clip.mp4')
  })

  it('returns null when the resolver gave no usable title', () => {
    const only = entry({ title: '  ' })
    expect(planMediaName(media('', [only]), only, mux)).toBeNull()
  })

  it('clamps a long title to the filesystem byte limit and keeps the extension', () => {
    const only = entry({ title: 'x' })
    // 150 CJK characters: 450 UTF-8 bytes.
    const planned = planMediaName(media('视'.repeat(150), [only]), only, mux)
    expect(planned?.endsWith('.mp4')).toBe(true)
    // Room for ".motrix" and a " (N)" dedup suffix under NAME_MAX.
    const bytes = Buffer.byteLength(`${planned} (9999).motrix`)
    expect(bytes).toBeLessThanOrEqual(255)
  })

  it.each(['CON', 'nul', 'Com1'])(
    'never plans the Windows device name %s',
    (title) => {
      const only = entry({ title: 'x' })
      const planned = planMediaName(media(title, [only]), only, mux)
      expect(planned).toBe(`_${title}.mp4`)
    }
  )

  it('sanitizes characters a filesystem refuses', () => {
    const only = entry({ title: 'x' })
    expect(planMediaName(media('A/B: C?', [only]), only, mux)).toBe(
      'A_B_ C_.mp4'
    )
  })
})
