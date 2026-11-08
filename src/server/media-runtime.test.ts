import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import type { FfmpegDetectionResult } from '@core/plugin/capabilities/ffmpeg-detect'
import { TaskManager } from '@core/task/task-manager'
import { makeMediaMetaStoreStub } from '@test-utils/media-meta-store'
import { describe, expect, it, vi } from 'vitest'
import { createServerMediaRuntime } from './media-runtime'

describe('Server media runtime', () => {
  function setup() {
    const detectFfmpeg = vi.fn<() => Promise<FfmpegDetectionResult>>()
    const runtime = createServerMediaRuntime({
      tempDir: '/tmp/server-media',
      detectFfmpeg,
      rpcClient: {
        addUri: vi.fn(async () => 'segment-1'),
        tellStatus: vi.fn(async () => ({})),
        onDownloadComplete: vi.fn(),
        onDownloadError: vi.fn(),
      },
      adapter: {
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
      },
    })
    return { runtime, detectFfmpeg }
  }

  it('uses live detection for capability refresh and muxing after path changes', async () => {
    const { runtime, detectFfmpeg } = setup()
    detectFfmpeg.mockResolvedValue({ active: null, candidates: [] })
    expect(await runtime.ffmpegAvailable()).toBe(false)
    expect(await runtime.resolveFfmpegBinaryPath()).toBeNull()
    for (const binaryPath of ['/data/binaries/ffmpeg', '/custom/ffmpeg']) {
      detectFfmpeg.mockResolvedValue({
        active: { path: binaryPath, version: '9.0.2' },
        candidates: [],
      })
      expect(await runtime.ffmpegAvailable()).toBe(true)
      expect(await runtime.resolveFfmpegBinaryPath()).toBe(binaryPath)
    }
    detectFfmpeg.mockResolvedValue({ active: null, candidates: [] })
    expect(await runtime.ffmpegAvailable()).toBe(false)
    expect(await runtime.resolveFfmpegBinaryPath()).toBeNull()
  })

  it('filters owned GIDs and stale segment snapshots without hiding normal downloads', async () => {
    const { runtime } = setup()
    const segment = { gid: 'segment-1', dir: '' }
    expect(runtime.isSegmentTask(segment)).toBe(false)
    await runtime.segmentAria2.addUri(['https://example.com/part.ts'], {
      dir: runtime.tmpRoot,
      out: 'part.ts',
    })
    expect(runtime.isSegmentTask(segment)).toBe(true)
    await runtime.segmentAria2.removeDownloadResult(segment.gid)
    expect(runtime.isSegmentTask(segment)).toBe(false)

    for (const dir of [
      runtime.tmpRoot,
      path.join(runtime.tmpRoot, 'run/video'),
    ])
      expect(runtime.isSegmentTask({ ...segment, dir })).toBe(true)
    for (const dir of [
      path.dirname(runtime.tmpRoot),
      `${runtime.tmpRoot}-downloads`,
      path.join(runtime.tmpRoot, '../normal'),
    ])
      expect(runtime.isSegmentTask({ ...segment, dir })).toBe(false)
  })

  it('composes the single media runtime over the process segment client', async () => {
    const { runtime, detectFfmpeg } = setup()
    const deps = {
      mediaMetaStore: makeMediaMetaStoreStub(),
      taskManager: new TaskManager(),
      activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
      eventBus: { emit: vi.fn() },
      publishTaskUpdate: vi.fn(),
      publishTaskUpdateNow: vi.fn(),
      pickName: async (_dir: string, name: string) => name,
      persistTask: vi.fn(async () => {}),
    }
    const pipelines = runtime.createPipelines(deps)
    expect(() => runtime.createPipelines(deps)).toThrow(
      'media pipelines already created'
    )
    detectFfmpeg.mockResolvedValue({ active: null, candidates: [] })
    expect(await pipelines.isFfmpegAvailable()).toBe(false)
    detectFfmpeg.mockResolvedValue({
      active: { path: '/data/binaries/ffmpeg', version: '9.0.2' },
      candidates: [],
    })
    expect(await pipelines.isFfmpegAvailable()).toBe(true)
    expect(pipelines.getActiveSegmentGids('unknown')).toEqual([])
  })
})
