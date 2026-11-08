import type { MediaPart } from '@core/media/segment-plan'
import type {
  MediaJob,
  MediaTaskCoordinator,
} from '@core/task/media-task-coordinator'
import type { AdaptedMux } from '../submit-download-adapter'
import { ensureMediaExtension } from './media-final-name'

export interface MuxPipelineDeps {
  coordinator: Pick<MediaTaskCoordinator, 'submit'>
  /** Reject before fetching manifests or creating a task if FFmpeg is absent. */
  assertFfmpegAvailable?: () => Promise<void>
}

/**
 * Pipeline for `kind: 'mux'` adapted selections. Builds two single-part
 * SegmentPlans (container: 'single') and hands them to MediaTaskCoordinator.
 */
export class MuxPipeline {
  constructor(private readonly deps: MuxPipelineDeps) {}

  async dispatch(adapted: AdaptedMux): Promise<{ taskId: string }> {
    await this.deps.assertFfmpegAvailable?.()
    const job: MediaJob = {
      taskId: adapted.taskId,
      kind: 'mux',
      video: {
        container: 'single',
        segments: [leg(adapted.videoUrl, adapted.videoMirrors)],
        isComplete: true,
      },
      audio: {
        container: 'single',
        segments: [leg(adapted.audioUrl, adapted.audioMirrors)],
        isComplete: true,
      },
      headers: adapted.sanitizedHeaders,
      saveDir: adapted.saveDir,
      // ffmpeg needs an output extension or it can't pick a muxer (exit 234).
      finalName: ensureMediaExtension(adapted.finalName, adapted.container),
      sourceMeta: adapted.sourceMeta,
      ...(adapted.receipt ? { receipt: adapted.receipt } : {}),
      ...(adapted.durationSec !== undefined
        ? { durationSec: adapted.durationSec }
        : {}),
    }
    return this.deps.coordinator.submit(job)
  }
}

function leg(url: string, mirrors: string[] | undefined): MediaPart {
  return {
    url,
    index: 0,
    ...(mirrors?.length ? { mirrors: [...mirrors] } : {}),
  }
}
