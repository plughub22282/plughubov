import { useEffect, useState, useCallback } from 'react'
import type { Plugin, InstallProgress, AutoInstallStatus } from '../types'
import { useI18n } from '../i18n'
import { useSearch } from '../hooks/useSearch'
import { useTaste } from '../hooks/useTaste'
import {
  PluginCard, PluginDetailsModal, SkeletonCard, Empty,
  IconRefresh, SearchField
} from './pluginCommon'

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Официальный курируемый каталог плагинов (таблица plugins). Только просмотр и
// установка; пополняют его авторы через вкладку «Публикация».

type LoadState = 'loading' | 'ok' | 'error' | 'fallback'
const ALL_CATEGORY = '__all__'

export default function Catalog() {
  const { t } = useI18n()
  const [plugins, setPlugins]       = useState<Plugin[]>([])
  const [loadState, setLoadState]   = useState<LoadState>('loading')
  const { query: search, setQuery: setSearch } = useSearch()
  const [category, setCategory]     = useState(ALL_CATEGORY)
  const [progressMap, setProgressMap] = useState<Record<string, InstallProgress>>({})
  const [archiveIds, setArchiveIds] = useState<Set<string>>(new Set())
  const [quota, setQuota]           = useState<AutoInstallStatus | null>(null)
  const { record } = useTaste()
  // Плагины, по которым клик уже ушёл в handleInstall, но первый install:progress ещё
  // не пришёл — без этого кнопка остаётся активной все 2-3 сетевых round-trip'а до него.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [detailsPlugin, setDetailsPlugin] = useState<Plugin | null>(null)

  const allCategories = [ALL_CATEGORY, ...Array.from(new Set(plugins.map((p) => p.category))).sort()]

  const fetchPlugins = useCallback(async () => {
    setLoadState('loading')
    try {
      const list = await window.api.listPlugins()
      setPlugins(list)
      setLoadState('ok')
    } catch {
      setLoadState('error')
    }
  }, [])

  const refreshQuota = useCallback(async () => {
    try { setQuota(await window.api.getAutoInstallStatus()) } catch { /* ignore */ }
  }, [])

  const selectCategory = useCallback((cat: string) => {
    setCategory(cat)
    if (cat !== ALL_CATEGORY) {
      record({ type: 'open', category: cat, tab: 'catalog', itemId: cat, name: cat })
    }
  }, [record])

  useEffect(() => {
    fetchPlugins()
    refreshQuota()
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
      }
    })
    return unsub
  }, [fetchPlugins, refreshQuota])

  const handleInstall = useCallback(async (plugin: Plugin) => {
    // Блокируем повторные клики сразу, до ответа IPC — иначе за 2-3 сетевых
    // round-trip'а до первого install:progress можно наплодить параллельных установок.
    setPendingIds((prev) => new Set(prev).add(plugin.id))
    try {
      const res = await window.api.installPlugin(plugin.id, 'catalog')
      // Суточный лимит free исчерпан → показываем кнопку «Скачать архивом».
      if (!res.ok && res.limitReached) {
        setArchiveIds((prev) => new Set(prev).add(plugin.id))
      }
      if (res.ok) {
        record({ type: 'download', category: plugin.category, tab: 'catalog', itemId: plugin.id, name: plugin.name })
      }
    } finally {
      setPendingIds((prev) => {
        if (!prev.has(plugin.id)) return prev
        const next = new Set(prev)
        next.delete(plugin.id)
        return next
      })
      refreshQuota()
    }
  }, [record, refreshQuota])

  const handleArchive = useCallback(async (plugin: Plugin) => {
    const res = await window.api.downloadPluginArchive(plugin.id, 'catalog')
    if (res.ok) {
      record({ type: 'download', category: plugin.category, tab: 'catalog', itemId: plugin.id, name: plugin.name })
    }
  }, [record])

  const filtered = plugins.filter((p) => {
    const q = search.toLowerCase()
    return (
      (p.name.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)) &&
      (category === ALL_CATEGORY || p.category === category)
    )
  })

  const isOnline = loadState === 'ok' || loadState === 'fallback'

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
          <h1 className="text-sm font-semibold text-txt-primary flex-shrink-0">{t('catalog.title')}</h1>

          <div className={`flex items-center gap-1.5 text-2xs ${
            loadState === 'loading' ? 'text-txt-muted' : isOnline ? 'text-status-success' : 'text-status-error'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              loadState === 'loading' ? 'bg-txt-muted animate-pulse' :
              isOnline ? 'bg-status-success' : 'bg-status-error'
            }`} />
            <span className="hidden sm:inline">
              {loadState === 'loading' ? t('common.loading') : isOnline ? t('common.online') : t('common.error')}
            </span>
          </div>

          {plugins.length > 0 && (
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={t('common.search')}
              className='flex-1 min-w-0 max-w-xs'
            />
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Остаток суточных автоустановок (только для free). */}
            {quota && quota.ok && quota.premium === false && !quota.unlimited && (
              <span
                className="text-2xs px-2 py-0.5 rounded-lg font-medium"
                style={{
                  color: 'rgb(var(--ac))',
                  background: 'rgb(var(--ac) / 0.1)',
                  border: '1px solid rgb(var(--ac) / 0.22)'
                }}
                title={t('quota.autoInstallHint')}
              >
                {t('quota.autoInstallLeft', {
                  left: Math.max(0, (quota.limit ?? 5) - (quota.used ?? 0)),
                  limit: quota.limit ?? 5
                })}
              </span>
            )}
            {isOnline && (
              <span className="text-2xs text-txt-muted">{t('common.pluginsCount', { count: filtered.length })}</span>
            )}
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
          </div>
        </div>

        {plugins.length > 0 && (
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            {allCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => selectCategory(cat)}
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
            title={t('catalog.loadError')}
            sub={t('catalog.connectionHint')}
            action={<button onClick={fetchPlugins} className="btn-ghost text-xs py-1.5 px-3">{t('common.retry')}</button>}
          />

        ) : filtered.length === 0 ? (
          <Empty
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>}
            title={search ? t('catalog.notFound', { query: search }) : t('catalog.empty')}
            action={search
              ? <button onClick={() => setSearch('')} className="text-xs text-accent hover:text-accent-hover no-drag">{t('common.clearSearch')}</button>
              : undefined
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
                showArchive={archiveIds.has(plugin.id)}
                onArchive={handleArchive}
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
          showArchive={archiveIds.has(detailsPlugin.id)}
          onArchive={handleArchive}
          onClose={() => setDetailsPlugin(null)}
        />
      )}
    </div>
  )
}
