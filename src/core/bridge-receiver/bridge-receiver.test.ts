import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { principalKey } from '@core/bridge/credential-store'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import type { SegmentAria2 } from '@core/download/segment-downloader'
import {
  createMediaRuntime,
  type MediaRuntime,
  type MediaRuntimeDeps,
} from '@core/media-resolve/media-runtime'
import { MediaResolveError } from '@core/task/media-resolve-error'
import { MediaTaskCoordinator } from '@core/task/media-task-coordinator'
import { TaskManager } from '@core/task/task-manager'
import { ErrorCodes } from '@motrix/mdxp'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeMediaMetaStoreStub } from '@test-utils/media-meta-store'
import {
  directVariant,
  fakeMediaResolve,
  manifestVariant,
  mediaResolution,
  muxVariant,
} from '@test-utils/media-resolve'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { BridgeReceiver } from './bridge-receiver'

/** Minimal fake SegmentAria2 — never actually called in routing tests. */
const fakeSegmentAria2: SegmentAria2 = {
  addUri: vi.fn(async () => 'gid-seg'),
  forceRemove: vi.fn(async () => {}),
  removeDownloadResult: vi.fn(async () => {}),
  tellStatus: vi.fn(async () => null),
  onComplete: vi.fn(),
  onError: vi.fn(),
}

type MediaFakeOptions = {
  /** Non-null (or a live resolver) builds a real process-scoped runtime. */
  ffmpegBinaryPath?: string | null
  resolveFfmpegBinaryPath?: () => Promise<string | null>
  fetchManifest?: MediaRuntimeDeps['fetchManifest']
  segmentAria2?: SegmentAria2
  taskManager?: TaskManager
  persistTask?: MediaRuntimeDeps['persistTask']
}

function fakeDeps(
  over: Partial<ConstructorParameters<typeof BridgeReceiver>[0]> &
    MediaFakeOptions = {}
) {
  const {
    ffmpegBinaryPath = null,
    resolveFfmpegBinaryPath,
    fetchManifest,
    segmentAria2 = fakeSegmentAria2,
    taskManager = new TaskManager(),
    persistTask = vi.fn(async () => {}),
    ...rest
  } = over
  const base = {
    getDefaultSaveDir: () => '/tmp/save',
    pickName: async (_d: string, n: string) => n,
    createTask: vi.fn(async () => ({ gid: 'gid-1', taskId: 'task-abc' })),
    removeTask: vi.fn(async () => {}),
    submitMagnetForFileSelection: vi.fn(async () => 'magnet-task-1'),
    isMagnetFileSelectionEnabled: () => false,
    eventBus: {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    },
    bridgeBus: {
      emitTaskProgress: vi.fn(),
      emitTaskCompleted: vi.fn(),
      emitTaskError: vi.fn(),
    },
    localize: (c: string) => c,
    ...rest,
  }
  // Default: no media runtime (as in a shell without FFmpeg support), so
  // tests that need one opt in through ffmpegBinaryPath/resolver.
  const media =
    rest.media ??
    (resolveFfmpegBinaryPath || ffmpegBinaryPath !== null
      ? createMediaRuntime({
          mediaMetaStore: makeMediaMetaStoreStub(),
          taskManager,
          activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
          eventBus: base.eventBus as MediaRuntimeDeps['eventBus'],
          publishTaskUpdate: vi.fn(),
          publishTaskUpdateNow: vi.fn(),
          resolveFfmpegBinaryPath:
            resolveFfmpegBinaryPath ?? (async () => ffmpegBinaryPath),
          pickName: base.pickName,
          persistTask,
          segmentAria2,
          tmpRoot: '/tmp/motrix-test',
          fetchManifest,
        })
      : undefined)
  return { ...base, media, fetchManifest }
}

function fakeMediaRuntime() {
  return {
    mux: { dispatch: vi.fn() },
    hlsDash: { dispatch: vi.fn() },
    isFfmpegAvailable: vi.fn(async () => true),
    getActiveSegmentGids: vi.fn(() => []),
    cancel: vi.fn(async () => {}),
    stopAndDrain: vi.fn(async () => {}),
  } as unknown as MediaRuntime & {
    mux: { dispatch: ReturnType<typeof vi.fn> }
    cancel: ReturnType<typeof vi.fn>
    stopAndDrain: ReturnType<typeof vi.fn>
  }
}

function mediaOf(deps: { media?: MediaRuntime }): MediaRuntime {
  if (!deps.media) throw new Error('test needs a media runtime')
  return deps.media
}

describe('BridgeReceiver', () => {
  it('handle: direct submit returns taskId and calls createTask', async () => {
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    const result = await r.handle(
      {
        source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
        selection: {
          kind: 'direct',
          primary: {
            url: 'http://x/f.mp4',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        },
        meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
      },
      {
        identity: { kind: 'extension', browser: 'chromium', extensionId: 'e' },
        startedAt: 0,
        isReady: () => false,
        markReady: () => {},
        pendingPair: null,
      } as never
    )
    expect(result.taskId).toBe('task-abc')
    expect(deps.createTask).toHaveBeenCalledTimes(1)
  })

  it('cancel tries both the direct pipeline and the media runtime', async () => {
    const removeTask = vi.fn(async () => {})
    const media = fakeMediaRuntime()
    const r = new BridgeReceiver(fakeDeps({ removeTask, media }) as never)

    await r.cancel('some-task')
    expect(removeTask).toHaveBeenCalled()
    expect(media.cancel).toHaveBeenCalledWith('some-task')
  })

  it('a bridge stop leaves process-scoped media runs alone, and a restarted receiver reuses the same runtime', async () => {
    const media = fakeMediaRuntime()
    vi.mocked(media.mux.dispatch).mockResolvedValue({ taskId: 'media-1' })
    const first = new BridgeReceiver(fakeDeps({ media }) as never)
    first.start()
    await first.stopAndDrain()
    expect(media.stopAndDrain).not.toHaveBeenCalled()
    expect(media.cancel).not.toHaveBeenCalled()

    const second = new BridgeReceiver(fakeDeps({ media }) as never)
    await expect(
      second.handle(
        {
          source: { pageUrl: 'https://x.test', pageTitle: 'X', detectedAt: 1 },
          selection: {
            kind: 'mux',
            video: {
              url: 'https://cdn.x.test/v.mp4',
              headers: {},
              cookies: [],
              refererPolicy: 'strict-origin-when-cross-origin',
            },
            audio: {
              url: 'https://cdn.x.test/a.mp4',
              headers: {},
              cookies: [],
              refererPolicy: 'strict-origin-when-cross-origin',
            },
            container: 'mp4',
          },
          meta: { suggestedFilename: 'out.mp4', qualityLabel: '1080p' },
        },
        {
          identity: {
            kind: 'extension',
            browser: 'chromium',
            extensionId: 'e',
          },
        } as never
      )
    ).resolves.toEqual({ taskId: 'media-1' })
    expect(media.mux.dispatch).toHaveBeenCalledOnce()
  })

  it('handle: rejects a non-extension (cli) session identity', async () => {
    // download/submit is extension-only. The agent-facing gate already keeps a
    // cli off this method at the unary layer; this is the defense-in-depth
    // guard so the receiver never reads extensionId/browser off a cli identity.
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    await expect(
      r.handle(
        {
          source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
          selection: {
            kind: 'direct',
            primary: {
              url: 'http://x/f.mp4',
              headers: {},
              cookies: [],
              refererPolicy: 'strict-origin-when-cross-origin',
            },
          },
          meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
        },
        {
          identity: { kind: 'cli', id: 'local' },
          startedAt: 0,
          isReady: () => true,
          markReady: () => {},
          pendingPair: null,
        } as never
      )
    ).rejects.toMatchObject({ code: ErrorCodes.CapabilityNotSupported })
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  it('start: subscribes to EventBus.TaskUpdated', () => {
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    r.start()
    expect(deps.eventBus.on).toHaveBeenCalled()
  })

  it('start: derives per-task progress + completed from a TaskUpdated array (bridge tasks only)', () => {
    // Regression for the discovered Plan 02 bug: Events.TaskUpdated carries
    // taskManager.getAll() (an array), and TaskCompleted/TaskFailed are never
    // emitted on the core bus — so the WS push must iterate + derive.
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    r.start()
    const listener = (
      deps.eventBus.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([ev]) => ev === Events.TaskUpdated)?.[1] as (
      p: unknown
    ) => void
    expect(listener).toBeDefined()

    const meta = {
      kind: 'direct' as const,
      extensionId: 'e',
      browser: 'chromium' as const,
      sessionKey: 'chromium:e',
      pageUrl: '',
      pageTitle: '',
      qualityLabel: '',
      durationSec: null,
      submittedAt: 0,
    }
    const bridge = (over: Partial<DownloadTask>) =>
      makeDownloadTask({ source: 'bridge', sourceMeta: meta, ...over })

    listener([
      bridge({ id: 'b1', status: TaskStatus.Downloading }),
      bridge({ id: 'b2', status: TaskStatus.Completed, finalPath: '/dl/x' }),
      // user task is filtered out by ProgressPublisher's source guard
      makeDownloadTask({ id: 'u1', status: TaskStatus.Downloading }),
    ])

    expect(deps.bridgeBus.emitTaskProgress).toHaveBeenCalledTimes(1)
    expect(deps.bridgeBus.emitTaskCompleted).toHaveBeenCalledTimes(1)
  })

  it('cancel: delegates to removeTask using the public taskId', async () => {
    // Boundary test: BridgeReceiver.cancel → DirectPipeline.cancel → deps.removeTask.
    // The deps.removeTask now takes the MDXP taskId (== DownloadTask.id)
    // directly; the core removeTask action also keys by task.id, so the
    // identity round-trips end-to-end without a gid lookup.
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    await r.cancel('task-abc')
    expect(deps.removeTask).toHaveBeenCalledWith('task-abc')
  })

  it('stop: unsubscribes the same TaskUpdated listener it registered', () => {
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    r.start()
    const onListener = (
      deps.eventBus.on as ReturnType<typeof vi.fn>
    ).mock.calls.find(([ev]) => ev === Events.TaskUpdated)?.[1]
    r.stop()
    expect(deps.eventBus.off).toHaveBeenCalledWith(
      Events.TaskUpdated,
      onListener
    )
  })

  it('restoreInflight: no-op', async () => {
    const deps = fakeDeps()
    const r = new BridgeReceiver(deps as never)
    await r.restoreInflight()
  })

  it('routes a magnet submit to a bt createTask', async () => {
    const createTask = vi.fn(async () => ({ gid: 'g', taskId: 'mt1' }))
    const deps = fakeDeps({ createTask })
    const receiver = new BridgeReceiver(deps as never)
    const out = await receiver.handle(
      {
        source: {
          pageUrl: 'https://example.com/p',
          pageTitle: 'P',
          detectedAt: 1,
        },
        selection: {
          kind: 'magnet',
          uri: 'magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
        },
        meta: { suggestedFilename: 'm', qualityLabel: 'file' },
      },
      {
        identity: { kind: 'extension', extensionId: 'e', browser: 'chromium' },
      } as never
    )
    expect(out).toEqual({ taskId: 'mt1' })
    expect((createTask.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      type: 'bt',
      payload: {
        kind: 'magnet',
        uri: 'magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
      },
    })
  })

  // ---------------------------------------------------------------------------
  // Media pipeline routing tests
  // Strategy: inject deps.fetchManifest as a seam so tests never hit the network.
  // ffmpegBinaryPath=null → unsupported-kind (pipeline not built)
  // ffmpegBinaryPath set + fetchManifest stub → routed to HlsDashPipeline,
  //   which calls coordinator.start → returns { taskId }. coordinator.start
  //   is async and performs real I/O, so we spy on HlsDashPipeline.dispatch
  //   instead of letting the full stack run (which would need a real aria2 + ffmpeg).
  // ---------------------------------------------------------------------------

  describe('media pipeline routing', () => {
    const hlsSubmitParams = {
      source: { pageUrl: 'https://x.com', pageTitle: 'X', detectedAt: 1 },
      selection: {
        kind: 'hls' as const,
        primary: {
          url: 'http://example.com/index.m3u8',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
        container: 'mp4' as const,
      },
      meta: { suggestedFilename: 'video.mp4', qualityLabel: '1080p' },
    }

    const muxSubmitParams = {
      source: { pageUrl: 'https://x.com', pageTitle: 'X', detectedAt: 1 },
      selection: {
        kind: 'mux' as const,
        video: {
          url: 'http://example.com/video.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
        audio: {
          url: 'http://example.com/audio.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
        container: 'mp4' as const,
      },
      meta: { suggestedFilename: 'out.mp4', qualityLabel: '1080p' },
    }

    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    it.each(['hls', 'dash', 'mux', 'resolved-page', 'desktop-mux'] as const)(
      'uses newly configured FFmpeg without rebuilding the %s pipeline',
      async (kind) => {
        let binaryPath: string | null = null
        const deps = fakeDeps({
          ffmpegBinaryPath: null,
          resolveFfmpegBinaryPath: async () => binaryPath,
          fetchManifest: vi.fn(
            async () =>
              '#EXTM3U\n#EXTINF:5,\nhttps://example.com/0.ts\n#EXT-X-ENDLIST'
          ),
          mediaResolve: fakeMediaResolve(
            mediaResolution(
              '',
              muxVariant(
                'https://example.com/v.mp4',
                'https://example.com/a.m4a'
              )
            )
          ),
        })
        const receiver = new BridgeReceiver(deps as never)
        const submit = vi
          .spyOn(MediaTaskCoordinator.prototype, 'submit')
          .mockResolvedValue({ taskId: 'accepted' })
        try {
          const attempt = () => {
            if (kind === 'desktop-mux')
              return mediaOf(deps).mux.dispatch({
                kind: 'mux',
                taskId: 'desktop',
                saveDir: '/tmp/save',
                finalName: 'out.mp4',
                videoUrl: 'https://example.com/v.mp4',
                audioUrl: 'https://example.com/a.m4a',
                sanitizedHeaders: {},
                container: 'mp4',
                sourceMeta: {},
              } as never)
            const params =
              kind === 'mux'
                ? muxSubmitParams
                : kind === 'resolved-page'
                  ? {
                      ...hlsSubmitParams,
                      selection: {
                        kind: 'direct',
                        primary: hlsSubmitParams.selection.primary,
                      },
                    }
                  : {
                      ...hlsSubmitParams,
                      selection: { ...hlsSubmitParams.selection, kind },
                    }
            return receiver.handle(params as never, extCtx)
          }
          expect(deps.media).toBeDefined()
          await expect(attempt()).rejects.toMatchObject({
            code: 'unsupported-kind',
          })
          expect(submit).not.toHaveBeenCalled()
          expect(deps.fetchManifest).not.toHaveBeenCalled()
          binaryPath = '/configured/ffmpeg'
          if (kind === 'dash')
            vi.mocked(deps.fetchManifest!).mockResolvedValue(
              '<MPD type="static" mediaPresentationDuration="PT5S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><BaseURL>https://example.com/v.mp4</BaseURL><SegmentList duration="5"><SegmentURL media="https://example.com/0.m4s" /></SegmentList></Representation></AdaptationSet></Period></MPD>'
            )
          await expect(attempt()).resolves.toEqual({ taskId: 'accepted' })
          expect(submit).toHaveBeenCalledTimes(1)
          binaryPath = null
          await expect(attempt()).rejects.toMatchObject({
            code: 'unsupported-kind',
          })
          expect(submit).toHaveBeenCalledTimes(1)
        } finally {
          submit.mockRestore()
        }
      }
    )

    it('hls submit throws unsupported-kind when ffmpegBinaryPath is null', async () => {
      const deps = fakeDeps({ ffmpegBinaryPath: null })
      const r = new BridgeReceiver(deps as never)
      await expect(r.handle(hlsSubmitParams, extCtx)).rejects.toMatchObject({
        name: 'BridgeReceiverError',
        code: 'unsupported-kind',
      })
    })

    it('dash submit throws unsupported-kind when ffmpegBinaryPath is null', async () => {
      const dashParams = {
        ...hlsSubmitParams,
        selection: {
          ...hlsSubmitParams.selection,
          kind: 'dash' as const,
          container: 'mp4' as const,
        },
      }
      const deps = fakeDeps({ ffmpegBinaryPath: null })
      const r = new BridgeReceiver(deps as never)
      await expect(r.handle(dashParams, extCtx)).rejects.toMatchObject({
        name: 'BridgeReceiverError',
        code: 'unsupported-kind',
      })
    })

    it('mux submit throws unsupported-kind when ffmpegBinaryPath is null', async () => {
      const deps = fakeDeps({ ffmpegBinaryPath: null })
      const r = new BridgeReceiver(deps as never)
      await expect(r.handle(muxSubmitParams, extCtx)).rejects.toMatchObject({
        name: 'BridgeReceiverError',
        code: 'unsupported-kind',
      })
    })

    it('hls submit routes to HlsDashPipeline.dispatch when ffmpegBinaryPath is set', async () => {
      // Stub fetchManifest to return a tiny HLS media playlist (no network).
      const fakeM3u8 = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:5',
        '#EXTINF:5.0,',
        'http://example.com/seg0.ts',
        '#EXT-X-ENDLIST',
      ].join('\n')
      const stubFetchManifest = vi.fn(async () => fakeM3u8)

      // Stub coordinator.start so the real download pipeline is never executed.
      // We inject it via MediaTaskCoordinator's deps by spying on the pipeline
      // AFTER construction — capture HlsDashPipeline.dispatch via module spy trick.
      // Easier: pass a fetchManifest that returns the playlist; then stub the
      // HlsDashPipeline by replacing the internal coordinator.start.
      // Approach: replace deps.fetchManifest and stub coordinator via the
      // MediaTaskCoordinator mkdtemp + makeDownloader injection.
      // Simplest offline approach: spy on the dispatch method post-construction.
      const deps = fakeDeps({
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: stubFetchManifest,
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
      })
      const r = new BridgeReceiver(deps as never)

      // Spy on internal hlsDash.dispatch to short-circuit actual segment work.
      // This verifies the routing wires up correctly without running aria2/ffmpeg.
      const hlsDash = mediaOf(deps).hlsDash
      expect(hlsDash).toBeDefined()
      const dispatchSpy = vi
        .spyOn(hlsDash, 'dispatch')
        .mockResolvedValue({ taskId: 'media-task-1' })

      const result = await r.handle(hlsSubmitParams, extCtx)
      expect(result).toEqual({ taskId: 'media-task-1' })
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    })

    it('mux submit routes to MuxPipeline.dispatch when ffmpegBinaryPath is set', async () => {
      const deps = fakeDeps({
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: vi.fn(async () => ''),
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
      })
      const r = new BridgeReceiver(deps as never)

      const mux = mediaOf(deps).mux
      expect(mux).toBeDefined()
      const dispatchSpy = vi
        .spyOn(mux, 'dispatch')
        .mockResolvedValue({ taskId: 'mux-task-1' })

      const result = await r.handle(muxSubmitParams, extCtx)
      expect(result).toEqual({ taskId: 'mux-task-1' })
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Site resolution seam (submit-path pre-resolve)
  // ---------------------------------------------------------------------------

  describe('site resolution seam', () => {
    const PAGE = 'https://video.example/watch/abc'
    const directParams = {
      source: { pageUrl: PAGE, pageTitle: 'T', detectedAt: 1 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: PAGE,
          headers: { 'x-custom': 'val' },
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'vid.mp4', qualityLabel: '1080p' },
    }

    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    function mediaDeps(
      raw: unknown,
      over: Parameters<typeof fakeDeps>[0] = {}
    ) {
      const mediaResolve = fakeMediaResolve(raw)
      const deps = fakeDeps({
        ffmpegBinaryPath: '/usr/bin/ffmpeg',
        fetchManifest: vi.fn(async () => ''),
        taskManager: new TaskManager(),
        segmentAria2: fakeSegmentAria2,
        mediaResolve,
        ...over,
      })
      const receiver = new BridgeReceiver(deps as never)
      const direct = (
        receiver as unknown as {
          direct: { dispatch: (...a: unknown[]) => Promise<{ taskId: string }> }
        }
      ).direct
      return { deps, receiver, mediaResolve, direct }
    }

    it('routes a resolved mux variant to the media runtime, not DirectPipeline', async () => {
      const { deps, receiver, direct } = mediaDeps(
        mediaResolution(
          '',
          muxVariant(
            'https://cdn.example/video.mp4',
            'https://cdn.example/audio.mp4'
          )
        )
      )
      const muxDispatchSpy = vi
        .spyOn(mediaOf(deps).mux, 'dispatch')
        .mockResolvedValue({ taskId: 'pre-resolved-mux-1' })
      const directDispatchSpy = vi.spyOn(direct, 'dispatch')

      const result = await receiver.handle(directParams, extCtx)

      expect(result).toEqual({ taskId: 'pre-resolved-mux-1' })
      expect(directDispatchSpy).not.toHaveBeenCalled()
      expect(muxDispatchSpy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: 'mux',
          taskId: expect.any(String),
          videoUrl: 'https://cdn.example/video.mp4',
          audioUrl: 'https://cdn.example/audio.mp4',
          container: 'mp4',
          sourceMeta: expect.objectContaining({ pageUrl: PAGE }),
        })
      )
    })

    it.each(['hls', 'dash'] as const)(
      'routes a resolved %s variant to the HLS/DASH pipeline',
      async (kind) => {
        const { deps, receiver } = mediaDeps(
          mediaResolution(
            'Clip',
            manifestVariant(kind, `https://cdn.example/${kind}`, {
              Referer: 'https://video.example/',
            })
          )
        )
        const spy = vi
          .spyOn(mediaOf(deps).hlsDash, 'dispatch')
          .mockResolvedValue({ taskId: 'media-1' })
        await expect(receiver.handle(directParams, extCtx)).resolves.toEqual({
          taskId: 'media-1',
        })
        expect(spy).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            kind,
            manifestUrl: `https://cdn.example/${kind}`,
            sanitizedHeaders: { Referer: 'https://video.example/' },
            finalName: 'Clip.mp4',
          })
        )
        expect(deps.createTask).not.toHaveBeenCalled()
      }
    )

    it('downloads a resolved direct variant as a direct task without the page cookies', async () => {
      const { deps, receiver } = mediaDeps(
        mediaResolution(
          'Clip',
          directVariant('https://cdn.example/360.mp4', {
            mirrors: ['https://mirror.example/360.mp4'],
            headers: { Referer: 'https://video.example/' },
          })
        ),
        { ffmpegBinaryPath: null }
      )
      const params = structuredClone(directParams)
      params.selection.primary.cookies = [
        {
          name: 'sid',
          value: 'secret',
          domain: '.video.example',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
        },
      ] as never

      await receiver.handle(params, extCtx)

      expect(deps.createTask).toHaveBeenCalledOnce()
      const [req, , options] = vi.mocked(deps.createTask).mock
        .calls[0] as unknown as [
        Record<string, unknown>,
        unknown,
        Record<string, unknown>,
      ]
      expect(req).toMatchObject({
        uris: ['https://cdn.example/360.mp4', 'https://mirror.example/360.mp4'],
        filename: 'Clip.mp4',
        headers: [{ name: 'Referer', value: 'https://video.example/' }],
      })
      expect(options.cookies).toEqual([])
    })

    it('re-picks the resolver title WITH its container extension (dedup runs on the on-disk name)', async () => {
      const picked: string[] = []
      const { deps, receiver } = mediaDeps(
        mediaResolution(
          'Human Title',
          muxVariant('https://cdn.example/v.mp4', 'https://cdn.example/a.m4a')
        ),
        {
          pickName: async (_d: string, n: string) => {
            picked.push(n)
            return n
          },
        }
      )
      const muxDispatchSpy = vi
        .spyOn(mediaOf(deps).mux, 'dispatch')
        .mockResolvedValue({ taskId: 't' })

      await receiver.handle(directParams, extCtx)

      expect(picked).toContain('Human Title.mp4')
      expect(muxDispatchSpy.mock.calls[0]?.[0]).toMatchObject({
        finalName: 'Human Title.mp4',
      })
    })

    it('falls through to direct dispatch when no resolver claims the URL', async () => {
      const { deps, receiver, mediaResolve } = mediaDeps(null)

      const result = await receiver.handle(directParams, extCtx)

      expect(result.taskId).toBeDefined()
      expect(deps.createTask).toHaveBeenCalledTimes(1)
      // Empty cookies are not forwarded.
      expect(mediaResolve.resolve).toHaveBeenCalledWith(PAGE, {})
    })

    it('rejects the submit when a matching resolver fails instead of downloading the page directly', async () => {
      const { deps, receiver } = mediaDeps(() => {
        throw new MediaResolveError(
          'community.site-resolver',
          'command-failed',
          new Error('timed out')
        )
      })

      await expect(receiver.handle(directParams, extCtx)).rejects.toMatchObject(
        {
          code: ErrorCodes.AdapterError,
          data: {
            appCode: 'media-resolve-failed',
            retryable: true,
            context: {
              pluginId: 'community.site-resolver',
              failure: 'command-failed',
            },
          },
        }
      )
      expect(deps.createTask).not.toHaveBeenCalled()
    })

    it('marks an invalid resolver result as not retryable', async () => {
      const { deps, receiver } = mediaDeps({ kind: 'mux', video: {} })

      await expect(receiver.handle(directParams, extCtx)).rejects.toMatchObject(
        { data: { appCode: 'media-resolve-failed', retryable: false } }
      )
      expect(deps.createTask).not.toHaveBeenCalled()
    })

    it('keeps a resolver timeout retryable', async () => {
      const { receiver } = mediaDeps(() => {
        throw new MediaResolveError('example.media-resolver', 'timeout')
      })

      await expect(receiver.handle(directParams, extCtx)).rejects.toMatchObject(
        {
          data: {
            appCode: 'media-resolve-failed',
            retryable: true,
            context: { failure: 'timeout' },
          },
        }
      )
    })

    it.each([
      ['login-required', 'auth-expired', false],
      ['drm', 'unsupported-encryption', false],
      ['live-unsupported', 'unsupported-live', false],
      ['removed', 'not-found', false],
      ['rate-limited', 'transient-failure', true],
      ['region-locked', 'unsupported-kind', false],
    ] as const)(
      'rejects unavailable media (%s) with its localized reason and code %s',
      async (reason, code, retryable) => {
        const { deps, receiver } = mediaDeps(
          { kind: 'unavailable', reason },
          { translate: (key: string) => `t:${key}` }
        )
        await expect(
          receiver.handle(directParams, extCtx)
        ).rejects.toMatchObject({
          code: ErrorCodes.AdapterError,
          message: expect.stringMatching(/^t:task\.add\.media\.unavailable\./),
          data: {
            appCode: 'media-resolve-failed',
            retryable,
            context: { failure: 'unavailable', reason, code },
          },
        })
        expect(deps.createTask).not.toHaveBeenCalled()
      }
    )

    it('rejects FFmpeg-only variants without FFmpeg like any media submit', async () => {
      const { deps, receiver } = mediaDeps(
        mediaResolution(
          'Clip',
          muxVariant('https://cdn.example/v.mp4', 'https://cdn.example/a.m4a')
        ),
        { ffmpegBinaryPath: null, media: undefined }
      )
      await expect(receiver.handle(directParams, extCtx)).rejects.toMatchObject(
        { name: 'BridgeReceiverError', code: 'unsupported-kind' }
      )
      expect(deps.createTask).not.toHaveBeenCalled()
    })

    it.each([
      ['a non-http scheme', 'ftp://cdn.example/video.m4s'],
      ['embedded credentials', 'https://user:secret@cdn.example/video.m4s'],
    ])(
      'rejects resolver stream URLs with %s before any dispatch',
      async (_label, videoUrl) => {
        const { deps, receiver, direct } = mediaDeps(
          mediaResolution(
            'Clip',
            muxVariant(videoUrl, 'https://cdn.example/audio.m4s')
          )
        )
        const muxDispatchSpy = vi.spyOn(mediaOf(deps).mux, 'dispatch')
        const directDispatchSpy = vi.spyOn(direct, 'dispatch')

        await expect(
          receiver.handle(directParams, extCtx)
        ).rejects.toMatchObject({
          data: {
            appCode: 'media-resolve-failed',
            context: { failure: 'invalid-result' },
          },
        })
        expect(muxDispatchSpy).not.toHaveBeenCalled()
        expect(directDispatchSpy).not.toHaveBeenCalled()
        expect(deps.createTask).not.toHaveBeenCalled()
      }
    )

    it('falls through to direct dispatch when no resolve service is wired', async () => {
      const deps = fakeDeps()
      const r = new BridgeReceiver(deps as never)

      const result = await r.handle(directParams, extCtx)

      expect(result.taskId).toBeDefined()
      expect(deps.createTask).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // serializeCookieHeader helper tests (BIL-HD)
  // ---------------------------------------------------------------------------

  describe('serializeCookieHeader()', () => {
    it('serializes two cookies to a Cookie header string', async () => {
      // Import the helper directly from BridgeReceiver module
      const { serializeCookieHeader } = await import('./bridge-receiver')
      const cookies = [
        { name: 'SESSDATA', value: 'abc' },
        { name: 'bili_jct', value: 'x' },
      ]
      expect(serializeCookieHeader(cookies)).toBe('SESSDATA=abc; bili_jct=x')
    })

    it('returns empty string for empty array', async () => {
      const { serializeCookieHeader } = await import('./bridge-receiver')
      expect(serializeCookieHeader([])).toBe('')
    })

    it('serializes a single cookie', async () => {
      const { serializeCookieHeader } = await import('./bridge-receiver')
      expect(
        serializeCookieHeader([{ name: 'SESSDATA', value: 'tok123' }])
      ).toBe('SESSDATA=tok123')
    })
  })

  // ---------------------------------------------------------------------------
  // BridgeReceiver cookie seam tests (BIL-HD)
  // ---------------------------------------------------------------------------

  describe('cookie seam: the resolver receives the cookie header', () => {
    const bilibiliPageParams = {
      source: {
        pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
        pageTitle: 'B',
        detectedAt: 1,
      },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          headers: {},
          cookies: [
            {
              name: 'SESSDATA',
              value: 'abc',
              domain: '.bilibili.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'lax' as const,
            },
            {
              name: 'bili_jct',
              value: 'x',
              domain: '.bilibili.com',
              path: '/',
              secure: false,
              httpOnly: false,
              sameSite: 'lax' as const,
            },
          ],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'vid', qualityLabel: '1080p' },
    }

    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    it('direct submit with cookies → the resolver gets the serialized cookie header', async () => {
      const mediaResolve = fakeMediaResolve(null)
      const deps = fakeDeps({ mediaResolve })
      const r = new BridgeReceiver(deps as never)
      await r.handle(bilibiliPageParams, extCtx)
      expect(mediaResolve.resolve).toHaveBeenCalledWith(
        'https://www.bilibili.com/video/BV1xx411c7mD',
        { cookieHeader: 'SESSDATA=abc; bili_jct=x' }
      )
    })

    it('direct submit with empty cookies → the resolver gets no cookie header', async () => {
      const mediaResolve = fakeMediaResolve(null)
      const paramsNoCookies = {
        ...bilibiliPageParams,
        selection: {
          ...bilibiliPageParams.selection,
          primary: {
            ...bilibiliPageParams.selection.primary,
            cookies: [],
          },
        },
      }
      const deps = fakeDeps({ mediaResolve })
      const r = new BridgeReceiver(deps as never)
      await r.handle(paramsNoCookies, extCtx)
      expect(mediaResolve.resolve).toHaveBeenCalledWith(
        'https://www.bilibili.com/video/BV1xx411c7mD',
        {}
      )
    })
  })

  // ---------------------------------------------------------------------------
  // download/submit idempotency (dedup on session + idempotencyKey)
  // ---------------------------------------------------------------------------

  describe('submit idempotency', () => {
    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    const submitParams = (idempotencyKey?: string) => ({
      source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'http://x/f.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })

    it('collapses a retransmit with the same key onto the pending submit', async () => {
      let resolveCreate!: (v: { gid: string; taskId: string }) => void
      const createTask = vi.fn(
        () =>
          new Promise<{ gid: string; taskId: string }>((r) => {
            resolveCreate = r
          })
      )
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const p1 = r.handle(submitParams('key-aaaaaaaa'), extCtx)
      const p2 = r.handle(submitParams('key-aaaaaaaa'), extCtx)
      // createTask is reached only after asynchronous name selection;
      // wait for the first dispatch to arrive there before releasing it.
      await vi.waitFor(() => expect(createTask).toHaveBeenCalled())
      resolveCreate({ gid: 'g', taskId: 'task-1' })
      const [r1, r2] = await Promise.all([p1, p2])

      expect(createTask).toHaveBeenCalledTimes(1)
      expect(r1.taskId).toBe(r2.taskId)
    })

    it('a settled key keeps returning the original task (exact retransmit after completion)', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const r1 = await r.handle(submitParams('key-bbbbbbbb'), extCtx)
      const r2 = await r.handle(submitParams('key-bbbbbbbb'), extCtx)
      expect(createTask).toHaveBeenCalledTimes(1)
      expect(r2.taskId).toBe(r1.taskId)
    })

    it('isolates same-key submissions and notification metadata between installations, while reconnect retries deduplicate', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const r = new BridgeReceiver(
        fakeDeps({ createTask: createTask as never }) as never
      )
      const context = (clientInstallationId: string): MdxpSessionContext => ({
        ...(extCtx as MdxpSessionContext),
        sessionKey: principalKey({
          browser: 'chromium',
          verifiedOrigin: 'chrome-extension://e',
          clientInstallationId,
        }),
      })
      const a = context('profile-a')
      const b = context('profile-b')
      const first = await r.handle(submitParams('shared-key'), a)
      const second = await r.handle(submitParams('shared-key'), b)
      const retry = await r.handle(
        submitParams('shared-key'),
        context('profile-a')
      )
      expect(first.taskId).not.toBe(second.taskId)
      expect(retry).toEqual(first)
      expect(createTask).toHaveBeenCalledTimes(2)
      expect(createTask).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        undefined,
        expect.objectContaining({
          sourceMeta: expect.objectContaining({ sessionKey: a.sessionKey }),
        })
      )
      expect(createTask).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        undefined,
        expect.objectContaining({
          sourceMeta: expect.objectContaining({ sessionKey: b.sessionKey }),
        })
      )
    })

    it('different keys create independent tasks', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const r1 = await r.handle(submitParams('key-cccccccc'), extCtx)
      const r2 = await r.handle(submitParams('key-dddddddd'), extCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
      expect(r1.taskId).not.toBe(r2.taskId)
    })

    it('a failed submit is NOT cached — the same key retries for real', async () => {
      const createTask = vi
        .fn()
        .mockRejectedValueOnce(new Error('engine down'))
        .mockResolvedValueOnce({ gid: 'g', taskId: 'task-retry' })
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      await expect(
        r.handle(submitParams('key-eeeeeeee'), extCtx)
      ).rejects.toThrow('engine down')
      const r2 = await r.handle(submitParams('key-eeeeeeee'), extCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
      expect(r2.taskId).toBe('task-retry')
    })

    it('no key → no dedup (back-compat with older extensions)', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      await r.handle(submitParams(), extCtx)
      await r.handle(submitParams(), extCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
    })

    it('eviction never drops a PENDING submit (a long media submit survives a keyed burst)', async () => {
      let resolveCreate!: (v: { gid: string; taskId: string }) => void
      const first = new Promise<{ gid: string; taskId: string }>((r) => {
        resolveCreate = r
      })
      const createTask = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockImplementation(async () => ({ gid: 'g', taskId: 'quick' }))
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)

      const pending = r.handle(submitParams('key-pending-000'), extCtx)
      await vi.waitFor(() => expect(createTask).toHaveBeenCalled())

      // A burst larger than the dedup cache capacity. Capacity eviction must
      // skip the still-pending entry — evicting it would let a reconnect
      // replay re-dispatch the same logical submit as a duplicate task.
      for (let i = 0; i < 500; i++) {
        await r.handle(
          submitParams(`key-burst-${String(i).padStart(8, '0')}`),
          extCtx
        )
      }

      const callsBefore = createTask.mock.calls.length
      const replay = r.handle(submitParams('key-pending-000'), extCtx)
      resolveCreate({ gid: 'g', taskId: 'task-first' })
      const [a, b] = await Promise.all([pending, replay])

      expect(a.taskId).toBe('task-first')
      expect(b.taskId).toBe('task-first')
      expect(createTask.mock.calls.length).toBe(callsBefore)
    })

    it('keys are scoped per session — same key from another extension is a new submit', async () => {
      let n = 0
      const createTask = vi.fn(async () => ({
        gid: 'g',
        taskId: `task-${++n}`,
      }))
      const deps = fakeDeps({ createTask: createTask as never })
      const r = new BridgeReceiver(deps as never)
      const otherCtx = {
        identity: {
          kind: 'extension' as const,
          extensionId: 'other',
          browser: 'firefox' as const,
        },
      } as never

      await r.handle(submitParams('key-ffffffff'), extCtx)
      await r.handle(submitParams('key-ffffffff'), otherCtx)
      expect(createTask).toHaveBeenCalledTimes(2)
    })
  })

  // A submit that lands while SessionManager.restore() is still running gets
  // its freshly-registered task wiped by restore's clear() and re-adopted as
  // an engine orphan (name with `.motrix`, source/sourceMeta lost, extension
  // progress notifications orphaned). The bootstrap passes a waitForReady
  // gate that resolves once startup restore has settled; every submit must
  // await it BEFORE any pipeline work reaches the engine.
  describe('startup ready gate (waitForReady)', () => {
    const extCtx = {
      identity: {
        kind: 'extension' as const,
        extensionId: 'e',
        browser: 'chromium' as const,
      },
    } as never

    const directParams = () => ({
      source: { pageUrl: 'http://x', pageTitle: 't', detectedAt: 1 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'http://x/f.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'f.mp4', qualityLabel: 'q' },
    })

    it('holds a submit until waitForReady resolves', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const createTask = vi.fn(async () => ({ gid: 'g', taskId: 'task-abc' }))
      const deps = fakeDeps({
        createTask: createTask as never,
        waitForReady: () => gate,
      } as never)
      const r = new BridgeReceiver(deps as never)

      const pending = r.handle(directParams(), extCtx)
      // Drain a few macrotask turns — without the gate the dispatch would
      // have reached createTask by now (adapt's name selection is the
      // only other async step).
      await new Promise((res) => setTimeout(res, 10))
      expect(createTask).not.toHaveBeenCalled()

      release()
      const result = await pending
      expect(result.taskId).toBe('task-abc')
      expect(createTask).toHaveBeenCalledTimes(1)
    })

    it('dispatches immediately when no gate is wired (back-compat)', async () => {
      const deps = fakeDeps()
      const r = new BridgeReceiver(deps as never)
      const result = await r.handle(directParams(), extCtx)
      expect(result.taskId).toBe('task-abc')
    })
  })
})
