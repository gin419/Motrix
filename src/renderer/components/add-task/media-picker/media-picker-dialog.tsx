import { InfoIcon, WarningIcon } from '@renderer/components/icons'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { useExitSnapshot } from '@renderer/hooks/use-exit-snapshot'
import { usePlatformServices } from '@renderer/platform/services'
import type { TaskCreateRequest } from '@shared/schemas/add-task'
import type { MediaPreview } from '@shared/schemas/media-resolution'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { v7 as uuidv7 } from 'uuid'
import {
  definiteRejectionMessage,
  definiteTaskCreateRejection,
  parsePathTooLong,
  parsePluginChainAbort,
  taskCreateFailureReason,
} from '../task-create-failure'
import { type EntryRowStatus, MediaEntryList } from './media-entry-list'
import {
  buildMediaPick,
  hasLockedVariants,
  initialSelection,
  isEntrySelectable,
  type MediaText,
  needsFfmpegHint,
  planQualities,
  resolveProblemOffersPageAsFile,
  resolveProblemText,
} from './media-pick-plan'
import { MediaQualitySelect } from './media-quality-select'
import { useCreateMediaTask } from './use-create-media-task'
import { type MediaResolveState, useMediaResolve } from './use-media-resolve'

export type HttpTaskCreateRequest = Extract<TaskCreateRequest, { type: 'http' }>

export interface MediaPickerTarget {
  url: string
  pluginName: string
}

export interface MediaPickerCreated {
  url: string
  firstTaskId: string
}

interface MediaPickerDialogProps {
  target: MediaPickerTarget | null
  /**
   * The form's request fields (save folder, headers, proxy) for this page,
   * or null when no save folder is chosen.
   */
  requestBase: (url: string) => HttpTaskCreateRequest | null
  onClose: () => void
  /** Every picked part (or the page as a file) was added. */
  onCreated: (created: MediaPickerCreated) => void
}

/** Text explaining why a CreateTask failed, and whether its outcome is known. */
function describeCreateFailure(error: unknown): {
  text: MediaText
  unconfirmed: boolean
} {
  const rejection = definiteTaskCreateRejection(error)
  if (rejection) {
    const { key, values } = definiteRejectionMessage(rejection)
    return { text: { key, values }, unconfirmed: false }
  }
  const reason = taskCreateFailureReason(error)
  if (!reason)
    return { text: { key: 'task.add.createFailed' }, unconfirmed: true }
  const abort = parsePluginChainAbort(reason)
  if (abort)
    return {
      text: { key: 'task.add.createFailedByPlugin', values: { ...abort } },
      unconfirmed: true,
    }
  const tooLong = parsePathTooLong(reason)
  if (tooLong)
    return {
      text: { key: 'task.add.createFailedPathTooLong', values: { ...tooLong } },
      unconfirmed: true,
    }
  return {
    text: { key: 'task.add.createFailedWithReason', values: { reason } },
    unconfirmed: true,
  }
}

export function MediaPickerDialog({
  target,
  requestBase,
  onClose,
  onCreated,
}: MediaPickerDialogProps) {
  const { t } = useTranslation()
  const platform = usePlatformServices()
  const createTask = useCreateMediaTask()
  const { state, entries, resolve, loadEntries, cancel, close } =
    useMediaResolve()
  const [creating, setCreating] = useState(false)
  const [pageFileError, setPageFileError] = useState<string | null>(null)
  const pageFileRequestId = useRef<string | null>(null)
  const open = target !== null
  const url = target?.url ?? null
  // What the dialog shows; it keeps the last page while animating closed.
  const shown = useExitSnapshot(open, target)

  useEffect(() => {
    if (url === null) {
      cancel()
      return
    }
    pageFileRequestId.current = null
    setPageFileError(null)
    void resolve(url)
  }, [url, resolve, cancel])

  const retry = useCallback(() => {
    if (url !== null) void resolve(url)
  }, [url, resolve])

  const downloadPageAsFile = useCallback(async () => {
    if (url === null) return
    const base = requestBase(url)
    if (!base) {
      setPageFileError(t('task.add.errors.saveDirRequired'))
      return
    }
    pageFileRequestId.current ??= uuidv7()
    setCreating(true)
    setPageFileError(null)
    try {
      const result = await createTask({
        ...base,
        uris: [url],
        requestId: pageFileRequestId.current,
        mediaResolve: 'skip',
      })
      if (result.outcome === 'invalid-source') {
        pageFileRequestId.current = null
        setPageFileError(
          t(`task.add.sourceErrors.${result.failure.diagnostic.reason}`)
        )
        return
      }
      if (result.outcome === 'conflict') {
        pageFileRequestId.current = null
        setPageFileError(t('task.add.createFailed'))
        return
      }
      platform.notify('info', 'task.add.created')
      onCreated({ url, firstTaskId: result.taskId ?? result.gid })
    } catch (error) {
      console.error(error)
      const { text, unconfirmed } = describeCreateFailure(error)
      if (!unconfirmed) pageFileRequestId.current = null
      setPageFileError(
        unconfirmed
          ? `${t(text.key, text.values)}\n${t('task.add.submissionUnconfirmed')}`
          : t(text.key, text.values)
      )
    } finally {
      setCreating(false)
    }
  }, [url, requestBase, createTask, onCreated, platform, t])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !creating) onClose()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent
        data-slot="media-picker"
        showCloseButton={false}
        className="flex max-h-[min(40rem,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-lg"
      >
        {state.phase === 'ready' && shown !== null ? (
          <ReadyView
            key={shown.url}
            url={shown.url}
            preview={state.preview}
            entries={entries}
            creating={creating}
            setCreating={setCreating}
            requestBase={requestBase}
            loadEntries={loadEntries}
            onClose={onClose}
            onCreated={onCreated}
          />
        ) : (
          <StatusView
            state={state.phase === 'ready' ? { phase: 'resolving' } : state}
            pluginName={shown?.pluginName ?? ''}
            creating={creating}
            pageFileError={pageFileError}
            onClose={onClose}
            onRetry={retry}
            onDownloadPageAsFile={() => void downloadPageAsFile()}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StatusView({
  state,
  pluginName,
  creating,
  pageFileError,
  onClose,
  onRetry,
  onDownloadPageAsFile,
}: {
  state: Exclude<MediaResolveState, { phase: 'ready' }>
  pluginName: string
  creating: boolean
  pageFileError: string | null
  onClose: () => void
  onRetry: () => void
  onDownloadPageAsFile: () => void
}) {
  const { t } = useTranslation()
  const resolving = state.phase === 'resolving' || state.phase === 'idle'
  let message: string | null = null
  let pageAsFile = false
  let retryable = !resolving && state.phase !== 'declined'
  switch (state.phase) {
    case 'problem': {
      const text = resolveProblemText(state.result)
      message = t(text.key, text.values)
      pageAsFile = resolveProblemOffersPageAsFile(state.result)
      // Protected media stays protected however often it is read.
      retryable = pageAsFile || state.result.status === 'failed'
      break
    }
    case 'declined':
      message = t('task.add.media.picker.declined')
      break
    case 'busy':
      message = t('task.add.media.picker.busy')
      break
    case 'cancelled':
      message = t('task.add.media.picker.cancelled')
      break
    case 'error':
      message = t('task.add.media.picker.error')
      break
  }
  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle>{t('task.add.media.picker.title')}</DialogTitle>
        <DialogDescription>
          {resolving
            ? t('task.add.media.picker.resolving', { plugin: pluginName })
            : t('task.add.media.picker.source', { plugin: pluginName })}
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        {resolving ? (
          <div className="flex items-center justify-center py-6">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : (
          <Alert
            variant={state.phase === 'problem' ? 'destructive' : 'default'}
          >
            <AlertDescription className="whitespace-pre-line">
              {message}
            </AlertDescription>
          </Alert>
        )}
        {pageFileError && (
          <p
            role="alert"
            className="whitespace-pre-line text-xs text-destructive"
          >
            {pageFileError}
          </p>
        )}
      </div>
      <DialogFooter className="shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={creating}
          onClick={onClose}
        >
          {resolving ? t('common.cancel') : t('common.close')}
        </Button>
        {pageAsFile && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={creating}
            onClick={onDownloadPageAsFile}
          >
            {t('task.add.media.downloadAsFile')}
          </Button>
        )}
        {retryable && (
          <Button type="button" size="sm" disabled={creating} onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

function ReadyView({
  url,
  preview,
  entries,
  creating,
  setCreating,
  requestBase,
  loadEntries,
  onClose,
  onCreated,
}: {
  url: string
  preview: MediaPreview
  entries: ReturnType<typeof useMediaResolve>['entries']
  creating: boolean
  setCreating: (creating: boolean) => void
  requestBase: (url: string) => HttpTaskCreateRequest | null
  loadEntries: (preview: MediaPreview, entryIds: string[]) => Promise<void>
  onClose: () => void
  onCreated: (created: MediaPickerCreated) => void
}) {
  const { t } = useTranslation()
  const platform = usePlatformServices()
  const createTask = useCreateMediaTask()
  const folderSwitchId = useId()
  const [selected, setSelected] = useState(() => initialSelection(preview))
  const [quality, setQuality] = useState<string | null>(null)
  const [saveToFolder, setSaveToFolder] = useState(true)
  const [status, setStatus] = useState<ReadonlyMap<string, EntryRowStatus>>(
    () => new Map()
  )
  const [notice, setNotice] = useState<string | null>(null)
  const requestIds = useRef(new Map<string, string>())
  const firstTaskId = useRef<string | null>(null)

  const picks = preview.entries.filter(
    (entry) =>
      selected.has(entry.id) &&
      isEntrySelectable(entry) &&
      status.get(entry.id)?.kind !== 'created'
  )
  const pickIds = new Set(picks.map((entry) => entry.id))
  const created = [...status.values()].filter((s) => s.kind === 'created')
  const multiPart = picks.length + created.length > 1
  const plan = planQualities(preview, pickIds)
  const qualityValue =
    quality !== null && plan.options.some((o) => o.value === quality)
      ? quality
      : plan.defaultValue
  const choice =
    plan.options.find((o) => o.value === qualityValue)?.choice ??
    ({ kind: 'best' } as const)
  const folder = multiPart ? preview.folderName : null

  // A single deferred part shows its exact qualities once they are loaded.
  const single = picks.length === 1 ? picks[0] : null
  useEffect(() => {
    if (!single || single.variants) return
    if (entries.loading.has(single.id) || entries.failed.has(single.id)) return
    void loadEntries(preview, [single.id])
  }, [single, entries, preview, loadEntries])
  const loadingQualities = single !== null && entries.loading.has(single.id)
  const qualityLoadFailed =
    single !== null && !single.variants && entries.failed.has(single.id)

  const create = async () => {
    const base = requestBase(url)
    if (!base) {
      setNotice(t('task.add.errors.saveDirRequired'))
      return
    }
    setNotice(null)
    setCreating(true)
    const next = new Map(status)
    let ok = 0
    let failed = 0
    try {
      for (const entry of picks) {
        let requestId = requestIds.current.get(entry.id)
        if (!requestId) {
          requestId = uuidv7()
          requestIds.current.set(entry.id, requestId)
        }
        const request: HttpTaskCreateRequest = {
          ...base,
          uris: [url],
          requestId,
          mediaPick: buildMediaPick(
            preview,
            entry.id,
            choice,
            folder !== null && saveToFolder
          ),
        }
        try {
          const result = await createTask(request)
          if (result.outcome === 'invalid-source') {
            requestIds.current.delete(entry.id)
            next.set(entry.id, {
              kind: 'failed',
              message: t(
                `task.add.sourceErrors.${result.failure.diagnostic.reason}`
              ),
            })
            failed += 1
            continue
          }
          if (result.outcome === 'conflict') {
            requestIds.current.delete(entry.id)
            next.set(entry.id, {
              kind: 'failed',
              message: t('task.add.createFailed'),
            })
            failed += 1
            continue
          }
          ok += 1
          firstTaskId.current ??= result.taskId ?? result.gid
          next.set(entry.id, { kind: 'created' })
        } catch (error) {
          console.error(error)
          failed += 1
          const { text, unconfirmed } = describeCreateFailure(error)
          // A definite rejection settles the request; a retry is a new one.
          if (!unconfirmed) requestIds.current.delete(entry.id)
          const message = t(text.key, text.values)
          next.set(entry.id, {
            kind: 'failed',
            message: unconfirmed
              ? `${message}\n${t('task.add.submissionUnconfirmed')}`
              : message,
          })
        }
      }
    } finally {
      setStatus(next)
      setCreating(false)
    }
    setSelected(
      new Set(
        [...next].filter(([, s]) => s.kind === 'failed').map(([id]) => id)
      )
    )
    if (failed === 0 && ok > 0) {
      if (ok + created.length === 1) platform.notify('info', 'task.add.created')
      else
        platform.notify('info', 'task.add.batchCreated', {
          count: ok + created.length,
        })
      if (firstTaskId.current)
        onCreated({ url, firstTaskId: firstTaskId.current })
    } else if (ok > 0) {
      platform.notify('warn', 'task.add.createdPartial', { ok, failed })
    }
  }

  const showFfmpegHint = needsFfmpegHint(preview, pickIds)
  const showLoginHint =
    preview.auth?.state !== 'authenticated' &&
    (preview.auth?.betterWithLogin === true ||
      hasLockedVariants(preview, pickIds))
  const manyParts = picks.length > preview.warnAboveParts

  return (
    <>
      <DialogHeader className="shrink-0 pe-2">
        <DialogTitle className="leading-snug [overflow-wrap:anywhere]">
          {preview.title || t('task.add.media.picker.title')}
        </DialogTitle>
        <DialogDescription>
          {t('task.add.media.picker.source', { plugin: preview.pluginName })}
        </DialogDescription>
      </DialogHeader>
      {/* Only the header and footer stay put: in a short window the list
          shrinks first, then this region scrolls, so Download stays reachable. */}
      <div
        data-slot="media-picker-body"
        className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1"
      >
        <MediaEntryList
          preview={preview}
          selected={selected}
          status={status}
          disabled={creating}
          onSelectionChange={setSelected}
        />
        <div className="shrink-0 space-y-3">
          <MediaQualitySelect
            plan={plan}
            value={qualityValue}
            disabled={creating || picks.length === 0 || loadingQualities}
            onChange={setQuality}
          />
          {loadingQualities && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {t('task.add.media.picker.loadingQualities')}
            </p>
          )}
          {qualityLoadFailed && single && (
            <div className="flex items-center justify-between gap-2 text-xs text-destructive">
              <span>{t('task.add.media.picker.qualitiesFailed')}</span>
              <Button
                type="button"
                variant="link"
                size="xs"
                disabled={creating}
                onClick={() => void loadEntries(preview, [single.id])}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {folder !== null && (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={folderSwitchId} className="min-w-0 font-normal">
                <span className="truncate">
                  {t('task.add.media.picker.saveToFolder', { folder })}
                </span>
              </Label>
              <Switch
                id={folderSwitchId}
                checked={saveToFolder}
                disabled={creating}
                onCheckedChange={setSaveToFolder}
              />
            </div>
          )}
          {manyParts && (
            <Alert>
              <WarningIcon aria-hidden="true" />
              <AlertDescription className="text-xs">
                {t('task.add.media.picker.manyParts', {
                  selected: picks.length,
                  limit: preview.warnAboveParts,
                })}
              </AlertDescription>
            </Alert>
          )}
          {showFfmpegHint && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <InfoIcon
                className="mt-px size-3.5 shrink-0"
                aria-hidden="true"
              />
              {t('task.add.media.picker.ffmpegHint')}
            </p>
          )}
          {showLoginHint && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <InfoIcon
                className="mt-px size-3.5 shrink-0"
                aria-hidden="true"
              />
              {t('task.add.media.picker.loginHint')}
            </p>
          )}
          {notice && (
            <p role="alert" className="text-xs text-destructive">
              {notice}
            </p>
          )}
        </div>
      </div>
      <DialogFooter className="shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={creating}
          onClick={onClose}
        >
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={creating || picks.length === 0}
          onClick={() => void create()}
        >
          {creating
            ? t('task.add.adding')
            : t('task.add.media.picker.download', { selected: picks.length })}
        </Button>
      </DialogFooter>
    </>
  )
}
