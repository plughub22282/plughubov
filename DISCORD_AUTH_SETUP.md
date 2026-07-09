# Настройка входа через Discord

Приложение использует **Discord OAuth** через Supabase. Вход устроен так:

1. Пользователь нажимает «Войти через Discord».
2. Main-процесс поднимает локальный сервер на `http://127.0.0.1:8743/callback` и
   открывает в браузере страницу авторизации Discord.
3. После подтверждения Discord → Supabase возвращает браузер на этот loopback-URL
   с одноразовым `code`, который обменивается на сессию прямо в приложении.

Loopback (а не custom-протокол) выбран потому, что приложение запускается с правами
администратора — возврат через `vst3manager://` вызывал бы лишний перезапуск и UAC-запрос.

---

## 1. Создать OAuth-приложение в Discord

1. Откройте <https://discord.com/developers/applications> → **New Application**.
2. Слева **OAuth2** → раздел **Redirects** → **Add Redirect** и вставьте URL колбэка
   Supabase:

   ```
   https://akcdjxzhdesjlrqdybbo.supabase.co/auth/v1/callback
   ```

   (Это `https://<ваш-проект>.supabase.co/auth/v1/callback`. URL берётся в Supabase
   на странице провайдера Discord — см. шаг 2.)
3. Скопируйте **Client ID** и **Client Secret** (вкладка OAuth2 → General).

## 2. Включить провайдер Discord в Supabase

1. Supabase Dashboard → **Authentication → Providers → Discord**.
2. Включите провайдер, вставьте **Client ID** и **Client Secret** из шага 1.
3. Сохраните.

## 3. Разрешить loopback Redirect URL

Supabase Dashboard → **Authentication → URL Configuration → Redirect URLs** →
добавьте точный URL:

```
http://127.0.0.1:8743/callback
```

> Порт `8743` задан в `src/main/auth.ts` (`LOOPBACK_PORT`). Если меняете его там —
> поменяйте и здесь, значения должны совпадать.

## 4. Применить схему БД

Выполните `supabase/schema.sql` в **SQL Editor** (скрипт идемпотентен).

## 5. Назначить авторов (роль «author»)

Роль, дающую доступ к загрузке плагинов, приложение выдаёт по списку Discord ID.

1. В Discord включите **Настройки → Расширенные → Режим разработчика**.
2. ПКМ по своему аватару → **Копировать ID пользователя** (18–19 цифр).
3. Впишите ID в `src/main/auth.ts`:

   ```ts
   const AUTHOR_DISCORD_IDS: string[] = [
     '123456789012345678', // ваш Discord ID
   ]
   ```

Пользователи не из списка получают роль `user` (только просмотр и установка плагинов).

---

## Проверка

```bash
npm run dev
```

Нажмите «Войти через Discord» → в браузере подтвердите доступ → приложение должно
автоматически войти. Если в списке `AUTHOR_DISCORD_IDS` есть ваш ID — появится вкладка
«Загрузить плагин».
