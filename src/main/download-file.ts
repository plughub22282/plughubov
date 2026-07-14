import https from 'https'
import http from 'http'
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
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported URL protocol')
  }

  // Security: verify every resolved address here and again in the socket lookup to stop DNS rebinding.
  await resolveAllowedDownloadAddresses(parsed.hostname)

  return new Promise((resolve, reject) => {
    const proto = parsed.protocol === 'https:' ? https : http
    const req = proto.get(parsed, { lookup: safeDownloadLookup }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume() // release redirect response socket
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects.'))
          return
        }
        const nextUrl = new URL(res.headers.location, parsed).toString()
        downloadFile(nextUrl, dest, onProgress, rateBytesPerSec, redirectsLeft - 1).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
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
