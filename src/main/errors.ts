const DEFAULT_SAFE_ERROR = 'Операция не выполнена. Попробуйте позже.'
const NETWORK_SAFE_ERROR = 'Нет соединения с сервером. Проверьте интернет.'
const TIMEOUT_SAFE_ERROR = 'Сервер не ответил за отведённое время. Попробуйте позже.'
const FILE_TOO_LARGE_SAFE_ERROR = 'Файл слишком большой для загрузки. Уменьшите размер архива и попробуйте снова.'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }
  return typeof error === 'string' ? error : ''
}

function hasServerErrorShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const value = error as Record<string, unknown>
  return typeof value.code === 'string' || 'details' in value || 'hint' in value
}

function looksSensitive(message: string, error: unknown): boolean {
  if (hasServerErrorShape(error)) return true
  const lower = message.toLowerCase()
  return [
    'row-level security',
    'rls',
    'policy',
    'relation',
    'table',
    'column',
    'schema',
    'constraint',
    'duplicate key',
    'violates',
    'permission denied',
    'postgres',
    'postgrest',
    'supabase',
    'jwt',
    'service_role'
  ].some((needle) => lower.includes(needle))
}

export function toSafeError(
  error: unknown,
  fallback = DEFAULT_SAFE_ERROR,
  context?: string
): string {
  // Security: keep full diagnostics in the main process, never in renderer-visible IPC payloads.
  if (context) console.error(`${context}:`, error)

  const message = messageOf(error).trim()
  if (!message) return fallback

  const lower = message.toLowerCase()
  if (lower.includes('timeout') || lower.includes('timed out')) return TIMEOUT_SAFE_ERROR
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('econnrefused')) {
    return NETWORK_SAFE_ERROR
  }
  if (
    lower.includes('exceeded the maximum allowed size') ||
    lower.includes('payload too large') ||
    (typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === '413')
  ) {
    return FILE_TOO_LARGE_SAFE_ERROR
  }
  if (looksSensitive(message, error)) return fallback
  return message
}
