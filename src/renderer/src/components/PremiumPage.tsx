import React from 'react'
import { useI18n } from '../i18n'
import PremiumActivation from './PremiumActivation'

/** Отдельная вкладка «Премиум» — вынесена из настроек в самостоятельный раздел. */
export default function PremiumPage(): React.ReactElement {
  const { t } = useI18n()

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[600px] mx-auto px-6 py-8 flex flex-col gap-5">
        <div className="mb-1">
          <h1 className="text-xl font-bold text-txt-primary">{t('nav.premium')}</h1>
          <p className="text-txt-muted text-sm mt-0.5">{t('premium.pageSubtitle')}</p>
        </div>

        <PremiumActivation />
      </div>
    </div>
  )
}
