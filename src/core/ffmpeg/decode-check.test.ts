import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  checkVideoDecodable,
  DECODE_ERROR_THRESHOLD,
  DECODE_STRONG_ERROR_THRESHOLD,
  decodeWindowStarts,
} from './decode-check'
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
    decoderUnavailable: false,
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

describe('decodeWindowStarts', () => {
  it.each([
    [undefined, [0]],
    [15, [0]],
    [25, [0, 12]],
    [30, [0, 15]],
    [40, [0, 20, 30]],
    [600, [0, 300, 450]],
    [Number.POSITIVE_INFINITY, [0]],
  ])('spreads windows over a %s s file without overlap', (duration, starts) => {
    expect(decodeWindowStarts(duration)).toEqual(starts)
  })
})

describe('checkVideoDecodable', () => {
  it('passes a healthy long file once two windows decode cleanly', async () => {
    const probe = probeReturning(result(), result())
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict).toEqual({ status: 'decodable', frames: 500, errors: 0 })
    expect(probe.mock.calls.map(([job]) => job.startSec)).toEqual([0, 300])
    expect(probe.mock.calls[0][0]).toMatchObject({ input: base.input })
  })

  it('passes a short healthy file after its only window', async () => {
    const probe = probeReturning(result())
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict).toEqual({ status: 'decodable', frames: 250, errors: 0 })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('fails a stream scrambled throughout even at a low error rate', async () => {
    // IDR-only scrambling: a garbage picture with only a few errors per GOP.
    const probe = probeReturning(result({ errors: 14 }), result({ errors: 14 }))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict).toEqual({ status: 'undecodable', frames: 500, errors: 28 })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('samples later windows, so scrambling that starts after the first one is caught', async () => {
    const probe = probeReturning(
      result(),
      result({ errors: 120 }),
      result({ errors: DECODE_ERROR_THRESHOLD })
    )
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict.status).toBe('undecodable')
    expect(probe.mock.calls.map(([job]) => job.startSec)).toEqual([0, 300, 450])
  })

  it('passes when only one of three windows is damaged', async () => {
    const probe = probeReturning(
      result({ errors: 60 }),
      result({ errors: 0 }),
      result({ errors: 0 })
    )
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict.status).toBe('decodable')
  })

  it('passes a two-window file when only one window is damaged', async () => {
    const probe = probeReturning(result({ errors: 400 }), result())
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 30,
      probe,
    })
    expect(verdict.status).toBe('decodable')
  })

  it.each([
    ['ffmpeg exits on its decode-error rate', { exitCode: 69, frames: 28 }],
    ['the window produces no frames', { frames: 0, errors: 5 }],
    [
      'errors reach the strong threshold',
      { errors: DECODE_STRONG_ERROR_THRESHOLD },
    ],
  ])('fails a single-window file when %s', async (_label, over) => {
    const probe = probeReturning(result(over))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict.status).toBe('undecodable')
  })

  it('treats exit 69 with no frames as damaged in every window', async () => {
    const broken = { exitCode: 69, frames: 0, errors: 1760 }
    const probe = probeReturning(result(broken), result(broken))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 40,
      probe,
    })
    expect(verdict).toEqual({ status: 'undecodable', frames: 0, errors: 3520 })
  })

  it('does not fail a single-window file on a handful of errors', async () => {
    const probe = probeReturning(result({ errors: DECODE_ERROR_THRESHOLD }))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      probe,
    })
    expect(verdict.status).toBe('decodable')
  })

  it('ignores a window that seeks past the end of the file', async () => {
    // A wrong (too long) duration: later seeks land past the end and decode
    // nothing, which must not count as a broken window.
    const empty = { frames: 0, errors: 0 }
    const probe = probeReturning(result(), result(empty), result(empty))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict).toEqual({ status: 'decodable', frames: 250, errors: 0 })
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
    [
      'the decoder cannot run on this build',
      // Native hwaccel-only AV1 decoder without libdav1d: every packet fails.
      result({
        exitCode: 69,
        frames: 0,
        errors: 2016,
        decoderUnavailable: true,
      }),
    ],
  ])('is inconclusive (never a failure) when %s', async (_label, outcome) => {
    const probe = probeReturning(outcome)
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict.status).toBe('inconclusive')
  })

  it('is inconclusive when a later window cannot run', async () => {
    const probe = probeReturning(result({ errors: 120 }), new Error('killed'))
    const verdict = await checkVideoDecodable(new FfmpegService(), {
      ...base,
      durationSec: 600,
      probe,
    })
    expect(verdict).toEqual({
      status: 'inconclusive',
      reason: 'window at 300s: killed',
    })
  })
})

function findBinary(bin: string): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    encoding: 'utf8',
  })
  const found = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : ''
  return found && existsSync(found) ? found : null
}

const FFMPEG = findBinary('ffmpeg')

/**
 * Overwrite the slice payload of every IDR NAL unit in an Annex B H.264
 * stream with nonzero pseudo-random bytes, leaving headers and all other
 * slices intact: a keyframe-only scrambling scheme.
 */
function scrambleIdrSlices(data: Buffer): Buffer {
  const starts: number[] = []
  for (let i = data.indexOf(START_CODE); i >= 0; ) {
    starts.push(i + START_CODE.length)
    i = data.indexOf(START_CODE, i + START_CODE.length)
  }
  const out = Buffer.from(data)
  let seed = 1
  starts.forEach((start, k) => {
    if (((data[start] ?? 0) & 0x1f) !== 5) return
    const end = k + 1 < starts.length ? (starts[k + 1] ?? 0) - 3 : data.length
    for (let p = start + 12; p < end; p++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      out[p] = 1 + (seed % 255)
    }
  })
  return out
}
const START_CODE = Buffer.from([0, 0, 1])

describe.skipIf(!FFMPEG)('checkVideoDecodable with real ffmpeg', () => {
  const ffmpegPath = FFMPEG ?? 'ffmpeg'
  let dir: string
  let healthy: string | null = null

  const ffmpeg = (...args: string[]) =>
    spawnSync(ffmpegPath, [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-y',
      ...args,
    ]).status === 0

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'motrix-decode-check-'))
    const out = path.join(dir, 'healthy.mp4')
    const encoded = ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=25',
      '-t',
      '40',
      '-c:v',
      'libx264',
      '-g',
      '50',
      '-pix_fmt',
      'yuv420p',
      out
    )
    healthy = encoded ? out : null
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const check = (input: string) =>
    checkVideoDecodable(new FfmpegService(), {
      binaryPath: ffmpegPath,
      input,
      outputName: 'video.mp4',
      durationSec: 40,
    })

  it('passes a healthy H.264 file', async (ctx) => {
    if (!healthy) return ctx.skip()
    await expect(check(healthy)).resolves.toMatchObject({
      status: 'decodable',
      errors: 0,
    })
  }, 60_000)

  it('fails a file whose packets mostly fail to decode (ffmpeg exit 69)', async (ctx) => {
    if (!healthy) return ctx.skip()
    const corrupt = path.join(dir, 'noise.mp4')
    expect(
      ffmpeg('-i', healthy, '-c', 'copy', '-bsf:v', 'noise=amount=2', corrupt)
    ).toBe(true)
    await expect(check(corrupt)).resolves.toMatchObject({
      status: 'undecodable',
    })
  }, 60_000)

  it('fails a file whose keyframes alone are scrambled', async (ctx) => {
    if (!healthy) return ctx.skip()
    const annexB = path.join(dir, 'healthy.h264')
    const scrambled = path.join(dir, 'idr.h264')
    const remuxed = path.join(dir, 'idr.mp4')
    expect(
      ffmpeg(
        '-i',
        healthy,
        '-c',
        'copy',
        '-bsf:v',
        'h264_mp4toannexb',
        '-f',
        'h264',
        annexB
      )
    ).toBe(true)
    writeFileSync(scrambled, scrambleIdrSlices(readFileSync(annexB)))
    expect(ffmpeg('-r', '25', '-i', scrambled, '-c', 'copy', remuxed)).toBe(
      true
    )
    await expect(check(remuxed)).resolves.toMatchObject({
      status: 'undecodable',
    })
  }, 60_000)
})
