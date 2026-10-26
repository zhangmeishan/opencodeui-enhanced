import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiBaseUrl, getAuthHeader } from '../api/http'

interface OfficeSession {
  scriptUrl: string
  config: Record<string, unknown>
  sessionToken: string
  editable: boolean
}
interface OfficeInstance {
  destroyEditor: () => void
}
declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => OfficeInstance }
  }
}
const scripts = new Map<string, Promise<void>>()
function loadOfficeScript(url: string): Promise<void> {
  if (window.DocsAPI) return Promise.resolve()
  const existing = scripts.get(url)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const timer = setTimeout(() => {
      script.remove()
      reject(new Error('Document editor timed out'))
    }, 20_000)
    script.src = url
    script.onload = () => {
      clearTimeout(timer)
      if (window.DocsAPI) resolve()
      else reject(new Error('Document editor could not be initialized'))
    }
    script.onerror = () => {
      clearTimeout(timer)
      script.remove()
      reject(new Error('Document editor could not be loaded'))
    }
    document.head.append(script)
  }).catch(error => {
    scripts.delete(url)
    throw error
  })
  scripts.set(url, promise)
  return promise
}

export function OnlyOfficeEditor({
  path,
  directory,
  serverId,
  onPreview,
  mode = 'edit',
  onUnavailable,
}: {
  path: string
  directory: string
  serverId: string
  onPreview: () => void
  mode?: 'edit' | 'view'
  onUnavailable?: () => void
}) {
  const { t, i18n } = useTranslation('components')
  const id = `onlyoffice-${useId().replace(/[^a-z\d]/gi, '')}`
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [modified, setModified] = useState(false)
  const modifiedRef = useRef(false)
  const [revision, setRevision] = useState(0)
  const [credentials, setCredentials] = useState<{ username: string; password: string } | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)
  const bridgeUrl = (import.meta.env.VITE_OFFICE_BRIDGE_URL || '/office-api').replace(/\/$/, '')
  const onUnavailableRef = useRef(onUnavailable)
  useEffect(() => {
    onUnavailableRef.current = onUnavailable
  }, [onUnavailable])

  useEffect(() => {
    let disposed = false,
      instance: OfficeInstance | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      readyTimer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    let documentReady = false
    const run = async () => {
      let unauthorized = false
      setLoading(true)
      setError('')
      setNeedsAuth(false)
      setAvailable(false)
      setSavedAt('')
      setModified(false)
      modifiedRef.current = false
      try {
        const authorization = credentials
          ? {
              Authorization: `Basic ${btoa(Array.from(new TextEncoder().encode(`${credentials.username}:${credentials.password}`), byte => String.fromCharCode(byte)).join(''))}`,
            }
          : getAuthHeader(serverId)
        const response = await fetch(`${bridgeUrl}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authorization },
          signal: controller.signal,
          body: JSON.stringify({
            serverUrl: new URL(getApiBaseUrl(serverId), window.location.href).href.replace(/\/$/, ''),
            directory,
            path,
            language: i18n.language,
            mode,
          }),
        })
        if (response.status === 401) {
          unauthorized = true
          setNeedsAuth(true)
          throw new Error(t('fileExplorer.officeLoginRequired'))
        }
        if (!response.headers.get('content-type')?.includes('application/json'))
          throw new Error(t('fileExplorer.officeNotConfigured'))
        const session = (await response.json()) as OfficeSession & { message?: string }
        if (!response.ok) throw new Error(session.message || t('fileExplorer.officeUnavailable'))
        const documentConfig = session.config?.document as
          | { permissions?: { edit?: boolean; review?: boolean; comment?: boolean; fillForms?: boolean } }
          | undefined
        const editorConfig = session.config?.editorConfig as { mode?: string } | undefined
        if (
          mode === 'view' &&
          (session.editable !== false ||
            editorConfig?.mode !== 'view' ||
            documentConfig?.permissions?.edit !== false ||
            documentConfig.permissions.review === true ||
            documentConfig.permissions.comment === true ||
            documentConfig.permissions.fillForms === true)
        ) {
          throw new Error(t('fileExplorer.officeReadonlyRequired'))
        }
        const scriptUrl = new URL(session.scriptUrl)
        if (!['http:', 'https:'].includes(scriptUrl.protocol) || scriptUrl.username || scriptUrl.password)
          throw new Error(t('fileExplorer.officeUnavailable'))
        await loadOfficeScript(scriptUrl.href)
        if (disposed || !hostRef.current) return
        // ONLYOFFICE replaces the target div; retain a React-owned outer container.
        const target = document.createElement('div')
        target.id = id
        hostRef.current.replaceChildren(target)
        instance = new window.DocsAPI!.DocEditor(id, {
          ...session.config,
          events: {
            onDocumentStateChange: (event: { data?: boolean }) => {
              if (!disposed && mode === 'edit' && session.editable) {
                modifiedRef.current = !!event.data
                setModified(!!event.data)
              }
            },
            onAppReady: () => {
              if (!disposed) setLoading(false)
            },
            onDocumentReady: () => {
              documentReady = true
              clearTimeout(readyTimer)
              if (!disposed) setLoading(false)
            },
            onError: (event: { data?: { errorDescription?: string } }) => {
              if (!disposed) {
                setError(event.data?.errorDescription || t('fileExplorer.officeUnavailable'))
                if (mode === 'view' && !unauthorized) onUnavailableRef.current?.()
              }
            },
          },
        })
        setAvailable(true)
        setLoading(false)
        if (mode === 'view' || !session.editable) {
          if (!documentReady)
            readyTimer = setTimeout(() => {
              if (!disposed) onUnavailableRef.current?.()
            }, 20000)
          return
        }
        const poll = async () => {
          try {
            const statusResponse = await fetch(
              `${bridgeUrl}/status?token=${encodeURIComponent(session.sessionToken)}`,
              { signal: controller.signal },
            )
            if (!statusResponse.ok) throw new Error(t('fileExplorer.officeStatusFailed'))
            const status = (await statusResponse.json()) as { error?: string; savedAt?: string }
            if (!disposed) {
              if (status.error) setError(status.error)
              else {
                setError('')
                setSavedAt(status.savedAt || '')
              }
            }
          } catch (error) {
            if (!disposed) setError(error instanceof Error ? error.message : t('fileExplorer.officeStatusFailed'))
          }
          if (!disposed) timer = setTimeout(() => void poll(), 3000)
        }
        void poll()
      } catch (error) {
        if (!disposed) {
          setError(error instanceof Error ? error.message : t('fileExplorer.officeUnavailable'))
          setLoading(false)
          if (mode === 'view' && !unauthorized) onUnavailableRef.current?.()
        }
      }
    }
    void run()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
      clearTimeout(readyTimer)
      instance?.destroyEditor()
    }
  }, [path, directory, serverId, credentials, revision, bridgeUrl, id, i18n.language, t, mode])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (modifiedRef.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-200/50 text-[length:var(--fs-xs)]">
        <span className="flex-1 text-text-400">
          {t(mode === 'view' ? 'fileExplorer.officeReadonlyPreview' : 'fileExplorer.edit')}{' '}
          {modified ? `· ${t('fileExplorer.officeModified')} ` : ''}
          {savedAt ? `· ${t('fileExplorer.officeSaved', { time: new Date(savedAt).toLocaleTimeString() })}` : ''}
        </span>
        <button
          type="button"
          onClick={() => {
            if (modifiedRef.current && !window.confirm(t('fileExplorer.officeLeaveConfirm'))) return
            onPreview()
          }}
          className="px-2 py-1 rounded hover:bg-bg-200"
        >
          {t(mode === 'view' ? 'fileExplorer.officeLocalPreview' : 'fileExplorer.officePreview')}
        </button>
        {!available && (
          <button
            type="button"
            onClick={() => setRevision(value => value + 1)}
            className="px-2 py-1 rounded hover:bg-bg-200"
          >
            {t('common:retry')}
          </button>
        )}
      </div>
      {loading && (
        <div role="status" className="p-3 text-text-400">
          {t('fileExplorer.officeLoading')}
        </div>
      )}
      {error && (
        <div role="alert" className="p-3 text-danger-100 text-[length:var(--fs-sm)]">
          {error.replace(/ONLYOFFICE/gi, t('fileExplorer.documentEditor')).replace(/office-bridge\/README\.md/gi, '')}
        </div>
      )}
      {!available && !loading && (
        <div className="px-3 pb-3 text-text-400 text-[length:var(--fs-sm)]">{t('fileExplorer.officeSetupHint')}</div>
      )}
      {needsAuth && (
        <form
          className="p-3 flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            setCredentials({ username: String(data.get('username')), password: String(data.get('password')) })
          }}
        >
          <input
            name="username"
            required
            autoComplete="username"
            aria-label={t('fileExplorer.officeUsername')}
            placeholder={t('fileExplorer.officeUsername')}
            className="p-2 border border-border-200 rounded bg-bg-100"
          />
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            aria-label={t('fileExplorer.officePassword')}
            placeholder={t('fileExplorer.officePassword')}
            className="p-2 border border-border-200 rounded bg-bg-100"
          />
          <button type="submit" className="p-2 rounded bg-bg-200">
            {t('fileExplorer.officeLogin')}
          </button>
        </form>
      )}
      <div ref={hostRef} className={available ? 'flex-1 min-h-0' : 'hidden'} />
    </div>
  )
}
