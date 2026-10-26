import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { deleteSession, updateSession, type ApiSession } from '../../../api'
import { CheckIcon, ListFilterIcon, SpinnerIcon, TrashIcon } from '../../../components/Icons'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { SessionListItem } from '../../sessions/SessionList'
import { pinnedSessionsStore } from '../../../store/pinnedSessionsStore'
import { serverStore } from '../../../store/serverStore'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import { uiErrorHandler } from '../../../utils'
import { useRecentSessions } from './useRecentSessions'
import { makeSessionKey } from '../../../utils/sessionKey'

interface RecentSessionListProps {
  serverIds: string[]
  directory: string | undefined
  search: string
  selectedSessionId: string | null
  onSelectSession: (session: ApiSession & { serverId?: string }) => void
  onNewSession: () => void
}

export function RecentSessionList({
  serverIds,
  directory,
  search,
  selectedSessionId,
  onSelectSession,
  onNewSession,
}: RecentSessionListProps) {
  const { t } = useTranslation(['chat', 'common', 'commands'])
  const { preferTouchUi } = useInputCapabilities()
  const { sessions, allSessions, loading, failedServerIds, refresh, removeLocal } = useRecentSessions(
    serverIds,
    search,
    directory,
  )
  const [isEditMode, setIsEditMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const [deleteKeys, setDeleteKeys] = useState<string[]>([])
  const [isDeleting, setIsDeleting] = useState(false)
  const deletingRef = useRef(false)
  const mountedRef = useRef(true)
  const currentSelectionRef = useRef(selectedSessionId)
  useLayoutEffect(() => {
    currentSelectionRef.current = selectedSessionId
  }, [selectedSessionId])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const toggleSelection = (key: string, shiftKey?: boolean) => {
    const anchor = sessions.findIndex(entry => entry.key === anchorRef.current)
    const target = sessions.findIndex(entry => entry.key === key)
    const keys =
      shiftKey && anchor >= 0 && target >= 0
        ? sessions.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).map(entry => entry.key)
        : [key]
    setSelectedKeys(previous => {
      const next = new Set(previous)
      keys.forEach(id => {
        if (previous.has(key)) next.delete(id)
        else next.add(id)
      })
      return next
    })
    if (!shiftKey || anchor < 0) anchorRef.current = key
  }

  const confirmDelete = async () => {
    if (deletingRef.current) return
    deletingRef.current = true
    setIsDeleting(true)
    const deleted = new Set<string>()
    await Promise.all(
      deleteKeys.map(async key => {
        const entry = allSessions.find(item => item.key === key)
        if (!entry) return
        try {
          await deleteSession(entry.session.id, entry.session.directory, entry.serverId)
          clearSessionRuntimeState(key)
          if (entry.serverId === serverStore.getActiveServerId()) pinnedSessionsStore.unpin(entry.session.id)
          deleted.add(key)
        } catch (error) {
          uiErrorHandler('delete session', error)
        }
      }),
    )
    deletingRef.current = false
    if (!mountedRef.current) return
    removeLocal(deleted)
    setSelectedKeys(previous => new Set([...previous].filter(key => !deleted.has(key))))
    setDeleteKeys([])
    setIsDeleting(false)
    refresh()
    const currentSelection = currentSelectionRef.current
    const currentKey =
      currentSelection && !currentSelection.includes('::') && serverIds.length === 1
        ? makeSessionKey(serverIds[0], currentSelection)
        : currentSelection
    if (currentKey && deleted.has(currentKey)) onNewSession()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 px-2">
        {isEditMode && (
          <span className="mr-auto truncate text-[length:var(--fs-xxs)] text-text-400">
            {selectedKeys.size ? t('sidebar.selectedSessions', { count: selectedKeys.size }) : t('sidebar.selectItems')}
          </span>
        )}
        {isEditMode && selectedKeys.size > 0 && (
          <button
            type="button"
            onClick={() => setDeleteKeys([...selectedKeys])}
            aria-label={t('sidebar.deleteSessionsWithCount', { count: selectedKeys.size })}
            className="rounded-md p-1.5 text-text-400 hover:bg-danger-100/10 hover:text-danger-100"
          >
            <TrashIcon size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setIsEditMode(!isEditMode)
            setSelectedKeys(new Set())
            anchorRef.current = null
          }}
          aria-label={t(isEditMode ? 'sidebar.doneManaging' : 'sidebar.manageSessions')}
          title={t(isEditMode ? 'sidebar.doneManaging' : 'sidebar.manageSessions')}
          className="rounded-md p-1 text-text-500 hover:bg-bg-200/50 hover:text-text-300"
        >
          {isEditMode ? <CheckIcon size={14} /> : <ListFilterIcon size={14} />}
        </button>
      </div>
      <div
        role="region"
        aria-label={t('sidebar.recents')}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar px-2 pb-3"
      >
        {loading && (
          <div className="flex justify-center py-3">
            <SpinnerIcon size={16} className="animate-spin" />
          </div>
        )}
        {failedServerIds.length > 0 && (
          <div className="px-2 py-3 text-[length:var(--fs-xs)] text-text-400">
            <span>{t('sidebar.loadFailed')}</span>
            <button type="button" onClick={refresh} className="ml-2 text-accent-main-100">
              {t('common:retry')}
            </button>
          </div>
        )}
        {!loading && !failedServerIds.length && !sessions.length && (
          <p className="py-12 text-center text-[length:var(--fs-sm)] text-text-400">
            {search ? t('common:noMatchesFound') : t('commands:sessions.noChatsYet')}
          </p>
        )}
        {sessions.map(({ key, serverId, session }, index) => (
          <SessionListItem
            key={key}
            session={session}
            activeSessionKey={key}
            isSelected={selectedSessionId === key || (serverIds.length === 1 && selectedSessionId === session.id)}
            onSelect={() => onSelectSession({ ...session, serverId })}
            onDelete={() => setDeleteKeys([key])}
            onRename={async title => {
              try {
                await updateSession(session.id, { title }, session.directory, serverId)
                if (serverId === serverStore.getActiveServerId()) pinnedSessionsStore.update(session.id, { title })
                if (mountedRef.current) refresh()
              } catch (error) {
                uiErrorHandler('rename session', error)
              }
            }}
            preferTouchUi={preferTouchUi}
            density="compact"
            showDirectory
            showPinAction={serverId === serverStore.getActiveServerId()}
            isEditMode={isEditMode}
            isChecked={selectedKeys.has(key)}
            checkedPrev={index > 0 && selectedKeys.has(sessions[index - 1].key)}
            checkedNext={index < sessions.length - 1 && selectedKeys.has(sessions[index + 1].key)}
            onToggleCheck={options => toggleSelection(key, options?.shiftKey)}
          />
        ))}
      </div>
      <ConfirmDialog
        isOpen={deleteKeys.length > 0}
        onClose={() => {
          if (!isDeleting) setDeleteKeys([])
        }}
        onConfirm={confirmDelete}
        title={t('sidebar.batchDeleteSessions', { count: deleteKeys.length })}
        description={t('sidebar.batchDeleteSessionsConfirm', { count: deleteKeys.length })}
        confirmText={t('common:delete')}
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  )
}
