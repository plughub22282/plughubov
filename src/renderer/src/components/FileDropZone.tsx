import React, { useState } from 'react'
import { useI18n } from '../i18n'

// ─── FileDropZone ─────────────────────────────────────────────────────────────

export interface DropZoneProps {
  label: string
  accept: string
  value: string | null
  onSelect: (path: string) => void
  hint?: string
  icon: React.ReactNode
}

export function FileDropZone({ label, accept, value, onSelect, hint, icon }: DropZoneProps) {
  const { t } = useI18n()
  const [dragging, setDragging] = useState(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    // Electron добавляет абсолютный путь в File.path (нет в стандартных DOM-типах).
    const file = e.dataTransfer.files[0] as (File & { path: string }) | undefined
    if (file) onSelect(file.path)
  }

  const handleBrowse = async () => {
    const extensions = accept
      .split(',')
      .map((s) => s.trim().replace('.', ''))
      .filter(Boolean)
    const path = await window.api.selectFile([{ name: label, extensions }])
    if (path) onSelect(path)
  }

  const fileName = value ? value.split(/[\\/]/).pop() : null

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded-lg p-5 flex flex-col items-center justify-center gap-2 transition-all cursor-pointer ${
        dragging
          ? 'border-accent bg-accent/10'
          : value
            ? 'border-status-success/50 bg-status-success/5'
            : 'border-app-border hover:border-app-border-active hover:bg-white/3'
      }`}
      onClick={handleBrowse}
    >
      <div className={value ? 'text-status-success' : 'text-txt-muted'}>{icon}</div>

      {fileName ? (
        <>
          <span className="text-sm text-status-success font-medium truncate max-w-full px-2">
            {fileName}
          </span>
          <span className="text-xs text-txt-muted">{t('common.clickToChange')}</span>
        </>
      ) : (
        <>
          <span className="text-sm text-txt-secondary">{label}</span>
          {hint && <span className="text-xs text-txt-muted">{hint}</span>}
          <button
            type="button"
            className="text-xs text-accent hover:text-accent-hover underline underline-offset-2 mt-1"
            onClick={(e) => { e.stopPropagation(); handleBrowse() }}
          >
            {t('common.selectFile')}
          </button>
        </>
      )}
    </div>
  )
}

// ─── Toast ────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error'

export interface ToastProps {
  message: string
  type: ToastType
  onClose: () => void
}

export function Toast({ message, type, onClose }: ToastProps) {
  return (
    <div
      className={`fixed bottom-6 right-6 flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl z-50 max-w-xs transition-all ${
        type === 'success'
          ? 'bg-green-900/80 border-green-700 text-green-200'
          : 'bg-red-900/80 border-red-700 text-red-200'
      }`}
    >
      <span className="text-sm leading-snug flex-1">{message}</span>
      <button onClick={onClose} className="text-current opacity-60 hover:opacity-100 flex-shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}
