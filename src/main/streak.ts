import { ipcMain } from 'electron'
import { supabase } from './supabase'
import { rejectUntrustedSender } from './ipc-security'
import { toSafeError } from './errors'

/**
 * Streak: подряд идущие дни входа. На 3, 7, и 28-й день входа доступна награда.
 * Всю серверную логику — инкремент counter, вычисление reward_stage — берёт на себя
 * RPC функция touch_streak() в Supabase. Здесь — тонкие обёртки над RPC и трансляция
 * результатов в понятные rendererу типы.
 */

// ─── Wire-типы (зеркалятся в preload/index.ts) ────────────────────────────────
// Формат ответов совпадает с StreakTouchResult/StreakClaimResult в preload и в
// renderer/types.ts — renderer уже читает поля ok/streakCount/rewardPending/rewardStage.

export interface StreakState {
  ok: boolean
  error?: string
  streakCount?: number
  rewardPending?: boolean
  rewardStage?: number
}

export interface ClaimRewardResult {
  ok: boolean
  error?: string
  streakCount?: number
}

// ─── Операции ─────────────────────────────────────────────────────────────────

function rpcRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined
}

/**
 * Регистрирует или обновляет touch-отметку для текущего дня. Возвращает
 * текущий счётчик streak'а, признак доступной награды и stage (3, 7, 28 или 0).
 */
export async function touchStreak(): Promise<StreakState> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) {
    return { ok: false, error: 'Войдите, чтобы обновить стрик.' }
  }

  try {
    const { data, error } = await supabase.rpc('touch_streak')
    if (error) throw error
    const row = rpcRow<{
      streak_count: number
      reward_pending: boolean
      reward_stage: number
    }>(data)
    return {
      ok: true,
      streakCount: row?.streak_count ?? 0,
      rewardPending: !!row?.reward_pending,
      rewardStage: row?.reward_stage ?? 0
    }
  } catch (e) {
    return {
      ok: false,
      error: toSafeError(e, 'Не удалось обновить стрик.', '[Supabase] streak:touch error')
    }
  }
}

/**
 * Требует выбор награды (choice должен быть 'beat' или 'download') и списывает
 * доступную награду со счёта пользователя. Возвращает новый счётчик streak'а.
 */
export async function claimReward(choice: string): Promise<ClaimRewardResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) {
    return { ok: false, error: 'Войдите, чтобы получить награду.' }
  }

  const trimmed = (choice ?? '').trim().toLowerCase()
  if (!['beat', 'download'].includes(trimmed)) {
    return { ok: false, error: 'Неверный выбор награды (beat|download).' }
  }

  try {
    const { data, error } = await supabase.rpc('claim_streak_reward', { p_choice: trimmed })
    if (error) {
      const msg = error.message ?? ''
      if (msg.includes('no_reward')) {
        return { ok: false, error: 'Награда недоступна. Пополните счёт входов.' }
      }
      throw error
    }
    const row = rpcRow<{ streak_count: number }>(data)
    return { ok: true, streakCount: row?.streak_count ?? 0 }
  } catch (e) {
    return {
      ok: false,
      error: toSafeError(e, 'Не удалось получить награду.', '[Supabase] streak:claim error')
    }
  }
}

// ─── IPC ────────────────────────────────────────────────────────────────────────

let ipcInitialized = false

/**
 * Регистрирует IPC-каналы streak-системы. Безопасно вызывать многократно.
 */
export function registerStreakIpc(): void {
  if (ipcInitialized) return
  ipcInitialized = true

  ipcMain.handle('streak:touch', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return touchStreak()
  })

  ipcMain.handle('streak:claim', (event, choice: string) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return claimReward(choice)
  })
}