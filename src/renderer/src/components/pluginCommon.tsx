import React, { useCallback, useRef, useState } from 'react'
import type { Plugin, InstallProgress, UploadStep } from '../types'
import { useI18n } from '../i18n'
import { AudioPlayerBar, PresetComparePlayer } from './AudioPlayer'
import { PremiumBadge } from './PremiumBadge'
import { ImageWithFallback } from './ImageWithFallback'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import { useUploadProgress } from '../hooks/useUploadProgress'
import { FileDropZone, Toast, type ToastType } from './FileDropZone'

// ─── Категории ────────────────────────────────────────────────────────────────

const CATEGORY_DOT: Record<string, string> = {
  Synthesizer: '#a78bfa',
  Sampler:     '#f472b6',
  Reverb:      '#60a5fa',
  Delay:       '#34d399',
  Instrument:  '#4ade80',
  Dynamics:    '#fbbf24',
  EQ:          '#fb923c',
  Effect:      '#f87171',
  Utility:     '#94a3b8'
}

export function catDot(cat: string): string {
  return CATEGORY_DOT[cat] ?? '#94a3b8'
}

// ─── Иконки ───────────────────────────────────────────────────────────────────

export const IconSearch = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

export const IconRefresh = ({ spin }: { spin: boolean }) => (
  <svg
    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    className={spin ? 'animate-spin' : ''}
    style={{ animation: spin ? 'spin 1.2s linear infinite' : 'none' }}
  >
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
)

export const IconX = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const IconTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

const IconDownloads = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const IconClock = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
    <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" />
  </svg>
)

const IconGear = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

// ─── SearchField ───────────────────────────────────────────────────────────────

/** Единое поле поиска для каталога, маркетплейса и ассетов. */
export function SearchField({
  value,
  onChange,
  placeholder,
  className = 'flex-1 min-w-0 max-w-sm'
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <div className={`search-wrap relative ${className}`}>
      <span className="search-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-muted">
        <IconSearch />
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="search-field"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear"
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-txt-muted no-drag hover:bg-white/10 hover:text-txt-primary"
          style={{ transition: 'background 140ms, color 120ms' }}
        >
          <IconX />
        </button>
      )}
    </div>
  )
}

// ─── ProgressBar ──────────────────────────────────────────────────────────────

export function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="mt-2">
      <div className="flex justify-between items-center text-[11px] mb-1.5">
        <span className="text-txt-muted">{label}</span>
        <span className="font-medium text-accent">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1 bg-app-panel rounded-full overflow-hidden"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'rgb(var(--ac))', transition: 'width 200ms ease' }}
        />
      </div>
    </div>
  )
}

// ─── UploadSteps ──────────────────────────────────────────────────────────────
// Живой пошаговый прогресс загрузки (плагин/ассет) вместо статичного «Загрузка».

const UPLOAD_STEP_ORDER: UploadStep[] = ['validate', 'upload', 'icon', 'publish', 'done']

export function UploadSteps({ step, error, hasIcon }: {
  step?: UploadStep
  error?: string
  hasIcon: boolean
}) {
  const { t } = useI18n()
  const order = hasIcon ? UPLOAD_STEP_ORDER : UPLOAD_STEP_ORDER.filter((s) => s !== 'icon')
  const lastGoodRef = useRef(0)
  if (step && step !== 'error') {
    const idx = order.indexOf(step)
    if (idx >= 0) lastGoodRef.current = idx
  }
  const activeIndex = lastGoodRef.current
  const isError = step === 'error'

  const labels: Record<UploadStep, string> = {
    validate: t('upload.stepValidate'),
    upload: t('upload.stepUpload'),
    icon: t('upload.stepIcon'),
    publish: t('upload.stepPublish'),
    done: t('upload.stepDone'),
    error: ''
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-app-border/50 bg-app-panel/40 px-3.5 py-3">
      {order.map((s, i) => {
        const isDone = i < activeIndex || (i === activeIndex && s === 'done')
        const isActive = i === activeIndex && s !== 'done' && !isError
        return (
          <div key={s} className="flex items-center gap-2.5 text-xs">
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {isDone ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--ac))" strokeWidth="2.6">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : isActive ? (
                <span className="h-3 w-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-txt-muted/40" />
              )}
            </span>
            <span className={isDone ? 'text-txt-secondary' : isActive ? 'font-medium text-txt-primary' : 'text-txt-muted'}>
              {labels[s]}
            </span>
          </div>
        )
      })}
      {isError && (
        <div
          role="alert"
          aria-live="assertive"
          className="text-[11px] text-status-error bg-red-500/8 border border-red-500/15 rounded-xl px-3 py-2 mt-1"
        >
          {error ?? t('plugin.unknownError')}
        </div>
      )}
    </div>
  )
}

// ─── Upload Locked Screen ───────────────────────────────────────────────────
// Общий экран-заглушка для форм публикации, к которым у пользователя нет доступа
// (роль не «author» / не владелец приложения и т.п.).

export function UploadLockedScreen({ title, text }: { title: string; text: string }) {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="w-14 h-14 rounded-2xl bg-app-panel border border-app-border flex items-center justify-center mx-auto mb-5 text-txt-muted">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-txt-primary mb-2">{title}</h2>
        <p className="text-sm text-txt-secondary leading-relaxed">{text}</p>
      </div>
    </div>
  )
}

// ─── Plugin Upload Form ─────────────────────────────────────────────────────
// Общая форма публикации плагина: используется и авторами (UploadPlugin, свой
// маркетплейс) и админом (AdminCatalogUpload, официальный каталог). Разница —
// только в наличии поля «Автор» и в переданном submit-обработчике.

const UPLOAD_CATEGORIES = [
  'Synthesizer', 'Sampler', 'Reverb', 'Delay', 'Dynamics', 'EQ', 'Effect', 'Instrument', 'Utility'
]

export interface PluginUploadFormState {
  name: string
  author?: string
  version: string
  description: string
  category: string
}

const emptyUploadForm = (withAuthor: boolean): PluginUploadFormState => ({
  name: '',
  ...(withAuthor ? { author: '' } : {}),
  version: '',
  description: '',
  category: 'Synthesizer'
})

export interface PluginUploadFormProps {
  title: string
  subtitle: string
  submitLabel: string
  /** Показывать поле «Автор» (нужно для официального каталога, не нужно для своих плагинов). */
  withAuthor?: boolean
  archiveAccept?: string
  onSubmit: (
    form: PluginUploadFormState,
    archivePath: string,
    iconPath: string | undefined,
    uploadId: string
  ) => Promise<{ ok: boolean; error?: string }>
  onSuccess: (name: string) => void
  /** Текст тоста об успехе; по умолчанию — общий "Плагин «{name}» успешно сохранён!". */
  successMessage?: (name: string) => string
}

export function PluginUploadForm({
  title, subtitle, submitLabel, withAuthor, archiveAccept = '.zip,.vst3', onSubmit, onSuccess, successMessage
}: PluginUploadFormProps) {
  const { t } = useI18n()
  const [form, setForm] = useState<PluginUploadFormState>(() => emptyUploadForm(!!withAuthor))
  const [archivePath, setArchivePath] = useState<string | null>(null)
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null)
  const { progress, start, reset } = useUploadProgress()

  const showToast = useCallback((message: string, type: ToastType) => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 5000)
  }, [])

  const update = <K extends keyof PluginUploadFormState>(key: K, value: PluginUploadFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const resetForm = () => {
    setForm(emptyUploadForm(!!withAuthor))
    setArchivePath(null)
    setIconPath(null)
  }

  const isValid =
    form.name.trim() !== '' &&
    (!withAuthor || (form.author ?? '').trim() !== '') &&
    form.version.trim() !== '' &&
    form.description.trim() !== '' &&
    archivePath !== null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || !archivePath) return

    setSubmitting(true)
    const uploadId = start()
    try {
      const result = await onSubmit(form, archivePath, iconPath ?? undefined, uploadId)
      if (result.ok) {
        showToast(successMessage ? successMessage(form.name) : t('upload.success', { name: form.name }), 'success')
        onSuccess(form.name)
        resetForm()
      } else {
        showToast(t('common.errorWithMessage', { error: result.error ?? t('plugin.unknownError') }), 'error')
      }
    } catch (err) {
      showToast(t('common.unexpectedError', { error: String(err) }), 'error')
    } finally {
      setSubmitting(false)
      reset()
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-txt-primary">{title}</h1>
          <p className="text-txt-secondary text-sm mt-1">{subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="form-label">{t('upload.pluginName')} *</label>
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
              <label className="form-label">{t('common.version')} *</label>
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

          {withAuthor ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">{t('common.author')} *</label>
                <input
                  type="text"
                  placeholder="Developer / Studio"
                  value={form.author ?? ''}
                  onChange={(e) => update('author', e.target.value)}
                  className="input-field"
                  maxLength={80}
                />
              </div>
              <div>
                <label className="form-label">{t('common.category')}</label>
                <select
                  value={form.category}
                  onChange={(e) => update('category', e.target.value)}
                  className="select-field"
                >
                  {UPLOAD_CATEGORIES.map((c) => (
                    <option key={c} value={c} className="bg-app-card">{c}</option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div>
              <label className="form-label">{t('common.category')}</label>
              <select
                value={form.category}
                onChange={(e) => update('category', e.target.value)}
                className="select-field"
              >
                {UPLOAD_CATEGORIES.map((c) => (
                  <option key={c} value={c} className="bg-app-card">{c}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="form-label">{t('common.description')} *</label>
            <textarea
              placeholder={t('upload.descriptionPlaceholder')}
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              className="input-field resize-none h-28 leading-relaxed"
              maxLength={500}
            />
            <div className="text-right text-xs text-txt-muted mt-1">{form.description.length}/500</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">{t('upload.archive')} *</label>
              <FileDropZone
                label={t('upload.dragZip')}
                accept={archiveAccept}
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
              <label className="form-label">{withAuthor ? t('common.icon') : t('upload.iconOptional')}</label>
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

          {(submitting || progress) && (
            <UploadSteps step={progress?.step} error={progress?.error} hasIcon={!!iconPath} />
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-app-border">
            <button type="button" onClick={resetForm} className="btn-ghost">
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
                  {t('upload.stepUpload')}
                </>
              ) : (
                submitLabel
              )}
            </button>
          </div>
        </form>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// ─── Plugin Card ──────────────────────────────────────────────────────────────

/** Подписи кнопки действия карточки (по умолчанию — установка плагина). */
export interface CardLabels {
  action: string   // «Установить» / «Скачать»
  busy: string     // «Установка» / «Загрузка»
  done: string     // «✓ Установлен» / «✓ Скачано»
}

export interface PluginCardProps {
  plugin: Plugin & { downloads?: number; likes?: number }
  progress: InstallProgress | null
  onInstall: (p: Plugin) => void
  /** Если задан — на карточке появляется кнопка удаления (для своих плагинов). */
  onDelete?: (p: Plugin) => void
  /** Подписи кнопки действия (для ассетов — «Скачать» и т.п.). */
  labels?: CardLabels
  /** Если задан — показывается мини-плеер с превью (лупы, биты). */
  previewUrl?: string
  previewLimitSec?: number
  /** Пресеты: два готовых клипа для живого A/B-плеера (с эффектами / без). */
  previewWetUrl?: string
  previewDryUrl?: string
  /** Цена платного контента (битов), напр. «20$». */
  price?: string
  /** Если задан — вместо «Скачать» показывается кнопка «Купить» (биты). */
  onBuy?: (p: Plugin) => void
  /** Показать кнопку «Скачать архивом» (суточный лимит автоустановок исчерпан). */
  showArchive?: boolean
  onArchive?: (p: Plugin) => void
  /**
   * Синхронный «занято» флаг от родителя — выставляется в обработчике клика ДО
   * вызова window.api, чтобы закрыть окно гонки между кликом и первым install:progress
   * (несколько сетевых round-trip'ов в performInstall до первого события). Как только
   * приходит любое реальное событие прогресса, isInstalling переключается на него.
   */
  pending?: boolean
  /** Если задан — клик по карточке (вне кнопок) открывает модалку с деталями. */
  onOpenDetails?: (p: Plugin) => void
  /** Иконка типа контента для плейсхолдера обложки (драм-кит/лут/пресет и т.п.). */
  fallbackIcon?: React.ReactNode
}

/**
 * Кнопка действия карточки (Установить/Купить/Скачать архивом) + прогресс/ошибка.
 * Вынесена из PluginCard, чтобы PluginDetailsModal использовала ту же логику состояний
 * установки без дублирования (size меняет только визуальный размер кнопки).
 */
function InstallAction({
  plugin, progress, onInstall, labels, price, onBuy, showArchive, onArchive, pending, size = 'sm'
}: {
  plugin: Plugin
  progress: InstallProgress | null
  onInstall: (p: Plugin) => void
  labels?: CardLabels
  price?: string
  onBuy?: (p: Plugin) => void
  showArchive?: boolean
  onArchive?: (p: Plugin) => void
  pending?: boolean
  size?: 'sm' | 'lg'
}) {
  const { t } = useI18n()
  const resolvedLabels = labels ?? {
    action: t('plugin.install'),
    busy: t('plugin.installing'),
    done: `✓ ${t('plugin.installed')}`
  }
  const isInstalling =
    (!!progress && progress.step !== 'done' && progress.step !== 'error') || (!!pending && !progress)
  const isDone = progress?.step === 'done'
  const isError = progress?.step === 'error'
  const progressLabel =
    progress?.step === 'download' ? t('progress.download') :
    progress?.step === 'scan'     ? t('progress.scan') :
    progress?.step === 'extract'  ? resolvedLabels.busy : ''
  const btnSize = size === 'lg' ? 'py-3 text-sm' : 'py-2 text-xs'

  return (
    <div className="space-y-2">
      {onBuy ? (
        <button
          onClick={(e) => { e.stopPropagation(); onBuy(plugin) }}
          className={`btn-primary w-full ${btnSize}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
          </svg>
          {price ? `${t('plugin.buy')} · ${price}` : t('plugin.buy')}
        </button>
      ) : (
        <>
          {isError && (
            <div
              role="alert"
              aria-live="assertive"
              className="text-[11px] text-status-error bg-red-500/8 border border-red-500/15 rounded-xl px-3 py-2"
            >
              {progress?.error ?? t('plugin.unknownError')}
            </div>
          )}
          {isInstalling && progress?.pct !== undefined && (
            <ProgressBar pct={progress.pct} label={progressLabel} />
          )}
          <button
            disabled={isInstalling || plugin.installed || isDone}
            onClick={(e) => { e.stopPropagation(); onInstall(plugin) }}
            className={`w-full ${btnSize} rounded-xl font-semibold no-drag flex items-center justify-center gap-2 ${
              plugin.installed || isDone
                ? 'bg-status-success/8 text-status-success cursor-default'
                : isInstalling
                  ? 'cursor-wait opacity-60'
                  : 'btn-primary'
            }`}
            style={isInstalling && !plugin.installed && !isDone
              ? { background: 'rgb(var(--ac) / 0.12)', color: 'rgb(var(--ac))' }
              : undefined
            }
          >
            {plugin.installed || isDone ? (
              resolvedLabels.done
            ) : isInstalling ? (
              progressLabel || resolvedLabels.busy
            ) : size === 'lg' ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {resolvedLabels.action}
                {plugin.size && <span className="opacity-60 font-normal">{plugin.size}</span>}
              </>
            ) : (
              resolvedLabels.action
            )}
          </button>

          {/* Fallback при исчерпании суточного лимита автоустановок (free). */}
          {showArchive && onArchive && !plugin.installed && !isDone && (
            <button
              onClick={(e) => { e.stopPropagation(); onArchive(plugin) }}
              disabled={isInstalling}
              className="w-full py-2 rounded-xl text-xs font-semibold no-drag btn-ghost disabled:opacity-50"
            >
              {t('plugin.downloadArchive')}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────
// Общий модальный запрос подтверждения для деструктивных действий (удаление и т.п.).

interface ConfirmDialogProps {
  title: string
  body: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, body, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useI18n()
  useEscapeToClose(onCancel)
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { e.stopPropagation(); onCancel() }}
    >
      <div
        className="card relative w-full max-w-sm p-6 animate-slide-up no-drag select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-txt-primary">{title}</h3>
        <p className="text-xs text-txt-secondary leading-relaxed mt-2">{body}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={(e) => { e.stopPropagation(); onCancel() }}
            className="btn-ghost px-4 py-2 rounded-xl text-xs font-semibold no-drag"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onConfirm() }}
            className="px-4 py-2 rounded-xl text-xs font-semibold no-drag bg-status-error text-white"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PluginCard({
  plugin, progress, onInstall, onDelete, labels, previewUrl, previewLimitSec, previewWetUrl, previewDryUrl, price, onBuy,
  showArchive, onArchive, pending, onOpenDetails, fallbackIcon
}: PluginCardProps) {
  const { t } = useI18n()
  const [durSec, setDurSec] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  return (
    <div
      className={`card-interactive p-5 flex flex-col gap-3.5 group relative overflow-hidden select-none`}
      onClick={onOpenDetails ? () => onOpenDetails(plugin) : undefined}
    >
      {/* Тонкий категорийный акцент сверху — проявляется на hover */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-5 top-0 h-[2px] rounded-full opacity-50 group-hover:opacity-100"
        style={{
          background: `linear-gradient(90deg, transparent, ${catDot(plugin.category)}, transparent)`,
          transition: 'opacity 180ms ease'
        }}
      />
      {/* Delete (own) */}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true) }}
          title={t('plugin.deleteMine')}
          className="absolute top-2.5 right-2.5 w-7 h-7 flex items-center justify-center rounded-lg
                     text-txt-muted opacity-0 group-hover:opacity-100 hover:text-status-error no-drag"
          style={{ transition: 'opacity 150ms, color 120ms, background 150ms' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <IconTrash />
        </button>
      )}
      {onDelete && confirmingDelete && (
        <ConfirmDialog
          title={t('plugin.deleteConfirmTitle')}
          body={t('plugin.deleteConfirmBody').replace('{name}', plugin.name)}
          onConfirm={() => { setConfirmingDelete(false); onDelete(plugin) }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <ImageWithFallback
          src={plugin.iconUrl}
          alt={plugin.name}
          seed={plugin.id}
          icon={fallbackIcon}
          className="w-10 h-10 rounded-xl object-cover flex-shrink-0 ring-1 ring-white/10
                     transition-transform duration-200 group-hover:scale-[1.04]"
        />

        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold text-sm text-txt-primary truncate leading-tight">{plugin.name}</h3>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: catDot(plugin.category) }}
            />
            <span className="text-[11px] text-txt-muted truncate min-w-0">
              {plugin.category} · {plugin.author}
            </span>
            {/* Верификационная галочка автора-премиума (п.6). */}
            {plugin.authorIsPremium && <PremiumBadge size={11} />}
            {plugin.version && (
              <span className="text-[11px] text-txt-muted flex-shrink-0">· v{plugin.version}</span>
            )}
          </div>
        </div>

        {!onDelete && (
          <span className="text-[10px] text-txt-muted flex-shrink-0 pt-1">{plugin.size}</span>
        )}
      </div>

      {/* Description */}
      <p className="text-xs text-txt-secondary leading-relaxed line-clamp-2">
        {plugin.description}
      </p>

      {plugin.tags && plugin.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 -mt-1">
          {plugin.tags.slice(0, 5).map((tag) => (
            <span
              key={tag}
              className="rounded-md border border-accent/20 bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent"
            >
              #{tag.replace(/^#/, '')}
            </span>
          ))}
        </div>
      )}

      {/* Meta row: длительность · размер · скачивания */}
      {plugin.downloads !== undefined && (
        <div className="flex items-center gap-3 text-[11px] text-txt-muted -mt-1 flex-wrap">
          <span className="flex items-center gap-1">
            <IconDownloads /> {plugin.downloads}
          </span>
          {durSec > 0 && (
            <span className="flex items-center gap-1">
              <IconClock /> {fmtTime(durSec)}
            </span>
          )}
          <span>{plugin.size}</span>
        </div>
      )}

      {/* Пресеты: живой A/B-плеер (с эффектами / без) вместо обычного превью */}
      {previewWetUrl && previewDryUrl ? (
        <PresetComparePlayer
          wetUrl={previewWetUrl}
          dryUrl={previewDryUrl}
          onDuration={setDurSec}
          stickers={[plugin.category, plugin.tags?.[0]].filter((v): v is string => !!v)}
        />
      ) : (
        /* Мини-плеер с таймлайном (лупы, биты) */
        previewUrl && <AudioPlayerBar url={previewUrl} onDuration={setDurSec} limitSec={previewLimitSec} />
      )}

      {/* Footer */}
      <div className="mt-auto">
        <InstallAction
          plugin={plugin}
          progress={progress}
          onInstall={onInstall}
          labels={labels}
          price={price}
          onBuy={onBuy}
          showArchive={showArchive}
          onArchive={onArchive}
          pending={pending}
        />
      </div>
    </div>
  )
}

// ─── Plugin Details Modal ─────────────────────────────────────────────────────
// Открывается по клику на карточку (Каталог/Маркетплейс) — крупная карточка с
// иконкой, категорией, разработчиком, версией и полным описанием плагина.

export interface PluginDetailsModalProps {
  plugin: Plugin & { downloads?: number; likes?: number }
  progress: InstallProgress | null
  onInstall: (p: Plugin) => void
  onDelete?: (p: Plugin) => void
  labels?: CardLabels
  price?: string
  onBuy?: (p: Plugin) => void
  showArchive?: boolean
  onArchive?: (p: Plugin) => void
  pending?: boolean
  onClose: () => void
}

export function PluginDetailsModal({
  plugin, progress, onInstall, onDelete, labels, price, onBuy, showArchive, onArchive, pending, onClose
}: PluginDetailsModalProps) {
  const { t } = useI18n()
  const authorInitial = plugin.author.trim()[0]?.toUpperCase() ?? '?'
  const accent = catDot(plugin.category)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  useEscapeToClose(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="card relative w-full max-w-md max-h-[88vh] overflow-y-auto p-6 animate-slide-up no-drag select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-4 right-4 flex items-center gap-1.5">
          {onDelete && (
            <button
              onClick={() => setConfirmingDelete(true)}
              title={t('plugin.deleteMine')}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-txt-muted hover:text-status-error"
              style={{ transition: 'background 150ms, color 120ms' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <IconTrash />
            </button>
          )}
          {onDelete && confirmingDelete && (
            <ConfirmDialog
              title={t('plugin.deleteConfirmTitle')}
              body={t('plugin.deleteConfirmBody').replace('{name}', plugin.name)}
              onConfirm={() => { setConfirmingDelete(false); onDelete(plugin) }}
              onCancel={() => setConfirmingDelete(false)}
            />
          )}
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-txt-muted hover:text-txt-primary"
            style={{ transition: 'background 150ms, color 120ms' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <IconX />
          </button>
        </div>

        {/* Header: крупная иконка + название + бейдж категории */}
        <div className="flex items-start gap-4 pr-16">
          <div
            className="w-24 h-24 rounded-3xl flex-shrink-0 flex items-center justify-center p-2"
            style={{ background: `linear-gradient(160deg, ${accent}55, ${accent}15)` }}
          >
            <ImageWithFallback
              src={plugin.iconUrl}
              alt={plugin.name}
              seed={plugin.id}
              className="w-full h-full rounded-2xl object-cover ring-1 ring-white/10"
            />
          </div>

          <div className="min-w-0 pt-1">
            <h2 className="text-lg font-bold text-txt-primary leading-snug">{plugin.name}</h2>
            <span
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg font-medium"
              style={{ color: 'rgb(var(--ac))', background: 'rgb(var(--ac) / 0.1)', border: '1px solid rgb(var(--ac) / 0.22)' }}
            >
              <IconGear />
              {plugin.category}
            </span>
          </div>
        </div>

        {/* Разработчик / Активация / Версия */}
        <div className="grid grid-cols-3 gap-2 mt-5 pt-4 border-t border-app-border/50">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="w-5 h-5 rounded-md flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
                style={{ background: accent }}
              >
                {authorInitial}
              </span>
              <span className="text-xs font-semibold text-txt-primary truncate">{plugin.author}</span>
              {plugin.authorIsPremium && <PremiumBadge size={11} />}
            </div>
            <p className="text-[10px] text-txt-muted uppercase tracking-wide mt-1.5">{t('plugin.developer')}</p>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-xs font-semibold text-txt-primary">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--ac))" strokeWidth="2.6">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {t('plugin.builtIn')}
            </div>
            <p className="text-[10px] text-txt-muted uppercase tracking-wide mt-1.5">{t('plugin.activation')}</p>
          </div>
          <div className="min-w-0 text-right">
            <p className="text-xs font-semibold text-txt-primary tabular-nums">
              {plugin.version ? `v${plugin.version}` : '—'}
            </p>
            <p className="text-[10px] text-txt-muted uppercase tracking-wide mt-1.5">{t('common.version')}</p>
          </div>
        </div>

        <div className="mt-5">
          <InstallAction
            plugin={plugin}
            progress={progress}
            onInstall={onInstall}
            labels={labels}
            price={price}
            onBuy={onBuy}
            showArchive={showArchive}
            onArchive={onArchive}
            pending={pending}
            size="lg"
          />
        </div>

        <div className="mt-5 pt-4 border-t border-app-border/50">
          <h3
            className="text-xs font-semibold text-txt-secondary uppercase tracking-wider pb-2 mb-3 border-b-2 inline-block"
            style={{ borderColor: 'rgb(var(--ac))' }}
          >
            {t('common.description')}
          </h3>
          <p className="text-xs text-txt-secondary leading-relaxed whitespace-pre-line">
            {plugin.description}
          </p>
          {plugin.tags && plugin.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {plugin.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-accent/20 bg-accent/8 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                >
                  #{tag.replace(/^#/, '')}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

export function SkeletonCard() {
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl skeleton flex-shrink-0" />
        <div className="flex-1 pt-0.5 space-y-2">
          <div className="h-3.5 skeleton rounded-lg w-3/4" />
          <div className="h-2.5 skeleton rounded-lg w-1/2" />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-2.5 skeleton rounded-lg w-full" />
        <div className="h-2.5 skeleton rounded-lg w-4/5" />
      </div>
      <div className="h-8 skeleton rounded-xl mt-1" />
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

export function Empty({ icon, title, sub, action }: {
  icon: React.ReactNode
  title: string
  sub?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-txt-muted px-6 py-16">
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center"
        style={{ background: 'var(--ui-subtle)', border: '1px solid rgb(var(--bdr) / 0.6)' }}
      >
        {icon}
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-txt-secondary">{title}</p>
        {sub && <p className="text-xs text-txt-muted mt-1">{sub}</p>}
      </div>
      {action}
    </div>
  )
}
