import { ipcMain, BrowserWindow, shell } from 'electron'
import http from 'http'
import type { AuthError, Session, User } from '@supabase/supabase-js'
import { supabase, type UserRole } from './supabase'
import { registerDeviceBestEffort } from './referral'
import { rejectUntrustedSender } from './ipc-security'
import { toSafeError } from './errors'

/**
 * Авторизация целиком живёт в main-процессе. Renderer общается с ней только через IPC
 * и НИКОГДА не видит токенов — это исключает их утечку через XSS/devtools в окне.
 *
 * Вход — через Discord OAuth (нативный провайдер Supabase):
 *   1. signInWithDiscord() поднимает локальный loopback-сервер на 127.0.0.1 и открывает
 *      в системном браузере страницу авторизации Discord (через Supabase);
 *   2. после подтверждения Discord → Supabase редиректит браузер на наш loopback-URL
 *      с одноразовым `code`;
 *   3. loopback-сервер ловит `code`, обменивает его на сессию (exchangeCodeForSession).
 *
 * Loopback вместо custom-протокола выбран намеренно: приложение запускается с правами
 * администратора (установка VST3 в Program Files), а возврат через custom-протокол
 * вызывал бы лишний перезапуск и UAC-запрос. HTTP-колбэк приходит прямо в уже
 * запущенный процесс — без перезапуска.
 *
 * Настройка на стороне Supabase/Discord описана в DISCORD_AUTH_SETUP.md.
 */

// ─── Конфигурация ───────────────────────────────────────────────────────────────

/**
 * Discord ID пользователей, которым при входе автоматически выдаётся роль «author»
 * (доступ к загрузке плагинов). ID — это «снежинка» аккаунта Discord (18–19 цифр).
 * Как узнать свой ID: Discord → Настройки → Расширенные → включить «Режим разработчика»,
 * затем ПКМ по своему аватару → «Копировать ID пользователя».
 */
const AUTHOR_DISCORD_IDS: string[] = [
  // '123456789012345678',
]

/**
 * Discord ID пользователей с премиум-подпиской — им разрешено выкладывать биты
 * на продажу (вкладка «Биты»). Авторы получают премиум автоматически.
 * Сюда добавляются ID тех, кто оформил подписку (вручную / по факту оплаты).
 */
const PREMIUM_DISCORD_IDS: string[] = [
  // '123456789012345678',
]

/**
 * Discord ID владельцев приложения — им доступна вкладка «Ключи» (генерация
 * премиум-кодов прямо в приложении). ДОЛЖЕН совпадать со списком owner_ids в
 * функции public.is_owner() в supabase/schema.sql — там серверная проверка прав.
 */
const OWNER_DISCORD_IDS: string[] = [
  '1235673671658377238',
]

/** Фиксированный порт loopback-сервера. Должен совпадать с Redirect URL в Supabase. */
const LOOPBACK_PORT = 8743
const REDIRECT_URL = `http://127.0.0.1:${LOOPBACK_PORT}/callback`

/** Время ожидания подтверждения в браузере, после которого попытка считается неудачной. */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

// HTML, который видит пользователь во вкладке браузера после возврата.
const RESPONSE_HTML = (ok: boolean): string => `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>PlugHub</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#09090c;color:#f0f0f4;
       font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .card{text-align:center;max-width:360px;padding:32px}
  h1{font-size:18px;margin:0 0 8px}
  p{font-size:14px;color:#8a8a98;margin:0;line-height:1.5}
</style></head><body><div class="card">
  <h1>${ok ? 'Вход выполнен' : 'Не удалось войти'}</h1>
  <p>${ok ? 'Можно закрыть эту вкладку и вернуться в PlugHub.' : 'Вернитесь в PlugHub и попробуйте снова.'}</p>
</div></body></html>`

// ─── Wire-типы (зеркалятся в preload/index.ts и renderer/types.ts) ───────────────

export type AuthStatus = 'signedOut' | 'signedIn'

export interface AuthUser {
  id: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  discordId: string | null
}

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
  onboardingDaw: string | null
  onboardingGenre: string | null
}

export interface AuthResult {
  ok: boolean
  error?: string
  state?: AuthState
}

const SIGNED_OUT: AuthState = {
  status: 'signedOut', user: null, role: null, premium: false, premiumUntil: null, isOwner: false,
  onboardingCompleted: false, onboardingDaw: null, onboardingGenre: null
}

// ─── Маппинг ошибок Supabase в человекочитаемые сообщения ───────────────────────

function humanizeError(err: AuthError | Error | null, fallback: string): string {
  if (!err) return fallback
  const msg = (err.message ?? '').toLowerCase()
  if (!msg) return fallback
  if (msg.includes('fetch') || msg.includes('network'))
    return 'Нет соединения с сервером. Проверьте интернет.'
  if (msg.includes('provider') && (msg.includes('not enabled') || msg.includes('disabled')))
    return 'Вход через Discord не настроен на сервере. См. DISCORD_AUTH_SETUP.md.'
  if (msg.includes('redirect') && msg.includes('not allowed'))
    return 'Redirect URL не разрешён в Supabase. Добавьте его в URL Configuration.'
  if (msg.includes('expired')) return 'Сессия входа истекла. Попробуйте снова.'
  if (msg.includes('access_denied') || msg.includes('cancel'))
    return 'Авторизация в Discord отменена.'
  return toSafeError(err, fallback)
}

// ─── Извлечение данных профиля из сессии Discord ─────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Discord «снежинка» пользователя — основной идентификатор для назначения роли. */
function discordIdOf(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const fromMeta = str(meta.provider_id) ?? str(meta.sub)
  if (fromMeta) return fromMeta

  const ident = user.identities?.find((i) => i.provider === 'discord')
  if (ident) {
    const data = (ident.identity_data ?? {}) as Record<string, unknown>
    return str(data.provider_id) ?? str(data.sub) ?? str(ident.id)
  }
  return null
}

function displayNameOf(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const claims = (meta.custom_claims ?? {}) as Record<string, unknown>
  return (
    str(meta.full_name) ??
    str(meta.name) ??
    str(meta.user_name) ??
    str(claims.global_name) ??
    (user.email ? user.email.split('@')[0] : null)
  )
}

/**
 * Базовое состояние из сессии (без обращения к БД). Премиум здесь — только из
 * статичных источников: роль «author» и allow-list Discord ID. Премиум, выданный
 * по коду активации, дочитывается из БД в buildState().
 */
function buildBaseState(session: Session | null): AuthState {
  if (!session?.user) return SIGNED_OUT
  const user = session.user
  const discordId = discordIdOf(user)
  // Роль вычисляется из allow-list Discord ID (а не из БД) — см. AUTHOR_DISCORD_IDS.
  const role: UserRole = discordId && AUTHOR_DISCORD_IDS.includes(discordId) ? 'author' : 'user'
  const isOwner = !!(discordId && OWNER_DISCORD_IDS.includes(discordId))
  // Премиум: явный allow-list ИЛИ автор (владельцы приложения — всегда премиум).
  const premium =
    role === 'author' || isOwner || !!(discordId && PREMIUM_DISCORD_IDS.includes(discordId))
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>

  return {
    status: 'signedIn',
    user: {
      id: user.id,
      email: user.email ?? null,
      displayName: displayNameOf(user),
      avatarUrl: str(meta.avatar_url) ?? str(meta.picture),
      discordId
    },
    role,
    premium,
    // Allow-list премиум (автор/владелец) — бессрочный, срока нет.
    premiumUntil: null,
    isOwner,
    onboardingCompleted: false,
    onboardingDaw: null,
    onboardingGenre: null
  }
}

/**
 * Прочитать премиум/онбординг-поля профиля из БД одним запросом. Best-effort:
 * при ошибке отдаёт безопасные дефолты (премиума/онбординга нет).
 */
async function fetchDbProfileExtras(userId: string): Promise<{
  premiumUntil: string | null
  onboardingCompleted: boolean
  onboardingDaw: string | null
  onboardingGenre: string | null
}> {
  const empty = { premiumUntil: null, onboardingCompleted: false, onboardingDaw: null, onboardingGenre: null }
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('premium_until, onboarding_completed, onboarding_daw, onboarding_genre')
      .eq('id', userId)
      .maybeSingle()
    if (error || !data) return empty
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
    return empty
  }
}

/**
 * Полное состояние авторизации: базовое + данные из БД. В БД ходим всегда, даже
 * для allow-list премиума — онбординг нужен и премиум/автор/owner пользователям.
 */
async function buildState(session: Session | null): Promise<AuthState> {
  const base = buildBaseState(session)
  if (base.status !== 'signedIn' || !base.user) return base

  // Регистрируем отпечаток устройства при каждом входе/восстановлении сессии
  // (best-effort, один раз на пользователя за запуск) — нужен для анти-абуза рефералов.
  void registerDeviceBestEffort()

  const extras = await fetchDbProfileExtras(base.user.id)
  const onboarding = {
    onboardingCompleted: extras.onboardingCompleted,
    onboardingDaw: extras.onboardingDaw,
    onboardingGenre: extras.onboardingGenre
  }

  if (base.premium) return { ...base, ...onboarding } // allow-list премиум — бессрочный, срок не нужен

  const active = extras.premiumUntil != null && new Date(extras.premiumUntil).getTime() > Date.now()
  return {
    ...base,
    premium: active,
    premiumUntil: active ? extras.premiumUntil : null,
    ...onboarding
  }
}

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

// ─── Публичные операции ─────────────────────────────────────────────────────────

export async function getState(): Promise<AuthState> {
  const { data } = await supabase.auth.getSession()
  return buildState(data.session)
}

/**
 * Пересобрать состояние авторизации и разослать его в окна. Нужно, когда премиум
 * меняется в обход redeemPremium() — например, реферальная награда начисляется
 * прямо в БД через RPC redeem_referral_rewards (см. referral.ts).
 */
export async function refreshAndBroadcast(): Promise<AuthState> {
  const { data } = await supabase.auth.getSession()
  const state = await buildState(data.session)
  broadcast(state)
  return state
}

/**
 * Активировать премиум по коду. Вызывает RPC redeem_premium_code в Supabase,
 * затем пересобирает состояние (с уже выданным премиумом) и рассылает его в окна.
 */
async function redeemPremium(code: string): Promise<AuthResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Войдите, чтобы активировать премиум.' }

  const trimmed = (code ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Введите код активации.' }

  try {
    const { data, error } = await supabase.rpc('redeem_premium_code', { p_code: trimmed })
    if (error) return { ok: false, error: humanizeError(error, 'Не удалось активировать код.') }

    switch (String(data)) {
      case 'ok': {
        const state = await buildState(sess.session)
        broadcast(state)
        return { ok: true, state }
      }
      case 'used':
        return { ok: false, error: 'Этот код уже активирован другим пользователем.' }
      case 'unauthorized':
        return { ok: false, error: 'Войдите, чтобы активировать премиум.' }
      case 'invalid':
      default:
        return { ok: false, error: 'Код не найден. Проверьте правильность ввода.' }
    }
  } catch (e) {
    return { ok: false, error: humanizeError(e as Error, 'Не удалось активировать код.') }
  }
}

/**
 * Завершить онбординг: onboarding_completed = true, плюс DAW/жанр если заданы
 * (null — пропущено). Колонки не защищены prevent_role_change — обычный update
 * под profiles_update_own, RPC не нужен (см. src/main/../supabase/schema.sql).
 */
async function completeOnboarding(daw: string | null, genre: string | null): Promise<AuthResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session?.user) return { ok: false, error: 'Войдите, чтобы продолжить.' }

  try {
    const patch: Record<string, unknown> = { onboarding_completed: true }
    if (daw != null) patch.onboarding_daw = daw
    if (genre != null) patch.onboarding_genre = genre

    const { error } = await supabase.from('profiles').update(patch).eq('id', sess.session.user.id)
    if (error) return { ok: false, error: humanizeError(error, 'Не удалось сохранить онбординг.') }

    const state = await buildState(sess.session)
    broadcast(state)
    return { ok: true, state }
  } catch (e) {
    return { ok: false, error: humanizeError(e as Error, 'Не удалось сохранить онбординг.') }
  }
}

// Состояние текущей OAuth-попытки (для возможности отмены и предотвращения дублей).
let activeServer: http.Server | null = null
let abortPending: ((reason: Error) => void) | null = null
// Поколение текущей попытки входа. Внутри signInWithDiscord() между `await` может
// успеть стартовать новый вызов и подменить activeServer/abortPending на свои —
// тогда teardownFlow() устаревшего вызова не должен закрывать чужой (актуальный) сервер.
let flowSeq = 0

function teardownFlow(): void {
  if (activeServer) {
    try {
      activeServer.close()
    } catch {
      /* ignore */
    }
    activeServer = null
  }
  abortPending = null
}

/**
 * Запускает вход через Discord. Промис держится открытым на всё время авторизации
 * в браузере и резолвится финальным состоянием (или ошибкой). Renderer показывает
 * спиннер «ожидание подтверждения», пока этот вызов не завершится.
 */
async function signInWithDiscord(): Promise<AuthResult> {
  // Прерываем предыдущую незавершённую попытку, если была.
  if (abortPending) abortPending(new Error('cancelled'))
  teardownFlow()

  // Метка именно этого вызова: если нас обгонит следующий signInWithDiscord(),
  // flowSeq изменится и isCurrent() начнёт возвращать false — это сигнал не трогать
  // чужое activeServer/abortPending и не открывать браузер повторно.
  const mySeq = ++flowSeq
  const isCurrent = (): boolean => flowSeq === mySeq

  let resolveCode!: (code: string) => void
  let rejectCode!: (err: Error) => void
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  abortPending = rejectCode

  // CSRF-защита loopback-колбэка: ждём ровно тот `state`, что Supabase положил в URL
  // авторизации. Без совпадения сторонний сайт не сможет «доставить» свой code на
  // наш локальный порт. Значение проставляется ниже, после signInWithOAuth.
  let expectedState: string | null = null

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400).end()
      return
    }
    const reqUrl = new URL(req.url, REDIRECT_URL)
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const code = reqUrl.searchParams.get('code')
    const state = reqUrl.searchParams.get('state')
    const errDesc =
      reqUrl.searchParams.get('error_description') ?? reqUrl.searchParams.get('error')

    // Колбэк с чужим/отсутствующим state игнорируем (не трогаем ожидающий промис).
    // expectedState к этому моменту всегда задан (см. ниже), поэтому отсутствие
    // совпадения — это всегда отклонение, а не «пропускаем проверку».
    if (!expectedState || state !== expectedState) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(RESPONSE_HTML(false))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(RESPONSE_HTML(!!code && !errDesc))

    if (errDesc) rejectCode(new Error(errDesc))
    else if (code) resolveCode(code)
    else rejectCode(new Error('no authorization code in callback'))
  })
  activeServer = server

  // Поднимаем loopback-сервер.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(LOOPBACK_PORT, '127.0.0.1', resolve)
    })
  } catch {
    if (isCurrent()) teardownFlow()
    return {
      ok: false,
      error: `Не удалось открыть локальный порт ${LOOPBACK_PORT}. Закройте другие приложения, использующие его, и повторите.`
    }
  }

  // Получаем URL авторизации Discord (без редиректа — мы в Node, а не в браузере).
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true }
  })
  if (error || !data?.url) {
    if (isCurrent()) teardownFlow()
    return { ok: false, error: humanizeError(error, 'Не удалось начать вход через Discord.') }
  }

  // Запоминаем state из URL авторизации — колбэк обязан вернуть тот же.
  try {
    expectedState = new URL(data.url).searchParams.get('state')
  } catch {
    expectedState = null
  }
  // Без state не сможем защититься от подделки колбэка — прерываем вход.
  if (!expectedState) {
    if (isCurrent()) teardownFlow()
    return { ok: false, error: 'Не удалось начать вход через Discord: отсутствует параметр state.' }
  }

  // Пока мы ждали сеть, нас мог обогнать новый вызов — тогда этот флоу уже отменён
  // и не должен открывать окно браузера повторно поверх актуальной попытки.
  if (!isCurrent()) return { ok: false }

  await shell.openExternal(data.url)

  const timer = setTimeout(() => rejectCode(new Error('timeout')), OAUTH_TIMEOUT_MS)
  try {
    const code = await codePromise
    const { data: exchanged, error: exErr } = await supabase.auth.exchangeCodeForSession(code)
    if (exErr) return { ok: false, error: humanizeError(exErr, 'Не удалось завершить вход.') }
    focusMainWindow()
    return { ok: true, state: await buildState(exchanged.session) }
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'cancelled') return { ok: false } // отмена пользователем — без сообщения об ошибке
    if (msg === 'timeout')
      return { ok: false, error: 'Время ожидания входа истекло. Попробуйте снова.' }
    return { ok: false, error: humanizeError(e as Error, 'Вход не выполнен.') }
  } finally {
    clearTimeout(timer)
    // Если нас уже обогнал следующий вызов signInWithDiscord(), activeServer/abortPending
    // принадлежат ЕМУ — нельзя их сносить из-под завершающегося устаревшего флоу.
    if (isCurrent()) teardownFlow()
  }
}

/** Отменить текущую попытку входа (пользователь закрыл окно ожидания). */
function cancelDiscord(): AuthResult {
  if (abortPending) abortPending(new Error('cancelled'))
  teardownFlow()
  return { ok: true, state: SIGNED_OUT }
}

async function signOut(): Promise<AuthResult> {
  const { error } = await supabase.auth.signOut()
  if (error) return { ok: false, error: humanizeError(error, 'Не удалось выйти.') }
  return { ok: true, state: SIGNED_OUT }
}

// ─── IPC + broadcast ────────────────────────────────────────────────────────────

function broadcast(state: AuthState): void {
  // Двигаем authEventSeq на каждой рассылке (не только из onAuthStateChange) — иначе
  // более старое, ещё не долетевшее событие (например, фоновый TOKEN_REFRESHED) может
  // прийти позже этого broadcast() и перезаписать в окнах уже показанное состояние.
  authEventSeq++
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('auth:changed', state)
  }
}

let initialized = false

// Монотонный номер auth-события. buildState() асинхронный (может ходить в БД за
// premium_until), поэтому события могут завершать сборку состояния не в том порядке,
// в котором пришли — иначе более старое событие рискует перезаписать в окнах уже
// показанное актуальное состояние своим устаревшим результатом.
let authEventSeq = 0

/**
 * Регистрирует IPC-каналы авторизации и подписку на изменения сессии.
 * Безопасно вызывать многократно (например, при создании нового окна) — инициализация
 * выполнится один раз.
 */
export function registerAuthIpc(): void {
  if (initialized) return
  initialized = true

  // rejectUntrustedSender — задел на будущее: сегодня посторонний фрейм в этом окне
  // недостижим (CSP frame-src 'none', webviewTag: false), но остальные 24 IPC-канала
  // в index.ts уже проверяют отправителя, и эти 5 не должны быть исключением.
  ipcMain.handle('auth:getState', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return SIGNED_OUT
    return getState()
  })
  ipcMain.handle('auth:signInDiscord', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return signInWithDiscord()
  })
  ipcMain.handle('auth:cancelDiscord', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return cancelDiscord()
  })
  ipcMain.handle('auth:signOut', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return signOut()
  })
  ipcMain.handle('auth:redeemPremium', (event, code: string) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return redeemPremium(code)
  })
  ipcMain.handle('auth:completeOnboarding', (event, daw: string | null, genre: string | null) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return completeOnboarding(daw, genre)
  })

  // Любое изменение сессии (вход, выход, авто-обновление токена) → транслируем в окна.
  supabase.auth.onAuthStateChange((_event, session) => {
    const seq = ++authEventSeq
    buildState(session).then((state) => {
      // Рассылаем только результат самого последнего по времени события — если пока
      // мы ждали (например, SELECT в profiles), пришло и уже долетело более новое
      // событие, наш ответ устарел и должен быть отброшен, а не разослан поверх.
      if (seq === authEventSeq) broadcast(state)
    })
  })
}
