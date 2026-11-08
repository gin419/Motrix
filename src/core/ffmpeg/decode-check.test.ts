import { describe, expect, it, vi } from 'vitest'
import { checkVideoDecodable, DECODE_ERROR_THRESHOLD } from './decode-check'
import {
  type DecodeProbeJob,
  type DecodeProbeResult,
  FfmpegService,
} from './ffmpeg-service'

function result(over: Partial<DecodeProbeResult> = {}): DecodeProbeResult {
  return {
    exitCode: 0,
    frames: 250,
    errors: 0,
    noVideoStream: false,
    timedOut: false,
    ...over,
  }
}

function probeReturning(...results: Array<DecodeProbeResult | Error>) {
  const queue = [...results]
  return vi.fn(async (_job: DecodeProbeJob) => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected probe call')
    if (next instanceof Error) throw next
    return next
  })
}

const base = {
  binaryPath: '/usr/bin/ffmpeg',
  input: '/d/video.mp4.motrix',
  outputName: 'video.mp4',
}

describe('checkVideoDecodable', () => {
  it('passes a healthy file after decoding only the first window', async () => {
    const probe = probeReturning(result())
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict).toEqual({ status: 'decodable', frames: 250, errors: 0 })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0][0]).toMatchObject({
      input: base.input,
      startSec: 0,
    })
  })

  it('tolerates a few errors from a stream cut mid-GOP', async () => {
    const probe = probeReturning(result({ errors: 3 }))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict.status).toBe('decodable')
  })

  it('fails a scrambled stream whose error count is far above normal', async () => {
    const probe = probeReturning(result({ errors: 181 }))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict).toEqual({ status: 'undecodable', frames: 250, errors: 181 })
  })

  it('fails when the window produces no frames at all', async () => {
    const probe = probeReturning(result({ frames: 0 }))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict.status).toBe('undecodable')
  })

  it('confirms a bad first window with a mid-file window before failing', async () => {
    const probe = probeReturning(
      result({ errors: DECODE_ERROR_THRESHOLD }),
      result({ errors: 90 })
    )
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict).toEqual({ status: 'undecodable', frames: 500, errors: 110 })
    expect(probe.mock.calls[1][0].startSec).toBe(300)
  })

  it('passes when only the first window is damaged and the middle decodes', async () => {
    const probe = probeReturning(result({ errors: 60 }), result({ errors: 0 }))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict.status).toBe('decodable')
  })

  it('skips audio-only outputs without running ffmpeg', async () => {
    const probe = probeReturning()
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      outputName: 'song.m4a',
      probe,
    })
    expect(verdict).toEqual({ status: 'skipped', reason: 'audio-only' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('skips an output that has no video stream', async () => {
    const probe = probeReturning(
      result({ exitCode: 234, frames: 0, errors: 5, noVideoStream: true })
    )
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict).toEqual({ status: 'skipped', reason: 'no-video-stream' })
  })

  it.each([
    ['ffmpeg cannot be spawned', new Error('decode-probe-failed: ENOENT')],
    ['the probe times out', result({ timedOut: true, exitCode: null })],
    ['ffmpeg exits abnormally', result({ exitCode: 1, errors: 400 })],
  ])('is inconclusive (never a failure) when %s', async (_label, outcome) => {
    const probe = probeReturning(outcome)
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict.status).toBe('inconclusive')
  })

  it('is inconclusive when the confirming window cannot run', async () => {
    const probe = probeReturning(result({ errors: 120 }), new Error('killed'))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict.status).toBe('inconclusive')
  })
})
