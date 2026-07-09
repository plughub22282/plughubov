// ============================================================================
//  PlugHub Web — лёгкий монолит (Express)
//  • «/»        — публичный лендинг (public/index.html)
//  • «/admin»   — защищённая паролем панель: список пользователей + генератор
//                 премиум-ключей.
//
//  Секреты (service_role Supabase, пароль админки) живут ТОЛЬКО здесь, на
//  сервере, и никогда не попадают в браузер. Клиент общается с БД
//  исключительно через наши /api/* эндпоинты.
// ============================================================================

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const cookieParser = require('cookie-parser')
const { createClient } = require('@supabase/supabase-js')

require('dotenv').config({ path: path.join(__dirname, '.env') })

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  PORT = 3000
} = process.env

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[!] Не заданы SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY в web/.env')
  process.exit(1)
}
if (!ADMIN_PASSWORD) {
  console.error('[!] Не задан ADMIN_PASSWORD в web/.env')
  process.exit(1)
}
// Дефолт запрещён явно: строка публична (была в примере/репозитории), и с ней
// любой мог бы сам подписать себе admin-сессию.
if (!SESSION_SECRET || SESSION_SECRET === 'insecure-default-change-me') {
  console.error('[!] Не задан безопасный SESSION_SECRET в web/.env')
  process.exit(1)
}

// service_role-клиент: обходит RLS. Нужен, чтобы читать ВСЕ профили и писать
// премиум-коды. Никаких пользовательских сессий — только серверная работа.
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const app = express()
app.use(express.json())
app.use(cookieParser())

// ─── Сессия админа: HMAC-подписанный токен в httpOnly-cookie ─────────────────

const SESSION_COOKIE = 'plughub_admin'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 часов

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex')
}

/** Выдать подписанный токен вида "<expiresAt>.<hmac>". */
function issueToken() {
  const expiresAt = String(Date.now() + SESSION_TTL_MS)
  return `${expiresAt}.${sign(expiresAt)}`
}

/** Проверить токен: корректная подпись и не истёк. */
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false
  const [expiresAt, mac] = token.split('.')
  const expected = sign(expiresAt)
  // Постоянное по времени сравнение — защита от timing-атак на подпись.
  if (mac.length !== expected.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false
  return Number(expiresAt) > Date.now()
}

/** Постоянное по времени сравнение пароля. */
function passwordMatches(input) {
  const a = Buffer.from(String(input))
  const b = Buffer.from(ADMIN_PASSWORD)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ─── Защита /api/admin/login от перебора пароля ─────────────────────────────
//  Примитивный лимит по IP: после нескольких неудачных попыток — блокировка
//  на время окна. Состояние в памяти процесса — этого достаточно, т.к. сервер
//  один и без общего Redis/БД для этой цели.

const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000 // 15 минут
const loginAttempts = new Map() // ip -> { count, firstAttemptAt }

function isLoginLocked(ip) {
  const entry = loginAttempts.get(ip)
  if (!entry) return false
  if (Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip)
    return false
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS
}

function registerLoginFailure(ip) {
  const entry = loginAttempts.get(ip)
  if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttemptAt: Date.now() })
  } else {
    entry.count++
  }
}

/** Middleware: пускает дальше только с валидной admin-сессией. */
function requireAdmin(req, res, next) {
  if (verifyToken(req.cookies?.[SESSION_COOKIE])) return next()
  res.status(401).json({ error: 'Требуется вход в админ-панель.' })
}

// ─── Генерация премиум-ключей ────────────────────────────────────────────────
//  Формат и алфавит В ТОЧНОСТИ повторяют generate_premium_codes() из
//  supabase/schema.sql: 16 символов без похожих (0/O, 1/I/L), разбитые дефисами
//  на ABCD-EFGH-JKLM-NPQR. Значит, redeem_premium_code() в приложении примет
//  такой ключ без изменений — коды полностью совместимы с активацией.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // те же 31 символ, что в SQL

function randomCode() {
  const bytes = crypto.randomBytes(16)
  let raw = ''
  for (let i = 0; i < 16; i++) raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`
}

// ─── Хранилище релизов (обновления программы) ────────────────────────────────
//  Список версий лежит в web/data/releases.json. Публикуете новую версию через
//  /admin → лендинг сам показывает последнюю (endpoint /api/releases/latest).
//  Файл, а не Supabase — чтобы вам не приходилось ничего настраивать в БД.

const DATA_DIR = path.join(__dirname, 'data')
const RELEASES_FILE = path.join(DATA_DIR, 'releases.json')

function readReleases() {
  try {
    const raw = fs.readFileSync(RELEASES_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return [] // файла ещё нет или он пуст — пустой список релизов
  }
}

function writeReleases(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RELEASES_FILE, JSON.stringify(list, null, 2), 'utf8')
}

/**
 * Сравнение semver-подобных версий ('1.2.0' vs '1.10.0'). Возвращает >0, если a
 * новее b. Нечисловые части сравниваются лексикографически (для суффиксов).
 */
function compareVersions(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i], 10)
    const nb = parseInt(pb[i], 10)
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb
    } else {
      const sa = pa[i] ?? ''
      const sb = pb[i] ?? ''
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  return 0
}

/** Последний по версии релиз (или null). */
function latestRelease() {
  const list = readReleases()
  if (!list.length) return null
  return list.slice().sort((x, y) => compareVersions(y.version, x.version))[0]
}

// ─── API: авторизация ────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip
  if (isLoginLocked(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже.' })
  }
  if (!passwordMatches(req.body?.password)) {
    registerLoginFailure(ip)
    return res.status(401).json({ error: 'Неверный пароль.' })
  }
  loginAttempts.delete(ip)
  res.cookie(SESSION_COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS
  })
  res.json({ ok: true })
})

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: verifyToken(req.cookies?.[SESSION_COOKIE]) })
})

// ─── API: список пользователей ───────────────────────────────────────────────

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  const { data, error } = await admin
    .from('profiles')
    .select(
      'id, display_name, email, premium, premium_until, referral_code, referred_by, referral_rewards_granted, created_at'
    )
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })

  const now = Date.now()
  const users = (data ?? []).map((u) => ({
    ...u,
    // Источник истины «премиум активен» = premium_until в будущем (как в схеме).
    premium_active: !!u.premium_until && new Date(u.premium_until).getTime() > now
  }))
  res.json({ users, total: users.length })
})

// ─── API: список ранее выданных ключей ───────────────────────────────────────

app.get('/api/admin/keys', requireAdmin, async (_req, res) => {
  const { data, error } = await admin
    .from('premium_codes')
    .select('code, note, duration_days, redeemed_by, redeemed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ keys: data ?? [] })
})

// ─── API: генерация новых ключей ─────────────────────────────────────────────
//  Пишем напрямую в premium_codes через service_role (обходит RLS). Серверная
//  функция generate_premium_codes требует auth.uid()=владелец, которого у
//  service_role нет, поэтому вставляем сами — тем же форматом и алфавитом.

app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 200)
  const durationDays = Math.min(Math.max(parseInt(req.body?.durationDays, 10) || 30, 1), 3650)
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) || null : null

  const created = []

  // До 5 попыток на каждый ключ — на случай крайне редкой коллизии по PK.
  for (let i = 0; i < count; i++) {
    let inserted = null
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const code = randomCode()
      const { data, error } = await admin
        .from('premium_codes')
        .insert({ code, note, duration_days: durationDays })
        .select('code, note, duration_days, created_at')
        .single()

      if (!error) {
        inserted = data
      } else if (error.code !== '23505') {
        // 23505 = unique_violation → пробуем другой код. Иную ошибку возвращаем.
        return res.status(500).json({ error: error.message, created })
      }
    }
    if (!inserted) {
      return res.status(500).json({ error: 'Не удалось сгенерировать уникальный код.', created })
    }
    created.push(inserted)
  }

  res.json({ ok: true, created })
})

// ─── API: релизы (обновления программы) ──────────────────────────────────────

// Публичный: последняя версия — её читает лендинг.
app.get('/api/releases/latest', (_req, res) => {
  const latest = latestRelease()
  if (!latest) return res.json({ release: null })
  res.json({ release: latest })
})

// Публичный: весь список версий (история) — при желании показать changelog.
app.get('/api/releases', (_req, res) => {
  const list = readReleases().slice().sort((x, y) => compareVersions(y.version, x.version))
  res.json({ releases: list })
})

// Админ: опубликовать новую версию.
app.post('/api/admin/releases', requireAdmin, (req, res) => {
  const version = String(req.body?.version ?? '').trim()
  // Разрешаем цифры, точки и суффикс вида 1.2.3 или 1.2.3-beta.
  if (!/^\d+(\.\d+)*(-[0-9A-Za-z.]+)?$/.test(version)) {
    return res.status(400).json({ error: 'Некорректный номер версии. Пример: 1.4.0' })
  }

  const clean = (v, max = 500) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s ? s.slice(0, max) : null
  }
  const validUrl = (u) => {
    if (!u) return null
    try {
      const parsed = new URL(u)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return parsed.href
    } catch {
      return null
    }
  }

  const downloads = {
    windows: validUrl(clean(req.body?.windowsUrl)),
    mac: validUrl(clean(req.body?.macUrl)),
    linux: validUrl(clean(req.body?.linuxUrl))
  }
  if (!downloads.windows && !downloads.mac && !downloads.linux) {
    return res.status(400).json({ error: 'Укажите хотя бы одну ссылку на скачивание.' })
  }

  const list = readReleases()
  if (list.some((r) => r.version === version)) {
    return res.status(409).json({ error: `Версия ${version} уже опубликована. Удалите её или укажите другой номер.` })
  }

  const release = {
    version,
    notes: clean(req.body?.notes, 4000),
    downloads,
    published_at: new Date().toISOString()
  }
  list.push(release)
  writeReleases(list)
  res.json({ ok: true, release })
})

// Админ: удалить версию.
app.delete('/api/admin/releases/:version', requireAdmin, (req, res) => {
  const version = String(req.params.version)
  const list = readReleases()
  const next = list.filter((r) => r.version !== version)
  if (next.length === list.length) {
    return res.status(404).json({ error: 'Версия не найдена.' })
  }
  writeReleases(next)
  res.json({ ok: true })
})

// ─── API: реферальная ссылка ──────────────────────────────────────────────────
//  Публичный эндпоинт для страницы /r/:code — подтверждает, что код существует,
//  и (если найден) отдаёт только имя пригласившего, для персонализации страницы.
//  Сама активация кода происходит в приложении (claim_referral) — сайт лишь
//  показывает приглашение и пытается открыть приложение по ссылке plughub://.

app.get('/api/referral/:code', async (req, res) => {
  // Формат в точности как у new_referral_code() в schema.sql: XXXX-XXXX без похожих символов.
  const code = String(req.params.code || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return res.json({ valid: false })

  const { data, error } = await admin
    .from('profiles')
    .select('display_name')
    .eq('referral_code', code)
    .maybeSingle()

  if (error || !data) return res.json({ valid: false })
  res.json({ valid: true, referrerName: data.display_name || null })
})

// ─── Реферальные ссылки ───────────────────────────────────────────────────────
//  /r/<CODE>    — страница-приглашение (public/referral.html). Код читается на
//                 клиенте из адресной строки — сервер ничего не подставляет в HTML,
//                 поэтому путь безопасен для любого значения :code.
//  /?ref=<CODE> — на случай, если ссылку вставили в корень сайта, а не в /r/...

app.get('/r/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'referral.html'))
})

app.get('/', (req, res, next) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : ''
  if (ref) return res.redirect(302, `/r/${encodeURIComponent(ref)}`)
  next()
})

// ─── Статика: лендинг и админка ──────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')))

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

app.listen(PORT, () => {
  console.log(`\n  PlugHub Web запущен:`)
  console.log(`  • Лендинг:      http://localhost:${PORT}/`)
  console.log(`  • Админ-панель: http://localhost:${PORT}/admin\n`)
})
