import path from 'node:path'
import { Aria2SegmentClient } from '@core/download/aria2-segment-client'
import {
  createMediaRuntime,
  type MediaRuntime,
  type MediaRuntimeDeps,
} from '@core/media-resolve/media-runtime'
import type { FfmpegDetectionResult } from '@core/plugin/capabilities/ffmpeg-detect'

export type ServerMediaPipelineDeps = Omit<
  MediaRuntimeDeps,
  'segmentAria2' | 'tmpRoot' | 'resolveFfmpegBinaryPath'
>

/**
 * Process-lifetime media resources shared by bridge restarts and task
 * polling. The segment client and temp root exist from startup (Session
 * restore and the poll loop need them); the HLS/DASH/mux pipelines are
 * composed once the task services they persist through are ready.
 */
export function createServerMediaRuntime(opts: {
  rpcClient: ConstructorParameters<typeof Aria2SegmentClient>[0]
  adapter: ConstructorParameters<typeof Aria2SegmentClient>[1]
  tempDir: string
  detectFfmpeg: () => Promise<FfmpegDetectionResult>
}) {
  const tmpRoot = path.join(opts.tempDir, 'motrix-media')
  const segmentAria2 = new Aria2SegmentClient(opts.rpcClient, opts.adapter)
  const resolveFfmpegBinaryPath = async (): Promise<string | null> =>
    (await opts.detectFfmpeg()).active?.path ?? null
  let pipelines: MediaRuntime | null = null

  return {
    tmpRoot,
    segmentAria2,
    resolveFfmpegBinaryPath,
    ffmpegAvailable: async () => (await resolveFfmpegBinaryPath()) !== null,
    /** Build the process's single media runtime. Throws on a second call. */
    createPipelines(deps: ServerMediaPipelineDeps): MediaRuntime {
      if (pipelines) throw new Error('media pipelines already created')
      pipelines = createMediaRuntime({
        ...deps,
        segmentAria2,
        tmpRoot,
        resolveFfmpegBinaryPath,
      })
      return pipelines
    },
    isSegmentTask: (task: { gid: string; dir: string }): boolean => {
      if (segmentAria2.isSegmentGid(task.gid)) return true
      if (!task.dir) return false
      // Directory ownership also covers the window before addUri returns a GID
      // and stale polling snapshots after a segment's result has been purged.
      const relative = path.relative(tmpRoot, path.resolve(task.dir))
      return (
        relative === '' ||
        (relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      )
    },
  }
}
