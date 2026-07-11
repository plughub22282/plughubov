export interface Plugin {
  id: string
  name: string
  author: string
  version: string
  description: string
  category: string
  size: string
  downloadUrl: string
  iconUrl?: string
  tags?: string[]
  installed?: boolean
  installDate?: string
  /** Автор с активным премиумом — рендерим верификационную галочку у имени. */
  authorIsPremium?: boolean
}

/** Результат автоустановки. При исчерпании суточного лимита — limitReached/allowArchive. */
export interface InstallResult {
  ok: boolean
  error?: string
  limitReached?: boolean
  allowArchive?: boolean
  resetsAt?: string
  usedAfter?: number
  limit?: number
}

/** Статус суточного лимита автоустановок (для UI). */
export interface AutoInstallStatus {
  ok: boolean
  premium?: boolean
  unlimited?: boolean
  used?: number
  limit?: number
  resetsAt?: string
  error?: string
}

/** Элемент облачной студии (установленный премиум-юзером плагин). */
export interface StudioItem {
  id: string
  name: string
  source: string
  installed: boolean
}

export interface StudioListResult {
  ok: boolean
  items?: StudioItem[]
  error?: string
}

export interface StudioRestoreResult {
  ok: boolean
  total?: number
  installed?: number
  failed?: Array<{ id: string; error: string }>
  cancelled?: boolean
  error?: string
}

/** Плагин из пользовательского маркетплейса (расширяет Plugin данными загрузки). */
export interface CommunityPlugin extends Plugin {
  uploaderId?: string
  downloads?: number
  likes?: number
  likedByMe?: boolean
  /** Цена для платного контента (битов), напр. «20$». Пусто — бесплатно. */
  price?: string
  /** Telegram владельца бита (https://t.me/...) — покупатель пишет ему для оплаты. */
  paymentUrl?: string
  /** Пресеты: готовый аудиоклип «с эффектами» для живого A/B-сравнения. */
  previewWetUrl?: string
  /** Пресеты: готовый аудиоклип «без эффектов» для живого A/B-сравнения. */
  previewDryUrl?: string
}

/** Сообщение в общем премиум-чате. */
export interface ChatMessage {
  id: string
  userId: string
  author: string
  text: string
  createdAt: string
}

export interface ChatHistoryResult {
  ok: boolean
  error?: string
  messages?: ChatMessage[]
}

/** Роль реплики в диалоге с AI-ассистентом (локальная история, без БД). */
export type AiRole = 'user' | 'assistant'

export interface AiChatMessage {
  id: string
  role: AiRole
  text: string
  /** Стриминг ещё не завершён — показать индикатор "печатает". */
  pending?: boolean
}

export interface AiSendResult {
  ok: boolean
  requestId?: string
  error?: string
  resetsAt?: string
}

export interface AiChunkEvent {
  requestId: string
  delta: string
}

export interface AiDoneEvent {
  requestId: string
}

export interface AiErrorEvent {
  requestId: string
  error: string
}

/** Один результат AI-подбора плагинов из каталога. */
export interface AiRecommendationItem {
  id: string
  name: string
  reason: string
}

export interface AiRecommendResult {
  ok: boolean
  error?: string
  resetsAt?: string
  items?: AiRecommendationItem[]
}

/** Статус реферальной программы текущего пользователя. */
export interface ReferralStats {
  ok: boolean
  error?: string
  /** Личный код приглашения. */
  code?: string
  /** Готовая ссылка-приглашение (та же активация, что и по коду). */
  inviteLink?: string
  /** Сколько всего человек перешло по коду. */
  invited?: number
  /** Сколько из них «засчитано» (прошли анти-абуз). */
  qualified?: number
  /** Сколько блоков премиума уже получено. */
  rewardsGranted?: number
  /** Сколько блоков премиума можно получить прямо сейчас. */
  rewardsAvailable?: number
  /** Пользователь уже перешёл по чьему-то коду. */
  referred?: boolean
  /** Рефералов на один блок награды. */
  perReward?: number
  /** Дней премиума за блок. */
  rewardDays?: number
}

export interface ReferralActionResult {
  ok: boolean
  error?: string
}

/** Результат обработки реферальной ссылки (plughub://ref/<code>). */
export interface ReferralDeepLinkResult extends ReferralActionResult {
  code: string
}

export interface ReferralRedeemResult {
  ok: boolean
  error?: string
  grantedDays?: number
  premiumUntil?: string | null
}

export interface AppSettings {
  vst3Path: string
  autoUpdate: boolean
  checkUpdateOnStart: boolean
  theme: string
  language: Language
}

export type Language = 'ru' | 'en'

export interface UploadMeta {
  name: string
  version: string
  description: string
  category: string
  /** Платный контент (биты): цена и Telegram владельца бита для связи/оплаты. */
  price?: string
  paymentUrl?: string
  tags?: string[]
}

export interface CatalogUploadMeta extends UploadMeta {
  author: string
}

export interface UploadAssetOptions {
  /** Для битов: уже нарезанное 30-секундное WAV-превью, которое уйдёт в публичное хранилище. */
  previewBuffer?: ArrayBuffer | Uint8Array
  previewFileName?: string
  previewStartSec?: number
  previewDurationSec?: number
  /** Для пресетов: готовый аудиофайл «с эффектами» (путь на диске, без трима). */
  previewWetPath?: string
  /** Для пресетов: готовый аудиофайл «без эффектов» (путь на диске, без трима). */
  previewDryPath?: string
}

export interface InstallProgress {
  pluginId: string
  step: 'download' | 'scan' | 'extract' | 'done' | 'error'
  pct?: number
  error?: string
  /** Текстовый статус текущего шага проверки безопасности (только для step === 'scan'). */
  message?: string
}

export type UploadStep = 'validate' | 'upload' | 'icon' | 'publish' | 'done' | 'error'

export interface UploadProgress {
  uploadId: string
  step: UploadStep
  message?: string
  error?: string
}

export type Tab =
  | 'home'
  | 'catalog' | 'marketplace' | 'flp' | 'templates' | 'loops' | 'drumkits' | 'beats' | 'presets'
  | 'vladon'
  | 'upload' | 'adminCatalog' | 'keys' | 'premium' | 'referral' | 'settings'

/** Тип пользовательского контента в community-маркетплейсе. */
export type AssetKind = 'plugin' | 'flp' | 'template' | 'loop' | 'drumkit' | 'beat' | 'preset'

// ─── Auth ───────────────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'author'
export type AuthStatus = 'signedOut' | 'signedIn'

export interface AuthUser {
  id: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  discordId: string | null
}

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  role: UserRole | null
  /** Премиум-подписка активна прямо сейчас. */
  premium: boolean
  /** Срок действия премиума (ISO). null — бессрочный allow-list или премиума нет. */
  premiumUntil: string | null
  /** Владелец приложения: доступна вкладка «Ключи» (генерация премиум-кодов). */
  isOwner: boolean
  onboardingCompleted: boolean
  onboardingDaw: string | null
  onboardingGenre: string | null
}

/** Премиум-код в панели владельца. */
export interface PremiumCode {
  code: string
  note?: string
  /** Срок действия кода в днях (на сколько продлевает премиум). */
  durationDays?: number
  redeemed: boolean
  redeemedBy?: string
  redeemedAt?: string
  createdAt: string
}

export interface AuthResult {
  ok: boolean
  error?: string
  state?: AuthState
}

/**
 * Локальный UI-статус: добавляет 'loading' (восстановление сессии при старте) и
 * 'connecting' (идёт вход через Discord — ждём подтверждения в браузере).
 */
export type UiAuthStatus = 'loading' | 'signedOut' | 'connecting' | 'signedIn'
