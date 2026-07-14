/**
 * Чистое ядро профиля вкусов (без Electron/IO) — чтобы алгоритм ранжирования ленты
 * «Для вас» можно было гонять в самопроверке обычным node. taste.ts — тонкая
 * IO-оболочка над этими функциями (load → applyTasteEvent → save, getProfile → rankCategories).
 */

export type TasteEventType = 'open' | 'play' | 'download'

export interface TasteRecordInput {
  type: TasteEventType
  category?: unknown
  tab?: unknown
  itemId?: unknown
  name?: unknown
}

export interface CategoryStat {
  category: string
  score: number
  opens: number
  plays: number
  downloads: number
  lastAt: number
}

export interface TasteEvent {
  type: TasteEventType
  category: string
  tab: string
  itemId: string
  name?: string
  at: number
}

export interface TasteStore {
  version: 1
  /** ms epoch последнего изменения — точка отсчёта общего затухания. */
  updatedAt: number
  totalEvents: number
  categories: Record<string, CategoryStat>
  recent: TasteEvent[]
}

// Вес события: скачивание — сильнейший сигнал намерения, открытие категории — слабейший.
export const WEIGHTS: Record<TasteEventType, number> = { open: 0.75, play: 1, download: 3 }
// Период полураспада аффинности. За 30 дней бездействия вклад категории падает вдвое.
export const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
// Кап истории «недавнее» — чтобы файл не рос бесконечно.
export const RECENT_CAP = 300
// Защита от мусора из renderer.
const MAX_STR = 120

export function emptyStore(): TasteStore {
  return { version: 1, updatedAt: 0, totalEvents: 0, categories: {}, recent: [] }
}

/** Экспоненциальное затухание: доля вклада, дожившая за elapsed мс. */
export function decayFactor(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1
  return Math.pow(0.5, elapsedMs / HALF_LIFE_MS)
}

export function cleanStr(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_STR) : ''
}

function cleanNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function normalizeCategoryStat(category: string, raw: Partial<CategoryStat> | undefined): CategoryStat {
  return {
    category,
    score: cleanNum(raw?.score),
    opens: cleanNum(raw?.opens),
    plays: cleanNum(raw?.plays),
    downloads: cleanNum(raw?.downloads),
    lastAt: cleanNum(raw?.lastAt)
  }
}

function normalizeType(value: unknown): TasteEventType {
  return value === 'download' ? 'download' : value === 'open' ? 'open' : 'play'
}

/**
 * Учесть одно действие пользователя (мутирует и возвращает тот же store).
 * Затухание применяется ко всем категориям относительно прошлого updatedAt, затем к
 * категории события добавляется её вес — так «свежесть» и «частота» объединяются в
 * одном score. Событие без категории игнорируется (для ленты бесполезно).
 */
export function applyTasteEvent(store: TasteStore, input: TasteRecordInput, now: number): TasteStore {
  const type = normalizeType(input.type)
  const category = cleanStr(input.category)
  if (!category) return store

  const factor = store.updatedAt > 0 ? decayFactor(now - store.updatedAt) : 1
  if (factor < 1) {
    for (const key of Object.keys(store.categories)) {
      store.categories[key].score *= factor
    }
  }

  const stat = normalizeCategoryStat(category, store.categories[category])
  stat.score += WEIGHTS[type]
  if (type === 'open') stat.opens += 1
  else if (type === 'play') stat.plays += 1
  else stat.downloads += 1
  stat.lastAt = now
  store.categories[category] = stat

  store.recent.unshift({
    type,
    category,
    tab: cleanStr(input.tab),
    itemId: cleanStr(input.itemId),
    name: cleanStr(input.name) || undefined,
    at: now
  })
  if (store.recent.length > RECENT_CAP) store.recent.length = RECENT_CAP

  store.totalEvents += 1
  store.updatedAt = now
  return store
}

/** Категории по убыванию аффинности (топ ленты — сверху), tie-break по свежести. */
export function rankCategories(store: TasteStore): CategoryStat[] {
  return Object.entries(store.categories)
    .map(([category, stat]) => normalizeCategoryStat(stat.category || category, stat))
    .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt)
}
