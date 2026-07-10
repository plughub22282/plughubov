import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { AssetKind, CommunityPlugin, Plugin, Tab } from '../types'

/** Единая карточка контента для дашборда «Главная» и глобального поиска. */
export interface LibraryItem {
  id: string
  tab: Tab
  name: string
  author: string
  category: string
  iconUrl?: string
  downloads?: number
  likes?: number
  uploaderId?: string
  authorIsPremium?: boolean
  /** Если задан — элемент можно проиграть в глобальном мини-плеере ("В тренде"). */
  previewUrl?: string
  tags?: string[]
}

const AUDIO_EXT_RE = /\.(wav|mp3|flac|ogg|m4a|aac)$/i

// Соответствие AssetKind → вкладка приложения (см. types.ts Tab и App.tsx рендер вкладок).
const ASSET_KIND_TABS: Record<Exclude<AssetKind, 'plugin'>, Tab> = {
  flp: 'flp',
  template: 'templates',
  loop: 'loops',
  drumkit: 'drumkits',
  beat: 'beats',
  preset: 'presets'
}

function fromPlugin(p: Plugin, tab: Tab): LibraryItem {
  return {
    id: p.id,
    tab,
    name: p.name,
    author: p.author,
    category: p.category,
    iconUrl: p.iconUrl,
    authorIsPremium: p.authorIsPremium,
    tags: p.tags
  }
}

/** Превью для трендов: лупы/биты хранят готовый аудиофайл прямо в download_url,
 * пресеты — отдельный «с эффектами» клип. Остальные типы (FLP/тимплейты/драм-киты)
 * не проигрываются напрямую — previewUrl остаётся не задан. */
function previewUrlFor(p: CommunityPlugin, kind: AssetKind): string | undefined {
  if (kind === 'preset') return p.previewWetUrl
  if ((kind === 'loop' || kind === 'beat') && AUDIO_EXT_RE.test(p.downloadUrl.split('?')[0])) {
    return p.downloadUrl
  }
  return undefined
}

function fromCommunity(p: CommunityPlugin, tab: Tab, kind: AssetKind): LibraryItem {
  return {
    ...fromPlugin(p, tab),
    downloads: p.downloads,
    likes: p.likes,
    uploaderId: p.uploaderId,
    previewUrl: previewUrlFor(p, kind)
  }
}

interface LibraryCtx {
  items: LibraryItem[]
  loading: boolean
  loaded: boolean
  refresh: () => Promise<void>
  /** Ленивая загрузка: безопасно вызывать из любого компонента, фетч запустится только один раз. */
  ensureLoaded: () => void
}

const Ctx = createContext<LibraryCtx | null>(null)

/**
 * Общий индекс всего каталога (официальные плагины + community-плагины + все виды
 * ассетов), собираемый один раз за сессию — используется дашбордом «Главная»
 * (тренды/лидерборд/подборка) и глобальным поиском, чтобы не дублировать фетчи.
 */
export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const fetchingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    setLoading(true)
    try {
      const kinds = Object.keys(ASSET_KIND_TABS) as (keyof typeof ASSET_KIND_TABS)[]
      const [plugins, community, ...assetLists] = await Promise.all([
        window.api.listPlugins(),
        window.api.listCommunityPlugins(),
        ...kinds.map((k) => window.api.listAssets(k))
      ])
      const next: LibraryItem[] = [
        ...plugins.map((p) => fromPlugin(p, 'catalog')),
        ...community.map((p) => fromCommunity(p, 'marketplace', 'plugin')),
        ...assetLists.flatMap((list, i) =>
          list.map((p) => fromCommunity(p, ASSET_KIND_TABS[kinds[i]], kinds[i]))
        )
      ]
      setItems(next)
      setLoaded(true)
    } catch {
      // best-effort: Home/поиск при ошибке просто останутся пустыми до повторного refresh()
    } finally {
      setLoading(false)
      fetchingRef.current = false
    }
  }, [])

  const ensureLoaded = useCallback(() => {
    if (!loaded && !fetchingRef.current) void refresh()
  }, [loaded, refresh])

  return (
    <Ctx.Provider value={{ items, loading, loaded, refresh, ensureLoaded }}>
      {children}
    </Ctx.Provider>
  )
}

export function useLibraryIndex(): LibraryCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useLibraryIndex must be used within LibraryProvider')
  return ctx
}
