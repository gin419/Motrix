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
 * A pattern that admits every host: `<all_urls>` or any pattern whose host
 * is a bare `*`.
 * Resolution runs on every pasted HTTP URL, so a resolver must name the
 * sites it handles; a match-all pattern never makes it a candidate. The
 * same plugin may still use such a pattern for its own HTTP calls.
 */
function admitsEveryHost(pattern: string): boolean {
  return parseHostPermissionPattern(pattern)?.host.kind === 'any'
}

/**
 * Enabled site resolvers with a resolve command whose manifest
 * hostPermissions — match-all patterns excluded — admit `url`, in a
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
          e.manifest.hostPermissions?.filter((p) => !admitsEveryHost(p)),
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
