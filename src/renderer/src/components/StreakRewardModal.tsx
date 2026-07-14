import React, { useState } from 'react'
import { Download, Gift, Music, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import type { StreakRewardChoice, StreakRewardStage } from '../types'

interface Props {
  rewardStage: StreakRewardStage
  claimPending?: StreakRewardChoice | null
  onClaim: (choice: StreakRewardChoice) => Promise<{ ok: boolean; error?: string }>
  onClose: () => void
}

export function StreakRewardModal({
  rewardStage,
  claimPending,
  onClaim,
  onClose
}: Props): React.ReactElement {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState(false)
  const busy = !!claimPending || claimed

  useEscapeToClose(onClose, !busy)

  const choose = async (choice: StreakRewardChoice) => {
    if (busy) return
    setError(null)
    const res = await onClaim(choice)
    if (!res.ok) {
      setError(res.error ?? t('streak.claimError'))
      return
    }
    setClaimed(true)
    window.setTimeout(onClose, 650)
  }

  const options: Array<{
    key: StreakRewardChoice
    title: string
    desc: string
    icon: React.ReactElement
  }> = [
    { key: 'beat', title: t('streak.rewardBeat'), desc: t('streak.rewardBeatDesc'), icon: <Music size={18} /> },
    { key: 'download', title: t('streak.rewardDownload'), desc: t('streak.rewardDownloadDesc'), icon: <Download size={18} /> }
  ]

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center p-6 backdrop-blur-md bg-black/60"
      onClick={(e) => { e.stopPropagation(); if (!busy) onClose() }}
    >
      <div
        className="card relative w-full max-w-md p-5 animate-slide-up no-drag select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <Gift size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-txt-primary">{t('streak.rewardTitle')}</h2>
              {rewardStage > 0 && (
                <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-2xs font-bold text-accent">
                  {rewardStage}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-txt-muted">{t('streak.rewardSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            title={t('common.cancel')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-txt-muted hover:bg-app-border/50 hover:text-txt-primary disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          {options.map((option) => {
            const pending = claimPending === option.key
            return (
              <button
                key={option.key}
                type="button"
                disabled={busy}
                onClick={() => choose(option.key)}
                className="group flex w-full items-center gap-3 rounded-xl border border-app-border/70 bg-white/[0.03] p-3 text-left hover:border-accent/50 hover:bg-accent/8 disabled:opacity-60"
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent group-hover:bg-accent/15">
                  {pending ? <span className="h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" /> : option.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-txt-primary">{option.title}</span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-txt-muted">{option.desc}</span>
                </span>
                <span className="rounded-lg bg-accent/12 px-3 py-1.5 text-2xs font-semibold text-accent">
                  {t('streak.claim')}
                </span>
              </button>
            )
          })}
        </div>

        {(error || claimed) && (
          <div
            className={`mt-4 rounded-xl border px-3 py-2 text-xs ${
              claimed
                ? 'border-status-success/30 bg-status-success/10 text-status-success'
                : 'border-status-error/30 bg-status-error/10 text-status-error'
            }`}
          >
            {claimed ? t('streak.claimed') : error}
          </div>
        )}
      </div>
    </div>
  )
}
