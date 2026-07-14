import https from 'https'
import { IncomingMessage } from 'http'
import { createWriteStream } from 'fs'
import { resolveAllowedDownloadAddresses, safeDownloadLookup } from './download-safety'

/**
 * HTTP(S)-транспорт скачивания файла на диск с прогрессом и клиентским throttling.
 * Механически вынесено из src/main/index.ts без изменения поведения.
 * SSRF/DNS-rebinding guard делегируется download-safety.ts (preflight + socket lookup).
 * Модуль не зависит от Electron.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (pct: number) => void,
  rateBytesPerSec = 0,
  redirectsLeft = 5
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Unsupported URL protocol')
  }
  // Security: HTTPS-only. Обычный HTTP (в т.ч. как цель HTTPS→HTTP downgrade-редиректа)
  // отклоняется до DNS и до открытия сокета — fail-closed, dev-HTTP не поддерживается.
  if (parsed.protocol !== 'https:') {
    throw new Error('Unsupported URL protocol')
  }

  // Security: verify every resolved address here and again in the socket lookup to stop DNS rebinding.
  await resolveAllowedDownloadAddresses(parsed.hostname)

  return new Promise((resolve, reject) => {
    const req = https.get(parsed, { lookup: safeDownloadLookup }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume() // release redirect response socket before continuing/rejecting
        if (!res.headers.location) {
          // 3xx без Location — не редирект: некуда идти, зависать нельзя.
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects.'))
          return
        }
        // Security: невалидный Location не должен ронять response-callback необработанным
        // исключением — контролируемо отклоняем вместо синхронного throw в new URL().
        let nextUrl: string
        try {
          nextUrl = new URL(res.headers.location, parsed).toString()
        } catch {
          reject(new Error('Invalid redirect location.'))
          return
        }
        // Каждый hop заново проходит protocol-проверку, SSRF-preflight и safe lookup внутри
        // рекурсивного вызова: HTTPS→HTTP downgrade и заблокированный хост отклоняются там же.
        // Общий redirect budget не сбрасывается — передаётся уменьшенным.
        downloadFile(nextUrl, dest, onProgress, rateBytesPerSec, redirectsLeft - 1).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume() // release non-2xx response socket before rejecting
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const total = parseInt(res.headers['content-length'] ?? '0', 10)
      let downloaded = 0
      const file = createWriteStream(dest)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
      res.on('error', reject)

      if (rateBytesPerSec > 0) {
        // Token-bucket throttling for free downloads.
        let allowance = rateBytesPerSec
        let last = Date.now()
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) onProgress(Math.round((downloaded / total) * 100))
          const canWrite = file.write(chunk)
          const now = Date.now()
          allowance = Math.min(rateBytesPerSec, allowance + ((now - last) / 1000) * rateBytesPerSec)
          last = now
          allowance -= chunk.length
          if (!canWrite || allowance < 0) {
            res.pause()
            const waitMs = allowance < 0 ? Math.max(0, (-allowance / rateBytesPerSec) * 1000) : 0
            const resume = () => setTimeout(() => { if (!res.destroyed) res.resume() }, waitMs)
            // Security: honor disk backpressure so a slow filesystem cannot grow unbounded buffers in main.
            if (canWrite) resume()
            else file.once('drain', resume)
          }
        })
        res.on('end', () => file.end())
      } else {
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (total > 0) onProgress(Math.round((downloaded / total) * 100))
        })
        res.pipe(file)
      }
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}
