import React, { useState } from 'react'
import { gradientFor } from '../utils/placeholderArt'

/** Иконка ноты/диска — нейтральный плейсхолдер для карточек без обложки. */
function IconDiscNote(): React.ReactElement {
  return (
    <svg width="38%" height="38%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="11" cy="17" r="3" />
      <path d="M14 17V4.5a1 1 0 0 1 1.28-.96l4 1.14A1 1 0 0 1 20 5.64V15" />
      <circle cx="17" cy="15" r="2.4" />
    </svg>
  )
}

export interface ImageWithFallbackProps {
  src?: string
  alt: string
  className: string
  style?: React.CSSProperties
  /** Уникальный идентификатор ассета — определяет градиент плейсхолдера (стабильно между рендерами). */
  seed: string
  /** Иконка типа контента поверх градиента (по умолчанию — нейтральный диск/нота). */
  icon?: React.ReactNode
}

/**
 * Обёртка над <img>: если src не задан или загрузка не удалась, вместо битой
 * картинки рендерится градиентный плейсхолдер (цвет зависит от seed) с иконкой
 * типа контента — вместо одного и того же серого блока для всех карточек.
 */
export function ImageWithFallback({ src, alt, className, style, seed, icon }: ImageWithFallbackProps): React.ReactElement {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div
        className={`${className} flex items-center justify-center select-none text-white/90`}
        style={{ background: gradientFor(seed), ...style }}
      >
        {icon ?? <IconDiscNote />}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}
