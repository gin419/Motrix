import {
  ErrorCode,
  MEDIA_RESOLVE_MESSAGE_KEYS,
  MEDIA_UNAVAILABLE_REASONS,
} from '@shared/errors'
import enUS from '@shared/locales/en-US.json'
import zhCN from '@shared/locales/zh-CN.json'
import { describe, expect, it } from 'vitest'
import { MediaResolveError } from './media-resolve-error'

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog
    )
}

describe('MediaResolveError message', () => {
  it.each([
    ['login-required', 'task.add.media.unavailable.loginRequired'],
    ['paid-content', 'task.add.media.unavailable.paidContent'],
    ['premium-required', 'task.add.media.unavailable.paidContent'],
    ['drm', 'task.add.media.unavailable.protected'],
    ['removed', 'task.add.media.unavailable.notFound'],
    // A reason the host has no text for falls back to the generic one.
    ['members-only-beta', 'task.add.media.unavailable.unsupported'],
    // An inherited object member is not a reason the host knows.
    ['constructor', 'task.add.media.unavailable.unsupported'],
  ])('explains the unavailable reason %s', (reason, key) => {
    const error = new MediaResolveError('p', 'unavailable', undefined, reason)
    expect(error).toMatchObject({
      code: ErrorCode.MediaResolveFailed,
      message: key,
      reason,
    })
  })

  it.each([
    ['command-failed', 'task.add.mediaResolveFailed'],
    ['invalid-result', 'task.add.mediaResolveFailed'],
    ['timeout', 'task.add.media.failure.timeout'],
    ['no-playable-variant', 'task.add.media.failure.noPlayableVariant'],
    ['stream-unavailable', 'task.add.media.failure.streamUnavailable'],
    ['ffmpeg-required', 'settings.integration.media.ffmpegRequired'],
  ] as const)('explains the %s failure', (failure, key) => {
    expect(new MediaResolveError('p', failure).message).toBe(key)
  })

  it('has every key it can raise in the eager catalogs', () => {
    expect(MEDIA_UNAVAILABLE_REASONS).toContain('geo-restricted')
    for (const key of MEDIA_RESOLVE_MESSAGE_KEYS) {
      expect(typeof lookup(enUS, key), key).toBe('string')
      expect(typeof lookup(zhCN, key), key).toBe('string')
    }
  })
})
