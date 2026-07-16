import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  dialog,
  shell,
  nativeTheme,
  session
} from 'electron'
import { join, relative, resolve, isAbsolute } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  lstatSync,
  statSync,
  rmSync,
  openAsBlob
} from 'fs'
import { platform, homedir, tmpdir } from 'os'
import { pathToFileURL } from 'url'
import extractZip from 'extract-zip'
import { supabase } from './supabase'
import type { DbPlugin, DbCommunityPlugin } from './supabase'
import { registerAuthIpc, getState } from './auth'
import { registerReferralIpc, handleReferralDeepLink, parseReferralDeepLink } from './referral'
import { registerStreakIpc } from './streak'
import { registerChatIpc } from './chat'
import { registerAiIpc } from './ai'
import { registerTasteIpc } from './taste'
import {
  getQuarantineDir,
  runFileSecurityScan,
  runSecurityPipeline,
  isPeMagic,
  verifyFileUnchangedSinceScan
} from './antivirus'
import {
  appendHashtagsToText,
  extractHashtagsFromText,
  normalizeHashtags,
  stripTrailingHashtagLine
} from '../shared/hashtags'
import { toSafeError } from './errors'
import { downloadRateFor } from './download-safety'
import { downloadFile } from './download-file'
import {
  MAX_EXTRACTED_FILES,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  extFromPath,
  readMagicBytes,
  isZipMagic,
  isVst3ZipEntryMatch,
  findZipEntry,
  zipHasVst3
} from './archive/zip-validation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppSettings {
  vst3Path: string
  autoUpdate: boolean
  checkUpdateOnStart: boolean
  theme: string
  language: 'ru' | 'en'
}

interface Plugin {
  id: string
  name: string
  author: string
  version: string
  description: string
  category: string
  size: string
  downloadUrl: string
  iconUrl?: string
  tags?: string[]
  installed?: boolean
  installDate?: string
}

interface UploadAssetOptions {
  previewBuffer?: ArrayBuffer | Uint8Array | number[]
  previewFileName?: string
  previewStartSec?: number
  previewDurationSec?: number
  /** Для пресетов: готовый аудиофайл «с эффектами» (путь на диске, без трима). */
  previewWetPath?: string
  /** Для пресетов: готовый аудиофайл «без эффектов» (путь на диске, без трима). */
  previewDryPath?: string
}

type UploadStep = 'validate' | 'upload' | 'icon' | 'publish' | 'done' | 'error'

type ContentSource = 'catalog' | 'community'

// ─── Paths ────────────────────────────────────────────────────────────────────

function getDefaultVst3Path(): string {
  const p = platform()
  if (p === 'win32') return 'C:\\Program Files\\Common Files\\VST3'
  if (p === 'darwin') return '/Library/Audio/Plug-Ins/VST3'
  return join(homedir(), '.vst3')
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function getInstalledDbPath(): string {
  return join(app.getPath('userData'), 'installed.json')
}

function isTrustedSender(event: IpcMainInvokeEvent, win: BrowserWindow): boolean {
  return !win.isDestroyed() && event.senderFrame?.top === win.webContents.mainFrame
}

function rejectUntrustedSender(event: IpcMainInvokeEvent, win: BrowserWindow): { ok: false; error: string } | null {
  if (isTrustedSender(event, win)) return null
  console.warn('[security] blocked IPC from untrusted sender:', event.senderFrame?.url ?? 'unknown')
  return { ok: false, error: 'Недоверенный источник IPC-вызова.' }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function safeDownloadName(value: string, fallback: string): string {
  const trimmed = (value || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim()
    .replace(/[. ]+$/, '') // Windows отбрасывает завершающие точки/пробелы при создании файла
  if (!trimmed || trimmed === '.' || trimmed === '..' || RESERVED_WINDOWS_NAMES.test(trimmed)) {
    return fallback
  }
  return trimmed
}

// Публичный адрес Cloud.ru Evolution Object Storage. Это не секрет: адрес нужен для
// CSP и для обратного вычисления ключа объекта при удалении публикации. Укажите либо
// path-style URL бакета, например
// https://s3.cloud.ru/<bucket-name>, либо отдельный публичный домен бакета.
// То же значение должно быть в Supabase secret STORAGE_PUBLIC_BASE_URL и в
// public.community_storage_url_matches() в supabase/schema.sql.
const STORAGE_PUBLIC_BASE_URL = 'https://plughub.s3.cloud.ru'

/** Обратное преобразование publicUrl → ключ объекта относительно namespace (для удаления). */
function objectKeyFromPublicUrl(value: string | null | undefined, namespacePrefix: string): string | null {
  if (!value) return null
  const prefix = `${STORAGE_PUBLIC_BASE_URL}/${namespacePrefix}/`
  if (!value.startsWith(prefix)) return null
  try {
    const key = decodeURIComponent(value.slice(prefix.length))
    return key && !key.includes('..') ? key : null
  } catch {
    return null
  }
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return !!rel && !rel.startsWith('..') && !rel.includes(':')
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    vst3Path: getDefaultVst3Path(),
    autoUpdate: true,
    checkUpdateOnStart: true,
    theme: 'carbon',
    language: 'ru'
  }
  try {
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return defaults
  }
}

function saveSettings(settings: AppSettings): void {
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

/**
 * Каталоги, куда нельзя направлять vst3Path, даже если запрос пришёл от доверенного
 * фрейма: на Windows приложение ставится с requestedExecutionLevel=requireAdministrator
 * (см. package.json), поэтому запись в системный/автозагрузочный каталог — это готовый
 * вектор закрепления, а не просто "неудобное" значение настройки.
 */
function getForbiddenVst3Roots(): string[] {
  const roots: string[] = []
  if (process.env.SystemRoot) roots.push(process.env.SystemRoot) // C:\Windows
  if (process.env.ProgramData) {
    roots.push(join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'))
  }
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'))
  }
  return roots.map((r) => resolve(r))
}

// vst3Path в обычном UI всегда приходит из dialog:selectFolder, но на стороне main
// это никак не гарантировано — settings:save должен сам отвергать мусорные/опасные значения.
function isValidVst3Path(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || !isAbsolute(p)) return false

  const resolved = resolve(p)
  if (resolve(resolved, '..') === resolved) return false // корень диска ("C:\\", "/") — слишком широко

  const forbidden = getForbiddenVst3Roots()
  if (forbidden.some((root) => resolved === root || isSubpath(root, resolved) || isSubpath(resolved, root))) {
    return false
  }

  try {
    // Если путь уже существует — это должна быть папка, а не файл.
    if (existsSync(resolved) && !statSync(resolved).isDirectory()) return false
  } catch {
    return false
  }
  return true
}

// ─── Installed plugins DB ─────────────────────────────────────────────────────

function loadInstalled(): Record<string, string> {
  try {
    const raw = readFileSync(getInstalledDbPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function markInstalled(pluginId: string, date: string): void {
  const db = loadInstalled()
  db[pluginId] = date
  writeFileSync(getInstalledDbPath(), JSON.stringify(db, null, 2), 'utf-8')
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

const STORAGE_TIMEOUT_MSG = 'Хранилище не ответило за отведённое время.'

// ─── Presigned-загрузка в Cloud.ru Object Storage (S3-compatible) ────────────────
// Реальные креды хранилища знает только Supabase Edge Function storage-proxy (см.
// supabase/functions/storage-proxy) — клиент получает от неё presigned URL на
// конкретную загрузку/удаление и сам стримит файл напрямую в Object Storage.
const STORAGE_PRESIGN_TIMEOUT_MS = 15_000
// Файл может быть до 1 ГБ (см. MAX_COMMUNITY_UPLOAD_BYTES) на не самом быстром канале —
// таймаут выше, чем на сам presign-запрос (тот — лёгкий JSON, не передача байтов).
const STORAGE_UPLOAD_TIMEOUT_MS = 20 * 60_000
// Клиентская защита от того, что один аплоад займёт непропорционально много места/
// трафика — значение легко поднять, если понадобится. Проверяется только для сетевых
// загрузок (catalog/community/assets), не для локального plugins:upload — тому 1 ГБ
// не имеет значения, он никуда по сети не отправляется.
const MAX_COMMUNITY_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024

function assertUploadSizeLimit(size: number): void {
  if (size > MAX_COMMUNITY_UPLOAD_BYTES) {
    throw new Error(`Файл слишком большой для загрузки (лимит ${formatBytes(MAX_COMMUNITY_UPLOAD_BYTES)}).`)
  }
}

type StorageNamespace = 'catalog' | 'community'

interface PresignedUpload {
  uploadUrl: string
  publicUrl: string
}

const DEFAULT_UPLOAD_CONTENT_TYPE = 'application/octet-stream'

async function presignUpload(
  namespace: StorageNamespace,
  key: string,
  contentType: string | undefined,
  size: number
): Promise<PresignedUpload> {
  const { data, error } = await supabase.functions.invoke('storage-proxy/presign-upload', {
    body: { namespace, key, contentType: contentType ?? DEFAULT_UPLOAD_CONTENT_TYPE, size },
    timeout: STORAGE_PRESIGN_TIMEOUT_MS
  })
  if (error) throw error
  return data as PresignedUpload
}

type UploadSource = { filePath: string } | { buffer: Buffer }

/**
 * Стримит файл на presigned URL. Тот же приём, что и uploadForAnalysis в
 * src/main/antivirus.ts для больших файлов VirusTotal — openAsBlob читает с диска
 * потоково, не дублируя весь файл в памяти процесса.
 */
async function uploadFileToStorage(
  uploadUrl: string,
  source: UploadSource,
  contentType: string | undefined
): Promise<void> {
  const type = contentType ?? DEFAULT_UPLOAD_CONTENT_TYPE
  const body =
    'buffer' in source
      ? new Blob([source.buffer], { type })
      : await openAsBlob(source.filePath, { type })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STORAGE_UPLOAD_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(uploadUrl, {
      method: 'PUT',
      body,
      headers: { 'content-type': type },
      signal: controller.signal
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(STORAGE_TIMEOUT_MSG)
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`Хранилище отклонило загрузку файла (${res.status}).`)
}

/** Best-effort — удаление объекта не должно ломать удаление записи из БД. */
async function deleteFromStorage(namespace: StorageNamespace, keys: string[]): Promise<void> {
  if (!keys.length) return
  try {
    await supabase.functions.invoke('storage-proxy/delete', {
      body: { namespace, keys },
      timeout: STORAGE_PRESIGN_TIMEOUT_MS
    })
  } catch {
    /* ignore — best-effort cleanup */
  }
}

// Валидация содержимого архива (поиск .vst3/.flp/аудио внутри zip) теперь не
// распаковывает файлы на диск (см. findZipEntry), но на очень большом/аномальном
// архиве (много мелких записей) всё ещё может занять заметное время — оборачиваем
// в тот же withTimeout, чтобы зависшая проверка не держала IPC-хендлер вечно.
const VALIDATE_UPLOAD_TIMEOUT_MS = 60_000
const VALIDATE_TIMEOUT_MSG = 'Проверка содержимого архива не уложилась в отведённое время.'

const AUDIO_FILE_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'])
const IMAGE_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const BEAT_PREVIEW_SECONDS = 30
const RAR4_MAGIC = '526172211a0700'
const RAR5_MAGIC = '526172211a070100'

// ─── Защита от zip-бомб ─────────────────────────────────────────────────────────
// Лимиты и низкоуровневый анализ ZIP вынесены в ./archive/zip-validation.ts
// (единый source of truth). makeZipExtractionGuard ниже импортирует оттуда MAX_*.

interface ZipEntryLike {
  fileName: string
  uncompressedSize: number
}

/**
 * Возвращает onEntry-страж для extractZip с замкнутыми счётчиками. Считает только
 * файлы (записи-папки заканчиваются на «/»). Размеры берутся из заголовков архива —
 * этого достаточно, чтобы отсечь классические zip-бомбы с петабайтным содержимым.
 */
function makeZipExtractionGuard(): (entry: ZipEntryLike) => void {
  let fileCount = 0
  let totalBytes = 0
  return (entry: ZipEntryLike): void => {
    if (entry.fileName.endsWith('/')) return
    fileCount += 1
    if (fileCount > MAX_EXTRACTED_FILES) {
      throw new Error('В архиве слишком много файлов.')
    }
    const size = Number(entry.uncompressedSize) || 0
    if (size > MAX_SINGLE_FILE_BYTES) {
      throw new Error('Файл внутри архива слишком большой.')
    }
    totalBytes += size
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Содержимое архива превышает допустимый размер.')
    }
  }
}

function bufferFromIpc(value: unknown): Buffer | null {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value)) return Buffer.from(value)
  return null
}

function contentTypeForExt(ext: string): string | undefined {
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'flac') return 'audio/flac'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'aac') return 'audio/aac'
  if (ext === 'zip') return 'application/zip'
  if (ext === 'vstpreset' || ext === 'fxp') return 'application/octet-stream'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return undefined
}

function assertNonEmptyRegularFile(filePath: string): number {
  const st = statSync(filePath)
  if (!st.isFile()) {
    throw new Error('Можно загружать только обычные файлы.')
  }
  if (st.size <= 0) {
    throw new Error('Нельзя загружать пустой файл.')
  }
  return st.size
}

function isRarMagic(buffer: Buffer): boolean {
  const hex = buffer.toString('hex')
  return hex.startsWith(RAR4_MAGIC) || hex.startsWith(RAR5_MAGIC)
}

function isImageMagic(ext: string, buffer: Buffer): boolean {
  if (ext === 'png') return buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (ext === 'jpg' || ext === 'jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (ext === 'webp') {
    return buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
  }
  return false
}

function validateUploadedFile(filePath: string, allowedExts: Set<string>, archiveRequired = false): { size: number; ext: string } {
  const size = assertNonEmptyRegularFile(filePath)
  const ext = extFromPath(filePath)

  if (!allowedExts.has(ext)) {
    throw new Error('Этот тип файла нельзя загрузить в выбранный раздел.')
  }

  const magic = readMagicBytes(filePath)
  const isArchiveExt = ext === 'zip' || ext === 'rar'

  if (archiveRequired && !isArchiveExt) {
    throw new Error('Нужен ZIP или RAR-архив.')
  }
  if (ext === 'zip' && !isZipMagic(magic)) {
    throw new Error('Файл не является настоящим ZIP-архивом.')
  }
  if (ext === 'rar' && !isRarMagic(magic)) {
    throw new Error('Файл не является настоящим RAR-архивом.')
  }

  return { size, ext }
}

function validateIconFile(iconPath: string): { size: number; ext: string } {
  const result = validateUploadedFile(iconPath, IMAGE_FILE_EXTS)
  if (!isImageMagic(result.ext, readMagicBytes(iconPath))) {
    throw new Error('Иконка должна быть настоящим PNG, JPG или WEBP-файлом.')
  }
  return result
}

// Для пресетов: превью-клипы «с эффектами» / «без эффектов» — те же ограничения,
// что и на аудио для лупов/битов, но isAudioBuffer (в частности wavDurationSec)
// разбирает fmt-чанк WAV, которого может не быть в первых 12 байтах магии — поэтому
// читаем файл целиком, как в audio:readFile, а не только заголовок.
function validateAudioPreviewFile(filePath: string): { size: number; ext: string } {
  const result = validateUploadedFile(filePath, AUDIO_FILE_EXTS)
  if (!isAudioBuffer(result.ext, readFileSync(filePath))) {
    throw new Error('Аудио-превью должно быть настоящим аудиофайлом.')
  }
  return result
}

function isFlpBuffer(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'FLhd'
}

function isAudioBuffer(ext: string, buffer: Buffer): boolean {
  if (buffer.length < 8) return false
  if (ext === 'wav') return wavDurationSec(buffer) !== null
  if (ext === 'mp3') {
    return buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  }
  if (ext === 'flac') return buffer.toString('ascii', 0, 4) === 'fLaC'
  if (ext === 'ogg') return buffer.toString('ascii', 0, 4) === 'OggS'
  if (ext === 'm4a') return buffer.toString('ascii', 4, 8) === 'ftyp'
  if (ext === 'aac') return buffer[0] === 0xff && (buffer[1] & 0xf0) === 0xf0
  return false
}

// .vstpreset (VST3) начинается с ASCII-магии «VST3»; .fxp (VST2 preset) — с чанк-ID «CcnK».
function isVstPresetMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'VST3'
}

function isFxpMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'CcnK'
}

function assertDirectUploadContent(kind: string, ext: string, filePath: string): void {
  const buffer = readFileSync(filePath)
  if ((kind === 'flp' || kind === 'template') && ext === 'flp' && isFlpBuffer(buffer)) return
  if ((kind === 'loop' || kind === 'drumkit' || kind === 'beat') && AUDIO_FILE_EXTS.has(ext) && isAudioBuffer(ext, buffer)) return
  if (kind === 'preset' && ext === 'vstpreset' && isVstPresetMagic(buffer)) return
  if (kind === 'preset' && ext === 'fxp' && isFxpMagic(buffer)) return
  throw new Error('Файл не похож на выбранный тип. Проверьте, что это не переименованная картинка.')
}

async function assertZipUploadContent(kind: string, zipPath: string): Promise<void> {
  if (kind === 'plugin') {
    // .exe допускается как альтернатива .vst3 (инсталлятор плагина вместо готового
    // бандла) — но только настоящий PE-бинарник, а не переименованный под .exe файл.
    // Это то же требование, что и scanExtractedTree применяет при установке
    // (см. src/main/antivirus.ts) — здесь проверяем уже на этапе загрузки в маркетплейс.
    const found = await findZipEntry(zipPath, async (entry, openContent) => {
      if (isVst3ZipEntryMatch(entry)) return true
      if (entry.size > 0 && entry.ext === 'exe') return isPeMagic(await openContent())
      return false
    })
    if (!found) {
      throw new Error('В ZIP-архиве плагина должен быть .vst3 или .exe-инсталлятор.')
    }
    return
  }

  if (kind === 'flp' || kind === 'template') {
    const found = await findZipEntry(zipPath, async (entry, openContent) => {
      if (entry.ext !== 'flp' || entry.size <= 0) return false
      return isFlpBuffer(await openContent())
    })
    if (!found) {
      throw new Error('В архиве должен быть .flp-проект.')
    }
    return
  }

  if (kind === 'loop' || kind === 'drumkit') {
    const found = await findZipEntry(zipPath, async (entry, openContent) => {
      if (!AUDIO_FILE_EXTS.has(entry.ext) || entry.size <= 0) return false
      return isAudioBuffer(entry.ext, await openContent())
    })
    if (!found) {
      throw new Error('В архиве должен быть хотя бы один аудиофайл.')
    }
    return
  }

  if (kind === 'preset') {
    const found = await findZipEntry(zipPath, async (entry, openContent) => {
      if (entry.size <= 0) return false
      if (entry.ext === 'vstpreset') return isVstPresetMagic(await openContent())
      if (entry.ext === 'fxp') return isFxpMagic(await openContent())
      return false
    })
    if (!found) {
      throw new Error('В архиве должен быть файл настройки .vstpreset или .fxp.')
    }
    return
  }

  throw new Error('В архиве должен быть хотя бы один аудиофайл.')
}

async function validateUploadContent(kind: string, filePath: string): Promise<number> {
  const allowedExts = allowedExtsForKind(kind)
  const { size, ext } = validateUploadedFile(filePath, allowedExts)
  if (ext === 'zip') {
    await assertZipUploadContent(kind, filePath)
  } else {
    assertDirectUploadContent(kind, ext, filePath)
  }
  return size
}

function allowedExtsForKind(kind: string): Set<string> {
  if (kind === 'plugin') return new Set(['zip'])
  if (kind === 'flp') return new Set(['flp', 'zip'])
  if (kind === 'template') return new Set(['flp', 'zip'])
  if (kind === 'loop') return new Set([...AUDIO_FILE_EXTS, 'zip'])
  if (kind === 'drumkit') return new Set([...AUDIO_FILE_EXTS, 'zip'])
  if (kind === 'beat') return new Set(AUDIO_FILE_EXTS)
  if (kind === 'preset') return new Set(['vstpreset', 'fxp', 'zip'])
  return new Set()
}

function isSafeExternalPaymentUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 't.me' || url.hostname === 'telegram.me')
  } catch {
    return false
  }
}

function slugify(value: string, fallback = 'plugin'): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || fallback
}

function wavDurationSec(buffer: Buffer): number | null {
  if (buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }

  let offset = 12
  let byteRate = 0
  let dataSize = 0

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8

    if (chunkId === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(dataOffset + 8)
    } else if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, buffer.length - dataOffset)
      break
    }

    offset = dataOffset + chunkSize + (chunkSize % 2)
  }

  if (!byteRate || !dataSize) return null
  return dataSize / byteRate
}

// ─── Mock marketplace data ────────────────────────────────────────────────────

const MOCK_PLUGINS: Plugin[] = [
  {
    id: 'vital-synth',
    name: 'Vital',
    author: 'Matt Tytel',
    version: '1.5.5',
    description: 'Wavetable synthesizer с возможностью визуализации спектра в реальном времени.',
    category: 'Synthesizer',
    size: '45 MB',
    downloadUrl: 'https://example.com/plugins/vital.zip'
  },
  {
    id: 'surge-xt',
    name: 'Surge XT',
    author: 'Surge Synth Team',
    version: '1.3.1',
    description: 'Мощный гибридный синтезатор с сотнями пресетов.',
    category: 'Synthesizer',
    size: '150 MB',
    downloadUrl: 'https://example.com/plugins/surge-xt.zip'
  },
  {
    id: 'dragonfly-reverb',
    name: 'Dragonfly Reverb',
    author: 'Michael Willis',
    version: '3.2.9',
    description: 'Набор алгоритмических ревербераторов высокого качества.',
    category: 'Reverb',
    size: '3 MB',
    downloadUrl: 'https://example.com/plugins/dragonfly.zip'
  },
  {
    id: 'mda-epiano',
    name: 'MDA ePiano',
    author: 'MDA',
    version: '1.0.1',
    description: 'Классическое электропианино на основе синтеза Rhodes.',
    category: 'Instrument',
    size: '2 MB',
    downloadUrl: 'https://example.com/plugins/mda-epiano.zip'
  },
  {
    id: 'odin2',
    name: 'Odin 2',
    author: 'TheWaveWarden',
    version: '2.3.4',
    description: 'Полуфизический синтезатор с модульной маршрутизацией.',
    category: 'Synthesizer',
    size: '18 MB',
    downloadUrl: 'https://example.com/plugins/odin2.zip'
  },
  {
    id: 'loudmax',
    name: 'LoudMax',
    author: 'Thomas Mundt',
    version: '1.45',
    description: 'Look-ahead brick-wall лимитер для мастеринга.',
    category: 'Dynamics',
    size: '1 MB',
    downloadUrl: 'https://example.com/plugins/loudmax.zip'
  }
]

// ─── Download helper ──────────────────────────────────────────────────────────

interface InstallTarget {
  id: string
  url: string
  source: ContentSource
  name: string
}

async function fetchInstallTarget(pluginId: string): Promise<InstallTarget> {
  const normalizedId = String(pluginId ?? '').trim()
  if (!normalizedId) throw new Error('Плагин не найден.')

  const catalog = await supabase
    .from('plugins')
    .select('*')
    .eq('id', normalizedId)
    .maybeSingle()
  if (catalog.error) throw catalog.error

  if (catalog.data) {
    const row = catalog.data as DbPlugin
    if (!isHttpUrl(row.download_url)) throw new Error('У плагина некорректная ссылка загрузки.')
    return { id: row.id, url: row.download_url, source: 'catalog', name: row.name }
  }

  const community = await supabase
    .from('community_plugins')
    .select('*')
    .eq('id', normalizedId)
    .maybeSingle()
  if (community.error) throw community.error
  if (!community.data) throw new Error('Плагин не найден.')

  const row = community.data as DbCommunityPlugin
  if ((row.kind ?? 'plugin') !== 'plugin') {
    throw new Error('Этот файл нельзя устанавливать как VST3-плагин.')
  }
  if (!isHttpUrl(row.download_url)) throw new Error('У плагина некорректная ссылка загрузки.')

  return { id: row.id, url: row.download_url, source: 'community', name: row.name }
}

// ─── Лимиты ────────────────────────────────────────────────────────────────────
const AUTO_INSTALL_DAILY_FREE = 5
const BEAT_PRICE_MIN_CENTS = 200   // $2
const BEAT_PRICE_MAX_CENTS = 1500  // $15

/**
 * Разобрать свободную цену бита («20$», «$5», «7.5») в центы. null — не распознано.
 * Диапазон $2–$15 проверяется отдельно (только для free-авторов).
 */
function parsePriceToCents(price: string | undefined | null): number | null {
  if (!price) return null
  const m = String(price).replace(',', '.').match(/(\d+(?:\.\d{1,2})?)/)
  if (!m) return null
  const value = Number(m[1])
  if (!isFinite(value) || value <= 0) return null
  return Math.round(value * 100)
}

interface QuotaRow { allowed: boolean; used_after: number; resets_at: string }

/**
 * Списать один слот автоустановки для free-юзера (атомарно на сервере).
 * Премиум сюда не заходит — у него безлимит.
 */
async function consumeAutoInstallSlot(): Promise<QuotaRow> {
  const { data, error } = await supabase.rpc('consume_auto_install_quota', { p_limit: AUTO_INSTALL_DAILY_FREE })
  if (error) throw error
  const row = (Array.isArray(data) ? data[0] : data) as QuotaRow | undefined
  return row ?? { allowed: false, used_after: AUTO_INSTALL_DAILY_FREE, resets_at: new Date().toISOString() }
}

/** Записать успешную установку в облачную «Студию» премиум-юзера (best-effort). */
async function logStudioInstall(target: InstallTarget): Promise<void> {
  try {
    await supabase.rpc('log_plugin_install', {
      p_plugin_id: target.id,
      p_source: target.source,
      p_name: target.name,
      p_download_url: target.url
    })
  } catch { /* best-effort: лог студии не должен ломать установку */ }
}

interface InstallOutcome {
  ok: boolean
  error?: string
  /** Достигнут суточный лимит автоустановок (free) — можно предложить «Скачать архивом». */
  limitReached?: boolean
  allowArchive?: boolean
  resetsAt?: string
  usedAfter?: number
  limit?: number
}

/**
 * Недоверенный плагин прогоняем через полный трёхуровневый пайплайн проверки
 * (anti-spoofing + VirusTotal) прямо в карантинной папке, до какого-либо переноса
 * в системную папку плагинов. При отказе файл удаляется и установка/скачивание прерывается.
 */
async function verifyDownloadedPlugin(
  pluginId: string,
  filePath: string,
  win: BrowserWindow
): Promise<{ ok: true; hash?: string } | { ok: false; error: string }> {
  win.webContents.send('install:progress', { pluginId, step: 'scan', pct: 0 })
  const result = await runSecurityPipeline(filePath, (message) => {
    win.webContents.send('install:progress', { pluginId, step: 'scan', pct: 0, message })
  })
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Файл не прошёл проверку безопасности.' }
  }
  return { ok: true, hash: result.hash }
}

// Security: TOCTOU — карантинный файл проверяется задолго (до ~3 минут VirusTotal-опроса)
// до фактической установки/копирования. Сверяем хэш прямо перед использованием файла
// и отменяем операцию, если он изменился (см. src/main/antivirus.ts, verifyFileUnchangedSinceScan).
async function assertScannedFileUnchanged(filePath: string, hash: string | undefined): Promise<void> {
  if (!hash) return
  const unchanged = await verifyFileUnchangedSinceScan(filePath, hash)
  if (!unchanged) throw new Error('Файл изменился после проверки безопасности — установка отменена.')
}

/**
 * Security: scan exemption is based only on the trusted DB source, never renderer UI state.
 */
function isScanExemptSource(source: ContentSource): boolean {
  return source === 'catalog'
}

// Active operations are keyed by operation and id so different IPC calls never share a result shape.
const activeInstallLocks = new Map<string, Promise<unknown>>()

type InstallLockOperation = 'install' | 'archive' | 'asset'

function withInstallLock<T>(operation: InstallLockOperation, pluginId: string, run: () => Promise<T>): Promise<T> {
  const lockKey = operation + ':' + pluginId
  const existing = activeInstallLocks.get(lockKey) as Promise<T> | undefined
  if (existing) return existing
  const promise = run().finally(() => { activeInstallLocks.delete(lockKey) })
  activeInstallLocks.set(lockKey, promise)
  return promise
}

/**
 * Единый путь скачивания+автоустановки VST3. Используется обычной установкой и
 * восстановлением студии. Прогресс шлётся по каналу install:progress.
 *  • free + countsAgainstQuota → списывается суточный слот (5/сутки); при исчерпании
 *    возвращается limitReached/allowArchive БЕЗ скачивания;
 *  • скорость: премиум — без лимита, free — 7 Мбит/с;
 *  • премиум → успешная установка логируется в облачную студию;
 *  • community-источник из БД → файл сначала попадает в карантин и проходит
 *    anti-spoofing + VirusTotal, и только потом устанавливается (см. src/main/antivirus.ts).
 */
async function performInstall(
  pluginId: string,
  win: BrowserWindow,
  premium: boolean,
  countsAgainstQuota: boolean,
  sourceTab?: string
): Promise<InstallOutcome> {
  void sourceTab // UI hint only; security decisions use target.source from fetchInstallTarget().
  let tmpFile: string | null = null
  try {
    const target = await fetchInstallTarget(pluginId)
    const skipScan = isScanExemptSource(target.source)

    if (!premium && countsAgainstQuota) {
      const quota = await consumeAutoInstallSlot()
      if (!quota.allowed) {
        return {
          ok: false,
          limitReached: true,
          allowArchive: true,
          resetsAt: quota.resets_at,
          usedAfter: quota.used_after,
          limit: AUTO_INSTALL_DAILY_FREE,
          error: 'Достигнут суточный лимит автоустановок.'
        }
      }
    }

    const settings = loadSettings()
    const downloadDir = skipScan ? tmpdir() : getQuarantineDir()
    // Date.now() один разрешение системного таймера Windows (~15.6мс) недостаточно,
    // чтобы отличить два параллельных запуска — добавляем случайный суффикс.
    tmpFile = join(downloadDir, `${target.source}-${target.id}-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`)
    win.webContents.send('install:progress', { pluginId, step: 'download', pct: 0 })

    await downloadFile(target.url, tmpFile, (pct) => {
      win.webContents.send('install:progress', { pluginId, step: 'download', pct })
    }, downloadRateFor(premium))

    let scannedHash: string | undefined
    if (!skipScan) {
      const scan = await verifyDownloadedPlugin(pluginId, tmpFile, win)
      if (!scan.ok) {
        win.webContents.send('install:progress', { pluginId, step: 'error', error: scan.error })
        return { ok: false, error: scan.error }
      }
      scannedHash = scan.hash
    }

    // Архив без .vst3 внутри (только .exe-инсталлятор) нельзя автоматически
    // разложить по папке VST3-плагинов — installVst3FromZip в этом случае просто
    // скопировал бы всё содержимое архива «как есть» в системную папку плагинов,
    // включая сам .exe. Вместо этого — тот же безопасный флоу, что и у
    // plugins:downloadArchive: архив кладём в Downloads и показываем в проводнике,
    // пользователь запускает инсталлятор сам.
    if (!(await zipHasVst3(tmpFile))) {
      await assertScannedFileUnchanged(tmpFile, scannedHash)
      const destDir = join(app.getPath('downloads'), 'PlugHub')
      mkdirSync(destDir, { recursive: true })
      const destFile = join(destDir, `${safeDownloadName(target.name || target.id, target.id)}.zip`)
      copyFileSync(tmpFile, destFile)
      win.webContents.send('install:progress', { pluginId, step: 'done', pct: 100 })
      shell.showItemInFolder(destFile)
      return { ok: true }
    }

    await assertScannedFileUnchanged(tmpFile, scannedHash)
    win.webContents.send('install:progress', { pluginId, step: 'extract', pct: 0 })
    await installVst3FromZip(tmpFile, settings.vst3Path, win)

    markInstalled(pluginId, new Date().toISOString())
    if (premium) await logStudioInstall(target)

    win.webContents.send('install:progress', { pluginId, step: 'done', pct: 100 })
    return { ok: true }
  } catch (err: unknown) {
    const msg = toSafeError(err, 'Не удалось установить плагин.', '[install] performInstall error')
    win.webContents.send('install:progress', { pluginId, step: 'error', error: msg })
    return { ok: false, error: msg }
  } finally {
    if (tmpFile) {
      try { rmSync(tmpFile, { force: true }) } catch { /* ignore */ }
    }
  }
}

async function fetchCommunityContent(id: string): Promise<DbCommunityPlugin> {
  const normalizedId = String(id ?? '').trim()
  if (!normalizedId) throw new Error('Контент не найден.')

  const { data, error } = await supabase
    .from('community_plugins')
    .select('*')
    .eq('id', normalizedId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Контент не найден.')
  return data as DbCommunityPlugin
}

function extFromUrl(value: string): string {
  try {
    const pathname = new URL(value).pathname
    const ext = pathname.split('/').pop()?.split('.').pop()?.toLowerCase()
    return ext && ext.length <= 8 ? ext : 'bin'
  } catch {
    return 'bin'
  }
}

function contentDownloadName(row: DbCommunityPlugin): string {
  const ext = extFromUrl(row.download_url)
  const base = safeDownloadName(row.name || row.id, `${row.id}`)
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`
}

function tagsFromRow(row: DbCommunityPlugin): string[] {
  if (Array.isArray(row.tags) && row.tags.length > 0) {
    return row.tags.map((tag) => tag.replace(/^#/, '')).filter(Boolean)
  }
  return extractHashtagsFromText(row.description)
}

function descriptionFromRow(row: DbCommunityPlugin): string {
  return stripTrailingHashtagLine(row.description ?? '')
}

async function likedCommunityIds(ids: string[], userId?: string | null): Promise<Set<string>> {
  if (!userId || ids.length === 0) return new Set()
  const { data, error } = await supabase
    .from('community_likes')
    .select('plugin_id')
    .eq('user_id', userId)
    .in('plugin_id', ids)
  if (error) return new Set()
  return new Set(((data ?? []) as Array<{ plugin_id: string }>).map((row) => row.plugin_id))
}

function isMissingTagsColumnError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('tags') && (msg.includes('column') || msg.includes('schema cache'))
}

async function insertCommunityPlugin(row: Record<string, unknown>, tags: string[]) {
  const { error } = await supabase.from('community_plugins').insert({
    ...row,
    tags: tags.map((tag) => `#${tag}`)
  })
  if (!error) return
  if (!isMissingTagsColumnError(error)) throw error

  const fallbackRow = {
    ...row,
    description: appendHashtagsToText(String(row.description ?? ''), tags)
  }
  const fallback = await supabase.from('community_plugins').insert(fallbackRow)
  if (fallback.error) throw fallback.error
}

// Install helper

async function installVst3FromZip(
  zipPath: string,
  vst3Dir: string,
  win: BrowserWindow
): Promise<void> {
  // Случайный суффикс — иначе параллельные установки (в т.ч. РАЗНЫХ плагинов),
  // стартовавшие в пределах одного тика системного таймера, получат один extractDir.
  const extractDir = join(tmpdir(), `vst3-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(extractDir, { recursive: true })

  try {
    await extractZip(zipPath, { dir: extractDir, onEntry: makeZipExtractionGuard() })

    if (!existsSync(vst3Dir)) {
      mkdirSync(vst3Dir, { recursive: true })
    }

    // Рекурсивно ищем .vst3 в распакованной папке
    function findVst3(dir: string): string[] {
      const results: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const st = lstatSync(full)
        if (st.isSymbolicLink()) {
          continue
        }
        if (entry.endsWith('.vst3')) {
          results.push(full)
        } else if (st.isDirectory()) {
          results.push(...findVst3(full))
        }
      }
      return results
    }

    const vst3Files = findVst3(extractDir)

    if (vst3Files.length === 0) {
      // Нет .vst3 — копируем всё из архива как есть
      for (const entry of readdirSync(extractDir)) {
        const src = join(extractDir, entry)
        const dst = join(vst3Dir, entry)
        const st = lstatSync(src)
        if (st.isSymbolicLink()) {
          win.webContents.send('install:log', `Пропущена символическая ссылка: ${entry}`)
        } else if (st.isDirectory()) {
          copyDirRecursive(src, dst)
        } else {
          copyFileSync(src, dst)
        }
      }
    } else {
      for (const vst3 of vst3Files) {
        const name = vst3.split(/[\\/]/).pop()!
        const dst = join(vst3Dir, name)
        const st = lstatSync(vst3)
        if (st.isSymbolicLink()) {
          win.webContents.send('install:log', `Пропущена символическая ссылка: ${name}`)
          continue
        }
        if (st.isDirectory()) {
          copyDirRecursive(vst3, dst)
        } else {
          copyFileSync(vst3, dst)
        }
        win.webContents.send('install:log', `Скопирован: ${name}`)
      }
    }
  } finally {
    try { rmSync(extractDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcFull = join(src, entry)
    const dstFull = join(dst, entry)
    const st = lstatSync(srcFull)
    if (st.isSymbolicLink()) {
      continue
    }
    if (st.isDirectory()) {
      copyDirRecursive(srcFull, dstFull)
    } else {
      copyFileSync(srcFull, dstFull)
    }
  }
}

// ─── Безопасность сессии ────────────────────────────────────────────────────────

let sessionHardened = false

/**
 * Глобальная защита сессии рендерера:
 *  • Content-Security-Policy — рендерер не может подгружать удалённый код. Картинки
 *    идут из Supabase storage и Discord CDN, аудио — из Supabase; вся сеть к Supabase
 *    живёт в main-процессе (CSP на него не распространяется), поэтому connect-src узкий.
 *  • Запрет любых запросов разрешений (камера, микрофон, гео и т.п.) — приложению
 *    они не нужны.
 *  • Запрет подключения <webview>.
 */
function hardenSession(isDev: boolean, devServerUrl: string | undefined): void {
  if (sessionHardened) return
  sessionHardened = true

  const supabaseOrigin = 'https://*.supabase.co'
  const discordCdn = 'https://cdn.discordapp.com'
  // Cloud.ru Object Storage — origin новых загрузок. supabaseOrigin остаётся в
  // списке ради файлов, загруженных туда до миграции.
  const storageOrigin = new URL(STORAGE_PUBLIC_BASE_URL).origin
  const devConnect = isDev
    ? ` ${devServerUrl ? new URL(devServerUrl).origin : 'http://127.0.0.1:5173'} ws://127.0.0.1:* http://127.0.0.1:*`
    : ''
  // В dev-сборке Vite использует inline-скрипты и eval для HMR; в prod код только из бандла.
  const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'"

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabaseOrigin} ${storageOrigin} ${discordCdn}`,
    `media-src 'self' blob: ${supabaseOrigin} ${storageOrigin}`,
    `connect-src 'self'${devConnect}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  const sess = session.defaultSession

  sess.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  // Приложению не нужны системные разрешения — отклоняем все запросы и проверки.
  sess.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  sess.setPermissionCheckHandler(() => false)
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  nativeTheme.themeSource = 'dark'
  const isDev = !app.isPackaged
  const devServerUrl = process.env.ELECTRON_RENDERER_URL?.replace('localhost', '127.0.0.1')
  const rendererFilePath = join(__dirname, '../renderer/index.html')
  const rendererFileUrl = pathToFileURL(rendererFilePath).toString()

  hardenSession(isDev, devServerUrl)

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0e0e0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  // <webview> в приложении не используется — запрещаем его подключение полностью.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    const isDevRenderer =
      isDev && devServerUrl != null && url.startsWith(`${new URL(devServerUrl).origin}/`)
    const isPackagedRenderer = url === rendererFileUrl
    const isSameDocument = current && url.startsWith(current.split('#')[0])
    if (!isDevRenderer && !isPackagedRenderer && !isSameDocument) {
      event.preventDefault()
      if (isHttpUrl(url)) shell.openExternal(url)
    }
  })

  if (isDev && devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(rendererFilePath)
  }

  // ─── IPC: auth ───────────────────────────────────────────────────────────
  // Регистрирует каналы auth:* и подписку на изменение сессии (идемпотентно).
  // Сохранённая сессия восстанавливается лениво: первый auth:getState из renderer
  // расшифрует токены через safeStorage и вернёт актуальное состояние.
  registerAuthIpc()

  // ─── IPC: реферальная программа ──────────────────────────────────────────
  registerReferralIpc()

  // ─── IPC: streak-награды ─────────────────────────────────────────────────
  registerStreakIpc()

  // ─── IPC: премиум-чат (общая комната) ────────────────────────────────────
  registerChatIpc()

  // ─── IPC: AI-ассистент (чат + подбор плагинов) ───────────────────────────
  registerAiIpc()

  // ─── IPC: профиль вкусов для ленты «Для вас» (локальная история) ──────────
  registerTasteIpc()

  // currentWin переустанавливается при КАЖДОМ вызове createWindow() (в т.ч. повторном,
  // после macOS-цикла закрыть окно → Dock → activate) — в отличие от параметра
  // registerAppIpc(), который из-за appIpcInitialized захватывается только один раз.
  currentWin = win

  // Остальные ~24 канала (окно/настройки/маркетплейс/файлы) регистрируются
  // отдельной идемпотентной функцией — см. registerAppIpc() ниже.
  registerAppIpc()
}

let appIpcInitialized = false

// Текущее главное окно — хендлеры registerAppIpc() читают его при каждом вызове,
// а не захватывают в замыкании один раз. registerAppIpc() выполняет своё тело
// только при первом вызове createWindow() (см. ниже), поэтому window-параметр там
// «замораживался» бы на первом окне: после его пересоздания (macOS activate) все
// хендлеры продолжали бы слать вызовы в уже уничтоженный BrowserWindow.
let currentWin: BrowserWindow

// Регистрирует window:*, settings:*, plugins:*, shell:* и все прочие каналы,
// не зависящие от конкретного вызова createWindow(). Обёрнуто флагом по тому же
// паттерну, что registerAuthIpc()/registerReferralIpc()/registerChatIpc():
// на macOS клик по иконке в доке после закрытия всех окон вызывает 'activate' с
// BrowserWindow.getAllWindows().length === 0, и createWindow() выполняется повторно.
// Без этой защиты повторный ipcMain.handle('settings:get', ...) синхронно бросает
// Error('Attempted to register a second handler for "settings:get"') — а так как
// нигде в проекте не зарегистрирован process.on('uncaughtException'), это
// необработанное исключение убивает весь main-процесс Electron целиком.
function registerAppIpc(): void {
  if (appIpcInitialized) return
  appIpcInitialized = true

  // ─── IPC: window controls ────────────────────────────────────────────────
  // rejectUntrustedSender здесь не защищает от активно эксплуатируемого вектора (нет
  // <webview>/iframe, см. hardenSession) — это defense-in-depth для единообразия с
  // остальными каналами на случай будущего ослабления CSP/frame-политики.
  ipcMain.on('window:minimize', (event) => {
    if (!rejectUntrustedSender(event, currentWin)) currentWin.minimize()
  })
  ipcMain.on('window:maximize', (event) => {
    if (!rejectUntrustedSender(event, currentWin)) {
      currentWin.isMaximized() ? currentWin.unmaximize() : currentWin.maximize()
    }
  })
  ipcMain.on('window:close', (event) => {
    if (!rejectUntrustedSender(event, currentWin)) currentWin.close()
  })

  // ─── IPC: settings ───────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:save', (event, settings: AppSettings) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked
    if (!isValidVst3Path(settings?.vst3Path)) {
      return { ok: false, error: 'Некорректный путь к папке VST3.' }
    }
    saveSettings(settings)
    return { ok: true }
  })

  // ─── IPC: marketplace ────────────────────────────────────────────────────
  ipcMain.handle('plugins:list', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return []

    const installed = loadInstalled()

    try {
      const { data, error } = await supabase
        .from('plugins')
        .select('*')
        .order('name', { ascending: true })

      if (error) throw error

      const rows = (data ?? []) as DbPlugin[]
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        author: p.author,
        version: p.version,
        description: p.description,
        category: p.category,
        size: p.size ?? '—',
        downloadUrl: p.download_url,
        iconUrl: p.icon_url,
        installed: !!installed[p.id],
        installDate: installed[p.id]
      }))
    } catch (err) {
      console.error('[Supabase] plugins:list error:', err)
      // Возвращаем mock-данные как fallback
      return MOCK_PLUGINS.map((p) => ({
        ...p,
        installed: !!installed[p.id],
        installDate: installed[p.id]
      }))
    }
  })

  // ─── IPC: install plugin (авто-установка VST3) ───────────────────────────
  // Free: 5 автоустановок/сутки (лимит на сервере). При исчерпании возвращаем
  // limitReached/allowArchive — renderer предлагает «Скачать архивом». Премиум: безлимит.
  ipcMain.handle('plugins:install', async (event, pluginId: string, sourceTab?: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked
    const state = await getState()
    // withInstallLock: повторный клик по уже устанавливаемому pluginId не тратит
    // ещё один слот квоты и не запускает параллельную запись файлов — дожидается
    // результата уже идущей установки.
    return withInstallLock('install', pluginId, () => performInstall(pluginId, currentWin, state.premium, true, sourceTab))
  })

  // ─── IPC: скачать архивом (ручная установка, без списания слота) ──────────
  // Доступно всем: качаем ZIP плагина в Downloads/PlugHub и показываем в проводнике.
  // Для free скорость ограничена (7 Мбит/с), суточный лимит автоустановок НЕ тратится.
  // Для community-источника из БД файл сперва проходит карантин+VirusTotal,
  // и только потом попадает в Downloads.
  ipcMain.handle('plugins:downloadArchive', async (event, pluginId: string, sourceTab?: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked

    // withInstallLock: тот же ключ и Map, что у plugins:install/assets:download —
    // повторный клик по тому же pluginId дожидается уже идущего скачивания,
    // а не запускает второе параллельное копирование в тот же destFile.
    return withInstallLock('archive', pluginId, async () => {
      void sourceTab // UI hint only; security decisions use target.source from fetchInstallTarget().
      let quarantineFile = ''
      let destFile = ''
      try {
        const target = await fetchInstallTarget(pluginId)
        const skipScan = isScanExemptSource(target.source)
        const state = await getState()
        const destDir = join(app.getPath('downloads'), 'PlugHub')
        mkdirSync(destDir, { recursive: true })
        destFile = join(destDir, `${safeDownloadName(target.name || target.id, target.id)}.zip`)

        currentWin.webContents.send('install:progress', { pluginId, step: 'download', pct: 0 })
        const downloadTarget = skipScan
          ? destFile
          : join(getQuarantineDir(), `${target.source}-${target.id}-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`)
        if (!skipScan) quarantineFile = downloadTarget

        await downloadFile(target.url, downloadTarget, (pct) => {
          currentWin.webContents.send('install:progress', { pluginId, step: 'download', pct })
        }, downloadRateFor(state.premium))

        if (!skipScan) {
          const scan = await verifyDownloadedPlugin(pluginId, downloadTarget, currentWin)
          if (!scan.ok) {
            currentWin.webContents.send('install:progress', { pluginId, step: 'error', error: scan.error })
            return { ok: false, error: scan.error }
          }
          await assertScannedFileUnchanged(downloadTarget, scan.hash)
          copyFileSync(downloadTarget, destFile)
        }

        currentWin.webContents.send('install:progress', { pluginId, step: 'done', pct: 100 })
        shell.showItemInFolder(destFile)
        return { ok: true, path: destFile }
      } catch (err: unknown) {
        const msg = toSafeError(err, 'Не удалось скачать архив.', '[install] plugins:downloadArchive error')
        currentWin.webContents.send('install:progress', { pluginId, step: 'error', error: msg })
        return { ok: false, error: msg }
      } finally {
        if (quarantineFile) {
          try { rmSync(quarantineFile, { force: true }) } catch { /* ignore */ }
        }
      }
    })
  })

  // ─── IPC: статус суточного лимита автоустановок (для UI, без списания) ────
  ipcMain.handle('plugins:autoInstallStatus', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return { ok: false as const, error: 'Недоверенный источник.' }
    const state = await getState()
    if (state.premium) {
      return { ok: true as const, premium: true, unlimited: true }
    }
    try {
      const { data, error } = await supabase.rpc('peek_auto_install_quota', { p_limit: AUTO_INSTALL_DAILY_FREE })
      if (error) throw error
      const row = (Array.isArray(data) ? data[0] : data) as
        { used_now: number; limit_val: number; resets_at: string } | undefined
      return {
        ok: true as const,
        premium: false,
        unlimited: false,
        used: row?.used_now ?? 0,
        limit: row?.limit_val ?? AUTO_INSTALL_DAILY_FREE,
        resetsAt: row?.resets_at
      }
    } catch (err: unknown) {
      return { ok: false as const, error: toSafeError(err, 'Не удалось получить статус лимита.', '[ipc] plugins:autoInstallStatus error') }
    }
  })

  // ─── IPC: облачная студия (только премиум) ───────────────────────────────
  // Список установленных плагинов текущего юзера (RLS отдаёт только премиуму).
  ipcMain.handle('studio:list', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return { ok: false as const, error: 'Недоверенный источник.' }
    const state = await getState()
    if (!state.premium) return { ok: false as const, error: 'Облачная студия доступна только с премиумом.' }
    try {
      const { data, error } = await supabase
        .from('plugin_installs')
        .select('plugin_id, source, name, install_order')
        .order('install_order', { ascending: true })
      if (error) throw error
      const installed = loadInstalled()
      const items = ((data ?? []) as Array<{ plugin_id: string; source: string; name: string | null }>).map((r) => ({
        id: r.plugin_id,
        name: r.name ?? r.plugin_id,
        source: r.source,
        installed: !!installed[r.plugin_id]
      }))
      return { ok: true as const, items }
    } catch (err: unknown) {
      return { ok: false as const, error: toSafeError(err, 'Не удалось загрузить студию.', '[ipc] studio:list error') }
    }
  })

  // «Восстановить студию»: последовательно скачиваем и ставим плагины из облака.
  // Только премиум; безлимит по скорости и без суточного лимита. Прогресс — по
  // install:progress (id плагина). Уже установленные пропускаем (идемпотентность).
  // ponytail: единственный in-flight restore за раз — простой модульный флаг вместо
  // токена операции; если понадобится параллельный restore на несколько окон, заменить на Map<winId, boolean>.
  let studioRestoreCancelled = false

  ipcMain.handle('studio:restore', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked
    const state = await getState()
    if (!state.premium) return { ok: false, error: 'Восстановление студии доступно только с премиумом.' }
    studioRestoreCancelled = false
    try {
      const { data, error } = await supabase
        .from('plugin_installs')
        .select('plugin_id, install_order')
        .order('install_order', { ascending: true })
      if (error) throw error
      const ids = ((data ?? []) as Array<{ plugin_id: string }>).map((r) => r.plugin_id)
      const alreadyInstalled = loadInstalled()

      let installed = 0
      const failed: Array<{ id: string; error: string }> = []
      let cancelled = false
      for (const id of ids) {
        if (studioRestoreCancelled) { cancelled = true; break }
        if (alreadyInstalled[id]) { installed++; continue } // уже стоит — пропускаем
        // countsAgainstQuota=false: премиум, лимита нет.
        const res = await performInstall(id, currentWin, true, false)
        if (res.ok) installed++
        else failed.push({ id, error: res.error ?? 'Ошибка установки' })
      }
      return { ok: true, total: ids.length, installed, failed, cancelled }
    } catch (err: unknown) {
      return { ok: false, error: toSafeError(err, 'Не удалось восстановить студию.', '[ipc] studio:restore error') }
    }
  })

  ipcMain.handle('studio:restoreCancel', (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked
    studioRestoreCancelled = true
    return { ok: true }
  })

  // ─── IPC: admin catalog upload ───────────────────────────────────────────
  ipcMain.handle(
    'catalog:upload',
    async (
      event,
      meta: { name: string; author: string; version: string; description: string; category: string },
      filePath: string,
      iconPath?: string,
      uploadId?: string
    ) => {
      const blocked = rejectUntrustedSender(event, currentWin)
      if (blocked) return blocked

      const sendProgress = (step: UploadStep, extra?: { message?: string; error?: string }) => {
        if (uploadId) currentWin.webContents.send('upload:progress', { uploadId, step, ...extra })
      }

      const state = await getState()
      if (!state.isOwner || !state.user) {
        return { ok: false, error: 'Добавлять плагины в каталог может только админ.' }
      }
      if (!existsSync(filePath)) {
        return { ok: false, error: 'Файл архива не найден.' }
      }

      const slug = slugify(meta.name)
      const versionSlug = slugify(meta.version, 'version')
      const ts = Date.now()
      const pluginId = `${slug}-${ts}`
      const archiveKey = `${pluginId}/${slug}-${versionSlug}.zip`

      try {
        sendProgress('validate')
        const archiveSize = await withTimeout(
          validateUploadContent('plugin', filePath),
          VALIDATE_UPLOAD_TIMEOUT_MS,
          VALIDATE_TIMEOUT_MSG
        )
        assertUploadSizeLimit(archiveSize)

        sendProgress('upload')
        const archivePresign = await withTimeout(
          presignUpload('catalog', archiveKey, 'application/zip', archiveSize),
          STORAGE_PRESIGN_TIMEOUT_MS,
          STORAGE_TIMEOUT_MSG
        )
        await uploadFileToStorage(archivePresign.uploadUrl, { filePath }, 'application/zip')
        const downloadUrl = archivePresign.publicUrl

        let iconUrl: string | undefined
        if (iconPath && existsSync(iconPath)) {
          sendProgress('icon')
          const { ext: iconExt } = validateIconFile(iconPath)
          const iconKey = `${pluginId}/icon-${ts}.${iconExt}`
          const iconMime = contentTypeForExt(iconExt)
          const iconPresign = await withTimeout(
            presignUpload('catalog', iconKey, iconMime, statSync(iconPath).size),
            STORAGE_PRESIGN_TIMEOUT_MS,
            STORAGE_TIMEOUT_MSG
          )
          await uploadFileToStorage(iconPresign.uploadUrl, { filePath: iconPath }, iconMime)
          iconUrl = iconPresign.publicUrl
        }

        sendProgress('publish')
        const { error: insertError } = await supabase.from('plugins').insert({
          id: pluginId,
          name: meta.name,
          author: meta.author,
          version: meta.version,
          description: meta.description,
          category: meta.category,
          size: formatBytes(archiveSize),
          download_url: downloadUrl,
          icon_url: iconUrl,
          owner_id: state.user.id
        })
        if (insertError) throw insertError

        sendProgress('done')
        return { ok: true, id: pluginId }
      } catch (err: unknown) {
        const msg = toSafeError(err, 'Не удалось опубликовать каталог.', '[Supabase] catalog:upload error')
        sendProgress('error', { error: msg })
        return { ok: false, error: msg }
      }
    }
  )

  // ─── IPC: upload plugin ───────────────────────────────────────────────────
  ipcMain.handle(
    'plugins:upload',
    async (
      event,
      meta: { name: string; version: string; description: string; category: string; tags?: string[] },
      filePath: string,
      iconPath?: string,
      uploadId?: string
    ) => {
      const blocked = rejectUntrustedSender(event, currentWin)
      if (blocked) return blocked

      const sendProgress = (step: UploadStep, extra?: { message?: string; error?: string }) => {
        if (uploadId) currentWin.webContents.send('upload:progress', { uploadId, step, ...extra })
      }

      // Серверная проверка роли (defense-in-depth): даже если UI-блокировку обойдут,
      // публиковать может только author. Дополнительно это закрыто RLS на стороне БД.
      const state = await getState()
      if (state.role !== 'author') {
        return { ok: false, error: 'Только пользователи с ролью «author» могут публиковать плагины.' }
      }

      const uploadDir = join(app.getPath('userData'), 'uploads')
      mkdirSync(uploadDir, { recursive: true })

      const slug = slugify(meta.name)
      // meta.version приходит из renderer как есть — без slugify тут можно было
      // подсунуть '..'/'\' и вывести destZip за пределы uploadDir (path traversal).
      const versionSlug = slugify(meta.version, 'version')
      const destZip = join(uploadDir, `${slug}-${versionSlug}.zip`)

      try {
        sendProgress('validate')
        await withTimeout(
          validateUploadContent('plugin', filePath),
          VALIDATE_UPLOAD_TIMEOUT_MS,
          VALIDATE_TIMEOUT_MSG
        )
        sendProgress('upload')
        copyFileSync(filePath, destZip)
        if (iconPath && existsSync(iconPath)) {
          sendProgress('icon')
          const { ext } = validateIconFile(iconPath)
          copyFileSync(iconPath, join(uploadDir, `${slug}.${ext}`))
        }
        sendProgress('done')
        return { ok: true, path: destZip }
      } catch (err: unknown) {
        const msg = toSafeError(err, 'Не удалось подготовить плагин к загрузке.', '[ipc] plugins:upload error')
        sendProgress('error', { error: msg })
        return { ok: false, error: msg }
      }
    }
  )

  // ─── IPC: community marketplace (пользовательские плагины) ────────────────
  // Список: читают все.
  ipcMain.handle('community:list', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return []

    const installed = loadInstalled()
    try {
      const { data, error } = await supabase
        .from('community_plugins')
        .select('*')
        .or('kind.is.null,kind.eq.plugin')
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = ((data ?? []) as DbCommunityPlugin[]).filter((p) => (p.kind ?? 'plugin') === 'plugin')
      const state = await getState()
      const likedIds = await likedCommunityIds(
        rows.map((row) => row.id),
        state.user?.id
      )
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        author: p.author ?? '—',
        version: p.version ?? '',
        description: descriptionFromRow(p),
        category: p.category ?? 'Utility',
        size: p.size ?? '—',
        downloadUrl: p.download_url,
        iconUrl: p.icon_url ?? undefined,
        tags: tagsFromRow(p),
        uploaderId: p.uploader_id ?? undefined,
        authorIsPremium: !!p.author_is_premium,
        downloads: p.downloads ?? 0,
        likes: p.likes ?? 0,
        likedByMe: likedIds.has(p.id),
        installed: !!installed[p.id],
        installDate: installed[p.id]
      }))
    } catch (err) {
      console.error('[Supabase] community:list error:', err)
      return []
    }
  })

  // Загрузка: доступна ЛЮБОМУ вошедшему юзеру (без проверки роли).
  ipcMain.handle(
    'community:upload',
    async (
      event,
      meta: { name: string; version: string; description: string; category: string; tags?: string[] },
      filePath: string,
      iconPath?: string,
      uploadId?: string
    ) => {
      const blocked = rejectUntrustedSender(event, currentWin)
      if (blocked) return blocked

      const sendProgress = (step: UploadStep, extra?: { message?: string; error?: string }) => {
        if (uploadId) currentWin.webContents.send('upload:progress', { uploadId, step, ...extra })
      }

      const state = await getState()
      if (state.status !== 'signedIn' || !state.user) {
        return { ok: false, error: 'Войдите, чтобы загружать плагины в маркетплейс.' }
      }
      if (!existsSync(filePath)) {
        return { ok: false, error: 'Файл архива не найден.' }
      }
      const tagResult = normalizeHashtags(meta.tags)
      if (!tagResult.ok) {
        return { ok: false, error: tagResult.error ?? 'Некорректные хештеги.' }
      }

      const uploaderId = state.user.id
      const slug = slugify(meta.name)
      const ts = Date.now()
      const zipKey = `${uploaderId}/${slug}-${meta.version}-${ts}.zip`

      try {
        sendProgress('validate')
        const archiveSize = await withTimeout(
          validateUploadContent('plugin', filePath),
          VALIDATE_UPLOAD_TIMEOUT_MS,
          VALIDATE_TIMEOUT_MSG
        )
        assertUploadSizeLimit(archiveSize)

        sendProgress('upload')
        // Таймаут — чтобы зависший запрос к хранилищу не держал upload-хендлер вечно
        // (см. withTimeout выше и аналогичный фикс в src/main/antivirus.ts для VirusTotal).
        const archivePresign = await withTimeout(
          presignUpload('community', zipKey, 'application/zip', archiveSize),
          STORAGE_PRESIGN_TIMEOUT_MS,
          STORAGE_TIMEOUT_MSG
        )
        await uploadFileToStorage(archivePresign.uploadUrl, { filePath }, 'application/zip')
        const downloadUrl = archivePresign.publicUrl

        let iconUrl: string | undefined
        if (iconPath && existsSync(iconPath)) {
          sendProgress('icon')
          const { ext } = validateIconFile(iconPath)
          const iconKey = `${uploaderId}/${slug}-${ts}.${ext}`
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
          const iconPresign = await withTimeout(
            presignUpload('community', iconKey, mime, statSync(iconPath).size),
            STORAGE_PRESIGN_TIMEOUT_MS,
            STORAGE_TIMEOUT_MSG
          )
          await uploadFileToStorage(iconPresign.uploadUrl, { filePath: iconPath }, mime)
          iconUrl = iconPresign.publicUrl
        }

        sendProgress('publish')
        await insertCommunityPlugin({
          name: meta.name,
          author: state.user.displayName ?? state.user.email ?? 'Аноним',
          version: meta.version,
          description: meta.description,
          category: meta.category,
          size: formatBytes(archiveSize),
          download_url: downloadUrl,
          icon_url: iconUrl,
          uploader_id: uploaderId,
          kind: 'plugin'
        }, tagResult.tags)

        sendProgress('done')
        return { ok: true }
      } catch (err: unknown) {
        const msg = toSafeError(err, 'Не удалось опубликовать плагин.', '[Supabase] community:upload error')
        sendProgress('error', { error: msg })
        return { ok: false, error: msg }
      }
    }
  )

  // Инкремент счётчика скачиваний (best-effort, через security definer RPC).
  ipcMain.handle('community:bumpDownload', async (event, id: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return { ok: false }

    try {
      await supabase.rpc('bump_community_download', { p_id: id })
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // Удаление публикации/файла: только владелец приложения или автор публикации.
  ipcMain.handle(
    'community:delete',
    async (event, id: string) => {
      const blocked = rejectUntrustedSender(event, currentWin)
      if (blocked) return blocked

      const state = await getState()
      if (state.status !== 'signedIn' || !state.user) {
        return { ok: false, error: 'Не авторизован.' }
      }
      try {
        const row = await fetchCommunityContent(id)

        // Удалять чужие публикации нельзя — только свои (или владельцу приложения).
        if (!state.isOwner && row.uploader_id !== state.user.id) {
          return { ok: false, error: 'Удалять можно только свои публикации.' }
        }

        // .select() возвращает реально удалённые строки. Если RLS не дал удалить
        // (например, политика БД не обновлена), ошибки не будет, но строк будет 0 —
        // не сообщаем ложный успех, иначе карточка «вернётся» после обновления.
        const { data: deleted, error } = await supabase
          .from('community_plugins')
          .delete()
          .eq('id', id)
          .select('id')
        if (error) throw error
        if (!deleted || deleted.length === 0) {
          return {
            ok: false,
            error: 'Сервер отклонил удаление (недостаточно прав). Обновите политики БД из supabase/schema.sql.'
          }
        }

        const keys = [row.download_url, row.icon_url]
          .map((u) => objectKeyFromPublicUrl(u, 'community-plugins'))
          .filter((key): key is string => !!key)
        if (keys.length) {
          await deleteFromStorage('community', keys)
        }
        return { ok: true }
      } catch (err: unknown) {
        const msg = toSafeError(err, 'Не удалось удалить публикацию.', '[ipc] community:delete error')
        return { ok: false, error: msg }
      }
    }
  )

  // ─── IPC: ассеты (FLP-проекты, тимплейты, лупы) ───────────────────────────
  // Та же таблица community_plugins, но с дискриминатором kind. «Скачивание»
  // здесь — это загрузка файла в папку Downloads/PlugHub и показ его в проводнике
  // (в отличие от плагинов, которые распаковываются в папку VST3).

  const ASSET_KINDS = ['flp', 'template', 'loop', 'drumkit', 'beat', 'preset'] as const

  // Список ассетов выбранного типа.
  ipcMain.handle('assets:list', async (event, kind: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return []

    const installed = loadInstalled()
    try {
      // Bump (п.5): в ленте битов авторы с премиумом поднимаются наверх, затем по свежести.
      const base = supabase.from('community_plugins').select('*').eq('kind', kind)
      const query = kind === 'beat'
        ? base.order('author_is_premium', { ascending: false }).order('created_at', { ascending: false })
        : base.order('created_at', { ascending: false })
      const { data, error } = await query

      if (error) throw error

      const rows = (data ?? []) as DbCommunityPlugin[]
      const state = await getState()
      const likedIds = await likedCommunityIds(
        rows.map((row) => row.id),
        state.user?.id
      )
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        author: p.author ?? '—',
        version: p.version ?? '',
        description: descriptionFromRow(p),
        category: p.category ?? 'Other',
        size: p.size ?? '—',
        downloadUrl: p.download_url,
        iconUrl: p.icon_url ?? undefined,
        tags: tagsFromRow(p),
        uploaderId: p.uploader_id ?? undefined,
        authorIsPremium: !!p.author_is_premium,
        downloads: p.downloads ?? 0,
        likes: p.likes ?? 0,
        likedByMe: likedIds.has(p.id),
        price: p.price ?? undefined,
        paymentUrl: p.payment_url ?? undefined,
        previewWetUrl: p.preview_wet_url ?? undefined,
        previewDryUrl: p.preview_dry_url ?? undefined,
        installed: !!installed[p.id],
        installDate: installed[p.id]
      }))
    } catch (err) {
      console.error('[Supabase] assets:list error:', err)
      return []
    }
  })

  // Загрузка ассета: доступна любому вошедшему юзеру.
  ipcMain.handle(
    'assets:upload',
    async (
      event,
      kind: string,
      meta: {
        name: string; version: string; description: string; category: string
        price?: string; paymentUrl?: string; tags?: string[]
      },
      filePath: string,
      iconPath?: string,
      options?: UploadAssetOptions,
      uploadId?: string
    ) => {
      const blocked = rejectUntrustedSender(event, currentWin)
      if (blocked) return blocked

      const sendProgress = (step: UploadStep, extra?: { message?: string; error?: string }) => {
        if (uploadId) currentWin.webContents.send('upload:progress', { uploadId, step, ...extra })
      }

      const state = await getState()
      if (state.status !== 'signedIn' || !state.user) {
        return { ok: false, error: 'Войдите, чтобы загружать файлы.' }
      }
      if (!ASSET_KINDS.includes(kind as (typeof ASSET_KINDS)[number])) {
        return { ok: false, error: 'Неизвестный тип контента.' }
      }
      if (!existsSync(filePath)) {
        return { ok: false, error: 'Файл не найден.' }
      }

      const uploaderId = state.user.id
      sendProgress('validate')
      const fileSize = await withTimeout(
        validateUploadContent(kind, filePath),
        VALIDATE_UPLOAD_TIMEOUT_MS,
        VALIDATE_TIMEOUT_MSG
      )
      assertUploadSizeLimit(fileSize)
      const ext = extFromPath(filePath)
      const tagResult = normalizeHashtags(meta.tags)
      if (!tagResult.ok) {
        return { ok: false, error: tagResult.error ?? 'Некорректные хештеги.' }
      }
      // Цена бита в центах: нужна для валидации диапазона у free-авторов и для БД.
      let beatPriceCents: number | null = null
      if (kind === 'beat') {
        if (!meta.price?.trim()) {
          return { ok: false, error: 'Для бита нужно указать цену.' }
        }
        if (!isSafeExternalPaymentUrl(meta.paymentUrl)) {
          return { ok: false, error: 'Укажите HTTPS-ссылку Telegram: https://t.me/username' }
        }
        beatPriceCents = parsePriceToCents(meta.price)
        if (beatPriceCents === null) {
          return { ok: false, error: 'Не удалось распознать цену. Укажите сумму в долларах, напр. «10$».' }
        }
        // Free-авторы: цена строго $2–$15 (премиум — свободное ценообразование).
        // Дублирует серверный триггер enforce_beat_rules (defense-in-depth).
        if (!state.premium && (beatPriceCents < BEAT_PRICE_MIN_CENTS || beatPriceCents > BEAT_PRICE_MAX_CENTS)) {
          return { ok: false, error: 'Цена бита должна быть от $2 до $15. Свободная цена — с премиумом.' }
        }
      }
      // Пресеты: оба готовых аудиоклипа (с эффектами / без) обязательны — без них
      // нечем показать живое A/B-сравнение в карточке.
      if (kind === 'preset') {
        if (!options?.previewWetPath || !options?.previewDryPath) {
          return { ok: false, error: 'Для пресета нужны оба аудиоклипа: «с эффектами» и «без эффектов».' }
        }
        if (!existsSync(options.previewWetPath) || !existsSync(options.previewDryPath)) {
          return { ok: false, error: 'Файл аудио-превью не найден.' }
        }
        validateAudioPreviewFile(options.previewWetPath)
        validateAudioPreviewFile(options.previewDryPath)
      }
      const slug = slugify(meta.name, kind)
      const ts = Date.now()
      const previewBuffer = kind === 'beat' ? bufferFromIpc(options?.previewBuffer) : null
      if (kind === 'beat') {
        if (!previewBuffer) {
          return { ok: false, error: 'Выберите 30-секундный фрагмент бита перед загрузкой.' }
        }

        const duration = wavDurationSec(previewBuffer)
        if (duration === null) {
          return { ok: false, error: 'Превью бита должно быть WAV-файлом.' }
        }
        if (duration < BEAT_PREVIEW_SECONDS - 0.25) {
          return { ok: false, error: 'Превью бита должно быть ровно 30 секунд.' }
        }
        if (duration > BEAT_PREVIEW_SECONDS + 0.25) {
          return { ok: false, error: 'Превью бита не может быть длиннее 30 секунд.' }
        }
      }

      const uploadExt = previewBuffer ? 'wav' : ext
      // Для бита в хранилище уходит только 30-секундное превью (уже в памяти, оно
      // маленькое) — сам исходный файл, каким бы большим он ни был, стримим с диска,
      // а не грузим целиком в память (см. STORAGE_UPLOAD_TIMEOUT_MS).
      const uploadSource: UploadSource = previewBuffer ? { buffer: previewBuffer } : { filePath }
      const uploadSize = previewBuffer ? previewBuffer.length : fileSize
      const fileKey = `${kind}/${uploaderId}/${slug}-${ts}.${uploadExt}`
      const uploadContentType = contentTypeForExt(uploadExt)

      try {
        sendProgress('upload')
        const filePresign = await withTimeout(
          presignUpload('community', fileKey, uploadContentType, uploadSize),
          STORAGE_PRESIGN_TIMEOUT_MS,
          STORAGE_TIMEOUT_MSG
        )
        await uploadFileToStorage(filePresign.uploadUrl, uploadSource, uploadContentType)
        const downloadUrl = filePresign.publicUrl

        let iconUrl: string | undefined
        if (iconPath && existsSync(iconPath)) {
          sendProgress('icon')
          const { ext: iext } = validateIconFile(iconPath)
          const iconKey = `${kind}/${uploaderId}/${slug}-${ts}.${iext}`
          const mime = iext === 'png' ? 'image/png' : iext === 'webp' ? 'image/webp' : 'image/jpeg'
          const iconPresign = await withTimeout(
            presignUpload('community', iconKey, mime, statSync(iconPath).size),
            STORAGE_PRESIGN_TIMEOUT_MS,
            STORAGE_TIMEOUT_MSG
          )
          await uploadFileToStorage(iconPresign.uploadUrl, { filePath: iconPath }, mime)
          iconUrl = iconPresign.publicUrl
        }

        // Пресеты: два готовых аудиоклипа («с эффектами» / «без эффектов») для
        // живого A/B-сравнения в карточке — грузим тем же путём, что основной файл.
        let previewWetUrl: string | undefined
        let previewDryUrl: string | undefined
        if (kind === 'preset' && options?.previewWetPath && options?.previewDryPath) {
          const { ext: wetExt } = validateAudioPreviewFile(options.previewWetPath)
          const { ext: dryExt } = validateAudioPreviewFile(options.previewDryPath)
          const wetKey = `${kind}/${uploaderId}/${slug}-${ts}-wet.${wetExt}`
          const dryKey = `${kind}/${uploaderId}/${slug}-${ts}-dry.${dryExt}`
          const wetPresign = await withTimeout(
            presignUpload('community', wetKey, contentTypeForExt(wetExt), statSync(options.previewWetPath).size),
            STORAGE_PRESIGN_TIMEOUT_MS,
            STORAGE_TIMEOUT_MSG
          )
          await uploadFileToStorage(wetPresign.uploadUrl, { filePath: options.previewWetPath }, contentTypeForExt(wetExt))
          previewWetUrl = wetPresign.publicUrl

          const dryPresign = await withTimeout(
            presignUpload('community', dryKey, contentTypeForExt(dryExt), statSync(options.previewDryPath).size),
            STORAGE_PRESIGN_TIMEOUT_MS,
            STORAGE_TIMEOUT_MSG
          )
          await uploadFileToStorage(dryPresign.uploadUrl, { filePath: options.previewDryPath }, contentTypeForExt(dryExt))
          previewDryUrl = dryPresign.publicUrl
        }

        sendProgress('publish')
        await insertCommunityPlugin({
          name: meta.name,
          author: state.user.displayName ?? state.user.email ?? 'Аноним',
          version: meta.version,
          description: meta.description,
          category: meta.category,
          size: formatBytes(uploadSize),
          download_url: downloadUrl,
          icon_url: iconUrl,
          preview_wet_url: previewWetUrl,
          preview_dry_url: previewDryUrl,
          uploader_id: uploaderId,
          kind,
          price: meta.price || null,
          price_cents: beatPriceCents,
          payment_url: meta.paymentUrl || null
        }, tagResult.tags)

        sendProgress('done')
        return { ok: true }
      } catch (err: unknown) {
        // Понятные сообщения о серверных лимитах битов (триггер enforce_beat_rules).
        const raw = err instanceof Error ? err.message : String(err)
        if (raw.includes('BEAT_MONTHLY_LIMIT')) {
          const msg = 'Лимит бесплатного аккаунта: 3 бита в месяц. Продлится 1-го числа или снимается премиумом.'
          sendProgress('error', { error: msg })
          return { ok: false, error: msg }
        }
        if (raw.includes('BEAT_PRICE_RANGE')) {
          const msg = 'Цена бита должна быть от $2 до $15. Свободная цена — с премиумом.'
          sendProgress('error', { error: msg })
          return { ok: false, error: msg }
        }
        const msg = toSafeError(err, 'Не удалось опубликовать файл.', '[Supabase] assets:upload error')
        sendProgress('error', { error: msg })
        return { ok: false, error: msg }
      }
    }
  )

  // Скачивание ассета: качаем файл в Downloads/PlugHub/<kind> и показываем в проводнике.
  // Прогресс шлём по тому же каналу install:progress (id ассета = pluginId).
  // Ассеты, как и community-плагины, публикует любой залогиненный пользователь —
  // поэтому файл сначала попадает в карантин и проходит VirusTotal (см.
  // src/main/antivirus.ts, runFileSecurityScan), и только потом копируется в Downloads.
  ipcMain.handle('assets:download', async (event, id: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked

    // withInstallLock: тот же ключ и Map, что у plugins:install/downloadArchive —
    // повторный клик по тому же id дожидается уже идущего скачивания вместо
    // параллельной записи в тот же destFile.
    return withInstallLock('asset', id, async () => {
      let quarantineFile = ''
      let destFile = ''
      try {
        const asset = await fetchCommunityContent(id)
        if ((asset.kind ?? 'plugin') === 'plugin') {
          return { ok: false, error: 'Для плагинов используйте установку из каталога.' }
        }
        if ((asset.kind ?? '') === 'beat') {
          return { ok: false, error: 'Бит доступен только через ссылку оплаты автора.' }
        }
        // Месячный лимит скачиваний — только preset/loop/drumkit.
        // Premium безлимитен; free = 50 + бонусные слоты стрика текущего месяца.
        if (new Set(['preset', 'loop', 'drumkit']).has(asset.kind ?? '')) {
          const { data: quota, error: quotaErr } = await supabase.rpc('consume_asset_download_quota')
          const row = Array.isArray(quota) ? quota[0] : quota
          if (quotaErr) {
            return { ok: false, error: toSafeError(quotaErr, 'Не удалось проверить лимит скачиваний.', '[ipc] assets:download quota error') }
          }
          if (!row?.allowed) {
            return {
              ok: false,
              error: 'Достигнут месячный лимит скачиваний для бесплатного аккаунта. Продлите премиум или заберите бонус за стрик.'
            }
          }
        }
        if (!isHttpUrl(asset.download_url)) {
          return { ok: false, error: 'У файла некорректная ссылка загрузки.' }
        }

        const destDir = join(app.getPath('downloads'), 'PlugHub')
        mkdirSync(destDir, { recursive: true })
        const fileName = contentDownloadName(asset)
        destFile = join(destDir, fileName)
        // Путь строим из asset.id (проверенного значения из БД), а не из сырого IPC-параметра id —
        // сейчас это эквивалентно (колонка id имеет тип uuid), но не полагаемся на непроверенный ввод.
        quarantineFile = join(getQuarantineDir(), `asset-${asset.id}-${Date.now()}-${Math.random().toString(16).slice(2)}-${fileName}`)

        const state = await getState()
        currentWin.webContents.send('install:progress', { pluginId: id, step: 'download', pct: 0 })
        await downloadFile(asset.download_url, quarantineFile, (pct) => {
          currentWin.webContents.send('install:progress', { pluginId: id, step: 'download', pct })
        }, downloadRateFor(state.premium))

        currentWin.webContents.send('install:progress', { pluginId: id, step: 'scan', pct: 0 })
        const scan = await runFileSecurityScan(quarantineFile, (message) => {
          currentWin.webContents.send('install:progress', { pluginId: id, step: 'scan', pct: 0, message })
        })
        if (!scan.ok) {
          const error = scan.error ?? 'Файл не прошёл проверку безопасности.'
          currentWin.webContents.send('install:progress', { pluginId: id, step: 'error', error })
          return { ok: false, error }
        }

        await assertScannedFileUnchanged(quarantineFile, scan.hash)
        copyFileSync(quarantineFile, destFile)
        markInstalled(id, new Date().toISOString())
        currentWin.webContents.send('install:progress', { pluginId: id, step: 'done', pct: 100 })
        // .flp открываем в ассоциированном приложении (FL Studio); остальное —
        // показываем в проводнике, чтобы пользователь сам решил, что делать.
        if (destFile.toLowerCase().endsWith('.flp')) {
          shell.openPath(destFile)
        } else {
          shell.showItemInFolder(destFile)
        }
        return { ok: true, path: destFile }
      } catch (err: unknown) {
        const msg = toSafeError(err, 'Не удалось скачать файл.', '[ipc] assets:download error')
        currentWin.webContents.send('install:progress', { pluginId: id, step: 'error', error: msg })
        return { ok: false, error: msg }
      } finally {
        if (quarantineFile) {
          try { rmSync(quarantineFile, { force: true }) } catch { /* ignore */ }
        }
      }
    })
  })

  // ─── IPC: folder dialog ───────────────────────────────────────────────────
  ipcMain.handle('dialog:selectFolder', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return null

    const result = await dialog.showOpenDialog(currentWin, {
      properties: ['openDirectory'],
      title: 'Выберите папку VST3'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectFile', async (event, filters?: Electron.FileFilter[]) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return null

    const result = await dialog.showOpenDialog(currentWin, {
      properties: ['openFile'],
      filters: filters ?? [{ name: 'All Files', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('audio:readFile', async (event, filePath: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) throw new Error(blocked.error)

    if (!existsSync(filePath)) {
      throw new Error('Файл не найден.')
    }

    const { ext } = validateUploadedFile(filePath, AUDIO_FILE_EXTS)
    const data = readFileSync(filePath)
    if (!isAudioBuffer(ext, data)) {
      throw new Error('Файл не является настоящим аудио-файлом.')
    }

    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  })

  // ─── IPC: премиум-ключи (только владелец) ─────────────────────────────────
  // Серверная проверка прав — в функциях is_owner() в БД; здесь дублируем UI-gate.
  ipcMain.handle('premium:generate', async (event, count: number, note?: string, days?: number) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked

    const state = await getState()
    if (!state.isOwner) return { ok: false, error: 'Генерация ключей доступна только владельцу.' }
    const n = Math.max(1, Math.min(200, Math.floor(Number(count) || 1)))
    // Срок действия кода в днях (1..3650). По умолчанию 30.
    const d = Math.max(1, Math.min(3650, Math.floor(Number(days) || 30)))
    try {
      const { data, error } = await supabase.rpc('generate_premium_codes', {
        p_count: n,
        p_note: note?.trim() || null,
        p_duration_days: d
      })
      if (error) throw error
      return { ok: true, codes: (data as string[]) ?? [] }
    } catch (err: unknown) {
      const msg = toSafeError(err, 'Не удалось сгенерировать ключи.', '[ipc] premium:generate error')
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('premium:list', async (event) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked

    const state = await getState()
    if (!state.isOwner) return { ok: false, error: 'Доступ только для владельца.' }
    try {
      const { data, error } = await supabase.rpc('list_premium_codes')
      if (error) throw error
      type Row = {
        code: string; note: string | null; duration_days: number | null
        redeemed_by: string | null; redeemed_at: string | null; created_at: string
      }
      const codes = ((data as Row[]) ?? []).map((r) => ({
        code: r.code,
        note: r.note ?? undefined,
        durationDays: r.duration_days ?? undefined,
        redeemed: !!r.redeemed_by,
        redeemedBy: r.redeemed_by ?? undefined,
        redeemedAt: r.redeemed_at ?? undefined,
        createdAt: r.created_at
      }))
      return { ok: true, codes }
    } catch (err: unknown) {
      const msg = toSafeError(err, 'Не удалось загрузить ключи.', '[ipc] premium:list error')
      return { ok: false, error: msg }
    }
  })

  // ─── IPC: shell ───────────────────────────────────────────────────────────
  ipcMain.handle('shell:openPath', (event, p: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked.error

    const settingsPath = resolve(loadSettings().vst3Path)
    const target = resolve(String(p ?? ''))
    if (target !== settingsPath && !isSubpath(settingsPath, target)) {
      return 'Открывать можно только текущую папку VST3.'
    }
    return shell.openPath(target)
  })

  // Открыть внешнюю ссылку (оплата) в браузере. Разрешаем только http(s).
  ipcMain.handle('shell:openExternal', (event, url: string) => {
    const blocked = rejectUntrustedSender(event, currentWin)
    if (blocked) return blocked

    if (isHttpUrl(url)) shell.openExternal(url)
    return { ok: true }
  })
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

// На случай будущих непредвиденных синхронных ошибок в колбэках Electron —
// без этого необработанное исключение молча убивает весь main-процесс.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})

// ─── Реферальные ссылки (plughub://ref/<code>) ───────────────────────────────
//
// Регистрируем приложение обработчиком кастомного протокола: переход по ссылке
// с сайта (web/public/referral.html) открывает уже установленный PlugHub и
// активирует код так же, как ручной ввод (см. handleReferralDeepLink в referral.ts).
// В dev-режиме (process.defaultApp === true, запуск через `electron .`) нужно явно
// передать путь к электрону и скрипту — иначе ОС будет пытаться открывать ссылки
// самим electron.exe без аргументов.
const DEEP_LINK_PROTOCOL = 'plughub'

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL)
}

/** Первый аргумент вида `plughub://...` среди argv (Windows/Linux). */
function extractDeepLink(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? null
}

function dispatchDeepLink(raw: string | null): void {
  const code = raw ? parseReferralDeepLink(raw) : null
  if (code) void handleReferralDeepLink(code)
}

// macOS: и холодный старт по ссылке, и клик по ссылке при уже запущенном приложении.
app.on('open-url', (event, url) => {
  event.preventDefault()
  dispatchDeepLink(url)
})

// Второй запущенный экземпляр приложения не должен работать параллельно с первым:
// оба процесса пишут в один и тот же файл сессии (sessionStore), и без лока
// одновременный запуск может привести к потере данных при гонке на запись.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // Windows/Linux: клик по plughub://-ссылке при уже запущенном приложении запускает
  // второй процесс, который тут же завершается — а его argv с ссылкой прилетает сюда.
  app.on('second-instance', (_event, commandLine) => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    dispatchDeepLink(extractDeepLink(commandLine))
  })

  app.whenReady().then(() => {
    createWindow()
    // Windows/Linux: приложение ещё не было запущено — ссылка пришла в argv самого
    // первого процесса, second-instance для неё не сработает.
    dispatchDeepLink(extractDeepLink(process.argv))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
