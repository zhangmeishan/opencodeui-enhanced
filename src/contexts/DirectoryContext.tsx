// ============================================
// DirectoryContext - 管理当前工作目录
// ============================================

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { getPath, type ApiPath } from '../api'
import { useRouter } from '../hooks/useRouter'
import { handleError, normalizeToForwardSlash, getDirectoryName, isSameDirectory, serverStorage } from '../utils'
import { layoutStore, useLayoutStore } from '../store/layoutStore'
import { serverStore } from '../store/serverStore'
import { multiServerStore, useMultiServerStore } from '../store/multiServerStore'
import { isTauri } from '../utils/tauri'
import { DirectoryContext, type DirectoryContextValue, type SavedDirectory } from './DirectoryContext.shared'
import { isWithinWorkspace } from '../utils/workspaceBoundary'
import { affectsBoundServer } from '../store/serverChangeScope'

const STORAGE_KEY_SAVED = 'opencode-saved-directories'
const STORAGE_KEY_RECENT = 'opencode-recent-projects'

// 最近使用记录: { [path]: lastUsedAt }
type RecentProjects = Record<string, number>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readSavedDirectories(serverId?: string): SavedDirectory[] {
  const saved = serverId
    ? serverStorage.getJSONFor<unknown>(STORAGE_KEY_SAVED, serverId)
    : serverStorage.getJSON<unknown>(STORAGE_KEY_SAVED)
  if (!Array.isArray(saved)) return []

  return saved.flatMap(item => {
    if (!isRecord(item) || typeof item.path !== 'string') return []
    const path = item.path
    return [
      {
        path,
        name: typeof item.name === 'string' && item.name.trim() ? item.name : getDirectoryName(path) || path,
        addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      },
    ]
  })
}

function readRecentProjects(serverId?: string): RecentProjects {
  const recent = serverId
    ? serverStorage.getJSONFor<unknown>(STORAGE_KEY_RECENT, serverId)
    : serverStorage.getJSON<unknown>(STORAGE_KEY_RECENT)
  if (!isRecord(recent)) return {}

  return Object.fromEntries(
    Object.entries(recent).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  )
}

export function DirectoryProvider({ children }: { children: ReactNode }) {
  // 从 URL 获取 directory（替代 localStorage）
  const { directory: urlDirectory, setDirectory: setUrlDirectory } = useRouter()

  // 从 layoutStore 获取 sidebarExpanded
  const { sidebarExpanded } = useLayoutStore()

  const [savedDirectories, setSavedDirectories] = useState<SavedDirectory[]>(readSavedDirectories)

  const [recentProjects, setRecentProjects] = useState<RecentProjects>(readRecentProjects)

  const [pathInfo, setPathInfo] = useState<ApiPath | null>(null)
  const [pathOwner, setPathOwner] = useState<string | undefined>(undefined)
  const pathRequestRef = useRef(0)

  // 多服务器模式：路径信息跟随焦点服务器（焦点缺省 = 活动服务器）
  const multiServerConfig = useMultiServerStore()
  const activeServerId = useSyncExternalStore(serverStore.subscribe.bind(serverStore), () =>
    serverStore.getActiveServerId(),
  )
  const pathServerId = multiServerConfig.enabled ? multiServerStore.getFocusedServerId() : activeServerId
  // Initial legacy state is read for the active server; don't write it to a
  // different focused server before its own storage has loaded.
  const [storageOwner, setStorageOwner] = useState<string | null>(null)

  // 服务器 ID 切换时切换 per-server 目录；local runtime URL 变化时只刷新 path info。
  useEffect(() => {
    return serverStore.onServerChange((changedServerId, reason) => {
      const targetServerId = multiServerStore.isEnabled()
        ? multiServerStore.getFocusedServerId()
        : serverStore.getActiveServerId()
      if (!affectsBoundServer(targetServerId, changedServerId, reason, serverStore.getActiveServerId())) return
      if (reason === 'server-switch') {
        setUrlDirectory(undefined)
      }
      setPathInfo(null)
      const requestId = ++pathRequestRef.current
      getPath(targetServerId)
        .then(info => {
          if (requestId === pathRequestRef.current) {
            setPathOwner(targetServerId)
            setPathInfo(info)
          }
        })
        .catch(handleError('get path info', 'api'))
    })
  }, [setUrlDirectory])

  // 加载路径信息（活动/焦点服务器变化时刷新）
  useEffect(() => {
    let cancelled = false
    setPathInfo(null)
    const requestId = ++pathRequestRef.current
    getPath(pathServerId)
      .then(info => {
        if (!cancelled && requestId === pathRequestRef.current) {
          setPathOwner(pathServerId)
          setPathInfo(info)
        }
      })
      .catch(handleError('get path info', 'api'))
    return () => {
      cancelled = true
    }
  }, [pathServerId])
  const workspaceRoot = pathOwner === pathServerId ? pathInfo?.directory : undefined

  useEffect(() => {
    setSavedDirectories(readSavedDirectories(pathServerId))
    setRecentProjects(readRecentProjects(pathServerId))
    setStorageOwner(pathServerId)
  }, [pathServerId])

  // 保存 savedDirectories 到 per-server storage
  useEffect(() => {
    if (storageOwner === pathServerId) serverStorage.setJSONFor(STORAGE_KEY_SAVED, savedDirectories, storageOwner)
  }, [savedDirectories, storageOwner, pathServerId])

  // 保存 recentProjects 到 per-server storage
  useEffect(() => {
    if (storageOwner === pathServerId) serverStorage.setJSONFor(STORAGE_KEY_RECENT, recentProjects, storageOwner)
  }, [recentProjects, storageOwner, pathServerId])

  // 设置当前目录（更新 URL + 记录最近使用）
  const setCurrentDirectory = useCallback(
    (directory: string | undefined) => {
      if (directory && !isWithinWorkspace(directory, workspaceRoot)) return
      setUrlDirectory(directory)
      if (directory) {
        setRecentProjects(prev => ({ ...prev, [directory]: Date.now() }))
      }
    },
    [setUrlDirectory, workspaceRoot],
  )

  // 添加目录
  const addDirectory = useCallback(
    (path: string) => {
      let normalized = normalizeToForwardSlash(path)

      // normalizeToForwardSlash 会去掉尾斜杠，导致根路径 "/" → "" 和 "C:/" → "C:"
      // 需要修正：如果原始路径是根路径，恢复正确的值
      const trimmed = path.replace(/\\/g, '/').replace(/\/+$/, '/')
      if (!normalized && (trimmed === '/' || /^[a-zA-Z]:\/$/.test(trimmed))) {
        normalized = trimmed.slice(0, -1) || '/'
      }

      // 验证路径非空（只阻止空字符串和 "."）
      if (!normalized || !isWithinWorkspace(normalized, workspaceRoot)) return

      // 使用 isSameDirectory 检查是否已存在（处理大小写和斜杠差异）
      if (savedDirectories.some(d => isSameDirectory(d.path, normalized))) {
        setCurrentDirectory(normalized)
        return
      }

      const newDir: SavedDirectory = {
        path: normalized,
        name: getDirectoryName(normalized) || normalized,
        addedAt: Date.now(),
      }

      setSavedDirectories(prev => [...prev, newDir])
      setCurrentDirectory(normalized)
    },
    [savedDirectories, setCurrentDirectory, workspaceRoot],
  )

  // 移除目录
  const removeDirectory = useCallback(
    (path: string) => {
      const normalized = normalizeToForwardSlash(path)
      setSavedDirectories(prev => prev.filter(d => !isSameDirectory(d.path, normalized)))
      if (isSameDirectory(urlDirectory, normalized)) {
        setCurrentDirectory(undefined)
      }
    },
    [urlDirectory, setCurrentDirectory],
  )

  const reorderDirectories = useCallback((draggedPath: string, targetPath: string) => {
    const normalizedDragged = normalizeToForwardSlash(draggedPath)
    const normalizedTarget = normalizeToForwardSlash(targetPath)

    if (!normalizedDragged || !normalizedTarget || isSameDirectory(normalizedDragged, normalizedTarget)) {
      return
    }

    setSavedDirectories(prev => {
      const next = [...prev]
      const draggedIndex = next.findIndex(directory => isSameDirectory(directory.path, normalizedDragged))
      const targetIndex = next.findIndex(directory => isSameDirectory(directory.path, normalizedTarget))

      if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
        return prev
      }

      const [draggedDirectory] = next.splice(draggedIndex, 1)
      next.splice(targetIndex, 0, draggedDirectory)
      return next
    })
  }, [])

  // Tauri: 启动时获取 CLI 传入的目录 + 监听后续 open-directory 事件
  // 用 ref 持有最新的 addDirectory 避免 stale closure
  const addDirectoryRef = useRef(addDirectory)
  addDirectoryRef.current = addDirectory

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined

    // 拉取启动时的 CLI 目录（一次性）
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string | null>('get_cli_directory')
        .then(dir => {
          if (dir) addDirectoryRef.current(dir)
        })
        .catch(() => {})
    })

    // 监听后续的 open-directory 事件（single-instance / macOS RunEvent::Opened）
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('open-directory', event => {
        addDirectoryRef.current(event.payload)
      }).then(fn => {
        unlisten = fn
      })
    })

    return () => {
      unlisten?.()
    }
  }, [])

  // 设置侧边栏展开 - 委托给 layoutStore
  const setSidebarExpanded = useCallback((expanded: boolean) => {
    layoutStore.setSidebarExpanded(expanded)
  }, [])

  // 稳定化 Provider value，避免每次渲染创建新对象导致子组件不必要重渲染
  const value = useMemo<DirectoryContextValue>(
    () => ({
      currentDirectory: isWithinWorkspace(urlDirectory, workspaceRoot) ? urlDirectory : workspaceRoot,
      setCurrentDirectory,
      savedDirectories:
        storageOwner === pathServerId
          ? savedDirectories.filter(item => isWithinWorkspace(item.path, workspaceRoot))
          : [],
      addDirectory,
      removeDirectory,
      reorderDirectories,
      pathInfo: pathOwner === pathServerId ? pathInfo : null,
      sidebarExpanded,
      setSidebarExpanded,
      recentProjects: storageOwner === pathServerId ? recentProjects : {},
    }),
    [
      urlDirectory,
      setCurrentDirectory,
      savedDirectories,
      addDirectory,
      removeDirectory,
      reorderDirectories,
      pathInfo,
      sidebarExpanded,
      setSidebarExpanded,
      recentProjects,
      workspaceRoot,
      pathOwner,
      pathServerId,
      storageOwner,
    ],
  )

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>
}
