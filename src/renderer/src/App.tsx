import React, { useEffect, useState } from 'react'
import Home from './components/Home'
import Catalog from './components/Catalog'
import Vladon from './components/Vladon'
import Marketplace from './components/Marketplace'
import AssetMarket from './components/AssetMarket'
import UploadPlugin from './components/UploadPlugin'
import AdminCatalogUpload from './components/AdminCatalogUpload'
import KeyManager from './components/KeyManager'
import PremiumPage from './components/PremiumPage'
import ReferralPage from './components/ReferralPage'
import Settings from './components/Settings'
import AuthScreen from './components/AuthScreen'
import Onboarding from './components/Onboarding'
import OnboardingTour from './components/OnboardingTour'
import PremiumChat from './components/PremiumChat'
import { PlayerBar, usePlayer } from './components/PlayerBar'
import { PremiumBadge } from './components/PremiumBadge'
import { SearchField } from './components/pluginCommon'
import GlobalSearchDropdown from './components/GlobalSearchDropdown'
import { useAuth } from './hooks/useAuth'
import { useSearch } from './hooks/useSearch'
import { useI18n } from './i18n'
import { applyTheme } from './utils/theme'
import type { Tab } from './types'

// Разделы, в которых работает глобальный поиск из верхней панели
const SEARCH_TABS: Tab[] = ['catalog', 'marketplace', 'flp', 'templates', 'loops', 'drumkits', 'beats', 'presets']

// ─── Icons ────────────────────────────────────────────────────────────────────

// Логотип-марка: «хаб» — центральный узел с расходящимися коннекторами
const IconLogo = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="4" r="1.7" />
    <circle cx="19" cy="16" r="1.7" />
    <circle cx="5" cy="16" r="1.7" />
    <path d="M12 6.6v2.8M13.9 13.3l3.4 1.9M10.1 13.3l-3.4 1.9" />
  </svg>
)

const IconHome = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" />
  </svg>
)

const IconMarket = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M16 10a4 4 0 0 1-8 0" />
  </svg>
)

const IconCatalog = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

const IconSparklesNav = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
  </svg>
)

const IconUpload = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
  </svg>
)

const IconFlp = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M10 12v6M10 12l4-1" />
  </svg>
)

const IconTemplate = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
  </svg>
)

const IconLoop = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
)

const IconDrum = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <ellipse cx="12" cy="7" rx="9" ry="3.5" />
    <path d="M3 7v8c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5V7" />
    <line x1="17" y1="9.5" x2="22" y2="3.5" /><line x1="7" y1="9.5" x2="2.5" y2="4" />
  </svg>
)

const IconBeat = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    <path d="M9 18V6l12-2v12" /><path d="M9 9l12-2" />
  </svg>
)

const IconPreset = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <line x1="5" y1="3" x2="5" y2="21" /><circle cx="5" cy="9" r="2" fill="currentColor" stroke="none" />
    <line x1="12" y1="3" x2="12" y2="21" /><circle cx="12" cy="15" r="2" fill="currentColor" stroke="none" />
    <line x1="19" y1="3" x2="19" y2="21" /><circle cx="19" cy="6" r="2" fill="currentColor" stroke="none" />
  </svg>
)

const IconPremiumNav = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z" />
  </svg>
)

const IconReferral = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="8" cy="8" r="3" />
    <circle cx="17" cy="6" r="2.3" />
    <circle cx="17" cy="14.5" r="2.3" />
    <path d="M3.5 20a4.5 4.5 0 0 1 9 0" />
    <path d="M13 15.5 15.3 14M13 8.5l2.3-1.5" />
  </svg>
)

const IconSettings = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const IconKey = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.5 12.5 8-8" /><path d="M16 7l3 3" /><path d="M19.5 4.5 22 7" />
  </svg>
)

const IconShieldPlus = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <line x1="12" y1="8" x2="12" y2="15" />
    <line x1="8.5" y1="11.5" x2="15.5" y2="11.5" />
  </svg>
)

const IconStar = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <path d="m12 2 2.4 7.4H22l-6 4.6 2.3 7.4L12 17l-6.3 4.4L8 14 2 9.4h7.6z" />
  </svg>
)

const IconLogout = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

const IconMinus = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const IconSquare = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </svg>
)

const IconX = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// Шеврон-индикатор аккордеона групп навигации: развёрнут — смотрит вниз, свёрнут — влево
const IconChevronDown = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

const NAV_COLLAPSE_STORAGE_KEY = 'vst3manager.nav.collapsedSections'

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App(): React.ReactElement {
  const auth = useAuth()
  const { t } = useI18n()
  const { query: searchQuery, setQuery: setSearchQuery } = useSearch()
  const { current: playerTrack } = usePlayer()
  const [tab, setTab] = useState<Tab>('home')
  const [searchFocused, setSearchFocused] = useState(false)
  const [referralDeepLinkMsg, setReferralDeepLinkMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showTour, setShowTour] = useState(false)

  useEffect(() => {
    window.api.getSettings().then((s) => applyTheme(s.theme ?? 'carbon'))
  }, [])

  // Реферальная ссылка (plughub://ref/<code>) — main обрабатывает клик по ссылке сам
  // (заявка активируется до/сразу после входа) и присылает результат сюда. Подписка на
  // событие покрывает уже запущенное приложение; consumeDeepLinkResult() на маунте —
  // холодный старт, когда ссылка могла быть обработана раньше, чем мы успели подписаться.
  useEffect(() => {
    const applyResult = (res: { ok: boolean; error?: string; code: string }) => {
      setTab('referral')
      setReferralDeepLinkMsg({
        kind: res.ok ? 'ok' : 'err',
        text: res.ok
          ? t('referral.deepLinkClaimed', { code: res.code })
          : (res.error ?? t('premium.error'))
      })
    }
    window.api.referral.consumeDeepLinkResult().then((res) => { if (res) applyResult(res) })
    return window.api.referral.onDeepLinkResult(applyResult)
  }, [t])

  // Сбрасываем поиск при переходе между разделами
  useEffect(() => {
    setSearchQuery('')
  }, [tab, setSearchQuery])

  const showSearch = SEARCH_TABS.includes(tab)

  const isAuthor = auth.state.role === 'author'
  const isPremium = auth.state.premium
  const isOwner = auth.state.isOwner

  type NavItem = { id: Tab; label: string; icon: React.ReactElement }
  type NavSection = { key: string; label: string; items: NavItem[] }

  const manageItems: NavItem[] = [
    ...(isAuthor ? [{ id: 'upload' as Tab, label: t('nav.upload'), icon: <IconUpload /> }] : []),
    ...(isOwner ? [{ id: 'adminCatalog' as Tab, label: t('nav.adminCatalog'), icon: <IconShieldPlus /> }] : []),
    ...(isOwner ? [{ id: 'keys' as Tab, label: t('nav.keys'), icon: <IconKey /> }] : [])
  ]

  const sections: NavSection[] = [
    {
      key: 'plugins',
      label: t('nav.section.plugins'),
      items: [
        { id: 'catalog', label: t('nav.catalog'), icon: <IconCatalog /> },
        { id: 'marketplace', label: t('nav.marketplace'), icon: <IconMarket /> },
        { id: 'vladon', label: t('nav.vladon'), icon: <IconSparklesNav /> }
      ]
    },
    {
      key: 'sounds',
      label: t('nav.section.sounds'),
      items: [
        { id: 'flp', label: t('nav.flp'), icon: <IconFlp /> },
        { id: 'templates', label: t('nav.templates'), icon: <IconTemplate /> },
        { id: 'loops', label: t('nav.loops'), icon: <IconLoop /> },
        { id: 'drumkits', label: t('nav.drumkits'), icon: <IconDrum /> },
        { id: 'beats', label: t('nav.beats'), icon: <IconBeat /> },
        { id: 'presets', label: t('nav.presets'), icon: <IconPreset /> }
      ]
    },
    // «Аккаунт» — премиум, рефералы и настройки вместе. Расположена между «Звуками» и
    // «Управлением», поэтому «Настройки» оказываются в середине списка разделов, а не
    // прибиты отдельным пунктом к низу сайдбара.
    {
      key: 'account',
      label: t('nav.section.account'),
      items: [
        { id: 'premium', label: t('nav.premium'), icon: <IconPremiumNav /> },
        { id: 'referral', label: t('nav.referral'), icon: <IconReferral /> },
        { id: 'settings', label: t('nav.settings'), icon: <IconSettings /> }
      ]
    },
    ...(manageItems.length ? [{ key: 'manage', label: t('nav.section.manage'), items: manageItems }] : [])
  ]

  const allTabIds: Tab[] = ['home', ...sections.flatMap((s) => s.items.map((i) => i.id))]

  // Если активная вкладка стала недоступной (например, сменилась роль) — возвращаемся на главную.
  // Зависим от примитивов, а не от заново создаваемого массива, чтобы эффект не гонялся каждый рендер.
  useEffect(() => {
    if (!allTabIds.includes(tab)) setTab('home')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isAuthor, isOwner])

  // Свёрнутые группы навигации (аккордеон) — состояние переживает перезапуск приложения
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSE_STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })

  useEffect(() => {
    localStorage.setItem(NAV_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedSections))
  }, [collapsedSections])

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Раздел активной вкладки всегда должен быть развёрнут — например, после перехода
  // по реферальной ссылке или смены роли, когда группа могла быть свёрнута ранее
  useEffect(() => {
    const activeSection = sections.find((s) => s.items.some((i) => i.id === tab))
    if (activeSection && collapsedSections[activeSection.key]) {
      setCollapsedSections((prev) => ({ ...prev, [activeSection.key]: false }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const isWindows = window.navigator.userAgent.includes('Windows')
  const isLinux   = window.navigator.userAgent.includes('Linux')
  const isMac     = window.navigator.userAgent.includes('Mac')
  const showControls = isWindows || isLinux

  const handleWindowControl = (action: 'minimize' | 'maximize' | 'close') => {
    window.api[action]()
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  if (auth.status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-app-border border-t-accent rounded-full animate-spin" />
      </div>
    )
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  if (auth.status !== 'signedIn') {
    return (
      <AuthScreen
        status={auth.status}
        error={auth.error}
        busy={auth.busy}
        signInWithDiscord={auth.signInWithDiscord}
        cancelDiscord={auth.cancelDiscord}
      />
    )
  }

  // ── Main ─────────────────────────────────────────────────────────────────

  const displayName = auth.state.user?.displayName || auth.state.user?.email || '?'
  const avatarLetter = displayName.charAt(0).toUpperCase()

  return (
    <div
      className="flex flex-col h-full text-txt-primary"
      style={{ backgroundImage: 'var(--content-glow)' }}
    >
      {/* ── Title Bar ─────────────────────────────────────────────────── */}
      <div
        className={`drag-region relative flex items-center gap-3 h-11 pr-2 border-b border-app-border/40 flex-shrink-0 ${
          isMac ? 'pl-[78px]' : 'pl-3'
        }`}
        style={{
          background:
            'linear-gradient(180deg, rgb(255 255 255 / 0.06), transparent 84%), rgb(var(--panel) / 0.72)',
          backdropFilter: 'blur(18px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.4)'
        }}
      >
        {/* Brand — логотип-марка + вордмарк слева */}
        <div className="flex items-center gap-2 no-drag select-none flex-shrink-0">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-[9px] flex-shrink-0"
            style={{
              color: 'rgb(var(--btn-primary-text))',
              background:
                'linear-gradient(180deg, rgb(255 255 255 / 0.34), transparent 44%), linear-gradient(135deg, rgb(var(--ac)), rgb(var(--ac-h)))',
              border: '1px solid rgb(255 255 255 / 0.28)',
              boxShadow:
                'inset 0 1px 0 rgb(255 255 255 / 0.55), 0 2px 8px rgb(0 0 0 / 0.35), 0 0 16px rgb(var(--ac) / 0.18)'
            }}
          >
            <IconLogo />
          </span>
          <span
            className="text-[14px] font-bold tracking-[0.04em] select-none"
            style={{
              background: 'linear-gradient(135deg, rgb(var(--ac)), rgb(var(--ac-h)))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text'
            }}
          >
            PlugHub
          </span>
        </div>

        {/* Поиск — по центру, для разделов с каталогом */}
        {showSearch && (
          <div
            data-tour="search"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(440px,44%)] no-drag"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearchFocused(false) }}
          >
            <div className="relative">
              <SearchField
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={t('common.search')}
                className="w-full"
              />
              {searchFocused && (
                <GlobalSearchDropdown
                  query={searchQuery}
                  onNavigate={setTab}
                  onSelect={() => {
                    setSearchQuery('')
                    setSearchFocused(false)
                  }}
                />
              )}
            </div>
          </div>
        )}

        {showControls && (
          <div className="flex items-center gap-0.5 no-drag ml-auto flex-shrink-0">
            {[
              { action: 'minimize' as const, icon: <IconMinus />, label: t('window.minimize') },
              { action: 'maximize' as const, icon: <IconSquare />, label: t('window.maximize') },
              { action: 'close'    as const, icon: <IconX />,     label: t('window.close'),  danger: true }
            ].map(({ action, icon, label, danger }) => (
              <button
                key={action}
                onClick={() => handleWindowControl(action)}
                title={label}
                className={`w-8 h-7 flex items-center justify-center rounded-lg text-txt-muted transition-colors ${
                  danger
                    ? 'hover:bg-red-500/80 hover:text-white'
                    : 'hover:bg-app-border/60 hover:text-txt-primary'
                }`}
              >
                {icon}
              </button>
            ))}
          </div>
        )}

        {/* На вкладках без поиска держим правый край ровным, если кнопок окна нет */}
        {!showControls && <div className="ml-auto" />}
      </div>

      {/* ── Layout ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar */}
        <aside
          className="w-[196px] flex-shrink-0 border-r border-app-border/40 flex flex-col py-4 px-3"
          style={{
            backgroundColor: 'rgb(var(--panel) / 0.58)',
            backgroundImage: 'var(--sidebar-glow)',
            backdropFilter: 'blur(18px) saturate(1.3)',
            WebkitBackdropFilter: 'blur(18px) saturate(1.3)'
          }}
        >
          {/* Nav — «Настройки» теперь обычный пункт раздела «Профиль» (см. sections), а не
              прибиты отдельно к низу: так весь список читается единым потоком сверху вниз.
              Каждая группа — аккордеон: заголовок сворачивает/разворачивает свой список
              пунктов с анимацией высоты через CSS grid (nav-group-body). */}
          <nav data-tour="sidebar-sections" className="flex flex-col flex-1 gap-1 overflow-y-auto -mr-1 pr-1">
            {/* «Главная» — закреплена над аккордеон-секциями, дефолтная вкладка при запуске. */}
            <button
              onClick={() => setTab('home')}
              className={`tab-btn mb-1 ${tab === 'home' ? 'tab-btn-active' : 'tab-btn-inactive'}`}
            >
              <span className="tab-icon flex-shrink-0"><IconHome /></span>
              <span>{t('nav.home')}</span>
            </button>
            {sections.map((section) => {
              const isCollapsed = !!collapsedSections[section.key]
              return (
                <div key={section.key} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggleSection(section.key)}
                    className="nav-section-header"
                    aria-expanded={!isCollapsed}
                  >
                    <span className="nav-section-label">{section.label}</span>
                    <span className={`nav-chevron ${isCollapsed ? 'nav-chevron-collapsed' : ''}`}>
                      <IconChevronDown />
                    </span>
                  </button>
                  <div className={`nav-group-body ${isCollapsed ? 'nav-group-body-collapsed' : ''}`}>
                    <div className="nav-group-body-inner">
                      {section.items.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setTab(item.id)}
                          className={`tab-btn ${tab === item.id ? 'tab-btn-active' : 'tab-btn-inactive'}`}
                        >
                          <span className="tab-icon flex-shrink-0">{item.icon}</span>
                          <span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </nav>

          {/* Premium CTA — показываем тем, у кого премиума ещё нет */}
          {!isPremium && (
            <button
              data-tour="premium-cta"
              onClick={() => setTab('premium')}
              className="w-full flex items-center gap-2 px-3 py-2 mb-2 rounded-xl text-xs font-semibold no-drag"
              style={{
                color: 'rgb(var(--ac))',
                background: 'rgb(var(--ac) / 0.12)',
                border: '1px solid rgb(var(--ac) / 0.3)',
                transition: 'background 150ms ease'
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ac) / 0.2)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgb(var(--ac) / 0.12)' }}
              title={t('premium.sidebarTitle')}
            >
              <IconStar />
              {t('premium.cta')}
            </button>
          )}

          {/* User */}
          <div className="pt-3 border-t border-app-border/40 select-none">
            <div className="flex items-center gap-2.5 px-2 py-2 mb-1 rounded-xl" style={{ background: 'var(--ui-subtle)' }}>
              {auth.state.user?.avatarUrl ? (
                <img
                  src={auth.state.user.avatarUrl}
                  alt=""
                  draggable={false}
                  className="w-7 h-7 rounded-full flex-shrink-0 object-cover"
                />
              ) : (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold uppercase flex-shrink-0"
                  style={{ background: 'rgb(var(--ac) / 0.15)', color: 'rgb(var(--ac))' }}
                >
                  {avatarLetter}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-xs font-medium text-txt-primary truncate">{displayName}</span>
                  {/* Верификационная галочка премиума (без текстовой плашки, п.6). */}
                  {isPremium && <PremiumBadge size={13} title={t('premium.verifiedTitle')} />}
                </div>
                <div className="text-[10px] mt-0.5 flex items-center gap-1">
                  <span className="text-txt-muted">{isAuthor ? t('role.author') : t('role.user')}</span>
                </div>
              </div>
            </div>

            <button
              onClick={auth.signOut}
              disabled={auth.busy}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-xs text-txt-muted
                         hover:text-txt-secondary no-drag disabled:opacity-40"
              style={{ transition: 'background 150ms ease, color 120ms ease' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <IconLogout />
              {t('common.logout')}
            </button>
          </div>
        </aside>

        {/* Content */}
        <main className={`flex-1 overflow-hidden ${playerTrack ? 'pb-14' : ''}`}>
          <div key={tab} className="h-full animate-tab">
            {tab === 'home'        && <Home onNavigate={setTab} genre={auth.state.onboardingGenre} />}
            {tab === 'catalog'     && <Catalog />}
            {tab === 'marketplace' && <Marketplace />}
            {tab === 'vladon' && (
              <Vladon user={auth.state.user ? { ...auth.state.user, isPremium } : null} isPremium={isPremium} />
            )}
            {tab === 'flp'         && <AssetMarket kind="flp" />}
            {tab === 'templates'   && <AssetMarket kind="template" />}
            {tab === 'loops'       && <AssetMarket kind="loop" />}
            {tab === 'drumkits'    && <AssetMarket kind="drumkit" />}
            {tab === 'beats'       && <AssetMarket kind="beat" />}
            {tab === 'presets'     && <AssetMarket kind="preset" />}
            {tab === 'upload'      && <UploadPlugin />}
            {tab === 'adminCatalog' && <AdminCatalogUpload />}
            {tab === 'keys'        && <KeyManager />}
            {tab === 'premium'     && <PremiumPage />}
            {tab === 'referral'    && (
              <ReferralPage
                externalMessage={referralDeepLinkMsg}
                onExternalMessageConsumed={() => setReferralDeepLinkMsg(null)}
              />
            )}
            {tab === 'settings'    && <Settings />}
          </div>
        </main>
      </div>

      <PlayerBar />
      <PremiumChat user={auth.state.user ? { ...auth.state.user, isPremium } : null} />

      {/* onboardingCompleted придёт через auth:changed после completeOnboarding — оверлей закроется сам */}
      {auth.status === 'signedIn' && !auth.state.onboardingCompleted && (
        <Onboarding onDone={() => {}} onStartTour={() => setShowTour(true)} />
      )}
      {showTour && <OnboardingTour onFinish={() => setShowTour(false)} />}
    </div>
  )
}

// Глобальный тип для window.api
declare global {
  interface Window {
    api: {
      minimize: () => void
      maximize: () => void
      close: () => void
      auth: {
        getState: () => Promise<import('./types').AuthState>
        signInWithDiscord: () => Promise<import('./types').AuthResult>
        cancelDiscord: () => Promise<import('./types').AuthResult>
        signOut: () => Promise<import('./types').AuthResult>
        redeemPremium: (code: string) => Promise<import('./types').AuthResult>
        completeOnboarding: (daw: string | null, genre: string | null) => Promise<import('./types').AuthResult>
        onChange: (cb: (state: import('./types').AuthState) => void) => () => void
      }
      premium: {
        generate: (
          count: number,
          note?: string,
          days?: number
        ) => Promise<{ ok: boolean; codes?: string[]; error?: string }>
        list: () => Promise<{ ok: boolean; codes?: import('./types').PremiumCode[]; error?: string }>
      }
      chat: {
        history: () => Promise<import('./types').ChatHistoryResult>
        send: (text: string) => Promise<{ ok: boolean; error?: string }>
        unsubscribe: () => Promise<{ ok: boolean }>
        onMessage: (cb: (message: import('./types').ChatMessage) => void) => () => void
      }
      ai: {
        send: (
          messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
          isPremium?: boolean
        ) => Promise<import('./types').AiSendResult>
        onChunk: (cb: (e: import('./types').AiChunkEvent) => void) => () => void
        onDone: (cb: (e: import('./types').AiDoneEvent) => void) => () => void
        onError: (cb: (e: import('./types').AiErrorEvent) => void) => () => void
        recommend: (query: string, isPremium?: boolean) => Promise<import('./types').AiRecommendResult>
      }
      referral: {
        stats: () => Promise<import('./types').ReferralStats>
        claim: (code: string) => Promise<import('./types').ReferralActionResult>
        redeem: () => Promise<import('./types').ReferralRedeemResult>
        onDeepLinkResult: (cb: (result: import('./types').ReferralDeepLinkResult) => void) => () => void
        consumeDeepLinkResult: () => Promise<import('./types').ReferralDeepLinkResult | null>
      }
      getSettings: () => Promise<import('./types').AppSettings>
      saveSettings: (s: import('./types').AppSettings) => Promise<{ ok: boolean }>
      listPlugins: () => Promise<import('./types').Plugin[]>
      installPlugin: (id: string, sourceTab?: string) => Promise<import('./types').InstallResult>
      downloadPluginArchive: (id: string, sourceTab?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      getAutoInstallStatus: () => Promise<import('./types').AutoInstallStatus>
      studio: {
        list: () => Promise<import('./types').StudioListResult>
        restore: () => Promise<import('./types').StudioRestoreResult>
      }
      uploadPlugin: (
        meta: import('./types').UploadMeta,
        filePath: string,
        iconPath?: string
      ) => Promise<{ ok: boolean; path?: string; error?: string }>
      uploadCatalogPlugin: (
        meta: import('./types').CatalogUploadMeta,
        filePath: string,
        iconPath?: string
      ) => Promise<{ ok: boolean; id?: string; error?: string }>
      listCommunityPlugins: () => Promise<import('./types').CommunityPlugin[]>
      uploadCommunityPlugin: (
        meta: import('./types').UploadMeta,
        filePath: string,
        iconPath?: string,
        uploadId?: string
      ) => Promise<{ ok: boolean; error?: string }>
      bumpCommunityDownload: (id: string) => Promise<{ ok: boolean }>
      deleteCommunityPlugin: (id: string) => Promise<{ ok: boolean; error?: string }>
      listAssets: (kind: import('./types').AssetKind) => Promise<import('./types').CommunityPlugin[]>
      uploadAsset: (
        kind: import('./types').AssetKind,
        meta: import('./types').UploadMeta,
        filePath: string,
        iconPath?: string,
        options?: import('./types').UploadAssetOptions,
        uploadId?: string
      ) => Promise<{ ok: boolean; error?: string }>
      downloadAsset: (id: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      selectFolder: () => Promise<string | null>
      selectFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>
      readAudioFile: (filePath: string) => Promise<ArrayBuffer>
      openPath: (p: string) => Promise<string>
      openExternal: (url: string) => Promise<{ ok: boolean }>
      onInstallProgress: (cb: (p: import('./types').InstallProgress) => void) => () => void
      onInstallLog: (cb: (msg: string) => void) => () => void
      onUploadProgress: (cb: (p: import('./types').UploadProgress) => void) => () => void
    }
  }
}
