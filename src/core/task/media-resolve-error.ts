import { AppError, ErrorCode } from '@shared/errors'

/**
 * i18n key carried as the AppError message. Electron flattens an AppError to
 * its message across IPC, so the renderer receives this key verbatim and
 * translates it, the same way it handles `task.storage.*` keys.
 */
export const MEDIA_RESOLVE_FAILED_KEY = 'task.add.mediaResolveFailed'

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
