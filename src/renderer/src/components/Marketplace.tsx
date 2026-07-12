import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { CommunityPlugin, InstallProgress, Plugin } from '../types'
import { useI18n } from '../i18n'
import { useSearch } from '../hooks/useSearch'
import { useUploadProgress } from '../hooks/useUploadProgress'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import {
  PluginCard, PluginDetailsModal, SkeletonCard, Empty, UploadSteps,
  IconRefresh, IconX
} from './pluginCommon'
import { FileDropZone, Toast, type ToastType } from './FileDropZone'
import { HashtagInput } from './HashtagInput'

const CATEGORIES = ['Synthesizer', 'Sampler', 'Reverb', 'Delay', 'Dynamics', 'EQ', 'Effect', 'Instrument', 'Utility']
const ALL_CATEGORY = '__all__'

// ─── Upload Modal ───────────────────────────────────────────────────────────

interface UploadForm {
  name: string
  version: string
  description: string
  category: string
  tags: string[]
}

const emptyForm: UploadForm = { name: '', version: '', description: '', category: 'Synthesizer', tags: [] }

function UploadModal({ onClose, onUploaded, notify }: {
  onClose: () => void
  onUploaded: () => void
  notify: (msg: string, type: ToastType) => void
}) {
  const { t } = useI18n()
  const [form, setForm] = useState<UploadForm>(emptyForm)
  const [archivePath, setArchivePath] = useState<string | null>(null)
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { progress, start, reset } = useUploadProgress()

  useEscapeToClose(onClose)

  const update = <K extends keyof UploadForm>(k: K, v: UploadForm[K]) => setForm((p) => ({ ...p, [k]: v }))

  const isValid =
    form.name.trim() !== '' &&
    form.version.trim() !== '' &&
    form.description.trim() !== '' &&
    archivePath !== null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || !archivePath) return
    setSubmitting(true)
    const uploadId = start()
    try {
      const res = await window.api.uploadCommunityPlugin(
        {
          name: form.name,
          version: form.version,
          description: form.description,
          category: form.category,
          tags: form.tags
        },
        archivePath,
        iconPath ?? undefined,
        uploadId
      )
      if (res.ok) {
        notify(t('marketplace.uploadSuccess', { name: form.name }), 'success')
        onUploaded()
        onClose()
      } else {
        notify(t('common.errorWithMessage', { error: res.error ?? t('plugin.unknownError') }), 'error')
      }
    } catch (err) {
      notify(t('common.unexpectedError', { error: String(err) }), 'error')
    } finally {
      setSubmitting(false)
      reset()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg max-h-[88vh] overflow-y-auto p-6 animate-slide-up no-drag"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold text-txt-primary">{t('marketplace.uploadPlugin')}</h2>
            <p className="text-xs text-txt-muted mt-1">{t('marketplace.uploadSub')}</p>
          </div>
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

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="form-label">
                {t('common.name')} *
              </label>
              <input
                type="text" placeholder="My Awesome Plugin" value={form.name}
                onChange={(e) => update('name', e.target.value)} className="input-field" maxLength={80}
              />
            </div>
            <div>
              <label className="form-label">
                {t('common.version')} *
              </label>
              <input
                type="text" placeholder="1.0.0" value={form.version}
                onChange={(e) => update('version', e.target.value)} className="input-field" maxLength={20}
              />
            </div>
          </div>

          <div>
            <label className="form-label">
              {t('common.category')}
            </label>
            <select
              value={form.category}
              onChange={(e) => update('category', e.target.value)}
              className="select-field"
            >
              {CATEGORIES.map((c) => <option key={c} value={c} className="bg-app-card">{c}</option>)}
            </select>
          </div>

          <div>
            <label className="form-label">
              {t('common.description')} *
            </label>
            <textarea
              placeholder={t('upload.descriptionPlaceholder')} value={form.description}
              onChange={(e) => update('description', e.target.value)}
              className="input-field resize-none h-24 leading-relaxed" maxLength={500}
            />
            <div className="text-right text-xs text-txt-muted mt-1">{form.description.length}/500</div>
          </div>

          <HashtagInput value={form.tags} onChange={(tags) => update('tags', tags)} disabled={submitting} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">
                {t('marketplace.archive')} *
              </label>
              <FileDropZone
                label={t('marketplace.dragZip')} accept=".zip,.vst3" value={archivePath} onSelect={setArchivePath}
                hint={t('marketplace.zipHint')}
                icon={
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                }
              />
            </div>
            <div>
              <label className="form-label">
                {t('common.icon')}
              </label>
              <FileDropZone
                label={t('common.icon')} accept=".png,.jpg,.jpeg,.webp" value={iconPath} onSelect={setIconPath}
                hint="PNG / JPG, 128×128"
                icon={
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                  </svg>
                }
              />
            </div>
          </div>

          {(submitting || progress) && (
            <UploadSteps step={progress?.step} error={progress?.error} hasIcon={!!iconPath} />
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              className={`btn-primary min-w-32 ${!isValid || submitting ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t('plugin.downloading')}
                </>
              ) : t('common.upload')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Marketplace (community) ────────────────────────────────────────────────
// Пользовательский маркетплейс: любой вошедший юзер загружает свои плагины и
// скачивает чужие. Данные — таблица community_plugins + Supabase Storage.

type LoadState = 'loading' | 'ok' | 'error'

export default function Marketplace() {
  const { t } = useI18n()
  const [plugins, setPlugins]       = useState<CommunityPlugin[]>([])
  const [loadState, setLoadState]   = useState<LoadState>('loading')
  const { query: search, setQuery: setSearch } = useSearch()
  const [category, setCategory]     = useState(ALL_CATEGORY)
  const [progressMap, setProgressMap] = useState<Record<string, InstallProgress>>({})
  // Плагины, по которым клик уже ушёл в handleInstall, но первый install:progress ещё
  // не пришёл — без этого кнопка остаётся активной все 2-3 сетевых round-trip'а до него.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [detailsPlugin, setDetailsPlugin] = useState<Plugin | null>(null)
  const [isOwner, setIsOwner]       = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [toast, setToast]           = useState<{ message: string; type: ToastType } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((message: string, type: ToastType) => {
    setToast({ message, type })
    // Сбрасываем предыдущий таймер — иначе старый toast может скрыть новый раньше времени.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 5000)
  }, [])

  const allCategories = [ALL_CATEGORY, ...Array.from(new Set(plugins.map((p) => p.category))).sort()]

  const fetchPlugins = useCallback(async () => {
    setLoadState('loading')
    try {
      const list = await window.api.listCommunityPlugins()
      setPlugins(list)
      setLoadState('ok')
    } catch {
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    fetchPlugins()
    window.api.auth.getState().then((s) => {
      setIsOwner(!!s.isOwner)
    })
    const unsub = window.api.onInstallProgress((p) => {
      setProgressMap((prev) => ({ ...prev, [p.pluginId]: p }))
      // Реальный прогресс пришёл — синхронный pending больше не нужен.
      setPendingIds((prev) => {
        if (!prev.has(p.pluginId)) return prev
        const next = new Set(prev)
        next.delete(p.pluginId)
        return next
      })
      if (p.step === 'done') {
        setPlugins((prev) =>
          prev.map((pl) => (pl.id === p.pluginId ? { ...pl, installed: true } : pl))
        )
        // Учитываем скачивание (best-effort).
        window.api.bumpCommunityDownload(p.pluginId)
      }
    })
    return unsub
  }, [fetchPlugins])

  const handleInstall = useCallback((plugin: Plugin) => {
    // Блокируем повторные клики сразу, до ответа IPC — иначе за 2-3 сетевых
    // round-trip'а до первого install:progress можно наплодить параллельных установок.
    setPendingIds((prev) => new Set(prev).add(plugin.id))
    const clearPending = () => setPendingIds((prev) => {
      if (!prev.has(plugin.id)) return prev
      const next = new Set(prev)
      next.delete(plugin.id)
      return next
    })
    window.api.installPlugin(plugin.id, 'marketplace').then(clearPending, clearPending)
  }, [])

  const handleDelete = useCallback(async (plugin: Plugin) => {
    const res = await window.api.deleteCommunityPlugin(plugin.id)
    if (res.ok) {
      setPlugins((prev) => prev.filter((p) => p.id !== plugin.id))
      notify(t('marketplace.deleteSuccess', { name: plugin.name }), 'success')
    } else {
      notify(t('marketplace.deleteError', { error: res.error ?? t('plugin.unknownError') }), 'error')
    }
  }, [notify, t])

  const filtered = plugins.filter((p) => {
    const q = search.toLowerCase()
    const matchesSearch =
      p.name.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      (p.tags ?? []).some((tag) => tag.toLowerCase().includes(q))

    return (
      matchesSearch &&
      (category === ALL_CATEGORY || p.category === category)
    )
  })

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 border-b border-app-border/40 px-5 py-3"
        style={{
          backgroundColor: 'rgb(var(--panel) / 0.6)',
          backdropFilter: 'blur(16px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.3)'
        }}
      >
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-txt-primary flex-shrink-0">{t('nav.marketplace')}</h1>

          <div className={`flex items-center gap-1.5 text-2xs ${
            loadState === 'loading' ? 'text-txt-muted' : loadState === 'ok' ? 'text-status-success' : 'text-status-error'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              loadState === 'loading' ? 'bg-txt-muted animate-pulse' :
              loadState === 'ok' ? 'bg-status-success' : 'bg-status-error'
            }`} />
            <span className="hidden sm:inline">
              {loadState === 'loading' ? t('common.loading') : loadState === 'ok' ? t('common.online') : t('common.error')}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={fetchPlugins}
              disabled={loadState === 'loading'}
              title={t('common.refresh')}
              className="p-1.5 rounded-lg text-txt-muted hover:text-txt-secondary no-drag disabled:opacity-30"
              style={{ transition: 'background 150ms, color 120ms' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <IconRefresh spin={loadState === 'loading'} />
            </button>
            <button onClick={() => setShowUpload(true)} className="btn-primary text-xs py-1.5 px-3">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t('common.upload')}
            </button>
          </div>
        </div>

        {plugins.length > 0 && (
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            {allCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`text-2xs px-2.5 py-1 rounded-lg font-medium no-drag ${
                  category === cat ? 'text-white' : 'text-txt-muted border border-app-border/60'
                }`}
                style={
                  category === cat
                    ? { background: 'rgb(var(--ac))', transition: 'background 150ms' }
                    : { transition: 'background 150ms, color 120ms, border-color 150ms' }
                }
                onMouseEnter={(e) => {
                  if (category !== cat) (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)'
                }}
                onMouseLeave={(e) => {
                  if (category !== cat) (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                {cat === ALL_CATEGORY ? t('common.all') : cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-5">
        {loadState === 'loading' ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>

        ) : loadState === 'error' ? (
          <Empty
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>}
            title={t('marketplace.loadError')}
            sub={t('catalog.connectionHint')}
            action={<button onClick={fetchPlugins} className="btn-ghost text-xs py-1.5 px-3">{t('common.retry')}</button>}
          />

        ) : filtered.length === 0 ? (
          <Empty
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M16 16h.01M8 16h.01M3 3h2l2 12h10l2-9H6" /></svg>}
            title={search ? t('catalog.notFound', { query: search }) : t('marketplace.empty')}
            sub={search ? undefined : t('marketplace.emptyHint')}
            action={search
              ? <button onClick={() => setSearch('')} className="text-xs text-accent hover:text-accent-hover no-drag">{t('common.clearSearch')}</button>
              : <button onClick={() => setShowUpload(true)} className="btn-primary text-xs py-1.5 px-3">{t('marketplace.uploadPlugin')}</button>
            }
          />

        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4 animate-fade-in">
            {filtered.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                progress={progressMap[plugin.id] ?? null}
                pending={pendingIds.has(plugin.id)}
                onInstall={handleInstall}
                onDelete={isOwner ? handleDelete : undefined}
                onOpenDetails={setDetailsPlugin}
              />
            ))}
          </div>
        )}
      </div>

      {detailsPlugin && (
        <PluginDetailsModal
          plugin={detailsPlugin}
          progress={progressMap[detailsPlugin.id] ?? null}
          pending={pendingIds.has(detailsPlugin.id)}
          onInstall={handleInstall}
          onDelete={isOwner ? (p) => { handleDelete(p); setDetailsPlugin(null) } : undefined}
          onClose={() => setDetailsPlugin(null)}
        />
      )}

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={fetchPlugins}
          notify={notify}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
