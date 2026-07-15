import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  downloadFile,
  MAX_DOWNLOAD_BYTES,
  CONNECT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS
} from '../../src/main/download-file'

// Тесты transport-слоя (downloadFile) после security-hardening.
// Покрывают: HTTPS-only и защиту редиректов, лимит размера и безопасный прогресс,
// модель таймаутов (connect/idle/total) с единым дедлайном на всю цепочку редиректов,
// атомарную запись через ${dest}.part + rename и единый идемпотентный путь очистки.
//
// Реальная сеть/диск не задействованы: http/https/fs и download-safety мокируются
// теми же specifier'ами, что импортирует production-модуль. Транспорт драйвится
// фейковыми EventEmitter-объектами, моделирующими только используемый контракт.

// ─── Fakes ──────────────────────────────────────────────────────────────────

class FakeRequest extends EventEmitter {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

class FakeResponse extends EventEmitter {
  statusCode: number
  headers: Record<string, string>
  destroyed = false
  resumeCalls = 0
  pauseCalls = 0
  piped: unknown = null
  constructor(statusCode = 200, headers: Record<string, string> = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }
  resume(): this {
    this.resumeCalls++
    return this
  }
  pause(): this {
    this.pauseCalls++
    return this
  }
  pipe(dest: unknown): unknown {
    this.piped = dest
    return dest
  }
  destroy(): void {
    this.destroyed = true
  }
}

class FakeWriteStream extends EventEmitter {
  dest = ''
  closed = false
  ended = false
  destroyed = false
  writeReturn = true
  written: Buffer[] = []
  // Реальный fs-поток эмитит 'close' асинхронно уже ПОСЛЕ destroy() — только тогда
  // дескриптор фактически освобождён. Моделируем это, чтобы воспроизвести гонку
  // close/unlink. Тесты, которым нужен ручной контроль тайминга, ставят false.
  autoCloseOnDestroy = true
  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return this.writeReturn
  }
  end(): void {
    this.ended = true
    this.emit('finish')
  }
  close(cb?: () => void): void {
    this.emitClose()
    if (cb) cb()
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // 'close' НЕ синхронно: планируем на setImmediate (реальный, таймеры фейковые).
    if (this.autoCloseOnDestroy) setImmediate(() => this.emitClose())
  }
  // Однократная эмиссия 'close' + выставление флага closed (идемпотентно).
  emitClose(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

// ─── Мокируемые specifier'ы (hoisted, т.к. vi.mock поднимается наверх) ─────────

const mocks = vi.hoisted(() => ({
  httpsGet: vi.fn(),
  httpGet: vi.fn(),
  createWriteStream: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  resolveAllowedDownloadAddresses: vi.fn(),
  // Sentinel: транспорт должен передать ровно эту ссылку в options.lookup.
  safeDownloadLookup: function safeDownloadLookupSentinel(): void {}
}))

vi.mock('https', () => ({ default: { get: mocks.httpsGet }, get: mocks.httpsGet }))
vi.mock('http', () => ({
  default: { get: mocks.httpGet },
  get: mocks.httpGet,
  IncomingMessage: class {}
}))
vi.mock('fs', () => ({
  createWriteStream: mocks.createWriteStream,
  rename: mocks.rename,
  unlink: mocks.unlink
}))
vi.mock('../../src/main/download-safety', () => ({
  resolveAllowedDownloadAddresses: mocks.resolveAllowedDownloadAddresses,
  safeDownloadLookup: mocks.safeDownloadLookup
}))

// ─── Общая инфраструктура драйвера ────────────────────────────────────────────

type GetCall = {
  protocol: 'http' | 'https'
  url: URL
  options: { lookup?: unknown }
  req: FakeRequest
  res: FakeResponse
}

let responseQueue: FakeResponse[]
let calls: GetCall[]
let files: FakeWriteStream[]

// Ждём осушения микротасок (SSRF await + рекурсивные редиректы) перед эмиссией событий.
const flushAll = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function installGet(protocol: 'http' | 'https', mockFn: ReturnType<typeof vi.fn>): void {
  mockFn.mockImplementation(
    (url: URL, options: { lookup?: unknown }, cb: (res: FakeResponse) => void) => {
      const req = new FakeRequest()
      const res = responseQueue.shift() ?? new FakeResponse(200, {})
      calls.push({ protocol, url, options, req, res })
      cb(res) // синхронно, как только транспорт вызвал get — слушатели навешиваются здесь же
      return req
    }
  )
}

beforeEach(() => {
  // Фейкуем только таймеры и Date: setImmediate (flushAll) и микротаски (SSRF await)
  // остаются реальными, а connect/idle/total-таймауты становятся детерминированными
  // и гарантированно очищаются в afterEach (никаких висящих 30-минутных таймеров).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  responseQueue = []
  calls = []
  files = []

  mocks.httpsGet.mockReset()
  mocks.httpGet.mockReset()
  mocks.createWriteStream.mockReset()
  mocks.rename.mockReset()
  mocks.unlink.mockReset()
  mocks.resolveAllowedDownloadAddresses.mockReset()

  installGet('https', mocks.httpsGet)
  installGet('http', mocks.httpGet)
  mocks.createWriteStream.mockImplementation((dest: string) => {
    const file = new FakeWriteStream()
    file.dest = dest
    files.push(file)
    return file
  })
  // fs.rename / fs.unlink — async с callback: по умолчанию успех (err = null).
  mocks.rename.mockImplementation((_from: string, _to: string, cb: (e: Error | null) => void) => cb(null))
  mocks.unlink.mockImplementation((_path: string, cb: (e: Error | null) => void) => cb(null))
  // По умолчанию SSRF-preflight пропускает (одна публичная запись).
  mocks.resolveAllowedDownloadAddresses.mockResolvedValue([{ address: '1.2.3.4', family: 4 }])
})

afterEach(() => {
  vi.clearAllTimers() // никаких висящих таймеров между тестами
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── Выбор протокола ──────────────────────────────────────────────────────────

describe('downloadFile — выбор протокола', () => {
  it('HTTPS-URL использует https.get, не http.get', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/tmp/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await p
    expect(mocks.httpsGet).toHaveBeenCalledTimes(1)
    expect(mocks.httpGet).not.toHaveBeenCalled()
    expect(calls[0].protocol).toBe('https')
  })

  it('HTTP-URL отклоняется до SSRF и до запроса (HTTPS-only)', async () => {
    await expect(downloadFile('http://example.com/a.zip', '/tmp/a.zip', vi.fn())).rejects.toThrow(
      'Unsupported URL protocol'
    )
    expect(mocks.resolveAllowedDownloadAddresses).not.toHaveBeenCalled()
    expect(mocks.httpsGet).not.toHaveBeenCalled()
    expect(mocks.httpGet).not.toHaveBeenCalled()
  })

  it('неподдерживаемый протокол отклоняется до SSRF и до запроса', async () => {
    await expect(downloadFile('ftp://example.com/a.zip', '/tmp/a.zip', vi.fn())).rejects.toThrow(
      'Unsupported URL protocol'
    )
    expect(mocks.resolveAllowedDownloadAddresses).not.toHaveBeenCalled()
    expect(mocks.httpsGet).not.toHaveBeenCalled()
    expect(mocks.httpGet).not.toHaveBeenCalled()
  })

  it('некорректный URL отклоняется как Unsupported URL protocol', async () => {
    await expect(downloadFile('not a url', '/tmp/a.zip', vi.fn())).rejects.toThrow(
      'Unsupported URL protocol'
    )
    expect(mocks.resolveAllowedDownloadAddresses).not.toHaveBeenCalled()
    expect(mocks.httpsGet).not.toHaveBeenCalled()
  })
})

// ─── SSRF preflight ───────────────────────────────────────────────────────────

describe('downloadFile — SSRF preflight', () => {
  it('вызывает resolveAllowedDownloadAddresses с hostname до запроса', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/tmp/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await p
    expect(mocks.resolveAllowedDownloadAddresses).toHaveBeenCalledWith('example.com')
    const ssrfOrder = mocks.resolveAllowedDownloadAddresses.mock.invocationCallOrder[0]
    const getOrder = mocks.httpsGet.mock.invocationCallOrder[0]
    expect(ssrfOrder).toBeLessThan(getOrder)
  })

  it('блокировка SSRF-preflight отклоняет загрузку и не открывает запрос', async () => {
    mocks.resolveAllowedDownloadAddresses.mockRejectedValueOnce(
      new Error('Загрузка с этого адреса запрещена.')
    )
    await expect(downloadFile('https://blocked.example/a.zip', '/tmp/a.zip', vi.fn())).rejects.toThrow(
      'Загрузка с этого адреса запрещена.'
    )
    expect(mocks.httpsGet).not.toHaveBeenCalled()
  })

  it('передаёт safeDownloadLookup в options запроса', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/tmp/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await p
    expect(calls[0].options.lookup).toBe(mocks.safeDownloadLookup)
  })
})

// ─── DNS preflight внутри общего дедлайна ─────────────────────────────────────

describe('downloadFile — preflight в общем дедлайне', () => {
  it('зависший preflight приводит к общему Timeout и НЕ открывает запрос', async () => {
    // Promise, который никогда не резолвится — эмулируем зависший DNS.
    mocks.resolveAllowedDownloadAddresses.mockReturnValueOnce(new Promise<never>(() => {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    const settled = vi.fn()
    p.then(settled, settled)
    await flushAll()
    expect(settled).not.toHaveBeenCalled() // ещё висим на preflight
    vi.advanceTimersByTime(TOTAL_TIMEOUT_MS) // выбираем весь дедлайн
    await expect(p).rejects.toThrow('Timeout')
    expect(mocks.httpsGet).not.toHaveBeenCalled() // сокет не открыт после timeout preflight
  })

  it('позднее завершение зависшего preflight ничего не запускает (нет запроса/unhandled)', async () => {
    let resolveLate: ((v: Array<{ address: string; family: number }>) => void) | undefined
    mocks.resolveAllowedDownloadAddresses.mockReturnValueOnce(
      new Promise((res) => {
        resolveLate = res
      })
    )
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    vi.advanceTimersByTime(TOTAL_TIMEOUT_MS)
    await expect(p).rejects.toThrow('Timeout')
    // Поздний resolve DNS уже после проигранной гонки: не должен открыть запрос.
    resolveLate?.([{ address: '1.2.3.4', family: 4 }])
    await flushAll()
    expect(mocks.httpsGet).not.toHaveBeenCalled()
  })

  it('дедлайн не сбрасывается на редиректе: preflight второго hop-а ограничен остатком', async () => {
    // Первый hop: мгновенный preflight + 302. Второй hop: preflight зависает.
    responseQueue.push(new FakeResponse(302, { location: 'https://cdn.example.com/final.zip' }))
    mocks.resolveAllowedDownloadAddresses
      .mockResolvedValueOnce([{ address: '1.2.3.4', family: 4 }]) // первый hop ок
      .mockReturnValueOnce(new Promise<never>(() => {})) // второй hop висит
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll() // первый hop делегировал второму, тот висит на preflight
    expect(calls.length).toBe(1) // второй сокет ещё не открыт
    // Общий дедлайн один на всю цепочку: добиваем остаток — и второй hop падает в Timeout.
    vi.advanceTimersByTime(TOTAL_TIMEOUT_MS)
    await expect(p).rejects.toThrow('Timeout')
    expect(calls.length).toBe(1) // второй запрос так и не открылся
  })

  it('preflight укладывается в дедлайн → запрос открывается штатно', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    expect(mocks.httpsGet).toHaveBeenCalledTimes(1) // preflight успел — сокет открыт
    files[files.length - 1].emit('finish')
    await expect(p).resolves.toBeUndefined()
  })
})

// ─── Финальный 200 и запись ───────────────────────────────────────────────────

describe('downloadFile — успешный ответ и запись', () => {
  it('HTTP 200 создаёт write stream в dest', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    expect(mocks.createWriteStream).toHaveBeenCalledWith('/dest/a.zip.part') // пишем во временный .part
    files[0].emit('finish')
    await p
  })

  it('premium-путь (rate=0) использует res.pipe(file), а не ручную запись', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '4' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    const res = calls[0].res
    const file = files[0]
    res.emit('data', Buffer.from('abcd'))
    expect(res.piped).toBe(file)
    expect(file.written.length).toBe(0)
    file.emit('finish')
    await p
  })

  it('free-путь (rate>0) пишет чанки вручную, без pipe', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '4' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    const res = calls[0].res
    const file = files[0]
    res.emit('data', Buffer.from('abcd'))
    expect(file.written.length).toBe(1)
    expect(res.piped).toBeNull()
    res.emit('end') // file.end() → finish → close → resolve
    await p
  })

  it('успешный finish → close → atomic rename .part → dest → резолвит', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await expect(p).resolves.toBeUndefined()
    expect(files[0].closed).toBe(true)
    expect(mocks.rename).toHaveBeenCalledWith('/dest/a.zip.part', '/dest/a.zip', expect.any(Function))
    expect(mocks.unlink).not.toHaveBeenCalled() // успех — partial не удаляется
  })

  it('сбой rename удаляет .part и отклоняет', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    mocks.rename.mockImplementationOnce((_f: string, _t: string, cb: (e: Error | null) => void) =>
      cb(new Error('EXDEV'))
    )
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await expect(p).rejects.toThrow('EXDEV')
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })

  it('rename EPERM/EACCES удаляет .part и отклоняет исходной ошибкой', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      mocks.rename.mockReset()
      mocks.unlink.mockReset()
      mocks.rename.mockImplementation((_f: string, _t: string, cb: (e: NodeJS.ErrnoException | null) => void) => {
        const err = new Error(code) as NodeJS.ErrnoException
        err.code = code
        cb(err)
      })
      mocks.unlink.mockImplementation((_p: string, cb: (e: Error | null) => void) => cb(null))
      responseQueue.push(new FakeResponse(200, {}))
      const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
      await flushAll()
      files[files.length - 1].emit('finish')
      await expect(p).rejects.toThrow(code)
      expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
    }
  })

  it('rename вызывается ровно .part → dest (замена целевого файла делегируется fs.rename)', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/existing.zip', '/dest/existing.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await expect(p).resolves.toBeUndefined()
    // Транспорт всегда пишет в .part и одним rename замещает dest; отдельного unlink dest нет.
    expect(mocks.rename).toHaveBeenCalledWith('/dest/existing.zip.part', '/dest/existing.zip', expect.any(Function))
    expect(mocks.unlink).not.toHaveBeenCalled() // при успехе исходный dest не трогаем вручную
  })
})

// ─── Progress ─────────────────────────────────────────────────────────────────

describe('downloadFile — progress', () => {
  it('сообщает прогресс при корректном Content-Length (free-путь)', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '10' }))
    const onProgress = vi.fn()
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', onProgress, 1000)
    await flushAll()
    const res = calls[0].res
    res.emit('data', Buffer.from('12345'))
    res.emit('data', Buffer.from('67890'))
    expect(onProgress.mock.calls).toEqual([[50], [100]])
    res.emit('end')
    await p
  })

  it('не сообщает прогресс при отсутствующем/нулевом Content-Length', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const onProgress = vi.fn()
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', onProgress)
    await flushAll()
    calls[0].res.emit('data', Buffer.from('abc'))
    expect(onProgress).not.toHaveBeenCalled()
    files[0].emit('finish')
    await p
  })

  it('прогресс не превышает 100 при теле больше заявленного Content-Length', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '4' }))
    const onProgress = vi.fn()
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', onProgress, 1000)
    await flushAll()
    const res = calls[0].res
    res.emit('data', Buffer.from('12345678')) // 8 байт при заявленных 4
    for (const [pct] of onProgress.mock.calls) {
      expect(Number.isFinite(pct)).toBe(true)
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
    res.emit('end')
    await p
  })

  it('не придумывает прогресс при некорректном Content-Length', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': 'not-a-number' }))
    const onProgress = vi.fn()
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', onProgress, 1000)
    await flushAll()
    calls[0].res.emit('data', Buffer.from('abcd'))
    expect(onProgress).not.toHaveBeenCalled()
    calls[0].res.emit('end')
    await p
  })
})

// ─── Byte limit ───────────────────────────────────────────────────────────────

describe('downloadFile — лимит размера', () => {
  it('невалидный maxBytes (0/NaN/Infinity/отрицательный) отклоняется до сети', async () => {
    for (const bad of [0, NaN, Infinity, -1]) {
      await expect(
        downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 5, bad)
      ).rejects.toThrow('Invalid maximum download size.')
    }
    expect(mocks.resolveAllowedDownloadAddresses).not.toHaveBeenCalled()
    expect(mocks.httpsGet).not.toHaveBeenCalled()
  })

  it('Content-Length больше лимита отклоняется до открытия файла', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '11' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 5, 10)
    await expect(p).rejects.toThrow('Download exceeds maximum size.')
    expect(mocks.createWriteStream).not.toHaveBeenCalled()
    expect(calls[0].res.resumeCalls).toBeGreaterThan(0)
  })

  it('Content-Length ровно лимиту разрешается', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '10' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 5, 10)
    await flushAll()
    expect(mocks.createWriteStream).toHaveBeenCalledTimes(1)
    calls[0].res.emit('data', Buffer.from('0123456789')) // ровно 10 = заявленным
    files[0].emit('finish')
    await expect(p).resolves.toBeUndefined()
  })

  it('Content-Length = лимит + 1 отклоняется', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '11' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 5, 10)
    await expect(p).rejects.toThrow('Download exceeds maximum size.')
  })

  it('chunked-тело (free) превышающее лимит рвёт соединение', async () => {
    responseQueue.push(new FakeResponse(200, {})) // без Content-Length
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000, 5, 10)
    await flushAll()
    const res = calls[0].res
    res.emit('data', Buffer.from('x'.repeat(6)))
    res.emit('data', Buffer.from('y'.repeat(6))) // суммарно 12 > 10
    await expect(p).rejects.toThrow('Download exceeds maximum size.')
    expect(res.destroyed).toBe(true)
    expect(calls[0].req.destroyed).toBe(true)
  })

  it('тело (premium) больше заявленного Content-Length не обходит лимит', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '4' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 5, 10)
    await flushAll()
    const res = calls[0].res
    res.emit('data', Buffer.from('z'.repeat(11))) // 11 > 10, хотя заявлено 4
    await expect(p).rejects.toThrow('Download exceeds maximum size.')
    expect(res.destroyed).toBe(true)
  })

  it('production-дефолт maxBytes равен 1 GiB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(1024 * 1024 * 1024)
  })
})

// ─── Redirects ────────────────────────────────────────────────────────────────

describe('downloadFile — редиректы (текущее поведение)', () => {
  it('3xx+Location освобождает сокет и повторяет запрос на absolute URL', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'https://cdn.example.com/final.zip' }))
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    expect(calls[0].res.resumeCalls).toBeGreaterThan(0) // сокет редиректа освобождён
    expect(calls.length).toBe(2)
    expect(calls[1].url.href).toBe('https://cdn.example.com/final.zip')
    files[0].emit('finish')
    await p
  })

  it('относительный Location разрешается относительно исходного URL', async () => {
    responseQueue.push(new FakeResponse(302, { location: '/other/final.zip' }))
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/dir/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    expect(calls[1].url.href).toBe('https://example.com/other/final.zip')
    files[0].emit('finish')
    await p
  })

  it('SSRF-preflight выполняется на каждом hop', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'https://cdn.example.com/final.zip' }))
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await p
    expect(mocks.resolveAllowedDownloadAddresses).toHaveBeenCalledTimes(2)
    expect(mocks.resolveAllowedDownloadAddresses).toHaveBeenNthCalledWith(1, 'example.com')
    expect(mocks.resolveAllowedDownloadAddresses).toHaveBeenNthCalledWith(2, 'cdn.example.com')
  })

  it('общий redirect budget разделяется между hop-ами и исчерпывается', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'https://a.example.com/1' }))
    responseQueue.push(new FakeResponse(302, { location: 'https://b.example.com/2' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 1)
    await expect(p).rejects.toThrow('Too many redirects.')
    expect(calls.length).toBe(2)
    expect(calls[1].res.resumeCalls).toBeGreaterThan(0)
  })

  it('исчерпанный budget (0) на первом же редиректе отклоняется', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'https://a.example.com/1' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 0, 0)
    await expect(p).rejects.toThrow('Too many redirects.')
    expect(calls[0].res.resumeCalls).toBeGreaterThan(0)
  })

  it('HTTPS → HTTPS redirect (absolute) разрешается', async () => {
    responseQueue.push(new FakeResponse(301, { location: 'https://cdn.example.com/final.zip' }))
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await expect(p).resolves.toBeUndefined()
    expect(mocks.httpsGet).toHaveBeenCalledTimes(2)
    expect(mocks.httpGet).not.toHaveBeenCalled()
  })

  it('HTTPS → HTTP redirect (downgrade) отклоняется без открытия http-запроса', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'http://cdn.example.com/final.zip' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await expect(p).rejects.toThrow('Unsupported URL protocol')
    expect(calls[0].res.resumeCalls).toBeGreaterThan(0) // сокет первого ответа освобождён
    expect(mocks.httpGet).not.toHaveBeenCalled()
    expect(mocks.httpsGet).toHaveBeenCalledTimes(1)
  })

  it('невалидный Location отклоняется контролируемой ошибкой (без uncaught)', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'http://[bad' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await expect(p).rejects.toThrow('Invalid redirect location.')
    expect(calls[0].res.resumeCalls).toBeGreaterThan(0)
    expect(calls.length).toBe(1) // второй запрос не открывался
  })

  it('3xx без Location не зависает: сокет освобождён, reject как HTTP <code>', async () => {
    responseQueue.push(new FakeResponse(302, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await expect(p).rejects.toThrow('HTTP 302')
    expect(calls[0].res.resumeCalls).toBeGreaterThan(0)
    expect(calls.length).toBe(1)
  })

  it('заблокированный хост на втором hop отклоняется preflight-ом', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'https://blocked.example/final.zip' }))
    mocks.resolveAllowedDownloadAddresses
      .mockResolvedValueOnce([{ address: '1.2.3.4', family: 4 }])
      .mockRejectedValueOnce(new Error('Загрузка с этого адреса запрещена.'))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await expect(p).rejects.toThrow('Загрузка с этого адреса запрещена.')
    expect(calls.length).toBe(1) // второй сокет не открыт (preflight до get)
  })
})

// ─── Ошибочные ветки ──────────────────────────────────────────────────────────

describe('downloadFile — ошибки', () => {
  it('не-200 (без Location) отклоняется как HTTP <code>', async () => {
    responseQueue.push(new FakeResponse(404, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await expect(p).rejects.toThrow('HTTP 404')
  })

  it('ошибка запроса отклоняет Promise и удаляет .part', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    calls[0].req.emit('error', new Error('socket reset'))
    await expect(p).rejects.toThrow('socket reset')
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })

  it('ошибка ответа отклоняет Promise и удаляет .part', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    calls[0].res.emit('data', Buffer.from('partial'))
    calls[0].res.emit('error', new Error('response aborted'))
    await expect(p).rejects.toThrow('response aborted')
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
    expect(mocks.rename).not.toHaveBeenCalled()
  })

  it('ошибка записи в файл отклоняет Promise и удаляет .part', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('error', new Error('ENOSPC'))
    await expect(p).rejects.toThrow('ENOSPC')
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })

  it('обрыв: тело короче заявленного Content-Length → Truncated download + удаление .part', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '10' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    const res = calls[0].res
    res.emit('data', Buffer.from('123')) // только 3 из 10
    res.emit('end') // file.end → finish → close: недобор
    files[0].emit('finish')
    await expect(p).rejects.toThrow('Truncated download.')
    expect(mocks.rename).not.toHaveBeenCalled()
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })
})

// ─── Cleanup: гонка close/unlink ──────────────────────────────────────────────

describe('downloadFile — cleanup (close/unlink)', () => {
  // Общий сетап: доходим до открытого файлового потока, затем роняем поток file.error.
  const openThenFail = async (): Promise<{ file: FakeWriteStream; p: Promise<void> }> => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    return { file: files[files.length - 1], p }
  }

  it('destroy файла не закрывает дескриптор синхронно (close асинхронный)', async () => {
    const { file, p } = await openThenFail()
    file.autoCloseOnDestroy = false // управляем close вручную
    calls[0].req.emit('error', new Error('boom'))
    // Сразу после fail(): поток уничтожен, но close ещё не эмитнут, поэтому unlink НЕ вызван.
    expect(file.destroyed).toBe(true)
    expect(file.closed).toBe(false)
    expect(mocks.unlink).not.toHaveBeenCalled()
    file.emitClose() // фактическое закрытие дескриптора
    await expect(p).rejects.toThrow('boom')
  })

  it('unlink не вызывается до close, и вызывается ровно после него', async () => {
    const { file, p } = await openThenFail()
    file.autoCloseOnDestroy = false
    calls[0].req.emit('error', new Error('boom'))
    expect(mocks.unlink).not.toHaveBeenCalled() // до close — нет
    file.emitClose()
    await expect(p).rejects.toThrow('boom')
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function)) // после close — да
    expect(mocks.unlink).toHaveBeenCalledTimes(1)
  })

  it('ENOENT (.part отсутствует) считается успешной очисткой (без шума в stderr)', async () => {
    mocks.unlink.mockImplementation((_path: string, cb: (e: NodeJS.ErrnoException | null) => void) => {
      const err = new Error('missing') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      cb(err)
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { file, p } = await openThenFail()
    file.emit('error', new Error('ENOSPC'))
    await expect(p).rejects.toThrow('ENOSPC')
    expect(spy).not.toHaveBeenCalled() // ENOENT — штатная очистка, не логируется
  })

  it('EPERM/EACCES на unlink не оставляет Promise зависшим и логируется', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      mocks.unlink.mockReset()
      mocks.unlink.mockImplementation((_path: string, cb: (e: NodeJS.ErrnoException | null) => void) => {
        const err = new Error(code) as NodeJS.ErrnoException
        err.code = code
        cb(err)
      })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { file, p } = await openThenFail()
      file.emit('error', new Error('disk gone'))
      // reject приходит исходной причиной, а не ошибкой unlink — Promise завершён.
      await expect(p).rejects.toThrow('disk gone')
      expect(spy).toHaveBeenCalled() // неожиданная ошибка cleanup диагностически логируется
      spy.mockRestore()
    }
  })

  it('поздние close/error после reject не завершают Promise повторно', async () => {
    let settles = 0
    responseQueue.push(new FakeResponse(200, {}))
    const done = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn()).then(
      () => settles++,
      () => settles++
    )
    await flushAll()
    const file = files[0]
    calls[0].req.emit('error', new Error('boom'))
    await flushAll() // close → unlink → reject
    // Поздние повторные события по уже settled-состоянию ничего не запускают.
    file.emit('close')
    file.emit('error', new Error('late'))
    calls[0].res.emit('error', new Error('late-res'))
    await flushAll()
    await done
    expect(settles).toBe(1)
    expect(mocks.unlink).toHaveBeenCalledTimes(1) // очистка ровно одна
  })

  it('поток не создан (fail до createWriteStream): .part удаляется без ожидания close', async () => {
    responseQueue.push(new FakeResponse(500, {})) // не-200 → fail до открытия файла
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await expect(p).rejects.toThrow('HTTP 500')
    expect(mocks.createWriteStream).not.toHaveBeenCalled()
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })

  it('поток уже закрыт к моменту fail: unlink без повторного destroy/ожидания', async () => {
    const { file, p } = await openThenFail()
    file.emitClose() // дескриптор уже закрыт
    file.destroyed = false // проверяем, что fail не станет ждать несуществующий close
    calls[0].req.emit('error', new Error('boom'))
    await expect(p).rejects.toThrow('boom')
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })
})

// ─── Таймауты ─────────────────────────────────────────────────────────────────

describe('downloadFile — таймауты', () => {
  it('connect-timeout (нет ответа) → Timeout + destroy запроса + удаление .part', async () => {
    // get не вызовет callback (сервер молчит) — переопределяем на «висящий» ответ.
    mocks.httpsGet.mockImplementation((url: URL, options: { lookup?: unknown }) => {
      const req = new FakeRequest()
      calls.push({ protocol: 'https', url, options, req, res: new FakeResponse() })
      return req // callback не вызывается
    })
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    await expect(p).rejects.toThrow('Timeout')
    expect(calls[0].req.destroyed).toBe(true)
    expect(mocks.unlink).toHaveBeenCalledWith('/dest/a.zip.part', expect.any(Function))
  })

  it('ответ, пришедший ПОСЛЕ дедлайна, лишь освобождает сокет (settled)', async () => {
    // Придерживаем response-callback, чтобы вызвать его вручную уже после timeout.
    let deferredCb: ((res: FakeResponse) => void) | undefined
    const heldRes = new FakeResponse(200, { 'content-length': '10' })
    mocks.httpsGet.mockImplementation(
      (url: URL, options: { lookup?: unknown }, cb: (res: FakeResponse) => void) => {
        const req = new FakeRequest()
        calls.push({ protocol: 'https', url, options, req, res: heldRes })
        deferredCb = cb
        return req
      }
    )
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS) // fail() до прихода ответа
    await expect(p).rejects.toThrow('Timeout')
    deferredCb?.(heldRes) // поздний ответ
    expect(heldRes.resumeCalls).toBeGreaterThan(0) // сокет освобождён
    expect(mocks.createWriteStream).not.toHaveBeenCalled() // запись не начата
  })

  it('idle-timeout (передача застопорилась) → Timeout', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '100' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    calls[0].res.emit('data', Buffer.from('12345')) // армирует idle-таймер
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS)
    await expect(p).rejects.toThrow('Timeout')
    expect(calls[0].res.destroyed).toBe(true)
  })

  it('активная передача сбрасывает idle-таймер (не ложное срабатывание)', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '30' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    const res = calls[0].res
    // Три чанка по 10 (итого 30 = заявленным) с интервалом чуть меньше idle-таймаута —
    // таймер каждый раз перезаводится и ложно не срабатывает.
    for (let i = 0; i < 3; i++) {
      res.emit('data', Buffer.from('1234567890'))
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1)
    }
    res.emit('end')
    files[0].emit('finish')
    await expect(p).resolves.toBeUndefined()
  })

  it('общий дедлайн покрывает цепочку редиректов и не сбрасывается на hop-е', async () => {
    responseQueue.push(new FakeResponse(302, { location: 'https://cdn.example.com/final.zip' }))
    responseQueue.push(new FakeResponse(200, { 'content-length': '100' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll() // первый hop делегирует второму
    // Второй hop открыт; двигаем время к общему дедлайну (30 мин), не трогая idle.
    calls[1].res.emit('data', Buffer.from('123'))
    vi.advanceTimersByTime(TOTAL_TIMEOUT_MS)
    await expect(p).rejects.toThrow('Timeout')
    expect(calls[1].res.destroyed).toBe(true)
  })
})

// ─── Идемпотентность завершения ───────────────────────────────────────────────

describe('downloadFile — единичное завершение', () => {
  it('после reject по timeout последующие события не меняют исход (settle один раз)', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '100' }))
    let settles = 0
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000).then(
      () => {
        settles++
      },
      () => {
        settles++
      }
    )
    await flushAll()
    calls[0].res.emit('data', Buffer.from('12345')) // армирует idle-таймер и создаёт .part
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS) // idle-timeout → fail один раз
    await p
    // Поздние события по уже settled-Promise игнорируются исполнением.
    calls[0].res.emit('error', new Error('late'))
    files[0].emit('finish')
    await flushAll()
    expect(settles).toBe(1)
    expect(mocks.rename).not.toHaveBeenCalled() // после timeout успеха быть не может
  })

  it('data-события после settle не пишут в файл', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '100' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    const res = calls[0].res
    const file = files[0]
    res.emit('data', Buffer.from('12345'))
    const writtenBefore = file.written.length
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS) // settle через idle-timeout
    await expect(p).rejects.toThrow('Timeout')
    res.emit('data', Buffer.from('late-bytes')) // поздний чанк
    expect(file.written.length).toBe(writtenBefore) // ничего не дописано
  })
})

// ─── Backpressure (характеризация, без таймеров) ──────────────────────────────

describe('downloadFile — backpressure', () => {
  it('при переполнении буфера файла res.pause() и ожидание drain, затем resume', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '10' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    const res = calls[0].res
    const file = files[0]
    file.writeReturn = false // диск не принимает — canWrite=false
    const drainBefore = file.listenerCount('drain')
    res.emit('data', Buffer.from('x'.repeat(10)))
    expect(res.pauseCalls).toBeGreaterThan(0)
    expect(file.listenerCount('drain')).toBe(drainBefore + 1)
    // drain → запланированный resume (setTimeout) → возобновление чтения.
    file.writeReturn = true
    file.emit('drain')
    vi.advanceTimersByTime(1000)
    expect(res.resumeCalls).toBeGreaterThan(0)
    res.emit('end')
    file.emit('finish')
    await expect(p).resolves.toBeUndefined()
  })
})
