export const MAX_HASHTAGS = 5
const MAX_TAG_LENGTH = 24

const BAD_WORD_PATTERNS = [
  /ху[ийеёюя]/i,
  /п[иi]зд/i,
  /[еeё]б/i,
  /бл[яa]/i,
  /су[кч]/i,
  /муд/i,
  /гандон/i,
  /fuck/i,
  /shit/i,
  /bitch/i,
  /cunt/i,
  /dick/i,
  /nigg/i,
  /fag/i
]

export interface HashtagResult {
  ok: boolean
  tags: string[]
  error?: string
}

function compactForCheck(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[@$0]/g, (char) => ({ '@': 'a', '$': 's', '0': 'o' })[char] ?? char)
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .toLowerCase()
}

export function normalizeHashtags(input: string | string[] | undefined | null): HashtagResult {
  const source = Array.isArray(input) ? input.join(' ') : input ?? ''
  const parts = source
    .split(/[\s,;]+/g)
    .map(normalizeTag)
    .filter(Boolean)

  const tags: string[] = []
  for (const tag of parts) {
    if (tags.includes(tag)) continue
    if (tag.length < 2) {
      return { ok: false, tags: [], error: 'Хештег должен быть длиннее одного символа.' }
    }
    if (tag.length > MAX_TAG_LENGTH) {
      return { ok: false, tags: [], error: `Хештег не должен быть длиннее ${MAX_TAG_LENGTH} символов.` }
    }
    if (BAD_WORD_PATTERNS.some((pattern) => pattern.test(compactForCheck(tag)))) {
      return { ok: false, tags: [], error: 'В хештегах нельзя использовать запрещённые слова.' }
    }
    tags.push(tag)
    if (tags.length > MAX_HASHTAGS) {
      return { ok: false, tags: [], error: `Можно добавить не больше ${MAX_HASHTAGS} хештегов.` }
    }
  }

  return { ok: true, tags }
}

export function formatHashtags(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(' ')
}

export function extractHashtagsFromText(value: string | null | undefined): string[] {
  const text = value ?? ''
  const matches = text.match(/#[\p{L}\p{N}_-]+/gu) ?? []
  const result = normalizeHashtags(matches)
  return result.ok ? result.tags : []
}

export function appendHashtagsToText(text: string, tags: string[]): string {
  if (tags.length === 0) return text
  const clean = stripTrailingHashtagLine(text)
  return `${clean.trimEnd()}\n\n${formatHashtags(tags)}`
}

export function stripTrailingHashtagLine(text: string): string {
  return text.replace(/\n*\s*(#[\p{L}\p{N}_-]+(?:\s+#[\p{L}\p{N}_-]+){0,4})\s*$/u, '').trimEnd()
}
