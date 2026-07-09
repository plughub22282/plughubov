// Прокси к Cloud.ru Evolution Object Storage (S3-compatible). Реальные
// STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY живут только здесь (Supabase
// secret) — клиент (src/main/index.ts) их не знает, только получает presigned URL
// на конкретную загрузку/удаление. Тот же приём, что и у supabase/functions/vt-proxy
// для VirusTotal-ключа.
//
// Для Cloud.ru обычно используются STORAGE_ENDPOINT=https://s3.cloud.ru и
// STORAGE_REGION=ru-central-1. STORAGE_ACCESS_KEY_ID задаётся в формате Cloud.ru
// <tenant_id>:<key_id>, STORAGE_SECRET_ACCESS_KEY — secret access key. Бакет должен
// разрешать публичное чтение объектов, потому что download_url сохраняется в БД.
//
// JWT проверяется платформой Supabase на входе (задеплоено без --no-verify-jwt),
// но auth.uid() нам всё равно нужен внутри — поэтому клиент для auth.getUser()/
// rpc('is_owner') создаётся с форвардом заголовка Authorization вызывающего.
//
// Ключ объекта клиент присылает как хочет, но мы ему не доверяем дальше проверки,
// что путь укладывается в собственный namespace пользователя — то же самое, что
// раньше проверяла RLS-политика community_files_insert на storage.objects.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch@1'

const STORAGE_ENDPOINT = (Deno.env.get('STORAGE_ENDPOINT') ?? 'https://s3.cloud.ru').replace(/\/+$/, '')
const STORAGE_BUCKET = Deno.env.get('STORAGE_BUCKET') ?? ''
const STORAGE_PUBLIC_BASE_URL = (
  Deno.env.get('STORAGE_PUBLIC_BASE_URL') ?? (STORAGE_BUCKET ? `${STORAGE_ENDPOINT}/${STORAGE_BUCKET}` : '')
).replace(/\/+$/, '')
const STORAGE_REGION = Deno.env.get('STORAGE_REGION') ?? 'ru-central-1'
const STORAGE_ACCESS_KEY_ID = Deno.env.get('STORAGE_ACCESS_KEY_ID') ?? ''
const STORAGE_SECRET_ACCESS_KEY = Deno.env.get('STORAGE_SECRET_ACCESS_KEY') ?? ''

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const PRESIGN_TTL_SECONDS = 15 * 60
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024 // 1 ГБ — зеркалит клиентский лимит в index.ts

const ASSET_KINDS = ['flp', 'template', 'loop', 'drumkit', 'beat', 'preset']
const NAMESPACES = ['catalog', 'community'] as const
type Namespace = (typeof NAMESPACES)[number]

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function requireStorageConfig(): void {
  if (
    !STORAGE_ENDPOINT ||
    !STORAGE_BUCKET ||
    !STORAGE_PUBLIC_BASE_URL ||
    !STORAGE_ACCESS_KEY_ID ||
    !STORAGE_SECRET_ACCESS_KEY
  ) {
    throw new HttpError(500, 'Хранилище не настроено на сервере.')
  }
}

function awsClient(): AwsClient {
  requireStorageConfig()
  return new AwsClient({
    accessKeyId: STORAGE_ACCESS_KEY_ID,
    secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
    service: 's3',
    region: STORAGE_REGION
  })
}

/** Кодирует ключ объекта посегментно, сохраняя '/' как разделитель "папок". */
function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function objectUrl(fullKey: string): string {
  requireStorageConfig()
  return `${STORAGE_ENDPOINT}/${STORAGE_BUCKET}/${encodeObjectKey(fullKey)}`
}

/** Базовая защита от path traversal / выхода за пределы своего namespace в ключе объекта. */
function isSafeKeySegment(key: string): boolean {
  return (
    key.length > 0 &&
    key.length < 1024 &&
    !key.startsWith('/') &&
    !key.includes('..') &&
    !key.includes('\\') &&
    !/[\x00-\x1f]/.test(key)
  )
}

/** Клиент, который auth.getUser()/rpc() выполняет от имени реального вызывающего. */
function userClientFrom(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? ''
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  })
}

async function requireUserId(req: Request): Promise<{ userId: string; client: ReturnType<typeof userClientFrom> }> {
  const client = userClientFrom(req)
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new HttpError(401, 'Не авторизован.')
  return { userId: data.user.id, client }
}

/**
 * Проверяет, что ключ объекта принадлежит namespace вызывающего, и возвращает
 * полный физический ключ в бакете (с префиксом logical-бакета внутри одного
 * физического бакета — раньше это были два отдельных бакета Supabase Storage).
 */
async function resolveFullKey(
  req: Request,
  namespace: Namespace,
  key: string
): Promise<{ fullKey: string; userId: string }> {
  if (!isSafeKeySegment(key)) throw new HttpError(400, 'Некорректный ключ файла.')

  if (namespace === 'catalog') {
    const { userId, client } = await requireUserId(req)
    const { data: owner, error } = await client.rpc('is_owner')
    if (error) throw new HttpError(500, 'Не удалось проверить права.')
    if (!owner) throw new HttpError(403, 'Добавлять файлы в каталог может только владелец приложения.')
    // Каталог целиком под контролем владельца — путь не завязан на его uid.
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(key)) throw new HttpError(400, 'Некорректный ключ файла.')
    return { fullKey: `catalog-plugins/${key}`, userId }
  }

  const { userId } = await requireUserId(req)
  const kindPattern = ASSET_KINDS.join('|')
  const ownPathRe = new RegExp(`^(?:(?:${kindPattern})/)?${userId}/[^/]+$`)
  if (!ownPathRe.test(key)) {
    throw new HttpError(403, 'Можно загружать файлы только в свой собственный путь.')
  }
  return { fullKey: `community-plugins/${key}`, userId }
}

async function handlePresignUpload(req: Request) {
  const body = (await req.json()) as { namespace?: string; key?: string; contentType?: string; size?: number }
  const namespace = body.namespace
  if (!namespace || !NAMESPACES.includes(namespace as Namespace)) {
    throw new HttpError(400, 'Некорректный namespace.')
  }
  if (!body.key || typeof body.key !== 'string') throw new HttpError(400, 'Не передан ключ файла.')
  // Размер обязателен и подписывается как content-length ниже — иначе presigned URL
  // ограничивал бы только заявленный клиентом размер, а не реальный объём PUT-запроса.
  if (typeof body.size !== 'number' || !Number.isFinite(body.size) || body.size <= 0) {
    throw new HttpError(400, 'Не передан размер файла.')
  }
  if (body.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, 'Файл слишком большой для загрузки.')
  }
  const contentType = typeof body.contentType === 'string' && body.contentType ? body.contentType : 'application/octet-stream'

  const { fullKey } = await resolveFullKey(req, namespace as Namespace, body.key)

  const url = new URL(objectUrl(fullKey))
  url.searchParams.set('X-Amz-Expires', String(PRESIGN_TTL_SECONDS))
  const signed = await awsClient().sign(url.toString(), {
    method: 'PUT',
    aws: { signQuery: true },
    headers: { 'content-type': contentType, 'content-length': String(body.size) }
  })

  return {
    uploadUrl: signed.url,
    publicUrl: `${STORAGE_PUBLIC_BASE_URL}/${encodeObjectKey(fullKey)}`
  }
}

async function handleDelete(req: Request) {
  const body = (await req.json()) as { namespace?: string; keys?: string[] }
  const namespace = body.namespace
  if (!namespace || !NAMESPACES.includes(namespace as Namespace)) {
    throw new HttpError(400, 'Некорректный namespace.')
  }
  if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 16) {
    throw new HttpError(400, 'Некорректный список ключей.')
  }

  // Один чек владельца на весь запрос: catalog удаляет только владелец приложения;
  // community — сам автор файла (по совпадению uid в пути) ИЛИ владелец (модерация).
  const { userId, client: userClient } = await requireUserId(req)
  const { data: owner, error: ownerError } = await userClient.rpc('is_owner')
  if (ownerError) throw new HttpError(500, 'Не удалось проверить права.')
  const isOwner = !!owner

  const kindPattern = ASSET_KINDS.join('|')
  const ownPathRe = new RegExp(`^(?:(?:${kindPattern})/)?${userId}/[^/]+$`)

  const s3 = awsClient()
  const results = await Promise.all(
    body.keys.map(async (key) => {
      if (typeof key !== 'string' || !isSafeKeySegment(key)) return false
      if (namespace === 'catalog') {
        if (!isOwner || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(key)) return false
      } else if (!isOwner && !ownPathRe.test(key)) {
        return false
      }
      const fullKey = `${namespace === 'catalog' ? 'catalog-plugins' : 'community-plugins'}/${key}`
      const signed = await s3.sign(objectUrl(fullKey), { method: 'DELETE', aws: { signQuery: true } })
      const res = await fetch(signed.url, { method: 'DELETE' })
      return res.ok || res.status === 404
    })
  )

  return { ok: results.every(Boolean) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop()

  try {
    switch (action) {
      case 'presign-upload':
        return jsonResponse(await handlePresignUpload(req))
      case 'delete':
        return jsonResponse(await handleDelete(req))
      default:
        return jsonResponse({ error: 'Unknown action' }, 404)
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (!(err instanceof HttpError)) console.error('[storage-proxy] unexpected error:', err)
    const message = err instanceof HttpError ? err.message : 'Внутренняя ошибка хранилища.'
    return jsonResponse({ error: message }, status)
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
