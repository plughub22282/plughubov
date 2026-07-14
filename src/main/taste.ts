import { app, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { rejectUntrustedSender } from './ipc-security'
import {
  applyTasteEvent,
  emptyStore,
  rankCategories,
  type CategoryStat,
  type TasteEvent,
  type TasteRecordInput,
  type TasteStore
} from './tasteScore'

/**
 * Локальный профиль вкусов для персональной ленты «Для вас» — IO-оболочка.
 *
 * Собирает историю открытий категорий, прослушиваний (превью в карточках + глобальный
 * мини-плеер) и скачиваний, агрегируя её по категориям. В отличие от plugin_installs
 * (облачная студия, только премиум), профиль хранится локально в userData и ведётся для
 * всех пользователей — он нужен только для сортировки ленты на этом устройстве и не
 * содержит ничего, что стоило бы синхронизировать на сервер.
 *
 * Вся математика ранжирования (затухание + веса) живёт в tasteScore.ts (без Electron),
 * чтобы её можно было проверять самопроверкой; здесь — только чтение/запись файла и IPC.
 */

let cachedPath: string | null = null
function storeFile(): string {
  if (!cachedPath) cachedPath = join(app.getPath('userData'), 'taste.json')
  return cachedPath
}

function loadStore(): TasteStore {
  try {
    const raw = readFileSync(storeFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TasteStore>
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      totalEvents: typeof parsed.totalEvents === 'number' ? parsed.totalEvents : 0,
      categories: parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {},
      recent: Array.isArray(parsed.recent) ? parsed.recent : []
    }
  } catch {
    return emptyStore()
  }
}

function saveStore(store: TasteStore): void {
  const file = storeFile()
  const tmp = `${file}.tmp`
  // Атомарная запись (как installed.json/settings.json), чтобы не оставить обрезанный файл.
  writeFileSync(tmp, JSON.stringify(store), 'utf-8')
  renameSync(tmp, file)
}

/** Профиль для renderer: категории, отсортированные по аффинности (топ ленты — сверху). */
function getProfile(): { categories: CategoryStat[]; recent: TasteEvent[]; totalEvents: number } {
  const store = loadStore()
  return { categories: rankCategories(store), recent: store.recent, totalEvents: store.totalEvents }
}

let ipcInitialized = false

export function registerTasteIpc(): void {
  if (ipcInitialized) return
  ipcInitialized = true

  ipcMain.handle('taste:record', (event, input: TasteRecordInput) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    try {
      // Date.now() допустим в main; в отличие от workflow-скриптов здесь нет ограничения.
      saveStore(applyTasteEvent(loadStore(), input ?? { type: 'play' }, Date.now()))
      return { ok: true as const }
    } catch {
      // best-effort: сбор истории не должен ломать проигрывание/скачивание.
      return { ok: false as const }
    }
  })

  ipcMain.handle('taste:get', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return { categories: [], recent: [], totalEvents: 0 }
    return getProfile()
  })
}
