import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
import { sessionStore } from './sessionStore'

export const SUPABASE_URL = 'https://akcdjxzhdesjlrqdybbo.supabase.co'
const SUPABASE_KEY = 'sb_publishable_RnkwIAwIC05YXskzzizzyA_yuEpAlxe'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    // Сессия шифруется системным ключом ОС и хранится на диске (см. sessionStore).
    storage: sessionStore,
    storageKey: 'vst3-manager-auth',
    persistSession: true,
    autoRefreshToken: true,
    // Десктоп-приложение, а не браузер — токенов в URL нет.
    detectSessionInUrl: false,
    // PKCE-поток для OAuth (Discord): supabase-js кладёт code-verifier в storage при
    // signInWithOAuth и забирает его в exchangeCodeForSession после возврата из браузера.
    flowType: 'pkce'
  },
  realtime: {
    // Node-реализация ws структурно совместима, но её типы (ErrorEvent) расходятся
    // с DOM-типами WebSocket — приводим к ожидаемому Supabase конструктору.
    transport: ws as unknown as import('@supabase/realtime-js').WebSocketLikeConstructor
  }
})

export type UserRole = 'user' | 'author'

export interface DbPlugin {
  id: string
  name: string
  author: string
  version: string
  description: string
  category: string
  size?: string
  download_url: string
  icon_url?: string
}

export interface DbProfile {
  id: string
  email: string | null
  display_name: string | null
  role: UserRole
  /** Срок действия премиума (ISO). null — премиума нет. */
  premium_until?: string | null
}

/** Пользовательский плагин из community-маркетплейса (таблица community_plugins). */
export interface DbCommunityPlugin {
  id: string
  name: string
  author: string | null
  version: string | null
  description: string | null
  category: string | null
  size?: string | null
  download_url: string
  icon_url?: string | null
  tags?: string[] | null
  uploader_id?: string | null
  downloads?: number
  likes?: number
  created_at?: string
  /** Тип контента: 'plugin' (по умолчанию) | 'flp' | 'template' | 'loop' | 'drumkit' | 'beat'. */
  kind?: string | null
  /** Цена платного контента (битов), напр. «20$». */
  price?: string | null
  /** Цена бита в центах (для валидации диапазона $2–$15 у free-авторов). */
  price_cents?: number | null
  /** Снимок статуса премиума автора на момент публикации (галочка + bump). */
  author_is_premium?: boolean | null
  /** Ссылка для оплаты. */
  payment_url?: string | null
  /** Пресеты: готовый аудиоклип «с эффектами» для живого A/B-сравнения. */
  preview_wet_url?: string | null
  /** Пресеты: готовый аудиоклип «без эффектов» для живого A/B-сравнения. */
  preview_dry_url?: string | null
}
