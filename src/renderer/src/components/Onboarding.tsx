import React, { useState } from 'react'
import { useI18n } from '../i18n'
import { useEscapeToClose } from '../hooks/useEscapeToClose'

type Step = 'value' | 'daw' | 'genre' | 'done'

const DAW_KEYS = ['flstudio', 'ableton', 'logicpro', 'flstudiomobile', 'other']
const GENRE_KEYS = ['trap', 'house', 'lofi', 'drill', 'pop', 'other']

function Chips({ keys, prefix, onSelect }: { keys: string[]; prefix: string; onSelect: (k: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onSelect(key)}
          className="rounded-xl border border-app-border/60 bg-app-card/50 px-3 py-2.5 text-sm font-medium
                     text-txt-primary text-left no-drag transition-all duration-150
                     hover:bg-app-border/20 hover:border-accent/45 active:scale-[0.97]"
        >
          {t(`onboarding.${prefix}.option.${key}`)}
        </button>
      ))}
    </div>
  )
}

export default function Onboarding({
  onDone,
  onStartTour
}: {
  onDone: (daw: string | null, genre: string | null) => void
  onStartTour: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('value')
  const [daw, setDaw] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingGenre, setPendingGenre] = useState<string | null>(null)

  const skip = () => (step === 'daw' ? setStep('genre') : void persist(null))
  useEscapeToClose(skip, step !== 'value' && step !== 'done' && !busy)

  const persist = async (finalGenre: string | null) => {
    setBusy(true)
    setError(null)
    setPendingGenre(finalGenre)
    try {
      const result = await window.api.auth.completeOnboarding(daw, finalGenre)
      if (!result.ok) {
        setError(result.error ?? t('onboarding.error.saveFailed'))
        return
      }
      setStep('done')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6 backdrop-blur-sm bg-black/50">
      <div className="w-full max-w-[360px] animate-slide-up">
        <div className="card p-6">
            {step !== 'value' && step !== 'done' && (
              <div className="flex justify-end mb-3">
                <button
                  type="button"
                  onClick={skip}
                  disabled={busy}
                  className="text-xs text-txt-muted hover:text-txt-secondary no-drag disabled:opacity-40"
                >
                  {t('onboarding.skip')}
                </button>
              </div>
            )}

            {step === 'value' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <h2 className="text-lg font-bold text-txt-primary">{t('onboarding.value.title')}</h2>
                <ul className="flex flex-col gap-2 text-sm text-txt-secondary leading-relaxed list-disc pl-4">
                  <li>{t('onboarding.value.point1')}</li>
                  <li>{t('onboarding.value.point2')}</li>
                  <li>{t('onboarding.value.point3')}</li>
                </ul>
                <button type="button" onClick={() => setStep('daw')} className="btn-primary w-full py-2.5">
                  {t('onboarding.value.next')}
                </button>
              </div>
            )}

            {step === 'daw' && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h2 className="text-base font-semibold text-txt-primary">{t('onboarding.daw.question')}</h2>
                <Chips keys={DAW_KEYS} prefix="daw" onSelect={(k) => { setDaw(k); setStep('genre') }} />
              </div>
            )}

            {step === 'genre' && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h2 className="text-base font-semibold text-txt-primary">{t('onboarding.genre.question')}</h2>
                <Chips keys={GENRE_KEYS} prefix="genre" onSelect={(k) => void persist(k)} />
              </div>
            )}

            {step === 'done' && (
              <div className="flex flex-col gap-5 animate-fade-in">
                <div>
                  <h2 className="text-lg font-bold text-txt-primary">{t('onboarding.done.title')}</h2>
                  <p className="text-sm text-txt-secondary mt-1.5">{t('onboarding.done.subtitle')}</p>
                </div>
                <div className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => { onStartTour(); onDone(daw, pendingGenre) }}
                    className="btn-primary w-full py-2.5"
                  >
                    {t('onboarding.done.startTour')}
                  </button>
                  <button type="button" onClick={() => onDone(daw, pendingGenre)} className="btn-ghost w-full py-2.5">
                    {t('onboarding.done.start')}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-3 text-xs text-status-error bg-red-500/8 border border-red-500/15 rounded-xl px-4 py-3 animate-fade-in">
                <p>{error}</p>
                <button type="button" onClick={() => void persist(pendingGenre)} className="mt-2 font-semibold underline underline-offset-2">
                  {t('onboarding.error.retry')}
                </button>
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
