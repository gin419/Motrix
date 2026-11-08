import { AppError, ErrorCode, mediaResolveMessageKey } from '@shared/errors'

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
 * - `stream-unavailable`: the chosen variant's manifest or stream could not
 *   be fetched when the pipeline took it over.
 *
 * The message is the i18n key that explains the failure: one per known
 * unavailability reason, one per host-side failure, and a shared key for a
 * resolver that failed or answered nonsense.
 */
export type MediaResolveFailure =
  | 'command-failed'
  | 'timeout'
  | 'invalid-result'
  | 'unavailable'
  | 'no-playable-variant'
  | 'ffmpeg-required'
  | 'stream-unavailable'

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
    super(
      ErrorCode.MediaResolveFailed,
      mediaResolveMessageKey(failure, reason),
      cause
    )
  }
}
