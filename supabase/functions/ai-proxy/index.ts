// Прокси к OpenRouter (бесплатные :free модели). Единственное место, где живёт
// реальный OPENROUTER_API_KEY (Supabase secret) — main-процесс (src/main/ai.ts)
// его не знает, только вызывает этот эндпоинт напрямую через fetch с JWT
// пользователя (не через supabase.functions.invoke — нужен потоковый ответ,
// а invoke буферизует тело). Тот же приём разделения секретов, что и у
// vt-proxy для VirusTotal-ключа.
//
// JWT проверяется платформой Supabase на входе (функция задеплоена без
// --no-verify-jwt), поэтому анонимные вызовы отклоняются до того, как
// выполнится код ниже. Квоты на сообщения/пользователя (usage_counters,
// consume_named_quota) списываются на стороне main-процесса ДО обращения
// сюда — но это UX-оптимизация (не тратить общий троттлинг на заведомо
// отклонённый запрос), а не защита: тот же JWT можно использовать напрямую
// в обход src/main/ai.ts. Поэтому здесь та же квота проверяется ещё раз от
// имени вызывающего (см. consumeUserQuota) — под своим ключом usage_counters,
// чтобы не задваивать счётчик клиента. Отдельно — общий на всех пользователей
// троттлинг одного OpenRouter-ключа (см. throttle() ниже и таблицу
// ai_rate_limit в schema.sql).
//
// Бесплатные модели OpenRouter периодически меняются/выводятся из ротации —
// актуальный список: https://openrouter.ai/models?max_price=0. При необходимости
// переключить модель без редеплоя: `supabase secrets set AI_MODEL=...`.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY')
const AI_MODEL = Deno.env.get('AI_MODEL') ?? 'nvidia/nemotron-3-ultra-550b-a55b:free'

// Свободный tier OpenRouter обычно ограничен ~20 запр/мин на ключ — держим
// запас, чтобы не словить 429 при нескольких пользователях одновременно.
const AI_MIN_REQUEST_INTERVAL_MS = 3_500
const AI_THROTTLE_POLL_MS = 500
const AI_THROTTLE_MAX_WAIT_MS = 20_000

const MAX_MESSAGES = 30 // ограничение контекста диалога, приходящего от клиента
const MAX_CONTENT_LEN = 4_000 // на одно сообщение — от флуда/огромных промптов
const MAX_CATALOG_LEN = 12_000 // на блок каталога плагинов в 'recommend'

// Те же значения, что CHAT_DAILY_*/RECOMMEND_DAILY_* в src/main/ai.ts, но свои ключи
// usage_counters — это отдельная (серверная) проверка того же лимита, а не тот же счётчик.
const CHAT_QUOTA_KEY = 'ai_chat_daily_proxy'
const RECOMMEND_QUOTA_KEY = 'ai_recommend_daily_proxy'
const CHAT_DAILY_FREE = 30
const CHAT_DAILY_PREMIUM = 150
const RECOMMEND_DAILY_FREE = 10
const RECOMMEND_DAILY_PREMIUM = 40

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Клиент от имени вызывающего (форвард его JWT) — нужен, чтобы auth.uid() внутри RPC ниже был реальным. */
function userClientFrom(req: Request) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }
  })
}

interface QuotaResult {
  allowed: boolean
  used_after: number
  resets_at: string
}

/**
 * Серверная проверка дневного лимита для прямых вызовов функции в обход
 * src/main/ai.ts. Премиум-статус берём из has_premium() (source of truth в БД),
 * а не доверяем клиенту — иначе лимит обходился бы указанием isPremium.
 */
async function consumeUserQuota(req: Request, counterKey: string, freeLimit: number, premiumLimit: number): Promise<void> {
  const client = userClientFrom(req)
  const { data: isPremium, error: premiumError } = await client.rpc('has_premium')
  if (premiumError) {
    console.error('[ai-proxy] has_premium error:', premiumError)
    throw new HttpError(500, 'Не удалось проверить статус подписки.')
  }
  const limit = isPremium ? premiumLimit : freeLimit
  const { data, error } = await client.rpc('consume_named_quota', { p_counter_key: counterKey, p_limit: limit })
  const result = (data as QuotaResult[] | null)?.[0]
  if (error || !result) {
    console.error('[ai-proxy] consume_named_quota error:', error)
    throw new HttpError(500, 'Не удалось проверить лимит запросов.')
  }
  if (!result.allowed) {
    throw new HttpError(429, `Дневной лимит AI-запросов исчерпан (${limit}/сутки).`)
  }
}

/** Тот же атомарный приём, что throttle() в vt-proxy: один общий бюджет на всех. */
async function throttle(): Promise<void> {
  const deadline = Date.now() + AI_THROTTLE_MAX_WAIT_MS
  for (;;) {
    const threshold = new Date(Date.now() - AI_MIN_REQUEST_INTERVAL_MS).toISOString()
    const { data, error } = await admin
      .from('ai_rate_limit')
      .update({ last_request_at: new Date().toISOString() })
      .eq('id', true)
      .lte('last_request_at', threshold)
      .select('id')
    if (error) {
      console.error('[ai-proxy] throttle error:', error)
      throw new HttpError(500, 'Не удалось получить слот очереди AI.')
    }
    if (data && data.length > 0) return
    if (Date.now() > deadline) {
      throw new HttpError(429, 'AI-сервис сейчас занят другим запросом — попробуйте ещё раз.')
    }
    await new Promise((resolve) => setTimeout(resolve, AI_THROTTLE_POLL_MS))
  }
}

interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function sanitizeMessages(input: unknown): ChatMsg[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'messages должен быть массивом.')
  const msgs = input.slice(-MAX_MESSAGES).map((m) => {
    const role = (m as ChatMsg)?.role
    const content = String((m as ChatMsg)?.content ?? '').slice(0, MAX_CONTENT_LEN)
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new HttpError(400, 'Некорректная роль сообщения.')
    }
    return { role, content }
  })
  if (msgs.length === 0) throw new HttpError(400, 'Пустой список сообщений.')
  return msgs
}

async function openRouterCall(body: Record<string, unknown>): Promise<Response> {
  if (!OPENROUTER_API_KEY) throw new HttpError(500, 'OpenRouter API-ключ не настроен на сервере.')
  await throttle()
  return fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // OpenRouter просит указывать источник — не обязательно, но снижает шанс троттлинга анонимных вызовов.
      'HTTP-Referer': 'https://vst3-manager.local',
      'X-Title': 'VST3 Manager'
    },
    body: JSON.stringify({ model: AI_MODEL, ...body })
  })
}

// Добавляется после обрезки истории (sanitizeMessages), чтобы при длинном диалоге
// системная инструкция не улетела вместе со старыми сообщениями.
const CHAT_SYSTEM_PROMPT =
  'Тебя зовут Владон — ты ассистент по звуку и VST3-плагинам в десктоп-приложении. Если спросят имя — отвечай ' +
  '«Владон». Отвечай кратко и по существу, обычными предложениями, разговорным языком. НЕ используй markdown и ' +
  'любые спецсимволы форматирования: без звёздочек, решёток, обратных кавычек, дефисов-буллетов, нумерованных ' +
  'списков и эмодзи — только чистый текст.'

/** Действие 'chat': стриминг SSE от OpenRouter ретранслируется как есть, без буферизации. */
async function handleChat(req: Request): Promise<Response> {
  await consumeUserQuota(req, CHAT_QUOTA_KEY, CHAT_DAILY_FREE, CHAT_DAILY_PREMIUM)
  const { messages } = (await req.json()) as { messages?: unknown }
  const sanitized = sanitizeMessages(messages)
  const withSystem: ChatMsg[] = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...sanitized]

  const upstream = await openRouterCall({ messages: withSystem, stream: true })
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    console.error('[ai-proxy] openrouter chat error:', upstream.status, text)
    throw new HttpError(502, `AI-сервис вернул ошибку (${upstream.status}).`)
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  })
}

/** Действие 'recommend': один нестримингованный вызов, модель обязана вернуть строгий JSON. */
async function handleRecommend(req: Request) {
  await consumeUserQuota(req, RECOMMEND_QUOTA_KEY, RECOMMEND_DAILY_FREE, RECOMMEND_DAILY_PREMIUM)
  const { catalog, query } = (await req.json()) as { catalog?: string; query?: string }
  const catalogText = String(catalog ?? '').slice(0, MAX_CATALOG_LEN)
  const queryText = String(query ?? '').slice(0, 500)
  if (!catalogText) throw new HttpError(400, 'Пустой каталог плагинов.')

  const system =
    'Ты помощник по подбору VST3-плагинов и звуковых пресетов из предоставленного каталога. ' +
    'Отвечай СТРОГО валидным JSON вида {"recommendations":[{"id":"...","reason":"..."}]}, ' +
    'без markdown-разметки и пояснений вне JSON. Выбирай только id, реально присутствующие в каталоге ' +
    '(поле id указано у каждой позиции). Не более 6 рекомендаций. reason — одно короткое предложение на русском.'
  const user = `Каталог (id | название | категория | теги | описание):\n${catalogText}\n\nЗапрос пользователя: ${
    queryText || '(не указан — предложи разнообразную подборку популярных категорий)'
  }`

  const upstream = await openRouterCall({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    stream: false,
    response_format: { type: 'json_object' }
  })
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    console.error('[ai-proxy] openrouter recommend error:', upstream.status, text)
    throw new HttpError(502, `AI-сервис вернул ошибку (${upstream.status}).`)
  }
  const body = (await upstream.json()) as { choices?: { message?: { content?: string } }[] }
  const raw = body.choices?.[0]?.message?.content ?? ''

  const parsed = parseRecommendations(raw)
  return { recommendations: parsed }
}

function parseRecommendations(raw: string): { id: string; reason: string }[] {
  const tryParse = (text: string): { id: string; reason: string }[] | null => {
    try {
      const obj = JSON.parse(text) as { recommendations?: { id?: string; reason?: string }[] }
      if (!Array.isArray(obj.recommendations)) return null
      return obj.recommendations
        .filter((r) => typeof r?.id === 'string' && r.id.length > 0)
        .slice(0, 6)
        .map((r) => ({ id: String(r.id), reason: String(r.reason ?? '').slice(0, 300) }))
    } catch {
      return null
    }
  }

  // Модель иногда оборачивает JSON в ```json ... ``` несмотря на просьбу — пробуем как есть, потом вырезаем блок.
  const direct = tryParse(raw)
  if (direct) return direct
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    const extracted = tryParse(match[0])
    if (extracted) return extracted
  }
  throw new HttpError(502, 'AI вернул ответ в неожиданном формате.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop()

  try {
    switch (action) {
      case 'chat':
        return await handleChat(req)
      case 'recommend':
        return jsonResponse(await handleRecommend(req))
      default:
        return jsonResponse({ error: 'Unknown action' }, 404)
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (!(err instanceof HttpError)) console.error('[ai-proxy] unexpected error:', err)
    const message = err instanceof HttpError ? err.message : 'Внутренняя ошибка AI-прокси.'
    return jsonResponse({ error: message }, status)
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
