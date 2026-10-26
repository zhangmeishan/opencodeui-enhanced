import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import {
  SidebarIcon,
  FolderIcon,
  PlusIcon,
  NewChatIcon,
  TrashIcon,
  SearchIcon,
  CloseIcon,
  ChevronDownIcon,
} from '../../../components/Icons'
import { useDirectory, useKeybindingLabel, useGitWorkspaceCatalog, useVcsInfo } from '../../../hooks'
import { useSessionContext } from '../../../contexts/useSessionContext'
import { useMultiServerStore, multiServerStore } from '../../../store/multiServerStore'
import { useServerStore } from '../../../hooks/useServerStore'
import { readServerWorkspaces } from '../../../utils/serverWorkspaces'
import { subscribePerServerStorageVersion, getStorageVersion } from '../../../utils/perServerStorage'
import { subscribeToConnectionState, type ApiSession, type ConnectionInfo } from '../../../api'
import { getDirectoryName, isSameDirectory, normalizeToForwardSlash } from '../../../utils'
import { isWithinWorkspace } from '../../../utils/workspaceBoundary'
import { getProjectGroupIdentity } from './projectGrouping'
import { getParentPath } from './sidebarUtils'
import { SidebarFooter } from './SidebarFooter'
import { RecentSessionList } from './RecentSessionList'
import { useFileNavigation } from '../../../store/fileNavigationStore'

const FileExplorer = lazy(() =>
  import('../../../components/FileExplorer').then(module => ({ default: module.FileExplorer })),
)

interface SidePanelProps {
  onNewSession: () => void
  onSelectSession: (session: ApiSession) => void
  onCloseMobile?: () => void
  selectedSessionId: string | null
  onAddProject: () => void
  isMobile?: boolean
  isExpanded?: boolean
  onToggleSidebar: () => void
  contextLimit?: number
  onOpenSettings?: () => void
}

interface ProjectItem {
  id: string
  worktree: string
  name: string
  memberDirectories: string[]
  workspaceDirectories: string[]
}

export function SidePanel({
  onNewSession,
  onSelectSession,
  onCloseMobile,
  selectedSessionId,
  onAddProject,
  isMobile = false,
  isExpanded = true,
  onToggleSidebar,
  contextLimit = 200000,
  onOpenSettings,
}: SidePanelProps) {
  const { t } = useTranslation(['chat', 'common'])
  const { currentDirectory, savedDirectories, setCurrentDirectory, removeDirectory, recentProjects, pathInfo } =
    useDirectory()
  const multiServerConfig = useMultiServerStore()
  const { activeServer, servers: registryServers } = useServerStore()
  const catalogServerId = multiServerConfig.enabled
    ? (multiServerConfig.focusedServerId ?? activeServer?.id)
    : activeServer?.id
  const storageVersion = useSyncExternalStore(subscribePerServerStorageVersion, getStorageVersion, getStorageVersion)
  const directories = useMemo(() => {
    void storageVersion
    if (multiServerConfig.enabled) {
      return readServerWorkspaces(multiServerStore.getFocusedServerId()).map(path => ({
        path,
        addedAt: 0,
        name: undefined,
      }))
    }
    return [...savedDirectories].sort(
      (a, b) => (recentProjects[b.path] || b.addedAt) - (recentProjects[a.path] || a.addedAt),
    )
  }, [multiServerConfig, storageVersion, savedDirectories, recentProjects])
  const catalogDirectories = useMemo(
    () =>
      Array.from(
        new Set(
          directories
            .map(directory => normalizeToForwardSlash(directory.path))
            .concat(currentDirectory ? [normalizeToForwardSlash(currentDirectory)] : []),
        ),
      ),
    [directories, currentDirectory],
  )
  const { catalog } = useGitWorkspaceCatalog(catalogDirectories, catalogServerId)
  const { vcsInfo, isLoading: isVcsLoading } = useVcsInfo(currentDirectory, catalogServerId)
  const projects = useMemo(() => {
    const groups = new Map<string, ProjectItem>()
    const root = pathInfo?.directory
    if (root)
      groups.set(root, {
        id: root,
        worktree: root,
        name: getDirectoryName(root),
        memberDirectories: [],
        workspaceDirectories: [],
      })
    for (const directory of directories) {
      const path = normalizeToForwardSlash(directory.path)
      if (!isWithinWorkspace(path, root)) continue
      const identity = getProjectGroupIdentity(path, catalog.get(path))
      const id = isWithinWorkspace(identity.projectId, root) ? identity.projectId : path
      const existing = groups.get(id)
      if (existing) {
        existing.memberDirectories.push(directory.path)
      } else {
        groups.set(id, {
          id,
          worktree: id,
          name: directory.name || getDirectoryName(id),
          memberDirectories: [directory.path],
          workspaceDirectories: (identity.workspaceDirectories ?? []).filter(workspace =>
            isWithinWorkspace(workspace, root),
          ),
        })
      }
    }
    return [...groups.values()]
  }, [directories, pathInfo?.directory, catalog])
  const currentProject = useMemo(
    () =>
      projects.find(
        project =>
          isSameDirectory(project.worktree, currentDirectory) ||
          project.memberDirectories.some(path => isSameDirectory(path, currentDirectory)) ||
          project.workspaceDirectories.some(path => isSameDirectory(path, currentDirectory)),
      ),
    [projects, currentDirectory],
  )
  const currentProjectLabel = useMemo(() => {
    const name =
      currentProject?.name ||
      (currentDirectory ? getDirectoryName(currentDirectory) : projects[0]?.name) ||
      t('common:loading')
    const branch = currentDirectory ? (vcsInfo?.branch ?? (isVcsLoading ? '...' : undefined)) : undefined
    return branch ? `${name} · ${branch}` : name
  }, [currentProject, currentDirectory, projects, vcsInfo?.branch, isVcsLoading, t])

  const subscribedServerIds = useMemo(
    () => multiServerConfig.subscribedServerIds.filter(id => registryServers.some(server => server.id === id)),
    [multiServerConfig.subscribedServerIds, registryServers],
  )
  const recentServerIds = useMemo(
    () =>
      catalogServerId && (!multiServerConfig.enabled || subscribedServerIds.includes(catalogServerId))
        ? [catalogServerId]
        : [],
    [catalogServerId, multiServerConfig.enabled, subscribedServerIds],
  )
  const [sidebarTab, setSidebarTab] = useState<'files' | 'recents'>('files')
  const fileNavigation = useFileNavigation()
  const fileReveal =
    fileNavigation?.sessionId === selectedSessionId && fileNavigation.file.serverId === catalogServerId
      ? fileNavigation
      : null
  const [handledRevealRevision, setHandledRevealRevision] = useState(0)
  const visibleTab = fileReveal && fileReveal.revision !== handledRevealRevision ? 'files' : sidebarTab
  const [projectsExpanded, setProjectsExpanded] = useState(false)
  const [removeProjectId, setRemoveProjectId] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionInfo | null>(null)
  const { search, setSearch } = useSessionContext()
  const projectToggleRef = useRef<HTMLButtonElement>(null)
  const projectsDropdownRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingOpenProjectsRef = useRef(false)
  const pendingFocusSearchRef = useRef(false)
  const showLabels = isExpanded || isMobile
  const newChatShortcut = useKeybindingLabel('newSession')

  useEffect(() => subscribeToConnectionState(setConnectionState), [])
  useEffect(() => {
    if (showLabels && projectsExpanded) return
    if (document.activeElement && projectsDropdownRef.current?.contains(document.activeElement))
      projectToggleRef.current?.focus()
  }, [projectsExpanded, showLabels])
  useEffect(() => {
    if (!showLabels) return
    if (pendingOpenProjectsRef.current) {
      pendingOpenProjectsRef.current = false
      const frame = requestAnimationFrame(() => setProjectsExpanded(true))
      return () => cancelAnimationFrame(frame)
    }
    if (pendingFocusSearchRef.current) {
      pendingFocusSearchRef.current = false
      const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [showLabels])
  useEffect(() => {
    if (isExpanded) return
    const frame = requestAnimationFrame(() => setProjectsExpanded(false))
    return () => cancelAnimationFrame(frame)
  }, [isExpanded])

  const handleSelect = useCallback(
    (session: ApiSession) => {
      onSelectSession(session)
      if (isMobile) onCloseMobile?.()
    },
    [onSelectSession, isMobile, onCloseMobile],
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mobile-safe-topbar-14 flex shrink-0 items-center">
        <div
          className="overflow-hidden transition-[width,padding,opacity] duration-300 ease-out"
          style={{ width: showLabels ? 'auto' : 0, paddingLeft: showLabels ? 16 : 0, opacity: showLabels ? 1 : 0 }}
        >
          <a href="/" className="flex items-center whitespace-nowrap">
            <span className="text-[length:var(--fs-heading-3)] font-semibold tracking-tight text-text-100">
              {t('header.openCode')}
            </span>
          </a>
        </div>
        {!isMobile && (
          <div
            className="flex flex-1 items-center transition-all duration-300 ease-out"
            style={{ justifyContent: showLabels ? 'flex-end' : 'center', paddingRight: showLabels ? 8 : 0 }}
          >
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={t(isExpanded ? 'sidebar.collapseSidebar' : 'sidebar.expandSidebar')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-300 transition-all hover:bg-bg-200 hover:text-text-100"
            >
              <SidebarIcon size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="mx-2 -mt-2.5 flex shrink-0 flex-col gap-0.5">
        <button
          type="button"
          onClick={onNewSession}
          aria-label={t('sidebar.newChat')}
          title={t('sidebar.newChat')}
          className="group flex h-8 items-center overflow-hidden rounded-lg text-text-300 transition-all duration-300 hover:bg-bg-200 hover:text-text-100"
          style={{ width: showLabels ? '100%' : 32, paddingLeft: 6, paddingRight: 6 }}
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <NewChatIcon size={16} />
          </span>
          <span
            className="ml-2 whitespace-nowrap text-[length:var(--fs-base)] transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t('sidebar.newChat')}
          </span>
          <span
            className="ml-auto whitespace-nowrap text-[length:var(--fs-xxs)] text-text-500 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ opacity: showLabels ? undefined : 0 }}
          >
            {newChatShortcut}
          </span>
        </button>
        <button
          ref={projectToggleRef}
          type="button"
          onClick={() => {
            if (!showLabels) {
              pendingOpenProjectsRef.current = true
              onToggleSidebar()
              return
            }
            setProjectsExpanded(!projectsExpanded)
          }}
          aria-expanded={showLabels && projectsExpanded}
          aria-label={currentProjectLabel}
          title={currentProjectLabel}
          className={`flex h-8 items-center overflow-hidden rounded-lg transition-all duration-300 ${projectsExpanded && showLabels ? 'bg-bg-200 text-text-100' : 'text-text-300 hover:bg-bg-200 hover:text-text-100'}`}
          style={{ width: showLabels ? '100%' : 32, paddingLeft: 6, paddingRight: 6 }}
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <FolderIcon size={16} />
          </span>
          <span
            className="ml-2 min-w-0 flex-1 truncate text-left text-[length:var(--fs-base)] transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {currentProjectLabel}
          </span>
          <ChevronDownIcon
            size={14}
            className={`ml-auto shrink-0 text-text-400 transition-all duration-200 ${projectsExpanded && showLabels ? '' : '-rotate-90'}`}
            style={{ opacity: showLabels ? 1 : 0 }}
          />
        </button>
        <div
          ref={projectsDropdownRef}
          className="overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-out"
          style={{
            maxHeight: showLabels && projectsExpanded ? 304 : 0,
            opacity: showLabels && projectsExpanded ? 1 : 0,
            marginTop: showLabels && projectsExpanded ? 4 : 0,
            visibility: showLabels && projectsExpanded ? 'visible' : 'hidden',
            pointerEvents: showLabels && projectsExpanded ? 'auto' : 'none',
          }}
          aria-hidden={!showLabels || !projectsExpanded}
        >
          <div className="glass-alt overflow-hidden rounded-lg border border-border-200/60 shadow-sm">
            <div className="custom-scrollbar max-h-48 overflow-y-auto p-1">
              {projects.map(project => (
                <div
                  key={project.id}
                  className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${currentProject?.id === project.id ? 'bg-bg-200/60 text-text-100' : 'text-text-300 hover:bg-bg-200/50 hover:text-text-100'}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentDirectory(project.worktree)
                      setProjectsExpanded(false)
                    }}
                    aria-current={currentProject?.id === project.id ? 'true' : undefined}
                    title={project.worktree}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      <FolderIcon size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--fs-sm)]">
                        {currentProject?.id === project.id ? currentProjectLabel : project.name}
                      </span>
                      <span className="block truncate font-mono text-[length:var(--fs-xxs)] text-text-400 opacity-70">
                        {getParentPath(project.worktree)}
                      </span>
                    </span>
                  </button>
                  {project.memberDirectories.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setRemoveProjectId(project.id)}
                      aria-label={t('sidebar.removeProject')}
                      title={t('common:remove')}
                      className="rounded p-1 text-text-400 transition-all hover:bg-danger-100/10 hover:text-danger-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
                    >
                      <TrashIcon size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="relative p-1 pt-1.5">
              <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-border-200/30" />
              {multiServerConfig.enabled && subscribedServerIds.length > 0 && (
                <div className="mb-1 flex w-full items-center gap-2 rounded-md bg-bg-200/40 px-2 py-1.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <span className="h-2 w-2 rounded-full bg-success-100" />
                  </span>
                  <span className="truncate text-[length:var(--fs-sm)] text-text-300">
                    {registryServers.find(server => server.id === catalogServerId)?.name ?? catalogServerId}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setProjectsExpanded(false)
                  onAddProject()
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-text-300 transition-colors hover:bg-bg-200/50 hover:text-text-100"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <PlusIcon size={14} />
                </span>
                <span className="text-[length:var(--fs-sm)]">{t('sidebar.addProject')}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="relative flex h-8 items-center" style={{ width: showLabels ? '100%' : 32 }}>
          <button
            type="button"
            aria-label={t('sidebar.searchChats')}
            onClick={() => {
              if (!showLabels) {
                pendingFocusSearchRef.current = true
                onToggleSidebar()
                return
              }
              searchInputRef.current?.focus()
            }}
            className="absolute left-[6px] flex size-5 items-center justify-center text-text-400"
          >
            <SearchIcon size={16} />
          </button>
          <input
            ref={searchInputRef}
            type="text"
            name="sidebar-chat-search"
            value={search}
            onChange={event => {
              setSearch(event.target.value)
              setSidebarTab('recents')
              setHandledRevealRevision(fileReveal?.revision ?? 0)
            }}
            placeholder={t('sidebar.searchChats')}
            aria-label={t('sidebar.searchChats')}
            autoComplete="off"
            className="h-8 w-full rounded-lg border border-transparent bg-transparent pl-[34px] pr-7 text-[length:var(--fs-base)] text-text-100 placeholder:text-text-400 focus:border-border-200 focus:bg-bg-200/40 focus:outline-none"
            style={{ opacity: showLabels ? 1 : 0, visibility: showLabels ? 'visible' : 'hidden' }}
          />
          {showLabels && search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('common:clear')}
              className="absolute right-2 text-text-400 hover:text-text-100"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-300 ease-out"
        style={{ opacity: showLabels ? 1 : 0, visibility: showLabels ? 'visible' : 'hidden' }}
      >
        <div className="mx-2 flex shrink-0 items-center gap-1" role="tablist">
          {(['files', 'recents'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={visibleTab === tab}
              onClick={() => {
                setSidebarTab(tab)
                setHandledRevealRevision(fileReveal?.revision ?? 0)
              }}
              className={`py-1.5 pl-[6px] pr-2 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider transition-colors ${visibleTab === tab ? 'text-text-100' : 'text-text-500 hover:text-text-300'}`}
            >
              {t(`sidebar.${tab}`)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {visibleTab === 'files' ? (
            <Suspense fallback={<div className="p-3 text-text-400">{t('common:loading')}</div>}>
              <FileExplorer
                key={`${catalogServerId}:${fileReveal?.file.directory ?? currentDirectory ?? ''}`}
                panelTabId="sidebar-files"
                mode="tree"
                directory={fileReveal?.file.directory ?? currentDirectory}
                revealFile={fileReveal?.file}
                revealRevision={fileReveal?.revision}
                serverId={catalogServerId}
                previewFile={null}
                previewFiles={[]}
                position="right"
                onOpenFile={isMobile ? onCloseMobile : undefined}
              />
            </Suspense>
          ) : multiServerConfig.enabled && !recentServerIds.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[length:var(--fs-xs)] text-text-400/70">
              <span>{t('sidebar.noSubscribedServers')}</span>
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-md px-2 py-1 text-accent-main-100 hover:bg-accent-main-100/10"
              >
                {t('sidebar.openServerSettings')}
              </button>
            </div>
          ) : (
            <RecentSessionList
              key={JSON.stringify([recentServerIds, currentDirectory])}
              serverIds={recentServerIds}
              directory={currentDirectory}
              search={search}
              selectedSessionId={selectedSessionId}
              onSelectSession={handleSelect}
              onNewSession={onNewSession}
            />
          )}
        </div>
      </div>
      <SidebarFooter
        showLabels={showLabels}
        connectionState={connectionState?.state || 'disconnected'}
        contextLimit={contextLimit}
        onOpenSettings={onOpenSettings}
      />
      <ConfirmDialog
        isOpen={removeProjectId !== null}
        onClose={() => setRemoveProjectId(null)}
        onConfirm={() => {
          projects.find(project => project.id === removeProjectId)?.memberDirectories.forEach(removeDirectory)
          setRemoveProjectId(null)
        }}
        title={t('sidebar.removeProject')}
        description={t('sidebar.removeProjectConfirm')}
        confirmText={t('common:remove')}
        variant="danger"
      />
    </div>
  )
}
