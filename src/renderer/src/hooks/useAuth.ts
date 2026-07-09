import { useCallback, useEffect, useState } from 'react'
import type { AuthState, UiAuthStatus } from '../types'

interface UseAuth {
  status: UiAuthStatus
  state: AuthState
  error: string | null
  busy: boolean
  /** Запустить вход через Discord (откроется браузер). */
  signInWithDiscord: () => Promise<void>
  /** Отменить ожидание подтверждения и вернуться к экрану входа. */
  cancelDiscord: () => Promise<void>
  signOut: () => Promise<void>
}

const SIGNED_OUT: AuthState = {
  status: 'signedOut', user: null, role: null, premium: false, premiumUntil: null, isOwner: false
}

export function useAuth(): UseAuth {
  const [state, setState] = useState<AuthState>(SIGNED_OUT)
  const [status, setStatus] = useState<UiAuthStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Восстановление сессии при старте + подписка на изменения из main.
  useEffect(() => {
    let active = true

    window.api.auth.getState().then((s) => {
      if (!active) return
      setState(s)
      setStatus(s.status)
    })

    const unsubscribe = window.api.auth.onChange((s) => {
      setState(s)
      // Пока идёт вход через Discord, игнорируем фоновые «signedOut», чтобы не сбросить
      // экран ожидания раньше времени.
      setStatus((prev) => (prev === 'connecting' && s.status === 'signedOut' ? prev : s.status))
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const signInWithDiscord = useCallback(async () => {
    setBusy(true)
    setError(null)
    setStatus('connecting')
    try {
      const res = await window.api.auth.signInWithDiscord()
      if (!res.ok) {
        // res.error пуст при отмене пользователем — тогда просто молча возвращаемся.
        if (res.error) setError(res.error)
        setStatus('signedOut')
        return
      }
      if (res.state) {
        setState(res.state)
        setStatus(res.state.status)
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const cancelDiscord = useCallback(async () => {
    await window.api.auth.cancelDiscord()
    setStatus('signedOut')
    setError(null)
    setBusy(false)
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.auth.signOut()
      setState(SIGNED_OUT)
      setStatus('signedOut')
      setError(null)
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    status,
    state,
    error,
    busy,
    signInWithDiscord,
    cancelDiscord,
    signOut
  }
}
