import { lookup } from 'dns/promises'
import { BlockList, isIP } from 'net'

/**
 * Сетевая политика скачивания: SSRF/DNS-rebinding guard + выбор скорости.
 * Механически вынесено из src/main/index.ts без изменения поведения.
 * Модуль не зависит от Electron — чистое ядро на Node core (dns/promises, net),
 * поэтому тестируется обычным Vitest без поднятия приложения.
 */

/**
 * Blocks downloads to local/private/special-purpose networks before the socket opens.
 * Security: plugin URLs are content-controlled, so both literal hosts and DNS answers are SSRF input.
 */
const blockedDownloadIps = new BlockList()
blockedDownloadIps.addSubnet('0.0.0.0', 8, 'ipv4')
blockedDownloadIps.addSubnet('10.0.0.0', 8, 'ipv4')
blockedDownloadIps.addSubnet('100.64.0.0', 10, 'ipv4')
blockedDownloadIps.addSubnet('127.0.0.0', 8, 'ipv4')
blockedDownloadIps.addSubnet('169.254.0.0', 16, 'ipv4')
blockedDownloadIps.addSubnet('172.16.0.0', 12, 'ipv4')
blockedDownloadIps.addSubnet('192.0.0.0', 24, 'ipv4')
blockedDownloadIps.addSubnet('192.0.2.0', 24, 'ipv4')
blockedDownloadIps.addSubnet('192.168.0.0', 16, 'ipv4')
blockedDownloadIps.addSubnet('198.18.0.0', 15, 'ipv4')
blockedDownloadIps.addSubnet('198.51.100.0', 24, 'ipv4')
blockedDownloadIps.addSubnet('203.0.113.0', 24, 'ipv4')
blockedDownloadIps.addSubnet('224.0.0.0', 4, 'ipv4')
blockedDownloadIps.addSubnet('240.0.0.0', 4, 'ipv4')
blockedDownloadIps.addAddress('255.255.255.255', 'ipv4')
blockedDownloadIps.addAddress('::', 'ipv6')
blockedDownloadIps.addAddress('::1', 'ipv6')
blockedDownloadIps.addSubnet('64:ff9b::', 96, 'ipv6')
blockedDownloadIps.addSubnet('100::', 64, 'ipv6')
blockedDownloadIps.addSubnet('2001::', 32, 'ipv6')
blockedDownloadIps.addSubnet('2001:db8::', 32, 'ipv6')
blockedDownloadIps.addSubnet('2002::', 16, 'ipv6')
blockedDownloadIps.addSubnet('fc00::', 7, 'ipv6')
blockedDownloadIps.addSubnet('fe80::', 10, 'ipv6')
blockedDownloadIps.addSubnet('ff00::', 8, 'ipv6')
// Примечание: IPv4-mapped IPv6 (::ffff:0:0/96) намеренно НЕ добавлен сюда как ipv6-правило.
// Баг Node.js net.BlockList: если в одном BlockList есть и это правило, и ipv4-подсети,
// то check(anyIpv4, 'ipv4') начинает возвращать true для ЛЮБОГО адреса (проверено на
// Node 24.17/24.18 — 8.8.8.8 и 172.64.x.x блокировались наравне с приватными сетями).
// Вместо этого extractMappedIpv4 разворачивает такие адреса в обычный IPv4 и проверяет
// его через тот же ipv4-блок-лист — семантически эквивалентно, без затронутого бага.

type DownloadLookupFamily = number | 'IPv4' | 'IPv6' | undefined
type DownloadLookupOptions = { family?: DownloadLookupFamily; all?: boolean }
type DownloadLookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)

function normalizeDownloadHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

/** Разворачивает 8 групп IPv6-адреса (учитывая сокращение "::"), либо null, если это не валидный IPv6. */
function expandIpv6Groups(address: string): number[] | null {
  const parts = address.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':').filter(Boolean) : []
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : []
  if (parts.length === 1) {
    if (head.length !== 8) return null
    return head.map((h) => parseInt(h, 16))
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  return [...head, ...Array(missing).fill('0'), ...tail].map((h) => parseInt(h, 16))
}

/**
 * Достаёт вложенный IPv4 из IPv4-mapped IPv6-литерала (::ffff:0:0/96), в обеих формах,
 * которые может выдать `new URL()`: сжатой hex-групповой (::ffff:7f00:1) и точечной
 * (::ffff:127.0.0.1). Возвращает null, если адрес не является IPv4-mapped.
 */
function extractMappedIpv4(host: string): string | null {
  const dottedMatch = host.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (dottedMatch) return isIP(dottedMatch[1]) === 4 ? dottedMatch[1] : null

  const groups = expandIpv6Groups(host)
  if (!groups || groups.length !== 8) return null
  if (groups[0] || groups[1] || groups[2] || groups[3] || groups[4] || groups[5] !== 0xffff) return null
  const high = groups[6]
  const low = groups[7]
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.')
}

function isBlockedIpAddress(address: string): boolean {
  const host = normalizeDownloadHostname(address)
  const family = isIP(host)
  if (family === 4) return blockedDownloadIps.check(host, 'ipv4')
  if (family === 6) {
    // ::ffff:0:0/96 намеренно не в blockedDownloadIps (см. комментарий у объявления
    // BlockList выше) — вместо этого разворачиваем вложенный IPv4 и проверяем его
    // через уже рабочий ipv4-блок-лист.
    const mappedIpv4 = extractMappedIpv4(host)
    if (mappedIpv4) return blockedDownloadIps.check(mappedIpv4, 'ipv4')
    return blockedDownloadIps.check(host, 'ipv6')
  }
  return false
}

function isBlockedDownloadHost(hostname: string): boolean {
  const host = normalizeDownloadHostname(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isBlockedIpAddress(host)
}

function normalizeLookupFamily(family: DownloadLookupFamily): number {
  if (family === 'IPv4') return 4
  if (family === 'IPv6') return 6
  return family === 4 || family === 6 ? family : 0
}

export async function resolveAllowedDownloadAddresses(
  hostname: string,
  family: DownloadLookupFamily = 0
): Promise<Array<{ address: string; family: number }>> {
  const requestedFamily = normalizeLookupFamily(family)
  const host = normalizeDownloadHostname(hostname)
  if (!host || isBlockedDownloadHost(host)) {
    // Диагностика: причина всегда одна и та же строка для пользователя (не палим детали
    // блокировки наружу), но в консоль main-процесса пишем, какая именно ветка сработала —
    // иначе три разных случая неотличимы друг от друга в логах.
    console.warn(`[ssrf-guard] blocked host literal: "${hostname}"`)
    throw new Error('Загрузка с этого адреса запрещена.')
  }

  const literalFamily = isIP(host)
  if (literalFamily) {
    if (requestedFamily && literalFamily !== requestedFamily) {
      console.warn(`[ssrf-guard] family mismatch for "${host}": requested=${requestedFamily} actual=${literalFamily}`)
      throw new Error('Загрузка с этого адреса запрещена.')
    }
    return [{ address: host, family: literalFamily }]
  }

  const records = await lookup(host, { all: true, verbatim: false, family: requestedFamily })
  if (!records.length) {
    console.warn(`[ssrf-guard] DNS lookup for "${host}" returned no records (family=${requestedFamily})`)
    throw new Error('Загрузка с этого адреса запрещена.')
  }
  const blocked = records.filter((record) => isBlockedIpAddress(record.address))
  if (blocked.length) {
    console.warn(
      `[ssrf-guard] DNS answer for "${host}" contains blocked address(es): ${blocked.map((r) => r.address).join(', ')} ` +
      `(full answer: ${records.map((r) => r.address).join(', ')})`
    )
    throw new Error('Загрузка с этого адреса запрещена.')
  }
  return records
}

export function safeDownloadLookup(hostname: string, options: DownloadLookupOptions, callback: DownloadLookupCallback): void {
  void resolveAllowedDownloadAddresses(hostname, options.family).then(
    (records) => {
      if (options.all) {
        ;(callback as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(null, records)
      } else {
        ;(callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          records[0].address,
          records[0].family
        )
      }
    },
    (err: NodeJS.ErrnoException) => {
      if (options.all) {
        ;(callback as (err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void)(err, [])
      } else {
        ;(callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(err, '', 0)
      }
    }
  )
}

// ─── Ограничение скорости (throttling) ────────────────────────────────────────
// 7 Мбит/с = 7 000 000 бит/с ÷ 8 = 875 000 байт/с ≈ 854 КиБ/с.
const FREE_DOWNLOAD_BYTES_PER_SEC = 875_000

/**
 * Скорость скачивания для пользователя. Премиум — без лимита (0), free — 7 Мбит/с.
 *
 * ВАЖНО: это клиентский (UX) троттлинг в доверенном main-процессе. Файлы лежат в
 * публичном CDN Supabase, поэтому по-настоящему серверный лимит здесь невозможен без
 * промежуточного проксирующего слоя (свой сервер / Edge Function с подписанными
 * ссылками). Определённый пользователь, пропатчив клиент, может его обойти — это
 * осознанный компромисс выбранной архитектуры (см. обсуждение в PR).
 */
export function downloadRateFor(premium: boolean): number {
  return premium ? 0 : FREE_DOWNLOAD_BYTES_PER_SEC
}
