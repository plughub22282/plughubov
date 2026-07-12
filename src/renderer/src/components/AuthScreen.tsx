import React from 'react'
import type { UiAuthStatus } from '../types'
import { useI18n } from '../i18n'

const DiscordIcon = (): React.ReactElement => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.2.36-.43.84-.59 1.225a18.27 18.27 0 0 0-5.937 0A11.6 11.6 0 0 0 9.44 3a19.74 19.74 0 0 0-3.76 1.37C2.07 9.71 1.34 14.91 1.7 20.04A19.94 19.94 0 0 0 7.77 23c.49-.67.93-1.39 1.31-2.14-.72-.27-1.41-.6-2.06-.99.17-.13.34-.26.5-.4 3.96 1.85 8.23 1.85 12.14 0 .17.14.34.27.5.4-.65.39-1.35.72-2.07.99.38.75.82 1.47 1.31 2.14a19.9 19.9 0 0 0 6.07-2.96c.42-5.95-.72-11.1-3.99-15.67ZM8.52 16.91c-1.18 0-2.15-1.09-2.15-2.42 0-1.34.95-2.42 2.15-2.42 1.21 0 2.18 1.09 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Zm6.96 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.34.95-2.42 2.15-2.42 1.21 0 2.18 1.09 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z" />
  </svg>
)

export default function AuthScreen({
  status,
  error,
  busy,
  signInWithDiscord,
  cancelDiscord
}: {
  status:            UiAuthStatus
  error:             string | null
  busy:              boolean
  signInWithDiscord: () => Promise<void>
  cancelDiscord:     () => Promise<void>
}): React.ReactElement {
  const { t } = useI18n()
  const connecting = status === 'connecting'

  return (
    <div
      className="flex flex-col h-full text-txt-primary overflow-hidden relative"
      style={{ backgroundColor: 'rgb(var(--bg))', backgroundImage: 'var(--app-gradient)' }}
    >
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'var(--auth-glow)' }} />

      {/* Drag region */}
      <div className="drag-region h-9 flex-shrink-0 relative z-10" />

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-6 pb-10 relative z-10">
        <div className="w-full max-w-[300px] animate-slide-up">

          {/* Logo */}
          <div className="flex flex-col items-center mb-8 select-none">
            <div className="mb-5">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-white"
                style={{
                  background: 'linear-gradient(135deg, rgb(var(--ac)), rgb(var(--ac-h)))',
                  boxShadow: '0 8px 24px rgb(var(--ac) / 0.35)'
                }}
              >
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-txt-primary">PlugHub</h1>
            <p className="text-sm text-txt-secondary mt-1.5">
              {connecting ? t('auth.waiting') : t('auth.subtitle')}
            </p>
          </div>

          {/* Card */}
          <div className="card p-6">
            {connecting ? (
              <div className="flex flex-col items-center gap-5 py-2">
                {/* Spinner ring */}
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center"
                  style={{ border: '1.5px solid rgb(var(--bdr))' }}
                >
                  <div
                    className="w-6 h-6 rounded-full"
                    style={{
                      border: '2px solid rgb(var(--bdr))',
                      borderTopColor: 'rgb(var(--ac))',
                      animation: 'spin 0.9s linear infinite'
                    }}
                  />
                </div>

                <div className="text-center">
                  <p className="text-sm font-medium text-txt-primary">{t('auth.browserOpen')}</p>
                  <p className="text-xs text-txt-muted mt-1.5 leading-relaxed">
                    {t('auth.browserHint')}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={cancelDiscord}
                  className="text-xs text-txt-muted hover:text-txt-secondary no-drag"
                  style={{ transition: 'color 150ms' }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <button
                  type="button"
                  onClick={signInWithDiscord}
                  disabled={busy}
                  className={`w-full flex items-center justify-center gap-2.5 py-2.5 rounded-xl
                              font-semibold text-sm text-white no-drag
                              ${busy ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110 active:scale-[0.97]'}`}
                  style={{
                    background: busy ? '#5865F2' : 'linear-gradient(135deg, #5865F2, #4752c4)',
                    transition: 'filter 150ms, transform 80ms'
                  }}
                >
                  <DiscordIcon />
                  {t('auth.signIn')}
                </button>

                <p className="text-2xs text-txt-muted text-center leading-relaxed">
                  {t('auth.privacy').split('\n').map((line, index) => (
                    <React.Fragment key={line}>
                      {index > 0 && <br />}
                      {line}
                    </React.Fragment>
                  ))}
                </p>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="mt-3 text-xs text-status-error bg-red-500/8 border border-red-500/15 rounded-xl px-4 py-3 animate-fade-in"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
