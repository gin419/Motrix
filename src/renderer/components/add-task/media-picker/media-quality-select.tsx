import { Label } from '@renderer/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@renderer/components/ui/native-select'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { QualityOption, QualityPlan } from './media-pick-plan'

interface MediaQualitySelectProps {
  plan: QualityPlan
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}

/**
 * One quality for the whole pick: an exact variant for a single part, or a
 * height ceiling shared by several parts. Locked and FFmpeg-dependent tiers
 * stay visible but disabled, with the reason in their label.
 */
export function MediaQualitySelect({
  plan,
  value,
  disabled,
  onChange,
}: MediaQualitySelectProps) {
  const { t } = useTranslation()
  const id = useId()
  const label = (option: QualityOption) => {
    if (option.choice.kind === 'best') return t('task.add.media.picker.best')
    if (option.choice.kind === 'maxHeight')
      return t('task.add.media.picker.upTo', { label: option.label })
    switch (option.blocked) {
      case 'login':
        return t('task.add.media.picker.lockedLogin', { label: option.label })
      case 'premium':
        return t('task.add.media.picker.lockedPremium', {
          label: option.label,
        })
      case 'ffmpeg':
        return t('task.add.media.picker.needsFfmpeg', { label: option.label })
      default:
        return option.label
    }
  }
  return (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={id}>{t('task.add.media.picker.quality')}</Label>
      <NativeSelect
        id={id}
        size="sm"
        className="min-w-44"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {plan.options.map((option) => (
          <NativeSelectOption
            key={option.value}
            value={option.value}
            disabled={option.blocked !== undefined}
          >
            {label(option)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}
