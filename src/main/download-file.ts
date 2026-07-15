import https from 'https'
import { IncomingMessage } from 'http'
import { createWriteStream, rename, unlink } from 'fs'
import { resolveAllowedDownloadAddresses, safeDownloadLookup } from './download-safety'

/**
 * Абсолютный потолок размера одной загрузки — единый source of truth (1 GiB).
 * Защищает диск и память main-процесса от бесконтрольно большого тела ответа.
 */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** Таймаут установления соединения / получения заголовков ответа. */
export const CONNECT_TIMEOUT_MS = 30_000
/** Таймаут простоя: максимум времени между чанками тела при активной передаче. */
export const IDLE_TIMEOUT_MS = 60_000
/**
 * Общий дедлайн всей операции, включая цепочку редиректов.
 * 1 GiB на свободной скорости (875000 Б/с) ≈ 1227 с; 1800 с (30 мин) покрывает это
 * с запасом на редиректы и рукопожатия и НЕ сбрасывается между hop-ами.
 */
export const TOTAL_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Выполняет SSRF/DNS-rebinding preflight, ограничивая его оставшимся временем общего
 * дедлайна. По истечении — отклоняет 'Timeout' и НЕ открывает сокет (вызов происходит
 * до https.get). Позднее завершение исходного DNS-Promise (resolve или reject)
 * проглатывается: оно не должно ни породить unhandledRejection, ни запустить запрос
 * задним числом. Таймер preflight гасится в любом случае (finally).
 */
async function preflightWithinDeadline(hostname: string, totalDeadline: number): Promise<void> {
  const remaining = totalDeadline - Date.now()
  if (remaining <= 0) throw new Error('Timeout')
  const preflight = resolveAllowedDownloadAddresses(hostname)
  // Late rejection после победы таймаута не должна всплыть как unhandledRejection.
  preflight.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      preflight.then(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout')), remaining)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * HTTPS-транспорт скачивания файла на диск с прогрессом и клиентским throttling.
 * Пишет во временный `${dest}.part` и атомарно переименовывает в dest только после
 * полного успешного закрытия; при любой ошибке .part удаляется. SSRF/DNS-rebinding
 * guard делегируется download-safety.ts (preflight + socket lookup). Не зависит от Electron.
 *
 * `deadline` — абсолютный общий дедлайн (мс, Date.now-шкала). На верхнем вызове не
 * задаётся и вычисляется из TOTAL_TIMEOUT_MS; при редиректе передаётся неизменным,
 * поэтому единый дедлайн покрывает всю цепочку. Продакшн вызывает без него.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (pct: number) => void,
  rateBytesPerSec = 0,
  redirectsLeft = 5,
  maxBytes = MAX_DOWNLOAD_BYTES,
  deadline?: number
): Promise<void> {
  // Security: лимит размера обязателен и должен быть корректным. NaN/Infinity/0/отрицательное
  // означало бы fail-open (нет потолка) — отклоняем до сети.
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('Invalid maximum download size.')
  }

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

  // Общий дедлайн вычисляется в самом начале верхнего вызова (ДО DNS preflight) и
  // сохраняется неизменным на всех редирект-hop-ах, поэтому и preflight, и передача,
  // и вся цепочка редиректов укладываются в один абсолютный дедлайн.
  const totalDeadline = deadline ?? Date.now() + TOTAL_TIMEOUT_MS

  // Security: verify every resolved address here and again in the socket lookup to stop
  // DNS rebinding. Preflight ограничен остатком общего дедлайна: если он исчерпан —
  // бросаем Timeout и НЕ открываем HTTPS-соединение.
  await preflightWithinDeadline(parsed.hostname, totalDeadline)

  return new Promise<void>((resolve, reject) => {
    const partPath = `${dest}.part`
    let settled = false
    let file: ReturnType<typeof createWriteStream> | undefined
    let response: IncomingMessage | undefined
    // NB: должно быть `let`, а не `const`. https.get() может вызвать свой response-callback
    // синхронно (внутри самого вызова, до присваивания req), а этот callback через fail()
    // читает req. С `const` это TDZ-ошибка «Cannot access 'req' before initialization»;
    // с `let` переменная в hoisted-области доступна как undefined. prefer-const тут ошибочен.
    // eslint-disable-next-line prefer-const
    let req: ReturnType<typeof https.get> | undefined
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let totalTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = (): void => {
      if (connectTimer) clearTimeout(connectTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      connectTimer = idleTimer = totalTimer = undefined
    }

    // Единое идемпотентное завершение с ошибкой: гасим таймеры, рвём сокеты и файловый
    // поток, удаляем .part и только потом reject — ровно один раз. Поздние события,
    // resume и записи после этого игнорируются (см. проверки `settled`).
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimers()
      // Сначала останавливаем сеть: рвём запрос и ответ (это сокеты, не fd на диске).
      req?.destroy()
      response?.destroy()

      // Downloader владеет partial-файлом, но удалять .part можно ТОЛЬКО после
      // фактического закрытия файлового дескриптора: иначе (особенно на Windows)
      // unlink гонится с ещё открытым хендлом. reject вызывается ровно один раз
      // в любом исходе unlink, чтобы Promise не завис.
      const removePart = (): void => {
        unlink(partPath, (unlinkErr: NodeJS.ErrnoException | null) => {
          // ENOENT (.part не существует) — штатная успешная очистка, молчим.
          // Любую другую ошибку логируем диагностически, но всё равно reject
          // исходной причиной — cleanup-сбой не должен её маскировать.
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            console.error(`downloadFile: не удалось удалить ${partPath} при очистке:`, unlinkErr)
          }
          reject(err)
        })
      }

      const stream = file
      if (!stream || stream.closed) {
        // Поток не создан, либо дескриптор уже закрыт — удалять .part можно сразу.
        removePart()
        return
      }
      // Дожидаемся реального 'close' (release fd), только потом удаляем. destroy()
      // вызываем один раз; если поток уже уничтожается, 'close' всё равно придёт.
      stream.once('close', removePart)
      if (!stream.destroyed) stream.destroy()
    }

    // Единое идемпотентное успешное завершение: атомарный rename .part → dest.
    // dest считается успешным только после удачного rename.
    const succeed = (): void => {
      if (settled) return
      settled = true
      clearTimers()
      rename(partPath, dest, (err) => {
        if (err) {
          unlink(partPath, () => reject(err))
          return
        }
        resolve()
      })
    }

    // Делегирование редирект-hop-у: этот вызов перестаёт владеть жизненным циклом и
    // просто зеркалит результат рекурсии; общий дедлайн передаётся неизменным.
    const delegateRedirect = (nextUrl: string): void => {
      settled = true
      clearTimers()
      downloadFile(nextUrl, dest, onProgress, rateBytesPerSec, redirectsLeft - 1, maxBytes, totalDeadline)
        .then(resolve)
        .catch(reject)
    }

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail(new Error('Timeout')), IDLE_TIMEOUT_MS)
    }

    // Общий дедлайн и таймаут соединения армируются до открытия сокета.
    totalTimer = setTimeout(() => fail(new Error('Timeout')), Math.max(0, totalDeadline - Date.now()))
    connectTimer = setTimeout(() => fail(new Error('Timeout')), CONNECT_TIMEOUT_MS)

    req = https.get(parsed, { lookup: safeDownloadLookup }, (res: IncomingMessage) => {
      if (settled) {
        res.resume() // соединение/дедлайн уже истекли — освобождаем сокет
        return
      }
      response = res
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = undefined
      }

      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume() // release redirect response socket before continuing/rejecting
        if (!res.headers.location) {
          // 3xx без Location — не редирект: некуда идти, зависать нельзя.
          fail(new Error(`HTTP ${res.statusCode}`))
          return
        }
        if (redirectsLeft <= 0) {
          fail(new Error('Too many redirects.'))
          return
        }
        // Security: невалидный Location не должен ронять response-callback необработанным
        // исключением — контролируемо отклоняем вместо синхронного throw в new URL().
        let nextUrl: string
        try {
          nextUrl = new URL(res.headers.location, parsed).toString()
        } catch {
          fail(new Error('Invalid redirect location.'))
          return
        }
        // Каждый hop заново проходит protocol-проверку, SSRF-preflight и safe lookup внутри
        // рекурсивного вызова: HTTPS→HTTP downgrade и заблокированный хост отклоняются там же.
        delegateRedirect(nextUrl)
        return
      }
      if (res.statusCode !== 200) {
        res.resume() // release non-2xx response socket before rejecting
        fail(new Error(`HTTP ${res.statusCode}`))
        return
      }

      // Security: доверяем Content-Length только если это корректное неотрицательное целое.
      // NaN/отрицательное/дробное трактуем как «неизвестно» — размер контролирует рантайм-счётчик.
      const rawLen = res.headers['content-length']
      const declared = rawLen !== undefined ? Number(rawLen) : NaN
      const hasDeclared = Number.isInteger(declared) && declared >= 0
      // Заявленный размер выше потолка отклоняем ДО открытия файла и записи.
      if (hasDeclared && declared > maxBytes) {
        res.resume() // release oversized response socket before rejecting
        fail(new Error('Download exceeds maximum size.'))
        return
      }
      const total = hasDeclared ? declared : 0
      let downloaded = 0

      file = createWriteStream(partPath)
      file.on('error', (e: Error) => fail(e))
      res.on('error', (e: Error) => fail(e))
      file.on('finish', () =>
        file!.close(() => {
          if (settled) return
          // Тело короче заявленного Content-Length — обрыв: не выдаём частичный файл за успех.
          if (hasDeclared && downloaded < declared) {
            fail(new Error('Truncated download.'))
            return
          }
          succeed()
        })
      )

      // Прогресс всегда конечный и в диапазоне 0–100 (тело больше заявленного не даёт >100).
      const reportProgress = (): void => {
        if (total > 0) onProgress(Math.min(100, Math.max(0, Math.round((downloaded / total) * 100))))
      }
      // Security: фактические байты (в любой ветке) не должны превысить потолок, даже если
      // сервер соврал в Content-Length или прислал больше. При превышении рвём соединение.
      const enforceLimit = (): boolean => {
        if (downloaded <= maxBytes) return false
        fail(new Error('Download exceeds maximum size.'))
        return true
      }

      armIdle()

      if (rateBytesPerSec > 0) {
        // Token-bucket throttling for free downloads.
        let allowance = rateBytesPerSec
        let last = Date.now()
        res.on('data', (chunk: Buffer) => {
          if (settled) return
          armIdle() // плановая rate-пауза (< 1 с) много меньше idle-таймаута, ложно его не тронет
          downloaded += chunk.length
          if (enforceLimit()) return
          reportProgress()
          const canWrite = file!.write(chunk)
          const now = Date.now()
          allowance = Math.min(rateBytesPerSec, allowance + ((now - last) / 1000) * rateBytesPerSec)
          last = now
          allowance -= chunk.length
          if (!canWrite || allowance < 0) {
            res.pause()
            const waitMs = allowance < 0 ? Math.max(0, (-allowance / rateBytesPerSec) * 1000) : 0
            const resume = () => setTimeout(() => { if (!settled && !res.destroyed) res.resume() }, waitMs)
            // Security: honor disk backpressure so a slow filesystem cannot grow unbounded buffers in main.
            if (canWrite) resume()
            else file!.once('drain', resume)
          }
        })
        res.on('end', () => { if (!settled) file!.end() })
      } else {
        res.on('data', (chunk: Buffer) => {
          if (settled) return
          armIdle()
          downloaded += chunk.length
          if (enforceLimit()) return
          reportProgress()
        })
        res.pipe(file)
      }
    })
    req.on('error', (e: Error) => fail(e))
  })
}
