import { useCallback, useEffect, useRef, useState } from 'react'
import type { UploadProgress } from '../types'

/** Живой прогресс одной загрузки (плагин/ассет). Игнорирует события чужих uploadId. */
export function useUploadProgress() {
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    return window.api.onUploadProgress((p) => {
      if (p.uploadId === idRef.current) setProgress(p)
    })
  }, [])

  const start = useCallback((): string => {
    const id = crypto.randomUUID()
    idRef.current = id
    setProgress(null)
    return id
  }, [])

  const reset = useCallback(() => {
    idRef.current = null
    setProgress(null)
  }, [])

  return { progress, start, reset }
}
