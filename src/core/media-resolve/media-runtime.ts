import fs from 'node:fs'
import path from 'node:path'
import { BridgeReceiverError } from '@core/bridge-receiver/errors'
import { HlsDashPipeline } from '@core/bridge-receiver/pipelines/hls-dash-pipeline'
import { MuxPipeline } from '@core/bridge-receiver/pipelines/mux-pipeline'
import type { SegmentAria2 } from '@core/download/segment-downloader'
import { SegmentDownloader } from '@core/download/segment-downloader'
import { FfmpegService } from '@core/ffmpeg/ffmpeg-service'
import { fetchManifest } from '@core/media/manifest-fetcher'
import { assembleSegments } from '@core/media/segment-assembler'
import { SegmentDecryptor } from '@core/media/segment-decryptor'
import {
  type MediaCoordinatorDeps,
  MediaTaskCoordinator,
} from '@core/task/media-task-coordinator'

/**
 * The HLS/DASH/mux pipelines and the one MediaTaskCoordinator behind them.
 * A shell builds exactly one per process: a second coordinator would not see
 * the first one's runs (the SP-1 phantom-task bug), and media tasks belong
 * to the app, not to the browser bridge that may have submitted them.
 */
export interface MediaRuntime {
  readonly mux: MuxPipeline
  readonly hlsDash: HlsDashPipeline
  /** Re-checks the live FFmpeg resolver. */
  isFfmpegAvailable(): Promise<boolean>
  /**
   * Live aria2 segment gids of a coordinator-managed task, so pause/resume can
   * act on them (the task's own engineTaskId is ''). [] for an unknown task
   * or one past its download phase.
   */
  getActiveSegmentGids(taskId: string): string[]
  /** Tear down a media task's in-flight run. No-op once it has finished. */
  cancel(taskId: string): Promise<void>
  /** Close the submit gate, cancel every run and wait for them. Idempotent. */
  stopAndDrain(): Promise<void>
}

export interface MediaRuntimeDeps {
  mediaMetaStore: MediaCoordinatorDeps['mediaMetaStore']
  taskManager: MediaCoordinatorDeps['taskManager']
  activityRecorder: MediaCoordinatorDeps['activityRecorder']
  eventBus: MediaCoordinatorDeps['eventBus']
  publishTaskUpdate: MediaCoordinatorDeps['publishTaskUpdate']
  publishTaskUpdateNow: MediaCoordinatorDeps['publishTaskUpdateNow']
  /** Re-resolved before accepting a job and immediately before each mux. */
  resolveFfmpegBinaryPath: () => Promise<string | null>
  pickName: MediaCoordinatorDeps['pickName']
  /** Durable save for coordinator-driven transitions (media tasks bypass the
   *  aria2 poll loop's transition saves). */
  persistTask: MediaCoordinatorDeps['persist']
  persistTaskWithOccurrence?: MediaCoordinatorDeps['persistTaskWithOccurrence']
  occurrenceDispatcher?: MediaCoordinatorDeps['occurrenceDispatcher']
  parentTaskCreated?: MediaCoordinatorDeps['parentTaskCreated']
  recordTransition?: MediaCoordinatorDeps['recordTransition']
  runTaskMutation?: MediaCoordinatorDeps['runTaskMutation']
  segmentAria2: SegmentAria2
  /** Parent of every media job's temp directory. */
  tmpRoot: string
  /** Test seam; defaults to the real manifest fetcher. */
  fetchManifest?: (
    url: string,
    opts: { headers?: Record<string, string> }
  ) => Promise<string>
}

export function createMediaRuntime(deps: MediaRuntimeDeps): MediaRuntime {
  const { resolveFfmpegBinaryPath, tmpRoot } = deps
  const assertFfmpegAvailable = async () => {
    if (!(await resolveFfmpegBinaryPath())) {
      throw new BridgeReceiverError(
        'unsupported-kind',
        'ffmpeg is unavailable; configure it in Settings and retry'
      )
    }
  }
  const coordinator = new MediaTaskCoordinator({
    mediaMetaStore: deps.mediaMetaStore,
    taskManager: deps.taskManager,
    activityRecorder: deps.activityRecorder,
    eventBus: deps.eventBus,
    publishTaskUpdate: deps.publishTaskUpdate,
    publishTaskUpdateNow: deps.publishTaskUpdateNow,
    resolveFfmpegBinaryPath,
    pickName: deps.pickName,
    persist: deps.persistTask,
    persistTaskWithOccurrence: deps.persistTaskWithOccurrence,
    occurrenceDispatcher: deps.occurrenceDispatcher,
    parentTaskCreated: deps.parentTaskCreated,
    recordTransition: deps.recordTransition,
    runTaskMutation: deps.runTaskMutation,
    makeDownloader: (tmpDir: string) =>
      new SegmentDownloader({ aria2: deps.segmentAria2, tmpDir }),
    decryptor: new SegmentDecryptor(),
    assemble: assembleSegments,
    makeFfmpeg: () => new FfmpegService(),
    mkdtemp: async () => {
      // mkdtemp requires its PARENT to exist. tmpRoot is not created anywhere
      // else, so ensure it first — otherwise the first media task fails with
      // ENOENT on mkdtemp.
      await fs.promises.mkdir(tmpRoot, { recursive: true })
      return fs.promises.mkdtemp(path.join(tmpRoot, 'motrix-media-'))
    },
  })
  const hlsDash = new HlsDashPipeline({
    fetchManifest: deps.fetchManifest ?? fetchManifest,
    coordinator,
    assertFfmpegAvailable,
  })
  const mux = new MuxPipeline({ coordinator, assertFfmpegAvailable })

  return {
    mux,
    hlsDash,
    isFfmpegAvailable: async () => (await resolveFfmpegBinaryPath()) !== null,
    getActiveSegmentGids: (taskId) => coordinator.getActiveSegmentGids(taskId),
    cancel: (taskId) => coordinator.cancel(taskId),
    stopAndDrain: () => coordinator.stopAndDrain(),
  }
}
