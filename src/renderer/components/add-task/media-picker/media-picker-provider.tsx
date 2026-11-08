import {
  type AddTaskFormValues,
  addTaskFormSchema,
  formValuesToTaskCreateRequest,
} from '@shared/schemas/add-task'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { parseUrlLines } from '../url-interpreters/multiline-url'
import {
  EMPTY_PICK_SESSION,
  type MediaPickerCreated,
  MediaPickerDialog,
  type MediaPickerTarget,
  type MediaPickSession,
  type MediaPickSessionUpdate,
  type MediaRequestBase,
} from './media-picker-dialog'
import {
  type MediaLineMatch,
  useMediaResolverMatches,
} from './use-media-resolver-matches'

interface MediaPickerContextValue {
  matches: MediaLineMatch[]
  disabled: boolean
  open: (match: MediaLineMatch) => void
  /** Lines whose site resolution failed and may be saved as plain files. */
  pageFileUrls: string[]
  onDownloadPagesAsFiles: () => void
}

const MediaPickerContext = createContext<MediaPickerContextValue | null>(null)

export function useMediaPicker(): MediaPickerContextValue | null {
  return useContext(MediaPickerContext)
}

interface MediaPickerProviderProps {
  enabled: boolean
  disabled: boolean
  pageFileUrls: string[]
  onDownloadPagesAsFiles: () => void
  /** Every line of the form was added; finish the submission. */
  onComplete: (taskId: string) => void
  /** Holds the URL field, which takes focus when a picked line goes. */
  fieldScope: RefObject<HTMLElement | null>
  children: ReactNode
}

/**
 * Owns the media picker of the Add Task form: which lines a site resolver
 * claims, the open picker, and folding its created tasks back into the
 * form: the line goes once parts were added and the picker closes.
 */
export function MediaPickerProvider({
  enabled,
  disabled,
  pageFileUrls,
  onDownloadPagesAsFiles,
  onComplete,
  fieldScope,
  children,
}: MediaPickerProviderProps) {
  const form = useFormContext<AddTaskFormValues>()
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  const urls = useWatch<AddTaskFormValues, 'urls'>({ name: 'urls' })
  const active = enabled && (tab ?? 'links') === 'links'
  const matches = useMediaResolverMatches(active ? (urls ?? '') : '', active)
  const [target, setTarget] = useState<MediaPickerTarget | null>(null)
  // The chip that opened the picker leaves with its line.
  const focusUrls = useRef(false)
  // Per page, for the life of the form: a page pasted again remembers what
  // was added and which requests are still unconfirmed.
  const [sessions, setSessions] = useState<
    ReadonlyMap<string, MediaPickSession>
  >(() => new Map())
  const updateSession = useCallback(
    (url: string, update: MediaPickSessionUpdate) =>
      setSessions((current) =>
        new Map(current).set(
          url,
          update(current.get(url) ?? EMPTY_PICK_SESSION)
        )
      ),
    []
  )

  const requestBase = useCallback(
    (url: string): MediaRequestBase => {
      const values = form.getValues()
      if (values.tab === 'links' && !values.saveDir?.trim())
        return {
          ok: false,
          message: { key: 'task.add.errors.saveDirRequired' },
        }
      // The same checks as a plain Download, which also mark the fields.
      const parsed = addTaskFormSchema.safeParse(values)
      if (!parsed.success || parsed.data.tab !== 'links') {
        void form.trigger()
        const message = parsed.error?.issues[0]?.message ?? ''
        return {
          ok: false,
          message: {
            key: message.startsWith('task.add.errors.')
              ? message
              : 'task.add.media.picker.invalidOptions',
          },
        }
      }
      const request = formValuesToTaskCreateRequest({
        ...parsed.data,
        urls: url,
        // Picked parts get names planned from the resolution.
        filename: undefined,
      })
      return request.type === 'http'
        ? { ok: true, request }
        : {
            ok: false,
            message: { key: 'task.add.media.picker.invalidOptions' },
          }
    },
    [form]
  )

  const handleCreated = useCallback(
    ({ url, firstTaskId }: MediaPickerCreated) => {
      focusUrls.current = true
      setTarget(null)
      const current = form.getValues('urls') ?? ''
      const drop = new Set(
        parseUrlLines(current)
          .filter((line) => line.url === url)
          .map((line) => line.line)
      )
      const remaining = current
        .split('\n')
        .filter((_, index) => !drop.has(index))
        .join('\n')
      form.setValue('urls', remaining, {
        shouldDirty: true,
        shouldValidate: Boolean(remaining.trim()),
      })
      // A line that is still there, even a mistyped one, keeps the form open
      // with its error, as after a plain Download.
      if (parseUrlLines(remaining).length === 0) onComplete(firstTaskId)
    },
    [form, onComplete]
  )

  const finalFocus = useCallback(
    () =>
      focusUrls.current
        ? (fieldScope.current?.querySelector<HTMLElement>(
            '[data-add-task-urls]'
          ) ?? null)
        : null,
    [fieldScope]
  )

  const presentUrls = useMemo(
    () =>
      new Set(
        parseUrlLines(urls ?? '')
          .filter((line) => line.valid)
          .map((line) => line.url)
      ),
    [urls]
  )
  const value = useMemo<MediaPickerContextValue>(
    () => ({
      matches,
      disabled,
      open: (match) => {
        focusUrls.current = false
        setTarget({ url: match.url, pluginName: match.match.pluginName })
      },
      pageFileUrls: active
        ? pageFileUrls.filter((url) => presentUrls.has(url))
        : [],
      onDownloadPagesAsFiles,
    }),
    [
      matches,
      disabled,
      active,
      pageFileUrls,
      presentUrls,
      onDownloadPagesAsFiles,
    ]
  )

  return (
    <MediaPickerContext.Provider value={value}>
      {children}
      {enabled && (
        <MediaPickerDialog
          target={target}
          session={(target && sessions.get(target.url)) || EMPTY_PICK_SESSION}
          onSessionChange={updateSession}
          requestBase={requestBase}
          onClose={() => setTarget(null)}
          onCreated={handleCreated}
          finalFocus={finalFocus}
        />
      )}
    </MediaPickerContext.Provider>
  )
}
