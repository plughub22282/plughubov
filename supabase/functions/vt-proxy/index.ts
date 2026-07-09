// Прокси к VirusTotal API v3. Единственное место, где живёт реальный
// VIRUSTOTAL_API_KEY (Supabase secret) — клиент (src/main/antivirus.ts)
// больше не знает ключ, только вызывает это через supabase.functions.invoke().
//
// JWT проверяется платформой Supabase на входе (функция задеплоена без
// --no-verify-jwt), поэтому анонимные вызовы отклоняются до того, как
// выполнится код ниже — отдельной ручной проверки токена не требуется.
//
// Троттлинг общий на всех пользователей сразу (один VT-ключ, ~4 запр/мин на
// free tier), поэтому не может жить в памяти одного вызова функции — см.
// throttle() и таблицу vt_rate_limit в supabase/schema.sql.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const VT_BASE = 'https://www.virustotal.com/api/v3'
const VT_MIN_REQUEST_INTERVAL_MS = 16_000 // тот же запас, что раньше был на клиенте
const VT_THROTTLE_POLL_MS = 1_000
const VT_THROTTLE_MAX_WAIT_MS = 25_000 // держим в пределах бюджета одного вызова функции

const VT_API_KEY = Deno.env.get('VIRUSTOTAL_API_KEY')

// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY доступны автоматически в любой
// Edge Function — заводить их руками через `supabase secrets set` не нужно.
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Атомарно резервирует право на следующий запрос к VT: строка обновляется,
 * только если с прошлого запроса (от ЛЮБОГО пользователя) прошло достаточно
 * времени. Конкурирующие вызовы функции проигрывают гонку за UPDATE и просто
 * повторяют попытку — это и есть общая на все инстансы очередь, которую
 * in-memory состояние одного вызова функции обеспечить не может.
 */
async function throttle(): Promise<void> {
  const deadline = Date.now() + VT_THROTTLE_MAX_WAIT_MS
  for (;;) {
    const threshold = new Date(Date.now() - VT_MIN_REQUEST_INTERVAL_MS).toISOString()
    const { data, error } = await admin
      .from('vt_rate_limit')
      .update({ last_request_at: new Date().toISOString() })
      .eq('id', true)
      .lte('last_request_at', threshold)
      .select('id')
    if (error) {
      console.error('[vt-proxy] throttle error:', error)
      throw new HttpError(500, 'Не удалось получить слот очереди VirusTotal.')
    }
    if (data && data.length > 0) return
    if (Date.now() > deadline) {
      throw new HttpError(429, 'VirusTotal сейчас занят другим запросом — попробуйте ещё раз.')
    }
    await new Promise((resolve) => setTimeout(resolve, VT_THROTTLE_POLL_MS))
  }
}

async function vtCall(path: string, init: RequestInit = {}): Promise<Response> {
  if (!VT_API_KEY) throw new HttpError(500, 'VirusTotal API-ключ не настроен на сервере.')
  await throttle()
  return fetch(`${VT_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-apikey': VT_API_KEY }
  })
}

interface VtFileAttributes {
  last_analysis_stats?: { malicious?: number; suspicious?: number }
}

function verdictFromStats(stats?: { malicious?: number; suspicious?: number }): 'clean' | 'malicious' {
  const malicious = stats?.malicious ?? 0
  const suspicious = stats?.suspicious ?? 0
  return malicious > 0 || suspicious > 0 ? 'malicious' : 'clean'
}

/** Фаза А: быстрая проверка по SHA256 уже известного VirusTotal файла. */
async function handleLookup(hash: string) {
  if (!hash) throw new HttpError(400, 'Не передан hash.')
  const res = await vtCall(`/files/${hash}`)
  if (res.status === 404) return { verdict: 'unknown' as const }
  if (!res.ok) throw new HttpError(502, `VirusTotal вернул ошибку (${res.status}).`)
  const body = (await res.json()) as { data?: { attributes?: VtFileAttributes } }
  return { verdict: verdictFromStats(body.data?.attributes?.last_analysis_stats) }
}

/** Ссылка для прямой загрузки больших (>32 МБ) файлов — байты идут с клиента напрямую в VT, не через прокси. */
async function handleUploadUrl() {
  const res = await vtCall('/files/upload_url')
  if (!res.ok) throw new HttpError(502, 'Не удалось получить ссылку загрузки VirusTotal для крупного файла.')
  const body = (await res.json()) as { data?: string }
  if (!body.data) throw new HttpError(502, 'VirusTotal не вернул ссылку загрузки.')
  return { url: body.data }
}

/** Файлы ≤32 МБ: ключ обязателен прямо на запросе с байтами, поэтому байты идут через прокси. */
async function handleUploadSmall(req: Request) {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(400, 'Некорректный формат загрузки файла.')
  }
  if (!req.body) throw new HttpError(400, 'Пустое тело запроса.')

  // Security: stream the client multipart body to VT instead of arrayBuffer()+Blob duplication in memory.
  const res = await vtCall('/files', {
    method: 'POST',
    body: req.body,
    headers: { 'content-type': contentType }
  })
  if (!res.ok) throw new HttpError(502, `VirusTotal отклонил загрузку файла (${res.status}).`)
  const body = (await res.json()) as { data?: { id?: string } }
  if (!body.data?.id) throw new HttpError(502, 'VirusTotal не вернул идентификатор анализа.')
  return { analysisId: body.data.id }
}
/** Один опрос статуса анализа — цикл ожидания остаётся на клиенте (см. pollAnalysis в antivirus.ts). */
async function handlePoll(analysisId: string) {
  if (!analysisId) throw new HttpError(400, 'Не передан analysisId.')
  const res = await vtCall(`/analyses/${analysisId}`)
  if (!res.ok) throw new HttpError(502, `VirusTotal вернул ошибку при опросе анализа (${res.status}).`)
  const body = (await res.json()) as {
    data?: { attributes?: { status?: string; stats?: { malicious?: number; suspicious?: number } } }
  }
  const attrs = body.data?.attributes
  if (attrs?.status !== 'completed') return { status: 'pending' as const }
  return { status: 'completed' as const, verdict: verdictFromStats(attrs.stats) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop()

  try {
    switch (action) {
      case 'lookup': {
        const { hash } = (await req.json()) as { hash?: string }
        return jsonResponse(await handleLookup(hash ?? ''))
      }
      case 'upload-url':
        return jsonResponse(await handleUploadUrl())
      case 'upload-small':
        return jsonResponse(await handleUploadSmall(req))
      case 'poll': {
        const { analysisId } = (await req.json()) as { analysisId?: string }
        return jsonResponse(await handlePoll(analysisId ?? ''))
      }
      default:
        return jsonResponse({ error: 'Unknown action' }, 404)
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (!(err instanceof HttpError)) console.error('[vt-proxy] unexpected error:', err)
    const message = err instanceof HttpError ? err.message : 'Внутренняя ошибка VirusTotal-прокси.'
    return jsonResponse({ error: message }, status)
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
