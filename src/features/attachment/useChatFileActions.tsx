import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useSessionNavigation } from '../../contexts/SessionNavigationContext'
import { splitSessionKey } from '../../utils/sessionKey'
import { resolveChatFile } from '../../utils/chatFileNavigation'
import { getPath } from '../../api/client'
import { layoutStore } from '../../store/layoutStore'
import { fileNavigationStore } from '../../store/fileNavigationStore'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { useFileDownload } from './useFileDownload'
import { TransferProgressBar } from '../../components/TransferProgressBar'

export function useChatFileActions() {
  const { t } = useTranslation(['components', 'common', 'commands'])
  const navigation = useSessionNavigation()
  const latest = useRef(navigation)
  useLayoutEffect(() => {
    latest.current = navigation
  }, [navigation])
  const { download, error: downloadError, progress, fileName } = useFileDownload()
  const [openError, setOpenError] = useState(false)
  const [opening, setOpening] = useState(false)
  const request = useRef(0)
  useEffect(
    () => () => {
      request.current++
    },
    [],
  )
  const [menu, setMenu] = useState<{ href: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = useCallback(
    async (href: string) => {
      if (!navigation.currentSessionId) return
      const version = ++request.current
      const focusedPaneId = paneLayoutStore.getFocusedPaneId()
      setOpenError(false)
      setOpening(true)
      try {
        const serverId = splitSessionKey(navigation.currentSessionId).serverId
        const info = await getPath(serverId)
        if (
          version !== request.current ||
          latest.current.currentSessionId !== navigation.currentSessionId ||
          latest.current.currentDirectory !== navigation.currentDirectory ||
          paneLayoutStore.getFocusedPaneId() !== focusedPaneId
        )
          return
        const file = resolveChatFile(href, navigation.currentDirectory, serverId, info.directory)
        navigation.focusPane?.()
        layoutStore.activateServerScope(serverId)
        if (layoutStore.openFilePreview(file, 'right')) {
          fileNavigationStore.reveal(file, navigation.currentSessionId)
          layoutStore.setSidebarExpanded(true)
        }
      } catch {
        if (version === request.current) setOpenError(true)
      } finally {
        if (version === request.current) setOpening(false)
      }
    },
    [navigation],
  )
  useEffect(() => {
    setMenu(null)
  }, [navigation.currentSessionId, navigation.currentDirectory])
  const contextMenu = useCallback((event: React.MouseEvent, href: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      href,
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - 100)),
    })
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', close)
    }
  }, [menu])
  const controls = (
    <>
      {opening && (
        <p role="status" className="text-text-400 text-[length:var(--fs-sm)]">
          {t('common:loading')}
        </p>
      )}
      <TransferProgressBar progress={progress} label={`${t('common:download')} ${fileName}`} />
      {openError && (
        <p role="alert" className="text-danger-100 text-[length:var(--fs-sm)]">
          {t('components:fileExplorer.openChatFileFailed')}
        </p>
      )}
      {downloadError && (
        <p role="alert" className="text-danger-100 text-[length:var(--fs-sm)]">
          {t('commands:attachment.downloadFailed')}
        </p>
      )}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[10000] p-1 rounded-lg border border-border-200 bg-bg-100 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left rounded hover:bg-bg-200 text-[length:var(--fs-sm)]"
              onClick={() => {
                const href = menu.href
                setMenu(null)
                void open(href)
              }}
            >
              {t('components:fileExplorer.open')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left rounded hover:bg-bg-200 text-[length:var(--fs-sm)]"
              onClick={() => {
                const href = menu.href
                setMenu(null)
                void download(href)
              }}
            >
              {t('common:download')}
            </button>
          </div>,
          document.body,
        )}
    </>
  )
  return { open, contextMenu, controls }
}
