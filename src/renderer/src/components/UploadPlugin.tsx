import React, { useState, useEffect } from 'react'
import type { UserRole } from '../types'
import { useI18n } from '../i18n'
import { PluginUploadForm, UploadLockedScreen, type PluginUploadFormState } from './pluginCommon'

// ─── UploadPlugin ─────────────────────────────────────────────────────────────

export default function UploadPlugin() {
  const { t } = useI18n()
  // Defense-in-depth: компонент сам проверяет роль, не полагаясь только на скрытие
  // вкладки. Реальную защиту обеспечивают серверный guard в main и RLS в БД.
  const [role, setRole] = useState<UserRole | null>(null)
  useEffect(() => {
    window.api.auth.getState().then((s) => setRole(s.role))
  }, [])

  // Не-авторам показываем экран блокировки вместо формы.
  if (role !== null && role !== 'author') {
    return <UploadLockedScreen title={t('upload.lockedTitle')} text={t('upload.lockedText')} />
  }

  const handleSubmit = (
    form: PluginUploadFormState,
    archivePath: string,
    iconPath: string | undefined,
    uploadId: string
  ) =>
    window.api.uploadPlugin(
      { name: form.name, version: form.version, description: form.description, category: form.category },
      archivePath,
      iconPath,
      uploadId
    )

  return (
    <PluginUploadForm
      title={t('upload.pluginTitle')}
      subtitle={t('upload.pluginSubtitle')}
      submitLabel={t('upload.publishPlugin')}
      onSubmit={handleSubmit}
      onSuccess={() => {}}
    />
  )
}
