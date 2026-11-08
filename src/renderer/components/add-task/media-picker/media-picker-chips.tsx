import { DocumentIcon, VideoIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { useTranslation } from 'react-i18next'
import { useMediaPicker } from './media-picker-provider'

/**
 * One chip per URL line a site resolver claims, opening the part and
 * quality picker. A plain Download keeps the one-click path, so the chip is
 * an extra, never a required step.
 */
export function MediaPickerChips() {
  const { t } = useTranslation()
  const picker = useMediaPicker()
  if (!picker) return null
  const { matches, pageFileUrls } = picker
  if (matches.length === 0 && pageFileUrls.length === 0) return null
  const numbered = matches.length > 1
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {matches.map((match) => {
        const label = t('task.add.media.picker.chip', {
          plugin: match.match.pluginName,
        })
        const line = t('task.add.sourceLine', { line: match.line + 1 })
        return (
          <Button
            key={match.url}
            type="button"
            variant="outline"
            size="xs"
            disabled={picker.disabled}
            className="max-w-full"
            title={match.url}
            onClick={() => picker.open(match)}
          >
            <VideoIcon aria-hidden="true" />
            <span className="truncate">
              {numbered ? `${label} · ${line}` : label}
            </span>
          </Button>
        )
      })}
      {pageFileUrls.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={picker.disabled}
          onClick={picker.onDownloadPagesAsFiles}
        >
          <DocumentIcon aria-hidden="true" />
          {t('task.add.media.downloadAsFile')}
        </Button>
      )}
    </div>
  )
}
