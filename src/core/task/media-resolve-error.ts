import { AppError, ErrorCode, MEDIA_RESOLVE_FAILED_KEY } from '@shared/errors'

/**
 * - `command-failed`: activation or the resolve command threw or timed out.
 * - `invalid-result`: the command returned a value that is neither `null`
 *   (an explicit decline) nor a result this host can route.
 */
export type MediaResolveFailure = 'command-failed' | 'invalid-result'

/**
 * A site resolver claimed the URL (enabled, resolve-command marker present,
 * hostPermissions admitted it) and then failed. Thrown instead of returning
 * null so the caller never falls back to downloading the page itself, which
 * would produce an HTML file named after the video.
 */
export class MediaResolveError extends AppError {
  constructor(
    public readonly pluginId: string,
    public readonly failure: MediaResolveFailure,
    cause?: unknown
  ) {
    super(ErrorCode.MediaResolveFailed, MEDIA_RESOLVE_FAILED_KEY, cause)
  }
}
