import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lookup } from 'dns/promises'
import {
  resolveAllowedDownloadAddresses,
  safeDownloadLookup,
  downloadRateFor
} from '../../src/main/download-safety'

// Characterization-тесты вынесенной сетевой политики скачивания (SSRF/DNS-rebinding guard).
// Поведение НЕ проектируется — фиксируется как есть в текущей реализации download-safety.ts.
// Реальная сеть не задействована: dns/promises мокируется тем же specifier, что и в модуле.

vi.mock('dns/promises', () => ({ lookup: vi.fn() }))

const mockedLookup = vi.mocked(lookup)
const BLOCK_MESSAGE = 'Загрузка с этого адреса запрещена.'

// Единый тип записи DNS-ответа (address+family), какой возвращает lookup({all:true}).
type Rec = { address: string; family: number }
function rec(address: string, family: number): Rec {
  return { address, family }
}

beforeEach(() => {
  // По умолчанию любой незамоканный вызов DNS — ошибка теста (сеть трогать нельзя).
  mockedLookup.mockReset()
  mockedLookup.mockRejectedValue(new Error('unexpected DNS call in test'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveAllowedDownloadAddresses — literal IPv4', () => {
  // Литеральный IP не должен приводить к DNS-запросу вовсе.
  const blocked = [
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1', // multicast (224.0.0.0/4)
    '240.0.0.1', // reserved (240.0.0.0/4)
    '255.255.255.255' // broadcast (addAddress)
  ]

  for (const ip of blocked) {
    it(`блокирует приватный/спец IPv4 ${ip} без DNS`, async () => {
      await expect(resolveAllowedDownloadAddresses(ip)).rejects.toThrow(BLOCK_MESSAGE)
      expect(mockedLookup).not.toHaveBeenCalled()
    })
  }

  it('разрешает публичный IPv4 8.8.8.8 без DNS (контроль)', async () => {
    const out = await resolveAllowedDownloadAddresses('8.8.8.8')
    expect(out).toEqual([rec('8.8.8.8', 4)])
    expect(mockedLookup).not.toHaveBeenCalled()
  })
})

describe('resolveAllowedDownloadAddresses — literal IPv6', () => {
  it('блокирует :: (unspecified)', async () => {
    await expect(resolveAllowedDownloadAddresses('::')).rejects.toThrow(BLOCK_MESSAGE)
    expect(mockedLookup).not.toHaveBeenCalled()
  })
  it('блокирует ::1 (loopback)', async () => {
    await expect(resolveAllowedDownloadAddresses('::1')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('блокирует fc00::1 (ULA fc00::/7)', async () => {
    await expect(resolveAllowedDownloadAddresses('fc00::1')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('блокирует fd00::1 (ULA fc00::/7)', async () => {
    await expect(resolveAllowedDownloadAddresses('fd00::1')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('блокирует fe80::1 (link-local fe80::/10)', async () => {
    await expect(resolveAllowedDownloadAddresses('fe80::1')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('блокирует IPv4-mapped приватный ::ffff:127.0.0.1', async () => {
    await expect(resolveAllowedDownloadAddresses('::ffff:127.0.0.1')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('разрешает IPv4-mapped публичный ::ffff:8.8.8.8', async () => {
    // Текущая реализация разворачивает mapped-IPv4 и проверяет по ipv4-списку; 8.8.8.8 публичен.
    const out = await resolveAllowedDownloadAddresses('::ffff:8.8.8.8')
    expect(out.length).toBe(1)
    expect(out[0].family).toBe(6)
    expect(mockedLookup).not.toHaveBeenCalled()
  })
  it('разрешает публичный IPv6 2606:4700::1', async () => {
    const out = await resolveAllowedDownloadAddresses('2606:4700::1')
    expect(out).toEqual([rec('2606:4700::1', 6)])
  })
})

describe('resolveAllowedDownloadAddresses — hostname + нормализация', () => {
  it('localhost блокируется ДО DNS', async () => {
    await expect(resolveAllowedDownloadAddresses('localhost')).rejects.toThrow(BLOCK_MESSAGE)
    expect(mockedLookup).not.toHaveBeenCalled()
  })
  it('поддомен *.localhost блокируется до DNS', async () => {
    await expect(resolveAllowedDownloadAddresses('api.localhost')).rejects.toThrow(BLOCK_MESSAGE)
    expect(mockedLookup).not.toHaveBeenCalled()
  })
  it('mixed-case hostname нормализуется в lower при вызове lookup', async () => {
    mockedLookup.mockResolvedValue([rec('93.184.216.34', 4)] as never)
    await resolveAllowedDownloadAddresses('ExAmPlE.CoM')
    expect(mockedLookup).toHaveBeenCalledTimes(1)
    expect(mockedLookup.mock.calls[0][0]).toBe('example.com')
  })
  it('trailing dot убирается перед lookup', async () => {
    mockedLookup.mockResolvedValue([rec('93.184.216.34', 4)] as never)
    await resolveAllowedDownloadAddresses('example.com.')
    expect(mockedLookup.mock.calls[0][0]).toBe('example.com')
  })
  it('публичный hostname с публичным DNS-ответом разрешён', async () => {
    mockedLookup.mockResolvedValue([rec('93.184.216.34', 4)] as never)
    const out = await resolveAllowedDownloadAddresses('example.com')
    expect(out).toEqual([rec('93.184.216.34', 4)])
  })
  it('пустой hostname блокируется без DNS (не fail-open)', async () => {
    await expect(resolveAllowedDownloadAddresses('')).rejects.toThrow(BLOCK_MESSAGE)
    expect(mockedLookup).not.toHaveBeenCalled()
  })
  it('DNS-ответ полностью из приватных адресов блокируется (fail-closed)', async () => {
    mockedLookup.mockResolvedValue([rec('10.0.0.5', 4)] as never)
    await expect(resolveAllowedDownloadAddresses('rebind.example')).rejects.toThrow(BLOCK_MESSAGE)
  })
})

describe('resolveAllowedDownloadAddresses — DNS answers', () => {
  it('один публичный IPv4 → разрешён', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4)] as never)
    expect(await resolveAllowedDownloadAddresses('a.example')).toEqual([rec('1.1.1.1', 4)])
  })
  it('один публичный IPv6 → разрешён', async () => {
    mockedLookup.mockResolvedValue([rec('2606:4700::1111', 6)] as never)
    expect(await resolveAllowedDownloadAddresses('a.example')).toEqual([rec('2606:4700::1111', 6)])
  })
  it('единственный приватный адрес → блок', async () => {
    mockedLookup.mockResolvedValue([rec('192.168.1.10', 4)] as never)
    await expect(resolveAllowedDownloadAddresses('a.example')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('смесь публичного и приватного → блок (проверяются ВСЕ адреса)', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4), rec('10.0.0.1', 4)] as never)
    await expect(resolveAllowedDownloadAddresses('a.example')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('приватный НЕ первым в массиве → всё равно блок (порядок не важен)', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4), rec('8.8.8.8', 4), rec('127.0.0.1', 4)] as never)
    await expect(resolveAllowedDownloadAddresses('a.example')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('несколько публичных адресов возвращаются целиком в исходном порядке', async () => {
    const answer = [rec('1.1.1.1', 4), rec('8.8.8.8', 4)]
    mockedLookup.mockResolvedValue(answer as never)
    expect(await resolveAllowedDownloadAddresses('a.example')).toEqual(answer)
  })
  it('пустой DNS-массив → блок', async () => {
    mockedLookup.mockResolvedValue([] as never)
    await expect(resolveAllowedDownloadAddresses('a.example')).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('DNS reject → ошибка пробрасывается наружу', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(resolveAllowedDownloadAddresses('a.example')).rejects.toThrow('ENOTFOUND')
  })
})

describe('resolveAllowedDownloadAddresses — family', () => {
  it('family 0 (по умолчанию) → lookup вызывается с family 0', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4)] as never)
    await resolveAllowedDownloadAddresses('a.example')
    expect(mockedLookup.mock.calls[0][1]).toEqual({ all: true, verbatim: false, family: 0 })
  })
  it('family 4 → прокинут в lookup', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4)] as never)
    await resolveAllowedDownloadAddresses('a.example', 4)
    expect(mockedLookup.mock.calls[0][1]).toMatchObject({ family: 4 })
  })
  it('family 6 → прокинут в lookup', async () => {
    mockedLookup.mockResolvedValue([rec('2606:4700::1', 6)] as never)
    await resolveAllowedDownloadAddresses('a.example', 6)
    expect(mockedLookup.mock.calls[0][1]).toMatchObject({ family: 6 })
  })
  it("строковое 'IPv4' нормализуется в 4", async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4)] as never)
    await resolveAllowedDownloadAddresses('a.example', 'IPv4')
    expect(mockedLookup.mock.calls[0][1]).toMatchObject({ family: 4 })
  })
  it("строковое 'IPv6' нормализуется в 6", async () => {
    mockedLookup.mockResolvedValue([rec('2606:4700::1', 6)] as never)
    await resolveAllowedDownloadAddresses('a.example', 'IPv6')
    expect(mockedLookup.mock.calls[0][1]).toMatchObject({ family: 6 })
  })
  it('неизвестное значение family нормализуется в 0', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4)] as never)
    // @ts-expect-error — намеренно вне типа: проверяем, что нормализация не fail-open
    await resolveAllowedDownloadAddresses('a.example', 'bogus')
    expect(mockedLookup.mock.calls[0][1]).toMatchObject({ family: 0 })
  })
  it('literal IPv4 с запрошенной family 6 → блок (mismatch)', async () => {
    await expect(resolveAllowedDownloadAddresses('8.8.8.8', 6)).rejects.toThrow(BLOCK_MESSAGE)
    expect(mockedLookup).not.toHaveBeenCalled()
  })
  it('literal IPv6 с запрошенной family 4 → блок (mismatch)', async () => {
    await expect(resolveAllowedDownloadAddresses('2606:4700::1', 4)).rejects.toThrow(BLOCK_MESSAGE)
  })
  it('literal IPv4 с family 4 → разрешён (совпадение)', async () => {
    expect(await resolveAllowedDownloadAddresses('8.8.8.8', 4)).toEqual([rec('8.8.8.8', 4)])
  })
})

// Оборачиваем callback-контракт в Promise для детерминированной проверки.
function callLookup(
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6'; all?: boolean }
): Promise<{ calls: number; args: unknown[] }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let calls = 0
    const timer = setTimeout(() => rejectPromise(new Error('callback never called')), 2000)
    safeDownloadLookup(hostname, options, ((...args: unknown[]) => {
      calls += 1
      clearTimeout(timer)
      // Небольшая задержка, чтобы поймать возможный повторный вызов callback.
      setTimeout(() => resolvePromise({ calls, args }), 10)
    }) as never)
  })
}

describe('safeDownloadLookup — callback contract', () => {
  it('all:false публичный → (null, address, family), вызван один раз', async () => {
    const { calls, args } = await callLookup('8.8.8.8', { all: false })
    expect(calls).toBe(1)
    expect(args[0]).toBeNull()
    expect(args[1]).toBe('8.8.8.8')
    expect(args[2]).toBe(4)
  })
  it('all:true публичный → (null, [records])', async () => {
    mockedLookup.mockResolvedValue([rec('1.1.1.1', 4), rec('8.8.8.8', 4)] as never)
    const { calls, args } = await callLookup('a.example', { all: true })
    expect(calls).toBe(1)
    expect(args[0]).toBeNull()
    expect(args[1]).toEqual([rec('1.1.1.1', 4), rec('8.8.8.8', 4)])
  })
  it('all:false приватный → (err, "", 0)', async () => {
    const { calls, args } = await callLookup('127.0.0.1', { all: false })
    expect(calls).toBe(1)
    expect(args[0]).toBeInstanceOf(Error)
    expect((args[0] as Error).message).toBe(BLOCK_MESSAGE)
    expect(args[1]).toBe('')
    expect(args[2]).toBe(0)
  })
  it('all:true приватный → (err, [])', async () => {
    const { calls, args } = await callLookup('127.0.0.1', { all: true })
    expect(calls).toBe(1)
    expect(args[0]).toBeInstanceOf(Error)
    expect(args[1]).toEqual([])
  })
  it('DNS error пробрасывается в callback (all:false)', async () => {
    mockedLookup.mockRejectedValue(new Error('ESERVFAIL'))
    const { calls, args } = await callLookup('a.example', { all: false })
    expect(calls).toBe(1)
    expect((args[0] as Error).message).toBe('ESERVFAIL')
    expect(args[1]).toBe('')
    expect(args[2]).toBe(0)
  })
})

describe('downloadRateFor — характеристика скорости', () => {
  it('free (false) → 875000 байт/с (7 Мбит/с)', () => {
    expect(downloadRateFor(false)).toBe(875_000)
  })
  it('premium (true) → 0 (без лимита)', () => {
    expect(downloadRateFor(true)).toBe(0)
  })
})
