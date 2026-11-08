import { EventEmitter } from 'node:events'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import type { BridgeReceiverDeps } from '@core/bridge-receiver/bridge-receiver'
import {
  createMediaRuntime,
  type MediaRuntime,
  type MediaRuntimeDeps,
} from '@core/media-resolve/media-runtime'
import { TaskManager } from '@core/task/task-manager'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { makeMediaMetaStoreStub } from '@test-utils/media-meta-store'
import { vi } from 'vitest'

/** Typed receiver dependencies with inert IO; each call owns independent state. */
export function makeBridgeReceiverDeps(
  overrides: Partial<BridgeReceiverDeps> = {}
): BridgeReceiverDeps {
  let serial = 0
  return {
    getDefaultSaveDir: () => '/downloads',
    pickName: vi.fn(async (_dir, name) => name),
    createTask: vi.fn(async () => ({
      gid: `gid-${++serial}`,
      taskId: `task-${serial}`,
    })),
    removeTask: vi.fn(async () => {}),
    submitMagnetForFileSelection: vi.fn(async () => 'magnet-task'),
    isMagnetFileSelectionEnabled: () => false,
    eventBus: new EventEmitter(),
    bridgeBus: new BridgeEventBus(),
    localize: (code) => code,
    ...overrides,
  }
}

/** A real media runtime over inert IO; FFmpeg resolves to a fixed path. */
export function makeTestMediaRuntime(
  overrides: Partial<MediaRuntimeDeps> = {}
): MediaRuntime {
  return createMediaRuntime({
    mediaMetaStore: makeMediaMetaStoreStub(),
    taskManager: new TaskManager(),
    activityRecorder: NOOP_TASK_ACTIVITY_RECORDER,
    eventBus: { emit: vi.fn() },
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    resolveFfmpegBinaryPath: async () => '/test/ffmpeg',
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
    tmpRoot: '/tmp/motrix-test',
    ...overrides,
  })
}

export function makeDirectSubmit(
  idempotencyKey?: string
): DownloadSubmitParams {
  return {
    source: {
      pageUrl: 'https://example.com/',
      pageTitle: 'Fixture',
      detectedAt: 1,
    },
    selection: {
      kind: 'direct',
      primary: {
        url: 'https://example.com/file.zip',
        headers: {},
        cookies: [],
        refererPolicy: 'strict-origin-when-cross-origin',
      },
    },
    meta: { suggestedFilename: 'file.zip', qualityLabel: 'source' },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }
}

export function makeExtensionContext(): MdxpSessionContext {
  return {
    identity: { kind: 'extension', browser: 'chromium', extensionId: 'test' },
    startedAt: 0,
    isReady: () => true,
    markReady: () => {},
    isAuthorized: () => true,
    markAuthorized: () => {},
    pendingPair: null,
  }
}
