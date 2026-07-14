import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Toggle } from './Toggle'
import { stopAnyPreview, registerActivePreview } from './previewPlayback'
import { usePlayer, type PlayerTrack } from './PlayerBar'

/** Треугольный плейхед над waveform — чисто визуальный маркер текущей позиции. */
function PlayheadMarker({ pct }: { pct: number }): React.ReactElement {
  return (
    <svg
      className="pointer-events-none absolute z-10"
      style={{ left: `calc(${pct}% - 2px)`, top: '-3px' }}
      width="8" height="6" viewBox="0 0 8 6"
    >
      <path d="M0 0 L8 0 L4 6 Z" fill="rgb(var(--ac))" />
    </svg>
  )
}

function fmtTime(value: number): string {
  if (!isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function makeWaveform(seedValue: string, count = 72): number[] {
  let seed = 0
  for (let i = 0; i < seedValue.length; i++) {
    seed = (seed * 31 + seedValue.charCodeAt(i)) >>> 0
  }

  return Array.from({ length: count }, (_, index) => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const random = seed / 0xffffffff
    const shape = Math.sin((index / count) * Math.PI)
    const pulse = Math.sin(index * 0.56) * 0.16 + Math.sin(index * 0.19) * 0.12
    return Math.max(0.18, Math.min(1, 0.28 + shape * 0.5 + random * 0.3 + pulse))
  })
}

/**
 * Затухающая «рябь» по волне при наведении: бары рядом с курсором получают импульс
 * и гаснут экспоненциально через requestAnimationFrame — имитация физики звуковой волны.
 * Пишет напрямую в DOM (CSS-переменная --ripple), минуя React, чтобы не триггерить
 * ре-рендер на каждый кадр. Отключается целиком при prefers-reduced-motion.
 */
function attachWaveRipple(container: HTMLElement): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}

  const bars = Array.from(container.querySelectorAll<HTMLElement>('.wave-bar'))
  const barCount = bars.length / 2
  if (!barCount) return () => {}

  const energy = new Float32Array(barCount)
  const targetEnergy = new Float32Array(barCount)
  let rafId: number | null = null
  let lastX: number | null = null

  const tick = (): void => {
    let alive = false
    for (let i = 0; i < barCount; i++) {
      // Плавно тянемся к цели (новый импульс) и одновременно затухаем — без рывка на снимке.
      energy[i] += (targetEnergy[i] - energy[i]) * 0.35
      targetEnergy[i] *= 0.88
      if (energy[i] < 0.002 && targetEnergy[i] < 0.002) energy[i] = targetEnergy[i] = 0
      else alive = true
      const value = energy[i].toFixed(3)
      bars[i].style.setProperty('--ripple', value)
      bars[i + barCount].style.setProperty('--ripple', value)
    }
    rafId = alive ? requestAnimationFrame(tick) : null
    if (!alive) container.classList.remove('wave-rippling')
  }

  const onPointerMove = (event: PointerEvent): void => {
    // Игнорируем дрожание мыши на месте — эффект реагирует только на осмысленное движение.
    if (lastX !== null && Math.abs(event.clientX - lastX) < 2) return
    lastX = event.clientX

    const rect = container.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const center = ratio * (barCount - 1)
    const radius = 5
    const from = Math.max(0, Math.floor(center - radius))
    const to = Math.min(barCount - 1, Math.ceil(center + radius))
    for (let i = from; i <= to; i++) {
      const impulse = Math.max(0, 1 - Math.abs(i - center) / radius) * 0.55
      targetEnergy[i] = Math.max(targetEnergy[i], impulse)
    }
    container.classList.add('wave-rippling')
    if (rafId === null) rafId = requestAnimationFrame(tick)
  }

  container.addEventListener('pointermove', onPointerMove)
  return () => {
    container.removeEventListener('pointermove', onPointerMove)
    if (rafId !== null) cancelAnimationFrame(rafId)
    container.classList.remove('wave-rippling')
  }
}

function IconPlay(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function IconPause(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

function IconVolume({ level }: { level: number }): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
      {level === 0 ? (
        <>
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : level < 0.5 ? (
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      ) : (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  )
}

export interface AudioPlayerBarProps {
  url: string
  track?: Omit<PlayerTrack, 'url'>
  onDuration?: (duration: number) => void
  limitSec?: number
  /** Вызывается один раз при первом старте воспроизведения — учёт прослушивания для ленты. */
  onPlay?: () => void
}

export function AudioPlayerBar({ url, track, onDuration, limitSec, onPlay }: AudioPlayerBarProps): React.ReactElement {
  const { t } = useI18n()
  const {
    current,
    playing: playerPlaying,
    loading: playerLoading,
    currentTime: playerCurrentTime,
    duration: playerDuration,
    volume,
    playTrack,
    togglePlay,
    seekTo,
    setVolume
  } = usePlayer()
  const reportedRef = useRef(false)
  const lastVolumeRef = useRef(volume || 1)
  const waveform = useRef(makeWaveform(url))
  const waveRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const el = waveRef.current
    if (!el) return
    return attachWaveRipple(el)
  }, [])

  if (volume > 0) lastVolumeRef.current = volume
  const trackLimitSec = limitSec ?? track?.limitSec
  const playerTrack: PlayerTrack = {
    id: track?.id ?? url,
    title: track?.title ?? t('plugin.previewOnly'),
    author: track?.author ?? '',
    iconUrl: track?.iconUrl,
    category: track?.category,
    tab: track?.tab,
    url,
    limitSec: trackLimitSec
  }
  const isCurrent = current?.id === playerTrack.id && current.url === playerTrack.url
  const playing = isCurrent && playerPlaying
  const loading = isCurrent && playerLoading
  const currentTime = isCurrent ? playerCurrentTime : 0
  const duration = isCurrent ? playerDuration : 0
  const limited = !!trackLimitSec && trackLimitSec > 0
  const effectiveDuration = limited ? Math.min(trackLimitSec as number, duration || (trackLimitSec as number)) : duration
  const effectiveVolume = volume
  const timelinePct = effectiveDuration ? (currentTime / effectiveDuration) * 100 : 0

  useEffect(() => {
    if (isCurrent && effectiveDuration > 0) onDuration?.(effectiveDuration)
  }, [isCurrent, effectiveDuration, onDuration])

  useEffect(() => {
    reportedRef.current = false
  }, [url])

  useEffect(() => {
    if (!isCurrent || !playing || reportedRef.current) return
    reportedRef.current = true
    onPlay?.()
  }, [isCurrent, playing, onPlay])

  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation()

    if (isCurrent) {
      togglePlay()
      return
    }

    playTrack(playerTrack)
  }

  const seekToRatio = (ratio: number) => {
    if (!isCurrent || !effectiveDuration) return
    const next = Math.min(effectiveDuration, Math.max(0, ratio * effectiveDuration))
    seekTo(next)
  }

  const seek = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    seekToRatio((event.clientX - rect.left) / rect.width)
  }

  const applyVolume = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value)
    setVolume(next)
  }

  const toggleMute = (event: React.MouseEvent) => {
    event.stopPropagation()

    setVolume(volume === 0 ? (lastVolumeRef.current || 1) : 0)
  }

  const volumeControl = (
    <div className="volume-control flex flex-shrink-0 items-center rounded-full border border-transparent bg-transparent px-1 py-1">
      <button
        onClick={toggleMute}
        title={t('plugin.volume')}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-txt-muted hover:text-txt-primary"
      >
        <IconVolume level={effectiveVolume} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={effectiveVolume}
        onChange={applyVolume}
        aria-label={t('plugin.volume')}
        className="volume-range-clean"
        style={{ ['--range-value' as string]: `${effectiveVolume * 100}%` }}
      />
    </div>
  )

  return (
    <div
      className="audio-player flex items-center gap-2.5 rounded-xl border border-app-border/70 bg-app-panel/40 px-2.5 py-2 no-drag"
      onClick={(event) => event.stopPropagation()}
    >
      {/* Play / Pause */}
      <button
        onClick={toggle}
        title={playing ? t('plugin.pause') : t('plugin.play')}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[rgb(var(--btn-primary-text))] shadow-[0_6px_16px_rgb(0_0_0_/_0.3)] transition-transform active:scale-95"
      >
        {loading ? (
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/35 border-t-current" />
        ) : playing ? <IconPause /> : <IconPlay />}
      </button>

      {/* Waveform — кликабельная дорожка для перемотки */}
      <button
        ref={waveRef}
        type="button"
        onPointerDown={seek}
        onPointerMove={(event) => {
          if (event.buttons === 1) seek(event)
        }}
        disabled={!isCurrent || !effectiveDuration}
        aria-label={t('plugin.timeline')}
        className="soundcloud-wave relative h-10 min-w-0 flex-1 rounded-lg px-1.5 disabled:cursor-default disabled:opacity-50"
      >
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/8" />
        <span className="wave-layer wave-layer-muted">
          {waveform.current.map((height, index) => (
            <span
              key={`muted-${index}`}
              className="wave-bar"
              style={{ height: `${Math.round(8 + height * 24)}px` }}
            />
          ))}
        </span>
        <span
          className="wave-layer wave-layer-active"
          style={{ clipPath: `inset(0 ${Math.max(0, 100 - timelinePct)}% 0 0)` }}
        >
          {waveform.current.map((height, index) => (
            <span
              key={`active-${index}`}
              className="wave-bar"
              style={{ height: `${Math.round(8 + height * 24)}px` }}
            />
          ))}
        </span>
        <span
          className="pointer-events-none absolute bottom-1 top-1 w-px rounded-full bg-accent"
          style={{ left: `calc(${timelinePct}% + 2px)` }}
        />
        <PlayheadMarker pct={timelinePct} />
      </button>

      {/* Тайминг: прошло / всего */}
      <span className="flex-shrink-0 whitespace-nowrap text-2xs tabular-nums text-txt-muted">
        <span className="text-txt-secondary">{fmtTime(currentTime)}</span>
        <span className="opacity-50"> / {fmtTime(effectiveDuration)}</span>
      </span>

      {/* Громкость — раскрывается по наведению */}
      {volumeControl}

      {limited && (
        <span
          className="flex-shrink-0 rounded bg-accent/12 px-1 py-0.5 text-2xs font-semibold uppercase tracking-wide text-accent"
          title={t('plugin.previewOnly')}
        >
          {t('plugin.previewShort', { seconds: trackLimitSec as number })}
        </span>
      )}
    </div>
  )
}

export interface PresetComparePlayerProps {
  wetUrl: string
  dryUrl: string
  onDuration?: (duration: number) => void
  /** Плавающие бейджи-стикеры над плеером (напр. категория/тег пресета), до 2 шт. */
  stickers?: string[]
  /** Вызывается один раз при первом старте воспроизведения — учёт прослушивания для ленты. */
  onPlay?: () => void
}

/**
 * A/B-плеер для пресетов: два синхронных <audio> (с эффектами / без), один общий
 * play/pause/seek. Переключение режима — не смена src и не seek, а мгновенный своп
 * volume между wet- и dry-элементом (оба всё время играют) — так сравнение звучит
 * «вживую», без щелчков и перемотки.
 */
export function PresetComparePlayer({ wetUrl, dryUrl, onDuration, stickers, onPlay }: PresetComparePlayerProps): React.ReactElement {
  const { t } = useI18n()
  const wetRef = useRef<HTMLAudioElement | null>(null)
  const dryRef = useRef<HTMLAudioElement | null>(null)
  const reportedRef = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [mode, setMode] = useState<'wet' | 'dry'>('wet')
  const waveform = useRef(makeWaveform(wetUrl))
  const waveRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const el = waveRef.current
    if (!el) return
    return attachWaveRipple(el)
  }, [])

  const effectiveVolume = muted ? 0 : volume
  const timelinePct = duration ? (currentTime / duration) * 100 : 0

  const applyVolumes = (vol: number, activeMode: 'wet' | 'dry') => {
    if (wetRef.current) wetRef.current.volume = activeMode === 'wet' ? vol : 0
    if (dryRef.current) dryRef.current.volume = activeMode === 'dry' ? vol : 0
  }

  const ensureAudio = (): { wet: HTMLAudioElement; dry: HTMLAudioElement } => {
    if (wetRef.current && dryRef.current) return { wet: wetRef.current, dry: dryRef.current }

    const wet = new Audio(wetUrl)
    const dry = new Audio(dryUrl)
    wet.preload = 'auto'
    dry.preload = 'auto'
    wet.volume = mode === 'wet' ? volume : 0
    dry.volume = mode === 'dry' ? volume : 0

    wet.addEventListener('loadedmetadata', () => {
      setDuration((prev) => Math.max(prev, wet.duration || 0))
      onDuration?.(wet.duration || 0)
    })
    dry.addEventListener('loadedmetadata', () => {
      setDuration((prev) => Math.max(prev, dry.duration || 0))
    })
    // wet — общий таймер обоих клипов; dry лишь изредка подравнивается по нему,
    // чтобы не накапливался слышимый рассинхрон при долгом воспроизведении.
    wet.addEventListener('timeupdate', () => {
      setCurrentTime(wet.currentTime)
      if (Math.abs(dry.currentTime - wet.currentTime) > 0.15) {
        dry.currentTime = wet.currentTime
      }
    })
    wet.addEventListener('ended', () => {
      setCurrentTime(0)
      setPlaying(false)
      dry.pause()
      dry.currentTime = 0
    })
    wet.addEventListener('playing', () => {
      setLoading(false)
      setPlaying(true)
      if (!reportedRef.current) {
        reportedRef.current = true
        onPlay?.()
      }
    })
    wet.addEventListener('waiting', () => setLoading(true))
    wet.addEventListener('pause', () => setPlaying(false))
    wet.addEventListener('error', () => {
      setLoading(false)
      setPlaying(false)
    })

    wetRef.current = wet
    dryRef.current = dry
    return { wet, dry }
  }

  useEffect(() => {
    return () => {
      wetRef.current?.pause()
      dryRef.current?.pause()
      if (wetRef.current) wetRef.current.src = ''
      if (dryRef.current) dryRef.current.src = ''
    }
  }, [])

  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation()
    const { wet, dry } = ensureAudio()

    if (playing) {
      wet.pause()
      dry.pause()
      return
    }

    stopAnyPreview()
    registerActivePreview(() => {
      wet.pause()
      dry.pause()
    })
    setLoading(true)
    dry.currentTime = wet.currentTime
    Promise.all([wet.play(), dry.play()]).then(() => setPlaying(true)).catch(() => setLoading(false))
  }

  const seekToRatio = (ratio: number) => {
    if (!duration) return
    const next = Math.min(duration, Math.max(0, ratio * duration))
    const { wet, dry } = ensureAudio()
    wet.currentTime = next
    dry.currentTime = next
    setCurrentTime(next)
  }

  const seek = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    seekToRatio((event.clientX - rect.left) / rect.width)
  }

  const applyVolume = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value)
    setVolume(next)
    setMuted(next === 0)
    applyVolumes(next, mode)
  }

  const toggleMute = (event: React.MouseEvent) => {
    event.stopPropagation()

    if (muted || volume === 0) {
      const next = volume === 0 ? 1 : volume
      setMuted(false)
      setVolume(next)
      applyVolumes(next, mode)
      return
    }

    setMuted(true)
    applyVolumes(0, mode)
  }

  const switchMode = (next: 'wet' | 'dry') => {
    ensureAudio()
    if (next === mode) return
    setMode(next)
    applyVolumes(effectiveVolume, next)
  }

  const volumeControl = (
    <div className="volume-control flex flex-shrink-0 items-center rounded-full border border-transparent bg-transparent px-1 py-1">
      <button
        onClick={toggleMute}
        title={t('plugin.volume')}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-txt-muted hover:text-txt-primary"
      >
        <IconVolume level={effectiveVolume} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={effectiveVolume}
        onChange={applyVolume}
        aria-label={t('plugin.volume')}
        className="volume-range-clean"
        style={{ ['--range-value' as string]: `${effectiveVolume * 100}%` }}
      />
    </div>
  )

  const player = (
    <div
      className="audio-player flex items-center gap-2.5 rounded-xl border border-app-border/70 bg-app-panel/40 px-2.5 py-2 no-drag"
      onClick={(event) => event.stopPropagation()}
    >
      {/* Play / Pause */}
      <button
        onClick={toggle}
        title={playing ? t('plugin.pause') : t('plugin.play')}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[rgb(var(--btn-primary-text))] shadow-[0_6px_16px_rgb(0_0_0_/_0.3)] transition-transform active:scale-95"
      >
        {loading ? (
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/35 border-t-current" />
        ) : playing ? <IconPause /> : <IconPlay />}
      </button>

      {/* Waveform — кликабельная дорожка для перемотки */}
      <button
        ref={waveRef}
        type="button"
        onPointerDown={seek}
        onPointerMove={(event) => {
          if (event.buttons === 1) seek(event)
        }}
        disabled={!duration}
        aria-label={t('plugin.timeline')}
        className="soundcloud-wave relative h-10 min-w-0 flex-1 rounded-lg px-1.5 disabled:cursor-default disabled:opacity-50"
      >
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/8" />
        <span className="wave-layer wave-layer-muted">
          {waveform.current.map((height, index) => (
            <span
              key={`muted-${index}`}
              className="wave-bar"
              style={{ height: `${Math.round(8 + height * 24)}px` }}
            />
          ))}
        </span>
        <span
          className="wave-layer wave-layer-active"
          style={{ clipPath: `inset(0 ${Math.max(0, 100 - timelinePct)}% 0 0)` }}
        >
          {waveform.current.map((height, index) => (
            <span
              key={`active-${index}`}
              className="wave-bar"
              style={{ height: `${Math.round(8 + height * 24)}px` }}
            />
          ))}
        </span>
        <span
          className="pointer-events-none absolute bottom-1 top-1 w-px rounded-full bg-accent"
          style={{ left: `calc(${timelinePct}% + 2px)` }}
        />
        <PlayheadMarker pct={timelinePct} />
      </button>

      {/* Тайминг: прошло / всего */}
      <span className="flex-shrink-0 whitespace-nowrap text-2xs tabular-nums text-txt-muted">
        <span className="text-txt-secondary">{fmtTime(currentTime)}</span>
        <span className="opacity-50"> / {fmtTime(duration)}</span>
      </span>

      {/* Переключатель «с эффектами / без» — тумблер, своп volume, звук не прерывается */}
      <div
        className="flex flex-shrink-0 items-center gap-1.5"
        title={mode === 'wet' ? t('preset.wet') : t('preset.dry')}
      >
        <span className="text-2xs font-medium text-txt-muted">{t('preset.effects')}</span>
        <Toggle
          size="sm"
          value={mode === 'wet'}
          onChange={(v) => switchMode(v ? 'wet' : 'dry')}
        />
      </div>

      {/* Громкость — раскрывается по наведению */}
      {volumeControl}
    </div>
  )

  return stickers && stickers.length > 0 ? (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5 px-0.5">
        {stickers.slice(0, 2).map((label) => (
          <span
            key={label}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium select-none"
            style={{
              color: 'rgb(var(--ac))',
              background: 'rgb(var(--ac) / 0.12)',
              border: '1px solid rgb(var(--ac) / 0.28)'
            }}
          >
            {label}
          </span>
        ))}
      </div>
      {player}
    </div>
  ) : player
}

export default AudioPlayerBar
