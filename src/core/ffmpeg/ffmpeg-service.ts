import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'

export interface FfmpegProgress {
  progress: number | null
}

export interface RemuxJob {
  binaryPath: string
  videoPath: string
  audioPath?: string
  output: string
  fromMpegts: boolean
  durationSec?: number
  /**
   * Explicit output muxer (`-f`). Required when `output` does not end in a
   * media extension ffmpeg can infer a muxer from — e.g. the `.motrix`
   * placeholder path a media task muxes into before the finalize rename.
   */
  format?: string
}

/**
 * The muxer ffmpeg would pick from the extension of the FINAL output name.
 * Must stay in sync with mediaFinalName's KNOWN_MEDIA_EXT: every extension
 * ensureMediaExtension can emit or pass through needs an entry here, so that
 * muxing to the extension-less `.motrix` path via `-f` produces the same
 * container the final name advertises.
 */
const EXT_TO_MUXER: Record<string, string> = {
  mp4: 'mp4',
  m4v: 'ipod',
  mov: 'mov',
  mkv: 'matroska',
  webm: 'webm',
  ts: 'mpegts',
  flv: 'flv',
  m4a: 'ipod',
  aac: 'adts',
  mp3: 'mp3',
  opus: 'opus',
}

export function muxerForOutputName(name: string): string {
  const ext = /\.([a-z0-9]{2,8})$/i.exec(name)?.[1]?.toLowerCase()
  return (ext && EXT_TO_MUXER[ext]) || 'mp4'
}

type SpawnImpl = (cmd: string, args: string[]) => ChildProcess

/**
 * stderr of a decoder that cannot decode on this build at all rather than of
 * a damaged stream: the native `av1` decoder without a usable hwaccel logs
 * "Your platform doesn't support hardware accelerated AV1 decoding" and
 * fails every packet with ENOSYS ("Function not implemented").
 */
const DECODER_UNAVAILABLE =
  /doesn't support hardware accelerated|Function not implemented/

export class FfmpegService {
  private child: ChildProcess | null = null
  private aborted = false

  buildArgs(job: RemuxJob): string[] {
    const args: string[] = []

    args.push('-i', job.videoPath)
    if (job.audioPath) {
      args.push('-i', job.audioPath)
    }

    args.push('-c', 'copy')

    if (job.audioPath) {
      args.push('-map', '0:v:0', '-map', '1:a:0')
    }

    if (job.fromMpegts) {
      args.push('-bsf:a', 'aac_adtstoasc')
    }

    args.push('-movflags', '+faststart')
    if (job.format) {
      args.push('-f', job.format)
    }
    args.push('-progress', 'pipe:1', '-nostats', '-y', job.output)

    return args
  }

  run(
    job: RemuxJob,
    onProgress: (p: FfmpegProgress) => void,
    spawnImpl: SpawnImpl = nodeSpawn as SpawnImpl
  ): Promise<void> {
    this.aborted = false
    const args = this.buildArgs(job)
    const child = spawnImpl(job.binaryPath, args)
    this.child = child
    const durMs = (job.durationSec ?? 0) * 1000

    // Buffer a bounded tail of stderr so a non-zero exit can report WHY ffmpeg
    // failed. ffmpeg names the offending input here — e.g. for exit 234
    // (EINVAL) it prints "Stream map '0:v:0' matches no streams" (a leg is the
    // wrong stream type) or "...Invalid data found... in 'audio.mp4'". Cap to
    // the last ~8 KiB so this never grows unbounded.
    const STDERR_TAIL_LIMIT = 8192
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString()
      if (stderrTail.length > STDERR_TAIL_LIMIT) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT)
      }
    })

    let closed = false
    let pending = ''
    let droppingLine = false
    let outTimeUs = 0
    const MAX_PROGRESS_LINE = 4096
    const acceptLine = (line: string) => {
      const eq = line.indexOf('=')
      if (eq < 0) return
      const key = line.slice(0, eq)
      const value = line.slice(eq + 1).trim()
      if (key === 'out_time_ms') {
        const time = Number(value)
        if (Number.isFinite(time) && time >= 0)
          outTimeUs = Math.max(outTimeUs, time)
      }
      if (key === 'progress' && (value === 'continue' || value === 'end')) {
        onProgress({
          progress:
            Number.isFinite(durMs) && durMs > 0
              ? Math.min(0.9999, outTimeUs / 1000 / durMs)
              : null,
        })
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (closed || this.aborted) return
      const text = chunk.toString()
      let start = 0
      for (let index = 0; index < text.length; index++) {
        if (text[index] !== '\n') continue
        const part = text.slice(start, index)
        if (!droppingLine && pending.length + part.length <= MAX_PROGRESS_LINE)
          acceptLine(pending + part)
        pending = ''
        droppingLine = false
        start = index + 1
      }
      if (!droppingLine) {
        const tail = text.slice(start)
        if (pending.length + tail.length <= MAX_PROGRESS_LINE) pending += tail
        else {
          pending = ''
          droppingLine = true
        }
      }
    })

    return new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        closed = true
        reject(new Error(`mux-failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (closed) return
        closed = true
        this.child = null
        if (this.aborted) return reject(new Error('mux-aborted'))
        if (code === 0) {
          onProgress({ progress: 1 })
          return resolve()
        }
        // Append the last few non-empty stderr lines — ffmpeg names the
        // offending input/stream here. The message MUST still start with
        // "mux-failed" (MediaTaskCoordinator.mapError matches that prefix to
        // normalize task.errorMessage), so the detail goes after the code.
        const tail = stderrTail
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6)
          .join(' | ')
        const detail = tail ? `: ${tail}` : ''
        reject(new Error(`mux-failed: ffmpeg exited ${code}${detail}`))
      })
    })
  }

  buildDecodeProbeArgs(job: DecodeProbeJob): string[] {
    return [
      '-hide_banner',
      '-nostdin',
      // Only error-level messages reach stderr, so each line is a decode or
      // demux error rather than banner/info noise.
      '-v',
      'error',
      ...(job.startSec && job.startSec > 0
        ? ['-ss', String(job.startSec)]
        : []),
      '-t',
      String(job.windowSec),
      '-i',
      job.input,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-f',
      'null',
      '-progress',
      'pipe:1',
      '-nostats',
      '-',
    ]
  }

  /**
   * Decode a bounded window of the first video stream to the null muxer and
   * report how many frames came out and how many error lines ffmpeg logged.
   * Resolves (never rejects) on a timeout, with `timedOut: true`. Rejects
   * when the process cannot be spawned or when kill() aborts it.
   */
  probeDecode(
    job: DecodeProbeJob,
    spawnImpl: SpawnImpl = nodeSpawn as SpawnImpl
  ): Promise<DecodeProbeResult> {
    if (this.aborted) return Promise.reject(new Error('mux-aborted'))
    const child = spawnImpl(job.binaryPath, this.buildDecodeProbeArgs(job))
    this.child = child

    const MAX_LINE = 4096
    let errors = 0
    let noVideoStream = false
    let decoderUnavailable = false
    let stderrPending = ''
    const acceptStderrLine = (line: string) => {
      const text = line.trim()
      if (!text) return
      // ffmpeg folds identical consecutive messages into one summary line.
      const repeated = /Last message repeated (\d+) times?/.exec(text)
      if (repeated) {
        errors += Number(repeated[1])
        return
      }
      if (text.includes('matches no streams')) noVideoStream = true
      if (DECODER_UNAVAILABLE.test(text)) decoderUnavailable = true
      errors += 1
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = (stderrPending + chunk.toString()).split(/\r?\n|\r/)
      stderrPending = (lines.pop() ?? '').slice(-MAX_LINE)
      for (const line of lines) acceptStderrLine(line)
    })

    let frames = 0
    let stdoutPending = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = (stdoutPending + chunk.toString()).split('\n')
      stdoutPending = (lines.pop() ?? '').slice(-MAX_LINE)
      for (const line of lines) {
        const match = /^frame=\s*(\d+)\s*$/.exec(line.trim())
        if (match) frames = Math.max(frames, Number(match[1]))
      }
    })

    return new Promise<DecodeProbeResult>((resolve, reject) => {
      let settled = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, job.timeoutMs)
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.child === child) this.child = null
        reject(new Error(`decode-probe-failed: ${err.message}`))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.child === child) this.child = null
        if (this.aborted) return reject(new Error('mux-aborted'))
        acceptStderrLine(stderrPending)
        resolve({
          exitCode: code,
          frames,
          errors,
          noVideoStream,
          decoderUnavailable,
          timedOut,
        })
      })
    })
  }

  kill(): void {
    this.aborted = true
    this.child?.kill('SIGKILL')
  }
}

export interface DecodeProbeJob {
  binaryPath: string
  input: string
  /** Input seek (seconds) before the window; omitted or 0 → file start. */
  startSec?: number
  windowSec: number
  timeoutMs: number
}

export interface DecodeProbeResult {
  /** Process exit code; null when it was killed (e.g. on timeout). */
  exitCode: number | null
  /** Video frames decoded in the window. */
  frames: number
  /** Error-level log lines, with "Last message repeated N times" expanded. */
  errors: number
  /** The input has no video stream for `-map 0:v:0` to select. */
  noVideoStream: boolean
  /**
   * The selected decoder cannot run on this build/machine at all (e.g. the
   * native hwaccel-only `av1` decoder on a build without libdav1d), so its
   * errors say nothing about the file.
   */
  decoderUnavailable: boolean
  timedOut: boolean
}
