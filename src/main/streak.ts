import { ipcMain } from 'electron'
import { supabase } from './supabase'
import { rejectUntrustedSender } from './ipc-security'
import { toSafeError } from './errors'

export type StreakRewardChoice = 'beat' | 'download'
export type StreakRewardStage = 0 | 3 | 7 | 28

export interface StreakTouchResult {
  ok: boolean
  error?: string
  streakCount?: number
  rewardPending?: boolean
  rewardStage?: StreakRewardStage
}

export interface StreakClaimResult {
  ok: boolean
  error?: string
  streakCount?: number
}

function rpcRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined
}

function normalizeStage(value: unknown): StreakRewardStage {
  return value === 3 || value === 7 || value === 28 ? value : 0
}

export async function touchStreak(): Promise<StreakTouchResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Войдите, чтобы вести стрик.' }

  try {
    const { data, error } = await supabase.rpc('touch_streak')
    if (error) throw error
    const row = rpcRow<{ streak_count: number; reward_pending: boolean; reward_stage: number }>(data)
    return {
      ok: true,
      streakCount: row?.streak_count ?? 0,
      rewardPending: !!row?.reward_pending,
      rewardStage: normalizeStage(row?.reward_stage)
    }
  } catch (e) {
    return { ok: false, error: toSafeError(e, 'Не удалось обновить стрик.', '[Supabase] streak:touch error') }
  }
}

export async function claimStreakReward(choice: StreakRewardChoice): Promise<StreakClaimResult> {
  const { data: sess } = await supabase.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Войдите, чтобы забрать награду.' }
  if (choice !== 'beat' && choice !== 'download') return { ok: false, error: 'Неизвестная награда.' }

  try {
    const { data, error } = await supabase.rpc('claim_streak_reward', { p_choice: choice })
    if (error) throw error
    const row = rpcRow<{ streak_count: number }>(data)
    return { ok: true, streakCount: row?.streak_count ?? 0 }
  } catch (e) {
    return { ok: false, error: toSafeError(e, 'Не удалось забрать награду.', '[Supabase] streak:claim error') }
  }
}

let ipcInitialized = false

export function registerStreakIpc(): void {
  if (ipcInitialized) return
  ipcInitialized = true

  ipcMain.handle('streak:touch', (event) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return touchStreak()
  })

  ipcMain.handle('streak:claim', (event, choice: StreakRewardChoice) => {
    const blocked = rejectUntrustedSender(event)
    if (blocked) return blocked
    return claimStreakReward(choice)
  })
}
