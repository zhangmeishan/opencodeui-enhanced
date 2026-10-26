// ============================================
// useFileExplorer - 文件浏览器 Hook
// 管理文件树状态、展开/折叠、文件预览
// ============================================

import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { listDirectory, getFileContent, getFileStatus, getSessionDiff, getLastTurnDiff, getVcsDiff } from '../api'
import type { FileNode, FileContent, FileStatusItem, FileDiff } from '../api/types'
import { useSessionChangeScope } from '../store/changeScopeStore'
import { activeSessionStore } from '../store/activeSessionStore'
import { useAutoRefresh } from './useAutoRefresh'
import { bytesToBase64, getFileMime, needsOriginalFilePreview, validateImagePreview } from '../utils/filePreview'
import { serverStore } from '../store/serverStore'
import { verifiedPreview, readVerifiedFile } from '../api/previewCache'
import { BINARY_PREVIEW_BYTES } from '../utils/previewLimits'
import { isProjectFilePath, isWithinWorkspace } from '../utils/workspaceBoundary'

export interface FileTreeNode extends FileNode {
  children?: FileTreeNode[]
  isLoading?: boolean
  isLoaded?: boolean
}

export interface UseFileExplorerOptions {
  projectRoot?: string | null
  directory?: string
  autoLoad?: boolean
  sessionId?: string
  /** 数据所属服务器（缺省用活动服务器；右侧面板跟随焦点 session 时传入） */
  serverId?: string
  /** 唯一标识，用于注册 SSE 消费者，避免多实例冲突 */
  consumerId?: string
}

export interface UseFileExplorerResult {
  // 文件树状态
  tree: FileTreeNode[]
  isLoading: boolean
  error: string | null

  // 展开状态
  expandedPaths: Set<string>
  toggleExpand: (path: string) => void
  expandPath: (path: string) => void
  collapsePath: (path: string) => void

  // 文件预览
  previewContent: FileContent | null
  previewLoading: boolean
  previewError: string | null
  loadPreview: (path: string, reload?: boolean) => Promise<void>
  clearPreview: () => void

  // 文件状态
  fileStatus: Map<string, FileStatusItem>

  // 操作
  refresh: () => Promise<void>
  softRefresh: () => Promise<void>
  loadChildren: (parentPath: string) => Promise<void>
}

export function useFileExplorer(options: UseFileExplorerOptions = {}): UseFileExplorerResult {
  const { directory, autoLoad = true, sessionId, serverId, projectRoot, consumerId = 'file-explorer' } = options
  const { t } = useTranslation(['components'])
  const changeMode = useSessionChangeScope(sessionId ?? null)

  // 多服务器模式：session 可能属于远端服务器，其工作区目录是远端路径（session 创建时的工作区）。
  // 文件树/文件状态应使用 session 自身目录，而不是本地 URL/currentDirectory 派生的目录。
  const sessionDirectory = useSyncExternalStore(
    cb => activeSessionStore.subscribe(cb),
    () => (sessionId ? activeSessionStore.getSessionMeta(sessionId)?.directory : undefined),
    () => (sessionId ? activeSessionStore.getSessionMeta(sessionId)?.directory : undefined),
  )
  const candidateDirectory = sessionId && sessionDirectory ? sessionDirectory : directory
  const effectiveDirectory =
    projectRoot === undefined || isWithinWorkspace(candidateDirectory, projectRoot || undefined)
      ? candidateDirectory
      : undefined
  const scopeKey = `${serverId ?? ''}\0${effectiveDirectory ?? ''}`
  const directoryRef = useRef(scopeKey)
  directoryRef.current = scopeKey

  // 文件树状态
  const [tree, setTree] = useState<FileTreeNode[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 展开状态
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const expandedPathsByDirectoryRef = useRef<Map<string, Set<string>>>(new Map())

  // 预览状态
  const [previewContent, setPreviewContent] = useState<FileContent | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewLoadIdRef = useRef(0)
  const activePreviewPathRef = useRef<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)

  // 文件状态（git）
  const [fileStatus, setFileStatus] = useState<Map<string, FileStatusItem>>(new Map())

  // 用于防止过时请求
  const loadIdRef = useRef(0)
  const childLoadIdsRef = useRef<Map<string, number>>(new Map())
  const statusLoadIdRef = useRef(0)

  // 加载根目录
  const loadRoot = useCallback(async () => {
    if (!effectiveDirectory) return

    const loadId = ++loadIdRef.current
    setIsLoading(true)
    setError(null)

    try {
      const nodes = await listDirectory('', effectiveDirectory, serverId)

      // 检查请求是否过时
      if (loadId !== loadIdRef.current || directoryRef.current !== scopeKey) return

      // 排序：目录在前，文件在后，按名称排序
      const sorted = sortNodes(
        nodes.filter(
          node =>
            isProjectFilePath(node.path, effectiveDirectory) && isWithinWorkspace(node.absolute, effectiveDirectory),
        ),
      )
      setTree(sorted.map(n => ({ ...n, children: n.type === 'directory' ? undefined : undefined })))
    } catch (e) {
      if (loadId === loadIdRef.current && directoryRef.current === scopeKey) {
        setError(e instanceof Error ? e.message : t('fileExplorer.failedToLoadFiles'))
      }
    } finally {
      if (loadId === loadIdRef.current && directoryRef.current === scopeKey) {
        setIsLoading(false)
      }
    }
  }, [effectiveDirectory, serverId, t, scopeKey])

  const loadStatuses = useCallback(async () => {
    if (!effectiveDirectory) {
      setFileStatus(new Map())
      return
    }

    const loadId = ++statusLoadIdRef.current
    const statusMap = new Map<string, FileStatusItem>()

    try {
      if (!sessionId) {
        const status = await getFileStatus(effectiveDirectory, serverId)
        if (loadId !== statusLoadIdRef.current || directoryRef.current !== scopeKey) return

        status.forEach(item => {
          const normalized = normalizePath(item.path)
          if (normalized.startsWith('../')) return
          statusMap.set(normalized, { ...item, path: normalized })
        })
      } else {
        const diffs =
          changeMode === 'git' || changeMode === 'branch'
            ? await getVcsDiff(changeMode, effectiveDirectory, serverId)
            : changeMode === 'turn'
              ? await getLastTurnDiff(sessionId, effectiveDirectory, serverId)
              : await getSessionDiff(sessionId, effectiveDirectory, serverId)

        if (loadId !== statusLoadIdRef.current || directoryRef.current !== scopeKey) return

        diffs.forEach(diff => {
          const normalized = normalizePath(diff.file)
          statusMap.set(normalized, {
            path: normalized,
            added: diff.additions,
            removed: diff.deletions,
            status: getFileStatusFromDiff(diff),
          })
        })
      }

      computeDirectoryStatus(statusMap)
      setFileStatus(statusMap)
    } catch {
      if (loadId !== statusLoadIdRef.current || directoryRef.current !== scopeKey) return
      setFileStatus(new Map())
    }
  }, [changeMode, effectiveDirectory, sessionId, serverId, scopeKey])

  // 加载子目录
  const loadChildren = useCallback(
    async (parentPath: string) => {
      if (!effectiveDirectory || !isProjectFilePath(parentPath, effectiveDirectory)) return

      const loadKey = `${scopeKey}\0${parentPath}`
      const loadId = (childLoadIdsRef.current.get(loadKey) ?? 0) + 1
      childLoadIdsRef.current.set(loadKey, loadId)

      const isCurrentLoad = () => directoryRef.current === scopeKey && childLoadIdsRef.current.get(loadKey) === loadId

      // 更新树，标记为加载中
      setTree(prev =>
        updateTreeNode(prev, parentPath, node => ({
          ...node,
          isLoading: true,
        })),
      )

      try {
        const nodes = await listDirectory(parentPath, effectiveDirectory, serverId)
        if (!isCurrentLoad()) return

        const sorted = sortNodes(
          nodes.filter(
            node =>
              isProjectFilePath(node.path, effectiveDirectory) && isWithinWorkspace(node.absolute, effectiveDirectory),
          ),
        )

        setTree(prev =>
          updateTreeNode(prev, parentPath, node => ({
            ...node,
            children: sorted.map(n => ({ ...n })),
            isLoading: false,
            isLoaded: true,
          })),
        )
      } catch {
        if (!isCurrentLoad()) return

        setTree(prev =>
          updateTreeNode(prev, parentPath, node => ({
            ...node,
            isLoading: false,
            isLoaded: true,
            children: [],
          })),
        )
      }
    },
    [effectiveDirectory, serverId, scopeKey],
  )

  const updateExpandedPaths = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setExpandedPaths(prev => {
        const next = updater(prev)
        if (effectiveDirectory) {
          expandedPathsByDirectoryRef.current.set(scopeKey, new Set(next))
        }
        return next
      })
    },
    [effectiveDirectory, scopeKey],
  )

  // 切换展开/折叠
  const toggleExpand = useCallback(
    (path: string) => {
      updateExpandedPaths(prev => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          // 如果该目录尚未加载，触发加载
          const node = findTreeNode(tree, path)
          if (node && node.type === 'directory' && !node.isLoaded && !node.isLoading) {
            loadChildren(path)
          }
        }
        return next
      })
    },
    [tree, loadChildren, updateExpandedPaths],
  )

  const expandPath = useCallback(
    (path: string) => {
      updateExpandedPaths(prev => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
      const node = findTreeNode(tree, path)
      if (node && node.type === 'directory' && !node.isLoaded && !node.isLoading) {
        loadChildren(path)
      }
    },
    [tree, loadChildren, updateExpandedPaths],
  )

  const collapsePath = useCallback(
    (path: string) => {
      updateExpandedPaths(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    },
    [updateExpandedPaths],
  )

  // 加载文件预览
  const loadPreview = useCallback(
    async (path: string, reload = false) => {
      if (!effectiveDirectory) return

      const loadId = ++previewLoadIdRef.current
      activePreviewPathRef.current = path
      previewAbortRef.current?.abort()
      const controller = new AbortController()
      previewAbortRef.current = controller

      setPreviewLoading(true)
      setPreviewError(null)

      setPreviewContent(null)

      try {
        if (!isProjectFilePath(path, effectiveDirectory)) throw new Error(t('fileExplorer.outsideProject'))
        // Native image reads avoid the PTY/base64 round trip for ordinary PNGs.
        const nativeImage = /\.(?:png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(path)
        const content: FileContent =
          needsOriginalFilePreview(path) && !nativeImage
            ? {
                type: 'binary',
                content: bytesToBase64(
                  await readVerifiedFile(path, effectiveDirectory, serverId ?? serverStore.getActiveServerId(), {
                    signal: controller.signal,
                    maxBytes: BINARY_PREVIEW_BYTES,
                    reload,
                  }),
                ),
                encoding: 'base64',
                mimeType: getFileMime(path),
              }
            : await verifiedPreview({
                path,
                directory: effectiveDirectory,
                serverId: serverId ?? serverStore.getActiveServerId(),
                variant: 'native-preview',
                diskKind: 'file-content',
                reload,
                signal: controller.signal,
                load: async () => {
                  const value = await getFileContent(path, effectiveDirectory, serverId)
                  if (value.content.length > Math.ceil(BINARY_PREVIEW_BYTES / 3) * 4)
                    throw new Error(t('fileExplorer.previewTooLarge'))
                  if (nativeImage && value.encoding === 'base64') validateImagePreview(value.content, path)
                  return value
                },
                size: value => value.content.length * 2,
              })
        if (content.content.length > Math.ceil(BINARY_PREVIEW_BYTES / 3) * 4)
          throw new Error(t('fileExplorer.previewTooLarge'))
        if (nativeImage && content.encoding === 'base64' && !content.mimeType) content.mimeType = getFileMime(path)
        if (nativeImage && content.encoding === 'base64') validateImagePreview(content.content, path)
        if (loadId !== previewLoadIdRef.current || directoryRef.current !== scopeKey) return
        setPreviewContent(content)
      } catch (e) {
        if (loadId !== previewLoadIdRef.current || directoryRef.current !== scopeKey) return
        setPreviewError(e instanceof Error ? e.message : t('fileExplorer.failedToLoadFile'))
        setPreviewContent(null)
      } finally {
        if (loadId === previewLoadIdRef.current && directoryRef.current === scopeKey) {
          setPreviewLoading(false)
        }
      }
    },
    [effectiveDirectory, t, serverId, scopeKey],
  )

  const clearPreview = useCallback(() => {
    activePreviewPathRef.current = null
    previewAbortRef.current?.abort()
    previewLoadIdRef.current += 1
    setPreviewContent(null)
    setPreviewError(null)
    setPreviewLoading(false)
  }, [])

  useEffect(() => {
    const revalidate = () => {
      if (activePreviewPathRef.current) void loadPreview(activePreviewPathRef.current)
    }
    window.addEventListener('focus', revalidate)
    return () => window.removeEventListener('focus', revalidate)
  }, [loadPreview])

  // 刷新
  const refresh = useCallback(async () => {
    if (effectiveDirectory) {
      expandedPathsByDirectoryRef.current.delete(scopeKey)
    }
    setExpandedPaths(new Set())
    previewLoadIdRef.current++
    setPreviewContent(null)
    await Promise.all([loadRoot(), loadStatuses()])
  }, [effectiveDirectory, loadRoot, loadStatuses, scopeKey])

  // 软刷新：重新加载根目录和状态，但保留展开路径和预览
  const softRefresh = useCallback(async () => {
    await Promise.all([loadRoot(), loadStatuses()])
  }, [loadRoot, loadStatuses])

  // 自动刷新：session idle / 窗口聚焦 / SSE 重连
  useAutoRefresh(consumerId, sessionId ?? null, softRefresh, autoLoad && !!effectiveDirectory)

  // 初始加载
  const invalidateTreeRequests = useCallback(() => {
    childLoadIdsRef.current.clear()
    loadIdRef.current++
    statusLoadIdRef.current++
  }, [])
  useLayoutEffect(() => {
    setTree([])
    setFileStatus(new Map())
    setError(null)
    invalidateTreeRequests()
    return invalidateTreeRequests
  }, [scopeKey, invalidateTreeRequests])

  useEffect(() => {
    if (autoLoad && effectiveDirectory) {
      loadRoot()
    }
  }, [autoLoad, effectiveDirectory, loadRoot])

  useEffect(() => {
    if (autoLoad && effectiveDirectory) {
      loadStatuses()
    }
  }, [autoLoad, effectiveDirectory, loadStatuses])

  useEffect(() => {
    if (!effectiveDirectory) {
      setExpandedPaths(new Set())
      return
    }

    const storedPaths = expandedPathsByDirectoryRef.current.get(scopeKey)
    setExpandedPaths(storedPaths ? new Set(storedPaths) : new Set())
  }, [effectiveDirectory, scopeKey])

  useEffect(() => {
    if (!effectiveDirectory || tree.length === 0 || expandedPaths.size === 0) return

    const pendingPaths = collectPendingExpandedDirectoryPaths(tree, expandedPaths)
    if (pendingPaths.length === 0) return

    pendingPaths.forEach(path => {
      void loadChildren(path)
    })
  }, [effectiveDirectory, expandedPaths, loadChildren, tree])

  useLayoutEffect(() => {
    activePreviewPathRef.current = null
    previewLoadIdRef.current += 1
    setPreviewContent(null)
    setPreviewError(null)
    setPreviewLoading(false)
    return () => {
      previewLoadIdRef.current++
      previewAbortRef.current?.abort()
    }
  }, [effectiveDirectory, sessionId, serverId])

  return {
    tree,
    isLoading,
    error,
    expandedPaths,
    toggleExpand,
    expandPath,
    collapsePath,
    previewContent,
    previewLoading,
    previewError,
    loadPreview,
    clearPreview,
    fileStatus,
    refresh,
    softRefresh,
    loadChildren,
  }
}

// ============================================
// Helper Functions
// ============================================

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    // 目录在前
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1
    }
    // 按名称排序（忽略大小写）
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}

function findTreeNode(tree: FileTreeNode[], path: string): FileTreeNode | null {
  for (const node of tree) {
    if (node.path === path) return node
    if (node.children) {
      const found = findTreeNode(node.children, path)
      if (found) return found
    }
  }
  return null
}

function updateTreeNode(
  tree: FileTreeNode[],
  path: string,
  updater: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
  return tree.map(node => {
    if (node.path === path) {
      return updater(node)
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeNode(node.children, path, updater),
      }
    }
    return node
  })
}

function collectPendingExpandedDirectoryPaths(tree: FileTreeNode[], expandedPaths: Set<string>): string[] {
  const pending: string[] = []

  const visit = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'directory') continue

      if (expandedPaths.has(node.path)) {
        if (!node.isLoaded && !node.isLoading) {
          pending.push(node.path)
          continue
        }
      }

      if (node.children) {
        visit(node.children)
      }
    }
  }

  visit(tree)
  return pending
}

// Helper: 规范化路径 — 统一分隔符为 /，去掉前导 ./
function normalizePath(p: string): string {
  let result = p.replace(/\\/g, '/')
  if (result.startsWith('./')) result = result.slice(2)
  return result
}

// Helper: 从 diff 推断文件状态（优先 status 字段，回退统计推断，最后 before/after 推断）
function getFileStatusFromDiff(diff: FileDiff): 'added' | 'modified' | 'deleted' {
  if (diff.status) return diff.status as 'added' | 'modified' | 'deleted'
  if (diff.deletions === 0 && diff.additions > 0) return 'added'
  if (diff.additions === 0 && diff.deletions > 0) return 'deleted'
  // 旧版 before/after 兼容
  if (diff.before !== undefined && diff.after !== undefined) {
    if (!diff.before.trim()) return 'added'
    if (!diff.after.trim()) return 'deleted'
  }
  return 'modified'
}

// Helper: 计算目录的累积状态（基于子文件状态）
function computeDirectoryStatus(statusMap: Map<string, FileStatusItem>): void {
  // 收集所有需要设置状态的目录路径
  const dirStatuses = new Map<string, 'added' | 'modified' | 'deleted'>()

  for (const [filePath, item] of statusMap) {
    const parts = filePath.split('/')
    // 构建所有父目录路径
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      const existingStatus = dirStatuses.get(dirPath)
      const newStatus = item.status as 'added' | 'modified' | 'deleted'

      // 优先级: added > modified > deleted
      if (!existingStatus || newStatus === 'added' || (newStatus === 'modified' && existingStatus === 'deleted')) {
        dirStatuses.set(dirPath, newStatus)
      }
    }
  }

  // 将目录状态添加到 statusMap
  for (const [dirPath, status] of dirStatuses) {
    if (!statusMap.has(dirPath)) {
      statusMap.set(dirPath, { path: dirPath, added: 0, removed: 0, status })
    }
  }
}
