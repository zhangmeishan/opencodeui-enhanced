import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getCurrentProject, listWorktrees } from '../api'
import { subscribeToServerEvents } from '../api/events'
import { serverStore } from '../store/serverStore'
import { isSameDirectory, normalizeToForwardSlash } from '../utils'
import { affectsBoundServer } from '../store/serverChangeScope'

export interface GitWorkspaceMeta {
  isGit: boolean
  rootDirectory: string
  // root workspace 放第一位，后面才是 sandbox worktree
  workspaces: string[]
}

export type GitWorkspaceCatalog = Map<string, GitWorkspaceMeta>

type RefreshListener = () => void
const EMPTY_CATALOG: GitWorkspaceCatalog = new Map()

const refreshListeners = new Set<RefreshListener>()

export function requestGitWorkspaceCatalogRefresh() {
  refreshListeners.forEach(listener => listener())
}

export function useGitWorkspaceCatalog(directories: string[], serverId?: string) {
  const boundServerId = useSyncExternalStore(
    serverStore.subscribe.bind(serverStore),
    () => serverId ?? serverStore.getActiveServerId(),
  )
  const [catalog, setCatalog] = useState<GitWorkspaceCatalog>(new Map())
  const [catalogOwner, setCatalogOwner] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const mountedRef = useRef(true)
  const versionRef = useRef(0)
  const catalogRef = useRef<GitWorkspaceCatalog>(new Map())
  const ownerRef = useRef<string | null>(null)

  const setCatalogState = useCallback(
    (nextCatalog: GitWorkspaceCatalog) => {
      catalogRef.current = nextCatalog
      ownerRef.current = boundServerId
      setCatalogOwner(boundServerId)
      setCatalog(nextCatalog)
    },
    [boundServerId],
  )

  const refresh = useCallback(async () => {
    const version = ++versionRef.current
    const normalizedDirectorySet = new Set(
      directories.filter(Boolean).map(directory => normalizeToForwardSlash(directory)),
    )
    const normalizedDirectories = Array.from(normalizedDirectorySet)

    if (normalizedDirectories.length === 0) {
      setIsLoading(false)
      setCatalogState(new Map())
      return
    }

    setIsLoading(true)
    const previousCatalog = ownerRef.current === boundServerId ? catalogRef.current : EMPTY_CATALOG

    try {
      const projectResults = await Promise.allSettled(
        normalizedDirectories.map(async directory => ({
          directory,
          project: await getCurrentProject(directory, boundServerId),
        })),
      )

      if (!mountedRef.current || version !== versionRef.current) return

      const rootDirectories = new Set<string>()
      const directoryToRoot = new Map<string, string>()
      const nextCatalog: GitWorkspaceCatalog = new Map()
      const previousWorkspacesByRoot = new Map<string, string[]>()

      for (const [directory, meta] of previousCatalog) {
        if (meta.isGit) {
          previousWorkspacesByRoot.set(meta.rootDirectory, meta.workspaces)
        }

        if (normalizedDirectorySet.has(directory)) {
          nextCatalog.set(directory, meta)
        }
      }

      for (let index = 0; index < projectResults.length; index++) {
        const result = projectResults[index]
        const directory = normalizedDirectories[index]

        if (result.status !== 'fulfilled') {
          const previousMeta = previousCatalog.get(directory)
          if (previousMeta?.isGit) {
            rootDirectories.add(previousMeta.rootDirectory)
            directoryToRoot.set(directory, previousMeta.rootDirectory)
          }
          continue
        }

        const { project } = result.value

        if (project.vcs === 'git' && project.worktree) {
          const rootDirectory = normalizeToForwardSlash(project.worktree)
          rootDirectories.add(rootDirectory)
          directoryToRoot.set(directory, rootDirectory)
        } else {
          nextCatalog.set(directory, {
            isGit: false,
            rootDirectory: directory,
            workspaces: [directory],
          })
        }
      }

      const rootDirectoryList = Array.from(rootDirectories)

      const workspaceResults = await Promise.allSettled(
        rootDirectoryList.map(async rootDirectory => ({
          rootDirectory,
          worktrees: await listWorktrees(rootDirectory, boundServerId),
        })),
      )

      if (!mountedRef.current || version !== versionRef.current) return

      const rootToWorkspaces = new Map<string, string[]>()

      for (let index = 0; index < workspaceResults.length; index++) {
        const result = workspaceResults[index]
        const rootDirectory = rootDirectoryList[index]

        if (result.status !== 'fulfilled') {
          rootToWorkspaces.set(rootDirectory, previousWorkspacesByRoot.get(rootDirectory) ?? [rootDirectory])
          continue
        }

        const { worktrees } = result.value
        const normalizedWorktrees = Array.from(new Set(worktrees.map(worktree => normalizeToForwardSlash(worktree))))
        const sandboxes = normalizedWorktrees.filter(worktree => !isSameDirectory(worktree, rootDirectory))
        rootToWorkspaces.set(rootDirectory, [rootDirectory, ...sandboxes])
      }

      for (const [directory, rootDirectory] of directoryToRoot) {
        nextCatalog.set(directory, {
          isGit: true,
          rootDirectory,
          workspaces: rootToWorkspaces.get(rootDirectory) ?? [rootDirectory],
        })
      }

      setCatalogState(nextCatalog)
    } finally {
      if (mountedRef.current && version === versionRef.current) {
        setIsLoading(false)
      }
    }
  }, [directories, boundServerId, setCatalogState])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  useEffect(() => {
    return subscribeToServerEvents(boundServerId, {
      onWorktreeReady: () => void refresh(),
      onWorktreeFailed: () => void refresh(),
      onReconnected: reason => {
        if (reason !== 'server-switch') void refresh()
      },
    })
  }, [refresh, boundServerId])

  useEffect(() => {
    const listener = () => void refresh()
    refreshListeners.add(listener)
    return () => {
      refreshListeners.delete(listener)
    }
  }, [refresh])

  useEffect(() => {
    return serverStore.onServerChange((changedServerId, reason) => {
      if (!affectsBoundServer(serverId, changedServerId, reason, serverStore.getActiveServerId())) return
      catalogRef.current = new Map()
      ownerRef.current = null
      setCatalogOwner(null)
      setCatalog(new Map())
      if (serverId || boundServerId === serverStore.getActiveServerId()) void refresh()
    })
  }, [refresh, serverId, boundServerId])

  return {
    catalog: catalogOwner === boundServerId ? catalog : EMPTY_CATALOG,
    isLoading,
    refresh,
  }
}
