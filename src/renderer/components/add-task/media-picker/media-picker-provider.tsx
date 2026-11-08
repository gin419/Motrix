import {
  type AddTaskFormValues,
  formValuesToTaskCreateRequest,
} from '@shared/schemas/add-task'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import { useFormContext, useWatch } from 'react-hook-form'
import { parseUrlLines } from '../url-interpreters/multiline-url'
import {
  type HttpTaskCreateRequest,
  type MediaPickerCreated,
  MediaPickerDialog,
  type MediaPickerTarget,
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
  children: ReactNode
}

/**
 * Owns the media picker of the Add Task form: which lines a site resolver
 * claims, the open picker, and folding its created tasks back into the
 * form (the line goes once every picked part was added).
 */
export function MediaPickerProvider({
  enabled,
  disabled,
  pageFileUrls,
  onDownloadPagesAsFiles,
  onComplete,
  children,
}: MediaPickerProviderProps) {
  const form = useFormContext<AddTaskFormValues>()
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  const urls = useWatch<AddTaskFormValues, 'urls'>({ name: 'urls' })
  const active = enabled && (tab ?? 'links') === 'links'
  const matches = useMediaResolverMatches(active ? (urls ?? '') : '', active)
  const [target, setTarget] = useState<MediaPickerTarget | null>(null)

  const requestBase = useCallback(
    (url: string): HttpTaskCreateRequest | null => {
      const values = form.getValues()
      if (values.tab !== 'links' || !values.saveDir?.trim()) return null
      const request = formValuesToTaskCreateRequest({
        ...values,
        urls: url,
        // Picked parts get names planned from the resolution.
        filename: undefined,
      })
      return request.type === 'http' ? request : null
    },
    [form]
  )

  const handleCreated = useCallback(
    ({ url, firstTaskId }: MediaPickerCreated) => {
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
      if (!parseUrlLines(remaining).some((line) => line.valid))
        onComplete(firstTaskId)
    },
    [form, onComplete]
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
      open: (match) =>
        setTarget({ url: match.url, pluginName: match.match.pluginName }),
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
          requestBase={requestBase}
          onClose={() => setTarget(null)}
          onCreated={handleCreated}
        />
      )}
    </MediaPickerContext.Provider>
  )
}
