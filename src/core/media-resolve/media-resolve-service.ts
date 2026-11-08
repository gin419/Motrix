import { isCommandTimeoutError } from '@core/plugin/host/capability-bridge'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import { MediaResolveError } from '@core/task/media-resolve-error'
import {
  parseSiteResolveResult,
  RESOLVE_BUDGET_MS,
  type SiteResolutionV1,
  type SiteResolveArgs,
} from './site-resolution'
import {
  type SiteResolverRegistry,
  siteResolverCandidates,
} from './site-resolver-candidates'

export interface ResolvedMedia {
  pluginId: string
  sourceUrl: string
  resolvedAt: number
  resolution: SiteResolutionV1
}

export type ResolveOutcome =
  /** No candidate matched, or every candidate returned `null`. */
  | { kind: 'declined' }
  | { kind: 'resolved'; media: ResolvedMedia }
  | { kind: 'unavailable'; pluginId: string; reason: string; message?: string }

export interface ResolveOptions {
  /** Forwarded to the resolver only; never placed on stream requests. */
  cookieHeader?: string
  /** Follow-up call for entries whose variants were deferred. */
  entryIds?: string[]
  /** Restrict the call to one resolver (follow-ups stay on the same plugin). */
  pluginId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface MediaResolveService {
  /** Registry-only match; starts no plugin VM. */
  match(urls: string[]): Array<{ pluginId: string; pluginName: string } | null>
  /**
   * Run the matching resolvers in order until one answers. Faults (throw,
   * timeout, invalid result) are remembered and the next candidate is tried;
   * if no candidate answers, the first fault is thrown as MediaResolveError.
   * A URL a resolver claimed never silently degrades to a plain download.
   */
  resolve(url: string, options?: ResolveOptions): Promise<ResolveOutcome>
}

interface WarnLogger {
  warn(fields: Record<string, unknown>, msg: string): void
}

export interface MediaResolveServiceDeps {
  registry: SiteResolverRegistry
  host: Pick<PluginHost, 'activate' | 'invokeCommand'>
  /** The plugin's own log, so authors see why a result was rejected. */
  pluginLog?: (pluginId: string) => {
    warn(msg: string, fields?: Record<string, unknown>): void
  }
  log?: WarnLogger
  now?: () => number
}

export function makeMediaResolveService(
  deps: MediaResolveServiceDeps
): MediaResolveService {
  const now = deps.now ?? Date.now

  return {
    match(urls) {
      return urls.map((url) => {
        const [first] = siteResolverCandidates(deps.registry, url)
        return first
          ? { pluginId: first.manifest.id, pluginName: first.manifest.name }
          : null
      })
    },

    async resolve(url, options = {}) {
      const candidates = siteResolverCandidates(deps.registry, url).filter(
        (e) => !options.pluginId || e.manifest.id === options.pluginId
      )
      const args: SiteResolveArgs = { url }
      // A resolver whose argsSchema omits `cookies` or `entryIds`
      // (additionalProperties:false) must not receive an undefined key.
      if (options.cookieHeader) args.cookies = options.cookieHeader
      if (options.entryIds) args.entryIds = options.entryIds
      const timeoutMs =
        options.timeoutMs ??
        (options.entryIds
          ? RESOLVE_BUDGET_MS.entries
          : RESOLVE_BUDGET_MS.resolve)

      let firstFailure: MediaResolveError | null = null
      for (const entry of candidates) {
        const id = entry.manifest.id
        let raw: unknown
        try {
          await deps.host.activate(id)
          raw = await deps.host.invokeCommand(id, `${id}.resolve`, args, {
            timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
          })
        } catch (err) {
          const failure = isCommandTimeoutError(err)
            ? 'timeout'
            : 'command-failed'
          deps.log?.warn(
            {
              pluginId: id,
              host: safeUrlHost(url),
              failure,
              err: err instanceof Error ? err.message : String(err),
            },
            'site resolver failed'
          )
          const error = new MediaResolveError(id, failure, err)
          // A cancelled call ends the whole resolve; no other candidate runs.
          if (options.signal?.aborted) throw error
          firstFailure ??= error
          continue
        }

        const parsed = parseSiteResolveResult(raw)
        if (parsed.kind === 'declined') continue
        if (parsed.kind === 'invalid') {
          deps.log?.warn(
            { pluginId: id, host: safeUrlHost(url) },
            'site resolver returned an unsupported result'
          )
          deps.pluginLog?.(id).warn('resolve result rejected by the host', {
            issues: parsed.issues.slice(0, 20),
          })
          firstFailure ??= new MediaResolveError(id, 'invalid-result')
          continue
        }
        if (parsed.kind === 'unavailable') {
          return {
            kind: 'unavailable',
            pluginId: id,
            reason: parsed.reason,
            ...(parsed.message ? { message: parsed.message } : {}),
          }
        }
        return {
          kind: 'resolved',
          media: {
            pluginId: id,
            sourceUrl: url,
            resolvedAt: now(),
            resolution: parsed.resolution,
          },
        }
      }
      if (firstFailure) throw firstFailure
      return { kind: 'declined' }
    },
  }
}

/**
 * Merge a follow-up resolution into `base`: entries that came back with
 * variants (or as unavailable) replace the same-id entries of `base`.
 */
export function mergeResolvedEntries(
  base: ResolvedMedia,
  update: ResolvedMedia
): ResolvedMedia {
  const updates = new Map(
    update.resolution.entries
      .filter((e) => e.variants !== undefined || e.unavailable !== undefined)
      .map((e) => [e.id, e])
  )
  return {
    ...base,
    resolvedAt: update.resolvedAt,
    resolution: {
      ...base.resolution,
      ...(update.resolution.expiresAt !== undefined
        ? { expiresAt: update.resolution.expiresAt }
        : {}),
      entries: base.resolution.entries.map((e) => {
        const next = updates.get(e.id)
        return next ? { ...e, ...next, current: e.current } : e
      }),
    },
  }
}

function safeUrlHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
