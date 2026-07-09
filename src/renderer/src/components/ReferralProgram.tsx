import React, { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type { AuthState, ReferralStats } from '../types'

/**
 * Карточка реферальной программы: личный код, статистика приглашений, активация
 * чужого кода и получение наград. Вся анти-абуз логика (возраст Discord-аккаунта,
 * отпечаток устройства) — на сервере (см. supabase/schema.sql); здесь только
 * отображение и вызовы IPC referral:*.
 */

function IconGift(): React.ReactElement {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="8" width="18" height="13" rx="1.5" />
      <path d="M3 12h18" />
      <path d="M12 8v13" />
      <path d="M12 8c-1.4 0-3-1-3-2.8A2.2 2.2 0 0 1 11.2 3C13 3 12 6 12 8z" />
      <path d="M12 8c1.4 0 3-1 3-2.8A2.2 2.2 0 0 0 12.8 3C11 3 12 6 12 8z" />
    </svg>
  )
}

function IconCopy(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

function IconLink(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M9 15 15 9" />
      <path d="M11 5 12.5 3.5a3.5 3.5 0 0 1 5 5L16 10" />
      <path d="M13 19 11.5 20.5a3.5 3.5 0 0 1-5-5L8 14" />
    </svg>
  )
}

export interface ReferralProgramProps {
  /** Результат авто-активации по ссылке-приглашению (см. App.tsx) — показывается один раз. */
  externalMessage?: { kind: 'ok' | 'err'; text: string } | null
  onExternalMessageConsumed?: () => void
}

export default function ReferralProgram({
  externalMessage,
  onExternalMessageConsumed
}: ReferralProgramProps = {}): React.ReactElement | null {
  const { t } = useI18n()
  const [signedIn, setSignedIn] = useState(false)
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [redeeming, setRedeeming] = useState(false)
  const [copied, setCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    const res = await window.api.referral.stats()
    setStats(res)
    setLoading(false)
  }, [])

  useEffect(() => {
    window.api.auth.getState().then((state: AuthState) => {
      setSignedIn(state.status === 'signedIn')
      if (state.status === 'signedIn') load()
      else setLoading(false)
    })

    return window.api.auth.onChange((state: AuthState) => {
      setSignedIn(state.status === 'signedIn')
      if (state.status === 'signedIn') load()
    })
  }, [load])

  // Результат авто-активации по ссылке (App.tsx переключает сюда вкладку и передаёт его
  // пропом) — показываем в уже существующем блоке message и обновляем статистику.
  useEffect(() => {
    if (!externalMessage) return
    setMessage(externalMessage)
    load()
    onExternalMessageConsumed?.()
    // onExternalMessageConsumed сознательно не в зависимостях: он пересоздаётся в App.tsx
    // на каждый рендер, а нам нужно сработать ровно один раз на каждое новое сообщение.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalMessage, load])

  const copyCode = useCallback(() => {
    if (!stats?.code) return
    navigator.clipboard.writeText(stats.code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }, [stats?.code])

  const copyLink = useCallback(() => {
    if (!stats?.inviteLink) return
    navigator.clipboard.writeText(stats.inviteLink)
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 1800)
  }, [stats?.inviteLink])

  const claim = useCallback(async () => {
    const value = code.trim()
    if (!value || claiming) return
    setClaiming(true)
    setMessage(null)
    try {
      const res = await window.api.referral.claim(value)
      if (!res.ok) {
        setMessage({ kind: 'err', text: res.error ?? t('premium.error') })
        return
      }
      setCode('')
      setMessage({ kind: 'ok', text: t('referral.claimSuccess') })
      await load()
    } finally {
      setClaiming(false)
    }
  }, [claiming, code, load, t])

  const redeem = useCallback(async () => {
    if (redeeming) return
    setRedeeming(true)
    setMessage(null)
    try {
      const res = await window.api.referral.redeem()
      if (!res.ok) {
        setMessage({ kind: 'err', text: res.error ?? t('referral.redeemNone') })
        return
      }
      setMessage({ kind: 'ok', text: t('referral.redeemSuccess', { days: res.grantedDays ?? 0 }) })
      await load()
    } finally {
      setRedeeming(false)
    }
  }, [load, redeeming, t])

  if (!signedIn || loading || !stats?.ok) return null

  const perReward = stats.perReward ?? 5
  const rewardDays = stats.rewardDays ?? 14
  const qualified = stats.qualified ?? 0
  const rewardsAvailable = stats.rewardsAvailable ?? 0
  const progressInBlock = qualified % perReward

  return (
    <div className="relative overflow-hidden rounded-2xl p-[1px] bg-app-border/60">
      <div className="relative rounded-2xl bg-app-card/95 p-5 backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <IconGift />
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-txt-primary">{t('referral.title')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-txt-muted">
              {t('referral.desc', { perReward, rewardDays })}
            </p>

            {/* Личный код */}
            {stats.code && (
              <div className="mt-3 flex items-center gap-2">
                <div className="flex-1 rounded-xl border border-app-border/60 bg-app-panel/40 px-3 py-2 font-mono text-sm tracking-wider text-txt-primary">
                  {stats.code}
                </div>
                <button onClick={copyCode} className="btn-ghost flex-shrink-0 px-3 py-2 text-xs">
                  <IconCopy />
                  {copied ? t('referral.copied') : t('referral.copy')}
                </button>
              </div>
            )}

            {/* Ссылка-приглашение — та же активация, что и код, но открывает приложение сама */}
            {stats.inviteLink && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 truncate rounded-xl border border-app-border/60 bg-app-panel/40 px-3 py-2 text-xs text-txt-muted">
                  {stats.inviteLink}
                </div>
                <button onClick={copyLink} className="btn-ghost flex-shrink-0 px-3 py-2 text-xs">
                  <IconLink />
                  {linkCopied ? t('referral.copied') : t('referral.copyLink')}
                </button>
              </div>
            )}

            {/* Статистика */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-app-border/60 bg-app-panel/40 px-3 py-2">
                <div className="text-lg font-semibold text-txt-primary">{stats.invited ?? 0}</div>
                <div className="text-[11px] text-txt-muted">{t('referral.invited')}</div>
              </div>
              <div className="rounded-xl border border-app-border/60 bg-app-panel/40 px-3 py-2">
                <div className="text-lg font-semibold text-txt-primary">{qualified}</div>
                <div className="text-[11px] text-txt-muted">{t('referral.qualified')}</div>
              </div>
            </div>

            {/* Прогресс до следующей награды */}
            {rewardsAvailable === 0 && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px] text-txt-muted">
                  <span>{t('referral.progressToNext', { have: progressInBlock, need: perReward })}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-app-panel/60">
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${(progressInBlock / perReward) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Награда доступна */}
            {rewardsAvailable > 0 && (
              <div className="mt-3 rounded-xl border border-yellow-300/20 bg-yellow-300/8 px-3 py-2.5">
                <div className="text-xs font-semibold text-yellow-200">
                  {t('referral.rewardsAvailable', { count: rewardsAvailable })}
                </div>
                <button
                  onClick={redeem}
                  disabled={redeeming}
                  className="btn-primary mt-2 w-full py-2 text-xs disabled:opacity-50"
                >
                  {redeeming ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      {t('referral.redeeming')}
                    </>
                  ) : t('referral.redeem')}
                </button>
              </div>
            )}

            {/* Активировать код друга */}
            {!stats.referred && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[11px] text-txt-muted">
                  <div className="h-px flex-1 bg-app-border/50" />
                  {t('referral.haveCode')}
                  <div className="h-px flex-1 bg-app-border/50" />
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter') claim() }}
                    placeholder={t('referral.placeholder')}
                    spellCheck={false}
                    disabled={claiming}
                    className="input-field flex-1 font-mono text-sm tracking-wider"
                  />
                  <button
                    onClick={claim}
                    disabled={claiming || !code.trim()}
                    className="btn-ghost flex-shrink-0 px-4 disabled:opacity-40"
                  >
                    {claiming ? t('referral.activating') : t('referral.activate')}
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

            <p className="mt-3 text-[10px] leading-relaxed text-txt-muted/80">
              {t('referral.antiAbuseNote')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
