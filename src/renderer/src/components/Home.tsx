import React, { useEffect, useMemo } from 'react'
import type { Tab } from '../types'
import { useI18n } from '../i18n'
import { useLibraryIndex, type LibraryItem } from '../hooks/useLibraryIndex'
import { usePlayer } from './PlayerBar'
import { catDot } from './pluginCommon'
import { ImageWithFallback } from './ImageWithFallback'

function IconPlaySmall(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function IconDownloadsSmall(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function IconCrown(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M3 19h18l-1.5-9-4.5 4-3-8-3 8-4.5-4L3 19z" />
    </svg>
  )
}

/** Единый плейсхолдер обложки (ImageWithFallback) в размере/скруглении под конкретное место.
 * hoverZoom — лёгкое приближение обложки при наведении на родителя (нужен .group на родителе
 * и overflow-hidden на обёртке, чтобы zoom не вылезал за скруглённые углы). */
function ItemIcon({ item, size = 'w-10 h-10', rounded = 'rounded-xl', hoverZoom = false }: {
  item: LibraryItem
  size?: string
  rounded?: string
  hoverZoom?: boolean
}) {
  return (
    <ImageWithFallback
      src={item.iconUrl}
      alt={item.name}
      seed={item.id}
      className={`${size} ${rounded} object-cover flex-shrink-0 ring-1 ring-white/10${
        hoverZoom ? ' transition-transform duration-200 group-hover:scale-[1.06]' : ''
      }`}
      style={hoverZoom ? { transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' } : undefined}
    />
  )
}

/** Простой детерминированный шаффл-снапшот: пересчитывается только при смене items,
 * а не на каждый ре-рендер (иначе горизонтальная лента дёргалась бы при тиках плеера). */
function pickSample(items: LibraryItem[], count: number): LibraryItem[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/** Как pickSample(), но детерминированный: та же dateKey всегда даёт тот же набор —
 * нужно для «Новое сегодня» (глобальная витрина дня, а не рандом на каждый рендер). */
function pickDailySample(items: LibraryItem[], count: number, dateKey: string): LibraryItem[] {
  const rand = mulberry32(hashString(dateKey))
  // Сортировка по id перед шаффлом — вход детерминирован независимо от порядка,
  // в котором backend вернул строки (created_at не уникален, стабильный order не гарантирован).
  const copy = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}

interface AuthorRank {
  key: string
  author: string
  downloads: number
  count: number
  category: string
}

export default function Home({ onNavigate, genre }: { onNavigate: (tab: Tab) => void; genre: string | null }) {
  const { t } = useI18n()
  const { items, loading, loaded, ensureLoaded } = useLibraryIndex()
  const { playTrack } = usePlayer()

  useEffect(() => {
    ensureLoaded()
  }, [ensureLoaded])

  // Мягкий приоритет по жанру: совпадения по tags идут первыми, ничего не исключаем.
  const genreMatch = (i: LibraryItem) => !!genre && !!i.tags?.some((tag) => tag.toLowerCase() === genre.toLowerCase())

  const featured = useMemo(
    () => [...pickSample(items, 8)].sort((a, b) => Number(genreMatch(b)) - Number(genreMatch(a))),
    [items, genre]
  )

  const dailyDrop = useMemo(
    () => pickDailySample(items, 5, new Date().toDateString()),
    [items]
  )

  const trending = useMemo(
    () =>
      items
        .filter((i) => !!i.previewUrl)
        .sort((a, b) => Number(genreMatch(b)) - Number(genreMatch(a)) || (b.downloads ?? 0) - (a.downloads ?? 0))
        .slice(0, 6),
    [items, genre]
  )

  const topAuthors = useMemo(() => {
    const map = new Map<string, AuthorRank>()
    for (const item of items) {
      if (!item.uploaderId) continue
      const key = item.uploaderId
      const prev = map.get(key)
      if (prev) {
        prev.downloads += item.downloads ?? 0
        prev.count += 1
      } else {
        map.set(key, { key, author: item.author, downloads: item.downloads ?? 0, count: 1, category: item.category })
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, 5)
  }, [items])

  const showEmpty = loaded && !loading && items.length === 0

  return (
    <div className="h-full flex flex-col overflow-hidden select-none">
      <div
        className="flex-shrink-0 border-b border-app-border/40 px-6 py-4"
        style={{ backgroundColor: 'rgb(var(--panel) / 0.6)' }}
      >
        <h1 className="text-xl font-bold tracking-tight text-txt-primary">{t('nav.home')}</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {loading && !loaded ? (
          <div className="flex items-center justify-center h-40 text-xs text-txt-muted">
            <div className="w-4 h-4 mr-2 border-2 border-app-border border-t-accent rounded-full animate-spin" />
            {t('common.loading')}
          </div>
        ) : showEmpty ? (
          <div className="flex items-center justify-center h-40 text-xs text-txt-muted">{t('home.empty')}</div>
        ) : (
          <>
            {dailyDrop.length > 0 && (
              <section>
                <h2 className="text-base font-semibold tracking-tight text-txt-primary">{t('home.dailyDrop')}</h2>
                <p className="text-xs text-txt-muted mt-1 mb-5">{t('home.dailyDropSub')}</p>
                <div className="flex gap-4 overflow-x-auto pb-2">
                  {dailyDrop.map((item) => (
                    <div
                      key={`daily-${item.tab}-${item.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => onNavigate(item.tab)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onNavigate(item.tab)
                        }
                      }}
                      className="group card-interactive card-interactive-no-lift flex-shrink-0 w-40 p-3.5 flex flex-col gap-3 text-left no-drag
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      style={{ outlineColor: 'rgb(var(--ac))' }}
                    >
                      <div className="relative overflow-hidden rounded-xl">
                        <ItemIcon item={item} size="w-full h-28" rounded="rounded-xl" hoverZoom />
                        {item.previewUrl && (
                          <>
                            <div
                              className="absolute inset-0 bg-black/0 group-hover:bg-black/35"
                              style={{ transition: 'background-color 200ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                            />
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                playTrack({ id: `${item.tab}-${item.id}`, title: item.name, author: item.author, iconUrl: item.iconUrl, url: item.previewUrl! })
                              }}
                              title={t('plugin.play')}
                              className="absolute inset-0 flex items-center justify-center opacity-0 translate-y-1
                                         group-hover:opacity-100 group-hover:translate-y-0"
                              style={{ transition: 'opacity 200ms cubic-bezier(0.22, 1, 0.36, 1), transform 200ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                            >
                              <span
                                className="flex h-9 w-9 items-center justify-center rounded-full pl-[1px] text-white shadow-lg"
                                style={{ background: 'rgb(var(--ac))' }}
                              >
                                <IconPlaySmall />
                              </span>
                            </button>
                          </>
                        )}
                        {item.downloads !== undefined && item.downloads > 0 && (
                          <span
                            className="absolute top-1.5 left-1.5 rounded-md px-1.5 py-0.5 text-2xs font-semibold"
                            style={{ color: 'rgb(var(--ac))', background: 'rgb(var(--card) / 0.85)', border: '1px solid rgb(var(--ac) / 0.3)' }}
                          >
                            {item.downloads}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-txt-primary truncate" title={item.name}>{item.name}</p>
                        <p className="text-2xs text-txt-muted truncate mt-0.5">{item.category}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Для вдохновения — плотнее и тише хиро-полки: меньше карточки, плоский стиль без подъёма/свечения */}
            <section className="mt-12">
              <h2 className="text-base font-semibold tracking-tight text-txt-primary">{t('home.forInspiration')}</h2>
              <p className="text-xs text-txt-muted mt-1 mb-4">{t('home.forInspirationSub')}</p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {featured.map((item) => (
                  <div
                    key={`${item.tab}-${item.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onNavigate(item.tab)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onNavigate(item.tab)
                      }
                    }}
                    className="group card track-card flex-shrink-0 w-28 p-2.5 flex flex-col gap-2 text-left no-drag cursor-pointer
                               focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ outlineColor: 'rgb(var(--ac))' }}
                  >
                    <div className="relative overflow-hidden rounded-lg">
                      <ItemIcon item={item} size="w-full h-20" rounded="rounded-lg" hoverZoom />
                      {item.previewUrl && (
                        <>
                          <div
                            className="absolute inset-0 bg-black/0 group-hover:bg-black/35"
                            style={{ transition: 'background-color 200ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              playTrack({ id: `${item.tab}-${item.id}`, title: item.name, author: item.author, iconUrl: item.iconUrl, url: item.previewUrl! })
                            }}
                            title={t('plugin.play')}
                            className="absolute inset-0 flex items-center justify-center opacity-0 translate-y-1
                                       group-hover:opacity-100 group-hover:translate-y-0"
                            style={{ transition: 'opacity 200ms cubic-bezier(0.22, 1, 0.36, 1), transform 200ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                          >
                            <span
                              className="flex h-7 w-7 items-center justify-center rounded-full pl-[1px] text-white shadow-lg"
                              style={{ background: 'rgb(var(--ac))' }}
                            >
                              <IconPlaySmall />
                            </span>
                          </button>
                        </>
                      )}
                      {item.downloads !== undefined && item.downloads > 0 && (
                        <span
                          className="absolute top-1 left-1 rounded px-1 py-0.5 text-2xs font-semibold"
                          style={{ color: 'rgb(var(--ac))', background: 'rgb(var(--card) / 0.85)', border: '1px solid rgb(var(--ac) / 0.3)' }}
                        >
                          {item.downloads}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-txt-primary truncate" title={item.name}>{item.name}</p>
                      <p className="text-2xs text-txt-muted truncate mt-0.5">{item.category}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* В тренде */}
            <section className="mt-8">
              <h2 className="text-base font-semibold tracking-tight text-txt-primary">{t('home.trending')}</h2>
              <p className="text-xs text-txt-muted mt-1 mb-4">{t('home.trendingSub')}</p>
              {trending.length === 0 ? (
                <p className="text-xs text-txt-muted">{t('home.empty')}</p>
              ) : (
                <div className="space-y-2">
                  {trending.map((item) => (
                    <div
                      key={`${item.tab}-${item.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => onNavigate(item.tab)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onNavigate(item.tab)
                        }
                      }}
                      className="group card track-card flex items-center gap-4 px-4 py-2.5 no-drag cursor-pointer
                                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      style={{ outlineColor: 'rgb(var(--ac))' }}
                    >
                      <ItemIcon item={item} size="w-9 h-9" rounded="rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-txt-primary truncate" title={item.name}>{item.name}</p>
                        <p className="text-2xs text-txt-muted truncate mt-0.5">{item.author}</p>
                      </div>
                      {item.downloads !== undefined && (
                        <span className="flex items-center gap-1 text-2xs text-txt-muted group-hover:text-txt-primary transition-colors flex-shrink-0">
                          <IconDownloadsSmall /> {item.downloads}
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!item.previewUrl) return
                          playTrack({ id: `${item.tab}-${item.id}`, title: item.name, author: item.author, iconUrl: item.iconUrl, url: item.previewUrl })
                        }}
                        title={t('plugin.play')}
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full
                                   text-txt-muted group-hover:text-txt-primary hover:bg-app-border/50 transition-colors"
                      >
                        <IconPlaySmall />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Лучшие авторы */}
            <section className="mt-8">
              <h2 className="text-base font-semibold tracking-tight text-txt-primary">{t('home.topAuthors')}</h2>
              <p className="text-xs text-txt-muted mt-1 mb-4">{t('home.topAuthorsSub')}</p>
              {topAuthors.length === 0 ? (
                <p className="text-xs text-txt-muted">{t('home.empty')}</p>
              ) : (
                <div className="space-y-2">
                  {topAuthors.map((author, i) => (
                    <div
                      key={author.key}
                      className="card track-card flex items-center gap-4 px-4 py-2.5"
                    >
                      <span
                        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-2xs font-bold ${
                          i === 0 ? '' : 'text-txt-muted'
                        }`}
                        style={i === 0 ? { color: 'rgb(250 204 21)', background: 'rgb(250 204 21 / 0.14)' } : undefined}
                      >
                        {i === 0 ? <IconCrown /> : `#${i + 1}`}
                      </span>
                      <span
                        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-2xs font-bold text-white"
                        style={{ background: catDot(author.category) }}
                      >
                        {author.author.trim()[0]?.toUpperCase() ?? '?'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-txt-primary truncate" title={author.author}>{author.author}</p>
                        <p className="text-2xs text-txt-muted mt-0.5">{t('home.publicationsCount', { count: author.count })}</p>
                      </div>
                      <span className="flex items-center gap-1 text-2xs font-medium text-txt-secondary flex-shrink-0">
                        <IconDownloadsSmall /> {author.downloads}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
