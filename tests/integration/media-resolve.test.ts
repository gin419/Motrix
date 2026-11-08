// Site resolution end to end, with no network beyond loopback: a real
// QuickJS site-resolver plugin (tests/fixtures/plugins/test.media-resolver)
// answers through the real PluginHost, the host validates its result, and
// handleCreateTask routes the selected variant — a direct stream to aria2,
// an HLS playlist fetched from a local fixture server into the media
// pipeline, a legacy mux pair to the mux pipeline.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { Aria2Adapter } from '@core/engine/aria2/aria2-adapter'
import { makeMediaResolveService } from '@core/media-resolve/media-resolve-service'
import { createMediaRuntime } from '@core/media-resolve/media-runtime'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import { PluginHost } from '@core/plugin/host/plugin-host'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { migrate } from '@core/session/migrations'
import { handleCreateTask } from '@core/task/create-task-handler'
import { MediaResolveError } from '@core/task/media-resolve-error'
import {
  type MediaJob,
  MediaTaskCoordinator,
} from '@core/task/media-task-coordinator'
import { TaskManager } from '@core/task/task-manager'
import { makeMediaMetaStoreStub } from '@test-utils/media-meta-store'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE_ID = 'test.media-resolver'

type Deps = Parameters<typeof handleCreateTask>[1]

interface FixtureRequest {
  url: string
  headers: IncomingHttpHeaders
}

let rootDir: string
let host: PluginHost
let db: Database.Database
let server: Server
let cdn: string
const requests: FixtureRequest[] = []
const pluginWarnings: string[] = []

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:2',
  '#EXTINF:2,',
  'seg0.ts',
  '#EXTINF:2,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n')

function capabilityHost(): CapabilityHost {
  const noop = () => {}
  const log = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (msg: string) => pluginWarnings.push(msg),
    error: noop,
    fatal: noop,
  }
  return {
    createLog: () => log,
    appSnapshot: () => ({
      version: '2.5.0',
      platform: process.platform,
      runtime: 'server',
      locale: 'en-US',
      arch: process.arch,
    }),
    i18nSnapshot: () => ({
      language: 'en-US',
      dir: 'ltr',
      currentDict: {},
      fallbackDict: {},
    }),
    setLocale: noop,
    onLocaleChange: () => noop,
    flush: async () => {},
  } as unknown as CapabilityHost
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    if (req.url === '/hls/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(PLAYLIST)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  )
  cdn = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  rootDir = mkdtempSync(path.join(tmpdir(), 'motrix-media-resolve-'))
  const pluginsDir = path.join(rootDir, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  cpSync(
    path.join(ROOT, 'tests/fixtures/plugins', FIXTURE_ID),
    path.join(pluginsDir, FIXTURE_ID),
    { recursive: true }
  )
  db = new Database(':memory:')
  migrate(db)
  const stateStore = new PluginStateStore(db)
  const registry = new PluginRegistry({
    pluginsDir,
    builtinDir: path.join(rootDir, 'builtin'),
    stateStore,
    hostVersion: '2.5.0',
  })
  await registry.discover()
  host = new PluginHost({
    registry,
    stateStore,
    capabilityHost: capabilityHost(),
    workerScriptPath: path.join(ROOT, 'dist-test/quick-js-worker.cjs'),
    appVersion: '2.5.0',
    runtime: 'server',
    hostLanguage: 'en-US',
  })
  mediaResolve = makeMediaResolveService({
    registry,
    host,
    pluginLog: () => ({
      warn: (msg: string) => pluginWarnings.push(msg),
    }),
  })
}, 30_000)

afterAll(async () => {
  await host?.shutdown()
  db?.close()
  await new Promise((resolve) => server?.close(resolve))
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
})

let mediaResolve: ReturnType<typeof makeMediaResolveService>

function page(kind: string): string {
  return `https://media.test/watch/${kind}?cdn=${encodeURIComponent(cdn)}`
}

function createDeps(ffmpeg: string | null) {
  const addUri = vi.fn(
    async (_uris: string[], options: Record<string, unknown>) =>
      String(options.gid)
  )
  const adapter = new Aria2Adapter({
    addUri,
    addTorrent: vi.fn(),
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  } as never)
  const taskManager = new TaskManager()
  const media = createMediaRuntime({
    mediaMetaStore: makeMediaMetaStoreStub(),
    taskManager,
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    eventBus: { emit: vi.fn() },
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    resolveFfmpegBinaryPath: async () => ffmpeg,
    pickName: async (_dir, name) => name,
    persistTask: vi.fn(async () => {}),
    segmentAria2: {
      addUri: vi.fn(async () => 'segment'),
      forceRemove: vi.fn(async () => {}),
      removeDownloadResult: vi.fn(async () => {}),
      tellStatus: vi.fn(async () => null),
      onComplete: vi.fn(),
      onError: vi.fn(),
    },
    tmpRoot: path.join(rootDir, 'media-tmp'),
  })
  const deps = {
    adapter,
    settingsManager: {
      getApp: () => ({ defaultSaveDir: rootDir }),
      getEngine: () => ({
        performanceProfile: 'custom',
        maxConnectionPerServer: 16,
      }),
    },
    directResourceProxyPolicy: new AppliedDownloadProxyPolicy({ noProxy: '' }),
    finalNamePicker: { pick: vi.fn(async (_d: string, name: string) => name) },
    torrentMetaStore: { persist: vi.fn(), read: vi.fn(), remove: vi.fn() },
    taskManager,
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    eventBus: { emit: vi.fn() },
    publishTaskUpdate: vi.fn(),
    mediaResolve,
    media,
  } as unknown as Deps
  return { deps, addUri }
}

async function create(url: string, deps: Deps) {
  return handleCreateTask(
    { type: 'http', uris: [url], saveDir: rootDir, headers: [] },
    deps
  )
}

function spySubmit() {
  return vi
    .spyOn(MediaTaskCoordinator.prototype, 'submit')
    .mockResolvedValue({ taskId: 'media-task' })
}

describe('site resolution through a real QuickJS resolver', () => {
  it('downloads a progressive variant directly with its stream header and title', async () => {
    const { deps, addUri } = createDeps('/fixture/ffmpeg')
    await create(page('progressive'), deps)
    const [uris, options] = addUri.mock.calls[0] as [
      string[],
      Record<string, unknown>,
    ]
    expect(uris).toEqual([`${cdn}/clip.mp4`])
    expect(options.out).toBe('Fixture clip.mp4.motrix')
    expect(options.header).toContain('Referer: https://media.test/')
  }, 30_000)

  it('fetches the HLS playlist from the fixture server into the media pipeline', async () => {
    const submit = spySubmit()
    try {
      const { deps, addUri } = createDeps('/fixture/ffmpeg')
      const result = await create(page('adaptive'), deps)
      expect(result.taskId).toBe('media-task')
      expect(addUri).not.toHaveBeenCalled()
      expect(requests.at(-1)).toMatchObject({
        url: '/hls/index.m3u8',
        headers: { referer: 'https://media.test/' },
      })
      const job = submit.mock.calls[0]?.[0] as MediaJob
      expect(job).toMatchObject({
        kind: 'hls',
        finalName: 'Fixture clip.mp4',
        headers: { Referer: 'https://media.test/' },
        sourceMeta: null,
      })
      expect(job.video.segments.map((segment) => segment.url)).toEqual([
        `${cdn}/hls/seg0.ts`,
        `${cdn}/hls/seg1.ts`,
      ])
    } finally {
      submit.mockRestore()
    }
  }, 30_000)

  it('prefers the direct variant of the same page when FFmpeg is missing', async () => {
    const before = requests.length
    const { deps, addUri } = createDeps(null)
    await create(page('adaptive'), deps)
    expect(addUri.mock.calls[0]?.[0]).toEqual([`${cdn}/clip.mp4`])
    expect(requests.length).toBe(before)
  }, 30_000)

  it('fetches a deferred current entry once and names it as a part', async () => {
    const invoke = vi.spyOn(host, 'invokeCommand')
    try {
      const { deps, addUri } = createDeps('/fixture/ffmpeg')
      await create(page('series'), deps)
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(invoke.mock.calls[1]?.[2]).toMatchObject({ entryIds: ['p2'] })
      const [uris, options] = addUri.mock.calls[0] as [
        string[],
        Record<string, unknown>,
      ]
      expect(uris).toEqual([`${cdn}/p2/clip.mp4`])
      expect(options.out).toBe('Fixture series - P2 Finale.mp4.motrix')
    } finally {
      invoke.mockRestore()
    }
  }, 30_000)

  it('routes a legacy mux pair to the mux pipeline without its cookie header', async () => {
    const submit = spySubmit()
    try {
      const { deps } = createDeps('/fixture/ffmpeg')
      await create(page('legacy'), deps)
      const job = submit.mock.calls[0]?.[0] as MediaJob
      expect(job).toMatchObject({
        kind: 'mux',
        finalName: 'Fixture legacy.mp4',
        headers: { Referer: 'https://media.test/' },
      })
      expect(job.video.segments[0]?.url).toBe(`${cdn}/video.m4s`)
      expect(job.audio?.segments[0]?.url).toBe(`${cdn}/audio.m4s`)
    } finally {
      submit.mockRestore()
    }
  }, 30_000)

  it('reports unavailable media with its reason and downloads nothing', async () => {
    const { deps, addUri } = createDeps('/fixture/ffmpeg')
    const rejection = create(page('members'), deps)
    await expect(rejection).rejects.toBeInstanceOf(MediaResolveError)
    await expect(rejection).rejects.toMatchObject({
      pluginId: FIXTURE_ID,
      reason: 'login-required',
      message: 'task.add.media.unavailable.loginRequired',
    })
    expect(addUri).not.toHaveBeenCalled()
  }, 30_000)

  it('rejects a result with a non-allowlisted stream header and tells the plugin log', async () => {
    const { deps, addUri } = createDeps('/fixture/ffmpeg')
    await expect(create(page('leaky'), deps)).rejects.toMatchObject({
      failure: 'invalid-result',
    })
    expect(pluginWarnings).toContain('resolve result rejected by the host')
    expect(addUri).not.toHaveBeenCalled()
  }, 30_000)

  it('leaves other hosts alone despite the resolver’s match-all permission', async () => {
    const invoke = vi.spyOn(host, 'invokeCommand')
    try {
      const { deps, addUri } = createDeps('/fixture/ffmpeg')
      await create(`${cdn}/files/archive.zip`, deps)
      expect(invoke).not.toHaveBeenCalled()
      expect(addUri.mock.calls[0]?.[0]).toEqual([`${cdn}/files/archive.zip`])
    } finally {
      invoke.mockRestore()
    }
  }, 30_000)
})
