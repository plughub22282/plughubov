import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import https from 'https'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AddressInfo } from 'net'

// Интеграционные тесты замены целевого файла: РЕАЛЬНЫЙ https-сервер + РЕАЛЬНЫЕ fs-операции
// (никаких моков fs/https/сети). Мокируется только SSRF-guard (download-safety), чтобы
// разрешить localhost и вернуть 127.0.0.1 из lookup — без этого guard блокирует loopback.
// Так мы проверяем реальную атомарную семантику ${dest}.part → rename, замену уже
// существующего dest и то, что при сбое старый файл не повреждён, а .part убран.
//
// TLS-сертификат — закоммиченная self-signed фикстура (fixtures/localhost-*.pem), только
// для loopback-теста. Никакой внешней команды (openssl) в рантайме: тест воспроизводим на
// любой чистой машине после `npm ci` (Windows/mac/Linux), не зависит от PATH и dev-tooling.
// Приватный ключ фикстуры ценности не имеет: он валиден исключительно для localhost/127.0.0.1.

const mocks = vi.hoisted(() => ({
  resolveAllowedDownloadAddresses: vi.fn(),
  // lookup, отдающий 127.0.0.1 — сервер слушает loopback; поддерживаем оба режима (all/single).
  safeDownloadLookup: (
    _hostname: string,
    options: { all?: boolean } | undefined,
    cb: ((err: Error | null, addr: string, family: number) => void) &
      ((err: Error | null, addrs: Array<{ address: string; family: number }>) => void)
  ): void => {
    if (options && options.all) cb(null, [{ address: '127.0.0.1', family: 4 }])
    else cb(null, '127.0.0.1', 4)
  }
}))

vi.mock('../../src/main/download-safety', () => ({
  resolveAllowedDownloadAddresses: mocks.resolveAllowedDownloadAddresses,
  safeDownloadLookup: mocks.safeDownloadLookup
}))

// Импорт ПОСЛЕ vi.mock, чтобы транспорт увидел мок download-safety.
import { downloadFile } from '../../src/main/download-file'

let cert: Buffer
let key: Buffer
let workDir: string
let savedCa: https.AgentOptions['ca']

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Поднимает одноразовый https-сервер с заданным обработчиком; резолвит его base-URL. */
function startServer(handler: https.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = https.createServer({ key, cert }, handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `https://localhost:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

beforeAll(() => {
  key = readFileSync(path.join(fixturesDir, 'localhost-key.pem'))
  cert = readFileSync(path.join(fixturesDir, 'localhost-cert.pem'))
  // Доверяем self-signed CA глобально: downloadFile не задаёт ca в самом запросе,
  // поэтому TLS-проверка (включённая) опирается на globalAgent. Сохраняем и восстановим,
  // чтобы не протечь доверие фикстуры в другие тестовые файлы.
  savedCa = https.globalAgent.options.ca
  https.globalAgent.options.ca = cert
})

afterAll(() => {
  https.globalAgent.options.ca = savedCa
})

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'vst3-dl-work-'))
  mocks.resolveAllowedDownloadAddresses.mockReset()
  mocks.resolveAllowedDownloadAddresses.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('downloadFile — замена целевого файла (real https + real fs)', () => {
  it('скачивает новый файл: dest содержит ровно отданные сервером байты, .part убран', async () => {
    const body = Buffer.from('BRAND-NEW-CONTENT-' + 'z'.repeat(100))
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })
    const dest = path.join(workDir, 'plugin.zip')
    try {
      await downloadFile(`${srv.url}/plugin.zip`, dest, vi.fn())
      expect(existsSync(dest)).toBe(true)
      expect(readFileSync(dest).equals(body)).toBe(true)
      expect(existsSync(`${dest}.part`)).toBe(false) // временный файл убран после rename
    } finally {
      await srv.close()
    }
  })

  it('перезаписывает уже существующий dest новым содержимым (замена, не дозапись)', async () => {
    const dest = path.join(workDir, 'existing.zip')
    writeFileSync(dest, Buffer.from('OLD-VERSION-PAYLOAD'))
    const body = Buffer.from('NEW-VERSION-PAYLOAD-different-length-xxxxxxxx')
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })
    try {
      await downloadFile(`${srv.url}/existing.zip`, dest, vi.fn())
      expect(readFileSync(dest).equals(body)).toBe(true) // ровно новое содержимое
      expect(existsSync(`${dest}.part`)).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('обрыв (тело короче Content-Length): старый dest НЕ повреждён и .part убран', async () => {
    const dest = path.join(workDir, 'keep-old.zip')
    const old = Buffer.from('ORIGINAL-INTACT-CONTENT')
    writeFileSync(dest, old)
    // Сервер обещает 1000 байт, но отдаёт 10 и обрывает соединение → Truncated download.
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' })
      res.write(Buffer.from('0123456789'))
      res.destroy() // резкий обрыв
    })
    try {
      await expect(downloadFile(`${srv.url}/keep-old.zip`, dest, vi.fn())).rejects.toThrow()
      // Критично: провалившаяся загрузка не тронула уже установленный файл.
      expect(readFileSync(dest).equals(old)).toBe(true)
      expect(existsSync(`${dest}.part`)).toBe(false) // partial очищен
    } finally {
      await srv.close()
    }
  })

  it('HTTP 404: dest не создаётся, .part не остаётся', async () => {
    const dest = path.join(workDir, 'missing.zip')
    const srv = await startServer((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    try {
      await expect(downloadFile(`${srv.url}/missing.zip`, dest, vi.fn())).rejects.toThrow('HTTP 404')
      expect(existsSync(dest)).toBe(false)
      expect(existsSync(`${dest}.part`)).toBe(false)
    } finally {
      await srv.close()
    }
  })

  it('прогресс достигает 100 и dest совпадает с телом на «большом» файле', async () => {
    const body = Buffer.alloc(256 * 1024, 7) // 256 KiB детерминированного содержимого
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })
    const dest = path.join(workDir, 'big.bin')
    const onProgress = vi.fn()
    try {
      await downloadFile(`${srv.url}/big.bin`, dest, onProgress)
      expect(readFileSync(dest).equals(body)).toBe(true)
      const last = onProgress.mock.calls.at(-1)?.[0]
      expect(last).toBe(100)
    } finally {
      await srv.close()
    }
  })
})
