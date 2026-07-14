/**
 * Самопроверка ядра ленты «Для вас». Запуск (Electron не нужен):
 *   node --experimental-strip-types src/main/tasteScore.selfcheck.ts
 * Падает с ненулевым кодом, если инварианты ранжирования сломаны.
 */
import assert from 'node:assert/strict'
import { applyTasteEvent, decayFactor, emptyStore, rankCategories, HALF_LIFE_MS, WEIGHTS } from './tasteScore.ts'

const DAY = 24 * 60 * 60 * 1000
let t = 1_000_000_000_000 // фиксированный старт (в модуле нет Date.now())

function feed(store: ReturnType<typeof emptyStore>, type: 'open' | 'play' | 'download', category: string, atMs = t) {
  return applyTasteEvent(store, { type, category, itemId: category, name: category }, atMs)
}

// 1. Затухание: ровно один период полураспада уменьшает вклад вдвое; t=0 не трогает.
assert.equal(decayFactor(0), 1)
assert.ok(Math.abs(decayFactor(HALF_LIFE_MS) - 0.5) < 1e-9)

// 2. Веса: скачивание сильнее прослушивания сильнее открытия.
assert.ok(WEIGHTS.download > WEIGHTS.play && WEIGHTS.play > WEIGHTS.open)

// 3. Частота решает при равной свежести: 3 прослушивания Bass > 1 прослушивание Keys.
{
  let s = emptyStore()
  s = feed(s, 'play', 'Bass')
  s = feed(s, 'play', 'Bass')
  s = feed(s, 'play', 'Bass')
  s = feed(s, 'play', 'Keys')
  const ranked = rankCategories(s)
  assert.equal(ranked[0].category, 'Bass')
  assert.equal(ranked[0].plays, 3)
  assert.equal(s.totalEvents, 4)
}

// 4. Тип-вес: одно скачивание (вес 3) перебивает два прослушивания (вес 1+1).
{
  let s = emptyStore()
  s = feed(s, 'play', 'Keys')
  s = feed(s, 'play', 'Keys')
  s = feed(s, 'download', 'Drums')
  const ranked = rankCategories(s)
  assert.equal(ranked[0].category, 'Drums')
}

// 5. Свежесть: давняя, но частая категория тает ниже недавней. Keys набрал 5 очков
//    год назад, Bass — одно недавнее прослушивание; за год Keys затухает почти в ноль.
{
  let s = emptyStore()
  for (let i = 0; i < 5; i++) s = feed(s, 'play', 'Keys', t)
  t += 365 * DAY
  s = feed(s, 'play', 'Bass', t)
  const ranked = rankCategories(s)
  assert.equal(ranked[0].category, 'Bass')
}

// 6. Событие без категории игнорируется (store не растёт).
{
  let s = emptyStore()
  s = applyTasteEvent(s, { type: 'play' }, t)
  assert.equal(s.totalEvents, 0)
  assert.equal(rankCategories(s).length, 0)
}

console.log('tasteScore self-check: OK')
