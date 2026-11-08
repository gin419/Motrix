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
 * Error lines in one window at or above which the window counts as damaged.
 * Healthy files decoded with zero errors in every window across H.264, HEVC
 * 10-bit, VP9, AV1, fMP4, MKV and MPEG-TS samples, while a stream whose IDR
 * slices alone are scrambled renders garbage yet logs only a few errors per
 * keyframe interval (6 per window at a 10 s GOP, 14 at a 2 s GOP).
 */
export const DECODE_ERROR_THRESHOLD = 3
/**
 * Error lines in one window at or above which that window alone is strong
 * evidence: fully scrambled H.264/HEVC measured 170–1100 errors per window.
 * Only strong evidence fails a file too short for a second window.
 */
export const DECODE_STRONG_ERROR_THRESHOLD = 20
/**
 * ffmpeg's exit code when the share of packets that failed to decode exceeds
 * `-max_error_rate` (default 2/3). Decoders that drop bad packets instead of
 * concealing them (libdav1d, libvpx) report a scrambled or encrypted track
 * this way rather than with exit 0.
 */
const FFMPEG_DECODE_ERROR_RATE_EXIT = 69

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
  /** Media duration; when long enough, later windows are sampled too. */
  durationSec?: number
  /** Test seam forwarded to FfmpegService.probeDecode. */
  probe?: (job: DecodeProbeJob) => Promise<DecodeProbeResult>
}

interface SampledWindow {
  /** clean: decodes; damaged: errors above normal; broken: strong evidence. */
  kind: 'clean' | 'damaged' | 'broken'
  frames: number
  errors: number
}

type WindowVerdict =
  | SampledWindow
  | { kind: 'skip'; reason: 'no-video-stream' }
  /** A seek at or past the end of the file: nothing was sampled. */
  | { kind: 'empty' }
  | { kind: 'inconclusive'; reason: string }

function judgeWindow(
  result: DecodeProbeResult,
  startSec: number
): WindowVerdict {
  if (result.noVideoStream) return { kind: 'skip', reason: 'no-video-stream' }
  if (result.timedOut) return { kind: 'inconclusive', reason: 'timeout' }
  if (result.decoderUnavailable) {
    return { kind: 'inconclusive', reason: 'decoder unavailable' }
  }
  const { frames, errors } = result
  if (result.exitCode === FFMPEG_DECODE_ERROR_RATE_EXIT) {
    return { kind: 'broken', frames, errors }
  }
  if (result.exitCode !== 0) {
    return { kind: 'inconclusive', reason: `exit ${result.exitCode}` }
  }
  if (frames === 0) {
    return startSec > 0 && errors === 0
      ? { kind: 'empty' }
      : { kind: 'broken', frames, errors }
  }
  if (errors >= DECODE_STRONG_ERROR_THRESHOLD) {
    return { kind: 'broken', frames, errors }
  }
  if (errors >= DECODE_ERROR_THRESHOLD) {
    return { kind: 'damaged', frames, errors }
  }
  return { kind: 'clean', frames, errors }
}

/**
 * Window starts: the file start, then the middle and three quarters in, each
 * only when it neither overlaps the previous window nor runs past the end.
 */
export function decodeWindowStarts(durationSec: number | undefined): number[] {
  const starts = [0]
  const duration = durationSec ?? 0
  if (!Number.isFinite(duration)) return starts
  for (const fraction of [0.5, 0.75]) {
    const start = Math.floor(duration * fraction)
    const previous = starts[starts.length - 1] ?? 0
    if (
      start >= previous + DECODE_WINDOW_SEC &&
      start + DECODE_WINDOW_SEC <= duration
    ) {
      starts.push(start)
    }
  }
  return starts
}

/**
 * Bounded post-mux check that the output's video track actually decodes.
 *
 * Samples up to three windows spread over the file (decodeWindowStarts) and
 * stops as soon as a majority agrees. A window is damaged when it logs at
 * least DECODE_ERROR_THRESHOLD errors, decodes no frame, or makes ffmpeg exit
 * with its decode-error-rate code. The file is `undecodable` when most
 * sampled windows are damaged, so one bad region (a dropped segment) never
 * fails a task, while a stream scrambled throughout, including one that only
 * scrambles keyframes, does. A file too short for a second window fails only
 * on strong evidence from its single window.
 *
 * Never throws: a spawn failure, timeout, unavailable decoder, other abnormal
 * exit, or abort yields `inconclusive`, and the caller must treat that as a
 * pass.
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
        }),
        startSec
      )
    } catch (err) {
      return {
        kind: 'inconclusive',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const starts = decodeWindowStarts(input.durationSec)
  const majority = Math.floor(starts.length / 2) + 1
  const sampled: Array<SampledWindow & { startSec: number }> = []
  let clean = 0
  let damaged = 0
  for (const startSec of starts) {
    const window = await runWindow(startSec)
    if (window.kind === 'skip') {
      return { status: 'skipped', reason: window.reason }
    }
    if (window.kind === 'inconclusive') {
      return {
        status: 'inconclusive',
        reason:
          startSec === 0
            ? window.reason
            : `window at ${startSec}s: ${window.reason}`,
      }
    }
    if (window.kind === 'empty') continue
    sampled.push({ ...window, startSec })
    if (window.kind === 'clean') clean += 1
    else damaged += 1
    if (clean >= majority || damaged >= majority) break
  }

  const frames = sampled.reduce((sum, w) => sum + w.frames, 0)
  const errors = sampled.reduce((sum, w) => sum + w.errors, 0)
  const undecodable =
    sampled.length === 1 ? sampled[0]?.kind === 'broken' : damaged > clean
  if (!undecodable && damaged > 0) {
    log.info(
      { windows: sampled },
      'a minority of decode windows was damaged; treating as decodable'
    )
  }
  return undecodable
    ? { status: 'undecodable', frames, errors }
    : { status: 'decodable', frames, errors }
}
