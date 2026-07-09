import { app, safeStorage } from 'electron'
import { join } from 'path'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  chmodSync
} from 'fs'

/**
 * Зашифрованное хранилище сессии Supabase.
 *
 * Реализует интерфейс `SupportedStorage` из supabase-js (getItem/setItem/removeItem).
 * supabase-js сам кладёт сюда сессию (access_token / refresh_token) под единственным
 * ключом `storageKey` и сам её обновляет (autoRefreshToken). Наша задача — хранить
 * значения на диске в зашифрованном виде.
 *
 * Шифрование выполняет Electron `safeStorage`, который использует системный механизм:
 *   • Windows — DPAPI (ключ привязан к учётной записи пользователя ОС);
 *   • macOS   — Keychain;
 *   • Linux   — libsecret / kwallet (если доступен keyring).
 *
 * Расшифровать файл может только тот же пользователь ОС на той же машине — даже при
 * краже файла токены бесполезны. Токены никогда не покидают main-процесс.
 */

// Версия формата на диске. v1 = безопасный (safeStorage). v0 = деградация (base64, без шифрования).
const ENC_PREFIX = 'v1:'
const PLAIN_PREFIX = 'v0:'

let cachedPath: string | null = null

function storeFile(): string {
  // app.getPath доступен только после ready; методы адаптера вызываются Supabase
  // исключительно во время auth-операций, т.е. уже после whenReady.
  if (!cachedPath) {
    cachedPath = join(app.getPath('userData'), 'auth.session.enc')
  }
  return cachedPath
}

/** Прочитать и расшифровать весь объект хранилища. Любая ошибка → пустой объект. */
function readAll(): Record<string, string> {
  // safeStorage доступен только после app ready; Supabase вызывает getItem
  // в конструкторе клиента — до готовности. Возвращаем {} без ошибки, сессия
  // будет перечитана при первом реальном getSession() (уже после ready).
  if (!app.isReady()) return {}

  const file = storeFile()
  if (!existsSync(file)) return {}

  try {
    const raw = readFileSync(file, 'utf-8')

    if (raw.startsWith(ENC_PREFIX)) {
      const encrypted = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64')
      const json = safeStorage.decryptString(encrypted)
      return JSON.parse(json)
    }

    if (raw.startsWith(PLAIN_PREFIX)) {
      const json = Buffer.from(raw.slice(PLAIN_PREFIX.length), 'base64').toString('utf-8')
      return JSON.parse(json)
    }

    return {}
  } catch (err) {
    // Повреждённый/нерасшифровываемый файл (например, сменился пользователь ОС) —
    // считаем сессию недействительной, требуем повторный вход.
    console.warn('[sessionStore] не удалось прочитать сессию, сбрасываю:', err)
    return {}
  }
}

/** Атомарно зашифровать и записать весь объект хранилища. */
function writeAll(data: Record<string, string>): void {
  const file = storeFile()
  const tmp = `${file}.tmp`
  const json = JSON.stringify(data)

  let payload: string
  if (safeStorage.isEncryptionAvailable()) {
    payload = ENC_PREFIX + safeStorage.encryptString(json).toString('base64')
  } else {
    // Редкий случай: Linux без доступного keyring. Не падаем, но и не делаем вид,
    // что данные защищены — храним как base64 и громко предупреждаем.
    console.warn(
      '[sessionStore] safeStorage недоступен — сессия будет сохранена БЕЗ шифрования.'
    )
    payload = PLAIN_PREFIX + Buffer.from(json, 'utf-8').toString('base64')
  }

  writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* на Windows права POSIX игнорируются */
  }
}

export const sessionStore = {
  getItem(key: string): string | null {
    const all = readAll()
    return key in all ? all[key] : null
  },

  setItem(key: string, value: string): void {
    const all = readAll()
    all[key] = value
    writeAll(all)
  },

  removeItem(key: string): void {
    const all = readAll()
    if (!(key in all)) return
    delete all[key]

    if (Object.keys(all).length === 0) {
      // Хранилище опустело (выход) — удаляем файл целиком.
      try {
        rmSync(storeFile(), { force: true })
      } catch {
        /* ignore */
      }
    } else {
      writeAll(all)
    }
  }
}
