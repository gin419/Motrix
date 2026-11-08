import { task } from '@shared/locales/en-US.json'

/**
 * English text for a `task.*` i18n key, with `{{name}}` values filled in;
 * any other or unknown key comes back unchanged.
 *
 * The headless server has no host translator, yet a bridge client shows the
 * rejection message of a failed site resolution to its user verbatim. Only
 * the `task` subtree of the English catalog is bundled for this, which
 * holds every site-resolution message key.
 */
export function translateMediaResolveText(
  key: string,
  values?: Readonly<Record<string, string>>
): string {
  const [root, ...path] = key.split('.')
  if (root !== 'task' || path.length === 0) return key
  let node: unknown = task
  for (const part of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part))
      return key
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node !== 'string') return key
  return node.replace(
    /\{\{(\w+)\}\}/g,
    (placeholder, name: string) => values?.[name] ?? placeholder
  )
}
