# Онбординг новых пользователей — план реализации

**REQUIRED SUB-SKILL:** после подтверждения этого плана пользователем — `superpowers:subagent-driven-development` (по умолчанию) либо `superpowers:executing-plans` (инлайн), в зависимости от выбора пользователя в Execution Handoff.

**Goal:** после первого входа через Discord пользователь проходит одноразовый оверлей ценности + анкету (DAW, жанр), может запустить необязательный coach-marks тур по интерфейсу; жанр используется для мягкой персонализации секций Home. Состояние прохождения хранится в Supabase (`profiles.onboarding_completed`), читается/пишется исключительно через main-процесс по IPC.

**Architecture:** новое состояние живёт как три поля `profiles` (`onboarding_completed`, `onboarding_daw`, `onboarding_genre`), читается вместе с premium в едином `buildState()` в `src/main/auth.ts`, экспонируется как `onboardingCompleted: boolean` в `AuthState` (пять зеркальных мест) и как новый IPC-метод `auth:completeOnboarding`. Renderer получает булев флаг через уже существующий канал `auth:changed`/`auth:getState` — никакой новой подписки не нужно. Два новых компонента (`Onboarding.tsx`, `OnboardingTour.tsx`) монтируются в `App.tsx` условно, по аналогии с уже существующими `PlayerBar`/`PremiumChat` («всегда смонтированы, сами решают, показываться ли»).

**Tech Stack:** Electron + Vite + React + TypeScript + Tailwind CSS, Supabase (Postgres + RLS), без изменений в стеке.

## Global Constraints

- Строгое разделение Main/Renderer (CLAUDE.md): весь доступ к Supabase — только из `src/main/auth.ts`; renderer работает только через `window.api.auth.completeOnboarding`.
- Нет тестового фреймворка в проекте (`package.json` содержит только `dev`/`build`/`package`/`typecheck`) — верификация каждого шага: `npx tsc --noEmit` (быстрая проверка типов) и в финале `npm run build`; UI-поведение проверяется вручную по чек-листу из шага 9.
- **AuthState — 5 зеркальных мест.** Любое изменение формы `AuthState` требует правки во ВСЕХ пяти файлах одновременно, иначе либо не соберётся TypeScript, либо типы разойдутся молча:
  1. `src/main/auth.ts` — интерфейс `AuthState` + константа `SIGNED_OUT`
  2. `src/preload/index.ts` — интерфейс `AuthState` (мирор)
  3. `src/renderer/src/types.ts` — интерфейс `AuthState` (мирор)
  4. `src/renderer/src/hooks/useAuth.ts` — константа `SIGNED_OUT` (свой локальный дубликат)
  5. `src/renderer/src/App.tsx` — глобальный блок `declare global { interface Window { api: {...} } }` (строки 632-726), где `auth` — независимое пятое дублирование той же формы
- `buildState()` в `src/main/auth.ts` (строки 220-233) содержит ранний `return` для premium-пользователей ДО похода в БД (строка 228: `if (base.premium) return base`). Это должно быть исправлено — `onboarding_completed`/`onboarding_daw`/`onboarding_genre` нужны для ВСЕХ вошедших пользователей, включая premium/author/owner, поэтому поход в БД за профилем должен стать безусловным.
- `LibraryItem` (в `src/renderer/src/hooks/useLibraryIndex.tsx`) не имеет поля `tags`, хотя `Plugin`/`CommunityPlugin` его имеют — это должно быть исправлено первым же шагом персонализации Home, иначе жанр-фильтр физически не на чем построить.
- Три новые колонки `profiles` не защищены триггером `prevent_role_change` (защищает только `role`/`premium`/`premium_until`/`referred_by`/`referral_rewards_granted`/`referral_code`, см. `supabase/schema.sql:130-137`) — значит `completeOnboarding` может писать напрямую через `supabase.from('profiles').update(...)`, без RPC/SECURITY DEFINER обхода.
- Каждый шаг завершается реальным `git add` + `git commit` (репозиторий уже инициализирован, текущая ветка `master`, HEAD на `ae31973`).

## File Structure

```
supabase/schema.sql                                  — [MODIFY] идемпотентная миграция 3 колонок profiles
src/main/auth.ts                                     — [MODIFY] AuthState+SIGNED_OUT, buildState fix, fetchDbProfileExtras, completeOnboarding, IPC
src/preload/index.ts                                 — [MODIFY] AuthState mirror + completeOnboarding wrapper
src/renderer/src/types.ts                             — [MODIFY] AuthState mirror
src/renderer/src/hooks/useAuth.ts                     — [MODIFY] SIGNED_OUT mirror
src/renderer/src/App.tsx                              — [MODIFY] window.api type mirror, data-tour атрибуты, showTour state, монтирование Onboarding/OnboardingTour, genre → Home
src/renderer/src/hooks/useLibraryIndex.tsx             — [MODIFY] добавить поле tags в LibraryItem + заполнение в fromPlugin
src/renderer/src/components/Home.tsx                  — [MODIFY] проп genre + soft-фильтр featured/trending
src/renderer/src/i18n.tsx                              — [MODIFY] ключи onboarding.* для ru/en
src/renderer/src/components/Onboarding.tsx             — [CREATE] компонент-автомат value→daw→genre→done
src/renderer/src/components/OnboardingTour.tsx         — [CREATE] coach-marks тур с 4 точками подсветки
```

---

### Task 1: Supabase-миграция полей онбординга

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: колонки `public.profiles.onboarding_completed boolean not null default false`, `public.profiles.onboarding_daw text`, `public.profiles.onboarding_genre text`.

**Steps:**

1. Открыть `supabase/schema.sql`, найти блок миграции премиума (строки 39-40: `alter table public.profiles add column if not exists premium_until timestamptz;`) и сразу после блока референс-полей (после строки 60, перед `create unique index if not exists profiles_referral_code_uidx` на строке 62) — вставить новый идемпотентный блок:

```sql
-- ─── Онбординг новых пользователей ───────────────────────────────────────────
-- default false намеренно распространяется и на существующих пользователей —
-- они один раз увидят онбординг при следующем входе (см. docs/superpowers/specs/2026-07-09-onboarding-design.md).
-- Обычные пользовательские настройки, НЕ защищены prevent_role_change — пишутся
-- напрямую через profiles_update_own (см. completeOnboarding в src/main/auth.ts).
alter table public.profiles
  add column if not exists onboarding_completed boolean not null default false;
alter table public.profiles
  add column if not exists onboarding_daw text;
alter table public.profiles
  add column if not exists onboarding_genre text;
```

2. Проверить: `grep -n "onboarding_" supabase/schema.sql` — должно вернуть 3 строки добавления колонки плюс строки комментария.
3. Применить миграцию к Supabase (через SQL Editor проекта, вручную пользователем — main-агент не имеет доступа к продовому Supabase). Отметить в описании коммита, что миграция также должна быть применена вручную.
4. `git add supabase/schema.sql && git commit -m "Add onboarding columns to profiles (schema migration)"`.

---

### Task 2: `src/main/auth.ts` — AuthState, buildState fix, completeOnboarding, IPC

**Files:**
- Modify: `src/main/auth.ts`

**Interfaces:**
- Consumes: `supabase.from('profiles').select(...)`, `supabase.from('profiles').update(...)` (существующий клиент из `./supabase`).
- Produces:
  - `AuthState.onboardingCompleted: boolean`
  - `AuthState.onboardingDaw: string | null`
  - `AuthState.onboardingGenre: string | null`
  - `completeOnboarding(daw: string | null, genre: string | null): Promise<AuthResult>` (внутренняя функция, экспонируется только через IPC-канал `auth:completeOnboarding`)

**Steps:**

1. Расширить `AuthState` (строки 92-102):

```ts
export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  role: UserRole | null
  /** Премиум-подписка активна прямо сейчас (allow-list ИЛИ действующий premium_until). */
  premium: boolean
  /** Срок действия премиума (ISO). null — бессрочный allow-list или премиума нет. */
  premiumUntil: string | null
  /** Владелец приложения: доступна вкладка «Ключи» (генерация премиум-кодов). */
  isOwner: boolean
  /** Онбординг (оверлей ценности + анкета DAW/жанр) пройден. */
  onboardingCompleted: boolean
  /** Ответ на вопрос про DAW из онбординга. null — не задан/пропущен. */
  onboardingDaw: string | null
  /** Ответ на вопрос про жанр из онбординга. null — не задан/пропущен. */
  onboardingGenre: string | null
}
```

2. Обновить `SIGNED_OUT` (строки 110-112):

```ts
const SIGNED_OUT: AuthState = {
  status: 'signedOut', user: null, role: null, premium: false, premiumUntil: null, isOwner: false,
  onboardingCompleted: false, onboardingDaw: null, onboardingGenre: null
}
```

3. Проверка: `npx tsc --noEmit` — TypeScript сейчас укажет на недостающие поля в четырёх других местах (preload, types.ts, useAuth.ts, App.tsx) — это ожидаемо, они правятся в Task 3-4. Убедиться, что ошибки локализованы именно в этих файлах, а не где-то ещё.

4. Заменить `fetchDbPremiumUntil` (строки 198-214) на комбинированный запрос, читающий и премиум, и онбординг за один SELECT:

```ts
interface DbProfileExtras {
  premiumUntil: string | null
  onboardingCompleted: boolean
  onboardingDaw: string | null
  onboardingGenre: string | null
}

const DEFAULT_PROFILE_EXTRAS: DbProfileExtras = {
  premiumUntil: null,
  // Если не пришло вовремя (гонка с handle_new_user) — трактуем как false: лучше
  // лишний раз показать онбординг, чем никогда.
  onboardingCompleted: false,
  onboardingDaw: null,
  onboardingGenre: null
}

/**
 * Прочитать премиум/онбординг-поля профиля одним запросом. Best-effort — при ошибке
 * возвращает безопасные дефолты (см. DEFAULT_PROFILE_EXTRAS).
 */
async function fetchDbProfileExtras(userId: string): Promise<DbProfileExtras> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('premium_until, onboarding_completed, onboarding_daw, onboarding_genre')
      .eq('id', userId)
      .maybeSingle()
    if (error || !data) return DEFAULT_PROFILE_EXTRAS
    const row = data as {
      premium_until?: string | null
      onboarding_completed?: boolean | null
      onboarding_daw?: string | null
      onboarding_genre?: string | null
    }
    return {
      premiumUntil: row.premium_until ?? null,
      onboardingCompleted: row.onboarding_completed ?? false,
      onboardingDaw: row.onboarding_daw ?? null,
      onboardingGenre: row.onboarding_genre ?? null
    }
  } catch {
    return DEFAULT_PROFILE_EXTRAS
  }
}
```

5. Переписать `buildState()` (строки 216-233) — убрать ранний `return base` для premium, всегда ходить в БД за `fetchDbProfileExtras`:

```ts
/**
 * Полное состояние авторизации: базовое + данные из БД (срок премиума, онбординг).
 * В БД ходим всегда — даже для allow-list премиума (автор/владелец), т.к. онбординг
 * должен быть прочитан для ЛЮБОГО вошедшего пользователя, а не только для не-премиум.
 */
async function buildState(session: Session | null): Promise<AuthState> {
  const base = buildBaseState(session)
  if (base.status !== 'signedIn' || !base.user) return base

  // Регистрируем отпечаток устройства при каждом входе/восстановлении сессии
  // (best-effort, один раз на пользователя за запуск) — нужен для анти-абуза рефералов.
  void registerDeviceBestEffort()

  const extras = await fetchDbProfileExtras(base.user.id)

  // allow-list премиум (автор/владелец) — бессрочный, срок из БД не нужен и не переопределяет его.
  if (base.premium) {
    return {
      ...base,
      onboardingCompleted: extras.onboardingCompleted,
      onboardingDaw: extras.onboardingDaw,
      onboardingGenre: extras.onboardingGenre
    }
  }

  const active = extras.premiumUntil != null && new Date(extras.premiumUntil).getTime() > Date.now()
  return {
    ...base,
    premium: active,
    premiumUntil: active ? extras.premiumUntil : null,
    onboardingCompleted: extras.onboardingCompleted,
    onboardingDaw: extras.onboardingDaw,
    onboardingGenre: extras.onboardingGenre
  }
}
```

6. Проверка: `npx tsc --noEmit 2>&1 | grep "auth.ts"` — не должно быть ошибок именно в `auth.ts` (ошибки в других 4 файлах пока ожидаемы, чинятся в след. задачах).

7. Добавить `completeOnboarding` сразу после `redeemPremium` (после строки 294, перед блоком `// Состояние текущей OAuth-попытки`):

```ts
/**
 * Завершить онбординг: пометить onboarding_completed = true и сохранить DAW/жанр,
 * если они были заданы (null — пропущено, соответствующее поле не трогаем).
 * Поля НЕ защищены prevent_role_change — обычный update через profiles_update_own.
 */
async function completeOnboarding(daw: string | null, genre: string | null): Promise<AuthResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session?.user) return { ok: false, error: 'Войдите, чтобы продолжить.' }

  try {
    const patch: Record<string, unknown> = { onboarding_completed: true }
    if (daw != null) patch.onboarding_daw = daw
    if (genre != null) patch.onboarding_genre = genre

    const { error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', sess.session.user.id)
    if (error) return { ok: false, error: humanizeError(error, 'Не удалось сохранить онбординг.') }

    const state = await buildState(sess.session)
    broadcast(state)
    return { ok: true, state }
  } catch (e) {
    return { ok: false, error: humanizeError(e as Error, 'Не удалось сохранить онбординг.') }
  }
}
```

8. Зарегистрировать IPC-канал в `registerAuthIpc()`, сразу после блока `auth:redeemPremium` (после строки 510, перед комментарием `// Любое изменение сессии`):

```ts
  ipcMain.handle('auth:completeOnboarding', (event, daw: string | null, genre: string | null) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return completeOnboarding(daw, genre)
  })
```

9. Проверка: `npx tsc --noEmit 2>&1 | grep "src/main/auth.ts"` — пусто (файл сам по себе типобезопасен; оставшиеся глобальные ошибки — в других файлах).
10. `git add src/main/auth.ts && git commit -m "auth: add onboardingCompleted/Daw/Genre to AuthState, fix buildState premium early-return, add completeOnboarding IPC"`.

---

### Task 3: `src/preload/index.ts` — зеркало AuthState + completeOnboarding

**Files:**
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `ipcRenderer.invoke('auth:completeOnboarding', daw, genre)`.
- Produces: `window.api.auth.completeOnboarding(daw: string | null, genre: string | null): Promise<AuthResult>`.

**Steps:**

1. Расширить интерфейс `AuthState` (строки 145-155):

```ts
export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  role: UserRole | null
  /** Премиум-подписка активна прямо сейчас. */
  premium: boolean
  /** Срок действия премиума (ISO). null — бессрочный allow-list или премиума нет. */
  premiumUntil: string | null
  /** Владелец приложения: доступна вкладка «Ключи». */
  isOwner: boolean
  /** Онбординг (оверлей ценности + анкета DAW/жанр) пройден. */
  onboardingCompleted: boolean
  /** Ответ на вопрос про DAW из онбординга. null — не задан/пропущен. */
  onboardingDaw: string | null
  /** Ответ на вопрос про жанр из онбординга. null — не задан/пропущен. */
  onboardingGenre: string | null
}
```

2. Добавить метод `completeOnboarding` в объект `auth` (после строки 279, `redeemPremium`, перед `onChange`):

```ts
    // Завершить онбординг: сохраняет DAW/жанр (null — пропущено) и ставит onboarding_completed = true.
    completeOnboarding: (daw: string | null, genre: string | null): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:completeOnboarding', daw, genre),
```

3. Проверка: `npx tsc --noEmit 2>&1 | grep "src/preload/index.ts"` — пусто.
4. `git add src/preload/index.ts && git commit -m "preload: mirror onboarding fields in AuthState, expose completeOnboarding"`.

---

### Task 4: `src/renderer/src/types.ts` + `useAuth.ts` + `App.tsx` window.api — держим все зеркала AuthState в синхроне

**Files:**
- Modify: `src/renderer/src/types.ts`
- Modify: `src/renderer/src/hooks/useAuth.ts`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Produces: `AuthState.onboardingCompleted/onboardingDaw/onboardingGenre` (третье зеркало), `SIGNED_OUT` (четвёртое зеркало) с новыми полями, `window.api.auth.completeOnboarding` в глобальном типе (пятое зеркало).

**Steps:**

1. В `src/renderer/src/types.ts` расширить `AuthState` (строки 257-267) — идентично Task 2 шагу 1 / Task 3 шагу 1:

```ts
export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  role: UserRole | null
  /** Премиум-подписка активна прямо сейчас. */
  premium: boolean
  /** Срок действия премиума (ISO). null — бессрочный allow-list или премиума нет. */
  premiumUntil: string | null
  /** Владелец приложения: доступна вкладка «Ключи» (генерация премиум-кодов). */
  isOwner: boolean
  /** Онбординг (оверлей ценности + анкета DAW/жанр) пройден. */
  onboardingCompleted: boolean
  /** Ответ на вопрос про DAW из онбординга. null — не задан/пропущен. */
  onboardingDaw: string | null
  /** Ответ на вопрос про жанр из онбординга. null — не задан/пропущен. */
  onboardingGenre: string | null
}
```

2. В `src/renderer/src/hooks/useAuth.ts` обновить `SIGNED_OUT` (строки 16-18):

```ts
const SIGNED_OUT: AuthState = {
  status: 'signedOut', user: null, role: null, premium: false, premiumUntil: null, isOwner: false,
  onboardingCompleted: false, onboardingDaw: null, onboardingGenre: null
}
```

3. В `src/renderer/src/App.tsx` расширить блок `auth` внутри `declare global { interface Window { api: {...` (строки 638-645):

```ts
      auth: {
        getState: () => Promise<import('./types').AuthState>
        signInWithDiscord: () => Promise<import('./types').AuthResult>
        cancelDiscord: () => Promise<import('./types').AuthResult>
        signOut: () => Promise<import('./types').AuthResult>
        redeemPremium: (code: string) => Promise<import('./types').AuthResult>
        completeOnboarding: (daw: string | null, genre: string | null) => Promise<import('./types').AuthResult>
        onChange: (cb: (state: import('./types').AuthState) => void) => () => void
      }
```

4. Проверка: `npx tsc --noEmit` — должен пройти полностью чисто (все 5 зеркал теперь синхронны).
5. `git add src/renderer/src/types.ts src/renderer/src/hooks/useAuth.ts src/renderer/src/App.tsx && git commit -m "renderer: mirror onboarding fields in AuthState (types.ts, useAuth SIGNED_OUT, App.tsx window.api)"`.

---

### Task 5: `src/renderer/src/i18n.tsx` — ключи `onboarding.*`

**Files:**
- Modify: `src/renderer/src/i18n.tsx`

**Interfaces:**
- Produces: ключи `onboarding.*` в `dictionaries.ru` и `dictionaries.en`, используемые `Onboarding.tsx`/`OnboardingTour.tsx` через `t('onboarding.xxx')`.

**Steps:**

1. В `ru`-словаре, непосредственно перед строкой 356 (`'recommend.error': 'Не удалось получить рекомендации'`), добавить запятую после неё и вставить новый блок (т.е. правится строка 356 → 357):

```ts
    'recommend.error': 'Не удалось получить рекомендации',
    'onboarding.value.title': 'Добро пожаловать в PlugHub',
    'onboarding.value.point1': 'Каталог официальных VST3-плагинов с автоустановкой в один клик',
    'onboarding.value.point2': 'Маркетплейс сообщества: биты, пресеты, лупы, тимплейты и FLP-проекты',
    'onboarding.value.point3': 'Реферальная программа и премиум-доступ без лимитов',
    'onboarding.value.next': 'Далее',
    'onboarding.daw.question': 'Какую DAW ты используешь?',
    'onboarding.daw.option.flstudio': 'FL Studio',
    'onboarding.daw.option.ableton': 'Ableton',
    'onboarding.daw.option.logicpro': 'Logic Pro',
    'onboarding.daw.option.flstudiomobile': 'FL Studio Mobile',
    'onboarding.daw.option.other': 'Другое',
    'onboarding.genre.question': 'Какой жанр тебе ближе?',
    'onboarding.genre.option.trap': 'Trap',
    'onboarding.genre.option.house': 'House',
    'onboarding.genre.option.lofi': 'Lo-fi',
    'onboarding.genre.option.drill': 'Drill',
    'onboarding.genre.option.pop': 'Pop',
    'onboarding.genre.option.other': 'Другое',
    'onboarding.done.title': 'Готово!',
    'onboarding.done.subtitle': 'Показать быстрый тур по интерфейсу?',
    'onboarding.done.startTour': 'Показать тур',
    'onboarding.done.start': 'Начать пользоваться',
    'onboarding.skip': 'Пропустить',
    'onboarding.tour.sidebarSections': 'Здесь собраны все разделы: плагины, звуковые ресурсы и профиль',
    'onboarding.tour.search': 'Глобальный поиск по каталогу и маркетплейсу',
    'onboarding.tour.player': 'Мини-плеер — прослушивай превью прямо в приложении',
    'onboarding.tour.premiumCta': 'Премиум снимает лимиты автоустановки и открывает облачную студию',
    'onboarding.tour.next': 'Далее',
    'onboarding.tour.skip': 'Пропустить тур',
    'onboarding.tour.finish': 'Готово',
    'onboarding.error.saveFailed': 'Не удалось сохранить. Проверьте соединение.',
    'onboarding.error.retry': 'Повторить'
```

2. В `en`-словаре, непосредственно перед закрывающей `}` словаря `en` (строка 707, `'recommend.error': 'Could not get recommendations'`), аналогично добавить запятую и блок:

```ts
    'recommend.error': 'Could not get recommendations',
    'onboarding.value.title': 'Welcome to PlugHub',
    'onboarding.value.point1': 'A catalog of official VST3 plugins with one-click auto-install',
    'onboarding.value.point2': 'Community marketplace: beats, presets, loops, templates and FLP projects',
    'onboarding.value.point3': 'Referral program and unlimited premium access',
    'onboarding.value.next': 'Next',
    'onboarding.daw.question': 'Which DAW do you use?',
    'onboarding.daw.option.flstudio': 'FL Studio',
    'onboarding.daw.option.ableton': 'Ableton',
    'onboarding.daw.option.logicpro': 'Logic Pro',
    'onboarding.daw.option.flstudiomobile': 'FL Studio Mobile',
    'onboarding.daw.option.other': 'Other',
    'onboarding.genre.question': 'Which genre is closest to you?',
    'onboarding.genre.option.trap': 'Trap',
    'onboarding.genre.option.house': 'House',
    'onboarding.genre.option.lofi': 'Lo-fi',
    'onboarding.genre.option.drill': 'Drill',
    'onboarding.genre.option.pop': 'Pop',
    'onboarding.genre.option.other': 'Other',
    'onboarding.done.title': 'All set!',
    'onboarding.done.subtitle': 'Want a quick tour of the interface?',
    'onboarding.done.startTour': 'Show tour',
    'onboarding.done.start': 'Start using PlugHub',
    'onboarding.skip': 'Skip',
    'onboarding.tour.sidebarSections': 'All sections live here: plugins, sound assets, and your account',
    'onboarding.tour.search': 'Global search across the catalog and marketplace',
    'onboarding.tour.player': 'Mini player — preview tracks right inside the app',
    'onboarding.tour.premiumCta': 'Premium removes install limits and unlocks the cloud studio',
    'onboarding.tour.next': 'Next',
    'onboarding.tour.skip': 'Skip tour',
    'onboarding.tour.finish': 'Done',
    'onboarding.error.saveFailed': 'Could not save. Check your connection.',
    'onboarding.error.retry': 'Retry'
```

3. Проверка: `npx tsc --noEmit` — чисто. Дополнительно `grep -c "'onboarding\." src/renderer/src/i18n.tsx` — должно вернуть 60 (30 ключей × 2 языка).
4. `git add src/renderer/src/i18n.tsx && git commit -m "i18n: add onboarding.* keys for ru/en"`.

---

### Task 6: `useLibraryIndex.tsx` — добавить `tags` в `LibraryItem`

**Files:**
- Modify: `src/renderer/src/hooks/useLibraryIndex.tsx`

**Interfaces:**
- Produces: `LibraryItem.tags?: string[]`, заполняется в `fromPlugin()` (и наследуется `fromCommunity()` через spread).

**Steps:**

1. Добавить поле в интерфейс `LibraryItem` (строки 5-18), сразу после `previewUrl?: string` (строка 17):

```ts
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
  /** Теги плагина/ассета — используются для мягкой персонализации Home по жанру. */
  tags?: string[]
}
```

2. Заполнить поле в `fromPlugin()` (строки 32-42):

```ts
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
```

3. Проверка: `fromCommunity()` (строки 55-63) уже спредит `...fromPlugin(p, tab)`, поэтому `tags` автоматически проставится и там — изменений в `fromCommunity` не требуется. Подтвердить: `grep -n "fromCommunity" src/renderer/src/hooks/useLibraryIndex.tsx`.
4. `npx tsc --noEmit` — чисто.
5. `git add src/renderer/src/hooks/useLibraryIndex.tsx && git commit -m "useLibraryIndex: expose tags on LibraryItem for genre-based Home filtering"`.

---

### Task 7: `Home.tsx` — жанровый soft-фильтр «Для вдохновения» и «В тренде»

**Files:**
- Modify: `src/renderer/src/components/Home.tsx`

**Interfaces:**
- Consumes: новый проп `genre: string | null` (передаётся из `App.tsx` в Task 9), `LibraryItem.tags` (из Task 6).
- Produces: soft-отсортированные `featured`/`trending` — совпадения по жанру идут первыми, при нехватке добираются остальными элементами (секция никогда не пустеет из-за фильтра).

**Steps:**

1. Обновить сигнатуру `Home` (строка 69):

```ts
export default function Home({ onNavigate, genre }: { onNavigate: (tab: Tab) => void; genre: string | null }) {
```

2. Добавить хелпер сортировки-по-жанру сразу после `pickSample` (после строки 59, перед `interface AuthorRank`):

```ts
/** Мягкий приоритет по жанру: совпадения по tags идут первыми, остальное — следом,
 * без исключения из списка (секция никогда не станет пустой из-за фильтра). */
function sortByGenrePriority<T extends LibraryItem>(items: T[], genre: string | null): T[] {
  if (!genre) return items
  const matches: T[] = []
  const rest: T[] = []
  for (const item of items) {
    if (item.tags?.some((tag) => tag.toLowerCase() === genre.toLowerCase())) matches.push(item)
    else rest.push(item)
  }
  return [...matches, ...rest]
}
```

3. Применить сортировку в `featured` (строка 78):

```ts
  const featured = useMemo(() => sortByGenrePriority(pickSample(items, 8), genre), [items, genre])
```

4. Применить сортировку в `trending` (строки 80-87):

```ts
  const trending = useMemo(
    () =>
      sortByGenrePriority(
        items
          .filter((i) => !!i.previewUrl)
          .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
          .slice(0, 6),
        genre
      ),
    [items, genre]
  )
```

5. Проверка: `npx tsc --noEmit` — чисто (в частности, проверить, что вызов `<Home onNavigate={setTab} />` в `App.tsx:598` теперь требует правки — это будет сделано в Task 9, здесь ошибка ожидаема и временна).
6. `git add src/renderer/src/components/Home.tsx && git commit -m "Home: soft genre-priority sort for featured/trending sections"`.

---

### Task 8: `Onboarding.tsx` — компонент-автомат

**Files:**
- Create: `src/renderer/src/components/Onboarding.tsx`

**Interfaces:**
- Consumes: `window.api.auth.completeOnboarding(daw: string | null, genre: string | null): Promise<AuthResult>` (Task 3), `useI18n().t` (существующий), Tailwind-классы `.card`/`.btn-primary`/`.btn-ghost`/`.animate-slide-up`/`.animate-fade-in` (существующие, `index.css:426-494,739-741`).
- Produces: `<Onboarding onDone={(daw: string | null, genre: string | null) => void} onStartTour={() => void} />`.

**Steps:**

1. Создать файл со следующим содержимым:

```tsx
import React, { useState } from 'react'
import { useI18n } from '../i18n'

type Step = 'value' | 'daw' | 'genre' | 'done'

const DAW_OPTIONS = [
  { key: 'flstudio', labelKey: 'onboarding.daw.option.flstudio' },
  { key: 'ableton', labelKey: 'onboarding.daw.option.ableton' },
  { key: 'logicpro', labelKey: 'onboarding.daw.option.logicpro' },
  { key: 'flstudiomobile', labelKey: 'onboarding.daw.option.flstudiomobile' },
  { key: 'other', labelKey: 'onboarding.daw.option.other' }
] as const

const GENRE_OPTIONS = [
  { key: 'trap', labelKey: 'onboarding.genre.option.trap' },
  { key: 'house', labelKey: 'onboarding.genre.option.house' },
  { key: 'lofi', labelKey: 'onboarding.genre.option.lofi' },
  { key: 'drill', labelKey: 'onboarding.genre.option.drill' },
  { key: 'pop', labelKey: 'onboarding.genre.option.pop' },
  { key: 'other', labelKey: 'onboarding.genre.option.other' }
] as const

function IconCheck(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ProgressDots({ step }: { step: Step }): React.ReactElement {
  const order: Step[] = ['value', 'daw', 'genre']
  const activeIndex = step === 'done' ? order.length : order.indexOf(step)
  return (
    <div className="flex items-center gap-1.5">
      {order.map((_, i) => (
        <span
          key={i}
          className="h-1.5 rounded-full transition-all duration-200"
          style={{
            width: i === activeIndex ? '18px' : '6px',
            background: i <= activeIndex ? 'rgb(var(--ac))' : 'rgb(var(--bdr))'
          }}
        />
      ))}
    </div>
  )
}

function ChipGrid({
  options,
  onSelect
}: {
  options: ReadonlyArray<{ key: string; labelKey: string }>
  onSelect: (key: string) => void
}): React.ReactElement {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onSelect(opt.key)}
          className="rounded-xl border border-app-border/60 bg-app-card/50 px-3 py-2.5 text-sm font-medium
                     text-txt-primary text-left no-drag transition-all duration-150
                     hover:bg-app-border/20 hover:border-accent/45 active:scale-[0.97]"
        >
          {t(opt.labelKey)}
        </button>
      ))}
    </div>
  )
}

export default function Onboarding({
  onDone,
  onStartTour
}: {
  onDone: (daw: string | null, genre: string | null) => void
  onStartTour: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('value')
  const [daw, setDaw] = useState<string | null>(null)
  const [genre, setGenre] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const persist = async (finalDaw: string | null, finalGenre: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.auth.completeOnboarding(finalDaw, finalGenre)
      if (!result.ok) {
        setError(result.error ?? t('onboarding.error.saveFailed'))
        return
      }
      setStep('done')
    } finally {
      setBusy(false)
    }
  }

  const handleDawSelect = (key: string) => {
    setDaw(key)
    setStep('genre')
  }

  const handleGenreSelect = (key: string) => {
    setGenre(key)
    void persist(daw, key)
  }

  const handleSkipDaw = () => setStep('genre')
  const handleSkipGenre = () => void persist(daw, null)

  const retry = () => void persist(daw, genre)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6 backdrop-blur-sm bg-black/50">
      <div className="w-full max-w-[360px] animate-slide-up">
        <div className="card p-6 relative overflow-hidden">
          <div
            className="absolute -inset-3 rounded-3xl blur-2xl opacity-20 pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgb(var(--ac) / 0.6), transparent)' }}
          />

          <div className="relative">
            {step !== 'done' && (
              <div className="flex items-center justify-between mb-5">
                <ProgressDots step={step} />
                {step !== 'value' && (
                  <button
                    type="button"
                    onClick={step === 'daw' ? handleSkipDaw : handleSkipGenre}
                    disabled={busy}
                    className="text-xs text-txt-muted hover:text-txt-secondary no-drag disabled:opacity-40"
                  >
                    {t('onboarding.skip')}
                  </button>
                )}
              </div>
            )}

            {step === 'value' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h2 className="text-lg font-bold text-txt-primary">{t('onboarding.value.title')}</h2>
                <div className="flex flex-col gap-3">
                  {[t('onboarding.value.point1'), t('onboarding.value.point2'), t('onboarding.value.point3')].map((point) => (
                    <div key={point} className="flex items-start gap-2.5">
                      <span
                        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full mt-0.5"
                        style={{ color: 'rgb(var(--ac))', background: 'rgb(var(--ac) / 0.12)' }}
                      >
                        <IconCheck />
                      </span>
                      <p className="text-sm text-txt-secondary leading-relaxed">{point}</p>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => setStep('daw')} className="btn-primary w-full py-2.5">
                  {t('onboarding.value.next')}
                </button>
              </div>
            )}

            {step === 'daw' && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h2 className="text-base font-semibold text-txt-primary">{t('onboarding.daw.question')}</h2>
                <ChipGrid options={DAW_OPTIONS} onSelect={handleDawSelect} />
              </div>
            )}

            {step === 'genre' && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h2 className="text-base font-semibold text-txt-primary">{t('onboarding.genre.question')}</h2>
                <ChipGrid options={GENRE_OPTIONS} onSelect={handleGenreSelect} />
              </div>
            )}

            {step === 'done' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <div>
                  <h2 className="text-lg font-bold text-txt-primary">{t('onboarding.done.title')}</h2>
                  <p className="text-sm text-txt-secondary mt-1.5">{t('onboarding.done.subtitle')}</p>
                </div>
                <div className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => { onStartTour(); onDone(daw, genre) }}
                    className="btn-primary w-full py-2.5"
                  >
                    {t('onboarding.done.startTour')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDone(daw, genre)}
                    className="btn-ghost w-full py-2.5"
                  >
                    {t('onboarding.done.start')}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-3 text-xs text-status-error bg-red-500/8 border border-red-500/15 rounded-xl px-4 py-3 animate-fade-in">
                <p>{error}</p>
                <button type="button" onClick={retry} className="mt-2 font-semibold underline underline-offset-2">
                  {t('onboarding.error.retry')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

Примечание к шагу `done`: клик по «Показать тур» вызывает и `onStartTour()`, и `onDone(daw, genre)` — оверлей `Onboarding` должен закрыться сразу (иначе он перекроет тур), а `App.tsx` включает `showTour` независимо от того, каким путём онбординг завершился (см. Task 9).

2. Проверка: `npx tsc --noEmit 2>&1 | grep Onboarding.tsx` — пусто.
3. `git add src/renderer/src/components/Onboarding.tsx && git commit -m "Add Onboarding component (value -> daw -> genre -> done state machine)"`.

---

### Task 9: `OnboardingTour.tsx` — coach-marks тур

**Files:**
- Create: `src/renderer/src/components/OnboardingTour.tsx`

**Interfaces:**
- Consumes: DOM-элементы с атрибутом `data-tour="sidebar-sections" | "search" | "player" | "premium-cta"` (проставляются в `App.tsx`, Task 10), `useI18n().t`.
- Produces: `<OnboardingTour onFinish={() => void} />`.

**Steps:**

1. Создать файл:

```tsx
import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

interface TourStep {
  target: string
  titleKey: string
}

const TOUR_STEPS: TourStep[] = [
  { target: 'sidebar-sections', titleKey: 'onboarding.tour.sidebarSections' },
  { target: 'search', titleKey: 'onboarding.tour.search' },
  { target: 'player', titleKey: 'onboarding.tour.player' },
  { target: 'premium-cta', titleKey: 'onboarding.tour.premiumCta' }
]

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function findMountedSteps(): Array<{ step: TourStep; rect: Rect }> {
  const result: Array<{ step: TourStep; rect: Rect }> = []
  for (const step of TOUR_STEPS) {
    const el = document.querySelector(`[data-tour="${step.target}"]`)
    if (!el) continue // например premium-cta не смонтирован у премиум-пользователя — пропускаем без ошибки
    const box = el.getBoundingClientRect()
    result.push({ step, rect: { top: box.top, left: box.left, width: box.width, height: box.height } })
  }
  return result
}

export default function OnboardingTour({ onFinish }: { onFinish: () => void }): React.ReactElement | null {
  const { t } = useI18n()
  const [steps, setSteps] = useState<Array<{ step: TourStep; rect: Rect }>>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setSteps(findMountedSteps())
  }, [])

  // Resize во время тура: пересчёт позиций на лету не реализуем — просто закрываем тур.
  useEffect(() => {
    const handleResize = () => onFinish()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [onFinish])

  if (steps.length === 0) return null

  const current = steps[index]
  const isLast = index === steps.length - 1
  const { rect } = current
  const pad = 8

  const tooltipTop = rect.top + rect.height + 14
  const tooltipLeft = Math.min(Math.max(rect.left, 16), window.innerWidth - 296)

  return (
    <div className="fixed inset-0 z-[70]">
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ width: '100%', height: '100%' }}>
        <defs>
          <mask id="onboarding-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <rect
              x={rect.left - pad}
              y={rect.top - pad}
              width={rect.width + pad * 2}
              height={rect.height + pad * 2}
              rx={12}
              fill="black"
            />
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#onboarding-tour-mask)" />
      </svg>

      <div
        className="absolute w-[280px] animate-fade-in"
        style={{ top: tooltipTop, left: tooltipLeft }}
      >
        <div className="card p-4">
          <p className="text-sm text-txt-primary leading-relaxed">{t(current.step.titleKey)}</p>
          <div className="flex items-center justify-between mt-3">
            <button
              type="button"
              onClick={onFinish}
              className="text-xs text-txt-muted hover:text-txt-secondary no-drag"
            >
              {t('onboarding.tour.skip')}
            </button>
            <button
              type="button"
              onClick={() => (isLast ? onFinish() : setIndex((i) => i + 1))}
              className="btn-primary py-1.5 px-3 text-xs"
            >
              {isLast ? t('onboarding.tour.finish') : t('onboarding.tour.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

2. Проверка: `npx tsc --noEmit 2>&1 | grep OnboardingTour.tsx` — пусто.
3. `git add src/renderer/src/components/OnboardingTour.tsx && git commit -m "Add OnboardingTour coach-marks component"`.

---

### Task 10: `App.tsx` — монтирование, data-tour атрибуты, проброс жанра в Home

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `Onboarding` (Task 8), `OnboardingTour` (Task 9), `auth.state.onboardingCompleted/onboardingGenre` (Task 2/4).
- Produces: `data-tour` атрибуты на 4 существующих элементах; локальный state `showTour`; условный рендер `<Onboarding>`/`<OnboardingTour>`; `genre` проброшен в `<Home>`.

**Steps:**

1. Добавить импорты (после строки 13, `import AuthScreen from './components/AuthScreen'`):

```ts
import Onboarding from './components/Onboarding'
import OnboardingTour from './components/OnboardingTour'
```

2. Добавить локальный state `showTour` в компонент `App`, сразу после строки 213 (`const [referralDeepLinkMsg, ...] = useState(...)`):

```ts
  const [showTour, setShowTour] = useState(false)
```

3. Проставить `data-tour="search"` на обёртку поиска (строка 417):

```tsx
          <div
            data-tour="search"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(440px,44%)] no-drag"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearchFocused(false) }}
          >
```

4. Проставить `data-tour="sidebar-sections"` на `<nav>` (строка 487):

```tsx
          <nav data-tour="sidebar-sections" className="flex flex-col flex-1 gap-1 overflow-y-auto -mr-1 pr-1">
```

5. Проставить `data-tour="premium-cta"` на кнопку Premium CTA (строка 532, внутри `{!isPremium && (`):

```tsx
            <button
              data-tour="premium-cta"
              onClick={() => setTab('premium')}
              className="w-full flex items-center gap-2 px-3 py-2 mb-2 rounded-xl text-xs font-semibold no-drag"
```

6. Пробросить `genre` в `<Home>` (строка 598):

```tsx
            {tab === 'home'        && <Home onNavigate={setTab} genre={auth.state.onboardingGenre} />}
```

7. Смонтировать `Onboarding`/`OnboardingTour` в конце главного `return`, сразу после `<PremiumChat .../>` (после строки 626, перед закрывающим `</div>` строка 627):

```tsx
      {auth.status === 'signedIn' && !auth.state.onboardingCompleted && (
        <Onboarding
          onDone={() => { /* onboardingCompleted придёт через auth:changed после completeOnboarding — оверлей закроется сам */ }}
          onStartTour={() => setShowTour(true)}
        />
      )}
      {showTour && <OnboardingTour onFinish={() => setShowTour(false)} />}
```

Примечание: `PlayerBar`'s собственная разметка (`src/renderer/src/components/PlayerBar.tsx:167-174`) уже несёт `data-tour="player"` — это правится в шаге 8 этой задачи, не здесь, т.к. `PlayerBar` — отдельный файл.

8. Открыть `src/renderer/src/components/PlayerBar.tsx`, добавить атрибут на корневой div визуального компонента (строки 167-174):

```tsx
    <div
      data-tour="player"
      className="no-drag fixed bottom-4 left-4 right-24 z-30 flex items-center gap-4 rounded-2xl border border-app-border/50 px-4 py-3 shadow-[0_12px_38px_rgb(0_0_0_/_0.35)]"
      style={{
        backgroundColor: 'rgb(var(--panel) / 0.92)',
        backdropFilter: 'blur(18px) saturate(1.3)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.3)'
      }}
    >
```

9. Проверка: `npx tsc --noEmit` — чисто. `npm run build` — чистая сборка без новых warning.
10. `git add src/renderer/src/App.tsx src/renderer/src/components/PlayerBar.tsx && git commit -m "App: mount Onboarding/OnboardingTour, wire data-tour targets, pass genre to Home"`.

---

## Self-Review

**Покрытие спецификации:**
- ✅ Поток `value → daw → genre → done` — реализован в `Onboarding.tsx` (Task 8), включая раздельный skip на `daw`/`genre`.
- ✅ `onboarding_completed`/`onboarding_daw`/`onboarding_genre` в Supabase — Task 1.
- ✅ Комбинированный SELECT премиум+онбординг в `buildState()` — Task 2, шаг 4-5 (исправлен баг раннего `return` для premium).
- ✅ IPC `auth:completeOnboarding` — Task 2 шаг 7-8, преload Task 3, вызов из `Onboarding.tsx` Task 8.
- ✅ Тур с 4 точками, автопропуск отсутствующих целей (`premium-cta` для премиум-юзера) — `OnboardingTour.tsx` шаг `findMountedSteps()` фильтрует отсутствующие `data-tour`.
- ✅ Тур ничего не пишет в БД — `OnboardingTour.tsx` не вызывает `window.api` вовсе.
- ✅ Resize закрывает тур — `OnboardingTour.tsx` эффект на `window.addEventListener('resize', ...)`.
- ✅ Ошибка сохранения → инлайн-ошибка с повтором, оверлей не закрывается — `Onboarding.tsx` `persist()`/`retry()`.
- ✅ i18n ключи ru+en — Task 5.
- ✅ Genre soft-filter Home (без DAW-фильтрации) — Task 6 (tags), Task 7 (Home).
- ✅ Существующие пользователи увидят онбординг один раз (default false) — Task 1 комментарий в SQL.

**Проверка на плейсхолдеры:** каждый Task содержит полный код без TBD/TODO/«аналогично»; единственная сноска-примечание (Task 8, Task 10 шаг 7) поясняет поведение, а не откладывает реализацию.

**Согласованность типов между задачами:** `AuthState` расширена идентично в Task 2/3/4 (5 зеркал), `completeOnboarding` сигнатура `(daw: string | null, genre: string | null) => Promise<AuthResult>` идентична в auth.ts/preload/Onboarding.tsx. `LibraryItem.tags?: string[]` (Task 6) потребляется `Home.tsx` (Task 7) через `item.tags?.some(...)`.

**Незапланированный побочный эффект:** миграция Task 1 применяется пользователем вручную в Supabase SQL Editor — агент не имеет доступа к продовой БД, это явно отмечено в шаге 3 Task 1.

---

## Execution Handoff

План сохранён в `docs/superpowers/plans/2026-07-09-onboarding-implementation.md`. Два варианта выполнения:

1. **Subagent-Driven (рекомендуется)** — через `superpowers:subagent-driven-development`: каждая задача выполняется отдельным субагентом, с проверкой между шагами.
2. **Inline Execution** — через `superpowers:executing-plans`: выполняю все задачи последовательно сам в этом диалоге.

Какой вариант выбрать?
