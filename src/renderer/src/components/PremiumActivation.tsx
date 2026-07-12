import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import type { AuthState } from '../types'
import { ConfirmDialog } from './pluginCommon'

const PREMIUM_BUY_URL = 'https://t.me/soundcrimee'

function IconSpark(): React.ReactElement {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z" />
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  )
}

function userLabel(user: AuthState['user']): string {
  return user?.displayName || user?.email || user?.discordId || user?.id || 'user'
}

export default function PremiumActivation(): React.ReactElement {
  const { t } = useI18n()
  const [premium, setPremium] = useState(false)
  const [premiumUntil, setPremiumUntil] = useState<string | null>(null)
  const [user, setUser] = useState<AuthState['user']>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [justActivated, setJustActivated] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [activatedFor, setActivatedFor] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  const [cancellingRestore, setCancellingRestore] = useState(false)

  useEffect(() => {
    window.api.auth.getState().then((state: AuthState) => {
      setPremium(!!state.premium)
      setPremiumUntil(state.premiumUntil)
      setUser(state.user)
      if (state.premium) setActivatedFor(userLabel(state.user))
    })

    return window.api.auth.onChange((state: AuthState) => {
      setPremium(!!state.premium)
      setPremiumUntil(state.premiumUntil)
      setUser(state.user)
      if (state.premium) setActivatedFor(userLabel(state.user))
    })
  }, [])

  // «Восстановить студию»: тянем список установленных плагинов из облака и ставим их
  // по очереди в фоне (только премиум; сервер тоже проверяет права).
  const restoreStudio = useCallback(async () => {
    if (restoring) return
    setRestoring(true)
    setRestoreMsg(null)
    try {
      const res = await window.api.studio.restore()
      if (!res.ok) {
        setRestoreMsg(res.error ?? t('studio.error'))
        return
      }
      if (res.cancelled) {
        setRestoreMsg(t('studio.cancelled', { installed: res.installed ?? 0, total: res.total ?? 0 }))
        return
      }
      if ((res.total ?? 0) === 0) {
        setRestoreMsg(t('studio.empty'))
        return
      }
      const failed = res.failed?.length ?? 0
      setRestoreMsg(
        t('studio.done', { installed: res.installed ?? 0, total: res.total ?? 0 }) +
        (failed ? ` · ${t('studio.failed', { count: failed })}` : '')
      )
    } finally {
      setRestoring(false)
      setCancellingRestore(false)
    }
  }, [restoring, t])

  const cancelRestore = useCallback(() => {
    setCancellingRestore(true)
    window.api.studio.restoreCancel()
  }, [])

  useEffect(() => {
    if (!justActivated) return
    const timer = window.setTimeout(() => setJustActivated(false), 3600)
    return () => window.clearTimeout(timer)
  }, [justActivated])

  const activationLabel = useMemo(() => activatedFor || userLabel(user), [activatedFor, user])

  const redeem = useCallback(async () => {
    const value = code.trim()
    if (!value || busy) return

    setBusy(true)
    setMessage(null)

    try {
      const result = await window.api.auth.redeemPremium(value)
      if (!result.ok) {
        setMessage({ kind: 'err', text: result.error ?? t('premium.error') })
        return
      }

      const nextUser = result.state?.user ?? user
      setPremium(true)
      setUser(nextUser)
      setActivatedFor(userLabel(nextUser))
      setCode('')
      setJustActivated(true)
      setMessage({ kind: 'ok', text: t('premium.success') })
    } finally {
      setBusy(false)
    }
  }, [busy, code, t, user])

  return (
    <div
      className={[
        'card p-5',
        premium ? 'border-yellow-300/40' : '',
        justActivated ? 'premium-activation-pop' : ''
      ].join(' ')}
      aria-live="polite"
    >
      {justActivated && (
        <div className="pointer-events-none absolute inset-0 premium-activation-shine" />
      )}

      <div className="flex items-start gap-3">
          <div
            className={[
              'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl',
              premium
                ? 'bg-yellow-300/15 text-yellow-200 shadow-[0_0_24px_rgba(250,204,21,.22)]'
                : 'bg-accent/10 text-accent'
            ].join(' ')}
          >
            <IconSpark />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-txt-primary">{t('premium.title')}</h2>
              {premium && (
                <span className="rounded-full border border-yellow-300/40 bg-yellow-300/15 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-yellow-200">
                  {t('premium.active')}
                </span>
              )}
            </div>

            <p className="mt-1 text-xs leading-relaxed text-txt-muted">
              {premium ? t('premium.enabled') : t('premium.disabled')}
            </p>

            {premium && (
              <div className="mt-3 rounded-xl border border-yellow-300/20 bg-yellow-300/8 px-3 py-2">
                <div className="text-xs font-semibold text-yellow-200">
                  {justActivated ? t('premium.activationTitle') : t('premium.active')}
                </div>
                <div className="mt-0.5 text-2xs text-txt-secondary">
                  {t('premium.activatedFor', { user: activationLabel })}
                </div>
                {premiumUntil && (
                  <div className="mt-0.5 text-2xs text-txt-muted">
                    {t('premium.validUntil', {
                      date: new Date(premiumUntil).toLocaleDateString()
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Облачная студия — «Студия в один клик». Только для премиума. */}
            {premium && (
              <div className="mt-3 rounded-xl border border-app-border/60 bg-app-panel/40 px-3 py-2.5">
                <div className="text-xs font-semibold text-txt-primary">{t('studio.title')}</div>
                <p className="mt-0.5 text-2xs text-txt-muted leading-relaxed">{t('studio.desc')}</p>
                {restoring ? (
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="btn-primary flex-1 py-2 text-xs opacity-50 flex items-center justify-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      {t('studio.restoring')}
                    </div>
                    <button
                      onClick={cancelRestore}
                      disabled={cancellingRestore}
                      className="btn-ghost flex-shrink-0 px-3 py-2 text-xs disabled:opacity-50"
                    >
                      {cancellingRestore ? t('studio.cancelling') : t('studio.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingRestore(true)}
                    className="btn-primary mt-2.5 w-full py-2 text-xs"
                  >
                    {t('studio.restore')}
                  </button>
                )}
                {restoreMsg && (
                  <div className="mt-2 text-2xs text-txt-secondary leading-relaxed">{restoreMsg}</div>
                )}
                {confirmingRestore && (
                  <ConfirmDialog
                    title={t('studio.restoreConfirmTitle')}
                    body={t('studio.restoreConfirmBody')}
                    onConfirm={() => { setConfirmingRestore(false); restoreStudio() }}
                    onCancel={() => setConfirmingRestore(false)}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {!premium && (
          <div className="mt-4 flex flex-col gap-3">
            <button
              onClick={() => window.api.openExternal(PREMIUM_BUY_URL)}
              className="btn-primary w-full py-2 text-sm"
            >
              {t('premium.buy')}
            </button>

            <div className="flex items-center gap-2 text-2xs text-txt-muted">
              <div className="h-px flex-1 bg-app-border/50" />
              {t('premium.haveCode')}
              <div className="h-px flex-1 bg-app-border/50" />
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') redeem() }}
                placeholder={t('premium.placeholder')}
                spellCheck={false}
                disabled={busy}
                className="input-field flex-1 font-mono text-sm tracking-wider"
              />
              <button
                onClick={redeem}
                disabled={busy || !code.trim()}
                className="btn-ghost flex-shrink-0 px-4 disabled:opacity-40"
              >
                {busy ? t('premium.checking') : t('premium.activate')}
              </button>
            </div>
          </div>
        )}

        {message && (
          <div
            className="mt-3 text-xs leading-relaxed"
            style={{ color: message.kind === 'ok' ? 'rgb(250 204 21)' : 'rgb(248 113 113)' }}
          >
            {message.text}
          </div>
        )}
    </div>
  )
}
