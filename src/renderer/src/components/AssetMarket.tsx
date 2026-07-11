import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { AssetKind, CommunityPlugin, InstallProgress, Plugin } from '../types'
import { useI18n } from '../i18n'
import { useSearch } from '../hooks/useSearch'
import { useUploadProgress } from '../hooks/useUploadProgress'
import { useEscapeToClose } from '../hooks/useEscapeToClose'
import {
  PluginCard, SkeletonCard, Empty, UploadSteps,
  IconRefresh, IconX,
  fmtTime,
  type CardLabels
} from './pluginCommon'
import { FileDropZone, Toast, type ToastType } from './FileDropZone'
import { HashtagInput } from './HashtagInput'

// ─── Конфигурация по типу контента ──────────────────────────────────────────

export interface AssetConfig {
  kind: AssetKind
  title: string
  /** Категории для фильтра и формы загрузки (без «Все»). */
  categories: string[]
  /** Поддерживаемые расширения для дроп-зоны. */
  accept: string
  fileHint: string
  /** Показывать ли поле «Версия» в форме загрузки. */
  hasVersion: boolean
  hasCover?: boolean
  /** Платный контент (биты): показывать поля цены/ссылки и кнопку «Купить». */
  isPaid?: boolean
  labels: CardLabels
  upload: { title: string; sub: string; cta: string }
  empty: { title: string; sub: string }
  /** Иконка файла в дроп-зоне. */
  fileIcon: React.ReactNode
}

const DOWNLOAD_LABELS: CardLabels = { action: 'Скачать', busy: 'Загрузка', done: '✓ Скачано' }
const ALL_CATEGORY = '__all__'

const IconFlp = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M9 13a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm2 0V9l4-1v4" />
  </svg>
)

const IconTemplate = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
  </svg>
)

const IconLoop = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
)

const IconDrum = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <ellipse cx="12" cy="7" rx="9" ry="3.5" />
    <path d="M3 7v8c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5V7" />
    <line x1="17" y1="9.5" x2="22" y2="3.5" /><line x1="7" y1="9.5" x2="2.5" y2="4" />
  </svg>
)

const IconBeatFile = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    <path d="M9 18V6l12-2v12" /><path d="M9 9l12-2" />
  </svg>
)

const IconPresetFile = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="5" y1="3" x2="5" y2="21" /><circle cx="5" cy="9" r="2.2" fill="currentColor" stroke="none" />
    <line x1="12" y1="3" x2="12" y2="21" /><circle cx="12" cy="15" r="2.2" fill="currentColor" stroke="none" />
    <line x1="19" y1="3" x2="19" y2="21" /><circle cx="19" cy="6" r="2.2" fill="currentColor" stroke="none" />
  </svg>
)

export const ASSET_CONFIGS: Record<AssetKind, AssetConfig> = {
  plugin: {
    kind: 'plugin', title: 'Плагины', categories: [], accept: '.zip', fileHint: '',
    hasVersion: true, labels: DOWNLOAD_LABELS,
    upload: { title: '', sub: '', cta: '' }, empty: { title: '', sub: '' }, fileIcon: IconFlp
  },
  flp: {
    kind: 'flp',
    title: 'FLP-проекты',
    categories: ['Hip-Hop', 'Trap', 'House', 'Techno', 'Pop', 'Lo-Fi', 'DnB', 'Ambient', 'Phonk', 'Other'],
    accept: '.flp,.zip',
    fileHint: '.flp или .zip с сэмплами',
    hasVersion: false,
    labels: DOWNLOAD_LABELS,
    upload: { title: 'Загрузить FLP-проект', sub: 'Поделитесь готовым проектом FL Studio', cta: 'Загрузить проект' },
    empty: { title: 'Пока нет проектов', sub: 'Загрузите первый .flp-проект для сообщества' },
    fileIcon: IconFlp
  },
  template: {
    kind: 'template',
    title: 'Тимплейты',
    categories: ['Mixing', 'Mastering', 'Beat', 'FX Chain', 'Vocal', 'Recording', 'Other'],
    accept: '.flp,.zip',
    fileHint: '.flp-тимплейт или .zip',
    hasVersion: false,
    hasCover: false,
    labels: DOWNLOAD_LABELS,
    upload: { title: 'Загрузить тимплейт', sub: 'Поделитесь тимплейтом проекта FL Studio', cta: 'Загрузить тимплейт' },
    empty: { title: 'Пока нет тимплейтов', sub: 'Загрузите первый тимплейт для сообщества' },
    fileIcon: IconTemplate
  },
  loop: {
    kind: 'loop',
    title: 'Лупы',
    categories: ['Drums', 'Bass', 'Melody', 'Vocal', 'Percussion', 'Synth', 'FX', 'Guitar', 'Other'],
    accept: '.wav,.mp3,.flac,.ogg,.zip',
    fileHint: 'WAV / MP3 / FLAC или .zip пак',
    hasVersion: false,
    labels: DOWNLOAD_LABELS,
    upload: { title: 'Загрузить луп', sub: 'Поделитесь сэмплом или паком лупов', cta: 'Загрузить луп' },
    empty: { title: 'Пока нет лупов', sub: 'Загрузите первый луп для сообщества' },
    fileIcon: IconLoop
  },
  drumkit: {
    kind: 'drumkit',
    title: 'Драм-киты',
    categories: ['Trap', 'Hip-Hop', 'House', 'Techno', 'Drill', 'Phonk', 'Lo-Fi', 'Pop', 'Afrobeat', 'Other'],
    accept: '.zip,.wav',
    fileHint: 'ZIP-пак с сэмплами',
    hasVersion: false,
    labels: DOWNLOAD_LABELS,
    upload: { title: 'Загрузить драм-кит', sub: 'Поделитесь паком ударных и сэмплов', cta: 'Загрузить кит' },
    empty: { title: 'Пока нет драм-китов', sub: 'Загрузите первый драм-кит для сообщества' },
    fileIcon: IconDrum
  },
  beat: {
    kind: 'beat',
    title: 'Биты',
    categories: ['Trap', 'Hip-Hop', 'Drill', 'Phonk', 'R&B', 'Pop', 'Afrobeat', 'Lo-Fi', 'House', 'Other'],
    accept: '.mp3,.wav',
    fileHint: 'MP3 / WAV, затем выберите 30 секунд',
    hasVersion: false,
    isPaid: true,
    labels: DOWNLOAD_LABELS,
    upload: { title: 'Добавить бит', sub: 'Загрузите трек, выберите 30 секунд, укажите цену и Telegram', cta: 'Добавить бит' },
    empty: { title: 'Пока нет битов', sub: 'Добавьте свой первый бит на продажу' },
    fileIcon: IconBeatFile
  },
  preset: {
    kind: 'preset',
    title: 'Пресеты',
    categories: ['Synth', 'Bass', 'Keys', 'Pad', 'Lead', 'FX', 'Vocal', 'Other'],
    accept: '.vstpreset,.fxp,.zip',
    fileHint: '.vstpreset / .fxp, опционально в .zip',
    hasVersion: false,
    hasCover: true,
    labels: DOWNLOAD_LABELS,
    upload: {
      title: 'Загрузить пресет',
      sub: 'Прикрепите файл настройки плагина и два готовых аудио для A/B-сравнения',
      cta: 'Загрузить пресет'
    },
    empty: { title: 'Пока нет пресетов', sub: 'Загрузите первый пресет для сообщества' },
    fileIcon: IconPresetFile
  }
}

// ─── Upload Modal ───────────────────────────────────────────────────────────

interface UploadForm {
  name: string
  version: string
  description: string
  category: string
  price: string
  paymentUrl: string
  tags: string[]
}

const BEAT_PREVIEW_SECONDS = 30

type BeatPreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function makePreviewFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'beat'
  return `${slug}-preview.wav`
}

function createAudioContext(errorMessage: string): AudioContext {
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

  if (!AudioContextCtor) {
    throw new Error(errorMessage)
  }

  return new AudioContextCtor()
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

function encodeWavPreview(buffer: AudioBuffer, startSec: number, durationSec: number): ArrayBuffer {
  const sampleRate = buffer.sampleRate
  const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels))
  const startFrame = Math.floor(startSec * sampleRate)
  const frameCount = Math.min(Math.round(durationSec * sampleRate), buffer.length - startFrame)
  const bytesPerSample = 2
  const blockAlign = channelCount * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = frameCount * blockAlign
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const channels = Array.from({ length: channelCount }, (_, ch) => buffer.getChannelData(ch))
  let offset = 44

  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = clamp(channels[ch][startFrame + frame] ?? 0, -1, 1)
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += bytesPerSample
    }
  }

  return out
}

function buildWaveformPeaks(buffer: AudioBuffer, barCount = 96): number[] {
  const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels))
  const channels = Array.from({ length: channelCount }, (_, ch) => buffer.getChannelData(ch))
  const samplesPerBar = Math.max(1, Math.floor(buffer.length / barCount))
  const peaks: number[] = []

  for (let i = 0; i < barCount; i++) {
    const start = i * samplesPerBar
    const end = i === barCount - 1 ? buffer.length : Math.min(buffer.length, start + samplesPerBar)
    const step = Math.max(1, Math.floor((end - start) / 180))
    let peak = 0

    for (let sample = start; sample < end; sample += step) {
      for (let ch = 0; ch < channelCount; ch++) {
        peak = Math.max(peak, Math.abs(channels[ch][sample] ?? 0))
      }
    }

    peaks.push(Math.pow(peak, 0.62))
  }

  const maxPeak = Math.max(...peaks, 0.01)
  return peaks.map((peak) => clamp(peak / maxPeak, 0.08, 1))
}

function UploadModal({ config, premium, onClose, onUploaded, notify }: {
  config: AssetConfig
  premium: boolean
  onClose: () => void
  onUploaded: () => void
  notify: (msg: string, type: ToastType) => void
}) {
  const { t } = useI18n()
  const showCover = config.hasCover !== false
  const [form, setForm] = useState<UploadForm>({
    name: '', version: '', description: '', category: config.categories[0] ?? 'Other',
    price: '', paymentUrl: '', tags: []
  })
  const [filePath, setFilePath] = useState<string | null>(null)
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [previewWetPath, setPreviewWetPath] = useState<string | null>(null)
  const [previewDryPath, setPreviewDryPath] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { progress, start, reset } = useUploadProgress()
  const [beatStatus, setBeatStatus] = useState<BeatPreviewStatus>('idle')
  const [beatError, setBeatError] = useState('')
  const [beatDuration, setBeatDuration] = useState(0)
  const [previewStart, setPreviewStart] = useState(0)
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([])
  const [previewElapsed, setPreviewElapsed] = useState(0)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewVolume, setPreviewVolume] = useState(1)

  useEscapeToClose(onClose)

  const update = <K extends keyof UploadForm>(k: K, v: UploadForm[K]) => setForm((p) => ({ ...p, [k]: v }))

  const maxPreviewStart = Math.max(0, beatDuration - BEAT_PREVIEW_SECONDS)
  const previewEnd = previewStart + BEAT_PREVIEW_SECONDS
  const selectionLeftPct = beatDuration ? (previewStart / beatDuration) * 100 : 0
  const selectionWidthPct = beatDuration ? (BEAT_PREVIEW_SECONDS / beatDuration) * 100 : 100
  const playbackPct = previewPlaying ? (previewElapsed / BEAT_PREVIEW_SECONDS) * 100 : 0
  const beatPreviewReady = !config.isPaid || (
    beatStatus === 'ready' &&
    !!audioBufferRef.current &&
    beatDuration >= BEAT_PREVIEW_SECONDS
  )
  const isValid =
    form.name.trim() !== '' &&
    form.description.trim() !== '' &&
    filePath !== null &&
    beatPreviewReady &&
    (!config.isPaid || (form.price.trim() !== '' && form.paymentUrl.trim() !== '')) &&
    (config.kind !== 'preset' || (previewWetPath !== null && previewDryPath !== null))

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause()
      }
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!config.isPaid) return

    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
      setPreviewPlaying(false)
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }

    audioBufferRef.current = null
    setBeatDuration(0)
    setPreviewStart(0)
    setWaveformPeaks([])
    setPreviewElapsed(0)
    setBeatError('')

    if (!filePath) {
      setBeatStatus('idle')
      return
    }

    let canceled = false
    setBeatStatus('loading')

    window.api.readAudioFile(filePath)
      .then(async (data) => {
        const audioContext = createAudioContext(t('asset.webAudioUnavailable'))
        try {
          const decoded = await audioContext.decodeAudioData(data.slice(0))
          if (canceled) return

          audioBufferRef.current = decoded
          setBeatDuration(decoded.duration)
          setWaveformPeaks(buildWaveformPeaks(decoded))
          setBeatStatus(decoded.duration >= BEAT_PREVIEW_SECONDS ? 'ready' : 'error')
          setBeatError(
            decoded.duration >= BEAT_PREVIEW_SECONDS
              ? ''
              : t('asset.beatTooShort')
          )
        } finally {
          void audioContext.close()
        }
      })
      .catch((err) => {
        if (canceled) return
        setBeatStatus('error')
        setBeatError(t('asset.readAudioError', { error: String(err instanceof Error ? err.message : err) }))
      })

    return () => { canceled = true }
  }, [config.isPaid, filePath, t])

  const togglePreview = () => {
    const audioBuffer = audioBufferRef.current
    if (!audioBuffer || beatStatus !== 'ready') return

    if (previewAudioRef.current && !previewAudioRef.current.paused) {
      previewAudioRef.current.pause()
      setPreviewPlaying(false)
      setPreviewElapsed(0)
      return
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current = null
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }

    const preview = encodeWavPreview(audioBuffer, previewStart, BEAT_PREVIEW_SECONDS)
    const url = URL.createObjectURL(new Blob([preview], { type: 'audio/wav' }))
    const audio = new Audio(url)
    audio.volume = previewVolume
    previewUrlRef.current = url
    setPreviewElapsed(0)
    audio.addEventListener('timeupdate', () => {
      setPreviewElapsed(clamp(audio.currentTime, 0, BEAT_PREVIEW_SECONDS))
    })
    audio.addEventListener('ended', () => {
      setPreviewPlaying(false)
      setPreviewElapsed(0)
      URL.revokeObjectURL(url)
      previewUrlRef.current = null
      if (previewAudioRef.current === audio) previewAudioRef.current = null
    })
    audio.addEventListener('pause', () => {
      setPreviewPlaying(false)
      if (!audio.ended) setPreviewElapsed(0)
    })
    previewAudioRef.current = audio
    audio.play()
      .then(() => setPreviewPlaying(true))
      .catch((err) => {
        URL.revokeObjectURL(url)
        previewUrlRef.current = null
        previewAudioRef.current = null
        setPreviewPlaying(false)
        setPreviewElapsed(0)
        notify(t('asset.playPreviewError', { error: String(err) }), 'error')
      })
  }

  const updatePreviewVolume = (value: number) => {
    const next = clamp(value, 0, 1)
    setPreviewVolume(next)
    if (previewAudioRef.current) {
      previewAudioRef.current.volume = next
      previewAudioRef.current.muted = next === 0
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || !filePath) return
    setSubmitting(true)
    const uploadId = start()
    try {
      const previewBuffer =
        config.isPaid && audioBufferRef.current
          ? encodeWavPreview(audioBufferRef.current, previewStart, BEAT_PREVIEW_SECONDS)
          : undefined

      const uploadOptions = previewBuffer
        ? {
            previewBuffer,
            previewFileName: makePreviewFileName(form.name),
            previewStartSec: previewStart,
            previewDurationSec: BEAT_PREVIEW_SECONDS
          }
        : config.kind === 'preset' && previewWetPath && previewDryPath
          ? { previewWetPath, previewDryPath }
          : undefined

      const res = await window.api.uploadAsset(
        config.kind,
        {
          name: form.name,
          version: config.hasVersion ? form.version : '',
          description: form.description,
          category: form.category,
          price: config.isPaid ? form.price.trim() : undefined,
          paymentUrl: config.isPaid ? telegramUrl(form.paymentUrl) : undefined,
          tags: form.tags
        },
        filePath,
        showCover ? iconPath ?? undefined : undefined,
        uploadOptions,
        uploadId
      )
      if (res.ok) {
        notify(t('asset.uploadSuccess', { name: form.name }), 'success')
        onUploaded()
        onClose()
      } else {
        notify(t('common.errorWithMessage', { error: res.error ?? t('plugin.unknownError') }), 'error')
      }
    } catch (err) {
      notify(t('common.unexpectedError', { error: String(err) }), 'error')
    } finally {
      setSubmitting(false)
      reset()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg max-h-[88vh] overflow-y-auto p-6 animate-slide-up no-drag"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold text-txt-primary">{config.upload.title}</h2>
            <p className="text-xs text-txt-muted mt-1">{config.upload.sub}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-txt-muted hover:text-txt-primary"
            style={{ transition: 'background 150ms, color 120ms' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <IconX />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-3">
            <div className={config.hasVersion ? 'col-span-2' : 'col-span-3'}>
              <label className="form-label">
                {t('common.name')} *
              </label>
              <input
                type="text" placeholder="Midnight Trap" value={form.name}
                onChange={(e) => update('name', e.target.value)} className="input-field" maxLength={80}
              />
            </div>
            {config.hasVersion && (
              <div>
                <label className="form-label">
                  {t('common.version')}
                </label>
                <input
                  type="text" placeholder="1.0" value={form.version}
                  onChange={(e) => update('version', e.target.value)} className="input-field" maxLength={20}
                />
              </div>
            )}
          </div>

          <div>
            <label className="form-label">
              {t('common.category')}
            </label>
            <select
              value={form.category}
              onChange={(e) => update('category', e.target.value)}
              className="select-field"
            >
              {config.categories.map((c) => <option key={c} value={c} className="bg-app-card">{c}</option>)}
            </select>
          </div>

          {config.isPaid && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label">
                  {t('common.price')} *
                </label>
                <input
                  type="text" placeholder={premium ? '20$' : '2$ – 15$'} value={form.price}
                  onChange={(e) => update('price', e.target.value)} className="input-field" maxLength={20}
                />
              </div>
              <div>
                <label className="form-label">
                  Telegram *
                </label>
                <input
                  type="text" placeholder="@username" value={form.paymentUrl}
                  onChange={(e) => update('paymentUrl', e.target.value)} className="input-field"
                />
              </div>
              {/* Free-авторы: цена строго $2–$15 и до 3 битов в месяц. Премиум — свободно. */}
              <p className="col-span-2 text-[11px] text-txt-muted -mt-1.5">
                {premium ? t('asset.buyerHint') : t('asset.freeBeatHint')}
              </p>
            </div>
          )}

          <div>
            <label className="form-label">
              {t('common.description')} *
            </label>
            <textarea
              placeholder={t('common.description')} value={form.description}
              onChange={(e) => update('description', e.target.value)}
              className="input-field resize-none h-24 leading-relaxed" maxLength={500}
            />
            <div className="text-right text-xs text-txt-muted mt-1">{form.description.length}/500</div>
          </div>

          <HashtagInput value={form.tags} onChange={(tags) => update('tags', tags)} disabled={submitting} />

          <div className={`grid gap-3 ${showCover ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <div>
              <label className="form-label">
                {t('common.file')} *
              </label>
              <FileDropZone
                label={t('common.dropToUpload')} accept={config.accept} value={filePath} onSelect={setFilePath}
                hint={config.fileHint}
                icon={config.fileIcon}
              />
            </div>
            {showCover && (
              <div>
                <label className="form-label">
                  {t('common.cover')}
                </label>
                <FileDropZone
                  label={t('common.cover')} accept=".png,.jpg,.jpeg,.webp" value={iconPath} onSelect={setIconPath}
                  hint="PNG / JPG, 128x128"
                  icon={
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
                    </svg>
                  }
                />
              </div>
            )}
          </div>

          {config.kind === 'preset' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label">
                  {t('preset.wetFile')} *
                </label>
                <FileDropZone
                  label={t('common.dropToUpload')} accept=".wav,.mp3,.flac,.ogg,.m4a,.aac"
                  value={previewWetPath} onSelect={setPreviewWetPath}
                  hint={t('preset.wetFileHint')}
                  icon={IconPresetFile}
                />
              </div>
              <div>
                <label className="form-label">
                  {t('preset.dryFile')} *
                </label>
                <FileDropZone
                  label={t('common.dropToUpload')} accept=".wav,.mp3,.flac,.ogg,.m4a,.aac"
                  value={previewDryPath} onSelect={setPreviewDryPath}
                  hint={t('preset.dryFileHint')}
                  icon={IconPresetFile}
                />
              </div>
            </div>
          )}

          {config.isPaid && (
            <div
              className="rounded-xl border p-3.5 space-y-3 overflow-hidden"
              style={{
                borderColor: beatStatus === 'ready' ? 'rgb(var(--ac) / 0.35)' : 'rgb(var(--bdr) / 0.65)',
                background:
                  'linear-gradient(160deg, rgb(var(--ac) / 0.08) 0%, transparent 36%), var(--ui-subtle)'
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-accent"
                      style={{ background: 'rgb(var(--ac) / 0.13)' }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 12h2l2-6 4 12 4-12 2 6h4" />
                      </svg>
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-txt-secondary uppercase tracking-wider">
                        {t('asset.selectPreview')} *
                      </p>
                      <p className="text-[11px] text-txt-muted mt-0.5">
                        {t('asset.previewPublishedOnly')}
                      </p>
                    </div>
                  </div>
                </div>
                {beatStatus === 'loading' && (
                  <span className="text-[11px] text-txt-muted flex items-center gap-1.5 px-2 py-1 rounded-lg border border-app-border/50">
                    <span className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                    {t('asset.analyzing')}
                  </span>
                )}
              </div>

              {!filePath ? (
                <div
                  className="h-24 rounded-xl border border-dashed flex items-center justify-center text-center px-5"
                  style={{ borderColor: 'rgb(var(--bdr) / 0.75)', background: 'rgb(var(--panel) / 0.35)' }}
                >
                  <p className="text-xs text-txt-muted">{t('asset.chooseAudio')}</p>
                </div>
              ) : beatStatus === 'error' ? (
                <div
                  className="rounded-xl border px-3 py-2.5 text-xs text-status-error"
                  style={{ borderColor: 'rgb(248 113 113 / 0.25)', background: 'rgb(248 113 113 / 0.07)' }}
                >
                  {beatError}
                </div>
              ) : beatStatus === 'ready' ? (
                <div className="space-y-3.5">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-xl border border-app-border/60 bg-app-panel/45 px-3 py-2">
                      <p className="text-[10px] text-txt-muted uppercase font-semibold tracking-wider">{t('asset.start')}</p>
                      <p className="text-sm font-semibold text-txt-primary tabular-nums mt-0.5">{fmtTime(previewStart)}</p>
                    </div>
                    <div className="rounded-xl border border-accent/30 px-3 py-2" style={{ background: 'rgb(var(--ac) / 0.10)' }}>
                      <p className="text-[10px] text-txt-muted uppercase font-semibold tracking-wider">{t('asset.preview')}</p>
                      <p className="text-sm font-semibold text-accent tabular-nums mt-0.5">{t('asset.seconds', { count: BEAT_PREVIEW_SECONDS })}</p>
                    </div>
                    <div className="rounded-xl border border-app-border/60 bg-app-panel/45 px-3 py-2 text-right">
                      <p className="text-[10px] text-txt-muted uppercase font-semibold tracking-wider">{t('asset.end')}</p>
                      <p className="text-sm font-semibold text-txt-primary tabular-nums mt-0.5">{fmtTime(previewEnd)}</p>
                    </div>
                  </div>

                  <div
                    className="relative rounded-xl border overflow-hidden px-3 py-4"
                    style={{
                      borderColor: 'rgb(var(--bdr) / 0.65)',
                      background: 'linear-gradient(180deg, rgb(var(--panel) / 0.72), rgb(var(--card) / 0.42))'
                    }}
                  >
                    <div className="absolute left-3 right-3 top-3 flex justify-between text-[10px] text-txt-muted tabular-nums">
                      <span>0:00</span>
                      <span>{fmtTime(beatDuration)}</span>
                    </div>

                    <div className="relative mt-5 h-20">
                      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-14 flex items-center gap-[2px]">
                        {waveformPeaks.map((peak, i) => {
                          const pct = waveformPeaks.length > 1 ? (i / (waveformPeaks.length - 1)) * 100 : 0
                          const active = pct >= selectionLeftPct && pct <= selectionLeftPct + selectionWidthPct
                          return (
                            <span
                              key={i}
                              className="flex-1 rounded-full"
                              style={{
                                height: `${Math.max(5, peak * 48)}px`,
                                background: active
                                  ? 'linear-gradient(180deg, rgb(var(--ac-h)), rgb(var(--ac)))'
                                  : 'rgb(var(--bdr-a) / 0.33)',
                                boxShadow: active ? '0 0 10px rgb(var(--ac) / 0.16)' : 'none'
                              }}
                            />
                          )
                        })}
                      </div>

                      <div className="absolute inset-y-0 left-0 rounded-l-xl bg-black/28 pointer-events-none" style={{ width: `${selectionLeftPct}%` }} />
                      <div
                        className="absolute inset-y-0 right-0 rounded-r-xl bg-black/28 pointer-events-none"
                        style={{ width: `${Math.max(0, 100 - selectionLeftPct - selectionWidthPct)}%` }}
                      />
                      <div
                        className="absolute inset-y-0 rounded-xl pointer-events-none"
                        style={{
                          left: `${selectionLeftPct}%`,
                          width: `${selectionWidthPct}%`,
                          border: '1px solid rgb(var(--ac) / 0.75)',
                          boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 0 22px rgb(var(--ac) / 0.18)'
                        }}
                      />
                      <div
                        className="absolute inset-y-0 w-px bg-white/80 pointer-events-none"
                        style={{ left: `calc(${selectionLeftPct}% + (${selectionWidthPct}% * ${playbackPct / 100}))` }}
                      />

                      <input
                        type="range"
                        min={0}
                        max={maxPreviewStart}
                        step={0.1}
                        value={previewStart}
                        aria-label={t('asset.selectPreview')}
                        onChange={(e) => {
                          if (previewAudioRef.current) {
                            previewAudioRef.current.pause()
                            previewAudioRef.current = null
                          }
                          if (previewUrlRef.current) {
                            URL.revokeObjectURL(previewUrlRef.current)
                            previewUrlRef.current = null
                          }
                          setPreviewPlaying(false)
                          setPreviewElapsed(0)
                          setPreviewStart(clamp(Number(e.target.value) || 0, 0, maxPreviewStart))
                        }}
                        className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-ew-resize"
                      />

                      <div
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 pointer-events-none"
                        style={{ left: `${selectionLeftPct}%` }}
                      >
                        <div
                          className="w-4 h-14 rounded-full border border-white/25"
                          style={{ background: 'linear-gradient(180deg, rgb(var(--ac-h)), rgb(var(--ac)))' }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <button type="button" onClick={togglePreview} className="btn-primary text-xs py-2 px-3 min-w-32">
                        {previewPlaying ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="5" width="4" height="14" rx="1" />
                            <rect x="14" y="5" width="4" height="14" rx="1" />
                          </svg>
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                        {previewPlaying ? t('asset.stop') : t('asset.listen')}
                      </button>
                      <div className="flex items-center gap-2 min-w-[132px]">
                        <span className="text-txt-muted">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                          </svg>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={previewVolume}
                          onChange={(e) => updatePreviewVolume(Number(e.target.value))}
                          aria-label={t('plugin.volume')}
                          className="range-slider w-24"
                          style={{ ['--range-value' as string]: `${previewVolume * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-[11px] text-txt-muted text-right leading-relaxed">
                      {t('asset.dragSelectionHint')}
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="h-24 rounded-xl border flex flex-col items-center justify-center gap-2"
                  style={{ borderColor: 'rgb(var(--bdr) / 0.65)', background: 'rgb(var(--panel) / 0.35)' }}
                >
                  <span className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                  <p className="text-xs text-txt-muted">{t('asset.preparingAudio')}</p>
                </div>
              )}
            </div>
          )}

          {(submitting || progress) && (
            <UploadSteps step={progress?.step} error={progress?.error} hasIcon={showCover && !!iconPath} />
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              className={`btn-primary min-w-32 ${!isValid || submitting ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t('plugin.downloading')}
                </>
              ) : config.upload.cta}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── AssetMarket ────────────────────────────────────────────────────────────

type LoadState = 'loading' | 'ok' | 'error'

/** Имя файла для скачивания: slug названия + расширение из URL. */
/** Можно ли проиграть файл прямо в браузере (одиночный аудио-файл, не архив). */
function previewableAudio(url: string): boolean {
  return /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(url.split('?')[0])
}

/** Привести ник/ссылку Telegram к виду https://t.me/username. */
function telegramUrl(input: string): string {
  const v = input.trim()
  if (/^https?:\/\//i.test(v)) return v
  const handle = v.replace(/^@/, '').replace(/^t\.me\//i, '')
  return `https://t.me/${handle}`
}

export default function AssetMarket({ kind }: { kind: AssetKind }) {
  const { t } = useI18n()
  const config = useMemo<AssetConfig>(() => {
    const baseConfig = ASSET_CONFIGS[kind]
    const downloadLabels: CardLabels = {
      action: t('plugin.download'),
      busy: t('plugin.downloading'),
      done: `✓ ${t('plugin.downloaded')}`
    }

    return {
      ...baseConfig,
      title: t(`asset.${kind}.title`),
      fileHint: baseConfig.fileHint ? t(`asset.${kind}.fileHint`) : '',
      labels: downloadLabels,
      upload: {
        title: t(`asset.${kind}.uploadTitle`),
        sub: t(`asset.${kind}.uploadSub`),
        cta: t(`asset.${kind}.uploadCta`)
      },
      empty: {
        title: t(`asset.${kind}.emptyTitle`),
        sub: t(`asset.${kind}.emptySub`)
      }
    }
  }, [kind, t])

  const [assets, setAssets]           = useState<CommunityPlugin[]>([])
  const [loadState, setLoadState]     = useState<LoadState>('loading')
  const { query: search, setQuery: setSearch } = useSearch()
  const [category, setCategory]       = useState(ALL_CATEGORY)
  const [progressMap, setProgressMap] = useState<Record<string, InstallProgress>>({})
  // Ассеты, по которым клик уже ушёл в handleDownload, но первый install:progress ещё
  // не пришёл — без этого кнопка остаётся активной все сетевые round-trip'ы до него.
  const [pendingIds, setPendingIds]   = useState<Set<string>>(new Set())
  const [userId, setUserId]           = useState<string | null>(null)
  const [isOwner, setIsOwner]         = useState(false)
  const [isPremium, setIsPremium]     = useState(false)
  const [showUpload, setShowUpload]   = useState(false)
  const [dropping, setDropping]       = useState(false)
  const [adding, setAdding]           = useState(false)
  const { progress: quickProgress, start: startQuick, reset: resetQuick } = useUploadProgress()
  const [toast, setToast]             = useState<{ message: string; type: ToastType } | null>(null)
  // Счётчик запросов: если пока грузился старый fetchAssets успел уйти и вернуться
  // более новый (например после публикации ассета), результат старого игнорируем.
  const fetchIdRef = useRef(0)

  const notify = useCallback((message: string, type: ToastType) => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 5000)
  }, [])

  const allCategories = [ALL_CATEGORY, ...Array.from(new Set(assets.map((a) => a.category))).sort()]

  const fetchAssets = useCallback(async () => {
    const requestId = ++fetchIdRef.current
    setLoadState('loading')
    try {
      const list = await window.api.listAssets(kind)
      if (fetchIdRef.current !== requestId) return
      setAssets(list)
      setLoadState('ok')
    } catch {
      if (fetchIdRef.current !== requestId) return
      setLoadState('error')
    }
  }, [kind])

  useEffect(() => {
    setSearch('')
    setCategory(ALL_CATEGORY)
    fetchAssets()
    window.api.auth.getState().then((s) => {
      setUserId(s.user?.id ?? null)
      setIsOwner(!!s.isOwner)
      setIsPremium(!!s.premium)
    })
    const unsub = window.api.onInstallProgress((p) => {
      setProgressMap((prev) => ({ ...prev, [p.pluginId]: p }))
      // Реальный прогресс пришёл — синхронный pending больше не нужен.
      setPendingIds((prev) => {
        if (!prev.has(p.pluginId)) return prev
        const next = new Set(prev)
        next.delete(p.pluginId)
        return next
      })
      if (p.step === 'done') {
        setAssets((prev) => prev.map((a) => (a.id === p.pluginId ? { ...a, installed: true } : a)))
        window.api.bumpCommunityDownload(p.pluginId)
      }
    })
    return unsub
  }, [fetchAssets])

  // Биты теперь может выкладывать любой вошедший юзер. Ограничения для free
  // (3 бита/мес, цена $2–$15) навешивает бэкенд; в форме — подсказка по цене.
  const openUpload = useCallback(() => {
    setShowUpload(true)
  }, [])

  const handleDownload = useCallback((asset: Plugin) => {
    const a = asset as CommunityPlugin
    // Блокируем повторные клики сразу, до ответа IPC — иначе за несколько сетевых
    // round-trip'ов до первого install:progress можно наплодить параллельных загрузок.
    setPendingIds((prev) => new Set(prev).add(a.id))
    const clearPending = () => setPendingIds((prev) => {
      if (!prev.has(a.id)) return prev
      const next = new Set(prev)
      next.delete(a.id)
      return next
    })
    window.api.downloadAsset(a.id).then(clearPending, clearPending)
  }, [])

  // Покупка бита: открываем ссылку оплаты автора в браузере.
  const handleBuy = useCallback((asset: Plugin) => {
    const a = asset as CommunityPlugin
    if (a.paymentUrl) {
      window.api.openExternal(a.paymentUrl)
      window.api.bumpCommunityDownload(a.id)   // считаем как интерес к биту
    } else {
      notify('Автор не указал ссылку для оплаты', 'error')
    }
  }, [notify])

  const handleDelete = useCallback(async (asset: Plugin) => {
    const res = await window.api.deleteCommunityPlugin(asset.id)
    if (res.ok) {
      setAssets((prev) => prev.filter((a) => a.id !== asset.id))
      notify(`«${asset.name}» удалён`, 'success')
    } else {
      notify(`Не удалось удалить: ${res.error}`, 'error')
    }
  }, [notify])

  // Быстрая загрузка перетаскиванием файлов прямо на вкладку: имя берём из
  // имени файла, категория — первая в списке. Полную форму даёт кнопка «Добавить бит».
  const acceptExts = config.accept.split(',').map((s) => s.trim().replace('.', '').toLowerCase())

  // Платный контент (биты) требует цену и ссылку, пресеты — два доп. аудиофайла:
  // оба доступны только через полную форму загрузки, не через quick drag-drop.
  const requiresFullForm = config.isPaid || config.kind === 'preset'

  const handleQuickDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    if (requiresFullForm) {
      notify('Биты добавляйте через «Добавить бит» — нужна цена и ссылка', 'error')
      return
    }
    const files = Array.from(e.dataTransfer.files) as (File & { path: string })[]
    const valid = files.filter((f) => acceptExts.includes((f.name.split('.').pop() ?? '').toLowerCase()))
    if (valid.length === 0) {
      notify(`Поддерживаются: ${config.accept}`, 'error')
      return
    }
    if (!userId) {
      notify('Войдите, чтобы загружать файлы', 'error')
      return
    }
    setAdding(true)
    let ok = 0
    for (const f of valid) {
      const name = f.name.replace(/\.[^.]+$/, '')
      const uploadId = startQuick()
      const res = await window.api.uploadAsset(
        kind,
        { name, version: '', description: '', category: config.categories[0] ?? 'Other' },
        f.path,
        undefined,
        undefined,
        uploadId
      )
      if (res.ok) ok++
      else notify(`«${name}»: ${res.error}`, 'error')
    }
    resetQuick()
    setAdding(false)
    if (ok > 0) {
      notify(ok === 1 ? 'Файл добавлен!' : `Добавлено файлов: ${ok}`, 'success')
      fetchAssets()
    }
  }, [acceptExts, config, kind, userId, notify, fetchAssets])

  const filtered = assets.filter((a) => {
    const q = search.toLowerCase()
    const matchesSearch =
      a.name.toLowerCase().includes(q) ||
      a.author.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      (a.tags ?? []).some((tag) => tag.toLowerCase().includes(q))

    return (
      matchesSearch &&
      (category === ALL_CATEGORY || a.category === category)
    )
  })

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div
        className="flex-shrink-0 border-b border-app-border/40 px-5 py-3"
        style={{
          backgroundColor: 'rgb(var(--panel) / 0.6)',
          backdropFilter: 'blur(16px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.3)'
        }}
      >
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-txt-primary flex-shrink-0">{config.title}</h1>

          <div className={`flex items-center gap-1.5 text-[11px] ${
            loadState === 'loading' ? 'text-txt-muted' : loadState === 'ok' ? 'text-status-success' : 'text-status-error'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              loadState === 'loading' ? 'bg-txt-muted animate-pulse' :
              loadState === 'ok' ? 'bg-status-success' : 'bg-status-error'
            }`} />
            <span className="hidden sm:inline">
              {loadState === 'loading' ? t('common.loading') : loadState === 'ok' ? t('common.online') : t('common.error')}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={fetchAssets}
              disabled={loadState === 'loading'}
              title={t('common.refresh')}
              className="p-1.5 rounded-lg text-txt-muted hover:text-txt-secondary no-drag disabled:opacity-30"
              style={{ transition: 'background 150ms, color 120ms' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <IconRefresh spin={loadState === 'loading'} />
            </button>
            <button
              onClick={openUpload}
              className="text-xs py-1.5 px-3 btn-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {config.upload.cta}
            </button>
          </div>
        </div>

        {assets.length > 0 && (
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            {allCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-medium no-drag ${
                  category === cat ? 'text-white' : 'text-txt-muted border border-app-border/60'
                }`}
                style={
                  category === cat
                    ? { background: 'rgb(var(--ac))', transition: 'background 150ms' }
                    : { transition: 'background 150ms, color 120ms, border-color 150ms' }
                }
                onMouseEnter={(e) => {
                  if (category !== cat) (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)'
                }}
                onMouseLeave={(e) => {
                  if (category !== cat) (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                {cat === ALL_CATEGORY ? t('common.all') : cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div
        className="relative flex-1 overflow-y-auto p-5"
        onDragOver={(e) => { if (requiresFullForm) return; e.preventDefault(); if (!dropping) setDropping(true) }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false) }}
        onDrop={requiresFullForm ? undefined : handleQuickDrop}
      >
        {/* Оверлей перетаскивания */}
        {(dropping || adding) && (
          <div
            className="absolute inset-3 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl
                       border-2 border-dashed pointer-events-none animate-fade-in"
            style={{
              borderColor: 'rgb(var(--ac) / 0.6)',
              background: 'rgb(var(--ac) / 0.06)'
            }}
          >
            {adding ? (
              <>
                <div className="w-7 h-7 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                <p className="text-sm font-medium text-txt-primary">
                  {quickProgress?.step === 'error'
                    ? (quickProgress.error ?? t('plugin.unknownError'))
                    : quickProgress?.step === 'upload'
                      ? t('upload.stepUpload')
                      : quickProgress?.step === 'icon'
                        ? t('upload.stepIcon')
                        : quickProgress?.step === 'publish'
                          ? t('upload.stepPublish')
                          : quickProgress?.step === 'done'
                            ? t('upload.stepDone')
                            : quickProgress?.step === 'validate'
                              ? t('upload.stepValidate')
                              : t('plugin.downloading')}
                </p>
              </>
            ) : (
              <>
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--ac))" strokeWidth="1.6">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <p className="text-sm font-medium text-txt-primary">{t('common.dropToUpload')}</p>
                <p className="text-xs text-txt-muted">{config.fileHint || config.accept}</p>
              </>
            )}
          </div>
        )}

        {loadState === 'loading' ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>

        ) : loadState === 'error' ? (
          <Empty
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>}
            title={t('asset.loadError')}
            sub={t('catalog.connectionHint')}
            action={<button onClick={fetchAssets} className="btn-ghost text-xs py-1.5 px-3">{t('common.retry')}</button>}
          />

        ) : filtered.length === 0 ? (
          <Empty
            icon={config.fileIcon}
            title={search ? t('catalog.notFound', { query: search }) : config.empty.title}
            sub={search ? undefined : requiresFullForm ? config.empty.sub : `${config.empty.sub} · ${t('common.orDragFilesHere')}`}
            action={search
              ? <button onClick={() => setSearch('')} className="text-xs text-accent hover:text-accent-hover no-drag">{t('common.clearSearch')}</button>
              : <button onClick={openUpload} className="btn-primary text-xs py-1.5 px-3">{config.upload.cta}</button>
            }
          />

        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4 animate-fade-in">
            {filtered.map((asset) => (
              <PluginCard
                key={asset.id}
                plugin={asset}
                progress={progressMap[asset.id] ?? null}
                pending={pendingIds.has(asset.id)}
                onInstall={handleDownload}
                onDelete={isOwner || asset.uploaderId === userId ? handleDelete : undefined}
                labels={config.labels}
                previewUrl={
                  (kind === 'loop' || kind === 'beat') && previewableAudio(asset.downloadUrl)
                    ? asset.downloadUrl
                    : undefined
                }
                previewLimitSec={kind === 'beat' ? BEAT_PREVIEW_SECONDS : undefined}
                previewWetUrl={kind === 'preset' ? asset.previewWetUrl : undefined}
                previewDryUrl={kind === 'preset' ? asset.previewDryUrl : undefined}
                price={config.isPaid ? asset.price : undefined}
                onBuy={config.isPaid ? handleBuy : undefined}
                fallbackIcon={config.fileIcon}
              />
            ))}
          </div>
        )}
      </div>

      {showUpload && (
        <UploadModal
          config={config}
          premium={isPremium}
          onClose={() => setShowUpload(false)}
          onUploaded={fetchAssets}
          notify={notify}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  )
}
