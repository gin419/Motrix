import { getLogger } from '@core/logger'
import type {
  DecodeProbeJob,
  DecodeProbeResult,
  FfmpegService,
} from './ffmpeg-service'

const log = getLogger('media-decode-check')

/** Seconds of video decoded per window. */
export const DECODE_WINDOW_SEC = 10
/** Wall-clock cap per window; a slower decode is treated as inconclusive. */
export const DECODE_WINDOW_TIMEOUT_MS = 30_000
/**
 * Error lines in one window at or above which the window counts as
 * undecodable. A healthy file decodes with zero errors (an HLS cut that
 * starts mid-GOP can add a handful); scrambled H.264 measured 34–181 errors
 * per segment while rendering a grey picture.
 */
export const DECODE_ERROR_THRESHOLD = 20

/** Final-name extensions that only ever carry audio. */
const AUDIO_ONLY_EXT = new Set(['m4a', 'aac', 'mp3', 'opus'])

export type DecodeCheckVerdict =
  | { status: 'decodable'; frames: number; errors: number }
  | { status: 'undecodable'; frames: number; errors: number }
  | { status: 'skipped'; reason: 'audio-only' | 'no-video-stream' }
  | { status: 'inconclusive'; reason: string }

export interface DecodeCheckInput {
  binaryPath: string
  /** File to check (the muxed output before its finalize rename). */
  input: string
  /** Final file name; its extension decides whether a video track exists. */
  outputName: string
  /** Known media duration; enables a confirming mid-file window. */
  durationSec?: number
  /** Test seam forwarded to FfmpegService.probeDecode. */
  probe?: (job: DecodeProbeJob) => Promise<DecodeProbeResult>
}

type WindowVerdict =
  | { kind: 'decodable' | 'undecodable'; frames: number; errors: number }
  | { kind: 'skip'; reason: 'no-video-stream' }
  | { kind: 'inconclusive'; reason: string }

function judgeWindow(result: DecodeProbeResult): WindowVerdict {
  if (result.noVideoStream) return { kind: 'skip', reason: 'no-video-stream' }
  if (result.timedOut) return { kind: 'inconclusive', reason: 'timeout' }
  if (result.exitCode !== 0) {
    return { kind: 'inconclusive', reason: `exit ${result.exitCode}` }
  }
  const { frames, errors } = result
  const undecodable = frames === 0 || errors >= DECODE_ERROR_THRESHOLD
  return { kind: undecodable ? 'undecodable' : 'decodable', frames, errors }
}

/**
 * Bounded post-mux check that the output's video track actually decodes.
 * Decodes the first window; only when that window looks undecodable and the
 * duration allows, a mid-file window must agree before the verdict is
 * `undecodable`. One bad region (a dropped segment) therefore never fails a
 * task, while a stream that is scrambled throughout does.
 *
 * Never throws: a spawn failure, timeout, abnormal exit, or abort yields
 * `inconclusive`, and the caller must treat that as a pass.
 */
export async function checkVideoDecodable(
  ffmpeg: FfmpegService,
  input: DecodeCheckInput
): Promise<DecodeCheckVerdict> {
  const ext = /\.([a-z0-9]{2,8})$/i.exec(input.outputName)?.[1]?.toLowerCase()
  if (ext && AUDIO_ONLY_EXT.has(ext)) {
    return { status: 'skipped', reason: 'audio-only' }
  }
  const probe =
    input.probe ?? ((job: DecodeProbeJob) => ffmpeg.probeDecode(job))
  const runWindow = async (startSec: number): Promise<WindowVerdict> => {
    try {
      return judgeWindow(
        await probe({
          binaryPath: input.binaryPath,
          input: input.input,
          startSec,
          windowSec: DECODE_WINDOW_SEC,
          timeoutMs: DECODE_WINDOW_TIMEOUT_MS,
        })
      )
    } catch (err) {
      return {
        kind: 'inconclusive',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const first = await runWindow(0)
  if (first.kind === 'skip') return { status: 'skipped', reason: first.reason }
  if (first.kind === 'inconclusive') {
    return { status: 'inconclusive', reason: first.reason }
  }
  if (first.kind === 'decodable') {
    return { status: 'decodable', frames: first.frames, errors: first.errors }
  }

  const duration = input.durationSec ?? 0
  if (duration >= DECODE_WINDOW_SEC * 3) {
    const mid = await runWindow(Math.floor(duration / 2))
    if (mid.kind === 'inconclusive') {
      return { status: 'inconclusive', reason: `mid window: ${mid.reason}` }
    }
    if (mid.kind === 'skip') return { status: 'skipped', reason: mid.reason }
    if (mid.kind === 'decodable') {
      log.info(
        { first, mid },
        'first decode window failed but mid window decoded; treating as decodable'
      )
      return { status: 'decodable', frames: mid.frames, errors: mid.errors }
    }
    return {
      status: 'undecodable',
      frames: first.frames + mid.frames,
      errors: first.errors + mid.errors,
    }
  }
  return { status: 'undecodable', frames: first.frames, errors: first.errors }
}
