import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useEscapeToClose } from '../hooks/useEscapeToClose'

const TOUR_STEPS: Record<string, string> = {
  'sidebar-sections': 'sidebarSections',
  search: 'search',
  player: 'player',
  'premium-cta': 'premiumCta'
}
const PAD = 8

interface Spot {
  target: string
  rect: DOMRect
}

function measureSteps(): Spot[] {
  return Object.keys(TOUR_STEPS).map((target) => {
    const el = document.querySelector(`[data-tour="${target}"]`)
    return el ? { target, rect: el.getBoundingClientRect() } : null
  }).filter((s): s is Spot => s !== null)
}

export default function OnboardingTour({ onFinish }: { onFinish: () => void }): React.ReactElement | null {
  const { t } = useI18n()
  const [steps] = useState<Spot[]>(measureSteps)
  const [index, setIndex] = useState(0)

  useEscapeToClose(onFinish)

  // Позиции элементов не пересчитываем на resize — при смене размеров окна просто закрываем тур.
  useEffect(() => {
    window.addEventListener('resize', onFinish, { once: true })
    return () => window.removeEventListener('resize', onFinish)
  }, [onFinish])

  if (steps.length === 0) return null

  const { rect, target } = steps[index]
  const isLast = index === steps.length - 1
  const tooltipTop = rect.top + rect.height + 14
  const tooltipLeft = Math.min(Math.max(rect.left, 16), window.innerWidth - 296)

  return (
    <div className="fixed inset-0 z-[70]">
      <div
        className="absolute rounded-xl pointer-events-none transition-all duration-200"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)'
        }}
      />
      <div className="absolute w-[280px] animate-fade-in" style={{ top: tooltipTop, left: tooltipLeft }}>
        <div className="card p-4">
          <p className="text-sm text-txt-primary leading-relaxed">{t(`onboarding.tour.${TOUR_STEPS[target]}`)}</p>
          <div className="flex items-center justify-between mt-3">
            <button type="button" onClick={onFinish} className="text-xs text-txt-muted hover:text-txt-secondary no-drag">
              {t('onboarding.tour.skip')}
            </button>
            <button
              type="button"
              onClick={() => (isLast ? onFinish() : setIndex((i) => i + 1))}
              className="btn-primary py-1.5 px-3 text-xs"
            >
              {isLast ? t('onboarding.tour.finish') : t('onboarding.tour.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
