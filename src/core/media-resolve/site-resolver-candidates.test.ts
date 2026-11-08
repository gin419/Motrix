import { describe, expect, it } from 'vitest'
import { siteResolverCandidates } from './site-resolver-candidates'

function resolver(id: string, hostPermissions: string[]) {
  return {
    manifest: {
      id,
      name: id,
      categories: ['site-resolver'],
      hostPermissions,
      contributes: {
        commands: [{ id: `${id}.resolve`, title: 'resolve', public: true }],
      },
    },
    origin: 'community',
    enabled: true,
  }
}

const registry = (...entries: ReturnType<typeof resolver>[]) =>
  ({ entries: () => entries }) as never

const PAGE = 'https://www.media.test/watch/1'

describe('siteResolverCandidates', () => {
  it.each([['<all_urls>'], ['*://*/*'], ['https://*/*'], ['*://*/watch/*']])(
    'never offers a resolver whose only match is %s',
    (pattern) => {
      expect(
        siteResolverCandidates(
          registry(resolver('example.any', [pattern])),
          PAGE
        )
      ).toEqual([])
    }
  )

  it.each([
    ['*://*.com/*', 'https://bank.example.com/statement.pdf'],
    ['https://*.test/*', PAGE],
    ['*://*.co.uk/*', 'https://shop.example.co.uk/item'],
    ['*://*.com.au/*', 'https://news.example.com.au/a'],
    ['*://*.ne.jp/*', 'https://www.example.ne.jp/a'],
  ])(
    'never offers a resolver that claims the public suffix of %s',
    (pattern, url) => {
      expect(
        siteResolverCandidates(
          registry(resolver('example.suffix', [pattern])),
          url
        )
      ).toEqual([])
    }
  )

  it.each([
    ['*://*.media.test/*', PAGE],
    ['*://*.example.co.uk/*', 'https://shop.example.co.uk/item'],
    ['*://*.video.example/*', 'https://www.video.example/watch/1'],
  ])('offers a resolver that names its site with %s', (pattern, url) => {
    const named = resolver('example.named', [pattern])
    expect(siteResolverCandidates(registry(named), url)).toEqual([named])
  })

  it('matches a resolver on its named hosts even next to a match-all pattern', () => {
    const named = resolver('example.media-resolver', [
      '*://*/*',
      '*://*.media.test/*',
    ])
    expect(siteResolverCandidates(registry(named), PAGE)).toEqual([named])
    expect(
      siteResolverCandidates(registry(named), 'https://other.example/watch/1')
    ).toEqual([])
  })
})
