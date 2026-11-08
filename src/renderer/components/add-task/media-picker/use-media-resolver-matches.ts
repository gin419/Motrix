import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import type {
  MatchMediaResolversResult,
  MediaResolverMatch,
} from '@shared/schemas/media-resolution'
import { useEffect, useMemo, useState } from 'react'
import { parseUrlLines } from '../url-interpreters/multiline-url'

/** Debounce between the last edit and the registry lookup. */
export const MATCH_DEBOUNCE_MS = 300
/** The request schema's limit on URLs per lookup. */
const MAX_URLS = 64

export interface MediaLineMatch {
  /** Zero-based line in the URL field. */
  line: number
  url: string
  match: MediaResolverMatch
}

/**
 * The URL lines an installed site resolver claims. A registry lookup only
 * (no plugin runs), debounced while the user types. Results are kept per
 * URL, so a line keeps its chip while other lines change.
 */
export function useMediaResolverMatches(
  urls: string,
  enabled: boolean
): MediaLineMatch[] {
  const candidates = useMemo(() => {
    if (!enabled) return []
    const seen = new Set<string>()
    return parseUrlLines(urls).filter((line) => {
      if (!line.valid || !/^https?:\/\//i.test(line.url)) return false
      if (seen.has(line.url)) return false
      seen.add(line.url)
      return true
    })
  }, [urls, enabled])
  const key = candidates
    .slice(0, MAX_URLS)
    .map((line) => line.url)
    .join('\n')
  const [known, setKnown] = useState<
    ReadonlyMap<string, MediaResolverMatch | null>
  >(() => new Map())

  useEffect(() => {
    if (!key) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const requested = key.split('\n')
      try {
        const result = (await transport.invoke(Queries.MatchMediaResolvers, {
          urls: requested,
        })) as MatchMediaResolversResult | undefined
        if (cancelled) return
        const matches = Array.isArray(result?.matches) ? result.matches : []
        setKnown(
          new Map(
            requested.map((url, index) => {
              const match = matches[index]
              return [
                url,
                match &&
                typeof match.pluginId === 'string' &&
                typeof match.pluginName === 'string'
                  ? match
                  : null,
              ]
            })
          )
        )
      } catch (error) {
        // The chip is optional: a plain submit still resolves the page.
        console.error(error)
      }
    }, MATCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key])

  return useMemo(
    () =>
      candidates.flatMap((line) => {
        const match = known.get(line.url)
        return match ? [{ line: line.line, url: line.url, match }] : []
      }),
    [candidates, known]
  )
}
