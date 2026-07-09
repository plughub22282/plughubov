import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { supabase, SUPABASE_URL, type DbPlugin, type DbCommunityPlugin } from './supabase'
import { rejectUntrustedSender } from './ipc-security'
import { toSafeError } from './errors'
import { getState } from './auth'

/**
 * AI-ассистент (чат + подбор плагинов) поверх бесплатных моделей OpenRouter.
 *
 * Реальный OPENROUTER_API_KEY живёт только в Edge Function supabase/functions/ai-proxy
 * (тот же приём разделения секретов, что у VirusTotal — см. antivirus.ts). Main
 * ходит туда напрямую через fetch с JWT текущей сессии (а не supabase.functions.invoke,
 * который буферизует тело ответа и не годится для потокового чата), парсит SSE
 * и транслирует токены в renderer через 'ai:chunk'/'ai:done'/'ai:error'.
 *
 * Квоты — свои для чата и для подбора — списываются здесь через consume_named_quota
 * (SECURITY DEFINER RPC над usage_counters, см. schema.sql), до обращения к прокси,
 * чтобы не тратить лимит общего троттлинга ai-proxy на заведомо отклонённые запросы.
 */

const CHAT_QUOTA_KEY = 'ai_chat_daily'
const RECOMMEND_QUOTA_KEY = 'ai_recommend_daily'
const CHAT_DAILY_FREE = 30
const RECOMMEND_DAILY_FREE = 10
const CHAT_DAILY_PREMIUM = 150
const RECOMMEND_DAILY_PREMIUM = 40

const MAX_CATALOG_ROWS = 200

// Потолок на весь запрос стрима чата — без него зависший ai-proxy держит сокет в main вечно.
const AI_STREAM_TIMEOUT_MS = 2 * 60_000

// requestId -> контроллер активного стрима, чтобы отменить его при закрытии окна или по ai:cancel.
const activeStreams = new Map<string, AbortController>()

interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface QuotaResult {
  allowed: boolean
  used_after: number
  resets_at: string
}

async function consumeQuota(counterKey: string, limit: number): Promise<QuotaResult> {
  const { data, error } = await supabase.rpc('consume_named_quota', { p_counter_key: counterKey, p_limit: limit })
  if (error || !data?.[0]) throw error ?? new Error('Не удалось проверить лимит.')
  return data[0] as QuotaResult
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

function broadcastToSender(event: IpcMainInvokeEvent, channel: string, payload: unknown): void {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Разбирает SSE-поток OpenAI/OpenRouter-формата на дельты текста. */
async function streamChat(
  event: IpcMainInvokeEvent,
  requestId: string,
  token: string,
  messages: ChatMsg[]
): Promise<void> {
  const controller = new AbortController()
  activeStreams.set(requestId, controller)
  // Закрытие окна должно обрывать стрим, а не оставлять его висеть в main без слушателя.
  const win = BrowserWindow.fromWebContents(event.sender)
  const onClosed = (): void => controller.abort()
  win?.once('closed', onClosed)
  const timer = setTimeout(() => controller.abort(), AI_STREAM_TIMEOUT_MS)

  try {
    let res: Response
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/ai-proxy/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal
      })
    } catch (err) {
      broadcastToSender(event, 'ai:error', { requestId, error: toSafeError(err, 'Не удалось подключиться к AI-сервису.', '[ai] stream connect error') })
      return
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      let message = 'AI-сервис недоступен, попробуйте позже.'
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        /* оставляем дефолтное сообщение */
      }
      broadcastToSender(event, 'ai:error', { requestId, error: message })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) broadcastToSender(event, 'ai:chunk', { requestId, delta })
          } catch {
            /* пропускаем строки, не являющиеся JSON (keep-alive комментарии и т.п.) */
          }
        }
      }
    } catch (err) {
      broadcastToSender(event, 'ai:error', { requestId, error: toSafeError(err, 'Соединение с AI прервалось.', '[ai] stream error') })
      return
    }

    broadcastToSender(event, 'ai:done', { requestId })
  } finally {
    clearTimeout(timer)
    win?.removeListener('closed', onClosed)
    activeStreams.delete(requestId)
  }
}

interface CatalogContext {
  index: Map<string, { name: string }>
  text: string
}

type CatalogPluginRow = Pick<DbPlugin, 'id' | 'name' | 'category' | 'description'>
type CatalogCommunityRow = Pick<DbCommunityPlugin, 'id' | 'name' | 'category' | 'description' | 'tags' | 'kind'>

/** Компактный текстовый каталог для промпта модели: id | название | категория | теги | описание. */
async function buildCatalogContext(): Promise<CatalogContext> {
  const [plugins, community] = await Promise.all([
    supabase.from('plugins').select('id,name,category,tags,description').limit(MAX_CATALOG_ROWS),
    supabase
      .from('community_plugins')
      .select('id,name,category,tags,description,kind')
      .or('kind.is.null,kind.eq.plugin')
      .limit(MAX_CATALOG_ROWS)
  ])

  const lines: string[] = []
  const index = new Map<string, { name: string }>()

  for (const row of (plugins.data ?? []) as CatalogPluginRow[]) {
    lines.push(formatCatalogLine(row.id, row.name, row.category, undefined, row.description))
    index.set(row.id, { name: row.name })
  }
  for (const row of (community.data ?? []) as CatalogCommunityRow[]) {
    if ((row.kind ?? 'plugin') !== 'plugin') continue
    lines.push(formatCatalogLine(row.id, row.name, row.category ?? undefined, row.tags ?? undefined, row.description ?? undefined))
    index.set(row.id, { name: row.name })
  }

  return { index, text: lines.join('\n') }
}

function formatCatalogLine(
  id: string,
  name: string,
  category?: string,
  tags?: string[],
  description?: string
): string {
  const parts = [id, name, category ?? '—', (tags ?? []).join(',') || '—', (description ?? '').slice(0, 160)]
  return parts.join(' | ')
}

let initialized = false

export function registerAiIpc(): void {
  if (initialized) return
  initialized = true

  ipcMain.handle('ai:send', async (event, payload: { messages?: ChatMsg[] }) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked

    const token = await accessToken()
    if (!token) return { ok: false, error: 'Войдите, чтобы пользоваться AI-ассистентом.' }

    // Тариф решает только серверное состояние подписки, а не флаг из renderer — иначе любой
    // залогиненный пользователь мог бы выдать себя за premium простым вызовом из devtools.
    const state = await getState()
    const limit = state.premium ? CHAT_DAILY_PREMIUM : CHAT_DAILY_FREE
    let quota: QuotaResult
    try {
      quota = await consumeQuota(CHAT_QUOTA_KEY, limit)
    } catch (err) {
      return { ok: false, error: toSafeError(err, 'Не удалось проверить лимит запросов.', '[ai] consume chat quota') }
    }
    if (!quota.allowed) {
      return { ok: false, error: `Дневной лимит AI-сообщений исчерпан (${limit}/сутки).`, resetsAt: quota.resets_at }
    }

    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (messages.length === 0) return { ok: false, error: 'Пустое сообщение.' }

    const requestId = randomUUID()
    // Стрим уходит в фоне — ai:send отвечает сразу с requestId, дальше события ai:chunk/ai:done/ai:error.
    void streamChat(event, requestId, token, messages)
    return { ok: true, requestId }
  })

  ipcMain.handle('ai:recommend', async (event, payload: { query?: string }) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked

    const token = await accessToken()
    if (!token) return { ok: false, error: 'Войдите, чтобы получить рекомендации.' }

    // См. ai:send — тариф берём из серверного getState(), а не из renderer-флага.
    const state = await getState()
    const limit = state.premium ? RECOMMEND_DAILY_PREMIUM : RECOMMEND_DAILY_FREE
    let quota: QuotaResult
    try {
      quota = await consumeQuota(RECOMMEND_QUOTA_KEY, limit)
    } catch (err) {
      return { ok: false, error: toSafeError(err, 'Не удалось проверить лимит запросов.', '[ai] consume recommend quota') }
    }
    if (!quota.allowed) {
      return { ok: false, error: `Дневной лимит подборок исчерпан (${limit}/сутки).`, resetsAt: quota.resets_at }
    }

    try {
      const { index, text: catalogText } = await buildCatalogContext()
      if (!catalogText) return { ok: false, error: 'Каталог плагинов пока пуст.' }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-proxy/recommend`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalog: catalogText, query: payload?.query ?? '' })
      })
      const body = (await res.json().catch(() => ({}))) as {
        recommendations?: { id: string; reason: string }[]
        error?: string
      }
      if (!res.ok) return { ok: false, error: body.error ?? 'AI-сервис вернул ошибку.' }

      // Не доверяем id от модели дальше проверки, что они реально есть в каталоге — исключаем "галлюцинации".
      const items = (body.recommendations ?? [])
        .filter((r) => index.has(r.id))
        .map((r) => ({ id: r.id, name: index.get(r.id)!.name, reason: r.reason }))

      return { ok: true, items }
    } catch (err) {
      return { ok: false, error: toSafeError(err, 'Не удалось получить рекомендации.', '[ai] recommend error') }
    }
  })

  // Явная отмена стрима (например, сброс чата в renderer) — не ждём таймаута, обрываем сразу.
  ipcMain.handle('ai:cancel', (event, payload: { requestId?: string }) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked

    activeStreams.get(payload?.requestId ?? '')?.abort()
    return { ok: true }
  })
}
