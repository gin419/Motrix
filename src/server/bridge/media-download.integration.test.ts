// @vitest-environment node
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import {
  exchangeCredential,
  initializeParams,
  mdxpOverChannel,
  runPake,
  startPair,
} from '@core/bridge/__tests__/mbp1-client'
import { BridgeReceiver } from '@core/bridge-receiver/bridge-receiver'
import { EventBus } from '@core/events/event-bus'
import { FfmpegService } from '@core/ffmpeg/ffmpeg-service'
import { getLogger } from '@core/logger'
import { pauseTask, removeTask, resumeTask } from '@core/task/actions'
import { TaskManager } from '@core/task/task-manager'
import {
  type DownloadSubmitParams,
  ErrorCodes,
  type InitializeResult,
  Methods,
  Notifications,
} from '@motrix/mdxp'
import { BridgeQueries } from '@shared/protocol/bridge'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import {
  makeBridgeReceiverDeps,
  makeDirectSubmit,
} from '@test-utils/bridge-receiver'
import { makeMediaMetaStoreStub } from '@test-utils/media-meta-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerMediaRuntime } from '../media-runtime'
import { bootstrapBridgeForServer, type ServerBridgeRuntime } from './bootstrap'
import { parseRemoteExtensionConfig } from './remote-extension-config'

describe('Server extension media downloads', () => {
  let root: string
  let runtime: ServerBridgeRuntime | undefined
  let closeClient: (() => void) | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'motrix-server-media-'))
  })
  afterEach(async () => {
    closeClient?.()
    closeClient = undefined
    await runtime?.shutdown()
    runtime = undefined
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  async function setup() {
    const eventBus = new EventBus()
    const taskManager = new TaskManager()
    const persisted = new Map<string, DownloadTask>()
    const persistTask = vi.fn(async (task: DownloadTask) => {
      persisted.set(task.id, structuredClone(task))
    })
    let binaryPath: string | null = null
    const completeHandlers: Array<(event: { gid: string }) => void> = []
    const segmentFiles = new Map<string, string>()
    let serial = 0
    const adapter = {
      pauseTask: vi.fn(async () => {}),
      resumeTask: vi.fn(async () => {}),
      forceRemoveTask: vi.fn(async () => {}),
      removeDownloadResult: vi.fn(async () => {}),
    }
    const media = createServerMediaRuntime({
      tempDir: path.join(root, 'temp'),
      detectFfmpeg: async () => ({
        active: binaryPath ? { path: binaryPath, version: '9.0.2' } : null,
        candidates: [],
      }),
      adapter,
      rpcClient: {
        addUri: vi.fn(async (_uris, options) => {
          const gid = `segment-${++serial}`
          const file = path.join(String(options.dir), String(options.out))
          await writeFile(file, 'media fixture')
          segmentFiles.set(gid, file)
          return gid
        }),
        tellStatus: vi.fn(async () => ({
          completedLength: '13',
          totalLength: '13',
        })),
        onDownloadComplete: (callback) => {
          completeHandlers.push(callback)
        },
        onDownloadError: vi.fn(),
      },
    })
    // Keep the coordinator, segment assembly, publication and persistence real;
    // only external aria2 and FFmpeg processes are replaced in this CI test.
    const ffmpeg = vi
      .spyOn(FfmpegService.prototype, 'run')
      .mockImplementation(async (job, progress) => {
        await copyFile(job.videoPath, job.output)
        progress({ progress: 1 })
        return { outputDurationSec: null }
      })
    const saveDir = path.join(root, 'downloads')
    await mkdir(saveDir)
    const fetchManifest = vi.fn(async (url: string) =>
      url.endsWith('.mpd')
        ? '<MPD type="static" mediaPresentationDuration="PT5S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><BaseURL>https://example.com/v.mp4</BaseURL><SegmentList duration="5"><SegmentURL media="https://example.com/0.m4s" /></SegmentList></Representation></AdaptationSet></Period></MPD>'
        : '#EXTM3U\n#EXTINF:5,\nhttps://example.com/0.ts\n#EXT-X-ENDLIST'
    )
    const publish = () =>
      eventBus.emit(Events.TaskUpdated, taskManager.getAll())
    // One process-scoped runtime, as server/index.ts composes it; bridge
    // receivers only dispatch into it.
    const pipelines = media.createPipelines({
      mediaMetaStore: makeMediaMetaStoreStub(),
      taskManager,
      activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
      eventBus,
      persistTask,
      pickName: async (_dir, name) => name,
      fetchManifest,
      publishTaskUpdate: publish,
      publishTaskUpdateNow: publish,
    })
    const deps = makeBridgeReceiverDeps({
      media: pipelines,
      eventBus,
      getDefaultSaveDir: () => saveDir,
    })
    const actionDeps = {
      taskManager,
      persistTask,
      publishTaskUpdate: publish,
      publishTaskUpdateNow: publish,
      eventBus,
      adapter: adapter as never,
      log: getLogger('server-media-test'),
      getMediaSegmentGids: (id: string) => pipelines.getActiveSegmentGids(id),
    }
    const remove = (id: string) =>
      removeTask(
        id,
        { deleteWithFiles: false },
        {
          ...actionDeps,
          cancelMedia: (taskId) => pipelines.cancel(taskId),
          db: {
            deleteTask: (taskId) => {
              persisted.delete(taskId)
            },
            getTask: () => null,
            saveTaskWithInstances: vi.fn(),
          },
          fileCleanupService: {} as never,
          torrentMetaStore: {} as never,
          magnetTracker: { observe: () => false } as never,
          taskPersistence: {
            runExclusivePersistence: async (operation) => operation(),
          },
          runTaskMutation: async (_ids, operation) => operation(),
        }
      )
    deps.removeTask = remove
    runtime = await bootstrapBridgeForServer({
      userDataDir: root,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.1.1',
      eventBus,
      ffmpegAvailable: media.ffmpegAvailable,
      remoteExtensionConfig: parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://motrix.example/bridge',
        MOTRIX_PUBLIC_URL: 'https://motrix.example',
      }),
      createExtensionReceiver: ({ bridgeBus }) =>
        new BridgeReceiver({ ...deps, bridgeBus }),
      readHandlerDeps: {
        taskManager,
        statsAggregator: {
          getStats: () => ({
            totalDownloadSpeed: 0,
            totalUploadSpeed: 0,
            activeTasks: 0,
            waitingTasks: 0,
            stoppedTasks: 0,
          }),
        },
        supervisor: {
          getState: () => EngineState.Ready,
          getFeatureReport: () => null,
        },
      },
      writeHandlerDeps: {
        taskManager,
        pauseTask: (id) => pauseTask(id, actionDeps),
        resumeTask: (id) => resumeTask(id, actionDeps),
        removeTask: remove,
        createTask: async () => ({ taskId: 'direct' }),
        parseTorrentFileCount: async () => 0,
      },
    })
    const extensionId = 'a'.repeat(32)
    const handshake = await startPair({
      port: runtime.port,
      origin: `chrome-extension://${extensionId}`,
      browser: 'chromium',
      claimedExtensionId: extensionId,
      routePrefix: '/bridge',
      hostHeader: 'motrix.example',
    })
    closeClient = () => handshake.wire.ws.terminate()
    const pending = (await runtime.bridgeQueryHandlers[
      BridgeQueries.ListPendingPairRequests
    ]()) as Array<{ code?: string }>
    const { channel } = await runPake(handshake, pending[0].code!)
    await exchangeCredential(handshake, channel)
    const connection = mdxpOverChannel(handshake.wire, channel)
    closeClient = () => {
      connection.dispose()
      handshake.wire.ws.terminate()
    }
    const initialize = () =>
      connection.sendRequest(
        Methods.MotrixInitialize,
        initializeParams(extensionId)
      ) as Promise<InitializeResult>
    await initialize()
    await connection.sendNotification(
      Notifications.MotrixInitialized,
      undefined
    )
    const completed = vi.fn()
    connection.onNotification(Notifications.TaskCompleted, completed)
    return {
      media,
      pipelines,
      pause: (id: string) => pauseTask(id, actionDeps),
      resume: (id: string) => resumeTask(id, actionDeps),
      remove,
      adapter,
      persisted,
      taskManager,
      ffmpeg,
      fetchManifest,
      initialize,
      completed,
      setBinary: (value: string | null) => {
        binaryPath = value
      },
      submit: (kind: 'hls' | 'dash' | 'mux') => {
        const base = makeDirectSubmit()
        if (base.selection.kind !== 'direct')
          throw new Error('Expected direct fixture')
        const resource = {
          ...base.selection.primary,
          url:
            kind === 'dash'
              ? 'https://example.com/a.mpd'
              : 'https://example.com/a.m3u8',
        }
        const selection: DownloadSubmitParams['selection'] =
          kind === 'mux'
            ? {
                kind,
                video: { ...resource, url: 'https://example.com/v.mp4' },
                audio: { ...resource, url: 'https://example.com/a.m4a' },
                container: 'mp4',
              }
            : { kind, primary: resource, container: 'mp4' }
        return connection.sendRequest(Methods.DownloadSubmit, {
          ...base,
          selection,
          meta: { suggestedFilename: `${kind}.mp4`, qualityLabel: 'source' },
        }) as Promise<{ taskId: string }>
      },
      request: (
        method:
          | typeof Methods.TaskPause
          | typeof Methods.TaskResume
          | typeof Methods.TaskRemove
          | typeof Methods.DownloadCancel,
        taskId: string
      ) => connection.sendRequest(method, { taskId }),
      completeSegments: () => {
        for (const gid of segmentFiles.keys())
          for (const callback of completeHandlers) callback({ gid })
      },
    }
  }

  it.each(['hls', 'dash', 'mux'] as const)(
    'refreshes capabilities and completes %s through the same authenticated connection',
    async (kind) => {
      const s = await setup()
      expect((await s.initialize()).capabilities).toMatchObject({
        ffmpegAvailable: false,
        selectionKinds: ['direct'],
      })
      await expect(s.submit(kind)).rejects.toMatchObject({
        code: ErrorCodes.CapabilityNotSupported,
      })
      expect(s.fetchManifest).not.toHaveBeenCalled()
      expect(s.persisted.size).toBe(0)
      s.setBinary('/data/binaries/ffmpeg')
      expect((await s.initialize()).capabilities).toMatchObject({
        ffmpegAvailable: true,
        selectionKinds: ['direct', 'hls', 'dash', 'mux'],
      })
      const { taskId } = await s.submit(kind)
      await vi.waitFor(() =>
        expect(s.pipelines.getActiveSegmentGids(taskId)).toHaveLength(
          kind === 'mux' ? 2 : 1
        )
      )
      await s.request(Methods.TaskPause, taskId)
      expect(s.taskManager.getById(taskId)?.status).toBe(TaskStatus.Paused)
      expect(s.adapter.pauseTask).toHaveBeenCalledTimes(kind === 'mux' ? 2 : 1)
      await s.request(Methods.TaskResume, taskId)
      expect(s.taskManager.getById(taskId)?.status).toBe(TaskStatus.Downloading)
      expect(s.adapter.resumeTask).toHaveBeenCalledTimes(kind === 'mux' ? 2 : 1)
      s.setBinary('/new/ffmpeg')
      s.completeSegments()
      await vi.waitFor(() =>
        expect(s.persisted.get(taskId)?.status).toBe(TaskStatus.Completed)
      )
      expect(s.ffmpeg).toHaveBeenCalledWith(
        expect.objectContaining({ binaryPath: '/new/ffmpeg' }),
        expect.any(Function)
      )
      expect(
        await readFile(s.taskManager.getById(taskId)!.finalPath!, 'utf8')
      ).toBe('media fixture')
      await vi.waitFor(() =>
        expect(s.completed).toHaveBeenCalledWith(
          expect.objectContaining({ taskId })
        )
      )
      await vi.waitFor(async () =>
        expect(await readdir(s.media.tmpRoot)).toEqual([])
      )
      s.setBinary(null)
      expect((await s.initialize()).capabilities.ffmpegAvailable).toBe(false)
      await expect(s.submit(kind)).rejects.toMatchObject({
        code: ErrorCodes.CapabilityNotSupported,
      })
    }
  )

  it.each(['cancel', 'remove', 'shutdown'] as const)(
    'drains segments and temporary files on %s',
    async (action) => {
      const s = await setup()
      s.setBinary('/data/binaries/ffmpeg')
      const { taskId } = await s.submit('hls')
      await vi.waitFor(() =>
        expect(s.pipelines.getActiveSegmentGids(taskId)).toHaveLength(1)
      )
      if (action === 'shutdown') await s.pipelines.stopAndDrain()
      else
        await s.request(
          action === 'cancel' ? Methods.DownloadCancel : Methods.TaskRemove,
          taskId
        )
      expect(s.adapter.forceRemoveTask).toHaveBeenCalledWith('segment-1')
      expect(s.adapter.removeDownloadResult).toHaveBeenCalledWith('segment-1')
      expect(s.ffmpeg).not.toHaveBeenCalled()
      await vi.waitFor(async () =>
        expect(await readdir(s.media.tmpRoot)).toEqual([])
      )
      expect(s.pipelines.getActiveSegmentGids(taskId)).toEqual([])
      if (action !== 'shutdown')
        expect(s.taskManager.getById(taskId)).toBeUndefined()
      else expect(s.persisted.get(taskId)?.status).toBe(TaskStatus.Error)
    }
  )

  it('keeps a running media task across a bridge stop, with pause, resume and remove still working', async () => {
    const s = await setup()
    s.setBinary('/data/binaries/ffmpeg')
    const { taskId } = await s.submit('mux')
    await vi.waitFor(() =>
      expect(s.pipelines.getActiveSegmentGids(taskId)).toHaveLength(2)
    )

    // Turning the bridge off no longer cancels app-owned media work.
    await runtime!.shutdown()
    runtime = undefined
    expect(s.adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(s.taskManager.getById(taskId)?.status).toBe(TaskStatus.Downloading)
    expect(s.pipelines.getActiveSegmentGids(taskId)).toHaveLength(2)

    await s.pause(taskId)
    expect(s.taskManager.getById(taskId)?.status).toBe(TaskStatus.Paused)
    expect(s.adapter.pauseTask).toHaveBeenCalledTimes(2)
    await s.resume(taskId)
    expect(s.taskManager.getById(taskId)?.status).toBe(TaskStatus.Downloading)

    await s.remove(taskId)
    expect(s.adapter.forceRemoveTask).toHaveBeenCalledWith('segment-1')
    expect(s.adapter.forceRemoveTask).toHaveBeenCalledWith('segment-2')
    expect(s.pipelines.getActiveSegmentGids(taskId)).toEqual([])
    expect(s.taskManager.getById(taskId)).toBeUndefined()
    await vi.waitFor(async () =>
      expect(await readdir(s.media.tmpRoot)).toEqual([])
    )
  })
})
