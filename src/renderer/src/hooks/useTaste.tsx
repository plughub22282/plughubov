import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { TasteCategoryStat, TasteProfile, TasteRecordInput } from '../types'

/**
 * Профиль вкусов пользователя для персональной ленты «Для вас».
 *
 * Тонкая обёртка над window.api.taste (main хранит и агрегирует историю в
 * userData/taste.json). Здесь живёт КЛИЕНТСКАЯ часть алгоритма ленты: из
 * агрегированных по категориям аффинностей строится карта весов, по которой
 * `personalize()` поднимает наверх контент из категорий, что юзер открывает чаще.
 *
 * record() — fire-and-forget: запись истории никогда не блокирует проигрывание или
 * скачивание. После успешной записи профиль перезапрашивается, чтобы лента ожила
 * в той же сессии, без перезапуска.
 */

interface TasteCtx {
  categories: TasteCategoryStat[]
  /** category → score, для быстрой сортировки. */
  rank: Map<string, number>
  /** Категории по убыванию аффинности (топ интересов). */
  topCategories: string[]
  totalEvents: number
  /** Есть ли достаточно сигнала, чтобы показывать персональную ленту. */
  hasSignal: boolean
  record: (input: TasteRecordInput) => void
  /**
   * Отсортировать список по персональной аффинности (по убыванию), стабильно.
   * `getCategory`/`getTags` извлекают поля из произвольного элемента, чтобы хук не
   * зависел от конкретного типа карточки. Возвращает НОВЫЙ массив, вход не мутируется.
   */
  personalize: <T>(
    items: T[],
    getCategory: (item: T) => string | undefined,
    getTags?: (item: T) => string[] | undefined
  ) => T[]
}

const Ctx = createContext<TasteCtx | null>(null)

// Ниже этого числа событий лента слишком «шумная», чтобы что-то предлагать.
const MIN_SIGNAL_EVENTS = 3
// Совпадение по тегу с топовой категорией — более слабый сигнал, чем сама категория.
const TAG_MATCH_WEIGHT = 0.35

const EMPTY: TasteProfile = { categories: [], recent: [], totalEvents: 0 }

function normCat(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function TasteProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [profile, setProfile] = useState<TasteProfile>(EMPTY)

  const load = useCallback(async () => {
    try {
      const next = await window.api.taste.get()
      setProfile(next ?? EMPTY)
    } catch {
      // best-effort: без профиля лента просто откатывается к неперсональной сортировке
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const record = useCallback(
    (input: TasteRecordInput) => {
      if (!input?.category) return // без категории событие для ленты бесполезно
      // Всегда шлём запись — событие терять нельзя. Обработчик в main синхронный, так
      // что параллельные вызовы не гонятся; refresh после — просто оживляет ленту.
      void (async () => {
        try {
          await window.api.taste.record(input)
          await load()
        } catch {
          /* ignore — сбор истории не критичен для проигрывания/скачивания */
        }
      })()
    },
    [load]
  )

  const rank = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of profile.categories) map.set(normCat(c.category), c.score)
    return map
  }, [profile])

  const topCategories = useMemo(
    () => profile.categories.filter((c) => c.score > 0).map((c) => c.category),
    [profile]
  )

  const hasSignal = profile.totalEvents >= MIN_SIGNAL_EVENTS && topCategories.length > 0

  const personalize = useCallback<TasteCtx['personalize']>(
    (items, getCategory, getTags) => {
      // Индекс исходного порядка — стабильный tie-break (равные веса не тасуются).
      const scored = items.map((item, index) => {
        const cat = normCat(getCategory(item))
        let score = cat ? rank.get(cat) ?? 0 : 0
        const tags = getTags?.(item)
        if (tags) {
          for (const tag of tags) {
            const w = rank.get(normCat(tag))
            if (w) score += w * TAG_MATCH_WEIGHT
          }
        }
        return { item, score, index }
      })
      scored.sort((a, b) => b.score - a.score || a.index - b.index)
      return scored.map((s) => s.item)
    },
    [rank]
  )

  const value: TasteCtx = {
    categories: profile.categories,
    rank,
    topCategories,
    totalEvents: profile.totalEvents,
    hasSignal,
    record,
    personalize
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTaste(): TasteCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTaste must be used within TasteProvider')
  return ctx
}
