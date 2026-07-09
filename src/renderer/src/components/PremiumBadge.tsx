import React from 'react'

/**
 * Верификационная галочка премиум-пользователя (п.6 ТЗ).
 *
 * Никаких текстовых плашек «Premium» — только кастомный SVG-значок: фигурная
 * «печать» с галочкой внутри, залитая золотым градиентом (совпадает с акцентом
 * премиум-карточек в PremiumActivation) — так значок узнаваем независимо от
 * акцентного цвета выбранной темы и не путается с обычными UI-элементами.
 * Рендерится строго по флагу `is_premium`, который отдаёт бэкенд; сам по себе
 * значок прав не даёт.
 */
export function PremiumBadge({
  size = 14,
  title = 'Премиум'
}: {
  size?: number
  title?: string
}): React.ReactElement {
  // Уникальный id градиента на каждый инстанс — чтобы несколько значков на странице
  // не «делили» один defs (иначе при перерисовке возможны артефакты заливки).
  const gradId = React.useId()
  return (
    <span
      className="premium-badge inline-flex flex-shrink-0 align-middle"
      style={{
        width: size,
        height: size,
        lineHeight: 0,
        filter: 'drop-shadow(0 0 3px rgba(250, 204, 21, 0.45))'
      }}
      title={title}
      aria-label={title}
      role="img"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fde68a" />
            <stop offset="0.55" stopColor="#facc15" />
            <stop offset="1" stopColor="#ca8a04" />
          </linearGradient>
        </defs>
        {/* Фигурная звёздчатая «печать» (verified seal). */}
        <path
          fill={`url(#${gradId})`}
          d="M12 1.6l2.35 1.72 2.9-.28 1.06 2.72 2.72 1.06-.28 2.9L22.4 12l-1.72 2.35.28 2.9-2.72 1.06-1.06 2.72-2.9-.28L12 22.4l-2.35-1.72-2.9.28-1.06-2.72-2.72-1.06.28-2.9L1.6 12l1.72-2.35-.28-2.9 2.72-1.06L8.75 3.04l2.9.28L12 1.6z"
        />
        {/* Галочка. */}
        <path
          d="M8 12.2l2.6 2.6L16 9.4"
          fill="none"
          stroke="#fff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

export default PremiumBadge
