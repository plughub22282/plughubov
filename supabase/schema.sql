-- ============================================================================
--  PlugHub — схема авторизации, ролей и таблиц плагинов
--  Выполнять в Supabase → SQL Editor.
--  Скрипт ИДЕМПОТЕНТЕН — его можно безопасно запускать повторно.
--
--  Вход выполняется через Discord OAuth (см. DISCORD_AUTH_SETUP.md).
--  Роль «author» приложение определяет по списку Discord ID в коде
--  (src/main/auth.ts → AUTHOR_DISCORD_IDS), а НЕ по колонке profiles.role —
--  поле role здесь остаётся как defense-in-depth для прямых запросов к БД.
-- ============================================================================

-- ─── Роль пользователя ──────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('user', 'author');
  end if;
end
$$;

-- ─── Профили (1:1 с auth.users) ─────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  role         public.user_role not null default 'user',
  premium      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Миграция для существующих БД: добавить колонку премиума идемпотентно.
alter table public.profiles
  add column if not exists premium boolean not null default false;

-- Срок действия премиум-подписки. NULL — премиума нет/не было.
-- Источник истины «премиум активен» = (premium_until > now()); булев premium
-- держим синхронно для обратной совместимости.
alter table public.profiles
  add column if not exists premium_until timestamptz;

-- Легаси-миграция: у кого стоял вечный premium=true, но срок не задан — считаем
-- «до дальней даты», чтобы has_premium() продолжал возвращать true.
update public.profiles
  set premium_until = timestamptz '2099-01-01'
  where premium = true and premium_until is null;

-- ─── Реферальные поля ────────────────────────────────────────────────────────
-- referral_code  — личный код приглашения (генерируется при создании профиля);
-- referred_by    — кто пригласил (ставится один раз, иммутабельно);
-- referral_rewards_granted — сколько блоков по 5 засчитанных рефералов уже оплачено
--                  премиумом (чтобы не выдать награду дважды).
-- Все три защищены триггером prevent_role_change (см. ниже) — юзер не может их менять
-- обычным апдейтом профиля.
alter table public.profiles
  add column if not exists referral_code text;
alter table public.profiles
  add column if not exists referred_by uuid references auth.users (id) on delete set null;
alter table public.profiles
  add column if not exists referral_rewards_granted int not null default 0;

-- ─── Онбординг (default false так же для существующих юзеров — увидят один раз) ──
alter table public.profiles
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists onboarding_daw text,
  add column if not exists onboarding_genre text;

create unique index if not exists profiles_referral_code_uidx
  on public.profiles (referral_code)
  where referral_code is not null;
create index if not exists profiles_referred_by_idx
  on public.profiles (referred_by);

-- Генератор уникального кода приглашения (формат XXXX-XXXX без похожих символов).
create or replace function public.new_referral_code()
  returns text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_code text;
begin
  loop
    select string_agg(
             substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), ''
           )
      into v_code
      from generate_series(1, 8);
    v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
    exit when not exists (select 1 from public.profiles where referral_code = v_code);
  end loop;
  return v_code;
end;
$$;

revoke execute on function public.new_referral_code() from public;

-- Бэкофилл кодов существующим профилям (по строке, чтобы уникальность проверялась
-- с учётом уже проставленных в этой же транзакции). allow_priv_change нужен, иначе
-- триггер prevent_role_change заблокирует изменение referral_code.
do $$
declare
  r record;
begin
  perform set_config('app.allow_priv_change', 'on', true);
  for r in select id from public.profiles where referral_code is null loop
    update public.profiles set referral_code = public.new_referral_code() where id = r.id;
  end loop;
end
$$;

alter table public.profiles enable row level security;

-- Пользователь видит и редактирует только свой профиль.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ─── Запрет самоповышения роли и премиума ───────────────────────────────────
-- Роль и флаг premium нельзя менять обычным апдейтом профиля (даже владельцем).
-- Менять их могут только: администратор через SQL Editor / service_role, ИЛИ
-- доверенные SECURITY DEFINER функции, которые перед апдейтом выставляют локальную
-- GUC-переменную app.allow_priv_change = 'on' (см. redeem_premium_code).
create or replace function public.prevent_role_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if (new.role is distinct from old.role
      or new.premium is distinct from old.premium
      or new.premium_until is distinct from old.premium_until
      or new.referred_by is distinct from old.referred_by
      or new.referral_rewards_granted is distinct from old.referral_rewards_granted
      or new.referral_code is distinct from old.referral_code
      -- Streak-поля: иначе юзер сам взведёт reward_pending / накрутит бонусы.
      or new.streak_count is distinct from old.streak_count
      or new.streak_last_date is distinct from old.streak_last_date
      or new.streak_reward_stage is distinct from old.streak_reward_stage
      or new.streak_reward_pending is distinct from old.streak_reward_pending
      or new.bonus_beat_slots is distinct from old.bonus_beat_slots
      or new.bonus_beat_slots_month is distinct from old.bonus_beat_slots_month
      or new.bonus_download_slots is distinct from old.bonus_download_slots
      or new.bonus_download_slots_month is distinct from old.bonus_download_slots_month)
     and coalesce(current_setting('app.allow_priv_change', true), '') <> 'on' then
    raise exception 'Изменение роли, премиума или реферальных полей запрещено';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_role_change on public.profiles;
create trigger trg_prevent_role_change
  before update on public.profiles
  for each row execute function public.prevent_role_change();

-- ─── Автосоздание профиля при входе ─────────────────────────────────────────
-- Имя берём из метаданных Discord (full_name / name / user_name), e-mail может
-- отсутствовать (зависит от выданных Discord прав).
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, referral_code)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'user_name',
      split_part(coalesce(new.email, 'user'), '@', 1)
    ),
    public.new_referral_code()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Хелпер: роль текущего пользователя (для RLS других таблиц) ──────────────
-- Имя current_role зарезервировано в PostgreSQL, поэтому current_app_role.
create or replace function public.current_app_role()
  returns public.user_role
  language sql
  stable
  security definer
  set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Серверный признак premium. Именно его используют RLS/Storage policies; клиентский
-- флаг premium в Electron нужен только для UI и не является источником доверия.
create or replace function public.has_premium()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.premium_until is not null
        and p.premium_until > now()
    );
$$;

-- Проверяет, что публичный URL community-файла указывает на путь текущего
-- пользователя в Cloud.ru Evolution Object Storage (см. supabase/functions/storage-proxy).
-- Для plugin: <uid>/file.zip; для ассетов: <kind>/<uid>/file.ext.
--
-- !!! ВАЖНО: впишите сюда публичный адрес вашего Cloud.ru bucket, например
-- https://plughub.s3.cloud.ru, либо другой публичный домен бакета.
-- То же значение должно быть в STORAGE_PUBLIC_BASE_URL в src/main/index.ts и
-- Supabase secret STORAGE_PUBLIC_BASE_URL для Edge Function storage-proxy.
create or replace function public.community_storage_url_matches(
  p_url text,
  p_kind text,
  p_uid uuid
)
  returns boolean
  language sql
  immutable
  set search_path = public
as $$
  select case
    when p_url is null or p_uid is null then false
    when coalesce(p_kind, 'plugin') = 'plugin' then
      p_url like 'https://plughub.s3.cloud.ru/community-plugins/' || p_uid::text || '/%'
    else
      p_url like 'https://plughub.s3.cloud.ru/community-plugins/' || coalesce(p_kind, 'plugin') || '/' || p_uid::text || '/%'
  end;
$$;

-- ============================================================================
--  Премиум-коды активации
--  Владелец приложения генерирует коды (generate_premium_codes) и продаёт их.
--  Покупатель вводит код в приложении → redeem_premium_code помечает код
--  использованным и выставляет profiles.premium = true.
-- ============================================================================
create table if not exists public.premium_codes (
  code         text primary key,
  created_at   timestamptz not null default now(),
  redeemed_by  uuid references auth.users (id) on delete set null,
  redeemed_at  timestamptz,
  note         text,                                 -- произвольная пометка (партия, покупатель)
  duration_days int not null default 30              -- на сколько дней код продлевает премиум
);

-- Миграция для существующих БД: срок действия кода (идемпотентно).
alter table public.premium_codes
  add column if not exists duration_days int not null default 30;

-- RLS включён, политик нет → обычные пользователи НЕ видят и НЕ меняют коды
-- напрямую (даже с publishable-ключом). Доступ — только через SECURITY DEFINER
-- функции ниже и SQL Editor (service_role обходит RLS).
alter table public.premium_codes enable row level security;

-- ─── Активация кода покупателем ─────────────────────────────────────────────
-- Возвращает строку-статус: 'ok' | 'invalid' | 'used' | 'unauthorized'.
-- Атомарно: блокирует строку кода (for update), помечает использованной и
-- включает премиум. Повторный ввод СВОЕГО кода тем же юзером безопасен (idempotent).
create or replace function public.redeem_premium_code(p_code text)
  returns text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_norm text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_row  public.premium_codes%rowtype;
  v_days int;
begin
  if v_uid is null then return 'unauthorized'; end if;
  if v_norm = '' then return 'invalid'; end if;

  select * into v_row from public.premium_codes where code = v_norm for update;
  if not found then return 'invalid'; end if;

  -- Код уже использован другим человеком.
  if v_row.redeemed_by is not null and v_row.redeemed_by <> v_uid then
    return 'used';
  end if;

  -- Повторная активация СВОЕГО кода — идемпотентна: срок повторно НЕ продлеваем.
  if v_row.redeemed_by = v_uid then
    return 'ok';
  end if;

  -- Первая активация: помечаем код и продлеваем премиум на его срок действия.
  v_days := coalesce(v_row.duration_days, 30);
  update public.premium_codes
    set redeemed_by = v_uid, redeemed_at = now()
    where code = v_norm;

  -- Доверенное повышение привилегий: разрешаем триггеру пропустить смену premium/premium_until.
  perform set_config('app.allow_priv_change', 'on', true);
  -- Продлеваем от максимума (текущий срок, now) — стэкается, если премиум ещё активен.
  update public.profiles
    set premium_until = greatest(coalesce(premium_until, now()), now()) + make_interval(days => v_days),
        premium = true,
        updated_at = now()
    where id = v_uid;

  return 'ok';
end;
$$;

-- Активировать код может любой вошедший пользователь.
revoke execute on function public.redeem_premium_code(text) from public;
grant  execute on function public.redeem_premium_code(text) to authenticated;

-- ─── Кто владелец приложения (может генерировать ключи) ──────────────────────
-- !!! ВАЖНО: впишите сюда свой Discord ID (тот же, что в src/main/auth.ts →
-- OWNER_DISCORD_IDS). Эта проверка — серверная защита: без неё любой пользователь
-- мог бы сгенерировать себе бесконечные коды. Узнать свой ID: Discord → Настройки →
-- Расширенные → «Режим разработчика» → ПКМ по аватару → «Копировать ID».
create or replace function public.is_owner()
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public, auth
as $$
declare
  v_discord text;
  owner_ids text[] := array[
    '1235673671658377238'                       -- Discord ID владельца приложения
  ];
begin
  if auth.uid() is null then return false; end if;
  select coalesce(raw_user_meta_data ->> 'provider_id', raw_user_meta_data ->> 'sub')
    into v_discord
    from auth.users where id = auth.uid();
  return v_discord is not null and v_discord = any (owner_ids);
end;
$$;

-- ─── Генерация кодов (только владелец; вызывается из приложения или SQL Editor) ─
-- Пример из SQL Editor: select * from public.generate_premium_codes(10, 'июнь-2026');
-- Возвращает список новых кодов формата ABCD-EFGH-JKLM-NPQR (без похожих символов).
create or replace function public.has_premium()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select public.is_owner()
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.premium_until is not null
        and p.premium_until > now()
    );
$$;

-- Старую 2-арг сигнатуру убираем, чтобы вызов (int, text) не был неоднозначным
-- при наличии 3-арг перегрузки со сроком действия.
drop function if exists public.generate_premium_codes(int, text);

create or replace function public.generate_premium_codes(
  p_count int default 1,
  p_note text default null,
  p_duration_days int default 30
)
  returns setof text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_code text;
  i int;
begin
  if not public.is_owner() then
    raise exception 'Только владелец приложения может генерировать коды';
  end if;
  -- Разумный предел на один вызов из UI.
  if coalesce(p_count, 1) > 200 then
    raise exception 'За один раз можно сгенерировать не более 200 кодов';
  end if;

  for i in 1..greatest(p_count, 1) loop
    loop
      select string_agg(
               substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), ''
             )
        into v_code
        from generate_series(1, 16);
      v_code := substr(v_code,1,4) ||'-'|| substr(v_code,5,4) ||'-'||
                substr(v_code,9,4) ||'-'|| substr(v_code,13,4);
      begin
        insert into public.premium_codes (code, note, duration_days)
          values (v_code, p_note, greatest(1, coalesce(p_duration_days, 30)));
        exit;                                  -- успешно вставили уникальный код
      exception when unique_violation then
        -- крайне редкое совпадение — генерируем заново
      end;
    end loop;
    return next v_code;
  end loop;
end;
$$;

-- Доступ есть у authenticated, но внутри функция всё равно проверяет is_owner().
revoke execute on function public.generate_premium_codes(int, text, int) from public;
grant  execute on function public.generate_premium_codes(int, text, int) to authenticated;

-- ─── Список всех кодов (только владелец) — для панели в приложении ───────────
-- Меняем сигнатуру RETURNS TABLE (добавили duration_days) → сначала дропаем старую.
drop function if exists public.list_premium_codes();
create or replace function public.list_premium_codes()
  returns table (
    code          text,
    note          text,
    duration_days int,
    redeemed_by   uuid,
    redeemed_at   timestamptz,
    created_at    timestamptz
  )
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Доступ только для владельца приложения';
  end if;
  return query
    select c.code, c.note, c.duration_days, c.redeemed_by, c.redeemed_at, c.created_at
    from public.premium_codes c
    order by c.created_at desc;
end;
$$;

revoke execute on function public.list_premium_codes() from public;
grant  execute on function public.list_premium_codes() to authenticated;

-- ============================================================================
--  Таблица плагинов
--  id — текстовый slug (совпадает с mock-данными приложения, напр. 'vital-synth').
-- ============================================================================
create table if not exists public.plugins (
  id           text primary key,
  name         text not null,
  author       text,
  version      text,
  description  text,
  category     text,
  size         text,
  download_url text not null,
  icon_url     text,
  tags         text[] not null default '{}',
  owner_id     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ─── RLS для plugins: читают все, пишет только владелец приложения ───────────
-- (Защищает БД, даже если клиент с publishable-ключом обратится к API напрямую.)
alter table public.plugins enable row level security;

drop policy if exists plugins_select_all on public.plugins;
create policy plugins_select_all on public.plugins
  for select using (true);

drop policy if exists plugins_insert_author on public.plugins;
drop policy if exists plugins_update_author on public.plugins;
drop policy if exists plugins_delete_author on public.plugins;

drop policy if exists plugins_insert_owner on public.plugins;
create policy plugins_insert_owner on public.plugins
  for insert to authenticated
  with check (public.is_owner());

drop policy if exists plugins_update_owner on public.plugins;
create policy plugins_update_owner on public.plugins
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists plugins_delete_owner on public.plugins;
create policy plugins_delete_owner on public.plugins
  for delete to authenticated
  using (public.is_owner());

-- ============================================================================
--  Legacy Supabase Storage: bucket для официального каталога плагинов
--  Новые файлы текущий клиент загружает через storage-proxy в Cloud.ru Object Storage.
--  Чтение публичное; загрузка/обновление/удаление только владельцу приложения.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('catalog-plugins', 'catalog-plugins', true)
on conflict (id) do nothing;

drop policy if exists catalog_files_select on storage.objects;
create policy catalog_files_select on storage.objects
  for select using (bucket_id = 'catalog-plugins');

drop policy if exists catalog_files_insert_owner on storage.objects;
create policy catalog_files_insert_owner on storage.objects
  for insert to authenticated
  with check (bucket_id = 'catalog-plugins' and public.is_owner());

drop policy if exists catalog_files_update_owner on storage.objects;
create policy catalog_files_update_owner on storage.objects
  for update to authenticated
  using (bucket_id = 'catalog-plugins' and public.is_owner())
  with check (bucket_id = 'catalog-plugins' and public.is_owner());

drop policy if exists catalog_files_delete_owner on storage.objects;
create policy catalog_files_delete_owner on storage.objects
  for delete to authenticated
  using (bucket_id = 'catalog-plugins' and public.is_owner());

-- ============================================================================
--  Роль «author» приложение выдаёт по списку Discord ID в src/main/auth.ts
--  (AUTHOR_DISCORD_IDS). Официальный каталог пополняет только владелец приложения
--  через вкладку «Админ каталог» и проверку public.is_owner().
--  Колонку profiles.role при желании можно синхронизировать вручную:
--    update public.profiles set role = 'author' where id = '<uuid пользователя>';
-- ============================================================================

-- ============================================================================
--  Пользовательский маркетплейс (community)
--  Любой вошедший юзер загружает свои плагины и скачивает чужие.
--  Отдельно от plugins (официальный каталог только для владельца приложения).
-- ============================================================================
create table if not exists public.community_plugins (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  author       text,                                  -- display_name загрузившего
  version      text,
  description  text,
  category     text,
  size         text,
  download_url text not null,                         -- публичный URL в Storage
  icon_url     text,
  uploader_id  uuid references auth.users (id) on delete cascade default auth.uid(),
  downloads    integer not null default 0,
  kind         text not null default 'plugin',     -- 'plugin' | 'flp' | 'template' | 'loop' | 'drumkit' | 'beat'
  price        text,                                -- цена платного контента (битов), напр. «20$»
  payment_url  text,                                -- Telegram владельца бита (https://t.me/…) для связи/оплаты
  created_at   timestamptz not null default now()
);

-- ─── Миграция: добавить новые колонки в существующую таблицу (идемпотентно) ──
alter table public.community_plugins
  add column if not exists kind text not null default 'plugin';
alter table public.community_plugins
  add column if not exists price text;
alter table public.community_plugins
  add column if not exists payment_url text;
alter table public.community_plugins
  add column if not exists tags text[] not null default '{}';
alter table public.community_plugins
  add column if not exists preview_wet_url text;
alter table public.community_plugins
  add column if not exists preview_dry_url text;

-- Индекс для быстрой выборки по типу контента (вкладки FLP / шаблоны / лупы / биты).
create index if not exists community_plugins_kind_idx
  on public.community_plugins (kind);

-- ─── RLS: читают все, загружает любой authenticated (только от своего имени) ──
alter table public.community_plugins enable row level security;

drop policy if exists community_select_all on public.community_plugins;
create policy community_select_all on public.community_plugins
  for select using (true);

drop policy if exists community_insert_own on public.community_plugins;
create policy community_insert_own on public.community_plugins
  for insert to authenticated
  with check (
    uploader_id = auth.uid()
    and kind in ('plugin', 'flp', 'template', 'loop', 'drumkit', 'beat', 'preset')
    and cardinality(tags) <= 5
    and not exists (
      select 1
      from unnest(tags) as tag
      where tag !~ '^#[[:alnum:]_А-Яа-яЁё-]{2,24}$'
    )
    -- Биты может выкладывать любой вошедший юзер. Лимит 3/мес и диапазон цены
    -- $2–$15 для не-премиума навешивает триггер public.enforce_beat_rules().
    and (
      kind <> 'beat'
      or coalesce(nullif(price, ''), null) is not null
    )
    and (
      kind <> 'beat'
      or payment_url ~* '^https://(t\.me|telegram\.me)/[A-Za-z0-9_/?=&.-]+$'
    )
    -- Пресеты: оба preview-клипа (с эффектами / без) обязательны и должны лежать
    -- в папке текущего пользователя — иначе живое A/B-сравнение показывать нечего.
    and (
      kind <> 'preset'
      or (
        preview_wet_url is not null
        and preview_dry_url is not null
        and public.community_storage_url_matches(preview_wet_url, kind, auth.uid())
        and public.community_storage_url_matches(preview_dry_url, kind, auth.uid())
      )
    )
    and public.community_storage_url_matches(download_url, kind, auth.uid())
    and (
      icon_url is null
      or public.community_storage_url_matches(icon_url, kind, auth.uid())
    )
  );

drop policy if exists community_delete_own on public.community_plugins;
create policy community_delete_own on public.community_plugins
  for delete to authenticated
  using (uploader_id = auth.uid() or public.is_owner());

-- ─── Счётчик скачиваний: инкремент может любой (через security definer RPC) ──
create or replace function public.bump_community_download(p_id uuid)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update public.community_plugins set downloads = downloads + 1 where id = p_id;
$$;

-- ============================================================================
--  Премиум-чат — единая общая комната для всех premium-подписчиков
--  Читать и писать могут только пользователи с premium (public.has_premium(),
--  включает владельца). Доставка новых сообщений — через Realtime (см. ниже).
-- ============================================================================
create table if not exists public.premium_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  author      text not null,                       -- снимок display_name на момент отправки
  text        text not null check (char_length(text) between 1 and 2000),
  created_at  timestamptz not null default now()
);

create index if not exists premium_messages_created_at_idx
  on public.premium_messages (created_at);

alter table public.premium_messages enable row level security;

-- Читают только premium-пользователи.
drop policy if exists premium_messages_select on public.premium_messages;
create policy premium_messages_select on public.premium_messages
  for select to authenticated
  using (public.has_premium());

-- Пишет premium-пользователь только от своего имени; длину дублируем (defense-in-depth).
drop policy if exists premium_messages_insert on public.premium_messages;
create policy premium_messages_insert on public.premium_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.has_premium()
    and char_length(text) between 1 and 2000
  );

-- Удалять (модерация) может только владелец приложения.
drop policy if exists premium_messages_delete_owner on public.premium_messages;
create policy premium_messages_delete_owner on public.premium_messages
  for delete to authenticated
  using (public.is_owner());

-- ─── Realtime: публикуем INSERT'ы таблицы (RLS применяется к подписчику) ─────
-- Realtime проверяет RLS для подключённого пользователя, поэтому сообщения
-- получат только premium-подписчики.
alter table public.premium_messages replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'premium_messages'
  ) then
    alter publication supabase_realtime add table public.premium_messages;
  end if;
end
$$;

-- ============================================================================
--  Legacy Supabase Storage: bucket для пользовательских файлов (публичный на чтение)
--  Текущий клиент загружает новые файлы через storage-proxy в Cloud.ru Object Storage.
--  Эти политики оставлены для старых файлов/деплоев и безопасной повторной миграции.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('community-plugins', 'community-plugins', true)
on conflict (id) do nothing;

-- Чтение — публично; загрузка — любой authenticated; удаление — только владелец.
drop policy if exists community_files_select on storage.objects;
create policy community_files_select on storage.objects
  for select using (bucket_id = 'community-plugins');

drop policy if exists community_files_insert on storage.objects;
create policy community_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-plugins'
    and (
      name like auth.uid()::text || '/%'
      or name like 'flp/' || auth.uid()::text || '/%'
      or name like 'template/' || auth.uid()::text || '/%'
      or name like 'loop/' || auth.uid()::text || '/%'
      or name like 'drumkit/' || auth.uid()::text || '/%'
      or name like 'beat/' || auth.uid()::text || '/%'
      or name like 'preset/' || auth.uid()::text || '/%'
    )
  );

drop policy if exists community_files_delete on storage.objects;
create policy community_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'community-plugins' and (owner = auth.uid() or public.is_owner()));

-- ============================================================================
--  ЛИМИТЫ ПРЕМИУМА / БЕЗ ПРЕМИУМА (v2)
--  • суточный лимит автоустановок плагинов (5/сутки для free);
--  • облачная «Студия» — лог установленных плагинов для восстановления;
--  • лимиты авторов битов (3/мес + цена $2–$15 для free);
--  • авто-подъём (bump) битов премиум-авторов в выдаче.
--  Enforcement — серверный (RLS + SECURITY DEFINER RPC). Клиентские флаги в
--  Electron нужны только для UI и источником доверия не являются.
-- ============================================================================

-- ─── Суточный лимит автоустановок ───────────────────────────────────────────
-- Универсальный счётчик квот с фиксированным окном сброса. Строка на (юзер, ключ).
create table if not exists public.usage_counters (
  user_id       uuid not null references auth.users (id) on delete cascade,
  counter_key   text not null,                       -- 'auto_install_daily'
  period_start  timestamptz not null default now(),
  period_length interval not null default interval '24 hours',
  used          int not null default 0,
  primary key (user_id, counter_key)
);

alter table public.usage_counters enable row level security;
-- Прямого доступа к счётчикам у клиента нет: только через SECURITY DEFINER RPC ниже.
-- (RLS включён, политик нет → всё закрыто для обычных ключей.)

-- Атомарно списать один автоустановочный слот. Возвращает allowed/used/resets_at.
-- FOR UPDATE сериализует параллельные запросы одного юзера → защита от гонок,
-- когда клиент шлёт пачку install-запросов, чтобы проскочить лимит.
create or replace function public.consume_auto_install_quota(p_limit int)
  returns table (allowed boolean, used_after int, resets_at timestamptz)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz;
  v_used  int;
begin
  if v_uid is null then
    return query select false, 0, now();
    return;
  end if;

  insert into public.usage_counters(user_id, counter_key, period_start, period_length, used)
    values (v_uid, 'auto_install_daily', now(), interval '24 hours', 0)
    on conflict (user_id, counter_key) do nothing;

  select period_start, used into v_start, v_used
    from public.usage_counters
    where user_id = v_uid and counter_key = 'auto_install_daily'
    for update;

  -- Строгий сброс окна каждые 24 часа.
  if now() - v_start >= interval '24 hours' then
    v_start := now();
    v_used := 0;
  end if;

  if v_used < p_limit then
    v_used := v_used + 1;
    update public.usage_counters
      set used = v_used, period_start = v_start
      where user_id = v_uid and counter_key = 'auto_install_daily';
    return query select true, v_used, v_start + interval '24 hours';
  else
    update public.usage_counters
      set period_start = v_start
      where user_id = v_uid and counter_key = 'auto_install_daily';
    return query select false, v_used, v_start + interval '24 hours';
  end if;
end;
$$;

revoke execute on function public.consume_auto_install_quota(int) from public;
grant  execute on function public.consume_auto_install_quota(int) to authenticated;

-- Прочитать текущий остаток лимита БЕЗ списания (для отображения в UI).
create or replace function public.peek_auto_install_quota(p_limit int)
  returns table (used_now int, limit_val int, resets_at timestamptz)
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz;
  v_used  int;
begin
  if v_uid is null then
    return query select 0, p_limit, now();
    return;
  end if;
  select period_start, used into v_start, v_used
    from public.usage_counters
    where user_id = v_uid and counter_key = 'auto_install_daily';
  if not found or now() - v_start >= interval '24 hours' then
    return query select 0, p_limit, now() + interval '24 hours';
  else
    return query select v_used, p_limit, v_start + interval '24 hours';
  end if;
end;
$$;

revoke execute on function public.peek_auto_install_quota(int) from public;
grant  execute on function public.peek_auto_install_quota(int) to authenticated;

-- ─── Облачная «Студия» (только премиум) ─────────────────────────────────────
-- Лог успешно установленных плагинов премиум-юзера для «Восстановить студию».
create table if not exists public.plugin_installs (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade default auth.uid(),
  plugin_id     text not null,                       -- id из plugins ИЛИ community_plugins
  source        text not null default 'catalog',     -- 'catalog' | 'community'
  name          text,
  download_url  text,
  install_order int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, plugin_id)
);

create index if not exists plugin_installs_user_idx on public.plugin_installs (user_id);

alter table public.plugin_installs enable row level security;

-- Свою студию видит и восстанавливает только премиум-пользователь.
drop policy if exists plugin_installs_select on public.plugin_installs;
create policy plugin_installs_select on public.plugin_installs
  for select to authenticated
  using (user_id = auth.uid() and public.has_premium());

drop policy if exists plugin_installs_delete on public.plugin_installs;
create policy plugin_installs_delete on public.plugin_installs
  for delete to authenticated
  using (user_id = auth.uid());

-- Логировать установку через прямой insert нельзя — только через RPC (проверяет премиум).
create or replace function public.log_plugin_install(
  p_plugin_id text,
  p_source text,
  p_name text,
  p_download_url text
)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null or not public.has_premium() then
    return;                                            -- бесплатным облачную студию не ведём
  end if;
  insert into public.plugin_installs(user_id, plugin_id, source, name, download_url, install_order)
    values (
      auth.uid(),
      p_plugin_id,
      coalesce(nullif(p_source, ''), 'catalog'),
      p_name,
      p_download_url,
      coalesce((select max(install_order) + 1 from public.plugin_installs where user_id = auth.uid()), 0)
    )
    on conflict (user_id, plugin_id) do update
      set source = excluded.source,
          name = excluded.name,
          download_url = excluded.download_url,
          updated_at = now();
end;
$$;

revoke execute on function public.log_plugin_install(text, text, text, text) from public;
grant  execute on function public.log_plugin_install(text, text, text, text) to authenticated;

-- ─── Биты: цена в центах, статус премиума автора, лимиты free-авторов ────────
alter table public.community_plugins
  add column if not exists price_cents int;
alter table public.community_plugins
  add column if not exists author_is_premium boolean not null default false;

-- Индекс под ленту битов: премиум-авторы сверху, затем по свежести (bump, п.5).
create index if not exists community_plugins_beat_feed_idx
  on public.community_plugins (kind, author_is_premium desc, created_at desc);

-- Триггер BEFORE INSERT: снимок премиума автора + лимиты free-авторов битов.
create or replace function public.enforce_beat_rules()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_prem  boolean;
  v_count int;
begin
  -- Снимок статуса автора на момент публикации — для галочки (п.6) и bump (п.5).
  v_prem := public.has_premium();
  new.author_is_premium := v_prem;

  if coalesce(new.kind, 'plugin') <> 'beat' then
    return new;
  end if;

  -- Премиум-автор: безлимит и свободная цена.
  if v_prem then
    return new;
  end if;

  -- Free-автор: не более 3 битов за календарный месяц (сброс 1-го числа).
  select count(*) into v_count
    from public.community_plugins
    where uploader_id = auth.uid()
      and kind = 'beat'
      and created_at >= date_trunc('month', now());
  if v_count >= 3 then
    raise exception 'BEAT_MONTHLY_LIMIT' using errcode = 'check_violation';
  end if;

  -- Free-автор: цена строго $2..$15 (в центах 200..1500).
  if new.price_cents is null or new.price_cents < 200 or new.price_cents > 1500 then
    raise exception 'BEAT_PRICE_RANGE' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_beat_rules on public.community_plugins;
create trigger trg_enforce_beat_rules
  before insert on public.community_plugins
  for each row execute function public.enforce_beat_rules();

-- При изменении срока премиума автора — пересчитываем author_is_premium его битов
-- (для bump/галочки). Истечение «по времени» без апдейта профиля здесь не ловится;
-- его добьёт периодический пересчёт/следующее продление.
create or replace function public.sync_author_premium()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if new.premium_until is distinct from old.premium_until then
    update public.community_plugins
      set author_is_premium = (new.premium_until is not null and new.premium_until > now())
      where uploader_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_author_premium on public.profiles;
create trigger trg_sync_author_premium
  after update on public.profiles
  for each row execute function public.sync_author_premium();

-- ============================================================================
--  РЕФЕРАЛЬНАЯ ПРОГРАММА
--  Пригласи 5 «засчитанных» человек → +14 дней премиума (за каждый блок из 5).
--
--  Защита от накрутки (оба условия обязательны, чтобы реферал был «засчитан»):
--   1) возраст Discord-аккаунта приглашённого ≥ 30 дней — вычисляется на сервере
--      из snowflake, юзер подделать не может (тамперпруф);
--   2) отпечаток устройства приглашённого отличается от устройства реферера и от
--      других его рефералов — отсекает «5 своих аккаунтов на одном ПК».
--
--  ВАЖНО: отпечаток устройства формирует клиент (main-процесс), поэтому это
--  «поднять цену абуза», а не абсолютная защита (как и клиентский троттлинг).
--  Единственный по-настоящему тамперпруф-сигнал здесь — возраст Discord-аккаунта.
--  Enforcement серверный: SECURITY DEFINER RPC + иммутабельность полей в триггере
--  prevent_role_change.
-- ============================================================================

-- ─── Параметры программы (меняются здесь же в SQL) ──────────────────────────
--  • 5 засчитанных рефералов = 1 блок = +14 дней премиума;
--  • минимальный возраст Discord-аккаунта приглашённого — 30 дней.
--  Значения захардкожены в функциях ниже (referral_stats/redeem/count_qualified).

-- ─── Отпечатки устройств аккаунта ────────────────────────────────────────────
-- Строка на (пользователь, устройство). «Основное» устройство пользователя —
-- самое раннее по created_at. Прямого доступа у клиента нет: только через RPC.
create table if not exists public.account_devices (
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_hash  text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, device_hash)
);

create index if not exists account_devices_hash_idx on public.account_devices (device_hash);

alter table public.account_devices enable row level security;
-- RLS включён, политик нет → таблица закрыта для обычных ключей; работа только через RPC.

-- Зарегистрировать отпечаток устройства текущего пользователя (клиент шлёт при входе).
create or replace function public.register_device(p_hash text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_hash text := lower(coalesce(p_hash, ''));
begin
  if v_uid is null then return; end if;
  -- Принимаем только правдоподобный хеш (hex 16..128). Мусор игнорируем.
  if v_hash !~ '^[0-9a-f]{16,128}$' then return; end if;

  insert into public.account_devices (user_id, device_hash)
    values (v_uid, v_hash)
  on conflict (user_id, device_hash)
    do update set last_seen_at = now();
end;
$$;

revoke execute on function public.register_device(text) from public;
grant  execute on function public.register_device(text) to authenticated;

-- Дата создания Discord-аккаунта из snowflake (provider_id/sub в auth.users).
-- Discord epoch = 1420070400000 мс; первые 42 бита id — время. Тамперпруф.
create or replace function public.discord_created_at(p_uid uuid)
  returns timestamptz
  language plpgsql
  stable
  security definer
  set search_path = public, auth
as $$
declare
  v_sf text;
begin
  select coalesce(raw_user_meta_data ->> 'provider_id', raw_user_meta_data ->> 'sub')
    into v_sf
    from auth.users
    where id = p_uid;
  if v_sf is null or v_sf !~ '^\d{5,25}$' then
    return null;
  end if;
  return to_timestamp((((v_sf)::numeric::bigint >> 22) + 1420070400000) / 1000.0);
exception when others then
  return null;
end;
$$;

revoke execute on function public.discord_created_at(uuid) from public;

-- Основное устройство пользователя — самое раннее зарегистрированное.
create or replace function public.primary_device(p_uid uuid)
  returns text
  language sql
  stable
  security definer
  set search_path = public
as $$
  select device_hash
    from public.account_devices
    where user_id = p_uid
    order by created_at asc, device_hash asc
    limit 1;
$$;

revoke execute on function public.primary_device(uuid) from public;

-- Число «засчитанных» рефералов реферера p_referrer.
-- Реферал засчитан, если: приглашён p_referrer'ом, у него есть основное устройство,
-- оно отличается от устройства реферера, Discord-аккаунту ≥ 30 дней, и это самый
-- ранний реферал для данного устройства (дедуп: одно устройство — один засчёт).
create or replace function public.count_qualified_referrals(p_referrer uuid)
  returns int
  language sql
  stable
  security definer
  set search_path = public
as $$
  with referrer_dev as (
    select public.primary_device(p_referrer) as dev
  ),
  refs as (
    select
      p.id,
      p.created_at,
      public.primary_device(p.id) as dev,
      public.discord_created_at(p.id) as born
    from public.profiles p
    where p.referred_by = p_referrer
  ),
  eligible as (
    select
      r.id,
      row_number() over (partition by r.dev order by r.created_at asc, r.id asc) as rn
    from refs r, referrer_dev rd
    where r.dev is not null
      and rd.dev is not null
      and r.dev <> rd.dev
      and r.born is not null
      and r.born <= now() - interval '30 days'
  )
  select coalesce(count(*), 0)::int from eligible where rn = 1;
$$;

revoke execute on function public.count_qualified_referrals(uuid) from public;

-- Статус реферальной программы для текущего пользователя (для UI).
-- Volatile: заодно бутстрапит referral_code, если его почему-то нет.
create or replace function public.referral_stats()
  returns table (
    referral_code     text,
    invited           int,
    qualified         int,
    rewards_granted   int,
    rewards_available int,
    referred          boolean
  )
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_code    text;
  v_granted int;
  v_ref     boolean;
  v_qual    int;
begin
  if v_uid is null then return; end if;

  select p.referral_code, coalesce(p.referral_rewards_granted, 0), (p.referred_by is not null)
    into v_code, v_granted, v_ref
    from public.profiles p
    where p.id = v_uid
    for update;

  if v_code is null then
    perform set_config('app.allow_priv_change', 'on', true);
    v_code := public.new_referral_code();
    update public.profiles set referral_code = v_code where id = v_uid;
  end if;

  v_qual := public.count_qualified_referrals(v_uid);

  referral_code     := v_code;
  invited           := (select count(*)::int from public.profiles where referred_by = v_uid);
  qualified         := v_qual;
  rewards_granted   := v_granted;
  rewards_available := greatest(0, (v_qual / 5) - v_granted);
  referred          := v_ref;
  return next;
end;
$$;

revoke execute on function public.referral_stats() from public;
grant  execute on function public.referral_stats() to authenticated;

-- Активировать код друга (ставит referred_by текущему пользователю).
-- Возвращает: 'ok' | 'invalid' | 'already' | 'self' | 'self_device' | 'unauthorized'.
create or replace function public.claim_referral(p_code text)
  returns text
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_norm     text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_referrer uuid;
  v_existing uuid;
  v_my_dev   text;
  v_ref_dev  text;
begin
  if v_uid is null then return 'unauthorized'; end if;
  if v_norm = '' then return 'invalid'; end if;

  select id into v_referrer from public.profiles where referral_code = v_norm;
  if v_referrer is null then return 'invalid'; end if;
  if v_referrer = v_uid then return 'self'; end if;

  -- referred_by ставится один раз.
  select referred_by into v_existing from public.profiles where id = v_uid for update;
  if v_existing is not null then return 'already'; end if;

  -- Нельзя активировать код с того же устройства, что и у пригласившего.
  v_my_dev  := public.primary_device(v_uid);
  v_ref_dev := public.primary_device(v_referrer);
  if v_my_dev is not null and v_ref_dev is not null and v_my_dev = v_ref_dev then
    return 'self_device';
  end if;

  perform set_config('app.allow_priv_change', 'on', true);
  update public.profiles set referred_by = v_referrer, updated_at = now() where id = v_uid;
  return 'ok';
end;
$$;

revoke execute on function public.claim_referral(text) from public;
grant  execute on function public.claim_referral(text) to authenticated;

-- Начислить премиум за новые блоки из 5 засчитанных рефералов (+14 дней за блок).
-- Идемпотентно: доначисляет только блоки сверх referral_rewards_granted.
create or replace function public.redeem_referral_rewards()
  returns table (granted int, premium_until timestamptz, qualified int)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_qual    int;
  v_blocks  int;
  v_granted int;
  v_new     int;
  v_until   timestamptz;
begin
  if v_uid is null then return; end if;

  select coalesce(referral_rewards_granted, 0), premium_until
    into v_granted, v_until
    from public.profiles
    where id = v_uid
    for update;

  v_qual   := public.count_qualified_referrals(v_uid);
  v_blocks := v_qual / 5;
  v_new    := v_blocks - v_granted;

  if v_new <= 0 then
    granted := 0; premium_until := v_until; qualified := v_qual;
    return next;
    return;
  end if;

  perform set_config('app.allow_priv_change', 'on', true);
  update public.profiles
    set premium_until = greatest(coalesce(premium_until, now()), now()) + make_interval(days => v_new * 14),
        premium = true,
        referral_rewards_granted = v_blocks,
        updated_at = now()
    where id = v_uid
    returning premium_until into v_until;

  granted := v_new; premium_until := v_until; qualified := v_qual;
  return next;
end;
$$;

revoke execute on function public.redeem_referral_rewards() from public;

-- ─── VirusTotal proxy: общий rate-limit ────────────────────────────────────
-- Единственная строка-семафор для supabase/functions/vt-proxy. Реальный VT
-- API-ключ живёт только в Edge Function (Supabase secret), которая делит
-- один и тот же троттлинг-бюджет (~4 запр/мин на free tier VT) между ВСЕМИ
-- пользователями сразу — поэтому очередь не может жить в памяти одного
-- вызова функции и хранится здесь, апдейт атомарный (see vt-proxy/index.ts).
create table if not exists public.vt_rate_limit (
  id               boolean primary key default true check (id),
  last_request_at  timestamptz not null default '-infinity'
);
insert into public.vt_rate_limit (id) values (true) on conflict do nothing;

alter table public.vt_rate_limit enable row level security;
-- Доступа у клиента нет вообще: читает/пишет только service-role внутри
-- Edge Function (RLS включён, политик нет → закрыто для anon/authenticated).
grant  execute on function public.redeem_referral_rewards() to authenticated;

-- ─── AI-ассистент: общий rate-limit прокси + квоты пользователей ───────────
-- Единственная строка-семафор для supabase/functions/ai-proxy, тот же приём,
-- что и vt_rate_limit выше: один бесплатный OpenRouter-ключ делится между
-- ВСЕМИ пользователями сразу, поэтому троттлинг живёт здесь, а не в памяти
-- одного вызова функции (см. throttle() в ai-proxy/index.ts).
create table if not exists public.ai_rate_limit (
  id               boolean primary key default true check (id),
  last_request_at  timestamptz not null default '-infinity'
);
insert into public.ai_rate_limit (id) values (true) on conflict do nothing;

alter table public.ai_rate_limit enable row level security;
-- Доступа у клиента нет вообще: читает/пишет только service-role внутри Edge Function.

-- Параметризованные версии consume_auto_install_quota/peek_auto_install_quota
-- (см. выше): та же таблица usage_counters, но counter_key передаётся
-- аргументом, а не зашит в тело функции — так одна пара RPC обслуживает и
-- 'ai_chat_daily', и 'ai_recommend_daily' с разными лимитами.
create or replace function public.consume_named_quota(p_counter_key text, p_limit int, p_period interval default interval '24 hours')
  returns table (allowed boolean, used_after int, resets_at timestamptz)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz;
  v_used  int;
begin
  if v_uid is null then
    return query select false, 0, now();
    return;
  end if;

  insert into public.usage_counters(user_id, counter_key, period_start, period_length, used)
    values (v_uid, p_counter_key, now(), p_period, 0)
    on conflict (user_id, counter_key) do nothing;

  select period_start, used into v_start, v_used
    from public.usage_counters
    where user_id = v_uid and counter_key = p_counter_key
    for update;

  if now() - v_start >= p_period then
    v_start := now();
    v_used := 0;
  end if;

  if v_used < p_limit then
    v_used := v_used + 1;
    update public.usage_counters
      set used = v_used, period_start = v_start, period_length = p_period
      where user_id = v_uid and counter_key = p_counter_key;
    return query select true, v_used, v_start + p_period;
  else
    update public.usage_counters
      set period_start = v_start, period_length = p_period
      where user_id = v_uid and counter_key = p_counter_key;
    return query select false, v_used, v_start + p_period;
  end if;
end;
$$;

revoke execute on function public.consume_named_quota(text, int, interval) from public;
grant  execute on function public.consume_named_quota(text, int, interval) to authenticated;

-- Прочитать текущий остаток именованного лимита БЕЗ списания (для UI).
create or replace function public.peek_named_quota(p_counter_key text, p_limit int, p_period interval default interval '24 hours')
  returns table (used_now int, limit_val int, resets_at timestamptz)
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz;
  v_used  int;
begin
  if v_uid is null then
    return query select 0, p_limit, now();
    return;
  end if;
  select period_start, used into v_start, v_used
    from public.usage_counters
    where user_id = v_uid and counter_key = p_counter_key;
  if not found or now() - v_start >= p_period then
    return query select 0, p_limit, now() + p_period;
  else
    return query select v_used, p_limit, v_start + p_period;
  end if;
end;
$$;

revoke execute on function public.peek_named_quota(text, int, interval) from public;
grant  execute on function public.peek_named_quota(text, int, interval) to authenticated;

-- ─── Streak-система (подпроект 2 Блока 1) ───────────────────────────────────
-- Считаем подряд идущие календарные дни (UTC) захода. Пороги 3/7/28 → выбор
-- одной из двух наград. Все 8 колонок под защитой prevent_role_change (ниже).
alter table public.profiles
  add column if not exists streak_count           int  not null default 0;
alter table public.profiles
  add column if not exists streak_last_date       date;
alter table public.profiles
  add column if not exists streak_reward_stage     int  not null default 0;
alter table public.profiles
  add column if not exists streak_reward_pending   boolean not null default false;
alter table public.profiles
  add column if not exists bonus_beat_slots        int  not null default 0;
alter table public.profiles
  add column if not exists bonus_beat_slots_month  date;
alter table public.profiles
  add column if not exists bonus_download_slots    int  not null default 0;
alter table public.profiles
  add column if not exists bonus_download_slots_month date;

-- ─── touch_streak() ─────────────────────────────────────────────────────────
-- Раз за сессию отмечает заход. Идемпотентно в рамках дня (diff=0 → no-op).
-- Не выдаёт награду сама — только взводит reward_pending на порогах 3/7/28.
create or replace function public.touch_streak()
  returns table (streak_count int, reward_pending boolean, reward_stage int)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid     uuid    := auth.uid();
  v_today   date    := (now() at time zone 'utc')::date;
  v_last    date;
  v_count   int;
  v_stage   int;
  v_pending boolean;
  v_diff    int;
begin
  if v_uid is null then
    return;
  end if;

  select p.streak_last_date,
         coalesce(p.streak_count, 0),
         coalesce(p.streak_reward_stage, 0),
         coalesce(p.streak_reward_pending, false)
    into v_last, v_count, v_stage, v_pending
    from public.profiles p
    where p.id = v_uid
    for update;

  if v_last is null then
    v_count := 1;
    v_stage := 0;
    v_pending := false;
  else
    v_diff := v_today - v_last;
    if v_diff = 0 then
      -- Тот же день: ничего не меняем, отдаём текущее состояние.
      streak_count  := v_count;
      reward_pending := v_pending;
      reward_stage  := v_stage;
      return next;
      return;
    elsif v_diff = 1 then
      v_count := v_count + 1;
    else
      -- Пропуск дня — безусловный сброс.
      v_count := 1;
      v_stage := 0;
      v_pending := false;
    end if;
  end if;

  -- Порог достигнут впервые в этом цикле → взводим pending.
  if v_count in (3, 7, 28) and v_stage < v_count then
    v_stage   := v_count;
    v_pending := true;
  end if;

  perform set_config('app.allow_priv_change', 'on', true);
  update public.profiles
    set streak_count          = v_count,
        streak_last_date      = v_today,
        streak_reward_stage   = v_stage,
        streak_reward_pending = v_pending
    where id = v_uid;

  streak_count  := v_count;
  reward_pending := v_pending;
  reward_stage  := v_stage;
  return next;
end;
$$;

revoke execute on function public.touch_streak() from public;
grant  execute on function public.touch_streak() to authenticated;

-- ─── claim_streak_reward(p_choice text) ─────────────────────────────────────
-- Выбор награды. Начисляет бонус текущего месяца, гасит pending.
-- На пороге 28 после выбора — стартует новый цикл (streak_count = 1).
create or replace function public.claim_streak_reward(p_choice text)
  returns table (streak_count int)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_pending boolean;
  v_stage   int;
  v_count   int;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  if p_choice is null or p_choice not in ('beat', 'download') then
    raise exception 'bad_choice';
  end if;

  select coalesce(p.streak_reward_pending, false),
         coalesce(p.streak_reward_stage, 0),
         coalesce(p.streak_count, 0)
    into v_pending, v_stage, v_count
    from public.profiles p
    where p.id = v_uid
    for update;

  if not v_pending then
    raise exception 'no_reward';
  end if;

  perform set_config('app.allow_priv_change', 'on', true);
  if p_choice = 'beat' then
    update public.profiles
      set bonus_beat_slots       = coalesce(bonus_beat_slots, 0) + 1,
          bonus_beat_slots_month = date_trunc('month', now())::date,
          streak_reward_pending  = false
      where id = v_uid;
  else
    update public.profiles
      set bonus_download_slots       = coalesce(bonus_download_slots, 0) + 1,
          bonus_download_slots_month = date_trunc('month', now())::date,
          streak_reward_pending      = false
      where id = v_uid;
  end if;

  if v_stage = 28 then
    update public.profiles
      set streak_count = 1, streak_reward_stage = 0
      where id = v_uid;
    v_count := 1;
  end if;

  streak_count := v_count;
  return next;
end;
$$;

revoke execute on function public.claim_streak_reward(text) from public;
grant  execute on function public.claim_streak_reward(text) to authenticated;
