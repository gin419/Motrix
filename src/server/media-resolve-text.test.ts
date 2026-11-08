import { MediaResolveError } from '@core/task/media-resolve-error'
import enUS from '@shared/locales/en-US.json'
import { describe, expect, it } from 'vitest'
import { translateMediaResolveText } from './media-resolve-text'

describe('translateMediaResolveText', () => {
  it.each([
    new MediaResolveError('p', 'unavailable', undefined, 'login-required'),
    new MediaResolveError('p', 'timeout'),
    new MediaResolveError('p', 'command-failed'),
    new MediaResolveError('p', 'stream-unavailable'),
  ])('gives the English text of the $message rejection', (error) => {
    const { key } = error.localizable
    const text = translateMediaResolveText(key)
    expect(text).not.toBe(key)
    expect(text).toBe(
      key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          enUS
        )
    )
  })

  it('fills in the resolver message of an unrecognized reason', () => {
    const { key, detail } = new MediaResolveError(
      'p',
      'unavailable',
      undefined,
      'age-gated',
      'Confirm your age'
    ).localizable
    expect(
      translateMediaResolveText(key, detail ? { detail } : undefined)
    ).toBe(
      'The site resolver plugin reports that this media can’t be downloaded: Confirm your age'
    )
  })

  it.each([
    'task.add.media.unavailable.constructor',
    'task.add',
    'settings.integration.media.ffmpegRequired',
    'not-a-key',
  ])('returns %s unchanged', (key) => {
    expect(translateMediaResolveText(key)).toBe(key)
  })
})
