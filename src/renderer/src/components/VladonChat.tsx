import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useTaste } from '../hooks/useTaste'
import type { AuthUser, AiChatMessage, AiRecommendationItem, Plugin, InstallProgress } from '../types'
import { PluginCard, SkeletonCard } from './pluginCommon'

interface VladonChatUser extends AuthUser {
  isPremium?: boolean
}

function IconSend(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
      <path d="M22 2 11 13" />
    </svg>
  )
}

function IconSparkles(): React.ReactElement {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  )
}

function IconSparklesSmall(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  )
}

function IconChatBubble(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </svg>
  )
}

function IconRefresh(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

const MAX_HISTORY_TURNS = 12 // сколько последних реплик диалога уходит в контекст модели
const REVEAL_TICK_MS = 16 // ~60fps — печатающий эффект не завязан на то, пачками или по токену пришли дельты

interface StreamState {
  requestId: string
  messageId: string
  queue: string
  ended: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/** Режим ввода: обычный чат (стриминг ответа) либо подбор плагинов из каталога. */
type Mode = 'chat' | 'recommend'

/**
 * Элемент единой ленты Владона. Чат и подбор плагинов слиты в один диалог:
 * - 'user'/'assistant' — реплики чат-режима (assistant стримится);
 * - 'reco' — карточка результата подбора (грид плагинов, прямо в потоке диалога).
 */
type Message =
  | (AiChatMessage & { kind: 'chat' })
  | { kind: 'reco'; id: string; loading: boolean; error?: string; items: AiRecommendationItem[] }

const SUGGESTIONS = ['bass', 'vintage', 'reverb', 'lofi'] as const

/**
 * Владон — единый AI-ассистент вкладки: чат и подбор плагинов в одной ленте.
 * Один ввод, один переключатель режима; ответы чата (стриминг) и блоки подбора
 * (карточки плагинов) идут общим потоком диалога. У каждого режима свой лимит на
 * бэкенде (ai.send / ai.recommend), переключение вкладок больше не разрывает историю.
 */
export default function VladonChat({
  user,
  isPremium
}: {
  user: VladonChatUser | null
  isPremium: boolean
}): React.ReactElement | null {
  const { t } = useI18n()
  const { record } = useTaste()
  const [mode, setMode] = useState<Mode>('chat')
  const [value, setValue] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // «Прилипание» к низу списка — включено, пока пользователь сам находится внизу (или
  // только что отправил сообщение). Как только он листает вверх читать историю, стриминг
  // ответа больше не утаскивает вид обратно вниз на каждый токен.
  const stickToBottomRef = useRef(true)
  // Активный стрим: пришедшие по IPC дельты копятся в queue и раскрываются по чуть-чуть
  // на таймере (см. tick ниже) — так текст «печатается» плавно, даже если сеть присылает
  // его рваными пачками по несколько токенов сразу.
  const streamRef = useRef<StreamState | null>(null)

  // Каталог (официальный + community) для резолва id рекомендаций в полноценные карточки,
  // прогресс установки и «ожидающие» id — перенесено из бывшего Recommendations.
  const [catalog, setCatalog] = useState<Map<string, Plugin>>(new Map())
  const [progressMap, setProgressMap] = useState<Record<string, InstallProgress>>({})
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 48
  }

  const stopStream = () => {
    if (streamRef.current?.timer) clearTimeout(streamRef.current.timer)
    streamRef.current = null
  }

  const tick = () => {
    const s = streamRef.current
    if (!s) return
    if (s.queue.length > 0) {
      // Если сеть опережает скорость «печати» — раскрываем крупными кусками, чтобы не копить лаг.
      const step = s.queue.length > 200 ? Math.ceil(s.queue.length / 8) : s.queue.length > 40 ? 3 : 1
      const piece = s.queue.slice(0, step)
      s.queue = s.queue.slice(step)
      const messageId = s.messageId
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.kind === 'chat' ? { ...m, text: m.text + piece } : m))
      )
    }
    if (s.queue.length === 0 && s.ended) {
      const messageId = s.messageId
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId && m.kind === 'chat' ? { ...m, pending: false } : m))
      )
      streamRef.current = null
      setSending(false)
      return
    }
    s.timer = setTimeout(tick, REVEAL_TICK_MS)
  }

  // Загрузка каталога + подписка на прогресс установки (для карточек подбора).
  useEffect(() => {
    Promise.all([window.api.listPlugins(), window.api.listCommunityPlugins()]).then(([plugins, community]) => {
      const map = new Map<string, Plugin>()
      plugins.forEach((p) => map.set(p.id, p))
      community.forEach((p) => map.set(p.id, p))
      setCatalog(map)
    })

    const unsub = window.api.onInstallProgress((p) => {
      setProgressMap((prev) => ({ ...prev, [p.pluginId]: p }))
      setPendingIds((prev) => {
        if (!prev.has(p.pluginId)) return prev
        const next = new Set(prev)
        next.delete(p.pluginId)
        return next
      })
      if (p.step === 'done') {
        setCatalog((prev) => {
          const plugin = prev.get(p.pluginId)
          if (!plugin) return prev
          const next = new Map(prev)
          next.set(p.pluginId, { ...plugin, installed: true })
          return next
        })
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsubChunk = window.api.ai.onChunk(({ requestId, delta }) => {
      const s = streamRef.current
      if (s?.requestId !== requestId) return
      if (prefersReducedMotion()) {
        const messageId = s.messageId
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId && m.kind === 'chat' ? { ...m, text: m.text + delta } : m))
        )
        return
      }
      s.queue += delta
      if (!s.timer) tick()
    })
    const unsubDone = window.api.ai.onDone(({ requestId }) => {
      const s = streamRef.current
      if (s?.requestId !== requestId) return
      s.ended = true
      if (!s.timer && s.queue.length === 0) {
        const messageId = s.messageId
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId && m.kind === 'chat' ? { ...m, pending: false } : m))
        )
        streamRef.current = null
        setSending(false)
      }
    })
    const unsubError = window.api.ai.onError(({ requestId, error: err }) => {
      const s = streamRef.current
      if (s?.requestId !== requestId) return
      const messageId = s.messageId
      stopStream()
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      setSending(false)
      setError(err)
    })
    return () => {
      unsubChunk()
      unsubDone()
      unsubError()
      stopStream()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    // 'auto' — во время стриминга эффект срабатывает на каждый тик раскрытия текста,
    // и очередь smooth-анимаций скролла на таком темпе выглядит дёргано.
    el.scrollTo({ top: el.scrollHeight })
  }, [messages])

  const handleInstall = useCallback(async (plugin: Plugin) => {
    setPendingIds((prev) => new Set(prev).add(plugin.id))
    try {
      const res = await window.api.installPlugin(plugin.id, 'marketplace')
      if (res.ok) {
        record({ type: 'download', category: plugin.category, tab: 'marketplace', itemId: plugin.id, name: plugin.name })
      }
    } finally {
      setPendingIds((prev) => {
        if (!prev.has(plugin.id)) return prev
        const next = new Set(prev)
        next.delete(plugin.id)
        return next
      })
    }
  }, [record])

  const sendChat = async (text: string) => {
    setSending(true)
    setError(null)

    const history = messages
      .filter((m): m is AiChatMessage & { kind: 'chat' } => m.kind === 'chat')
      .slice(-MAX_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.text }))
    const apiMessages = [...history, { role: 'user' as const, content: text }]

    const userMsg: Message = { kind: 'chat', id: newId(), role: 'user', text }
    const assistantMsg: Message = { kind: 'chat', id: newId(), role: 'assistant', text: '', pending: true }
    stickToBottomRef.current = true // отправка своего сообщения всегда прижимает вид к низу
    setMessages((prev) => [...prev, userMsg, assistantMsg])

    const res = await window.api.ai.send(apiMessages, user?.isPremium === true)
    if (!res.ok || !res.requestId) {
      setMessages((prev) => prev.filter((m) => m.id !== assistantMsg.id))
      setSending(false)
      setError(res.error ?? t('ai.error'))
      return
    }
    streamRef.current = { requestId: res.requestId, messageId: assistantMsg.id, queue: '', ended: false, timer: null }
  }

  const sendRecommend = async (text: string) => {
    setSending(true)
    setError(null)

    // Запрос пользователя — обычной репликой, результат подбора — блоком 'reco' следом.
    const userMsg: Message = { kind: 'chat', id: newId(), role: 'user', text: text || t('vladon.tabRecommend') }
    const recoMsg: Message = { kind: 'reco', id: newId(), loading: true, items: [] }
    stickToBottomRef.current = true
    setMessages((prev) => [...prev, userMsg, recoMsg])

    try {
      const res = await window.api.ai.recommend(text, isPremium)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === recoMsg.id && m.kind === 'reco'
            ? res.ok
              ? { ...m, loading: false, items: res.items ?? [] }
              : { ...m, loading: false, error: res.error ?? t('recommend.error') }
            : m
        )
      )
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.id === recoMsg.id && m.kind === 'reco' ? { ...m, loading: false, error: t('recommend.error') } : m))
      )
    } finally {
      setSending(false)
    }
  }

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (sending) return
    // В чате пустое сообщение не отправляем; в подборе пустой запрос допустим (общая подборка).
    if (mode === 'chat' && !trimmed) return
    setValue('')
    if (mode === 'chat') void sendChat(trimmed)
    else void sendRecommend(trimmed)
  }

  const resetChat = () => {
    stopStream()
    stickToBottomRef.current = true
    setMessages([])
    setError(null)
    setSending(false)
  }

  if (!user) return null

  const placeholder = mode === 'chat' ? t('ai.placeholder') : t('recommend.placeholder')

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {messages.length > 0 && (
        <div className="flex flex-shrink-0 justify-end px-5 py-2">
          <button
            type="button"
            onClick={resetChat}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-2xs text-txt-muted hover:bg-white/10 hover:text-txt-primary no-drag"
          >
            <IconRefresh />
            {t('ai.newChat')}
          </button>
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-3 py-10 text-center">
              <span
                className="flex h-12 w-12 items-center justify-center rounded-2xl text-accent"
                style={{
                  background: 'linear-gradient(160deg, rgb(var(--ac) / 0.18), rgb(var(--ac) / 0.06) 70%)',
                  border: '1px solid rgb(var(--ac) / 0.18)'
                }}
              >
                <IconSparkles />
              </span>
              <p className="text-xs text-txt-muted">{t('ai.empty')}</p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {SUGGESTIONS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => submit(t(`ai.suggestion.${key}`))}
                    className="rounded-full border border-accent/20 bg-accent/8 px-2.5 py-1 text-2xs font-medium text-accent hover:bg-accent/14 no-drag"
                  >
                    {t(`ai.suggestion.${key}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((message) =>
                message.kind === 'reco' ? (
                  <RecoBlock
                    key={message.id}
                    message={message}
                    catalog={catalog}
                    progressMap={progressMap}
                    pendingIds={pendingIds}
                    onInstall={handleInstall}
                  />
                ) : (
                  <ChatBubble key={message.id} message={message} />
                )
              )}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-auto mb-2 w-full max-w-3xl flex-shrink-0 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2 text-2xs text-rose-300">
          {error}
        </div>
      )}

      <div className="flex-shrink-0 border-t border-app-border/40 p-4">
        <div className="mx-auto w-full max-w-3xl">
          {/* Переключатель режима — общий ввод обслуживает и чат, и подбор плагинов. */}
          <div className="mb-2.5 flex gap-1.5">
            <ModeButton active={mode === 'chat'} onClick={() => setMode('chat')} icon={<IconChatBubble />}>
              {t('vladon.tabChat')}
            </ModeButton>
            <ModeButton active={mode === 'recommend'} onClick={() => setMode('recommend')} icon={<IconSparklesSmall />}>
              {t('vladon.tabRecommend')}
            </ModeButton>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit(value)
                }
              }}
              maxLength={2000}
              placeholder={placeholder}
              className="input-field max-h-32 min-h-[42px] flex-1 resize-none py-2.5 text-xs"
            />
            <button
              onClick={() => submit(value)}
              disabled={sending || (mode === 'chat' && !value.trim())}
              title={mode === 'chat' ? t('chat.send') : t('recommend.button')}
              className="btn-primary h-[42px] w-[42px] flex-shrink-0 px-0 disabled:opacity-40"
            >
              {sending ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current/40 border-t-current" />
              ) : mode === 'chat' ? (
                <IconSend />
              ) : (
                <IconSparklesSmall />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold no-drag ${
        active ? 'btn-primary' : 'btn-ghost'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

/** Одна реплика чат-режима (пузырь пользователя/ассистента со стримингом). */
function ChatBubble({ message }: { message: AiChatMessage & { kind: 'chat' } }): React.ReactElement {
  const mine = message.role === 'user'
  const streaming = message.pending && message.text !== ''
  return (
    <div className={`flex animate-fade-in-up ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[75%] rounded-2xl px-3.5 py-2.5 text-xs shadow-sm',
          mine
            ? 'bg-accent text-[rgb(var(--btn-primary-text))]'
            : 'border border-app-border/70 bg-app-panel/70 text-txt-primary'
        ].join(' ')}
      >
        <div className="whitespace-pre-wrap break-words leading-relaxed">
          {message.text}
          {streaming && (
            <span className="ml-0.5 inline-block h-3 w-[2px] -mb-0.5 animate-pulse bg-current align-middle" />
          )}
          {message.pending && message.text === '' && (
            <span className="inline-flex gap-0.5 align-middle">
              <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:-0.2s]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:-0.1s]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Блок подбора: сетка карточек плагинов с обоснованием, прямо в ленте диалога. */
function RecoBlock({
  message,
  catalog,
  progressMap,
  pendingIds,
  onInstall
}: {
  message: { kind: 'reco'; id: string; loading: boolean; error?: string; items: AiRecommendationItem[] }
  catalog: Map<string, Plugin>
  progressMap: Record<string, InstallProgress>
  pendingIds: Set<string>
  onInstall: (plugin: Plugin) => void
}): React.ReactElement {
  const { t } = useI18n()

  if (message.loading) {
    return (
      <div className="grid animate-fade-in-up grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  if (message.error) {
    return (
      <div className="animate-fade-in-up rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2 text-2xs text-rose-300">
        {message.error}
      </div>
    )
  }

  const resolved = message.items
    .map((item) => ({ item, plugin: catalog.get(item.id) }))
    .filter((r): r is { item: AiRecommendationItem; plugin: Plugin } => !!r.plugin)

  if (resolved.length === 0) {
    return (
      <div className="animate-fade-in-up rounded-xl border border-app-border/60 bg-app-panel/60 px-3.5 py-3 text-center text-2xs text-txt-muted">
        {t('recommend.empty')}
      </div>
    )
  }

  return (
    <div className="grid animate-fade-in-up grid-cols-1 gap-4 md:grid-cols-2">
      {resolved.map(({ item, plugin }, i) => (
        <div
          key={item.id}
          className="flex flex-col gap-2 animate-fade-in-up"
          style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
        >
          <div
            className="flex items-start gap-1.5 rounded-xl border border-accent/20 px-3 py-2 text-2xs leading-relaxed text-txt-secondary"
            style={{ background: 'linear-gradient(135deg, rgb(var(--ac) / 0.1), rgb(var(--ac) / 0.03))' }}
          >
            <span className="mt-0.5 flex-shrink-0 text-accent">
              <IconSparklesSmall />
            </span>
            <span>{item.reason}</span>
          </div>
          <PluginCard
            plugin={plugin}
            progress={progressMap[plugin.id] ?? null}
            onInstall={onInstall}
            pending={pendingIds.has(plugin.id)}
          />
        </div>
      ))}
    </div>
  )
}
