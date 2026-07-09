import React from 'react'
import { useI18n } from '../i18n'
import ReferralProgram, { type ReferralProgramProps } from './ReferralProgram'

/** Отдельная вкладка «Рефералы» — вынесена из настроек в самостоятельный раздел. */
export default function ReferralPage(props: ReferralProgramProps = {}): React.ReactElement {
  const { t } = useI18n()

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[600px] mx-auto px-6 py-8 flex flex-col gap-5">
        <div className="mb-1">
          <h1 className="text-xl font-bold text-txt-primary">{t('nav.referral')}</h1>
          <p className="text-txt-muted text-sm mt-0.5">{t('referral.pageSubtitle')}</p>
        </div>

        <ReferralProgram {...props} />
      </div>
    </div>
  )
}
