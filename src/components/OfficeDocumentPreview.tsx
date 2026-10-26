import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WordFilePreview } from './WordFilePreview'
import { readVerifiedFile } from '../api/previewCache'
import { bytesToBase64 } from '../utils/filePreview'
import { LOCAL_OFFICE_PREVIEW_BYTES } from '../utils/previewLimits'

const OnlyOfficeEditor = lazy(() => import('./OnlyOfficeEditor').then(module => ({ default: module.OnlyOfficeEditor })))
const OfficeFilePreview = lazy(() =>
  import('./OfficeFilePreview').then(module => ({ default: module.OfficeFilePreview })),
)
const PresentationPreview = lazy(() =>
  import('./PresentationPreview').then(module => ({ default: module.PresentationPreview })),
)

export function OfficeDocumentPreview({
  path,
  directory,
  serverId,
  base64,
}: {
  path: string
  directory: string
  serverId: string
  base64?: string
}) {
  const { t } = useTranslation('components')
  const [local, setLocal] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const [fallback, setFallback] = useState<{ key: string; base64?: string; error?: string } | null>(null)
  const key = JSON.stringify([serverId, directory, path, revision])
  useEffect(() => {
    if (!local || base64 || !/\.(docx|pptx|xlsx)$/i.test(path)) return
    const controller = new AbortController()
    void readVerifiedFile(path, directory, serverId, {
      maxBytes: LOCAL_OFFICE_PREVIEW_BYTES,
      signal: controller.signal,
    })
      .then(bytes => {
        if (!controller.signal.aborted) setFallback({ key, base64: bytesToBase64(bytes) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setFallback({ key, error: t('fileExplorer.officeLargeFallback') })
      })
    return () => controller.abort()
  }, [local, base64, key, path, directory, serverId, t])
  const localData = base64 || (fallback?.key === key ? fallback.base64 : undefined)
  if (!local)
    return (
      <Suspense fallback={<div className="p-3">{t('common:loading')}</div>}>
        <OnlyOfficeEditor
          key={revision}
          path={path}
          directory={directory}
          serverId={serverId}
          mode="view"
          onPreview={() => {
            setRevision(value => value + 1)
            setLocal(true)
          }}
          onUnavailable={() => {
            setRevision(value => value + 1)
            setLocal(true)
          }}
        />
      </Suspense>
    )
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border-200/50 text-[length:var(--fs-xs)]">
        <span className="flex-1 text-text-400">{t('fileExplorer.officeLocalFallback')}</span>
        <button type="button" className="rounded px-2 py-1 hover:bg-bg-200" onClick={() => setLocal(false)}>
          {t('common:retry')}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {fallback?.key === key && fallback.error ? (
          <p role="alert" className="p-4 text-text-400">
            {fallback.error}
          </p>
        ) : !localData && /\.(docx|pptx|xlsx)$/i.test(path) ? (
          <p role="status" className="p-4 text-text-400">
            {t('common:loading')}
          </p>
        ) : localData && /\.docx$/i.test(path) ? (
          <WordFilePreview base64={localData} />
        ) : localData && /\.pptx$/i.test(path) ? (
          <Suspense fallback={null}>
            <PresentationPreview base64={localData} />
          </Suspense>
        ) : localData && /\.xlsx$/i.test(path) ? (
          <Suspense fallback={null}>
            <OfficeFilePreview base64={localData} path={path} />
          </Suspense>
        ) : (
          <p className="p-4 text-text-400">{t('fileExplorer.legacyWord')}</p>
        )}
      </div>
    </div>
  )
}
