import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreakRewardChoice, StreakRewardStage, UiAuthStatus } from '../types'

interface UseStreak {
  streakCount: number
  rewardPending: boolean
  rewardStage: StreakRewardStage
  loading: boolean
  error: string | null
  claimPending: StreakRewardChoice | null
  claim: (choice: StreakRewardChoice) => Promise<{ ok: boolean; error?: string }>
}

export function useStreak(status: UiAuthStatus): UseStreak {
  const [streakCount, setStreakCount] = useState(0)
  const [rewardPending, setRewardPending] = useState(false)
  const [rewardStage, setRewardStage] = useState<StreakRewardStage>(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimPending, setClaimPending] = useState<StreakRewardChoice | null>(null)
  const touchedRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    if (status !== 'signedIn') {
      touchedRef.current = false
      setStreakCount(0)
      setRewardPending(false)
      setRewardStage(0)
      setLoading(false)
      setError(null)
      return () => { cancelled = true }
    }

    if (touchedRef.current) return () => { cancelled = true }
    touchedRef.current = true
    setLoading(true)
    setError(null)

    window.api.streak.touch().then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setError(res.error ?? 'Не удалось обновить стрик.')
        return
      }
      setStreakCount(res.streakCount ?? 0)
      setRewardPending(!!res.rewardPending)
      setRewardStage(res.rewardStage ?? 0)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [status])

  const claim = useCallback(async (choice: StreakRewardChoice) => {
    setClaimPending(choice)
    setError(null)
    try {
      const res = await window.api.streak.claim(choice)
      if (!res.ok) {
        const message = res.error ?? 'Не удалось забрать награду.'
        setError(message)
        return { ok: false, error: message }
      }
      setStreakCount(res.streakCount ?? streakCount)
      setRewardPending(false)
      setRewardStage(0)
      return { ok: true }
    } finally {
      setClaimPending(null)
    }
  }, [streakCount])

  return { streakCount, rewardPending, rewardStage, loading, error, claimPending, claim }
}
