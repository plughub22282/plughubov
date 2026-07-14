let stopActivePreview: (() => void) | null = null

export function stopAnyPreview(): void {
  stopActivePreview?.()
}

export function registerActivePreview(stop: () => void): void {
  stopActivePreview = stop
}
