import { describe, expect, it } from 'vitest'
import {
  isEntryDeferred,
  parseSiteResolveResult,
  SITE_RESOLUTION_LIMITS,
  type SiteResolveParse,
} from './site-resolution'

const VIDEO = 'https://cdn.media.test/v/1080.m4s'
const AUDIO = 'https://cdn.media.test/a/hi.m4s'

function v1(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'media',
    schemaVersion: 1,
    title: 'Example collection',
    entries: [
      {
        id: 'part:1',
        index: 1,
        title: 'Part one',
        current: true,
        variants: [
          {
            id: 'q1080',
            label: '1080P',
            height: 1080,
            container: 'mp4',
            source: {
              kind: 'mux',
              video: {
                url: VIDEO,
                mirrors: ['https://mirror.media.test/v/1080.m4s'],
                headers: { Referer: 'https://media.test/' },
              },
              audio: { url: AUDIO },
            },
          },
          { id: 'q4k', label: '4K', container: 'mp4', locked: 'premium' },
        ],
      },
      { id: 'part:2', index: 2, title: 'Part two' },
    ],
    ...overrides,
  }
}

function withVariant(variant: Record<string, unknown>) {
  return v1({
    entries: [{ id: 'only', title: 'Only', variants: [variant] }],
  })
}

function expectInvalid(result: SiteResolveParse): string[] {
  expect(result.kind).toBe('invalid')
  return result.kind === 'invalid' ? result.issues : []
}

describe('parseSiteResolveResult', () => {
  it('treats null and undefined as a decline', () => {
    expect(parseSiteResolveResult(null)).toEqual({ kind: 'declined' })
    expect(parseSiteResolveResult(undefined)).toEqual({ kind: 'declined' })
  })

  it('normalizes a legacy mux pair to one current entry with a default variant', () => {
    const result = parseSiteResolveResult({
      kind: 'mux',
      video: { url: VIDEO, headers: { Referer: 'https://media.test/' } },
      audio: { url: AUDIO },
      container: 'mkv',
      title: 'Legacy title',
    })
    expect(result).toEqual({
      kind: 'media',
      resolution: {
        kind: 'media',
        schemaVersion: 1,
        title: 'Legacy title',
        entries: [
          {
            id: 'default',
            title: 'Legacy title',
            current: true,
            variants: [
              {
                id: 'default',
                label: 'Default',
                container: 'mkv',
                source: {
                  kind: 'mux',
                  video: {
                    url: VIDEO,
                    headers: { Referer: 'https://media.test/' },
                  },
                  // The legacy pair carried one header set for both legs.
                  audio: {
                    url: AUDIO,
                    headers: { Referer: 'https://media.test/' },
                  },
                },
              },
            ],
          },
        ],
      },
    })
  })

  it('accepts null optional fields in legacy and versioned results', () => {
    const legacy = parseSiteResolveResult({
      kind: 'mux',
      video: { url: VIDEO, headers: null },
      audio: { url: AUDIO },
      container: null,
      title: null,
    })
    expect(legacy.kind).toBe('media')
    if (legacy.kind === 'media') {
      expect(legacy.resolution.title).toBe('')
      expect(legacy.resolution.entries[0]?.variants?.[0]?.container).toBe('mp4')
    }
    const versioned = parseSiteResolveResult(
      v1({ expiresAt: null, auth: null })
    )
    expect(versioned.kind).toBe('media')
  })

  it('accepts a versioned result and keeps deferred entries deferred', () => {
    const result = parseSiteResolveResult(v1())
    expect(result.kind).toBe('media')
    if (result.kind !== 'media') return
    const [first, second] = result.resolution.entries
    expect(first?.variants).toHaveLength(2)
    expect(first && isEntryDeferred(first)).toBe(false)
    expect(second && isEntryDeferred(second)).toBe(true)
  })

  it('returns an unavailable result with its reason', () => {
    expect(
      parseSiteResolveResult({
        kind: 'unavailable',
        reason: 'login-required',
        message: 'Sign in\nfirst',
      })
    ).toEqual({
      kind: 'unavailable',
      reason: 'login-required',
      message: 'Sign in first',
    })
    expectInvalid(
      parseSiteResolveResult({ kind: 'unavailable', reason: 'Not A Token' })
    )
  })

  it('rejects any stream header outside the allowlist', () => {
    const issues = expectInvalid(
      parseSiteResolveResult(
        withVariant({
          id: 'a',
          label: 'A',
          container: 'mp4',
          source: {
            kind: 'direct',
            stream: {
              url: VIDEO,
              headers: { Referer: 'https://media.test/', Cookie: 'sid=secret' },
            },
          },
        })
      )
    )
    expect(issues).toEqual([
      'entries.0.variants.0.source.stream.headers: header not allowed',
    ])
    expect(issues.join(' ')).not.toContain('secret')
  })

  it('drops legacy headers outside the allowlist instead of failing the result', () => {
    // A pre-contract resolver keeps working with the headers the host allows;
    // the others never reach a stream request.
    const result = parseSiteResolveResult({
      kind: 'mux',
      video: {
        url: VIDEO,
        headers: {
          referer: 'https://media.test/',
          Cookie: 'sid=secret',
          Authorization: 'Bearer secret',
          'X-Site-Token': 'secret',
        },
      },
      audio: { url: AUDIO },
    })
    expect(result.kind).toBe('media')
    const source =
      result.kind === 'media'
        ? result.resolution.entries[0]?.variants?.[0]?.source
        : undefined
    expect(source).toEqual({
      kind: 'mux',
      video: { url: VIDEO, headers: { referer: 'https://media.test/' } },
      audio: { url: AUDIO, headers: { referer: 'https://media.test/' } },
    })
  })

  it('omits legacy headers entirely when none are allowlisted', () => {
    const result = parseSiteResolveResult({
      kind: 'mux',
      video: { url: VIDEO, headers: { Authorization: 'Bearer secret' } },
      audio: { url: AUDIO },
    })
    const source =
      result.kind === 'media'
        ? result.resolution.entries[0]?.variants?.[0]?.source
        : undefined
    expect(source).toEqual({
      kind: 'mux',
      video: { url: VIDEO },
      audio: { url: AUDIO },
    })
  })

  it.each([
    ['LF', 'https://media.test/\nCookie: sid=secret'],
    ['CRLF', 'https://media.test/\r\nAuthorization: Bearer secret'],
    ['NUL', 'https://media.test/\u0000secret'],
    ['DEL', 'https://media.test/\u007fsecret'],
  ])('rejects a %s inside an allowlisted header value', (_name, value) => {
    const versioned = expectInvalid(
      parseSiteResolveResult(
        withVariant({
          id: 'a',
          label: 'A',
          container: 'mp4',
          source: {
            kind: 'direct',
            stream: { url: VIDEO, headers: { Referer: value } },
          },
        })
      )
    )
    expect(versioned.join(' ')).toContain('headers')
    expect(versioned.join(' ')).not.toContain('secret')
    const legacy = expectInvalid(
      parseSiteResolveResult({
        kind: 'mux',
        video: { url: VIDEO, headers: { 'User-Agent': value } },
        audio: { url: AUDIO },
      })
    )
    expect(legacy.join(' ')).not.toContain('secret')
  })

  it('accepts a tab inside a header value', () => {
    const result = parseSiteResolveResult(
      withVariant({
        id: 'a',
        label: 'A',
        container: 'mp4',
        source: {
          kind: 'direct',
          stream: { url: VIDEO, headers: { 'User-Agent': 'Agent/1.0\t(x)' } },
        },
      })
    )
    expect(result.kind).toBe('media')
  })

  it.each([
    'Referer: secret',
    'Referer\nsecret',
    'Ref secret',
    'Referer\u0000secret',
  ])('rejects a header name that is not an HTTP token (%j)', (name) => {
    const versioned = expectInvalid(
      parseSiteResolveResult(
        withVariant({
          id: 'a',
          label: 'A',
          container: 'mp4',
          source: {
            kind: 'direct',
            stream: { url: VIDEO, headers: { [name]: 'https://media.test/' } },
          },
        })
      )
    )
    expect(versioned).toEqual([
      'entries.0.variants.0.source.stream.headers: invalid_key',
    ])
    const legacy = expectInvalid(
      parseSiteResolveResult({
        kind: 'mux',
        video: { url: VIDEO, headers: { [name]: 'https://media.test/' } },
        audio: { url: AUDIO },
      })
    )
    expect(legacy.join(' ')).not.toContain('secret')
  })

  it('matches allowlisted header names case-insensitively', () => {
    const result = parseSiteResolveResult(
      withVariant({
        id: 'a',
        label: 'A',
        container: 'mp4',
        source: {
          kind: 'hls',
          manifest: {
            url: 'https://cdn.media.test/master.m3u8',
            headers: {
              'USER-AGENT': 'Agent/1.0',
              origin: 'https://media.test',
            },
          },
        },
      })
    )
    expect(result.kind).toBe('media')
  })

  it('requires a source unless the variant is locked, and forbids one when it is', () => {
    expectInvalid(
      parseSiteResolveResult(
        withVariant({ id: 'a', label: 'A', container: 'mp4' })
      )
    )
    expectInvalid(
      parseSiteResolveResult(
        withVariant({
          id: 'a',
          label: 'A',
          container: 'mp4',
          locked: 'login',
          source: { kind: 'direct', stream: { url: VIDEO } },
        })
      )
    )
    expect(
      parseSiteResolveResult(
        withVariant({ id: 'a', label: 'A', container: 'mp4', locked: 'login' })
      ).kind
    ).toBe('media')
  })

  it('rejects a mux variant in a ts container', () => {
    const issues = expectInvalid(
      parseSiteResolveResult(
        withVariant({
          id: 'a',
          label: 'A',
          container: 'ts',
          source: {
            kind: 'mux',
            video: { url: VIDEO },
            audio: { url: AUDIO },
          },
        })
      )
    )
    expect(issues).toEqual(['entries.0.variants.0.container: custom'])
  })

  it('rejects stream urls that are not admissible http sources', () => {
    for (const url of ['ftp://cdn.media.test/v.mp4', 'not a url']) {
      const issues = expectInvalid(
        parseSiteResolveResult(
          withVariant({
            id: 'a',
            label: 'A',
            container: 'mp4',
            source: {
              kind: 'direct',
              stream: { url: VIDEO, mirrors: [url] },
            },
          })
        )
      )
      expect(issues).toEqual([
        'entries.0.variants.0.source.stream.mirrors.0: inadmissible source',
      ])
    }
  })

  it('enforces collection limits', () => {
    const entries = Array.from(
      { length: SITE_RESOLUTION_LIMITS.entries + 1 },
      (_, i) => ({ id: `e${i}`, title: `E${i}` })
    )
    expectInvalid(parseSiteResolveResult(v1({ entries })))
    expectInvalid(parseSiteResolveResult(v1({ entries: [] })))
    expectInvalid(
      parseSiteResolveResult(
        withVariant({
          id: 'a',
          label: 'A',
          container: 'mp4',
          source: {
            kind: 'direct',
            stream: {
              url: VIDEO,
              mirrors: Array.from(
                { length: SITE_RESOLUTION_LIMITS.mirrorsPerStream + 1 },
                (_, i) => `https://m${i}.media.test/v.mp4`
              ),
            },
          },
        })
      )
    )
  })

  it('rejects duplicate ids and more than one current entry', () => {
    expectInvalid(
      parseSiteResolveResult(
        v1({
          entries: [
            { id: 'x', title: 'A' },
            { id: 'x', title: 'B' },
          ],
        })
      )
    )
    expectInvalid(
      parseSiteResolveResult(
        v1({
          entries: [
            { id: 'x', title: 'A', current: true },
            { id: 'y', title: 'B', current: true },
          ],
        })
      )
    )
  })

  it('rejects a result over the byte cap without validating it', () => {
    const issues = expectInvalid(
      parseSiteResolveResult(
        v1({ padding: 'x'.repeat(SITE_RESOLUTION_LIMITS.resultBytes) })
      )
    )
    expect(issues).toEqual([
      `result exceeds ${SITE_RESOLUTION_LIMITS.resultBytes} bytes`,
    ])
  })

  it('rejects unknown kinds and values that cannot be serialized', () => {
    expectInvalid(parseSiteResolveResult({ kind: 'direct', url: VIDEO }))
    const cyclic: Record<string, unknown> = { kind: 'media' }
    cyclic.self = cyclic
    expect(expectInvalid(parseSiteResolveResult(cyclic))).toEqual([
      'not serializable',
    ])
  })

  it('ignores a deeply nested unknown property without overflowing the stack', () => {
    let deep: unknown = null
    for (let depth = 0; depth < 20_000; depth += 1) deep = [deep]
    const result = parseSiteResolveResult(v1({ extra: deep }))
    expect(result.kind).toBe('media')
    expect(result.kind === 'media' && 'extra' in result.resolution).toBe(false)
  })

  it('reports a deeply nested schema field as invalid instead of throwing', () => {
    let deep: unknown = { kind: 'mux' }
    for (let depth = 0; depth < 20_000; depth += 1) deep = { nested: deep }
    expectInvalid(
      parseSiteResolveResult({
        kind: 'mux',
        video: deep,
        audio: { url: AUDIO },
      })
    )
  })

  it('removes control characters from titles', () => {
    const result = parseSiteResolveResult(
      v1({ title: 'Line\u0000one\u202e\tend ' })
    )
    expect(result.kind === 'media' && result.resolution.title).toBe(
      'Line one end'
    )
  })
})
