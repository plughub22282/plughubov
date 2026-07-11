import React, { useState } from 'react'
import { MAX_HASHTAGS, normalizeHashtags } from '../../../shared/hashtags'
import { useI18n } from '../i18n'
import { IconX } from './pluginCommon'

interface HashtagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
}

export function HashtagInput({ value, onChange, disabled }: HashtagInputProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const addTags = (input: string) => {
    const raw = input.trim()
    if (!raw) {
      setDraft('')
      setError('')
      return
    }

    const result = normalizeHashtags([...value, raw])
    if (!result.ok) {
      setError(result.error ?? t('hashtags.invalid'))
      return
    }

    onChange(result.tags)
    setDraft('')
    setError('')
  }

  const removeTag = (tag: string) => {
    onChange(value.filter((item) => item !== tag))
    setError('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault()
      addTags(draft)
      return
    }

    if (e.key === 'Backspace' && !draft && value.length > 0) {
      removeTag(value[value.length - 1])
    }
  }

  const handleBlur = () => addTags(draft)

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!/[\s,;]/.test(text)) return
    e.preventDefault()
    addTags(text)
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="form-label mb-0">
          {t('hashtags.label')}
        </label>
        <span className="text-[11px] text-txt-muted tabular-nums">
          {value.length}/{MAX_HASHTAGS}
        </span>
      </div>

      <div className="input-field min-h-[44px] flex flex-wrap items-center gap-2 py-2">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2 py-1 text-xs font-medium text-accent"
          >
            #{tag}
            <button
              type="button"
              disabled={disabled}
              onClick={() => removeTag(tag)}
              className="text-accent/70 hover:text-accent disabled:opacity-40"
              title={t('hashtags.remove')}
            >
              <IconX />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          disabled={disabled || value.length >= MAX_HASHTAGS}
          onChange={(e) => { setDraft(e.target.value); setError('') }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPaste={handlePaste}
          placeholder={value.length >= MAX_HASHTAGS ? t('hashtags.limit') : t('hashtags.placeholder')}
          className="min-w-[140px] flex-1 text-sm text-txt-primary placeholder-txt-muted disabled:cursor-not-allowed disabled:opacity-45"
          maxLength={80}
        />
      </div>

      <div className={`mt-1 text-[11px] ${error ? 'text-status-error' : 'text-txt-muted'}`}>
        {error || t('hashtags.hint')}
      </div>
    </div>
  )
}
