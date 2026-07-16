// Типы для низкоуровневого анализа ZIP-архивов (см. ./zip-validation.ts).
// Вынесены отдельно, чтобы и движок чтения ZIP, и его потребители в index.ts
// ссылались на один и тот же контракт записи без циклических импортов.

export interface ZipContentEntry {
  relativePath: string
  ext: string
  size: number
}
