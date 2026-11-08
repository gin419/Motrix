import { urlMatchesHostPermissions } from '@core/plugin/hooks/eligibility'
import { parseHostPermissionPattern } from '@core/plugin/permissions/host-pattern'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import type { PluginManifest } from '@shared/types/plugin'

export type SiteResolverRegistry = Pick<PluginRegistry, 'entries'>
export type SiteResolverEntry = ReturnType<PluginRegistry['entries']>[number]

/**
 * A plugin contributes to the site-resolve seam when it is an enabled
 * `site-resolver` that declares a PUBLIC command whose id is
 * `${manifest.id}.resolve` — the resolve-command marker.
 *
 * Keying off this marker (not the `site-resolver` category alone) is the
 * load-bearing distinction: a plugin can be a `site-resolver` whose
 * hostPermissions match all URLs and still have NO resolve command (it works
 * through the `beforeCreate` hook instead). Deriving seam membership from
 * the category alone would let such a plugin collapse routing to
 * match-everything and send every download through a resolver VM.
 */
export function contributesResolveCommand(manifest: PluginManifest): boolean {
  const commands = manifest.contributes?.commands ?? []
  const marker = `${manifest.id}.resolve`
  return commands.some((c) => c.public === true && c.id === marker)
}

/**
 * Second-level labels that registries use under a country-code TLD
 * (`co.uk`, `com.au`, `ne.jp`, …). The host carries no public-suffix list;
 * together with the single-label rule this covers the suffixes a resolver
 * could claim to match most of the web.
 */
const REGISTRY_SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set([
  'ac',
  'biz',
  'co',
  'com',
  'edu',
  'go',
  'gob',
  'gouv',
  'gov',
  'gv',
  'info',
  'ltd',
  'mil',
  'ne',
  'net',
  'nic',
  'nom',
  'or',
  'org',
  'plc',
  'sch',
])

/**
 * Whether a `*.<suffix>` wildcard covers a whole public suffix rather than
 * one site: a single label (`*.com`), a registry second level under a
 * country code (`*.co.uk`), or numeric labels only.
 */
function isPublicSuffixWildcard(suffix: string): boolean {
  const labels = suffix.split('.')
  if (labels.length === 1) return true
  if (labels.every((label) => /^\d+$/.test(label))) return true
  return (
    labels.length === 2 &&
    REGISTRY_SECOND_LEVEL_LABELS.has(labels[0] ?? '') &&
    /^[a-z]{2}$/.test(labels[1] ?? '')
  )
}

/**
 * A pattern that claims every host, or every host under a public suffix:
 * `<all_urls>`, a bare `*` host, or `*.com` / `*.co.uk`.
 * Resolution runs on every pasted HTTP URL, so a resolver must name the
 * sites it handles; such a pattern never makes it a candidate. The same
 * plugin may still use the pattern for its own HTTP calls.
 */
function claimsTooManyHosts(pattern: string): boolean {
  const host = parseHostPermissionPattern(pattern)?.host
  if (!host) return false
  if (host.kind === 'any') return true
  return host.kind === 'subdomain' && isPublicSuffixWildcard(host.value)
}

/**
 * Enabled site resolvers with a resolve command whose manifest
 * hostPermissions — match-all and public-suffix patterns excluded — admit
 * `url`, in a
 * deterministic order: builtin origin before community, then by id. No
 * plugin id is hardcoded — the host ships no site knowledge; a resolver
 * contributes its own hostPermissions.
 */
export function siteResolverCandidates(
  registry: SiteResolverRegistry,
  url: string
): SiteResolverEntry[] {
  return registry
    .entries()
    .filter(
      (e) =>
        e.enabled &&
        (e.manifest.categories ?? []).includes('site-resolver') &&
        contributesResolveCommand(e.manifest) &&
        urlMatchesHostPermissions(
          e.manifest.hostPermissions?.filter((p) => !claimsTooManyHosts(p)),
          url
        )
    )
    .sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'builtin' ? -1 : 1
      return a.manifest.id < b.manifest.id
        ? -1
        : a.manifest.id > b.manifest.id
          ? 1
          : 0
    })
}
