import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { hostname, networkInterfaces, platform } from 'os'
import { ipcMain, BrowserWindow } from 'electron'
import { supabase } from './supabase'
import { rejectUntrustedSender } from './ipc-security'
import { toSafeError } from './errors'

const execFileAsync = promisify(execFile)

/**
 * Реферальная программа. Вся серверная логика (кто «засчитан», начисление премиума)
 * живёт в SECURITY DEFINER функциях Supabase (см. supabase/schema.sql). Здесь —
 * тонкие обёртки над RPC и вычисление отпечатка устройства.
 *
 * Анти-абуз: реферал засчитывается, только если у приглашённого Discord-аккаунт
 * старше 30 дней (проверяется на сервере по snowflake — подделать нельзя) И он
 * заходил с другого устройства, чем реферер и остальные его рефералы. Отпечаток
 * устройства формируется здесь, в доверенном main-процессе, и отправляется на
 * сервер через register_device. Это «поднимает цену» массового абуза с одного ПК,
 * но, как и клиентский троттлинг, не является абсолютной защитой: возраст Discord —
 * единственный по-настоящему тамперпруф-сигнал.
 */

// ─── Отпечаток устройства ────────────────────────────────────────────────────

const DEVICE_SALT = 'plughub-device-v1'

/**
 * Стабильный идентификатор установки Windows (реестр). Приложение и так под админом.
 * Асинхронный вызов: execFileSync блокировал единственный поток main-процесса
 * (а с ним — обработку всех IPC) на всё время работы reg.exe, до 4 секунд по таймауту.
 */
async function windowsMachineGuid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 4000 }
    )
    const m = stdout.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/i)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Первый не-внутренний MAC — запасной идентификатор, если MachineGuid недоступен. */
function firstMacAddress(): string {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac
    }
  }
  return ''
}

async function rawMachineId(): Promise<string> {
  if (platform() === 'win32') {
    const guid = await windowsMachineGuid()
    if (guid) return `guid:${guid}`
  }
  // macOS/Linux (или Windows без доступа к реестру): hostname + MAC.
  return `host:${hostname()}|mac:${firstMacAddress()}`
}

/** SHA-256 отпечаток машины (64 hex-символа). Соль скрывает исходный MachineGuid. */
export async function computeDeviceHash(): Promise<string> {
  return createHash('sha256').update(`${DEVICE_SALT}|${await rawMachineId()}`).digest('hex')
}

// ─── Регистрация устройства (best-effort, один раз на пользователя за запуск) ──

let lastRegisteredUser: string | null = null
// Промис текущей попытки регистрации — чтобы конкурентные вызовы (например, из
// первичного getState() и из onAuthStateChange почти одновременно при старте)
// не запускали computeDeviceHash()/reg.exe параллельно друг с другом.
let registrationInFlight: Promise<void> | null = null

/**
 * Отправляет отпечаток текущего устройства на сервер. Вызывается при входе и при
 * обращениях к реферальному API. Тихо игнорирует ошибки — регистрация устройства
 * не должна ломать основной поток.
 */
export async function registerDeviceBestEffort(): Promise<void> {
  if (registrationInFlight) return registrationInFlight
  registrationInFlight = (async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const uid = data.session?.user?.id
      if (!uid) {
        lastRegisteredUser = null
        return
      }
      if (lastRegisteredUser === uid) return
      const { error } = await supabase.rpc('register_device', { p_hash: await computeDeviceHash() })
      if (!error) lastRegisteredUser = uid
    } catch {
      /* best-effort */
    } finally {
      registrationInFlight = null
    }
  })()
  return registrationInFlight
}

// ─── Wire-типы (зеркалятся в preload/index.ts и renderer/types.ts) ────────────

export interface ReferralStats {
  ok: boolean
  error?: string
  /** Личный код приглашения. */
  code?: string
  /** Готовая ссылка-приглашение (сайт web/, страница /r/<code>) — та же активация, что и по коду. */
  inviteLink?: string
  /** Сколько всего человек перешло по коду. */
  invited?: number
  /** Сколько из них «засчитано» (прошли анти-абуз). */
  qualified?: number
  /** Сколько блоков премиума уже получено. */
  rewardsGranted?: number
  /** Сколько блоков премиума можно получить прямо сейчас. */
  rewardsAvailable?: number
  /** Пользователь уже перешёл по чьему-то коду (referred_by задан). */
  referred?: boolean
  /** Рефералов на один блок награды (5). */
  perReward?: number
  /** Дней премиума за блок (14). */
  rewardDays?: number
}

export interface ReferralActionResult {
  ok: boolean
  error?: string
}

export interface ReferralRedeemResult {
  ok: boolean
  error?: string
  /** Сколько дней премиума начислено этим вызовом. */
  grantedDays?: number
  /** Новый срок действия премиума (ISO). */
  premiumUntil?: string | null
}

/** Рефералов на один блок и дней за блок — держим синхронно с schema.sql. */
const REFERRALS_PER_REWARD = 5
const REWARD_DAYS = 14

// TODO: заменить на реальный домен после деплоя web/ (см. web/README.md).
// Используется только для сборки ссылки-приглашения (SITE_URL + /r/<code>) —
// сама активация не зависит от домена, страница на сайте лишь показывает код
// и пытается открыть приложение по ссылке plughub://ref/<code>.
const SITE_URL = 'https://plughub.app'

function rpcRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined
}

// ─── Операции ─────────────────────────────────────────────────────────────────

export async function getReferralStats(): Promise<ReferralStats> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) {
    return { ok: false, error: 'Войдите, чтобы участвовать в реферальной программе.' }
  }
  await registerDeviceBestEffort()
  try {
    const { data, error } = await supabase.rpc('referral_stats')
    if (error) throw error
    const row = rpcRow<{
      referral_code: string
      invited: number
      qualified: number
      rewards_granted: number
      rewards_available: number
      referred: boolean
    }>(data)
    return {
      ok: true,
      code: row?.referral_code,
      inviteLink: row?.referral_code ? `${SITE_URL}/r/${row.referral_code}` : undefined,
      invited: row?.invited ?? 0,
      qualified: row?.qualified ?? 0,
      rewardsGranted: row?.rewards_granted ?? 0,
      rewardsAvailable: row?.rewards_available ?? 0,
      referred: !!row?.referred,
      perReward: REFERRALS_PER_REWARD,
      rewardDays: REWARD_DAYS
    }
  } catch (e) {
    return { ok: false, error: toSafeError(e, 'Не удалось получить реферальную награду.', '[Supabase] referral:redeem error') }
  }
}

export async function claimReferral(code: string): Promise<ReferralActionResult> {
  const trimmed = (code ?? '').trim().toUpperCase()
  if (!trimmed) return { ok: false, error: 'Введите код друга.' }

  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Войдите, чтобы активировать код.' }
  // Регистрируем устройство до активации: нужно для проверки self_device на сервере.
  await registerDeviceBestEffort()

  try {
    const { data, error } = await supabase.rpc('claim_referral', { p_code: trimmed })
    if (error) throw error
    switch (String(data)) {
      case 'ok':
        return { ok: true }
      case 'self':
        return { ok: false, error: 'Нельзя пригласить самого себя.' }
      case 'self_device':
        return {
          ok: false,
          error: 'Код нельзя активировать с того же устройства, что и у пригласившего.'
        }
      case 'already':
        return { ok: false, error: 'Вы уже перешли по чьему-то коду.' }
      case 'unauthorized':
        return { ok: false, error: 'Войдите, чтобы активировать код.' }
      case 'invalid':
      default:
        return { ok: false, error: 'Код не найден. Проверьте правильность ввода.' }
    }
  } catch (e) {
    return { ok: false, error: toSafeError(e, 'Не удалось активировать реферальный код.', '[Supabase] referral:claim error') }
  }
}

export async function redeemReferralRewards(): Promise<ReferralRedeemResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Войдите, чтобы получить награду.' }

  try {
    const { data, error } = await supabase.rpc('redeem_referral_rewards')
    if (error) throw error
    const row = rpcRow<{ granted: number; premium_until: string | null; qualified: number }>(data)
    const granted = row?.granted ?? 0
    if (granted <= 0) {
      return {
        ok: false,
        error: `Пока нет доступных наград. Нужно ${REFERRALS_PER_REWARD} засчитанных рефералов.`
      }
    }
    // Премиум только что продлился в БД (RPC) — пересобираем и рассылаем auth-состояние,
    // чтобы бейджи/настройки в открытых окнах обновились без ручного перезахода.
    const { refreshAndBroadcast } = await import('./auth')
    void refreshAndBroadcast()
    return {
      ok: true,
      grantedDays: granted * REWARD_DAYS,
      premiumUntil: row?.premium_until ?? null
    }
  } catch (e) {
    return { ok: false, error: toSafeError(e, 'Не удалось получить реферальную награду.', '[Supabase] referral:redeem error') }
  }
}

// ─── Приглашение по ссылке (plughub://ref/<code>) ────────────────────────────
//
// Помимо ручного ввода, код теперь можно передать ссылкой — регистрацию протокола
// и разбор argv/open-url см. в src/main/index.ts. Сюда долетает уже голый код,
// дальше он идёт через тот же claim_referral(), что и ручной ввод: сервер не
// различает источник кода, поэтому антиабуз-логика не дублируется.

export interface ReferralDeepLinkResult extends ReferralActionResult {
  code: string
}

/** Код, дождавшийся входа пользователя (ссылку открыли до авторизации в приложении). */
let pendingLinkCode: string | null = null
/** Последний результат обработки ссылки — подстраховка от гонки при холодном старте:
 *  окно может ещё не успеть подписаться на 'referral:deepLinkResult', когда ссылка
 *  уже обработана, поэтому рендерер дополнительно «дотягивается» за ним сам. */
let lastDeepLinkResult: ReferralDeepLinkResult | null = null

/** Достаёт код из plughub://ref/<CODE> или plughub://ref?code=<CODE>. Иначе — null. */
export function parseReferralDeepLink(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'plughub:' || url.hostname !== 'ref') return null
  const fromQuery = url.searchParams.get('code')
  const fromPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const code = (fromQuery || fromPath || '').trim()
  return code || null
}

function broadcastDeepLinkResult(result: ReferralDeepLinkResult): void {
  lastDeepLinkResult = result
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('referral:deepLinkResult', result)
  }
}

/**
 * Обрабатывает переход по реферальной ссылке. Если пользователь уже вошёл — код
 * активируется сразу. Если нет — запоминается и активируется автоматически сразу
 * после входа (см. подписку ниже).
 */
export async function handleReferralDeepLink(rawCode: string): Promise<void> {
  const code = (rawCode ?? '').trim()
  if (!code) return

  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) {
    pendingLinkCode = code
    return
  }
  const res = await claimReferral(code)
  broadcastDeepLinkResult({ ...res, code })
}

// Как только пользователь входит — если ссылку открывали до авторизации, код
// активируется сам, без повторного клика в приложении.
supabase.auth.onAuthStateChange((event, session) => {
  if (event !== 'SIGNED_IN' || !session || !pendingLinkCode) return
  const code = pendingLinkCode
  pendingLinkCode = null
  claimReferral(code).then((res) => broadcastDeepLinkResult({ ...res, code }))
})

// ─── IPC ────────────────────────────────────────────────────────────────────────

let ipcInitialized = false

/**
 * Регистрирует IPC-каналы реферальной программы. Безопасно вызывать многократно.
 */
export function registerReferralIpc(): void {
  if (ipcInitialized) return
  ipcInitialized = true

  // См. rejectUntrustedSender в auth.ts registerAuthIpc — та же логика, тот же смысл.
  ipcMain.handle('referral:stats', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return getReferralStats()
  })
  ipcMain.handle('referral:claim', (event, code: string) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return claimReferral(code)
  })
  ipcMain.handle('referral:redeem', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return redeemReferralRewards()
  })
  // Рендерер вызывает это один раз при монтировании — забирает результат ссылки,
  // если она была обработана до того, как окно успело подписаться на push-событие.
  ipcMain.handle('referral:consumeDeepLinkResult', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return null
    const result = lastDeepLinkResult
    lastDeepLinkResult = null
    return result
  })
}
