import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

/**
 * Проверка доверенного отправителя IPC — та же, что использует каждый обработчик в
 * index.ts (см. isTrustedSender/rejectUntrustedSender там же), но вынесена сюда, чтобы
 * ей могли пользоваться auth.ts/referral.ts/chat.ts: они не могут импортировать её из
 * index.ts, потому что index.ts сам импортирует их (получился бы циклический импорт).
 *
 * В index.ts обработчики регистрируются внутри createWindow() и берут `win` из
 * замыкания; здесь такого замыкания нет, поэтому окно находим по event.sender.
 */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  return !!win && !win.isDestroyed() && event.senderFrame?.top === win.webContents.mainFrame
}

export function rejectUntrustedSender(event: IpcMainInvokeEvent): { ok: false; error: string } | null {
  if (isTrustedSender(event)) return null
  console.warn('[security] blocked IPC from untrusted sender:', event.senderFrame?.url ?? 'unknown')
  return { ok: false, error: 'Недоверенный источник IPC-вызова.' }
}
