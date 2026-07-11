import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { AuthUser, ChatMessage } from '../types'
import { useEscapeToClose } from '../hooks/useEscapeToClose'

interface PremiumChatUser extends AuthUser {
  isPremium?: boolean
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function IconSend(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1">
      <path d="m22 2-7 20-4-9-9-4 20-7z" />
      <path d="M22 2 11 13" />
    </svg>
  )
}

function IconChat(): React.ReactElement {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  )
}

function IconMinus(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export default function PremiumChat({ user }: { user: PremiumChatUser | null }): React.ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [unread, setUnread] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  // Держим актуальный t в ref, чтобы не пересоздавать подписку при смене языка.
  const tRef = useRef(t)
  tRef.current = t
  // ID уже учтённых сообщений — чтобы realtime-передоставка не задваивала счётчик непрочитанных.
  const seenRef = useRef<Set<string>>(new Set())

  const isPremium = user?.isPremium === true
  const myId = user?.id ?? null

  useEscapeToClose(() => setOpen(false), open)

  // Загрузка истории + realtime-подписка. Активны только для premium-пользователя.
  useEffect(() => {
    if (!isPremium) return
    let alive = true

    setLoading(true)
    window.api.chat
      .history()
      .then((res) => {
        if (!alive) return
        if (res.ok && res.messages) {
          res.messages.forEach((m) => seenRef.current.add(m.id))
          setMessages(res.messages)
        } else setError(res.error ?? tRef.current('chat.error'))
      })
      .catch(() => alive && setError(tRef.current('chat.error')))
      .finally(() => alive && setLoading(false))

    const unsub = window.api.chat.onMessage((message) => {
      // Передоставка уже виденного сообщения не должна задваивать список и счётчик.
      if (seenRef.current.has(message.id)) return
      seenRef.current.add(message.id)
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
      // Считаем непрочитанным только новое чужое сообщение при закрытом чате.
      if (!openRef.current && message.userId !== myId) {
        setUnread((n) => n + 1)
      }
    })

    return () => {
      alive = false
      unsub()
      window.api.chat.unsubscribe()
    }
  }, [isPremium, myId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, open])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  if (!isPremium || !user) return null

  const send = async () => {
    const text = value.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    const res = await window.api.chat.send(text)
    setSending(false)
    if (res.ok) {
      setValue('') // само сообщение придёт обратно через realtime-подписку
    } else {
      setError(res.error ?? t('chat.error'))
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('chat.title')}
        className="premium-chat-widget fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/24 bg-app-card/95 text-accent shadow-[0_12px_38px_rgb(0_0_0_/_0.42)] no-drag"
      >
        <IconChat />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-[rgb(var(--btn-primary-text))] shadow-[0_0_12px_rgb(var(--ac)_/_0.7)]">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    )
  }

  return (
    <section className="premium-chat-panel fixed bottom-4 right-4 z-40 flex h-[420px] w-[320px] flex-col overflow-hidden rounded-2xl border border-app-border/70 bg-app-card/95 shadow-[0_20px_70px_rgb(0_0_0_/_0.58)] no-drag">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-app-border/50 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <IconChat />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-txt-primary">{t('chat.title')}</h2>
            <p className="truncate text-[10px] text-txt-muted">{t('chat.subtitle')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title={t('window.minimize')}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-txt-muted hover:bg-white/10 hover:text-txt-primary"
        >
          <IconMinus />
        </button>
      </header>

      <div ref={scrollRef} role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3.5">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-txt-muted">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-txt-muted/30 border-t-txt-muted" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-txt-muted">
            {error ?? t('chat.empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {messages.map((message) => {
              const mine = message.userId === myId
              return (
                <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={[
                      'max-w-[80%] rounded-2xl px-3 py-2 text-xs shadow-sm',
                      mine
                        ? 'bg-accent text-[rgb(var(--btn-primary-text))]'
                        : 'border border-app-border/70 bg-app-panel/70 text-txt-primary'
                    ].join(' ')}
                  >
                    {!mine && (
                      <div className="mb-0.5 text-[10px] font-bold text-accent/90">{message.author}</div>
                    )}
                    <div className="whitespace-pre-wrap break-words leading-relaxed">{message.text}</div>
                    <div className={`mt-1 text-[9px] ${mine ? 'opacity-70' : 'text-txt-muted'}`}>
                      {fmtTime(message.createdAt)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {error && !loading && messages.length > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex-shrink-0 border-t border-rose-500/20 bg-rose-500/10 px-3.5 py-1.5 text-[10px] text-rose-300"
        >
          {error}
        </div>
      )}

      <div className="flex-shrink-0 border-t border-app-border/50 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            maxLength={2000}
            placeholder={t('chat.placeholder')}
            className="input-field max-h-24 min-h-[40px] flex-1 resize-none py-2 text-xs"
          />
          <button
            onClick={() => void send()}
            disabled={!value.trim() || sending}
            title={t('chat.send')}
            className="btn-primary h-10 w-10 flex-shrink-0 px-0 disabled:opacity-40"
          >
            {sending ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current/40 border-t-current" />
            ) : (
              <IconSend />
            )}
          </button>
        </div>
      </div>
    </section>
  )
}
