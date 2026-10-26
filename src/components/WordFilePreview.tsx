import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function WordFilePreview({ base64 }: { base64: string }) {
  const { t } = useTranslation('components')
  const frame = useRef<HTMLIFrameElement>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    setError(false)
    const render = async () => {
      try {
        const doc = frame.current?.contentDocument
        if (!doc) throw new Error('Preview unavailable')
        const container = doc.createElement('div')
        const policy = doc.createElement('meta')
        policy.httpEquiv = 'Content-Security-Policy'
        policy.content = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:"
        doc.head.replaceChildren(policy)
        doc.body.replaceChildren(container)
        doc.body.style.margin = '0'
        const { renderAsync } = await import('docx-preview')
        const binary = atob(base64)
        if (cancelled) return
        await renderAsync(
          Uint8Array.from(binary, char => char.charCodeAt(0)),
          container,
          undefined,
          {
            inWrapper: true,
            breakPages: true,
            ignoreLastRenderedPageBreak: false,
            renderAltChunks: false,
            useBase64URL: true,
          },
        )
      } catch {
        if (!cancelled) setError(true)
      }
    }
    void render()
    return () => {
      cancelled = true
    }
  }, [base64])
  if (error)
    return (
      <div role="alert" className="p-4 text-danger-100">
        {t('fileExplorer.wordFailed')}
      </div>
    )
  return (
    <iframe
      ref={frame}
      title={t('fileExplorer.wordPreview')}
      sandbox="allow-same-origin"
      className="w-full h-full min-h-80 border-0 bg-white"
    />
  )
}
