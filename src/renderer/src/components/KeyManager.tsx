import React, { useCallback, useEffect, useState } from 'react'
import type { PremiumCode } from '../types'
import { useI18n } from '../i18n'
import type { Language } from '../types'

// ─── Панель владельца: генерация и учёт премиум-ключей ────────────────────────
// Видна только владельцу (вкладка «Ключи» в App.tsx появляется при isOwner).
// Серверная защита — функции is_owner() в БД; здесь только удобный интерфейс.

function formatDate(iso: string | undefined, language: Language): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(language === 'en' ? 'en-US' : 'ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// Пресеты срока действия кода (в днях). Владелец выбирает при генерации.
const DURATION_OPTIONS = [7, 30, 90, 180, 365] as const

export default function KeyManager(): React.ReactElement {
  const { language, t } = useI18n()
  const [count, setCount]   = useState(10)
  const [days, setDays]     = useState(30)
  const [note, setNote]     = useState('')
  const [busy, setBusy]     = useState(false)
  const [codes, setCodes]   = useState<PremiumCode[]>([])
  const [fresh, setFresh]   = useState<string[]>([])         // только что сгенерированные
  const [error, setError]   = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const reload = useCallback(async () => {
    const res = await window.api.premium.list()
    if (res.ok && res.codes) setCodes(res.codes)
    else if (res.error) setError(res.error)
  }, [])

  useEffect(() => { reload() }, [reload])

  const generate = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setFresh([])
    try {
      const res = await window.api.premium.generate(count, note, days)
      if (res.ok && res.codes) {
        setFresh(res.codes)
        await reload()
      } else {
        setError(res.error ?? t('keys.generateError'))
      }
    } finally {
      setBusy(false)
    }
  }, [busy, count, days, note, reload, t])

  const copyFresh = useCallback(() => {
    if (!fresh.length) return
    navigator.clipboard.writeText(fresh.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }, [fresh])

  const total    = codes.length
  const used     = codes.filter((c) => c.redeemed).length
  const available = total - used

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[680px] mx-auto px-6 py-8 flex flex-col gap-5">

        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-txt-primary">{t('keys.title')}</h1>
          <p className="text-txt-muted text-sm mt-0.5">
            {t('keys.subtitle')}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: t('keys.total'), value: total },
            { label: t('keys.available'), value: available },
            { label: t('keys.activated'), value: used }
          ].map((s) => (
            <div key={s.label} className="card p-4 text-center">
              <div className="text-2xl font-bold text-txt-primary">{s.value}</div>
              <div className="text-xs text-txt-muted mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Generate */}
        <div className="card p-5 flex flex-col gap-4">
          <div className="text-xs font-semibold text-txt-muted uppercase tracking-wider">
            {t('keys.generate')}
          </div>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-txt-muted">{t('keys.count')}</label>
              <input
                type="number"
                min={1}
                max={200}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                disabled={busy}
                className="input-field w-24 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-txt-muted">{t('keys.duration')}</label>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                disabled={busy}
                className="select-field w-32 text-sm"
              >
                {DURATION_OPTIONS.map((d) => (
                  <option key={d} value={d} className="bg-app-card">
                    {t('keys.durationDays', { days: d })}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5 flex-1 min-w-[160px]">
              <label className="text-xs text-txt-muted">{t('keys.note')}</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('keys.notePlaceholder')}
                disabled={busy}
                className="input-field w-full text-sm"
              />
            </div>
            <button
              onClick={generate}
              disabled={busy}
              className="btn-primary text-sm px-5 py-2 no-drag disabled:opacity-40"
            >
              {busy ? t('keys.generating') : t('keys.create')}
            </button>
          </div>

          {error && (
            <div className="text-xs leading-relaxed" style={{ color: 'rgb(248 113 113)' }}>
              {error}
            </div>
          )}

          {/* Свежие коды — крупно, с копированием */}
          {fresh.length > 0 && (
            <div className="rounded-xl p-4" style={{ background: 'rgb(var(--ac) / 0.08)', border: '1px solid rgb(var(--ac) / 0.3)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold" style={{ color: 'rgb(var(--ac))' }}>
                  {t('keys.createdHint', { count: fresh.length })}
                </span>
                <button
                  onClick={copyFresh}
                  className="btn-ghost text-xs py-1 px-3 no-drag"
                >
                  {copied ? t('keys.copied') : t('keys.copyAll')}
                </button>
              </div>
              <div className="font-mono text-sm text-txt-primary leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap select-text">
                {fresh.join('\n')}
              </div>
            </div>
          )}
        </div>

        {/* Список всех кодов */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-semibold text-txt-muted uppercase tracking-wider">
              {t('keys.all')}
            </div>
            <button onClick={reload} className="btn-ghost text-xs py-1 px-3 no-drag">{t('common.refresh')}</button>
          </div>

          {codes.length === 0 ? (
            <div className="text-sm text-txt-muted py-6 text-center">{t('keys.empty')}</div>
          ) : (
            <div className="flex flex-col divide-y divide-app-border/40">
              {codes.map((c) => (
                <div key={c.code} className="flex items-center gap-3 py-2.5">
                  <span className="font-mono text-sm text-txt-primary select-text flex-1 min-w-0 truncate">
                    {c.code}
                  </span>
                  {c.note && <span className="text-xs text-txt-muted truncate max-w-[140px]">{c.note}</span>}
                  {c.durationDays && (
                    <span
                      className="text-2xs text-txt-muted flex-shrink-0 px-2 py-0.5 rounded-full border border-app-border/60"
                      title={t('keys.duration')}
                    >
                      {t('keys.durationDays', { days: c.durationDays })}
                    </span>
                  )}
                  {c.redeemed ? (
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span
                        className="text-2xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: 'rgb(120 120 130 / 0.18)', color: 'rgb(150 150 160)' }}
                      >
                        {t('common.redeemed', { date: formatDate(c.redeemedAt, language) })}
                      </span>
                      {c.redeemedBy && (
                        <span className="text-2xs text-txt-muted max-w-[180px] truncate">
                          Активирован: {c.redeemedBy}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span
                      className="text-2xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ background: 'rgb(var(--ac) / 0.18)', color: 'rgb(var(--ac))' }}
                    >
                      {t('common.free')}
                    </span>
                  )}
                  <button
                    onClick={() => { navigator.clipboard.writeText(c.code) }}
                    title={t('common.copy')}
                    className="text-txt-muted hover:text-txt-primary no-drag flex-shrink-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
