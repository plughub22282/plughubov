import { contextBridge, ipcRenderer } from 'electron'

export type InstallStep = 'download' | 'scan' | 'extract' | 'done' | 'error'

export interface InstallProgress {
  pluginId: string
  step: InstallStep
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

export interface AppSettings {
  vst3Path: string
  autoUpdate: boolean
  checkUpdateOnStart: boolean
  theme: string
  language: 'ru' | 'en'
}

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

export interface UploadMeta {
  name: string
  version: string
  description: string
  category: string
  /** Платный контент (биты): цена и ссылка для оплаты. */
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

/** Плагин из пользовательского маркетплейса (расширяет Plugin метаданными загрузки). */
export interface CommunityPlugin extends Plugin {
  uploaderId?: string
  downloads?: number
  likes?: number
  likedByMe?: boolean
  price?: string
  paymentUrl?: string
  /** Пресеты: готовые аудиоклипы «с эффектами» / «без эффектов» для живого A/B-сравнения. */
  previewWetUrl?: string
  previewDryUrl?: string
}

// ─── Auth (зеркало main/auth.ts) ────────────────────────────────────────────────

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
  /** Владелец приложения: доступна вкладка «Ключи». */
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

export interface AiChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
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

// ─── Реферальная программа (зеркало main/referral.ts) ───────────────────────────

export interface ReferralStats {
  ok: boolean
  error?: string
  code?: string
  /** Готовая ссылка-приглашение (та же активация, что и по коду). */
  inviteLink?: string
  invited?: number
  qualified?: number
  rewardsGranted?: number
  rewardsAvailable?: number
  referred?: boolean
  perReward?: number
  rewardDays?: number
}

export interface ReferralActionResult {
  ok: boolean
  error?: string
}

/** Результат обработки реферальной ссылки (plughub://ref/<code>) — см. main/referral.ts. */
export interface ReferralDeepLinkResult extends ReferralActionResult {
  code: string
}

export interface ReferralRedeemResult {
  ok: boolean
  error?: string
  grantedDays?: number
  premiumUntil?: string | null
}

const api = {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Auth (вся работа с токенами — в main; renderer токенов не видит)
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke('auth:getState'),
    // Вход через Discord OAuth. Промис держится открытым на всё время авторизации
    // в браузере и резолвится финальным состоянием.
    signInWithDiscord: (): Promise<AuthResult> => ipcRenderer.invoke('auth:signInDiscord'),
    cancelDiscord: (): Promise<AuthResult> => ipcRenderer.invoke('auth:cancelDiscord'),
    signOut: (): Promise<AuthResult> => ipcRenderer.invoke('auth:signOut'),
    // Активация премиума по коду. Возвращает обновлённое состояние при успехе.
    redeemPremium: (code: string): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:redeemPremium', code),
    completeOnboarding: (daw: string | null, genre: string | null): Promise<AuthResult> =>
      ipcRenderer.invoke('auth:completeOnboarding', daw, genre),
    onChange: (cb: (state: AuthState) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, state: AuthState) => cb(state)
      ipcRenderer.on('auth:changed', handler)
      return () => ipcRenderer.removeListener('auth:changed', handler)
    }
  },

  // Реферальная программа (5 засчитанных рефералов = +14 дней премиума; анти-абуз — на сервере)
  referral: {
    stats: (): Promise<ReferralStats> => ipcRenderer.invoke('referral:stats'),
    claim: (code: string): Promise<ReferralActionResult> =>
      ipcRenderer.invoke('referral:claim', code),
    redeem: (): Promise<ReferralRedeemResult> => ipcRenderer.invoke('referral:redeem'),
    // Активация по ссылке (plughub://ref/<code>) — main обрабатывает клик по ссылке сам
    // (см. src/main/index.ts) и рассылает результат сюда.
    onDeepLinkResult: (cb: (result: ReferralDeepLinkResult) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, result: ReferralDeepLinkResult) => cb(result)
      ipcRenderer.on('referral:deepLinkResult', handler)
      return () => ipcRenderer.removeListener('referral:deepLinkResult', handler)
    },
    // Подстраховка от гонки при холодном старте — забирает результат, если ссылку
    // обработали до того, как окно успело подписаться на onDeepLinkResult.
    consumeDeepLinkResult: (): Promise<ReferralDeepLinkResult | null> =>
      ipcRenderer.invoke('referral:consumeDeepLinkResult')
  },

  // Премиум-чат (общая комната; доступ проверяется в main и в БД через RLS)
  chat: {
    history: (): Promise<ChatHistoryResult> => ipcRenderer.invoke('chat:history'),
    send: (text: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('chat:send', text),
    unsubscribe: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:unsubscribe'),
    onMessage: (cb: (message: ChatMessage) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, message: ChatMessage) => cb(message)
      ipcRenderer.on('chat:message', handler)
      return () => ipcRenderer.removeListener('chat:message', handler)
    }
  },

  // AI-ассистент (чат стримится токенами через ai:chunk/ai:done/ai:error) и подбор плагинов
  ai: {
    send: (messages: AiChatMsg[], isPremium?: boolean): Promise<AiSendResult> =>
      ipcRenderer.invoke('ai:send', { messages, isPremium }),
    onChunk: (cb: (e: AiChunkEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: AiChunkEvent) => cb(payload)
      ipcRenderer.on('ai:chunk', handler)
      return () => ipcRenderer.removeListener('ai:chunk', handler)
    },
    onDone: (cb: (e: AiDoneEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: AiDoneEvent) => cb(payload)
      ipcRenderer.on('ai:done', handler)
      return () => ipcRenderer.removeListener('ai:done', handler)
    },
    onError: (cb: (e: AiErrorEvent) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: AiErrorEvent) => cb(payload)
      ipcRenderer.on('ai:error', handler)
      return () => ipcRenderer.removeListener('ai:error', handler)
    },
    recommend: (query: string, isPremium?: boolean): Promise<AiRecommendResult> =>
      ipcRenderer.invoke('ai:recommend', { query, isPremium })
  },

  // Премиум-ключи (только владелец; права проверяются в main и в БД)
  premium: {
    generate: (count: number, note?: string, days?: number): Promise<{ ok: boolean; codes?: string[]; error?: string }> =>
      ipcRenderer.invoke('premium:generate', count, note, days),
    list: (): Promise<{ ok: boolean; codes?: PremiumCode[]; error?: string }> =>
      ipcRenderer.invoke('premium:list')
  },

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: AppSettings): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('settings:save', s),

  // Каталог (официальные плагины)
  listPlugins: (): Promise<Plugin[]> => ipcRenderer.invoke('plugins:list'),
  // sourceTab — вкладка, инициировавшая установку ('catalog'/'marketplace' пропускают
  // проверку безопасности, см. src/main/antivirus.ts).
  installPlugin: (pluginId: string, sourceTab?: string): Promise<InstallResult> =>
    ipcRenderer.invoke('plugins:install', pluginId, sourceTab),
  // Скачать архивом (ручная установка, без списания суточного слота).
  downloadPluginArchive: (pluginId: string, sourceTab?: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('plugins:downloadArchive', pluginId, sourceTab),
  // Статус суточного лимита автоустановок (для UI).
  getAutoInstallStatus: (): Promise<AutoInstallStatus> =>
    ipcRenderer.invoke('plugins:autoInstallStatus'),

  // Облачная студия (только премиум)
  studio: {
    list: (): Promise<StudioListResult> => ipcRenderer.invoke('studio:list'),
    restore: (): Promise<StudioRestoreResult> => ipcRenderer.invoke('studio:restore'),
    restoreCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('studio:restoreCancel')
  },

  // Авторская публикация: старый локальный путь загрузки.
  uploadPlugin: (
    meta: UploadMeta,
    filePath: string,
    iconPath?: string,
    uploadId?: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('plugins:upload', meta, filePath, iconPath, uploadId),
  // Официальный каталог: только владелец приложения.
  uploadCatalogPlugin: (
    meta: CatalogUploadMeta,
    filePath: string,
    iconPath?: string,
    uploadId?: string
  ): Promise<{ ok: boolean; id?: string; error?: string }> =>
    ipcRenderer.invoke('catalog:upload', meta, filePath, iconPath, uploadId),

  // Пользовательский маркетплейс (community)
  listCommunityPlugins: (): Promise<CommunityPlugin[]> => ipcRenderer.invoke('community:list'),
  uploadCommunityPlugin: (
    meta: UploadMeta,
    filePath: string,
    iconPath?: string,
    uploadId?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('community:upload', meta, filePath, iconPath, uploadId),
  bumpCommunityDownload: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('community:bumpDownload', id),
  setAssetLike: (id: string, liked: boolean): Promise<{ ok: boolean; likes?: number; likedByMe?: boolean; error?: string }> =>
    ipcRenderer.invoke('assets:setLike', id, liked),
  deleteCommunityPlugin: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('community:delete', id),

  // Ассеты: FLP-проекты, тимплейты, лупы (та же таблица, дискриминатор kind)
  listAssets: (kind: string): Promise<CommunityPlugin[]> =>
    ipcRenderer.invoke('assets:list', kind),
  uploadAsset: (
    kind: string,
    meta: UploadMeta,
    filePath: string,
    iconPath?: string,
    options?: UploadAssetOptions,
    uploadId?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('assets:upload', kind, meta, filePath, iconPath, options, uploadId),
  downloadAsset: (id: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('assets:download', id),

  // Dialogs
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  selectFile: (filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectFile', filters),
  readAudioFile: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('audio:readFile', filePath),

  // Shell
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('shell:openExternal', url),

  // Install progress events
  onInstallProgress: (cb: (progress: InstallProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: InstallProgress) => cb(data)
    ipcRenderer.on('install:progress', handler)
    return () => ipcRenderer.removeListener('install:progress', handler)
  },
  onInstallLog: (cb: (msg: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, msg: string) => cb(msg)
    ipcRenderer.on('install:log', handler)
    return () => ipcRenderer.removeListener('install:log', handler)
  },

  // Upload progress events
  onUploadProgress: (cb: (progress: UploadProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: UploadProgress) => cb(data)
    ipcRenderer.on('upload:progress', handler)
    return () => ipcRenderer.removeListener('upload:progress', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
