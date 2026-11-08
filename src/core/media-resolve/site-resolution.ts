import { stripHopByHopHeaders } from '@core/bridge-receiver/header-replay'
import { admitHttpSource } from '@core/task/source-admission'
import { z } from 'zod'

/**
 * Host ↔ plugin contract for a site resolver's `${id}.resolve` command.
 *
 * Plugin output is untrusted: `parseSiteResolveResult` is the only way a
 * result reaches task creation. It enforces a byte cap, validates the shape,
 * admits every stream URL as a task source, and restricts stream headers to
 * an allowlist. Nothing in this contract can describe a decryptor, key or
 * script — the host applies only what its pipelines already support.
 */

export const SITE_RESOLUTION_LIMITS = {
  resultBytes: 1_048_576,
  entries: 500,
  variantsPerEntry: 32,
  mirrorsPerStream: 4,
  headersPerStream: 8,
  headerValueChars: 2048,
  urlChars: 8192,
  idChars: 128,
  titleChars: 512,
  messageChars: 300,
  entryIdsPerCall: 50,
} as const

/** Per-call budgets for the initial resolve and a deferred-entries follow-up. */
export const RESOLVE_BUDGET_MS = { resolve: 45_000, entries: 30_000 } as const

/**
 * The only headers a resolver may attach to a stream request (matched
 * case-insensitively). Any other header makes the result invalid. Cookie and
 * Authorization never travel to CDN hosts; a resolver uses them only on its
 * own API calls.
 */
export const STREAM_HEADER_ALLOWLIST = [
  'referer',
  'origin',
  'user-agent',
  'accept',
  'accept-language',
] as const

/** Unavailability reasons the host has localized text for. */
export const KNOWN_UNAVAILABLE_REASONS = [
  'login-required',
  'premium-required',
  'paid-content',
  'preview-only',
  'drm',
  'encrypted',
  'geo-restricted',
  'rate-limited',
  'not-found',
  'removed',
  'live-unsupported',
  'unsupported',
] as const

const L = SITE_RESOLUTION_LIMITS

const idSchema = z.string().min(1).max(L.idChars)
const titleSchema = z.string().max(L.titleChars)
const urlSchema = z.string().min(1).max(L.urlChars)
const reasonSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const messageSchema = z.string().max(L.messageChars)

// RFC 9110 field-name token. Values may carry HTAB but no other C0 control or
// DEL: aria2 stores its `header` option newline-delimited, so a CR/LF inside
// one allowlisted value would smuggle extra request headers past the allowlist.
const headerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting header-splitting controls is the point.
const HEADER_VALUE_CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/
const headerValueSchema = z
  .string()
  .max(L.headerValueChars)
  .refine(
    (value) => !HEADER_VALUE_CONTROL_RE.test(value),
    'control character in header value'
  )

const headersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .refine((headers) => Object.keys(headers).length <= L.headersPerStream, {
    message: `at most ${L.headersPerStream} headers`,
  })

const streamRefSchema = z.object({
  url: urlSchema,
  mirrors: z.array(urlSchema).max(L.mirrorsPerStream).optional(),
  headers: headersSchema.optional(),
})

const mediaSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), stream: streamRefSchema }),
  z.object({
    kind: z.literal('mux'),
    video: streamRefSchema,
    audio: streamRefSchema,
  }),
  z.object({ kind: z.literal('hls'), manifest: streamRefSchema }),
  z.object({ kind: z.literal('dash'), manifest: streamRefSchema }),
])

const mediaVariantSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(64),
    height: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    fps: z.number().positive().finite().optional(),
    bitrateKbps: z.number().nonnegative().finite().optional(),
    videoCodec: z.string().max(64).optional(),
    audioCodec: z.string().max(64).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    container: z.enum(['mp4', 'mkv', 'ts']),
    locked: z.enum(['login', 'premium']).optional(),
    source: mediaSourceSchema.optional(),
  })
  .superRefine((variant, ctx) => {
    if (variant.locked && variant.source) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'a locked variant must not carry a source',
      })
    }
    if (!variant.locked && !variant.source) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'an unlocked variant needs a source',
      })
    }
    if (variant.source?.kind === 'mux' && variant.container === 'ts') {
      ctx.addIssue({
        code: 'custom',
        path: ['container'],
        message: 'a mux variant must use an mp4 or mkv container',
      })
    }
  })

const mediaEntrySchema = z.object({
  id: idSchema,
  index: z.number().int().positive().optional(),
  title: titleSchema,
  durationSec: z.number().nonnegative().finite().optional(),
  current: z.boolean().optional(),
  variants: z
    .array(mediaVariantSchema)
    .max(L.variantsPerEntry)
    .superRefine((variants, ctx) => {
      const seen = new Set<string>()
      variants.forEach((variant, index) => {
        if (seen.has(variant.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: 'duplicate variant id',
          })
        }
        seen.add(variant.id)
      })
    })
    .optional(),
  unavailable: z
    .object({ reason: reasonSchema, message: messageSchema.optional() })
    .optional(),
})

const siteResolutionV1Schema = z.object({
  kind: z.literal('media'),
  schemaVersion: z.literal(1),
  title: titleSchema,
  entries: z
    .array(mediaEntrySchema)
    .min(1)
    .max(L.entries)
    .superRefine((entries, ctx) => {
      const seen = new Set<string>()
      let current = 0
      entries.forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: 'duplicate entry id',
          })
        }
        seen.add(entry.id)
        if (entry.current) current += 1
      })
      if (current > 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'at most one entry may be current',
        })
      }
    }),
  expiresAt: z.number().int().positive().optional(),
  auth: z
    .object({
      state: z.enum(['anonymous', 'authenticated']),
      betterWithLogin: z.boolean().optional(),
    })
    .optional(),
})

const siteUnavailableSchema = z.object({
  kind: z.literal('unavailable'),
  reason: reasonSchema,
  message: messageSchema.optional(),
})

/** The single-pair result resolvers returned before the versioned contract. */
const legacyMuxResultSchema = z.object({
  kind: z.literal('mux'),
  video: z.object({ url: urlSchema, headers: headersSchema.optional() }),
  audio: z.object({ url: urlSchema }),
  container: z.enum(['mp4', 'mkv']).optional(),
  title: titleSchema.optional(),
})

const resolveResultSchema = z.discriminatedUnion('kind', [
  siteResolutionV1Schema,
  siteUnavailableSchema,
  legacyMuxResultSchema,
])

export type SiteResolutionV1 = z.infer<typeof siteResolutionV1Schema>
export type MediaEntry = z.infer<typeof mediaEntrySchema>
export type MediaVariant = z.infer<typeof mediaVariantSchema>
export type MediaSource = z.infer<typeof mediaSourceSchema>
export type StreamRef = z.infer<typeof streamRefSchema>

/** Arguments the host sends to `${id}.resolve`. Only `url` is always present. */
export type SiteResolveArgs = {
  url: string
  cookies?: string
  /** Sent only on a follow-up for entries whose variants were deferred. */
  entryIds?: string[]
}

export type SiteResolveParse =
  /** `null`/`undefined`: the resolver does not handle this URL. */
  | { kind: 'declined' }
  | { kind: 'media'; resolution: SiteResolutionV1 }
  | { kind: 'unavailable'; reason: string; message?: string }
  /** Issue paths and constraint names only — never values from the result. */
  | { kind: 'invalid'; issues: string[] }

/**
 * Validate and normalize a raw `${id}.resolve` result. A legacy mux pair is
 * normalized to one current entry with one `default` variant; its video
 * headers also apply to the audio leg, as they did before.
 */
export function parseSiteResolveResult(raw: unknown): SiteResolveParse {
  if (raw === null || raw === undefined) return { kind: 'declined' }

  const bytes = measureJsonBytes(raw)
  if (bytes === null) return { kind: 'invalid', issues: ['not serializable'] }
  if (bytes > L.resultBytes) {
    return {
      kind: 'invalid',
      issues: [`result exceeds ${L.resultBytes} bytes`],
    }
  }

  // QuickJS results commonly spell an absent optional field as `null`.
  const parsed = resolveResultSchema.safeParse(dropNullProperties(raw))
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map(
        (issue) => `${formatIssuePath(issue.path)}: ${issue.code}`
      ),
    }
  }

  const value = parsed.data
  if (value.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: value.reason,
      ...(value.message ? { message: sanitizeText(value.message) } : {}),
    }
  }

  // `value` is zod's fresh output, so admission may normalize it in place.
  const resolution = value.kind === 'mux' ? normalizeLegacyMux(value) : value
  const issues = admitResolution(resolution)
  if (issues.length > 0) return { kind: 'invalid', issues }
  return { kind: 'media', resolution }
}

// Header names are record keys chosen by the plugin, so a path stops at
// `headers`: an issue line must never echo text from the result.
function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)'
  const headers = path.indexOf('headers')
  const kept = headers === -1 ? path : path.slice(0, headers + 1)
  return kept.map(String).join('.')
}

/** An entry whose variants the resolver left out, to be fetched by entry id. */
export function isEntryDeferred(entry: MediaEntry): boolean {
  return entry.variants === undefined && entry.unavailable === undefined
}

function normalizeLegacyMux(
  legacy: z.infer<typeof legacyMuxResultSchema>
): SiteResolutionV1 {
  const title = legacy.title ?? ''
  const headers = legacy.video.headers
  return {
    kind: 'media',
    schemaVersion: 1,
    title,
    entries: [
      {
        id: 'default',
        title,
        current: true,
        variants: [
          {
            id: 'default',
            label: 'Default',
            container: legacy.container ?? 'mp4',
            source: {
              kind: 'mux',
              video: { url: legacy.video.url, ...(headers ? { headers } : {}) },
              audio: { url: legacy.audio.url, ...(headers ? { headers } : {}) },
            },
          },
        ],
      },
    ],
  }
}

/**
 * Admission over a schema-valid resolution, mutating it in place: every URL,
 * mirror and manifest becomes an admitted task source, headers are checked
 * against the allowlist and stripped of hop-by-hop names, and titles lose
 * control characters.
 */
function admitResolution(resolution: SiteResolutionV1): string[] {
  const issues: string[] = []
  resolution.title = sanitizeText(resolution.title)
  resolution.entries.forEach((entry, entryIndex) => {
    entry.title = sanitizeText(entry.title)
    if (entry.unavailable?.message) {
      entry.unavailable.message = sanitizeText(entry.unavailable.message)
    }
    entry.variants?.forEach((variant, variantIndex) => {
      const base = `entries.${entryIndex}.variants.${variantIndex}.source`
      const source = variant.source
      if (!source) return
      const streams: Array<[string, StreamRef]> =
        source.kind === 'direct'
          ? [['stream', source.stream]]
          : source.kind === 'mux'
            ? [
                ['video', source.video],
                ['audio', source.audio],
              ]
            : [['manifest', source.manifest]]
      for (const [name, stream] of streams) {
        admitStream(stream, `${base}.${name}`, issues)
      }
    })
  })
  return issues
}

function admitStream(stream: StreamRef, path: string, issues: string[]): void {
  const admit = (url: string, at: string): string | null => {
    try {
      return admitHttpSource(url)
    } catch {
      issues.push(`${at}: inadmissible source`)
      return null
    }
  }
  stream.url = admit(stream.url, `${path}.url`) ?? stream.url
  if (stream.mirrors) {
    stream.mirrors = stream.mirrors.map(
      (mirror, index) => admit(mirror, `${path}.mirrors.${index}`) ?? mirror
    )
  }
  if (stream.headers) {
    const allowed = new Set<string>(STREAM_HEADER_ALLOWLIST)
    for (const name of Object.keys(stream.headers)) {
      if (!allowed.has(name.toLowerCase())) {
        issues.push(`${path}.headers: header not allowed`)
        return
      }
    }
    stream.headers = stripHopByHopHeaders(stream.headers)
  }
}

// C0/C1 controls and bidi overrides would corrupt names and log lines.
function isControlChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

function sanitizeText(text: string): string {
  let out = ''
  for (const char of text) {
    out += isControlChar(char.codePointAt(0) ?? 0) ? ' ' : char
  }
  return out.replace(/\s+/g, ' ').trim()
}

function measureJsonBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : Buffer.byteLength(json, 'utf8')
  } catch {
    return null
  }
}

// The deepest schema field (entries → variants → source → stream → headers →
// value) sits at depth 8. Below this bound nothing can match the schema, and
// zod drops unknown keys without walking them, so deeper values are returned
// as-is. A result nested thousands deep fits under the byte cap and would
// otherwise overflow the stack here instead of becoming `invalid`.
const NULL_STRIP_MAX_DEPTH = 16

function dropNullProperties(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= NULL_STRIP_MAX_DEPTH) return value
  if (Array.isArray(value)) {
    return value.map((child) => dropNullProperties(child, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child === null) continue
    out[key] = dropNullProperties(child, depth + 1)
  }
  return out
}
