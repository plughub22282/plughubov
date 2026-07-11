import { useI18n } from '../i18n'
import type { AuthUser } from '../types'
import VladonChat from './VladonChat'

function IconSparkles() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  )
}

interface VladonUser extends AuthUser {
  isPremium?: boolean
}

/** Владон — AI-ассистент проекта: чат и подбор плагинов слиты в одну ленту (см. VladonChat). */
export default function Vladon({ user, isPremium }: { user: VladonUser | null; isPremium: boolean }) {
  const { t } = useI18n()

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 border-b border-app-border/40 bg-app-panel px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-2xl text-accent"
            style={{
              background: 'linear-gradient(160deg, rgb(var(--ac) / 0.2), rgb(var(--ac) / 0.06) 70%)',
              border: '1px solid rgb(var(--ac) / 0.2)'
            }}
          >
            <IconSparkles />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-txt-primary">{t('vladon.title')}</h1>
            <p className="text-xs text-txt-muted mt-0.5">{t('vladon.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <VladonChat user={user} isPremium={isPremium} />
      </div>
    </div>
  )
}
