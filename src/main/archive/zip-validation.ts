// Низкоуровневый анализ и валидация ZIP-архивов — вынесено из src/main/index.ts.
// Модуль намеренно зависит только от `fs` и `yauzl`: он НЕ импортирует Electron,
// Supabase, index.ts или antivirus.ts, чтобы оставаться unit-тестируемым без
// поднятия Electron и не создавать циклических импортов. Бизнес-оркестрация загрузки
// (`assertZipUploadContent`) остаётся в index.ts, а `makeZipExtractionGuard` находится
// в ./zip-extraction-guard.ts. Этот модуль отвечает за low-level ZIP inspection,
// общие лимиты и validation helpers.

import { openSync, readSync, closeSync } from 'fs'
import yauzl from 'yauzl'
import type { ZipContentEntry } from './archive-types'

export type { ZipContentEntry }

const ZIP_MAGIC_VALUES = new Set(['504b0304', '504b0506', '504b0708'])

// ─── Защита от zip-бомб ─────────────────────────────────────────────────────────
// Распаковываем архивы только в один уровень, но и здесь злонамеренный архив может
// объявить гигантское содержимое. Лимитируем число файлов и суммарный распакованный
// размер; превышение прерывает extract-zip (исключение из onEntry → reject).
export const MAX_EXTRACTED_FILES = 10_000
export const MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024 * 1024 // 4 GiB на файл
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024 // 4 GiB суммарно

// Сколько байт записи из архива буферизуем в памяти для проверки magic-байтов
// (FLP/WAV/MP3/... заголовки укладываются в первые несколько КБ; 1 МиБ — щедрый запас
// на случай больших служебных чанков перед данными, например LIST/INFO в WAV).
export const ZIP_CONTENT_PEEK_BYTES = 1024 * 1024

export function extFromPath(value: string): string {
  return (value.split(/[\\/]/).pop()?.split('.').pop() ?? '').toLowerCase()
}

export function readMagicBytes(filePath: string, length = 12): Buffer {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

export function isZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && ZIP_MAGIC_VALUES.has(buffer.subarray(0, 4).toString('hex'))
}

export function isInsideVst3Bundle(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((part) => part.toLowerCase().endsWith('.vst3'))
}

export function isVst3ZipEntryMatch(entry: ZipContentEntry): boolean {
  return entry.size > 0 && (entry.ext === 'vst3' || isInsideVst3Bundle(entry.relativePath))
}

/**
 * Ищет в ZIP запись, удовлетворяющую onEntry, читая только центральный каталог и,
 * при необходимости, содержимое конкретных кандидатов — БЕЗ распаковки архива на
 * диск. Раньше валидация загрузки (community:upload и т.п.) распаковывала весь
 * архив во временную папку через extract-zip только чтобы проверить наличие
 * .vst3/.flp/аудио — на архивах в десятки-сотни МБ с тысячами файлов это давало
 * заметную задержку и создавало тысячи временных файлов (лишняя нагрузка на
 * диск и на антивирус ОС, который их сканирует на лету). yauzl читает central
 * directory без записи файлов на диск и открывает поток отдельной записи только
 * если она нужна onEntry для проверки содержимого.
 */
export async function findZipEntry(
  zipPath: string,
  onEntry: (entry: ZipContentEntry, openContent: () => Promise<Buffer>) => Promise<boolean>
): Promise<boolean> {
  if (!isZipMagic(readMagicBytes(zipPath))) {
    throw new Error('ZIP-архив повреждён или это файл другого типа.')
  }

  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    let fileCount = 0
    let totalBytes = 0
    let sawFile = false
    let settled = false

    const finish = (err: Error | null, ok = false): void => {
      if (settled) return
      settled = true
      if (err) rejectPromise(err)
      else resolvePromise(ok)
    }

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        finish(new Error('ZIP-архив повреждён или это файл другого типа.'))
        return
      }

      zipfile.on('error', () => finish(new Error('ZIP-архив повреждён или это файл другого типа.')))

      zipfile.on('end', () => {
        finish(sawFile ? null : new Error('В архиве нет подходящих файлов для загрузки.'), false)
      })

      zipfile.on('entry', (entry) => {
        if (settled) return
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry()
          return
        }

        fileCount += 1
        if (fileCount > MAX_EXTRACTED_FILES) {
          finish(new Error('В архиве слишком много файлов.'))
          return
        }
        const size = Number(entry.uncompressedSize) || 0
        if (size > MAX_SINGLE_FILE_BYTES) {
          finish(new Error('Файл внутри архива слишком большой.'))
          return
        }
        totalBytes += size
        if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          finish(new Error('Содержимое архива превышает допустимый размер.'))
          return
        }
        if (size > 0) sawFile = true

        const info: ZipContentEntry = { relativePath: entry.fileName, ext: extFromPath(entry.fileName), size }
        const openContent = (): Promise<Buffer> =>
          new Promise<Buffer>((res, rej) => {
            zipfile.openReadStream(entry, (streamErr, stream) => {
              if (streamErr || !stream) {
                rej(streamErr ?? new Error('Не удалось прочитать файл из архива.'))
                return
              }
              const chunks: Buffer[] = []
              let bytesRead = 0
              let doneReading = false
              const finishRead = (): void => {
                if (doneReading) return
                doneReading = true
                res(Buffer.concat(chunks))
              }
              stream.on('data', (chunk: Buffer) => {
                if (doneReading) return
                bytesRead += chunk.length
                chunks.push(chunk)
                if (bytesRead >= ZIP_CONTENT_PEEK_BYTES) {
                  // Достаточно байт для проверки magic-заголовка — резолвим СРАЗУ и
                  // прекращаем чтение. Раньше здесь только вызывался stream.destroy()
                  // и код ждал события 'end'/'close', чтобы резолвить промис. Но
                  // destroy() у распакованного потока yauzl эти события не гарантирует
                  // (в частности, при отсутствии обработчика они могут не прийти),
                  // из-за чего openContent() зависал до внешнего withTimeout — это и
                  // давало «Проверка содержимого архива не уложилась в отведённое время»
                  // на архивах с крупным первым файлом (напр. .exe-инсталлятор ≥1 МиБ).
                  finishRead()
                  stream.destroy()
                }
              })
              stream.on('end', finishRead)
              stream.on('close', finishRead)
              stream.on('error', (streamReadErr) => {
                if (doneReading) return
                doneReading = true
                rej(streamReadErr)
              })
            })
          })

        Promise.resolve(onEntry(info, openContent))
          .then((isMatch) => {
            if (settled) return
            if (isMatch) {
              finish(null, true)
            } else {
              zipfile.readEntry()
            }
          })
          .catch((entryErr: unknown) => finish(entryErr instanceof Error ? entryErr : new Error(String(entryErr))))
      })

      zipfile.readEntry()
    })
  })
}

/** Есть ли в архиве настоящий .vst3-бандл/файл (без чтения содержимого — только central directory). */
export async function zipHasVst3(zipPath: string): Promise<boolean> {
  return findZipEntry(zipPath, async (entry) => isVst3ZipEntryMatch(entry))
}
