import { app } from 'electron'
import { createHash } from 'crypto'
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  lstatSync,
  openAsBlob,
  rmSync,
  statSync,
  openSync,
  readSync,
  closeSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import extractZip from 'extract-zip'
import { supabase } from './supabase'
import { toSafeError } from './errors'

// ─── Карантин ───────────────────────────────────────────────────────────────

/** Скрытая папка карантина внутри userData — сюда попадают файлы до всех проверок. */
export function getQuarantineDir(): string {
  const dir = join(app.getPath('userData'), '.quarantine')
  mkdirSync(dir, { recursive: true })
  return dir
}

// ─── Потоковый SHA256 (без загрузки файла целиком в память) ───────────────────

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// ─── Anti-spoofing: магические байты содержимого архива ───────────────────────
// Расширение файла ничего не гарантирует — под .vst3/.dll может лежать
// переименованный .exe/.bat/.vbs. Здесь проверяем реальную сигнатуру.

function readMagicBytes(filePath: string, length = 16): Buffer {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

/** PE/DLL (Windows): заголовок MZ. Покрывает .dll, одиночный файл .vst3 и .exe-инсталлятор. */
export function isPeMagic(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a
}

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

/** Mach-O (macOS), включая fat-бинарники: .dylib и бинарник внутри .vst3/.component-бандла. */
function isMachOMagic(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  return MACHO_MAGICS.has(buffer.readUInt32BE(0))
}

/**
 * Расширения, у которых нет легитимной причины лежать внутри архива с плагином.
 * Присутствие любого из них — верный признак маскировки вредоносного файла под плагин.
 * .exe сюда сознательно не входит: пользователи легитимно распространяют
 * VST3-инсталляторы как .exe внутри zip — см. isDeclaredExeInstaller ниже,
 * там он проверяется отдельно (обязателен настоящий PE-заголовок).
 */
const DISGUISE_EXTS = new Set([
  'bat', 'cmd', 'com', 'scr', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'msi', 'jar'
])

const BUNDLE_EXTS = new Set(['vst3', 'component'])

function extOf(name: string): string {
  return (name.split(/[\\/]/).pop()?.split('.').pop() ?? '').toLowerCase()
}

interface ScanEntry {
  fullPath: string
  relativePath: string
  ext: string
  isDir: boolean
}

function walk(dir: string, base = dir, acc: ScanEntry[] = []): ScanEntry[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const st = lstatSync(fullPath)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      acc.push({ fullPath, relativePath: fullPath.slice(base.length + 1), ext: extOf(entry), isDir: true })
      walk(fullPath, base, acc)
    } else if (st.isFile()) {
      acc.push({ fullPath, relativePath: fullPath.slice(base.length + 1), ext: extOf(entry), isDir: false })
    }
  }
  return acc
}

/** true, если fileRelPath лежит внутри директории dirRelPath (учитывает оба разделителя пути). */
function isWithin(dirRelPath: string, fileRelPath: string): boolean {
  return fileRelPath.startsWith(`${dirRelPath}/`) || fileRelPath.startsWith(`${dirRelPath}\\`)
}

export interface ScanResult {
  ok: boolean
  error?: string
  /**
   * true — отказ не окончательный (VT не успел закончить анализ в отведённое время),
   * в отличие от подтверждённого вердикта ('malicious'). Такой результат нельзя
   * кэшировать по хэшу файла надолго — иначе повторная установка того же архива
   * будет мгновенно проваливаться этим же отказом вместо реальной повторной попытки.
   */
  transient?: boolean
  /**
   * SHA256 файла на момент вердикта 'ok'. Между этим моментом и фактической
   * установкой/копированием (вызывающий код, до нескольких минут спустя из-за
   * ожидания VirusTotal) карантинный файл лежит по обычному пути userData —
   * вызывающий код должен сверить hash через verifyFileUnchangedSinceScan
   * непосредственно перед использованием файла (см. TOCTOU).
   */
  hash?: string
}

/**
 * Проверяет распакованное дерево плагина. Отсекает переименованные исполняемые
 * скрипты (Уровень 1, п.1 ТЗ) и подтверждает, что заявленные .vst3/.component/.dll/.dylib
 * действительно являются исполняемым кодом нужной платформы (PE/Mach-O), а не чем-то
 * подложенным под тем же расширением. Отдельно допускается .exe-инсталлятор — но только
 * если это настоящий PE-бинарник (см. isPeMagic), а не что-то переименованное под .exe.
 *
 * Для бандлов (.vst3/.component-папок) требуется, чтобы хотя бы один файл внутри был
 * настоящим бинарником — остальные файлы бандла (Info.plist, ресурсы) не обязаны
 * проходить magic-проверку, иначе легитимные плагины будут отбраковываться.
 */
export function scanExtractedTree(dir: string): ScanResult {
  const entries = walk(dir)

  for (const entry of entries) {
    if (!entry.isDir && DISGUISE_EXTS.has(entry.ext)) {
      return { ok: false, error: `В архиве обнаружен подозрительный файл: ${entry.relativePath}` }
    }
  }

  const files = entries.filter((e) => !e.isDir)
  const bundleDirs = entries.filter((e) => e.isDir && BUNDLE_EXTS.has(e.ext))
  let foundReal = false

  for (const file of files) {
    const isDllOrDylib = file.ext === 'dll' || file.ext === 'dylib'
    const isStandaloneVst3 = file.ext === 'vst3' && !bundleDirs.some((b) => isWithin(b.relativePath, file.relativePath))
    const isExeInstaller = file.ext === 'exe'
    if (!isDllOrDylib && !isStandaloneVst3 && !isExeInstaller) continue

    const magic = readMagicBytes(file.fullPath)
    if (isExeInstaller) {
      // .exe допускается ТОЛЬКО как настоящий PE-бинарник (Mach-O для .exe не бывает) —
      // никаких послаблений по сравнению с проверкой .dll/.vst3 выше.
      if (!isPeMagic(magic)) {
        return { ok: false, error: `Файл «${file.relativePath}» не является настоящим исполняемым файлом Windows.` }
      }
      foundReal = true
      continue
    }
    if (!isPeMagic(magic) && !isMachOMagic(magic)) {
      return { ok: false, error: `Файл «${file.relativePath}» не является настоящим бинарником плагина.` }
    }
    foundReal = true
  }

  for (const bundle of bundleDirs) {
    const inside = files.filter((f) => isWithin(bundle.relativePath, f.relativePath))
    const hasRealBinary = inside.some((f) => {
      const magic = readMagicBytes(f.fullPath)
      return isPeMagic(magic) || isMachOMagic(magic)
    })
    if (!hasRealBinary) {
      return { ok: false, error: `Бандл «${bundle.relativePath}» не содержит настоящего бинарника плагина.` }
    }
    foundReal = true
  }

  if (!foundReal) {
    return { ok: false, error: 'В архиве не найден настоящий исполняемый файл плагина.' }
  }

  return { ok: true }
}

// Те же лимиты, что и при валидации загружаемых архивов — защита от zip-бомб
// применяется здесь так же, т.к. мы снова распаковываем недоверенный ZIP.
const MAX_EXTRACTED_FILES = 10_000
const MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024

interface ZipEntryLike {
  fileName: string
  uncompressedSize: number
}

function makeExtractionGuard(): (entry: ZipEntryLike) => void {
  let fileCount = 0
  let totalBytes = 0
  return (entry: ZipEntryLike): void => {
    if (entry.fileName.endsWith('/')) return
    fileCount += 1
    if (fileCount > MAX_EXTRACTED_FILES) throw new Error('В архиве слишком много файлов.')
    const size = Number(entry.uncompressedSize) || 0
    if (size > MAX_SINGLE_FILE_BYTES) throw new Error('Файл внутри архива слишком большой.')
    totalBytes += size
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('Содержимое архива превышает допустимый размер.')
  }
}

// ─── VirusTotal через серверный прокси (Supabase Edge Function) ───────────
// Реальный VIRUSTOTAL_API_KEY здесь больше не хранится и не используется —
// он живёт только в supabase/functions/vt-proxy (Supabase secret). Троттлинг
// общей на всех пользователей очереди к VT тоже переехал на сервер (таблица
// vt_rate_limit в supabase/schema.sql), т.к. ключ теперь общий сразу для всех
// клиентов приложения, а не только для потоков одного процесса. Здесь
// остаётся только ретрай: сама Edge Function может ответить 429/503, пока
// ждёт своей очереди на сервере — тот же смысл, что раньше был у vtFetch.
const VT_DIRECT_UPLOAD_LIMIT = 32 * 1024 * 1024 // 32 МБ — лимит стандартного /files
const VT_ABSOLUTE_LIMIT = 650 * 1024 * 1024 // абсолютный предел самого VT (upload_url)

const VT_PROXY_MAX_RETRIES = 3
const VT_PROXY_RETRY_BASE_MS = 4_000
// Без этого зависшая (не ответившая ни успехом, ни 429/503, ни сетевой ошибкой) Edge
// Function или сам VT вешают весь пайплайн навсегда: install:progress так и останется
// на шаге 'scan', ни ok, ни error никогда не придёт. lookup/poll — лёгкие JSON-запросы,
// upload-small — блоб до 32 МБ, поэтому даём ему отдельный, более щедрый лимит.
const VT_PROXY_TIMEOUT_MS = 60_000
const VT_PROXY_UPLOAD_TIMEOUT_MS = 3 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Response, если invoke() упал из-за не-2xx ответа функции (FunctionsHttpError.context). */
function vtProxyResponse(error: unknown): Response | undefined {
  const context = (error as { context?: unknown } | null)?.context
  return context instanceof Response ? context : undefined
}

async function vtProxyErrorMessage(error: unknown): Promise<string> {
  if (error instanceof Error && error.name === 'FunctionsFetchError') {
    return 'VirusTotal-прокси не ответил за отведённое время.'
  }
  const res = vtProxyResponse(error)
  if (res) {
    try {
      const body = (await res.clone().json()) as { error?: string }
      if (body?.error) return body.error
    } catch {
      /* тело ответа не JSON — используем сообщение ошибки ниже */
    }
  }
  return error instanceof Error ? error.message : 'Ошибка обращения к VirusTotal-прокси.'
}

/** Вызов одного действия vt-proxy; 429/503 (сервер сам ждёт своей очереди к VT) — повтор, не отказ. */
async function invokeVtProxy<T>(action: string, body?: Record<string, unknown> | Blob | FormData): Promise<T> {
  const timeout = action === 'upload-small' ? VT_PROXY_UPLOAD_TIMEOUT_MS : VT_PROXY_TIMEOUT_MS
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await supabase.functions.invoke(`vt-proxy/${action}`, { body, timeout })
    if (!error) return data as T

    const status = vtProxyResponse(error)?.status
    if ((status === 429 || status === 503) && attempt < VT_PROXY_MAX_RETRIES) {
      await sleep(VT_PROXY_RETRY_BASE_MS * (attempt + 1))
      continue
    }
    throw new Error(await vtProxyErrorMessage(error))
  }
}

type VtVerdict = 'clean' | 'malicious' | 'unknown'

/** Фаза А: быстрая проверка по SHA256 уже известного VirusTotal файла. */
async function checkHashOnVirusTotal(hash: string): Promise<VtVerdict> {
  const { verdict } = await invokeVtProxy<{ verdict: VtVerdict }>('lookup', { hash })
  return verdict
}

// Прямая загрузка крупного файла идёт мимо Edge Function, поэтому таймаут выше, чем
// у vt-proxy — это реальная передача до ~650 МБ, а не лёгкий JSON-запрос — но так же
// ограничен: без этого зависший сокет держит install:progress на шаге 'scan' навсегда.
const VT_DIRECT_UPLOAD_TIMEOUT_MS = 5 * 60_000

/** Фаза Б: файл неизвестен VirusTotal — отправляем его в песочницу на анализ. */
async function uploadForAnalysis(filePath: string, size: number): Promise<string> {
  if (size > VT_ABSOLUTE_LIMIT) {
    throw new Error('Файл слишком большой для проверки VirusTotal.')
  }

  if (size > VT_DIRECT_UPLOAD_LIMIT) {
    // Security: openAsBlob streams from disk, avoiding a second in-memory copy of attacker-controlled archives.
    const { url } = await invokeVtProxy<{ url: string }>('upload-url')
    const form = new FormData()
    form.append('file', await openAsBlob(filePath, { type: 'application/zip' }), 'plugin.zip')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VT_DIRECT_UPLOAD_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', body: form, signal: controller.signal })
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('VirusTotal не ответил за отведённое время при загрузке файла.')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`VirusTotal отклонил загрузку файла (${res.status}).`)
    const body = (await res.json()) as { data?: { id?: string } }
    if (!body.data?.id) throw new Error('VirusTotal не вернул идентификатор анализа.')
    return body.data.id
  }

  const form = new FormData()
  form.append('file', await openAsBlob(filePath, { type: 'application/zip' }), 'plugin.zip')
  const { analysisId } = await invokeVtProxy<{ analysisId: string }>('upload-small', form)
  return analysisId
}
const VT_POLL_INTERVAL_MS = 10_000
const VT_POLL_MAX_ATTEMPTS = 18 // ~3 минуты

/** Ждёт завершения анализа в песочнице VirusTotal. Таймаут трактуется как отказ (fail-closed). */
async function pollAnalysis(analysisId: string): Promise<VtVerdict | 'timeout'> {
  for (let attempt = 0; attempt < VT_POLL_MAX_ATTEMPTS; attempt++) {
    const result = await invokeVtProxy<{ status: 'pending' | 'completed'; verdict?: VtVerdict }>('poll', {
      analysisId
    })
    if (result.status === 'completed' && result.verdict) return result.verdict
    await sleep(VT_POLL_INTERVAL_MS)
  }
  return 'timeout'
}

// ─── Оркестратор ────────────────────────────────────────────────────────────

export type ScanLog = (message: string) => void

/**
 * VirusTotal-часть пайплайна (фазы А+Б), общая для plugin-архивов и одиночных
 * ассетов. Любой неопределённый результат (нет ключа, таймаут анализа, файл
 * слишком большой для VirusTotal) трактуется как отказ — это сознательно строже,
 * чем «пропустить, если непонятно».
 */
async function verifyWithVirusTotal(filePath: string, hash: string, onLog: ScanLog): Promise<ScanResult> {
  onLog('Проверка по базе VirusTotal…')
  const hashVerdict = await checkHashOnVirusTotal(hash)
  if (hashVerdict === 'malicious') {
    return { ok: false, error: 'Файл заблокирован VirusTotal (обнаружены угрозы).' }
  }
  if (hashVerdict === 'clean') {
    return { ok: true }
  }

  onLog('Файл новый для VirusTotal — отправка на глубокий анализ…')
  const size = statSync(filePath).size
  const analysisId = await uploadForAnalysis(filePath, size)

  onLog('Ожидание результата анализа в песочнице…')
  const verdict = await pollAnalysis(analysisId)
  if (verdict === 'malicious') {
    return { ok: false, error: 'Файл заблокирован VirusTotal (обнаружены угрозы при глубоком анализе).' }
  }
  if (verdict === 'timeout') {
    return {
      ok: false,
      error: 'Файл не прошёл верификацию: VirusTotal не успел завершить анализ.',
      transient: true
    }
  }
  return { ok: true }
}

// Кеш промиса сканирования по SHA256: параллельные попытки поставить один и тот
// же архив (двойной клик «Установить», два ассета с одинаковым содержимым)
// дожидаются ОДНОГО реального похода в VirusTotal вместо того, чтобы независимо
// жечь общий на всё приложение API-ключ и суточную квоту дубликатами запросов.
const VT_SCAN_CACHE_MAX_ENTRIES = 512
const VT_SCAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface VtScanCacheEntry {
  promise: Promise<ScanResult>
  expiresAt: number
}

const vtScanCache = new Map<string, VtScanCacheEntry>()

function getCachedVtScan(hash: string): Promise<ScanResult> | null {
  const entry = vtScanCache.get(hash)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    vtScanCache.delete(hash)
    return null
  }
  vtScanCache.delete(hash)
  vtScanCache.set(hash, entry)
  return entry.promise
}

function rememberVtScan(hash: string, promise: Promise<ScanResult>): void {
  // Security: LRU+TTL keeps deduplication useful without retaining attacker-chosen hashes forever.
  vtScanCache.set(hash, { promise, expiresAt: Date.now() + VT_SCAN_CACHE_TTL_MS })
  for (const [key, entry] of vtScanCache) {
    if (entry.expiresAt <= Date.now() || vtScanCache.size > VT_SCAN_CACHE_MAX_ENTRIES) {
      vtScanCache.delete(key)
    }
    if (vtScanCache.size <= VT_SCAN_CACHE_MAX_ENTRIES) break
  }
}

async function verifyWithVirusTotalCached(filePath: string, onLog: ScanLog): Promise<ScanResult> {
  onLog('Подсчёт SHA256…')
  const hash = await sha256File(filePath)

  const pending = getCachedVtScan(hash)
  if (pending) {
    onLog('Файл уже проверяется параллельной установкой — ждём готовый результат…')
    const result = await pending
    return result.ok ? { ...result, hash } : result
  }

  const scan = verifyWithVirusTotal(filePath, hash, onLog)
  rememberVtScan(hash, scan)
  // Transient failures must not stick in the bounded verdict cache.
  scan.then(
    (result) => { if (!result.ok && result.transient) vtScanCache.delete(hash) },
    () => vtScanCache.delete(hash)
  )
  const result = await scan
  // hash кладём в результат здесь же (а не только в кэш), чтобы вызывающий код мог
  // сверить его прямо перед install/copy — см. verifyFileUnchangedSinceScan.
  return result.ok ? { ...result, hash } : result
}
/**
 * Полный трёхуровневый пайплайн проверки скачанного архива плагина:
 *  1. Anti-spoofing по магическим байтам содержимого (scanExtractedTree).
 *  2-3. VirusTotal (см. verifyWithVirusTotal).
 */
export async function runSecurityPipeline(zipPath: string, onLog: ScanLog): Promise<ScanResult> {
  const extractDir = join(tmpdir(), `plughub-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(extractDir, { recursive: true })
  try {
    onLog('Проверка структуры архива…')
    await extractZip(zipPath, { dir: extractDir, onEntry: makeExtractionGuard() })
    const signatureResult = scanExtractedTree(extractDir)
    if (!signatureResult.ok) return signatureResult

    return await verifyWithVirusTotalCached(zipPath, onLog)
  } catch (err: unknown) {
    const msg = toSafeError(err, 'Файл не прошёл проверку безопасности.', '[antivirus] runSecurityPipeline error')
    return { ok: false, error: msg }
  } finally {
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * Облегчённая проверка для одиночных ассетов из community-контента (FLP/лупы/
 * драмкиты/биты) — только VirusTotal, без anti-spoofing-распаковки. Расширение
 * и реальный тип содержимого для этих файлов уже подтверждены магическими
 * байтами на этапе `assets:upload` (см. index.ts, validateUploadContent), а
 * серверное имя объекта в Storage присваивается по проверенному типу, а не
 * бралось из пользовательского ввода — так что подмена расширения здесь
 * исключена. Остаётся риск вредоносной полезной нагрузки внутри легитимного
 * по формату файла — его и покрывает VirusTotal.
 */
export async function runFileSecurityScan(filePath: string, onLog: ScanLog): Promise<ScanResult> {
  try {
    return await verifyWithVirusTotalCached(filePath, onLog)
  } catch (err: unknown) {
    const msg = toSafeError(err, 'Файл не прошёл проверку безопасности.', '[antivirus] runFileSecurityScan error')
    return { ok: false, error: msg }
  }
}

/**
 * Security: TOCTOU-защита. Карантинный файл проверяется здесь, а устанавливается/
 * копируется вызывающим кодом позже (VirusTotal-опрос может занимать до ~3 минут) —
 * всё это время файл лежит по обычному userData-пути, куда теоретически может
 * писать другой процесс того же пользователя Windows. Перед install/copy вызывающий
 * код обязан сверить текущий хэш файла с ScanResult.hash, полученным от
 * runSecurityPipeline/runFileSecurityScan, и отменить операцию при несовпадении.
 */
export async function verifyFileUnchangedSinceScan(filePath: string, expectedHash: string): Promise<boolean> {
  const hash = await sha256File(filePath)
  return hash === expectedHash
}
