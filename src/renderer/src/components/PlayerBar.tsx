import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume1, Volume2, VolumeX, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { stopAnyPreview, registerActivePreview } from './AudioPlayer'
import { ImageWithFallback } from './ImageWithFallback'

export interface PlayerTrack {
  id: string
  title: string
  author: string
  iconUrl?: string
  url: string
}

interface PlayerCtx {
  current: PlayerTrack | null
  playing: boolean
  currentTime: number
  duration: number
  volume: number
  playTrack: (track: PlayerTrack) => void
  togglePlay: () => void
  seekTo: (sec: number) => void
  setVolume: (v: number) => void
  close: () => void
}

const Ctx = createContext<PlayerCtx | null>(null)

/**
 * Единственный на всё приложение <audio> для глобального мини-плеера ("В тренде"
 * на дашборде «Главная») — переживает смену вкладок, в отличие от превью-плееров
 * внутри карточек (AudioPlayerBar/PresetComparePlayer), которые размонтируются
 * вместе с карточкой. Взаимно останавливает и останавливается card-превью через
 * stopAnyPreview/registerActivePreview (см. AudioPlayer.tsx) — звучит только один трек.
 */
export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [current, setCurrent] = useState<PlayerTrack | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(1)

  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current
    const audio = new Audio()
    audio.volume = volume
    audio.addEventListener('loadedmetadata', () => setDuration(audio.duration || 0))
    audio.addEventListener('timeupdate', () => setCurrentTime(audio.currentTime))
    audio.addEventListener('ended', () => { setPlaying(false); setCurrentTime(0) })
    audio.addEventListener('playing', () => setPlaying(true))
    audio.addEventListener('pause', () => setPlaying(false))
    audioRef.current = audio
    return audio
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const playTrack = useCallback((track: PlayerTrack) => {
    const audio = ensureAudio()
    stopAnyPreview()
    registerActivePreview(() => audio.pause())
    setCurrent((prev) => {
      if (prev?.id !== track.id) {
        audio.src = track.url
        setCurrentTime(0)
        setDuration(0)
      }
      return track
    })
    audio.play().catch(() => setPlaying(false))
  }, [ensureAudio])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    if (playing) {
      audio.pause()
    } else {
      stopAnyPreview()
      registerActivePreview(() => audio.pause())
      audio.play().catch(() => {})
    }
  }, [playing, current])

  const seekTo = useCallback((sec: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = sec
    setCurrentTime(sec)
  }, [])

  const setVolume = useCallback((v: number) => {
    setVolumeState(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [])

  const close = useCallback(() => {
    audioRef.current?.pause()
    setCurrent(null)
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [])

  useEffect(() => {
    return () => { audioRef.current?.pause() }
  }, [])

  return (
    <Ctx.Provider value={{ current, playing, currentTime, duration, volume, playTrack, togglePlay, seekTo, setVolume, close }}>
      {children}
    </Ctx.Provider>
  )
}

export function usePlayer(): PlayerCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider')
  return ctx
}

function fmt(value: number): string {
  if (!isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const sliderThumbClasses =
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-0 [&::-webkit-slider-thumb]:w-0 ' +
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-zinc-200 ' +
  '[&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.5)] [&::-webkit-slider-thumb]:transition-all ' +
  'hover:[&::-webkit-slider-thumb]:h-3 hover:[&::-webkit-slider-thumb]:w-3 ' +
  '[&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:h-0 [&::-moz-range-thumb]:w-0 ' +
  '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-zinc-200 ' +
  '[&::-moz-range-thumb]:transition-all hover:[&::-moz-range-thumb]:h-3 hover:[&::-moz-range-thumb]:w-3'

/** Видимый бар — рендерить безусловно (как PremiumChat), сам решает, показываться ли. */
export function PlayerBar(): React.ReactElement | null {
  const { t } = useI18n()
  const { current, playing, currentTime, duration, volume, togglePlay, seekTo, setVolume, close } = usePlayer()
  // Громкость на момент mute — чтобы клик по иконке восстанавливал прежний уровень, а не всегда 100%.
  const lastVolumeRef = useRef(volume || 1)
  if (volume > 0) lastVolumeRef.current = volume

  if (!current) return null

  const pct = duration ? (currentTime / duration) * 100 : 0
  const volumePct = Math.round(volume * 100)

  const seek = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!duration) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    seekTo(ratio * duration)
  }

  const toggleMute = () => {
    if (volume > 0) setVolume(0)
    else setVolume(lastVolumeRef.current || 1)
  }

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div
      className="no-drag fixed bottom-4 left-4 right-24 z-30 flex items-center gap-4 rounded-2xl border border-app-border/50 px-4 py-3 shadow-[0_12px_38px_rgb(0_0_0_/_0.35)]"
      style={{
        backgroundColor: 'rgb(var(--panel) / 0.92)',
        backdropFilter: 'blur(18px) saturate(1.3)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.3)'
      }}
    >
      {/* Трек */}
      <div className="flex w-52 min-w-0 flex-shrink-0 items-center gap-2.5">
        <ImageWithFallback
          src={current.iconUrl}
          alt={current.title}
          seed={current.id}
          className="h-11 w-11 flex-shrink-0 rounded-xl object-cover"
        />
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-txt-primary">{current.title}</p>
          <p className="truncate text-[10px] text-txt-muted">{current.author}</p>
        </div>
      </div>

      {/* Play/pause + таймлайн */}
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1.5">
        <button
          onClick={togglePlay}
          title={playing ? t('plugin.pause') : t('plugin.play')}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[rgb(var(--btn-primary-text))] shadow-[0_4px_12px_rgb(0_0_0_/_0.3)] transition hover:scale-105 hover:shadow-[0_4px_16px_rgb(0_0_0_/_0.4)]"
        >
          {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
        </button>
        <div className="flex w-full max-w-xl items-center gap-2">
          <span className="w-9 flex-shrink-0 text-right text-[10px] tabular-nums text-txt-muted">{fmt(currentTime)}</span>
          <button
            type="button"
            onPointerDown={seek}
            onPointerMove={(event) => { if (event.buttons === 1) seek(event) }}
            disabled={!duration}
            aria-label={t('plugin.timeline')}
            className="group relative h-1.5 flex-1 overflow-hidden rounded-full bg-app-panel transition-all hover:h-2 disabled:opacity-50"
          >
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </button>
          <span className="w-9 flex-shrink-0 text-[10px] tabular-nums text-txt-muted">{fmt(duration)}</span>
        </div>
      </div>

      {/* Громкость — компактный слайдер фиксированной ширины (как в эталоне);
          w-20 + min-w-0 не дают нативному range с его дефолтной шириной ~129px
          вылезти за правый край панели. */}
      <div className="flex flex-shrink-0 items-center gap-2 pr-1">
        <button
          onClick={toggleMute}
          title={volume === 0 ? t('plugin.unmute') : t('plugin.mute')}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-txt-muted transition hover:bg-white/10 hover:text-txt-primary"
        >
          <VolumeIcon size={15} />
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={volumePct}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          aria-label={t('plugin.volume')}
          className={`h-1 w-20 min-w-0 flex-shrink-0 cursor-pointer appearance-none rounded-full bg-zinc-700 transition-all ${sliderThumbClasses}`}
          style={{ background: `linear-gradient(90deg, rgb(244 244 245) 0%, rgb(244 244 245) ${volumePct}%, rgb(63 63 70) ${volumePct}%, rgb(63 63 70) 100%)` }}
        />
      </div>

      {/* Крестик закрытия вынесен в угол бейджем — иначе он стоит вплотную к слайдеру
          громкости и промах мимо тонкого ползунка захлопывает весь плеер. */}
      <button
        onClick={close}
        title={t('window.close')}
        className="absolute -top-2.5 -right-2.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-app-border/70 bg-app-card text-txt-muted shadow-[0_4px_10px_rgb(0_0_0_/_0.4)] transition hover:border-red-500/50 hover:bg-red-500/90 hover:text-white"
      >
        <X size={12} />
      </button>
    </div>
  )
}
