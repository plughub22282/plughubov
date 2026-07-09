import React, { useState, useEffect, useCallback } from 'react'
import type { UploadMeta, UserRole } from '../types'
import { useI18n } from '../i18n'
import { FileDropZone, Toast, type ToastType } from './FileDropZone'

const CATEGORIES = ['Synthesizer', 'Sampler', 'Reverb', 'Delay', 'Dynamics', 'EQ', 'Effect', 'Instrument', 'Utility']

interface FormState extends UploadMeta {
  name: string
  version: string
  description: string
  category: string
}

const initialForm: FormState = {
  name: '',
  version: '',
  description: '',
  category: 'Synthesizer'
}

// ─── UploadPlugin ─────────────────────────────────────────────────────────────

export default function UploadPlugin() {
  const { t } = useI18n()
  // Defense-in-depth: компонент сам проверяет роль, не полагаясь только на скрытие
  // вкладки. Реальную защиту обеспечивают серверный guard в main и RLS в БД.
  const [role, setRole] = useState<UserRole | null>(null)
  useEffect(() => {
    window.api.auth.getState().then((s) => setRole(s.role))
  }, [])

  const [form, setForm] = useState<FormState>(initialForm)
  const [archivePath, setArchivePath] = useState<string | null>(null)
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null)

  const showToast = useCallback((message: string, type: ToastType) => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 5000)
  }, [])

  const update = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const isValid =
    form.name.trim() !== '' &&
    form.version.trim() !== '' &&
    form.description.trim() !== '' &&
    archivePath !== null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || !archivePath) return

    setSubmitting(true)
    try {
      const result = await window.api.uploadPlugin(
        { name: form.name, version: form.version, description: form.description, category: form.category },
        archivePath,
        iconPath ?? undefined
      )
      if (result.ok) {
        showToast(t('upload.success', { name: form.name }), 'success')
        setForm(initialForm)
        setArchivePath(null)
        setIconPath(null)
      } else {
        showToast(t('common.errorWithMessage', { error: result.error ?? t('plugin.unknownError') }), 'error')
      }
    } catch (err) {
      showToast(t('common.unexpectedError', { error: String(err) }), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // Не-авторам показываем экран блокировки вместо формы.
  if (role !== null && role !== 'author') {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="w-14 h-14 rounded-2xl bg-app-panel border border-app-border flex items-center justify-center mx-auto mb-5 text-txt-muted">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-txt-primary mb-2">{t('upload.lockedTitle')}</h2>
          <p className="text-sm text-txt-secondary leading-relaxed">
            {t('upload.lockedText')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-txt-primary">{t('upload.pluginTitle')}</h1>
          <p className="text-txt-secondary text-sm mt-1">
            {t('upload.pluginSubtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Name + Version */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
                {t('upload.pluginName')} *
              </label>
              <input
                type="text"
                placeholder="My Awesome Plugin"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                className="input-field"
                maxLength={80}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
                {t('common.version')} *
              </label>
              <input
                type="text"
                placeholder="1.0.0"
                value={form.version}
                onChange={(e) => update('version', e.target.value)}
                className="input-field"
                maxLength={20}
              />
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
              {t('common.category')}
            </label>
            <select
              value={form.category}
              onChange={(e) => update('category', e.target.value)}
              className="select-field"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="bg-app-card">
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
              {t('common.description')} *
            </label>
            <textarea
              placeholder={t('upload.descriptionPlaceholder')}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              className="input-field resize-none h-28 leading-relaxed"
              maxLength={500}
            />
            <div className="text-right text-xs text-txt-muted mt-1">
              {form.description.length}/500
            </div>
          </div>

          {/* Files */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
                {t('upload.archive')} *
              </label>
              <FileDropZone
                label={t('upload.dragZip')}
                accept=".zip,.vst3"
                value={archivePath}
                onSelect={setArchivePath}
                hint={t('upload.zipHint')}
                icon={
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="12" y1="18" x2="12" y2="12" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                }
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
                {t('upload.iconOptional')}
              </label>
              <FileDropZone
                label={t('upload.pluginIcon')}
                accept=".png,.jpg,.jpeg,.webp"
                value={iconPath}
                onSelect={setIconPath}
                hint={t('upload.iconHint')}
                icon={
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                }
              />
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-app-border">
            <button
              type="button"
              onClick={() => { setForm(initialForm); setArchivePath(null); setIconPath(null) }}
              className="btn-ghost"
            >
              {t('common.reset')}
            </button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              className={`btn-primary min-w-32 flex items-center justify-center gap-2 ${
                !isValid || submitting ? 'opacity-40 cursor-not-allowed' : ''
              }`}
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t('plugin.downloading')}
                </>
              ) : (
                t('upload.publishPlugin')
              )}
            </button>
          </div>
        </form>
      </div>

      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  )
}
