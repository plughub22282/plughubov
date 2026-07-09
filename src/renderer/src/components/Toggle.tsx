import React from 'react'

// ─── Toggle ───────────────────────────────────────────────────────────────────
// iOS-style свитч. Общий атом без зависимостей от других компонентов — переиспользуют
// Settings.tsx и AudioPlayer.tsx (последний, будучи импортируемым из pluginCommon.tsx,
// не может сам зависеть от pluginCommon.tsx без цикла импорта).
// size='sm' — компактный вариант для плотных рядов (напр. переключатель "Эффекты" в
// PresetComparePlayer), 'md' (по умолчанию) — как в Settings.

export function Toggle({ value, onChange, disabled, size = 'md' }: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  const track = size === 'sm' ? 'w-[34px] h-[18px]' : 'w-11 h-6'
  const thumb = size === 'sm' ? 'w-[14px] h-[14px]' : 'w-4 h-4'
  const onX = size === 'sm' ? 16 : 24
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!value) }}
      className={`relative inline-flex flex-shrink-0 ${track} rounded-full no-drag ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      }`}
      style={{
        background: value
          ? 'linear-gradient(180deg, rgb(var(--ac-h)), rgb(var(--ac)))'
          : 'rgb(var(--bdr))',
        boxShadow: value
          ? 'inset 0 1px 2px rgb(0 0 0 / 0.18), 0 0 12px rgb(var(--ac) / 0.28)'
          : 'inset 0 1px 2px rgb(0 0 0 / 0.28)',
        transition: 'background 200ms ease, box-shadow 200ms ease'
      }}
    >
      <span
        className={`absolute top-1 left-0 ${thumb} rounded-full bg-white`}
        style={{
          boxShadow: '0 1px 3px rgb(0 0 0 / 0.35)',
          transition: 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)',
          transform: value ? `translateX(${onX}px)` : 'translateX(4px)'
        }}
      />
    </button>
  )
}
