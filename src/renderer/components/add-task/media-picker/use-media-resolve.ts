import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type {
  MediaPreview,
  ResolveMediaRequest,
  ResolveMediaResult,
} from '@shared/schemas/media-resolution'
import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

export type MediaResolveState =
  | { phase: 'idle' }
  | { phase: 'resolving' }
  | { phase: 'ready'; preview: MediaPreview }
  | {
      phase: 'problem'
      result: Extract<ResolveMediaResult, { status: 'unavailable' | 'failed' }>
    }
  | { phase: 'declined' }
  | { phase: 'busy' }
  | { phase: 'cancelled' }
  /** The transport itself failed; the outcome is unknown. */
  | { phase: 'error' }

export interface EntryLoadState {
  loading: ReadonlySet<string>
  /** Entries whose variants could not be loaded, with the outcome. */
  failed: ReadonlyMap<string, ResolveMediaResult | null>
}

const NO_ENTRIES: EntryLoadState = { loading: new Set(), failed: new Map() }

async function invokeResolve(
  request: ResolveMediaRequest
): Promise<ResolveMediaResult> {
  return (await transport.invoke(
    Commands.ResolveMedia,
    request
  )) as ResolveMediaResult
}

function cancelRequest(requestId: string): void {
  transport
    .invoke(Commands.CancelMediaResolve, { requestId })
    .catch((error: unknown) => console.error(error))
}

/**
 * One picker session: resolve a page into a preview, load deferred entries,
 * cancel. Every call carries its own request id, and a reply is applied only
 * while it still belongs to the current session, so a late answer from a
 * cancelled or superseded resolve never replaces a newer state.
 */
export function useMediaResolve() {
  const [state, setState] = useState<MediaResolveState>({ phase: 'idle' })
  const [entries, setEntries] = useState<EntryLoadState>(NO_ENTRIES)
  const session = useRef(0)
  const running = useRef(new Set<string>())
  const pageUrl = useRef<string | null>(null)

  const stopRunning = useCallback(() => {
    for (const requestId of running.current) cancelRequest(requestId)
    running.current.clear()
  }, [])

  const resolve = useCallback(
    async (url: string) => {
      stopRunning()
      const current = ++session.current
      pageUrl.current = url
      const requestId = uuidv4()
      running.current.add(requestId)
      setEntries(NO_ENTRIES)
      setState({ phase: 'resolving' })
      let next: MediaResolveState
      try {
        const result = await invokeResolve({ requestId, url })
        next =
          result?.status === 'ok'
            ? { phase: 'ready', preview: result.preview }
            : result?.status === 'unavailable' || result?.status === 'failed'
              ? { phase: 'problem', result }
              : result?.status === 'declined' ||
                  result?.status === 'busy' ||
                  result?.status === 'cancelled'
                ? { phase: result.status }
                : { phase: 'error' }
      } catch (error) {
        console.error(error)
        next = { phase: 'error' }
      } finally {
        running.current.delete(requestId)
      }
      if (current !== session.current) return
      setState(next)
    },
    [stopRunning]
  )

  const loadEntries = useCallback(
    async (preview: MediaPreview, entryIds: string[]) => {
      const url = pageUrl.current
      if (!url || entryIds.length === 0) return
      const current = session.current
      const requestId = uuidv4()
      running.current.add(requestId)
      setEntries((previous) => {
        const failed = new Map(previous.failed)
        for (const id of entryIds) failed.delete(id)
        return {
          loading: new Set([...previous.loading, ...entryIds]),
          failed,
        }
      })
      let result: ResolveMediaResult | null = null
      try {
        result = await invokeResolve({
          requestId,
          url,
          resolutionId: preview.resolutionId,
          entryIds,
        })
      } catch (error) {
        console.error(error)
      } finally {
        running.current.delete(requestId)
      }
      if (current !== session.current) return
      if (result?.status === 'ok') {
        const loaded = result.preview
        setState((previous) =>
          previous.phase === 'ready'
            ? { phase: 'ready', preview: loaded }
            : previous
        )
      }
      setEntries((previous) => {
        const loading = new Set(previous.loading)
        const failed = new Map(previous.failed)
        for (const id of entryIds) {
          loading.delete(id)
          const entry =
            result?.status === 'ok'
              ? result.preview.entries.find((e) => e.id === id)
              : undefined
          if (!entry?.variants) failed.set(id, result)
        }
        return { loading, failed }
      })
    },
    []
  )

  /**
   * End the session: a running resolve is cancelled on the host and late
   * replies are ignored, but the last state stays for the exit animation.
   */
  const cancel = useCallback(() => {
    session.current += 1
    pageUrl.current = null
    stopRunning()
  }, [stopRunning])

  /** End the session and forget its state. */
  const close = useCallback(() => {
    cancel()
    setEntries(NO_ENTRIES)
    setState({ phase: 'idle' })
  }, [cancel])

  useEffect(
    () => () => {
      session.current += 1
      stopRunning()
    },
    [stopRunning]
  )

  return { state, entries, resolve, loadEntries, cancel, close }
}
