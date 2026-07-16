import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  extFromPath,
  readMagicBytes,
  isZipMagic,
  isInsideVst3Bundle,
  isVst3ZipEntryMatch,
  findZipEntry,
  zipHasVst3,
  MAX_EXTRACTED_FILES,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  type ZipContentEntry
} from '../../../src/main/archive/zip-validation'
import { buildZip, type ZipEntrySpec } from '../../helpers/zip-fixture'

// Characterization + regression тесты вынесенного ZIP-модуля. Поведение НЕ
// проектируется — фиксируется как есть в текущей реализации (см. index.ts и
// docs/refactoring/zip-validation-extraction-plan.md §5, §7). Все тексты ошибок
// сверяются дословно (полная строка, не подстрока). Реальные ZIP пишутся во
// временный каталог; lifecycle/error-сценарии yauzl — в отдельном mock-файле.

const CORRUPT_MESSAGE = 'ZIP-архив повреждён или это файл другого типа.'
const NO_CONTENT_MESSAGE = 'В архиве нет подходящих файлов для загрузки.'
const TOO_MANY_MESSAGE = 'В архиве слишком много файлов.'
const TOO_BIG_MESSAGE = 'Файл внутри архива слишком большой.'
const TOO_LARGE_TOTAL_MESSAGE = 'Содержимое архива превышает допустимый размер.'

let workDir: string
let fileSeq = 0

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zipval-'))
  fileSeq = 0
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeZip(entries: ZipEntrySpec[]): string {
  const p = join(workDir, `fixture-${fileSeq++}.zip`)
  writeFileSync(p, buildZip(entries))
  return p
}

function writeRaw(bytes: Buffer): string {
  const p = join(workDir, `raw-${fileSeq++}.bin`)
  writeFileSync(p, bytes)
  return p
}

const alwaysFalse = async (): Promise<boolean> => false

describe('extFromPath — характеризация', () => {
  it('обычное расширение', () => {
    expect(extFromPath('song.wav')).toBe('wav')
  })
  it('отсутствие расширения', () => {
    // split('.') на 'README' → ['README'] → pop() → 'readme'. Текущее поведение.
    expect(extFromPath('README')).toBe('readme')
  })
  it('несколько точек — берётся последний сегмент', () => {
    expect(extFromPath('archive.tar.gz')).toBe('gz')
  })
  it('верхний регистр приводится к нижнему', () => {
    expect(extFromPath('Plugin.VST3')).toBe('vst3')
  })
  it('Windows-путь', () => {
    expect(extFromPath('C:\\plugins\\x.dll')).toBe('dll')
  })
  it('POSIX-путь', () => {
    expect(extFromPath('/usr/lib/x.so')).toBe('so')
  })
  it('смешанные разделители', () => {
    expect(extFromPath('a\\b/c.flp')).toBe('flp')
  })
  it('имя директории с точкой без файла-расширения', () => {
    // Последний сегмент 'MyPlug.vst3' → после точки 'vst3'.
    expect(extFromPath('root/MyPlug.vst3/')).toBe('')
  })
  it('пустая строка', () => {
    expect(extFromPath('')).toBe('')
  })
})

describe('readMagicBytes — характеризация', () => {
  it('default length = 12', () => {
    const p = writeRaw(Buffer.from('0123456789ABCDEF', 'utf8'))
    expect(readMagicBytes(p)).toEqual(Buffer.from('0123456789AB', 'utf8'))
  })
  it('явно заданный length', () => {
    const p = writeRaw(Buffer.from('0123456789ABCDEF', 'utf8'))
    expect(readMagicBytes(p, 4)).toEqual(Buffer.from('0123', 'utf8'))
  })
  it('файл короче запрошенной длины — возвращает только доступные байты', () => {
    const p = writeRaw(Buffer.from('AB', 'utf8'))
    expect(readMagicBytes(p, 12)).toEqual(Buffer.from('AB', 'utf8'))
  })
  it('пустой файл — пустой буфер', () => {
    const p = writeRaw(Buffer.alloc(0))
    expect(readMagicBytes(p)).toEqual(Buffer.alloc(0))
  })
  it('отсутствующий файл — бросает', () => {
    expect(() => readMagicBytes(join(workDir, 'nope.bin'))).toThrow()
  })
  it('дескриптор закрывается при успехе (2000 повторов не исчерпывают FD)', () => {
    const p = writeRaw(Buffer.from('0123456789ABCDEF', 'utf8'))
    for (let i = 0; i < 2000; i++) {
      expect(readMagicBytes(p, 4)).toEqual(Buffer.from('0123', 'utf8'))
    }
  })
})

describe('isZipMagic — характеризация', () => {
  it('504b0304 — валидный', () => {
    expect(isZipMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
  })
  it('504b0506 — валидный (пустой архив)', () => {
    expect(isZipMagic(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true)
  })
  it('504b0708 — валидный (spanned)', () => {
    expect(isZipMagic(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true)
  })
  it('произвольные байты — не ZIP', () => {
    expect(isZipMagic(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(false)
  })
  it('короткий Buffer (< 4 байт) — false', () => {
    expect(isZipMagic(Buffer.from([0x50, 0x4b, 0x03]))).toBe(false)
  })
  it('пустой Buffer — false', () => {
    expect(isZipMagic(Buffer.alloc(0))).toBe(false)
  })
  it('лишние байты после валидного magic не мешают (проверяются первые 4)', () => {
    expect(isZipMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]))).toBe(true)
  })
})

describe('isInsideVst3Bundle / isVst3ZipEntryMatch — характеризация', () => {
  const entry = (relativePath: string, ext: string, size: number): ZipContentEntry => ({
    relativePath,
    ext,
    size
  })

  it('обычный .vst3 файл в корне', () => {
    expect(isInsideVst3Bundle('MyPlug.vst3')).toBe(true)
    expect(isVst3ZipEntryMatch(entry('MyPlug.vst3', 'vst3', 10))).toBe(true)
  })
  it('файл внутри .vst3-бандла матчится по сегменту пути', () => {
    expect(isInsideVst3Bundle('MyPlug.vst3/Contents/x64/p.dll')).toBe(true)
    expect(isVst3ZipEntryMatch(entry('MyPlug.vst3/Contents/x64/p.dll', 'dll', 100))).toBe(true)
  })
  it('.VST3 в верхнем регистре (сегмент) — bundle матчится', () => {
    expect(isInsideVst3Bundle('MyPlug.VST3/Contents/p.dll')).toBe(true)
  })
  it('.VST3 верхний регистр как ext (extFromPath уже нормализует)', () => {
    expect(isVst3ZipEntryMatch(entry('x.VST3', extFromPath('x.VST3'), 5))).toBe(true)
  })
  it('похожее, но неверное расширение не матчится', () => {
    expect(isInsideVst3Bundle('MyPlug.vst3x/p.dll')).toBe(false)
    expect(isVst3ZipEntryMatch(entry('notes.vst', 'vst', 5))).toBe(false)
  })
  it('Windows-разделители', () => {
    expect(isInsideVst3Bundle('MyPlug.vst3\\Contents\\p.dll')).toBe(true)
  })
  it('POSIX-разделители', () => {
    expect(isInsideVst3Bundle('a/b/MyPlug.vst3/p.dll')).toBe(true)
  })
  it('смешанные разделители', () => {
    expect(isVst3ZipEntryMatch(entry('a\\b/MyPlug.vst3/p.dll', 'dll', 3))).toBe(true)
  })
  it('нулевой размер не матчится даже при ext=vst3 (size > 0 обязателен)', () => {
    expect(isVst3ZipEntryMatch(entry('MyPlug.vst3', 'vst3', 0))).toBe(false)
  })
  it('обычный не-vst3 файл вне бандла', () => {
    expect(isInsideVst3Bundle('docs/readme.txt')).toBe(false)
    expect(isVst3ZipEntryMatch(entry('docs/readme.txt', 'txt', 10))).toBe(false)
  })
})

describe('PATH-инварианты — path-safety НЕ на этом слое (страж регрессии, план §8)', () => {
  const entry = (relativePath: string): ZipContentEntry => ({
    relativePath,
    ext: extFromPath(relativePath),
    size: 10
  })
  // findZipEntry не может получить такие имена из РЕАЛЬНОГО ZIP: yauzl отвергает
  // '..', абсолютные пути и '\\' в validateFileName ДО события entry. Поэтому
  // path-инварианты фиксируются на уровне чистых классификаторов: они намеренно
  // НЕ отвергают traversal/абсолютные пути (это ответственность extract-этапа).
  it('15. абсолютный Windows-путь не отвергается классификатором', () => {
    expect(isVst3ZipEntryMatch(entry('C:\\plugins\\x.vst3'))).toBe(true)
  })
  it('15. абсолютный POSIX-путь не отвергается', () => {
    expect(isVst3ZipEntryMatch(entry('/opt/plugins/x.vst3'))).toBe(true)
  })
  it('16. traversal ../x.vst3 не отвергается (матч по расширению)', () => {
    expect(isVst3ZipEntryMatch(entry('../x.vst3'))).toBe(true)
  })
  it('17. mixed separators a\\b/c.vst3 — split по [\\\\/]', () => {
    expect(isVst3ZipEntryMatch(entry('a\\b/c.vst3'))).toBe(true)
  })
})

describe('findZipEntry / zipHasVst3 — реальные ZIP-фикстуры', () => {
  it('1. корректный ZIP с .vst3 → true', async () => {
    const p = writeZip([{ name: 'MyPlug.vst3', data: Buffer.from('vst3-bundle-bytes') }])
    await expect(zipHasVst3(p)).resolves.toBe(true)
    await expect(findZipEntry(p, async (e) => isVst3ZipEntryMatch(e))).resolves.toBe(true)
  })

  it('4. ZIP без записей → throw NO_CONTENT', async () => {
    const p = writeZip([])
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(NO_CONTENT_MESSAGE)
  })

  it('5. ZIP только с папками → throw NO_CONTENT (папки не считаются)', async () => {
    const p = writeZip([{ name: 'foo/' }, { name: 'foo/bar/' }])
    await expect(zipHasVst3(p)).rejects.toThrow(NO_CONTENT_MESSAGE)
  })

  it('6. единственный 0-байтный файл → throw NO_CONTENT (sawFile только при size>0)', async () => {
    const p = writeZip([{ name: 'empty.txt', data: Buffer.alloc(0) }])
    await expect(zipHasVst3(p)).rejects.toThrow(NO_CONTENT_MESSAGE)
  })

  it('7. файлы есть, matcher всегда false → resolve false (не throw)', async () => {
    const p = writeZip([{ name: 'a.txt', data: Buffer.from('x') }])
    await expect(findZipEntry(p, alwaysFalse)).resolves.toBe(false)
  })

  it('8. архив с .txt без .vst3 → zipHasVst3 false', async () => {
    const p = writeZip([{ name: 'notes.txt', data: Buffer.from('hello') }])
    await expect(zipHasVst3(p)).resolves.toBe(false)
  })

  it('11. directory entries не считаются файлами (папка + один .vst3)', async () => {
    const p = writeZip([
      { name: 'root/' },
      { name: 'root/MyPlug.vst3', data: Buffer.from('bytes') }
    ])
    await expect(zipHasVst3(p)).resolves.toBe(true)
  })

  it('12. resolve завершается без зависания на no-match (таймаут теста — страж)', async () => {
    const p = writeZip([
      { name: 'a.txt', data: Buffer.from('x') },
      { name: 'b.txt', data: Buffer.from('y') }
    ])
    await expect(findZipEntry(p, alwaysFalse)).resolves.toBe(false)
  })

  it('18. несколько .vst3 → резолвит на первой совпавшей, single-settle', async () => {
    const p = writeZip([
      { name: 'a.txt', data: Buffer.from('x') },
      { name: 'First.vst3', data: Buffer.from('one') },
      { name: 'Second.vst3', data: Buffer.from('two') }
    ])
    let matchCalls = 0
    const found = await findZipEntry(p, async (e) => {
      if (isVst3ZipEntryMatch(e)) {
        matchCalls += 1
        return true
      }
      return false
    })
    expect(found).toBe(true)
    expect(matchCalls).toBe(1)
  })

  it('19. файл внутри .vst3-бандла → true', async () => {
    const p = writeZip([
      { name: 'MyPlug.vst3/Contents/x64/MyPlug.dll', data: Buffer.from('dll-bytes') }
    ])
    await expect(zipHasVst3(p)).resolves.toBe(true)
  })

  it('2. битый ZIP (мусорные байты, плохой magic) → throw CORRUPT (синхронно, до yauzl)', async () => {
    const p = writeRaw(Buffer.from('this is definitely not a zip file'))
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(CORRUPT_MESSAGE)
  })

  it('3. валидный ZIP-magic, но ломаный central dir → throw CORRUPT (yauzl error path)', async () => {
    // Сигнатура 504b0304 проходит isZipMagic, но валидного EOCD нет → yauzl.open фейлит.
    const p = writeRaw(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]))
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(CORRUPT_MESSAGE)
  })

  it('16. openContent прокидывается в matcher и читает реальные данные один раз', async () => {
    const payload = Buffer.from('MZ-fake-pe-header-and-more')
    const p = writeZip([{ name: 'installer.exe', data: payload }])
    let opened = 0
    const found = await findZipEntry(p, async (e, openContent) => {
      if (e.ext !== 'exe') return false
      opened += 1
      const buf = await openContent()
      return buf.subarray(0, 2).toString('utf8') === 'MZ'
    })
    expect(found).toBe(true)
    expect(opened).toBe(1)
  })
})

describe('findZipEntry — лимиты (границы >, порядок проверок)', () => {
  const filler = (n: number): ZipEntrySpec[] =>
    Array.from({ length: n }, (_v, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }))

  it('MAX_EXTRACTED_FILES + 1 файлов отклоняется → TOO_MANY', async () => {
    const p = writeZip(filler(MAX_EXTRACTED_FILES + 1))
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(TOO_MANY_MESSAGE)
  })

  it('ровно MAX_EXTRACTED_FILES файлов НЕ отклоняется по лимиту количества', async () => {
    const p = writeZip(filler(MAX_EXTRACTED_FILES))
    // Граница `> MAX` не срабатывает; matcher false → resolve false (не TOO_MANY).
    await expect(findZipEntry(p, alwaysFalse)).resolves.toBe(false)
  })

  it('directory entries не увеличивают fileCount (MAX+1 папок → NO_CONTENT, не TOO_MANY)', async () => {
    const dirs = Array.from({ length: MAX_EXTRACTED_FILES + 1 }, (_v, i) => ({ name: `d${i}/` }))
    const p = writeZip(dirs)
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(NO_CONTENT_MESSAGE)
  })

  it('размер ровно MAX_SINGLE_FILE_BYTES разрешён (граница >, не throw)', async () => {
    const p = writeZip([{ name: 'big.bin', forgedUncompressedSize: MAX_SINGLE_FILE_BYTES }])
    await expect(findZipEntry(p, alwaysFalse)).resolves.toBe(false)
  })

  it('размер MAX_SINGLE_FILE_BYTES + 1 отклоняется → TOO_BIG', async () => {
    const p = writeZip([{ name: 'big.bin', forgedUncompressedSize: MAX_SINGLE_FILE_BYTES + 1 }])
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(TOO_BIG_MESSAGE)
  })

  it('суммарный размер ровно MAX_TOTAL_UNCOMPRESSED_BYTES разрешён', async () => {
    const half = MAX_TOTAL_UNCOMPRESSED_BYTES / 2
    const p = writeZip([
      { name: 'a.bin', forgedUncompressedSize: half },
      { name: 'b.bin', forgedUncompressedSize: half }
    ])
    await expect(findZipEntry(p, alwaysFalse)).resolves.toBe(false)
  })

  it('суммарный размер MAX_TOTAL_UNCOMPRESSED_BYTES + 1 отклоняется → TOO_LARGE_TOTAL', async () => {
    const half = MAX_TOTAL_UNCOMPRESSED_BYTES / 2
    const p = writeZip([
      { name: 'a.bin', forgedUncompressedSize: half },
      { name: 'b.bin', forgedUncompressedSize: half + 1 }
    ])
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(TOO_LARGE_TOTAL_MESSAGE)
  })

  it('порядок: single-file size проверяется раньше total (одна запись > per-file)', async () => {
    const p = writeZip([{ name: 'huge.bin', forgedUncompressedSize: MAX_SINGLE_FILE_BYTES + 1 }])
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(TOO_BIG_MESSAGE)
  })

  it('uncompressedSize=0 (Number(...)||0) не ломает счётчик — 0-байтные → NO_CONTENT', async () => {
    const p = writeZip([{ name: 'z.bin', forgedUncompressedSize: 0 }])
    await expect(findZipEntry(p, alwaysFalse)).rejects.toThrow(NO_CONTENT_MESSAGE)
  })
})
