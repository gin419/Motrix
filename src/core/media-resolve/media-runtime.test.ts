import { MediaTaskCoordinator } from '@core/task/media-task-coordinator'
import { makeTestMediaRuntime } from '@test-utils/bridge-receiver'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('createMediaRuntime', () => {
  afterEach(() => vi.restoreAllMocks())

  it('routes mux and HLS jobs into one coordinator instance', async () => {
    const owners: unknown[] = []
    vi.spyOn(MediaTaskCoordinator.prototype, 'submit').mockImplementation(
      async function (this: MediaTaskCoordinator) {
        owners.push(this)
        return { taskId: 'accepted' }
      }
    )
    const runtime = makeTestMediaRuntime({
      fetchManifest: async () =>
        '#EXTM3U\n#EXTINF:5,\nhttps://cdn.media.test/0.ts\n#EXT-X-ENDLIST',
    })

    await runtime.mux.dispatch({
      kind: 'mux',
      taskId: 'm',
      saveDir: '/tmp/save',
      finalName: 'out.mp4',
      videoUrl: 'https://cdn.media.test/v.mp4',
      audioUrl: 'https://cdn.media.test/a.m4a',
      sanitizedHeaders: {},
      container: 'mp4',
      sourceMeta: null,
    })
    await runtime.hlsDash.dispatch({
      kind: 'hls',
      taskId: 'h',
      saveDir: '/tmp/save',
      finalName: 'out.mp4',
      manifestUrl: 'https://cdn.media.test/index.m3u8',
      sanitizedHeaders: {},
      container: 'mp4',
      sourceMeta: {},
    } as never)

    expect(owners).toHaveLength(2)
    expect(owners[0]).toBe(owners[1])
  })

  it('delegates cancel, segment gids and drain to that coordinator', async () => {
    const cancel = vi
      .spyOn(MediaTaskCoordinator.prototype, 'cancel')
      .mockResolvedValue()
    const gids = vi
      .spyOn(MediaTaskCoordinator.prototype, 'getActiveSegmentGids')
      .mockReturnValue(['gid-1'])
    const drain = vi
      .spyOn(MediaTaskCoordinator.prototype, 'stopAndDrain')
      .mockResolvedValue()
    const runtime = makeTestMediaRuntime()

    await runtime.cancel('t')
    expect(runtime.getActiveSegmentGids('t')).toEqual(['gid-1'])
    await runtime.stopAndDrain()

    expect(cancel).toHaveBeenCalledWith('t')
    expect(gids).toHaveBeenCalledWith('t')
    expect(drain).toHaveBeenCalledOnce()
  })

  it('rejects media jobs while FFmpeg is unavailable, re-checked per job', async () => {
    let binary: string | null = null
    const submit = vi
      .spyOn(MediaTaskCoordinator.prototype, 'submit')
      .mockResolvedValue({ taskId: 'accepted' })
    const runtime = makeTestMediaRuntime({
      resolveFfmpegBinaryPath: async () => binary,
    })
    const job = {
      kind: 'mux' as const,
      taskId: 'm',
      saveDir: '/tmp/save',
      finalName: 'out.mp4',
      videoUrl: 'https://cdn.media.test/v.mp4',
      audioUrl: 'https://cdn.media.test/a.m4a',
      sanitizedHeaders: {},
      container: 'mp4' as const,
      sourceMeta: null,
    }
    expect(await runtime.isFfmpegAvailable()).toBe(false)
    await expect(runtime.mux.dispatch(job)).rejects.toMatchObject({
      code: 'unsupported-kind',
    })
    binary = '/usr/bin/ffmpeg'
    expect(await runtime.isFfmpegAvailable()).toBe(true)
    await expect(runtime.mux.dispatch(job)).resolves.toEqual({
      taskId: 'accepted',
    })
    expect(submit).toHaveBeenCalledOnce()
  })
})
