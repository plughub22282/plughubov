/**
 * Детерминированный (без рандома/анимации) градиентный плейсхолдер для карточек
 * без обложки. Один и тот же seed (обычно id ассета) всегда даёт одну и ту же
 * пару цветов — карточка не «мигает» новым цветом при каждом ре-рендере.
 */
const GRADIENT_PAIRS: readonly [string, string][] = [
  ['#8B5CF6', '#22D3EE'], // violet → cyan
  ['#F43F5E', '#8B5CF6'], // rose → violet
  ['#22D3EE', '#2563EB'], // cyan → blue
  ['#8B5CF6', '#F43F5E'], // violet → rose
  ['#0EA5E9', '#8B5CF6'], // sky → violet
  ['#F43F5E', '#F59E0B'], // rose → amber
  ['#22D3EE', '#8B5CF6'], // cyan → violet
  ['#A78BFA', '#F43F5E']  // light violet → rose
]

function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Возвращает CSS linear-gradient для данного seed — стабильный между рендерами. */
export function gradientFor(seed: string): string {
  const [from, to] = GRADIENT_PAIRS[hashSeed(seed) % GRADIENT_PAIRS.length]
  return `linear-gradient(160deg, ${from}, ${to})`
}
