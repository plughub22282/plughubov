import { describe, it, expect } from 'vitest'
import {
  applyTasteEvent,
  decayFactor,
  emptyStore,
  rankCategories,
  normalizeCategoryStat,
  cleanStr,
  HALF_LIFE_MS,
  WEIGHTS,
  RECENT_CAP,
  type TasteStore,
  type TasteEventType
} from '../../src/main/tasteScore'

// Чистое ядро ленты «Для вас»: без Electron/IO. Переносит инварианты из
// src/main/tasteScore.selfcheck.ts в обычный Vitest-тест (production-код не меняется).

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_000_000_000_000 // фиксированный старт — в модуле нет Date.now(), поведение детерминировано

function feed(store: TasteStore, type: TasteEventType, category: string, atMs: number): TasteStore {
  return applyTasteEvent(store, { type, category, itemId: category, name: category }, atMs)
}

describe('decayFactor', () => {
  it('нейтрален при нулевом/отрицательном интервале', () => {
    expect(decayFactor(0)).toBe(1)
    expect(decayFactor(-5)).toBe(1)
  })

  it('ровно один период полураспада уменьшает вклад вдвое', () => {
    expect(decayFactor(HALF_LIFE_MS)).toBeCloseTo(0.5, 9)
  })

  it('конечен и в диапазоне (0, 1] на больших интервалах (нет NaN/Infinity)', () => {
    for (const days of [1, 30, 365, 3650]) {
      const f = decayFactor(days * DAY)
      expect(Number.isFinite(f)).toBe(true)
      expect(f).toBeGreaterThan(0)
      expect(f).toBeLessThanOrEqual(1)
    }
  })
})

describe('веса событий', () => {
  it('download > play > open', () => {
    expect(WEIGHTS.download).toBeGreaterThan(WEIGHTS.play)
    expect(WEIGHTS.play).toBeGreaterThan(WEIGHTS.open)
  })
})

describe('applyTasteEvent / rankCategories — известные примеры', () => {
  it('частота решает при равной свежести: 3×Bass выше 1×Keys', () => {
    let s = emptyStore()
    s = feed(s, 'play', 'Bass', T0)
    s = feed(s, 'play', 'Bass', T0)
    s = feed(s, 'play', 'Bass', T0)
    s = feed(s, 'play', 'Keys', T0)
    const ranked = rankCategories(s)
    expect(ranked[0].category).toBe('Bass')
    expect(ranked[0].plays).toBe(3)
    expect(s.totalEvents).toBe(4)
  })

  it('тип-вес: одно скачивание (3) перебивает два прослушивания (1+1)', () => {
    let s = emptyStore()
    s = feed(s, 'play', 'Keys', T0)
    s = feed(s, 'play', 'Keys', T0)
    s = feed(s, 'download', 'Drums', T0)
    expect(rankCategories(s)[0].category).toBe('Drums')
  })

  it('свежесть: давняя частая категория тает ниже недавней редкой', () => {
    let s = emptyStore()
    for (let i = 0; i < 5; i++) s = feed(s, 'play', 'Keys', T0)
    s = feed(s, 'play', 'Bass', T0 + 365 * DAY)
    expect(rankCategories(s)[0].category).toBe('Bass')
  })
})

describe('граничные значения и защита от мусора', () => {
  it('событие без категории игнорируется (store не растёт)', () => {
    let s = emptyStore()
    s = applyTasteEvent(s, { type: 'play' }, T0)
    expect(s.totalEvents).toBe(0)
    expect(rankCategories(s)).toHaveLength(0)
  })

  it('пустой store ранжируется в пустой массив', () => {
    expect(rankCategories(emptyStore())).toEqual([])
  })

  it('history «recent» ограничен RECENT_CAP', () => {
    let s = emptyStore()
    for (let i = 0; i < RECENT_CAP + 50; i++) s = feed(s, 'play', `cat-${i}`, T0 + i)
    expect(s.recent.length).toBe(RECENT_CAP)
  })

  it('cleanStr режет нестроки и длину', () => {
    expect(cleanStr(123)).toBe('')
    expect(cleanStr(null)).toBe('')
    expect(cleanStr('  hi  ')).toBe('hi')
    expect(cleanStr('x'.repeat(500)).length).toBeLessThanOrEqual(120)
  })

  it('normalizeCategoryStat выдаёт конечные числа из мусорного ввода (нет NaN)', () => {
    const bad = { score: NaN, opens: Infinity, plays: 'x', downloads: undefined, lastAt: null }
    // @ts-expect-error — намеренно мусорный ввод: проверяем санитизацию нетипизированных данных
    const stat = normalizeCategoryStat('Bass', bad)
    for (const n of [stat.score, stat.opens, stat.plays, stat.downloads, stat.lastAt]) {
      expect(Number.isFinite(n)).toBe(true)
    }
  })
})

describe('score конечен и повторяем', () => {
  it('после серии событий score всех категорий конечен (нет NaN/Infinity)', () => {
    let s = emptyStore()
    const cats = ['Bass', 'Keys', 'Drums', 'FX']
    for (let i = 0; i < 200; i++) {
      s = feed(s, (['open', 'play', 'download'] as const)[i % 3], cats[i % cats.length], T0 + i * DAY)
    }
    for (const stat of rankCategories(s)) {
      expect(Number.isFinite(stat.score)).toBe(true)
      expect(stat.score).toBeGreaterThanOrEqual(0)
    }
  })

  it('одинаковый вход → одинаковый ранжированный выход (детерминизм)', () => {
    const run = (): string[] => {
      let s = emptyStore()
      s = feed(s, 'download', 'Drums', T0)
      s = feed(s, 'play', 'Bass', T0 + DAY)
      s = feed(s, 'open', 'Keys', T0 + 2 * DAY)
      return rankCategories(s).map((c) => `${c.category}:${c.score.toFixed(6)}`)
    }
    expect(run()).toEqual(run())
  })
})
