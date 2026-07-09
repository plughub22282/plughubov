import { ipcMain, BrowserWindow } from 'electron'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { getState } from './auth'
import { rejectUntrustedSender } from './ipc-security'
import { toSafeError } from './errors'

/**
 * Премиум-чат — единая общая комната для всех premium-подписчиков.
 *
 * Renderer не имеет доступа к Supabase напрямую (как и в auth.ts): он ходит сюда
 * через IPC, а новые сообщения получает событием 'chat:message'. Источник доверия —
 * RLS на таблице premium_messages (политика has_premium()); серверная проверка
 * premium здесь — это UI-gate + ранний выход, а не единственная защита.
 *
 * Доставка realtime: main подписывается на INSERT'ы таблицы и транслирует их во все
 * окна. Realtime применяет RLS к подключённому пользователю, поэтому строки получают
 * только premium-подписчики. Отправитель тоже видит своё сообщение через эту же
 * подписку (единый путь — без оптимистичного добавления и рассинхронизации).
 */

const MAX_MESSAGE_LEN = 2000
const HISTORY_LIMIT = 50
// Анти-спам на отправку: без него один premium-аккаунт может флудить общую комнату
// (см. consume_named_quota / usage_counters в schema.sql — тот же приём, что в ai.ts).
const SEND_BURST_LIMIT = 5
const SEND_BURST_WINDOW = '10 seconds'

export interface ChatMessage {
  id: string
  userId: string
  author: string
  text: string
  createdAt: string
}

interface DbChatRow {
  id: string
  user_id: string
  author: string | null
  text: string
  created_at: string
}

function toMessage(row: DbChatRow): ChatMessage {
  return {
    id: row.id,
    userId: row.user_id,
    author: row.author ?? 'Аноним',
    text: row.text,
    createdAt: row.created_at
  }
}

function broadcast(message: ChatMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chat:message', message)
  }
}

let channel: RealtimeChannel | null = null

/** Лениво поднимает realtime-подписку на новые сообщения (идемпотентно). */
function ensureChannel(): void {
  if (channel) return
  channel = supabase
    .channel('premium-chat')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'premium_messages' },
      (payload) => broadcast(toMessage(payload.new as DbChatRow))
    )
    .subscribe()
}

function teardownChannel(): void {
  if (channel) {
    try {
      supabase.removeChannel(channel)
    } catch {
      /* ignore */
    }
    channel = null
  }
}

let initialized = false

/**
 * Регистрирует IPC-каналы чата. Безопасно вызывать многократно.
 */
export function registerChatIpc(): void {
  if (initialized) return
  initialized = true

  // История последних сообщений + старт realtime-подписки. Доступно только premium.
  // См. rejectUntrustedSender в auth.ts registerAuthIpc — та же логика, тот же смысл.
  ipcMain.handle('chat:history', async (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    const state = await getState()
    if (!state.premium) {
      return { ok: false, error: 'Чат доступен только premium-подписчикам.' }
    }
    ensureChannel()

    const { data, error } = await supabase
      .from('premium_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
    if (error) return { ok: false, error: toSafeError(error, 'Не удалось загрузить чат.', '[Supabase] chat:history error') }

    const messages = ((data ?? []) as DbChatRow[]).map(toMessage).reverse()
    return { ok: true, messages }
  })

  // Отправка сообщения. Сервер ещё раз проверяет premium, длину и анти-спам лимит (RLS — основной гард).
  ipcMain.handle('chat:send', async (event, text: string) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    const state = await getState()
    if (!state.premium || !state.user) {
      return { ok: false, error: 'Чат доступен только premium-подписчикам.' }
    }

    const trimmed = String(text ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Пустое сообщение.' }
    if (trimmed.length > MAX_MESSAGE_LEN) {
      return { ok: false, error: 'Сообщение слишком длинное (макс. 2000 символов).' }
    }

    const { data: quota, error: quotaError } = await supabase.rpc('consume_named_quota', {
      p_counter_key: 'chat_send_burst',
      p_limit: SEND_BURST_LIMIT,
      p_period: SEND_BURST_WINDOW
    })
    if (quotaError || !quota?.[0]) {
      return { ok: false, error: toSafeError(quotaError, 'Не удалось отправить сообщение.', '[Supabase] chat:send quota error') }
    }
    if (!quota[0].allowed) {
      return { ok: false, error: 'Слишком много сообщений подряд, подождите немного.' }
    }

    const author = state.user.displayName ?? state.user.email ?? 'Аноним'
    const { error } = await supabase.from('premium_messages').insert({
      user_id: state.user.id,
      author,
      text: trimmed
    })
    if (error) return { ok: false, error: toSafeError(error, 'Не удалось отправить сообщение.', '[Supabase] chat:send error') }
    return { ok: true }
  })

  // Renderer закрыл чат/окно — отключаем подписку (best-effort).
  ipcMain.handle('chat:unsubscribe', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    teardownChannel()
    return { ok: true }
  })
}
