import { AppError, ErrorCode, MEDIA_RESOLVE_FAILED_KEY } from '@shared/errors'

/**
 * - `command-failed`: activation or the resolve command threw.
 * - `timeout`: the resolve command did not answer within its budget.
 * - `invalid-result`: the command returned a value that is neither `null`
 *   (an explicit decline) nor a valid site resolution.
 * - `unavailable`: the resolver reported the media as unavailable; `reason`
 *   carries its token.
 * - `no-playable-variant`: no variant of the chosen entry can be downloaded
 *   by the consumer.
 * - `ffmpeg-required`: the only usable variants need FFmpeg, which is absent.
 *
 * Every failure currently shares one user-facing message key.
 */
export type MediaResolveFailure =
  | 'command-failed'
  | 'timeout'
  | 'invalid-result'
  | 'unavailable'
  | 'no-playable-variant'
  | 'ffmpeg-required'

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
    cause?: unknown,
    public readonly reason?: string
  ) {
    super(ErrorCode.MediaResolveFailed, MEDIA_RESOLVE_FAILED_KEY, cause)
  }
}
