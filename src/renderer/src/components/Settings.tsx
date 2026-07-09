import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { AppSettings, Language } from '../types'
import { useI18n } from '../i18n'
import { applyTheme, THEMES } from '../utils/theme'
import { Toggle } from './Toggle'

const DEFAULT_PATHS: Record<string, string> = {
  Windows: 'C:\\Program Files\\Common Files\\VST3',
  macOS:   '/Library/Audio/Plug-Ins/VST3',
  Linux:   '~/.vst3'
}

// ─── Section icons ─────────────────────────────────────────────────────────────

const IconPalette = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="13.5" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="7.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="12.5" r="1.3" fill="currentColor" stroke="none" />
    <path d="M12 2a10 10 0 0 0 0 20c1.7 0 2.5-1.3 2-2.7-.4-1.3.5-2.3 1.8-2.3H18a4 4 0 0 0 4-4c0-5.5-4.5-9-10-9z" />
  </svg>
)

const IconFolder = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

const IconRefresh = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <polyline points="21 3 21 9 15 9" />
  </svg>
)

const IconInfo = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="12" cy="12" r="9.5" />
    <line x1="12" y1="11" x2="12" y2="16.5" />
    <circle cx="12" cy="7.6" r="0.6" fill="currentColor" stroke="currentColor" />
  </svg>
)

// ─── Segmented ─────────────────────────────────────────────────────────────────

function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: React.ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div
      className="inline-flex gap-1 p-1 rounded-xl no-drag"
      style={{
        background: 'rgb(var(--panel) / 0.7)',
        border: '1px solid rgb(var(--bdr) / 0.7)',
        boxShadow: 'inset 0 1px 2px rgb(0 0 0 / 0.18)'
      }}
    >
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold no-drag ${
              active ? '' : 'text-txt-muted hover:text-txt-primary'
            }`}
            style={{
              color: active ? 'rgb(var(--btn-primary-text))' : undefined,
              background: active
                ? 'linear-gradient(180deg, rgb(var(--ac-h)), rgb(var(--ac)))'
                : 'transparent',
              boxShadow: active
                ? 'inset 0 1px 0 rgb(255 255 255 / 0.4), 0 2px 8px rgb(0 0 0 / 0.28)'
                : 'none',
              transition: 'background 150ms ease, color 120ms ease, box-shadow 150ms ease'
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function Row({ label, description, children }: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5 first:pt-0.5 last:pb-0.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-txt-primary">{label}</div>
        {description && <div className="text-xs text-txt-muted mt-0.5 leading-relaxed">{description}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ icon, title, children }: {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2.5 mb-4">
        {icon && (
          <span
            className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
            style={{
              background: 'rgb(var(--ac) / 0.1)',
              color: 'rgb(var(--ac))',
              border: '1px solid rgb(var(--ac) / 0.16)'
            }}
          >
            {icon}
          </span>
        )}
        <span className="text-[13px] font-semibold text-txt-primary tracking-wide">{title}</span>
      </div>
      <div className="divide-y divide-app-border/40">
        {children}
      </div>
    </div>
  )
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export default function Settings() {
  const { language, setLanguage, t } = useI18n()
  const [settings, setSettings]     = useState<AppSettings | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const settingsRef = useRef<AppSettings | null>(null)
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleRef     = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      const next = { ...s, language: s.language ?? 'ru' }
      setSettings(next)
      settingsRef.current = next
    })
  }, [])

  // Чистим отложенные таймеры при размонтировании, чтобы не было setState после unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (idleRef.current) clearTimeout(idleRef.current)
    }
  }, [])

  const ua     = window.navigator.userAgent
  const osHint = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : 'Linux'

  const triggerSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      if (!settingsRef.current) return
      setSaveStatus('saving')
      await window.api.saveSettings(settingsRef.current)
      setSaveStatus('saved')
      if (idleRef.current) clearTimeout(idleRef.current)
      idleRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
    }, 700)
  }, [])

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => {
      const next = prev ? { ...prev, [key]: value } : prev
      settingsRef.current = next
      return next
    })
    triggerSave()
  }, [triggerSave])

  const handleThemeChange = useCallback((theme: string) => {
    update('theme', theme)
    applyTheme(theme)
  }, [update])

  const handleLanguageChange = useCallback((next: Language) => {
    update('language', next)
    setLanguage(next)
  }, [update, setLanguage])

  if (!settings) {
    return (
      <div className="h-full flex items-center justify-center gap-3 text-txt-secondary">
        <div className="w-4 h-4 border-2 border-app-border border-t-accent rounded-full animate-spin" />
        <span className="text-sm">{t('settings.loading')}</span>
      </div>
    )
  }

  const selectedLanguage = settings.language ?? language

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[600px] mx-auto px-6 py-8 flex flex-col gap-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <h1 className="text-xl font-bold text-txt-primary">{t('settings.title')}</h1>
            <p className="text-txt-muted text-sm mt-0.5">{t('settings.subtitle')}</p>
          </div>
          <div
            className="flex items-center gap-1.5 text-xs pt-1"
            style={{
              opacity: saveStatus === 'idle' ? 0 : 1,
              transition: 'opacity 250ms ease'
            }}
          >
            {saveStatus === 'saving' ? (
              <span className="text-txt-muted flex items-center gap-1.5">
                <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                {t('common.saving')}
              </span>
            ) : (
              <span className="text-status-success flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {t('common.saved')}
              </span>
            )}
          </div>
        </div>

        {/* Appearance */}
        <Section icon={<IconPalette />} title={t('settings.appearance')}>
          <Row label={t('settings.language')} description={t('settings.languageDesc')}>
            <Segmented<Language>
              value={selectedLanguage}
              onChange={handleLanguageChange}
              options={[
                { value: 'ru', label: t('settings.langRu') },
                { value: 'en', label: t('settings.langEn') }
              ]}
            />
          </Row>
          <Row label={t('settings.theme')} description={t(`theme.${settings.theme ?? 'carbon'}Desc`)}>
            <Segmented<string>
              value={settings.theme ?? 'carbon'}
              onChange={handleThemeChange}
              options={THEMES.map((theme) => ({
                value: theme.id,
                label: (
                  <>
                    <span
                      className="w-3 h-3 rounded-full border"
                      style={{
                        background: theme.id === 'carbon' ? '#0b0c0f' : '#f8fafc',
                        borderColor: (settings.theme ?? 'carbon') === theme.id
                          ? 'currentColor'
                          : 'rgb(var(--bdr-a) / 0.55)'
                      }}
                    />
                    {t(`theme.${theme.id}`)}
                  </>
                )
              }))}
            />
          </Row>
        </Section>

        {/* Paths */}
        <Section icon={<IconFolder />} title={t('settings.paths')}>
          <div className="py-3.5">
            <label className="block text-sm font-medium text-txt-primary mb-2.5">{t('settings.vst3Folder')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={settings.vst3Path}
                onChange={(e) => update('vst3Path', e.target.value)}
                className="input-field flex-1 font-mono text-xs"
                spellCheck={false}
              />
              <button onClick={async () => {
                const path = await window.api.selectFolder()
                if (path) update('vst3Path', path)
              }} className="btn-ghost flex-shrink-0 px-3">
                {t('settings.browse')}
              </button>
              <button
                onClick={() => settings.vst3Path && window.api.openPath(settings.vst3Path)}
                className="btn-ghost flex-shrink-0 px-3"
                title={t('settings.openFolder')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            </div>
            <p className="text-xs text-txt-muted mt-2">
              {t('settings.defaultPath', { os: osHint })}{' '}
              <button
                className="text-accent hover:text-accent-hover no-drag"
                onClick={() => update('vst3Path', DEFAULT_PATHS[osHint] ?? DEFAULT_PATHS['Windows'])}
              >
                {DEFAULT_PATHS[osHint] ?? DEFAULT_PATHS['Windows']}
              </button>
            </p>
          </div>
        </Section>

        {/* Updates */}
        <Section icon={<IconRefresh />} title={t('settings.updates')}>
          <Row label={t('settings.autoUpdates')} description={t('settings.autoUpdatesDesc')}>
            <Toggle value={settings.autoUpdate} onChange={(v) => update('autoUpdate', v)} />
          </Row>
          <Row label={t('settings.checkOnStart')} description={t('settings.checkOnStartDesc')}>
            <Toggle value={settings.checkUpdateOnStart} onChange={(v) => update('checkUpdateOnStart', v)} />
          </Row>
        </Section>

        {/* About */}
        <Section icon={<IconInfo />} title={t('settings.about')}>
          <Row label={t('settings.version')}>
            <span className="text-sm text-txt-secondary font-mono">1.0.0</span>
          </Row>
          <Row label={t('settings.license')}>
            <span className="text-sm text-txt-secondary">MIT</span>
          </Row>
        </Section>

      </div>
    </div>
  )
}
