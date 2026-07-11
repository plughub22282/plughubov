# Streak-система — дизайн

Дата: 2026-07-10
Статус: спроектировано, ожидает `writing-plans`
Часть более широкой инициативы «Блок 1: план удержания DAU (битмейкеры)» (подпроект 2 из 4: Daily Drop → **streak** → персонализированная лента → Telegram-пуши).

## Контекст

Считаем подряд идущие календарные дни, когда пользователь открывает приложение. На днях 3, 7 и 28 пользователь получает право выбрать одну из двух наград: бонусный слот на публикацию бита сверх free-tier лимита, или +1 к новому месячному лимиту скачиваний ассетов. Награда не выдаётся автоматически — пользователь выбирает тип сам.

### Обнаруженное несоответствие с исходной формулировкой

Исходный текст задачи говорит про интеграцию с «существующей Premium_limit логикой» — такого механизма в коде нет. Ближайшие аналоги — `enforce_beat_rules()` (3 бита/мес free-tier на **загрузку**, не на скачивание) и общий параметризованный `consume_named_quota`/`peek_named_quota` (сейчас используется для AI-квот). Месячного лимита на **скачивание** ассетов не существовало вовсе — только клиентский троттлинг скорости. Решение (см. вопросы ниже): месячный лимит скачиваний вводится с нуля, но узко — только на `preset`/`loop`/`drumkit` (биты не скачиваются через приложение — только внешняя оплата по `paymentUrl`, поэтому лимит на них физически не на что вешать; `flp`/`template` остаются без лимита).

## Модель данных (Supabase)

Новые колонки `profiles` (по аналогии с `premium_until`/`referral_rewards_granted`):

| Колонка | Тип | Назначение |
|---|---|---|
| `streak_count` | `int not null default 0` | текущая длина стрика, 1..28 |
| `streak_last_date` | `date` | UTC-дата последнего засчитанного захода |
| `streak_reward_stage` | `int not null default 0` | какой порог (0/3/7/28) обработан в текущем цикле |
| `streak_reward_pending` | `boolean not null default false` | true — порог достигнут, пользователь ещё не выбрал награду |
| `bonus_beat_slots` | `int not null default 0` | одноразовый бонус к лимиту публикации битов |
| `bonus_beat_slots_month` | `date` | месяц выдачи бонуса — сравнивается с `date_trunc('month', now())`, старое значение молча не учитывается |
| `bonus_download_slots` | `int not null default 0` | одноразовый бонус к месячному лимиту скачиваний |
| `bonus_download_slots_month` | `date` | месяц выдачи, та же логика молчаливого истечения |

`prevent_role_change`: добавить все 8 новых колонок в список защищённых от прямого self-update через `profiles_update_own`.

## RPC-функции

### `touch_streak()` — SECURITY DEFINER, вызывается раз за сессию

- `diff = current_date(UTC) - streak_last_date`.
- `diff = 0` → ничего не делает (идемпотентно в рамках дня, безопасно звать повторно).
- `diff = 1` → `streak_count += 1`, `streak_last_date = current_date`.
- `diff > 1` или `streak_last_date is null` → `streak_count = 1`, `streak_reward_stage = 0`, `streak_last_date = current_date`.
- После обновления `streak_count`: если новое значение ∈ {3, 7, 28} и `streak_reward_stage <` этого порога → `streak_reward_stage = <порог>`, `streak_reward_pending = true`.
- Возвращает `{ streak_count, reward_pending, reward_stage }`.
- **Не выдаёт награду сама** — только взводит pending-флаг. Цикл не сбрасывается после дня 28, пока пользователь не заберёт награду через `claim_streak_reward` (см. ниже) — иначе стрик обнулится раньше, чем пользователь успеет выбрать.

### `claim_streak_reward(p_choice text)` — SECURITY DEFINER

- `p_choice ∈ ('beat', 'download')`, иначе ошибка.
- Если `streak_reward_pending = false` → ошибка «нет активной награды».
- `p_choice = 'beat'` → `bonus_beat_slots += 1`, `bonus_beat_slots_month = date_trunc('month', now())::date`.
- `p_choice = 'download'` → `bonus_download_slots += 1`, `bonus_download_slots_month = date_trunc('month', now())::date`.
- `streak_reward_pending = false`.
- Если обработанный `streak_reward_stage = 28` → дополнительно `streak_count = 1`, `streak_reward_stage = 0` (новый цикл стартует только после выбора награды).
- Возвращает `{ streak_count }`.

## Enforcement — интеграция с существующими лимитами

### `enforce_beat_rules()` (`supabase/schema.sql:917-957`)

- Было: free-автор блокируется на 4-й бит в календарном месяце (`count(*) >= 3`).
- Стало: эффективный лимит = `3 + (bonus_beat_slots, если bonus_beat_slots_month = date_trunc('month', now())::date, иначе 0)`.
- `bonus_beat_slots` не списывается при использовании — одноразовость обеспечивается сравнением `_month`: при смене календарного месяца бонус перестаёт учитываться сам по себе, без отдельного decrement/cron.

### Новый месячный лимит скачиваний — `asset_download_monthly`

- Реализуется через существующий `consume_named_quota(p_counter_key, p_limit, p_period)` — новый counter_key `'asset_download_monthly'`, период `interval '30 days'`.
- Действует **только** для `kind ∈ ('preset', 'loop', 'drumkit')`. `flp`/`template` — без лимита. Биты — вне механизма (не скачиваются через приложение).
- База: 50/мес для free. Premium — без лимита (как и в существующем паттерне `consumeUserQuota(req, counterKey, freeLimit, premiumLimit)`).
- Эффективный лимит для free = `50 + (bonus_download_slots, если bonus_download_slots_month = date_trunc('month', now())::date, иначе 0)`.
- Проверка — **до** скачивания: в начале `assets:download` (`src/main/index.ts:2553`), сразу после `fetchCommunityContent(id)` (где уже известен `asset.kind`), до вызова `downloadFile`/скана. Если квота исчерпана — `{ ok: false, error: '...' }` сразу, без скачивания и без скана.

## Интеграция с реферальной системой

`count_qualified_referrals(p_referrer uuid)` (`supabase/schema.sql:1099-1130`): CTE `refs` уже селектит из `profiles p` — достаточно добавить одну колонку в select-лист, джойн не нужен:

```sql
refs as (
  select
    p.id,
    p.created_at,
    public.primary_device(p.id) as dev,
    public.discord_created_at(p.id) as born,
    p.streak_count as streak          -- новое поле
  from public.profiles p
  where p.referred_by = p_referrer
),
```

В CTE `eligible` к существующим условиям (`dev <> referrer_dev`, `born <= now() - 30 days`) добавляется третье: `and r.streak >= 3`.

Итоговое условие «засчитанного» реферала: устройство приглашённого отличается от реферера **и** возраст Discord-аккаунта ≥ 30 дней **и** `streak_count` приглашённого ≥ 3 (реальные 3 дня подряд использования приложения — поведенческий сигнал, которого раньше не было).

Граничный случай: `count_qualified_referrals` пересчитывается на лету при каждом вызове `referral_stats()`/`redeem_referral_rewards()`, ретроактивной миграции данных не требуется. Уже выданные премиум-дни (`referral_rewards_granted`) не отбираются — `redeem_referral_rewards()` только доначисляет новые блоки (`v_new = v_blocks - v_granted`, `if v_new <= 0` — no-op). Эффект ужесточения: рефералы, у которых ещё нет 3-дневного стрика, временно не засчитываются в `qualified`, пока не наберут его — для реферера это отложенная, а не потерянная награда.

UI не меняется — `ReferralProgram.tsx` уже показывает `qualified`/`rewards_available` из `referral_stats()` динамически.

## IPC-контракт

Новый файл в `preload.ts` → `window.api.streak`:

```ts
streak: {
  touch(): Promise<
    | { ok: true; streakCount: number; rewardPending: boolean; rewardStage: 0 | 3 | 7 | 28 }
    | { ok: false; error: string }
  >
  claim(choice: 'beat' | 'download'): Promise<
    | { ok: true; streakCount: number }
    | { ok: false; error: string }
  >
}
```

Main-процесс — два новых `ipcMain.handle('streak:touch', ...)` и `ipcMain.handle('streak:claim', ...)`, каждый вызывает соответствующую RPC через `supabase.rpc(...)`, стандартный `rejectUntrustedSender`/`toSafeError` паттерн, как у остальных хендлеров.

## UI

### Хук `useStreak()` (новый файл `src/renderer/src/hooks/useStreak.ts`)

- Не расширяет `useAuth`/`AuthState` — отдельный хук, чтобы не растить уже 5x-дублированный интерфейс `AuthState`.
- Вызывает `window.api.streak.touch()` один раз, когда `useAuth()` первый раз сообщает `status === 'signed_in'` (переход в этот статус, не на каждый рендер).
- Хранит `{ streakCount, rewardPending, rewardStage }` в локальном `useState`.
- Отдаёт `claim(choice)` — вызывает `window.api.streak.claim`, по успеху обновляет локальный стейт (`rewardPending = false`, новый `streakCount`).

### Индикатор в хедере

- Компактный элемент рядом с существующими элементами хедера (профиль/премиум-бейдж): `🔥 {streakCount}`.
- Если `rewardPending` — маленькая точка-бейдж поверх иконки (проверить на этапе реализации, есть ли в проекте уже готовый паттерн для notification-точки, переиспользовать его).
- Клик: если `rewardPending` → открыть `StreakRewardModal`; если нет → поповер/тултип с текущим стриком и подсказкой «до следующей награды: N дней» (N = 3/7/28 минус `streakCount`, следующий незанятый порог).

### `StreakRewardModal.tsx` (новый компонент)

- Две карточки выбора: «Бесплатный слот для бита» и «+1 к скачиваниям в этом месяце», с кратким описанием под каждой.
- Выбор → `claim(choice)` → закрыть модалку, показать подтверждение (тост/инлайн-текст).
- Закрытие без выбора (крестик) — допустимо: `rewardPending` остаётся `true`, точка на индикаторе не пропадает, выбор доступен позже повторным кликом по индикатору.

### i18n

Новые ключи (ru + en), по аналогии с существующими блоками: `streak.title`, `streak.tooltip` (с `{days}`), `streak.rewardTitle`, `streak.rewardBeat`, `streak.rewardBeatDesc`, `streak.rewardDownload`, `streak.rewardDownloadDesc`, `streak.claimed`.

## Обработка ошибок и граничные случаи

- **Пропуск дня** (diff > 1): стрик сбрасывается на 1 безусловно, без грейс-периода.
- **Повторный вызов `touch_streak()` в тот же день** (diff = 0): не должен повторно взводить `reward_pending` или менять `streak_count` — идемпотентность гарантируется веткой `diff = 0` в самой RPC.
- **Смена месяца с невыбранной наградой прошлого месяца**: `bonus_*_month` сравнивается с текущим месяцем при каждом enforcement-чтении — просроченный бонус просто перестаёт совпадать и не учитывается, никакой отдельной очистки не требуется.
- **День 28 без выбора награды**: цикл **не** сбрасывается, пока `claim_streak_reward` не вызван — `streak_count` может оставаться на 28 сколь угодно долго, `touch_streak()` в этом состоянии просто не находит новых порогов (28 уже зафиксирован в `streak_reward_stage`) и не трогает `reward_pending`.
- **Premium-пользователь**: `touch_streak()`/награды работают одинаково независимо от премиума — премиум влияет только на eё-эффективный лимит скачиваний (уже безлимитный) и лимит битов (уже безлимитный через `sync_author_premium()`), поэтому бонусные слоты для премиум-пользователя по сути не имеют эффекта на скачивания, но слот на бит всё равно начисляется (не используется, т.к. free-only ограничение и так снято).

## Вне рамок этого цикла

- Персонализация/лидерборды по стрику — не запрошено.
- Grace-период на пропущенный день — отклонено в пользу безусловного сброса.
- Décrement/списание `bonus_beat_slots`/`bonus_download_slots` при фактическом использовании — не требуется благодаря помесячному сравнению `_month`.
- Уведомления/пуши о риске потери стрика («стрик сгорит сегодня») — не в этом цикле, потенциально пересекается с подпроектом 4 (Telegram-интеграция).
- Daily Drop, персонализированная лента «Для тебя», Telegram-пуши — отдельные циклы (подпроекты 1, 3, 4 Блока 1).

## Проверка при реализации

- `npx tsc --noEmit` и `npm run build` — чистый прогон.
- Ручной чек-лист в dev-сборке (потребует ручного управления `streak_last_date` в БД для симуляции нескольких дней подряд):
  - Первый заход — `streak_count = 1`, индикатор показывает `🔥 1`.
  - Симуляция 3 дней подряд — на 3-й день `reward_pending = true`, точка на индикаторе, модалка предлагает выбор.
  - Выбор «бит» на дне 3 — free-автор с уже опубликованными 3 битами может опубликовать 4-й в этом месяце.
  - Выбор «скачивание» на дне 7 (после симуляции ещё 4 дней) — лимит скачиваний preset/loop/drumkit становится 51 вместо 50.
  - Пропуск дня (искусственно поставить `streak_last_date` на 2+ дня назад) — при следующем заходе `streak_count` сбрасывается на 1.
  - День 28 — после выбора награды `streak_count` сбрасывается на 1, `streak_reward_stage = 0`, новый цикл стартует корректно.
  - Смена месяца после начисления бонуса — бонус не переносится на новый месяц (проверить по `bonus_*_month`).
  - Приглашённый с валидным устройством и возрастом Discord, но `streak_count < 3` — не попадает в `qualified` у реферера; после того как приглашённый наберёт стрик 3 — попадает без ручных действий реферера.
