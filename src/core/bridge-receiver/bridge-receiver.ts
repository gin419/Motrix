import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { IdempotencyCache } from '@core/bridge/idempotency-cache'
import type { MdxpSessionContext } from '@core/bridge/mdxp-session-context'
import { newTaskId } from '@core/lib/ids'
import type { MediaRuntime } from '@core/media-resolve/media-runtime'
import type { ResolveToMux } from '@core/media-resolve/resolve-to-mux'
import { MediaResolveError } from '@core/task/media-resolve-error'
import { admitHttpSource } from '@core/task/source-admission'
import {
  type DownloadSubmitParams,
  ErrorCodes,
  makeMdxpError,
} from '@motrix/mdxp'
import { clientKey } from '@shared/protocol/bridge'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import type { BridgeErrorCode } from './errors'
import { BridgeReceiverError } from './errors'
import { stripHopByHopHeaders } from './header-replay'
import { DirectPipeline } from './pipelines/direct-pipeline'
import { MagnetPipeline } from './pipelines/magnet-pipeline'
import { ensureMediaExtension } from './pipelines/media-final-name'
import {
  dispatchTaskUpdates,
  type TaskNotificationSink,
} from './progress-mapping'
import { ProgressPublisher } from './progress-publisher'
import {
  type AdaptedMux,
  type AdapterDeps,
  SubmitDownloadAdapter,
  sanitizeFilename,
} from './submit-download-adapter'

/**
 * Serialize a list of Cookie objects (from @motrix/mdxp Resource.cookies) into
 * a ready-to-send Cookie header string: `name=value; name=value`.
 * Empty array → empty string. Caller should treat '' as "no cookies".
 */
export function serializeCookieHeader(
  cookies: ReadonlyArray<{ name: string; value: string }>
): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export interface BridgeReceiverDeps {
  /**
   * The process-scoped HLS/DASH/mux runtime. The receiver only dispatches
   * into it; it neither builds nor drains it, so media tasks outlive a bridge
   * restart. Absent in shells and tests without media support, where media
   * submits fail with `unsupported-kind`.
   */
  media?: MediaRuntime
  getDefaultSaveDir: AdapterDeps['getDefaultSaveDir']
  resolveSaveDir?: AdapterDeps['resolveSaveDir']
  recordDirectory?: (path: string) => Promise<unknown>
  pickName: AdapterDeps['pickName']
  createTask: ConstructorParameters<typeof DirectPipeline>[0]['createTask']
  removeTask: ConstructorParameters<typeof DirectPipeline>[0]['removeTask']
  submitMagnetForFileSelection: ConstructorParameters<
    typeof MagnetPipeline
  >[0]['submitMagnetForFileSelection']
  isMagnetFileSelectionEnabled: ConstructorParameters<
    typeof MagnetPipeline
  >[0]['isMagnetFileSelectionEnabled']
  eventBus: {
    on(event: string, listener: (payload: unknown) => void): unknown
    off(event: string, listener: (payload: unknown) => void): unknown
    emit?(event: string, payload: unknown): void
  }
  bridgeBus: BridgeEventBus
  localize: (code: BridgeErrorCode) => string
  /**
   * Optional submit-path pre-resolver for direct submits. A mux pair re-routes
   * the submit to the media runtime's MuxPipeline; null proceeds as a direct
   * download. A matching resolver that fails throws MediaResolveError and the
   * submit is rejected with appCode `media-resolve-failed` instead of
   * downloading the page as a file. Submit cookies are forwarded to the
   * resolver only (2nd arg).
   */
  resolveToMux?: ResolveToMux
  /**
   * Optional startup gate awaited before any submit reaches a pipeline.
   * The bootstrap resolves it once engine start + SessionManager.restore()
   * have settled. Without it, a submit racing startup restore gets its
   * freshly-registered task wiped by restore's clear() and re-adopted as an
   * engine orphan: name keeps the `.motrix` placeholder, source flips to
   * 'user', sourceMeta is lost, and the taskId already acked to the
   * extension points at a task that no longer exists. Absent ⇒ no gate
   * (tests, Node shell back-compat).
   */
  waitForReady?: () => Promise<void>
}

/**
 * Entry point of subsystem ③. Implements SubmitDownloadHandler from
 * src/core/bridge/web-socket-bridge-server.ts:45 — synchronously returns
 * { taskId } so the server can ack the extension immediately. All
 * progress / completion / error events flow asynchronously via
 * BridgeEventBus.
 */
export class BridgeReceiver {
  private readonly adapter: SubmitDownloadAdapter
  private readonly direct: DirectPipeline
  private readonly magnet: MagnetPipeline
  private readonly publisher: ProgressPublisher
  // Terminal-transition dedup for the WS push (same harness as the SSE source).
  private readonly terminalEmitted = new Map<string, string>()
  /**
   * In-flight and settled download/submit results keyed by
   * [authenticated installation key, idempotencyKey]. A retransmit of the same
   * logical submit (lost response, reconnect replay) awaits or receives the original
   * result instead of creating a duplicate task — dedup semantics live in
   * IdempotencyCache (failure eviction, settled-only capacity eviction).
   */
  private readonly submitsByKey = new IdempotencyCache<{
    taskId: string
    requestedSaveDir?: string
  }>()

  constructor(private readonly deps: BridgeReceiverDeps) {
    this.adapter = new SubmitDownloadAdapter({
      getDefaultSaveDir: deps.getDefaultSaveDir,
      resolveSaveDir: deps.resolveSaveDir,
      pickName: deps.pickName,
      mintTaskId: newTaskId,
    })
    this.direct = new DirectPipeline({
      createTask: deps.createTask,
      removeTask: deps.removeTask,
    })
    this.magnet = new MagnetPipeline({
      createTask: deps.createTask,
      removeTask: deps.removeTask,
      submitMagnetForFileSelection: deps.submitMagnetForFileSelection,
      isMagnetFileSelectionEnabled: deps.isMagnetFileSelectionEnabled,
    })
    this.publisher = new ProgressPublisher(deps.bridgeBus, deps.localize)
  }

  /** SubmitDownloadHandler: the bridge dispatcher injects this. */
  async handle(
    params: DownloadSubmitParams,
    ctx: MdxpSessionContext
  ): Promise<{ taskId: string }> {
    // download/submit is extension-only. The agent-facing gate already keeps a
    // cli off this method at the unary layer; this is the defense-in-depth
    // guard so the receiver never reads extensionId/browser off a cli identity.
    if (ctx.identity.kind !== 'extension') {
      throw makeMdxpError(
        ErrorCodes.CapabilityNotSupported,
        `download/submit is not available to ${ctx.identity.kind} clients`
      )
    }
    const identity = ctx.identity
    const sessionKey = ctx.sessionKey ?? clientKey(identity)
    const key = params.idempotencyKey
    if (!key) return this.dispatchSubmit(params, identity, sessionKey)

    const result = await this.submitsByKey.run(
      JSON.stringify([sessionKey, key]),
      async () => ({
        ...(await this.dispatchSubmit(params, identity, sessionKey)),
        requestedSaveDir: params.saveDir,
      })
    )
    if (result.requestedSaveDir !== params.saveDir) {
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        'Submission key was already used with another directory'
      )
    }
    return { taskId: result.taskId }
  }

  private async dispatchSubmit(
    params: DownloadSubmitParams,
    identity: Extract<MdxpSessionContext['identity'], { kind: 'extension' }>,
    sessionKey: string
  ): Promise<{ taskId: string }> {
    // Hold the submit until startup restore has settled (see the dep doc).
    // Awaited before adapt so even the name pick sees the
    // final on-disk state left by restore/recovery.
    if (this.deps.waitForReady) {
      await this.deps.waitForReady()
    }
    const adapted = await this.adapter.adapt(params, {
      extensionId: identity.extensionId,
      browser: identity.browser,
      sessionKey,
    })

    const result = await this.dispatchAdapted(adapted, params)
    // A history-write failure must never turn an accepted task into a retry.
    void Promise.resolve()
      .then(() => this.deps.recordDirectory?.(adapted.saveDir))
      .catch(() => {})
    return result
  }

  private async dispatchAdapted(
    adapted: Awaited<ReturnType<SubmitDownloadAdapter['adapt']>>,
    params: DownloadSubmitParams
  ): Promise<{ taskId: string }> {
    // Submit-path pre-resolve: if the adapted result is a direct download and
    // a resolveToMux factory is wired (bootstrap only), call it. On a non-null
    // mux pair the direct submit is transparently re-routed to MuxPipeline.
    // A null means "no resolver claimed this URL — proceed as direct". A
    // MediaResolveError means a resolver claimed it and failed: reject the
    // submit rather than saving the page HTML under the video's name.
    //
    // Cookie handoff (bilibili HD): when the extension submits a direct download
    // with cookies (e.g. SESSDATA for bilibili), serialize them into a Cookie
    // header string and pass it as the 2nd arg to resolveToMux. The resolver
    // attaches the header ONLY to api.bilibili.com calls — never to CDN URLs.
    if (adapted.kind === 'direct' && this.deps.resolveToMux) {
      const rawCookies =
        params.selection.kind === 'direct'
          ? params.selection.primary.cookies
          : []
      const serialized = serializeCookieHeader(rawCookies)
      const cookieHeader = serialized || undefined
      let m: Awaited<ReturnType<ResolveToMux>>
      try {
        m = await this.deps.resolveToMux(adapted.primaryUrl, cookieHeader)
      } catch (error) {
        if (error instanceof MediaResolveError) {
          throw makeMdxpError(
            ErrorCodes.AdapterError,
            'Media page could not be resolved',
            {
              appCode: 'media-resolve-failed',
              retryable:
                error.failure === 'command-failed' ||
                error.failure === 'timeout',
              context: { pluginId: error.pluginId, failure: error.failure },
            }
          )
        }
        throw error
      }
      if (m) {
        // Resolver output is a task source, not a plugin HTTP request: apply
        // the same admission the desktop Add-Task path applies, before any
        // name pick or pipeline work.
        const videoUrl = admitHttpSource(m.videoUrl)
        const audioUrl = admitHttpSource(m.audioUrl)
        const media = this.deps.media
        if (!media) {
          throw new BridgeReceiverError(
            'unsupported-kind',
            'ffmpeg unavailable — mux pipeline not active'
          )
        }
        // Prefer the resolver's human title over the URL-derived name (a bvid
        // like BV1xxx is meaningless). Sanitize, append the container
        // extension, THEN dedup — the pick must run on the on-disk name.
        const titleBase = m.title ? sanitizeFilename(m.title).trim() : ''
        const finalName = titleBase
          ? await this.deps.pickName(
              adapted.saveDir,
              ensureMediaExtension(titleBase, m.container)
            )
          : adapted.finalName
        const muxAdapted: AdaptedMux = {
          kind: 'mux',
          taskId: adapted.taskId,
          saveDir: adapted.saveDir,
          finalName,
          videoUrl,
          audioUrl,
          sanitizedHeaders: m.headers
            ? stripHopByHopHeaders(m.headers)
            : adapted.sanitizedHeaders,
          container: m.container,
          sourceMeta: adapted.sourceMeta,
          ...(adapted.sourceMeta.durationSec != null
            ? { durationSec: adapted.sourceMeta.durationSec }
            : {}),
        }
        return media.mux.dispatch(muxAdapted)
      }
    }

    if (adapted.kind === 'magnet') {
      return this.magnet.dispatch(adapted)
    }
    if (adapted.kind === 'hls' || adapted.kind === 'dash') {
      if (!this.deps.media) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg unavailable — hls/dash pipeline not active'
        )
      }
      return this.deps.media.hlsDash.dispatch(adapted)
    }
    if (adapted.kind === 'mux') {
      if (!this.deps.media) {
        throw new BridgeReceiverError(
          'unsupported-kind',
          'ffmpeg unavailable — mux pipeline not active'
        )
      }
      return this.deps.media.mux.dispatch(adapted)
    }
    return this.direct.dispatch(adapted)
  }

  private readonly sink: TaskNotificationSink = {
    onProgress: (task) => this.publisher.onTaskUpdated(task),
    onCompleted: (task) => this.publisher.onTaskCompleted(task),
    onError: (task, code) => this.publisher.onTaskFailed(task, code),
  }

  // Stored so stop() can unsubscribe the exact reference.
  private readonly handleTaskUpdated = (payload: unknown): void => {
    if (!Array.isArray(payload)) return
    dispatchTaskUpdates(
      payload as DownloadTask[],
      this.terminalEmitted,
      this.sink
    )
  }

  /**
   * Subscribe to the core EventBus. The only reliable task signal is
   * `Events.TaskUpdated`, which carries the FULL task list each poll tick
   * (TaskCompleted/TaskFailed are never emitted on the core bus). So iterate the
   * array through the shared `dispatchTaskUpdates` harness — it emits progress
   * per task and DERIVES completed/error from terminal status (deduped) — and
   * let `ProgressPublisher` apply the `source==='bridge'` filter + per-session
   * routing. Same derivation the SSE firehose uses.
   */
  start(): void {
    this.deps.eventBus.on(Events.TaskUpdated, this.handleTaskUpdated)
  }

  /**
   * Unsubscribe from the core EventBus. Called from the bootstrap shutdown so a
   * re-enabled bridge doesn't leak this (now dead) receiver instance — the core
   * EventBus is a process-lifetime singleton.
   */
  stop(): void {
    this.deps.eventBus.off(Events.TaskUpdated, this.handleTaskUpdated)
    this.terminalEmitted.clear()
  }

  /**
   * Stop publishing. Media runs belong to the process-scoped runtime and are
   * drained by the shell, not by a bridge stop; direct/aria2 downloads remain
   * owned by the engine lifecycle.
   */
  async stopAndDrain(): Promise<void> {
    this.stop()
  }

  /** Extension-initiated cancel. `taskId` is the MDXP public id
   *  (== DownloadTask.id), not an aria2 gid. The receiver does not know
   *  which subsystem owns the task, so both the direct pipeline and the
   *  media runtime are tried defensively; not-found is silently swallowed. */
  async cancel(taskId: string): Promise<void> {
    await Promise.allSettled([
      this.direct.cancel(taskId),
      this.deps.media?.cancel(taskId),
    ])
  }

  /**
   * On startup, revive any bridge-sourced state that survives a restart.
   * v1.0 needs nothing here: the aria2 session resumes in-flight tasks and
   * start() arms the EventBus subscriptions. Kept as the v1.1+ hook for
   * HLS / mux segment revival.
   */
  async restoreInflight(): Promise<void> {}
}
