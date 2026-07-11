import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { PluginUploadForm, UploadLockedScreen, type PluginUploadFormState } from './pluginCommon'

export default function AdminCatalogUpload() {
  const { t } = useI18n()
  const [isOwner, setIsOwner] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.auth.getState().then((s) => setIsOwner(s.isOwner))
  }, [])

  if (isOwner === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-app-border border-t-accent rounded-full animate-spin" />
      </div>
    )
  }

  if (!isOwner) {
    return <UploadLockedScreen title={t('admin.onlyTitle')} text={t('admin.onlyText')} />
  }

  const handleSubmit = (
    form: PluginUploadFormState,
    archivePath: string,
    iconPath: string | undefined,
    uploadId: string
  ) =>
    window.api.uploadCatalogPlugin(
      {
        name: form.name.trim(),
        author: (form.author ?? '').trim(),
        version: form.version.trim(),
        description: form.description.trim(),
        category: form.category
      },
      archivePath,
      iconPath,
      uploadId
    )

  return (
    <PluginUploadForm
      title={t('admin.addCatalog')}
      subtitle={t('admin.subtitle')}
      submitLabel={t('admin.addCatalog')}
      withAuthor
      archiveAccept=".zip"
      onSubmit={handleSubmit}
      onSuccess={() => {}}
      successMessage={(name) => t('admin.addSuccess', { name })}
    />
  )
}
