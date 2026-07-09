import React, { useEffect, useMemo } from 'react'
import type { Tab } from '../types'
import { useI18n } from '../i18n'
import { useLibraryIndex } from '../hooks/useLibraryIndex'

interface GlobalSearchDropdownProps {
  query: string
  onNavigate: (tab: Tab) => void
  /** Клик по результату: закрыть дропдаун и очистить строку поиска. */
  onSelect: () => void
}

function initialsOf(name: string): string {
  return name.split(' ').slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
}

/**
 * Выпадающий список результатов поиска по ВСЕМ разделам сразу (Каталог, Маркетплейс,
 * все виды ассетов) — быстрый переход в другой раздел прямо из текущей вкладки.
 * Аддитивно поверх локальной фильтрации: сама вкладка под дропдауном по-прежнему
 * фильтрует свой грид тем же query, как раньше — дропдаун лишь предлагает быстрый
 * переход, если нужное лежит в другом разделе.
 */
export default function GlobalSearchDropdown({ query, onNavigate, onSelect }: GlobalSearchDropdownProps) {
  const { t } = useI18n()
  const { items, ensureLoaded } = useLibraryIndex()

  useEffect(() => {
    ensureLoaded()
  }, [ensureLoaded])

  const q = query.trim().toLowerCase()

  const results = useMemo(() => {
    if (!q) return []
    return items
      .filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.author.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q)
      )
      .slice(0, 8)
  }, [items, q])

  if (!q) return null

  return (
    <div
      className="card absolute top-full left-0 right-0 mt-2 max-h-80 overflow-y-auto p-1.5 animate-fade-in no-drag"
      style={{ zIndex: 60 }}
      // Предотвращает blur инпута при клике — иначе дропдаун закрылся бы раньше onClick.
      onMouseDown={(e) => e.preventDefault()}
    >
      {results.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-txt-muted">{t('catalog.notFound', { query })}</p>
      ) : (
        results.map((item) => (
          <button
            key={`${item.tab}-${item.id}`}
            onClick={() => {
              onNavigate(item.tab)
              onSelect()
            }}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left"
            style={{ transition: 'background 120ms ease' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ui-hover)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            {item.iconUrl ? (
              <img src={item.iconUrl} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
            ) : (
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-[11px] font-semibold"
                style={{ background: 'rgb(var(--ac) / 0.15)', color: 'rgb(var(--ac))' }}
              >
                {initialsOf(item.name)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-txt-primary truncate">{item.name}</p>
              <span className="text-[10px] text-txt-muted">{t(`nav.${item.tab}`)}</span>
            </div>
          </button>
        ))
      )}
    </div>
  )
}
