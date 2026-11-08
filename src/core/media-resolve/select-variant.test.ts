import { describe, expect, it } from 'vitest'
import type { ResolvedMedia } from './media-resolve-service'
import { selectVariant } from './select-variant'
import type { MediaEntry, MediaVariant } from './site-resolution'

const stream = (tag: string) => ({ url: `https://cdn.media.test/${tag}` })
const direct = (id: string, height?: number): MediaVariant => ({
  id,
  label: id,
  container: 'mp4',
  ...(height ? { height } : {}),
  source: { kind: 'direct', stream: stream(id) },
})
const mux = (id: string, height?: number): MediaVariant => ({
  id,
  label: id,
  container: 'mkv',
  ...(height ? { height } : {}),
  source: { kind: 'mux', video: stream(`${id}/v`), audio: stream(`${id}/a`) },
})
const locked = (id: string): MediaVariant => ({
  id,
  label: id,
  container: 'mp4',
  locked: 'premium',
})

function media(entries: MediaEntry[]): ResolvedMedia {
  return {
    pluginId: 'example.media-resolver',
    sourceUrl: 'https://www.media.test/watch/abc123',
    resolvedAt: 1,
    resolution: { kind: 'media', schemaVersion: 1, title: 'C', entries },
  }
}

const ok = (result: ReturnType<typeof selectVariant>) =>
  result.kind === 'ok' ? `${result.entry.id}/${result.variant.id}` : result

describe('selectVariant', () => {
  it('defaults to the current entry, else the first', () => {
    const variants = [direct('d')]
    expect(
      ok(
        selectVariant(
          media([
            { id: 'a', title: 'A', variants },
            { id: 'b', title: 'B', current: true, variants },
          ]),
          undefined,
          true
        )
      )
    ).toBe('b/d')
    expect(
      ok(
        selectVariant(
          media([
            { id: 'a', title: 'A', variants },
            { id: 'b', title: 'B', variants },
          ]),
          undefined,
          true
        )
      )
    ).toBe('a/d')
  })

  it('takes the first usable variant, skipping locked ones', () => {
    const m = media([
      {
        id: 'a',
        title: 'A',
        variants: [locked('4k'), mux('1080'), direct('720')],
      },
    ])
    expect(ok(selectVariant(m, undefined, true))).toBe('a/1080')
  })

  it('prefers a direct variant when FFmpeg is missing', () => {
    const m = media([
      { id: 'a', title: 'A', variants: [mux('1080'), direct('720')] },
    ])
    expect(ok(selectVariant(m, undefined, false))).toBe('a/720')
  })

  it('reports ffmpeg-required when only FFmpeg variants were usable', () => {
    const m = media([
      { id: 'a', title: 'A', variants: [locked('4k'), mux('1080')] },
    ])
    expect(() => selectVariant(m, undefined, false)).toThrow(
      expect.objectContaining({ failure: 'ffmpeg-required' })
    )
  })

  it('reports no-playable-variant when nothing is usable', () => {
    const m = media([{ id: 'a', title: 'A', variants: [locked('4k')] }])
    expect(() => selectVariant(m, undefined, true)).toThrow(
      expect.objectContaining({ failure: 'no-playable-variant' })
    )
    expect(() =>
      selectVariant(
        media([{ id: 'a', title: 'A', variants: [] }]),
        undefined,
        true
      )
    ).toThrow(expect.objectContaining({ failure: 'no-playable-variant' }))
  })

  it('applies maxHeight, keeping variants without a height', () => {
    const m = media([
      {
        id: 'a',
        title: 'A',
        variants: [mux('2160', 2160), mux('1080', 1080), direct('x')],
      },
    ])
    expect(ok(selectVariant(m, { maxHeight: 1080 }, true))).toBe('a/1080')
    expect(ok(selectVariant(m, { maxHeight: 480 }, true))).toBe('a/x')
  })

  it('honors an explicit entry and variant pick', () => {
    const m = media([
      { id: 'a', title: 'A', current: true, variants: [direct('d')] },
      { id: 'b', title: 'B', variants: [mux('m'), direct('d2')] },
    ])
    expect(ok(selectVariant(m, { entryId: 'b', variantId: 'd2' }, true))).toBe(
      'b/d2'
    )
    expect(() =>
      selectVariant(m, { entryId: 'b', variantId: 'missing' }, true)
    ).toThrow(expect.objectContaining({ failure: 'no-playable-variant' }))
  })

  it('asks for the entry when its variants were deferred', () => {
    const m = media([{ id: 'a', title: 'A', current: true }])
    expect(selectVariant(m, undefined, true)).toEqual({
      kind: 'needs-entries',
      entryId: 'a',
    })
  })

  it('fails an unavailable entry with its reason', () => {
    const m = media([
      { id: 'a', title: 'A', unavailable: { reason: 'paid-content' } },
    ])
    expect(() => selectVariant(m, undefined, true)).toThrow(
      expect.objectContaining({
        failure: 'unavailable',
        reason: 'paid-content',
      })
    )
  })
})
