import { useEffect } from 'react'

const stack: Array<() => void> = []

export function useEscapeToClose(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return

    stack.push(onClose)
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stack[stack.length - 1] !== onClose) return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler)

    return () => {
      document.removeEventListener('keydown', handler)
      const idx = stack.indexOf(onClose)
      if (idx !== -1) stack.splice(idx, 1)
    }
  }, [onClose, active])
}
