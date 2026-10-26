import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTheme } from '../hooks/useTheme'
import { createSandboxedHtmlDocument } from './htmlSandbox'
import { resolveHtmlPreviewResources } from './htmlPreviewResources'
import { resolveHtmlPreviewSelection } from '../utils/fuzzyPreviewSelection'

interface HtmlFilePreviewFrameProps {
  html: string
  title: string
  isResizing?: boolean
  filePath?: string
  directory?: string
  serverId?: string
}

export function HtmlFilePreviewFrame({
  html,
  title,
  isResizing = false,
  filePath,
  directory,
  serverId,
}: HtmlFilePreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const resourceKey = `${serverId ?? ''}\0${directory ?? ''}\0${filePath ?? ''}\0${html}`
  const [resolution, setResolution] = useState<{ key: string; html: string } | null>(null)
  const resizeId = useId()
  const documentId = useMemo(() => {
    void resourceKey
    return `${resizeId}:${crypto.randomUUID()}`
  }, [resizeId, resourceKey])
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [initialTheme] = useState<'light' | 'dark'>(theme)
  const effectiveHtml = filePath ? (resolution?.key === resourceKey ? resolution.html : null) : html
  const srcDoc = useMemo(
    () =>
      effectiveHtml !== null &&
      createSandboxedHtmlDocument(effectiveHtml, documentId, initialTheme, {
        overflow: 'auto',
        allowDataScripts: true,
      }),
    [effectiveHtml, initialTheme, documentId],
  )

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.type !== 'opencode-html-selection' ||
        event.data.id !== documentId
      )
        return
      const { text, x, y } = event.data
      if (typeof text !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) return
      const rect = frameRef.current.getBoundingClientRect()
      const mapped =
        typeof event.data.displayed === 'string' &&
        Number.isInteger(event.data.from) &&
        Number.isInteger(event.data.to) &&
        event.data.displayed.slice(event.data.from, event.data.to).replace(/\s/g, '') === text.replace(/\s/g, '')
          ? resolveHtmlPreviewSelection(html, event.data.displayed, event.data.from, event.data.to)
          : null
      const inTextPreview = !!frameRef.current.closest('[data-text-file-preview]')
      frameRef.current.dispatchEvent(
        new CustomEvent('opencode-preview-selection', {
          bubbles: true,
          detail: {
            text,
            x: rect.left + x,
            y: rect.top + y,
            ...(mapped
              ? { selection: { ...mapped, text }, mappedSource: html }
              : inTextPreview
                ? { mappingFailed: true }
                : {}),
          },
        }),
      )
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [documentId, html])

  useEffect(() => {
    if (!filePath) return
    let active = true
    resolveHtmlPreviewResources(html, filePath, directory, serverId).then(
      resolved => {
        if (active) setResolution({ key: resourceKey, html: resolved })
      },
      () => {
        if (active) setResolution({ key: resourceKey, html })
      },
    )
    return () => {
      active = false
    }
  }, [directory, filePath, html, resourceKey, serverId])

  const sendTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'opencode-html-theme', theme }, '*')
  }, [theme])

  useEffect(() => {
    sendTheme()
  }, [sendTheme])

  if (!srcDoc) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <span className="h-4 w-4 animate-spin rounded-full border border-text-400 border-t-transparent" />
      </div>
    )
  }

  // File previews are explicitly opened workspace content; sandboxing isolates them from the app origin.
  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={sendTheme}
      style={{ colorScheme: theme, touchAction: 'pan-x pan-y' }}
      className={`block h-full min-h-0 w-full border-0 bg-transparent ${isResizing ? 'pointer-events-none' : ''}`}
    />
  )
}
