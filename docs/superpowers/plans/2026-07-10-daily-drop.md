# Daily Drop — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на `Home.tsx` появляется первая по порядку секция «Новое сегодня» — фиксированный на календарный день детерминированный сэмпл из 5 элементов всего каталога, одинаковый для всех пользователей, с акцентной рамкой и бейджем «СЕГОДНЯ».

**Architecture:** новая чистая функция `pickDailySample()` (seeded Fisher-Yates на `mulberry32`, засеянный хэшем `dateKey = new Date().toDateString()`) добавляется рядом с существующей `pickSample()` в `Home.tsx`. Секция рендерится по тому же карточному паттерну, что и «Для вдохновения», но обёрнута в блок с акцентной рамкой и бейджем. Данные берутся из уже загруженного `items` в `useLibraryIndex()` — без изменений схемы БД, IPC, `preload.ts` или типов `LibraryItem`/`CommunityPlugin`/`Plugin`.

**Tech Stack:** Electron + Vite + React + TypeScript + Tailwind CSS, без новых зависимостей.

## Global Constraints

- Нет тестового фреймворка в проекте (`package.json` — только `dev`/`build`/`package`/`typecheck`) — верификация каждого шага: `npx tsc --noEmit`, в финале `npm run build`; поведение проверяется вручную по чек-листу из последнего таска.
- Строгое разделение Main/Renderer (CLAUDE.md) — эта фича не затрагивает границу, весь код только в Renderer.
- Отбор для Daily Drop **не зависит от `created_at`** — это детерминированный случайный сэмпл из всего каталога, а не «реально новый контент» (см. спек, раздел «Отбор контента»).
- `dateKey` считается локально на клиенте (`new Date().toDateString()`), без сервера/UTC — сознательное упрощение, дроп меняется в полночь по времени устройства пользователя (см. спек, Ponytail-примечание).
- Каждый шаг завершается реальным `git add` + `git commit`.

## File Structure

```
src/renderer/src/components/Home.tsx   — [MODIFY] pickDailySample(), dailyDrop useMemo, новая секция «Новое сегодня»
src/renderer/src/i18n.tsx              — [MODIFY] ключи home.dailyDrop/dailyDropSub/dailyDropBadge для ru/en
```

---

### Task 1: Локализация — ключи `home.dailyDrop*`

**Files:**
- Modify: `src/renderer/src/i18n.tsx:227-233` (блок ru), `src/renderer/src/i18n.tsx:610-616` (блок en)

**Interfaces:**
- Produces: ключи `home.dailyDrop`, `home.dailyDropSub`, `home.dailyDropBadge` в обоих словарях, читаемые через `t('home.dailyDrop')` и т.д.

**Steps:**

- [ ] **Step 1: Добавить ru-ключи**

В `src/renderer/src/i18n.tsx` сразу перед строкой `'home.forInspiration': 'Для вдохновения',` (строка 227) вставить:

```ts
    'home.dailyDrop': 'Новое сегодня',
    'home.dailyDropSub': 'Свежая подборка дня — обновится завтра',
    'home.dailyDropBadge': 'Сегодня',
```

- [ ] **Step 2: Добавить en-ключи**

В том же файле сразу перед строкой `'home.forInspiration': 'For inspiration',` (строка 610) вставить:

```ts
    'home.dailyDrop': 'New today',
    'home.dailyDropSub': "Today's picks — refreshes tomorrow",
    'home.dailyDropBadge': 'Today',
```

- [ ] **Step 3: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без новых ошибок (i18n-словари — плоские объекты `Record<string, string>`, новые ключи не ломают тип).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n.tsx
git commit -m "i18n: добавить ключи home.dailyDrop* для Daily Drop"
```

---

### Task 2: `pickDailySample()` — детерминированный seeded-шаффл

**Files:**
- Modify: `src/renderer/src/components/Home.tsx:52-59` (сразу после существующей `pickSample()`)

**Interfaces:**
- Consumes: `LibraryItem[]` (из `../hooks/useLibraryIndex`, уже импортирован в файле).
- Produces: `pickDailySample(items: LibraryItem[], count: number, dateKey: string): LibraryItem[]` — используется в Task 3.

**Steps:**

- [ ] **Step 1: Добавить seeded PRNG и хэш-функцию сразу после `pickSample()` (после строки 59)**

```ts
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
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без ошибок — функция пока не используется, но типизирована корректно (unused-var предупреждений быть не должно, т.к. TS по умолчанию не ругается на неиспользуемые top-level функции в этом проекте — если появится ошибка `noUnusedLocals`, это устранится в Task 3, где функция становится используемой).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Home.tsx
git commit -m "feat: детерминированный seeded-шаффл pickDailySample для Daily Drop"
```

---

### Task 3: Секция «Новое сегодня» на Home

**Files:**
- Modify: `src/renderer/src/components/Home.tsx` (внутри компонента `Home`, после блока `useMemo` для `featured` — строки 81-84; и в JSX — новая секция перед существующей «Для вдохновения», строка 134)

**Interfaces:**
- Consumes: `pickDailySample()` из Task 2, `useLibraryIndex()` (`items`), `useI18n()` (`t`), `ItemIcon` (уже определён в файле, строки 35-48), `onNavigate: (tab: Tab) => void` (проп компонента).
- Produces: `dailyDrop: LibraryItem[]` — локальная переменная компонента, используется только в этом же файле.

**Steps:**

- [ ] **Step 1: Добавить `useMemo` для `dailyDrop` сразу после `featured` (после строки 84, до `const trending = ...`)**

```ts
  const dailyDrop = useMemo(
    () => pickDailySample(items, 5, new Date().toDateString()),
    [items]
  )
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 3: Вставить новую секцию в JSX перед секцией «Для вдохновения» (перед строкой 134, комментарий `{/* Для вдохновения */}`)**

```tsx
            {dailyDrop.length > 0 && (
              <section
                className="rounded-2xl border-2 p-4 -m-4"
                style={{ borderColor: 'rgb(var(--ac) / 0.4)' }}
              >
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-txt-primary">{t('home.dailyDrop')}</h2>
                  <span
                    className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase"
                    style={{ color: 'rgb(var(--ac))', background: 'rgb(var(--ac) / 0.14)' }}
                  >
                    {t('home.dailyDropBadge')}
                  </span>
                </div>
                <p className="text-[11px] text-txt-muted mt-1 mb-4">{t('home.dailyDropSub')}</p>
                <div className="flex gap-4 overflow-x-auto pb-2">
                  {dailyDrop.map((item) => (
                    <button
                      key={`daily-${item.tab}-${item.id}`}
                      onClick={() => onNavigate(item.tab)}
                      className="flex-shrink-0 w-36 p-4 flex flex-col gap-2.5 text-left no-drag rounded-2xl
                                 border border-app-border/60 bg-app-card/50
                                 transition-all duration-200 hover:bg-app-border/20 hover:scale-[1.02]"
                    >
                      <div className="relative">
                        <ItemIcon item={item} size="w-full h-24" rounded="rounded-xl" />
                        {item.downloads !== undefined && item.downloads > 0 && (
                          <span
                            className="absolute top-1.5 left-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                            style={{ color: 'rgb(var(--ac))', background: 'rgb(var(--card) / 0.85)', border: '1px solid rgb(var(--ac) / 0.3)' }}
                          >
                            {item.downloads}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-txt-primary truncate">{item.name}</p>
                        <p className="text-[10px] text-txt-muted truncate mt-0.5">{item.category}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

```

Вставляется как первый элемент внутри `<>...</>` фрагмента (строки 133-249), сразу после `<>` и перед `{/* Для вдохновения */}`.

- [ ] **Step 4: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 5: Собрать проект**

Run: `npm run build`
Expected: чистая сборка, без новых warning.

- [ ] **Step 6: Ручная проверка в dev-сборке**

Run: `npm run dev`, зайти на вкладку «Главная».

Чек-лист:
- Секция «Новое сегодня» отображается первой, выше «Для вдохновения», с акцентной рамкой и бейджем «Сегодня».
- До 5 карточек, клик по карточке переключает на соответствующую вкладку (совпадает с `item.tab`).
- Обновление страницы/повторный вход в тот же день — набор карточек не меняется (тот же порядок и состав).
- Если в каталоге меньше 5 элементов — секция показывает сколько есть, без пустых слотов/ошибок.
- Если каталог пуст (`items.length === 0`, например при обрыве сети до `refresh()`) — секция «Новое сегодня» не рендерится вовсе, остальной Home ведёт себя как раньше (индикатор загрузки/`home.empty`).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Home.tsx
git commit -m "feat: секция «Новое сегодня» (Daily Drop) на Home"
```

---

## Итог

После Task 3 фича полностью реализована и проверена: новая первая секция на Home, детерминированная на календарный день, без изменений бэкенда/IPC/схемы БД. Дальше — по декомпозиции Блока 1: следующий цикл брейнсторминга — streak-система (подпроект 2/4).
