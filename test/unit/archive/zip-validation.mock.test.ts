import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// yauzl мокируется тем же specifier, что и в модуле, ТОЛЬКО для lifecycle/error
// сценариев, которые трудно/невозможно воспроизвести реальным ZIP: ошибка
// yauzl.open, событие 'error' у zipfile, ошибка потока записи, а также
// settled-guard (промис резолвится один раз). Мок проверяет ВНЕШНИЙ контракт
// findZipEntry, а не порядок внутренних вызовов. Для magic-проверки на диске
// лежит реальный файл с валидной ZIP-сигнатурой (isZipMagic отрабатывает до
// yauzl.open).
vi.mock('yauzl', () => ({ default: { open: vi.fn() } }))

import yauzl from 'yauzl'
import { findZipEntry } from '../../../src/main/archive/zip-validation'

const mockedOpen = vi.mocked(yauzl.open)
const CORRUPT_MESSAGE = 'ZIP-архив повреждён или это файл другого типа.'
const READ_FAIL_MESSAGE = 'Не удалось прочитать файл из архива.'

let workDir: string
let zipPath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zipval-mock-'))
  zipPath = join(workDir, 'valid-magic.zip')
  // Валидная ZIP-сигнатура 504b0304, чтобы isZipMagic пропустил до yauzl.open.
  writeFileSync(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type OpenCb = (err: Error | null, zip: unknown) => void
type StreamCb = (err: Error | null, stream: unknown) => void

// Минимальный фейк zipfile с интерфейсом, который использует findZipEntry.
class FakeZipfile extends EventEmitter {
  public openReadStream = vi.fn()
  public readEntry = vi.fn()
}

const alwaysFalse = async (): Promise<boolean> => false

describe('findZipEntry — yauzl.open error path', () => {
  it('13. yauzl.open возвращает ошибку → reject CORRUPT (полная строка)', async () => {
    mockedOpen.mockImplementation(((_p: string, _o: unknown, cb: OpenCb) => {
      cb(new Error('open boom'), null)
    }) as never)
    await expect(findZipEntry(zipPath, alwaysFalse)).rejects.toThrow(CORRUPT_MESSAGE)
  })

  it('13b. yauzl.open отдаёт (null, null) → reject CORRUPT', async () => {
    mockedOpen.mockImplementation(((_p: string, _o: unknown, cb: OpenCb) => {
      cb(null, null)
    }) as never)
    await expect(findZipEntry(zipPath, alwaysFalse)).rejects.toThrow(CORRUPT_MESSAGE)
  })
})

describe('findZipEntry — zipfile error event', () => {
  it('14. zipfile испускает error → reject CORRUPT (полная строка)', async () => {
    mockedOpen.mockImplementation(((_p: string, _o: unknown, cb: OpenCb) => {
      const zf = new FakeZipfile()
      zf.readEntry.mockImplementation(() => {
        setImmediate(() => zf.emit('error', new Error('zipfile boom')))
      })
      cb(null, zf)
    }) as never)
    await expect(findZipEntry(zipPath, alwaysFalse)).rejects.toThrow(CORRUPT_MESSAGE)
  })
})

describe('findZipEntry — entry stream errors', () => {
  const emitOneFile = (zf: FakeZipfile): void => {
    zf.readEntry.mockImplementation(() => {
      setImmediate(() => zf.emit('entry', { fileName: 'a.bin', uncompressedSize: 10 }))
    })
  }

  it('15. openReadStream отдаёт stream error → openContent reject прокидывается', async () => {
    mockedOpen.mockImplementation(((_p: string, _o: unknown, cb: OpenCb) => {
      const zf = new FakeZipfile()
      zf.openReadStream.mockImplementation((_entry: unknown, scb: StreamCb) => {
        const stream = new EventEmitter()
        scb(null, stream)
        setImmediate(() => stream.emit('error', new Error('stream boom')))
      })
      emitOneFile(zf)
      cb(null, zf)
    }) as never)

    await expect(
      findZipEntry(zipPath, async (_entry, openContent) => {
        await openContent()
        return true
      })
    ).rejects.toThrow('stream boom')
  })

  it('18-err. openReadStream отдаёт (null, null) → READ_FAIL (полная строка)', async () => {
    mockedOpen.mockImplementation(((_p: string, _o: unknown, cb: OpenCb) => {
      const zf = new FakeZipfile()
      zf.openReadStream.mockImplementation((_entry: unknown, scb: StreamCb) => {
        scb(null, null)
      })
      emitOneFile(zf)
      cb(null, zf)
    }) as never)

    await expect(
      findZipEntry(zipPath, async (_entry, openContent) => {
        await openContent()
        return true
      })
    ).rejects.toThrow(READ_FAIL_MESSAGE)
  })

  it('settled-guard: error/end после успешного резолва игнорируются (один settle)', async () => {
    mockedOpen.mockImplementation(((_p: string, _o: unknown, cb: OpenCb) => {
      const zf = new FakeZipfile()
      zf.readEntry.mockImplementation(() => {
        setImmediate(() => {
          zf.emit('entry', { fileName: 'hit.vst3', uncompressedSize: 5 })
          // Повторные события после резолва должны быть проглочены settled-guard.
          setImmediate(() => {
            zf.emit('error', new Error('late boom'))
            zf.emit('end')
          })
        })
      })
      cb(null, zf)
    }) as never)

    // matcher сразу true → finish(null, true); последующие error/end не должны
    // перекинуть промис в reject.
    await expect(findZipEntry(zipPath, async () => true)).resolves.toBe(true)
  })
})

describe('findZipEntry — openContent PEEK (реальный поток > 1 MiB)', () => {
  it('17/20. openContent резолвит по ZIP_CONTENT_PEEK_BYTES и не виснет', async () => {
    // Реальный STORED-файл ~1.5 MiB: openContent обязан резолвить по достижении
    // PEEK-порога (1 MiB) через stream.destroy(), не ожидая 'end' — страж против
    // зависания на крупном первом файле. Здесь мок yauzl заменяется реальной
    // реализацией (importActual), чтобы поток был настоящим. 1.5 MiB — не гигабайты.
    const { buildZip } = await import('../../helpers/zip-fixture')
    const actualYauzl = await vi.importActual<typeof import('yauzl')>('yauzl')
    mockedOpen.mockImplementation(actualYauzl.default.open as never)

    const big = Buffer.alloc(1_500_000, 0x41)
    const p = join(workDir, 'peek.zip')
    writeFileSync(p, buildZip([{ name: 'big.bin', data: big }]))

    let readLen = -1
    const found = await findZipEntry(p, async (_entry, openContent) => {
      const buf = await openContent()
      readLen = buf.length
      return true
    })
    expect(found).toBe(true)
    // Прочитано не меньше PEEK-порога, но и не весь файл (чтение прервано destroy).
    expect(readLen).toBeGreaterThanOrEqual(1024 * 1024)
    expect(readLen).toBeLessThan(big.length)
  })
})
