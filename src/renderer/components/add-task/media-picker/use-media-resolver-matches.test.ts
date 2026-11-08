import { Queries } from '@shared/protocol/queries'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MATCH_DEBOUNCE_MS,
  useMediaResolverMatches,
} from './use-media-resolver-matches'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: invokeMock, on: vi.fn(), off: vi.fn() },
}))

const resolver = { pluginId: 'example.media-resolver', pluginName: 'Example' }

function claimMediaTest() {
  invokeMock.mockImplementation(async (_channel: string, { urls }) => ({
    matches: urls.map((url: string) =>
      url.startsWith('https://media.test/') ? resolver : null
    ),
  }))
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MATCH_DEBOUNCE_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  invokeMock.mockReset()
})

describe('useMediaResolverMatches', () => {
  it('looks up the http lines once the user stops typing', async () => {
    claimMediaTest()
    const { result, rerender } = renderHook(
      ({ urls }) => useMediaResolverMatches(urls, true),
      { initialProps: { urls: 'https://media.test/w' } }
    )
    rerender({ urls: 'https://media.test/watch' })
    rerender({
      urls: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567\nhttps://example.com/a.zip\nhttps://media.test/watch/1',
    })
    expect(invokeMock).not.toHaveBeenCalled()
    await settle()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(Queries.MatchMediaResolvers, {
      urls: ['https://example.com/a.zip', 'https://media.test/watch/1'],
    })
    expect(result.current).toEqual([
      { line: 2, url: 'https://media.test/watch/1', match: resolver },
    ])
  })

  it('drops a reply that arrives after the lines changed', async () => {
    let answer!: (value: unknown) => void
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ urls }) => useMediaResolverMatches(urls, true),
      { initialProps: { urls: 'https://media.test/watch/1' } }
    )
    await settle()
    claimMediaTest()
    rerender({ urls: 'https://media.test/watch/1\nhttps://media.test/watch/2' })
    await settle()
    expect(result.current).toHaveLength(2)
    // The superseded lookup answers last, with an outdated view.
    await act(async () => {
      answer({ matches: [null] })
    })
    expect(result.current.map((match) => match.url)).toEqual([
      'https://media.test/watch/1',
      'https://media.test/watch/2',
    ])
  })

  it('treats a malformed reply as no match', async () => {
    invokeMock.mockResolvedValue({ gid: 'unrelated' })
    const { result } = renderHook(() =>
      useMediaResolverMatches('https://media.test/watch/1', true)
    )
    await settle()
    expect(result.current).toEqual([])
  })

  it('does nothing while disabled', async () => {
    claimMediaTest()
    const { result } = renderHook(() =>
      useMediaResolverMatches('https://media.test/watch/1', false)
    )
    await settle()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })
})
