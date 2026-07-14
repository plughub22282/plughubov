import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { downloadFile, MAX_DOWNLOAD_BYTES } from '../../src/main/download-file'

// Characterization-тесты текущего transport-слоя (downloadFile).
// Поведение НЕ проектируется — фиксируется как есть на момент механического выноса,
// ДО функционального hardening (HTTPS-only, byte limit, total timeout, cleanup).
// Небезопасные свойства (HTTP разрешён, downgrade-redirect, отсутствие лимита и т.д.)
// намеренно НЕ закрепляются как желаемые — они вынесены в it.todo ниже.
//
// Реальная сеть/диск не задействованы: http/https/fs и download-safety мокируются
// теми же specifier'ами, что импортирует production-модуль. Транспорт драйвится
// фейковыми EventEmitter-объектами, моделирующими только используемый контракт.

// ─── Fakes ──────────────────────────────────────────────────────────────────

class FakeRequest extends EventEmitter {
  destroyed = false
  timeoutMs: number | undefined
  timeoutCb: (() => void) | undefined
  setTimeout(ms: number, cb: () => void): this {
    this.timeoutMs = ms
    this.timeoutCb = cb
    return this
  }
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
  writeReturn = true
  written: Buffer[] = []
  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return this.writeReturn
  }
  end(): void {
    this.ended = true
    this.emit('finish')
  }
  close(cb?: () => void): void {
    this.closed = true
    if (cb) cb()
  }
}

// ─── Мокируемые specifier'ы (hoisted, т.к. vi.mock поднимается наверх) ─────────

const mocks = vi.hoisted(() => ({
  httpsGet: vi.fn(),
  httpGet: vi.fn(),
  createWriteStream: vi.fn(),
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
vi.mock('fs', () => ({ createWriteStream: mocks.createWriteStream }))
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
  responseQueue = []
  calls = []
  files = []

  mocks.httpsGet.mockReset()
  mocks.httpGet.mockReset()
  mocks.createWriteStream.mockReset()
  mocks.resolveAllowedDownloadAddresses.mockReset()

  installGet('https', mocks.httpsGet)
  installGet('http', mocks.httpGet)
  mocks.createWriteStream.mockImplementation((dest: string) => {
    const file = new FakeWriteStream()
    file.dest = dest
    files.push(file)
    return file
  })
  // По умолчанию SSRF-preflight пропускает (одна публичная запись).
  mocks.resolveAllowedDownloadAddresses.mockResolvedValue([{ address: '1.2.3.4', family: 4 }])
})

afterEach(() => {
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

// ─── Финальный 200 и запись ───────────────────────────────────────────────────

describe('downloadFile — успешный ответ и запись', () => {
  it('HTTP 200 создаёт write stream в dest', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    expect(mocks.createWriteStream).toHaveBeenCalledWith('/dest/a.zip')
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

  it('успешный finish → close → резолвит Promise', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('finish')
    await expect(p).resolves.toBeUndefined()
    expect(files[0].closed).toBe(true)
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

  it('ошибка запроса отклоняет Promise', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    calls[0].req.emit('error', new Error('socket reset'))
    await expect(p).rejects.toThrow('socket reset')
  })

  it('ошибка ответа отклоняет Promise', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    calls[0].res.emit('error', new Error('response aborted'))
    await expect(p).rejects.toThrow('response aborted')
  })

  it('ошибка записи в файл отклоняет Promise', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    files[0].emit('error', new Error('ENOSPC'))
    await expect(p).rejects.toThrow('ENOSPC')
  })

  it('idle-timeout уничтожает запрос и отклоняет как Timeout', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn())
    await flushAll()
    expect(calls[0].req.timeoutMs).toBe(30_000)
    calls[0].req.timeoutCb?.()
    await expect(p).rejects.toThrow('Timeout')
    expect(calls[0].req.destroyed).toBe(true)
  })
})

// ─── Идемпотентность завершения ───────────────────────────────────────────────

describe('downloadFile — единичное завершение', () => {
  it('после reject по timeout последующие события не меняют исход (settle один раз)', async () => {
    responseQueue.push(new FakeResponse(200, {}))
    let settles = 0
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn()).then(
      () => {
        settles++
      },
      () => {
        settles++
      }
    )
    await flushAll()
    calls[0].req.timeoutCb?.()
    await p
    // Поздние события уже settled-Promise игнорируются исполнением.
    calls[0].res.emit('error', new Error('late'))
    files[0].emit('finish')
    await flushAll()
    expect(settles).toBe(1)
  })
})

// ─── Backpressure (характеризация, без таймеров) ──────────────────────────────

describe('downloadFile — backpressure', () => {
  it('при переполнении буфера файла res.pause() и ожидание drain', async () => {
    responseQueue.push(new FakeResponse(200, { 'content-length': '100' }))
    const p = downloadFile('https://example.com/a.zip', '/dest/a.zip', vi.fn(), 1000)
    await flushAll()
    const res = calls[0].res
    const file = files[0]
    file.writeReturn = false // диск не принимает — canWrite=false
    const drainBefore = file.listenerCount('drain')
    res.emit('data', Buffer.from('x'.repeat(10)))
    expect(res.pauseCalls).toBeGreaterThan(0)
    expect(file.listenerCount('drain')).toBe(drainBefore + 1)
    // Осознанно не эмитим 'drain' (это запланировало бы setTimeout-resume);
    // ветку возобновления по времени характеризует Этап 4.
    void p
  })
})

// ─── Будущие security-требования (НЕ закрепляем текущее небезопасное поведение) ─

describe('downloadFile — будущие security-инварианты (Этап 4)', () => {
  it.todo('partial-файл должен удаляться при любой ошибке')
  it.todo('общий timeout должен покрывать цепочку редиректов')
  it.todo('stream не должен писать после reject')
})
