// ============================================
// FileExplorer - 文件浏览器组件
// 包含文件树和文件预览两个区域，支持拖拽调整高度
// 性能优化：使用 CSS 变量 + requestAnimationFrame 处理 resize
// ============================================

import {
  lazy,
  Suspense,
  memo,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useFileExplorer, type FileTreeNode } from '../hooks'
import { useVerticalSplitResize } from '../hooks/useVerticalSplitResize'
import { layoutStore, type PreviewFile } from '../store/layoutStore'
import {
  ChevronRightIcon,
  ChevronDownIcon,
  RetryIcon,
  AlertCircleIcon,
  DownloadIcon,
  MaximizeIcon,
  SearchIcon,
  CloseIcon,
  UploadIcon,
} from './Icons'
import { CodePreview } from './CodePreview'
import { HtmlFilePreviewFrame } from './HtmlFilePreviewFrame'
import { PreviewTabsBar, type PreviewTabsBarItem } from './PreviewTabsBar'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useFullscreenLayer } from '../contexts'
import { getMaterialIconUrl } from '../utils/materialIcons'
import { detectLanguage } from '../utils/languageUtils'
import {
  getPreviewCategory,
  isBinaryContent,
  isTextualMedia,
  buildDataUrl,
  buildTextDataUrl,
  decodeBase64Text,
  formatMimeType,
  type PreviewCategory,
} from '../utils/mimeUtils'
import { saveData } from '../utils/downloadUtils'
import { readFileBytes } from '../api/fileDownload'
import { uploadProjectFile } from '../api/fileUpload'
import { serverStore } from '../store/serverStore'
import { invalidateDirectoryCache } from '../api/file'
import { WordFilePreview } from './WordFilePreview'
import { searchText, searchFiles } from '../api/file'
import type { FileContent, TextSearchMatch } from '../api/types'
import { startInternalDrag } from '../lib/internalDragCore'
import { toAbsolutePath } from '../features/mention'
import { getDesktopPlatform, isTauri, isTauriMobile } from '../utils/tauri'
import type { TargetLineRange } from './codeMirrorReadonlyExtensions'
import { isEditableFile, isOfficeFile } from '../utils/filePreview'
import { hasDirtyFileDraft } from '../store/fileDraftStore'
import { useWorkspaceRoot } from '../hooks/useWorkspaceRoot'
import { isWithinWorkspace, isProjectFilePath } from '../utils/workspaceBoundary'
import { addFileContextToChat } from '../utils/chatContext'
import { FileContextBoundary } from './FileContextBoundary'
import { TransferProgressBar } from './TransferProgressBar'
import type { TransferProgress } from '../utils/transferProgress'

const FileWorkspace = lazy(() => import('./FileWorkspace').then(module => ({ default: module.FileWorkspace })))
const OnlyOfficeEditor = lazy(() => import('./OnlyOfficeEditor').then(module => ({ default: module.OnlyOfficeEditor })))
const OfficeFilePreview = lazy(() =>
  import('./OfficeFilePreview').then(module => ({ default: module.OfficeFilePreview })),
)
const OfficeDocumentPreview = lazy(() =>
  import('./OfficeDocumentPreview').then(module => ({ default: module.OfficeDocumentPreview })),
)

function canRevealInSystemExplorer(): boolean {
  return isTauri() && !isTauriMobile()
}

function getRevealInSystemExplorerLabel(t: (key: string) => string): string {
  switch (getDesktopPlatform()) {
    case 'windows':
      return t('fileExplorer.revealInExplorer')
    case 'macos':
      return t('fileExplorer.revealInFinder')
    default:
      return t('fileExplorer.revealInFileManager')
  }
}

async function revealPathInSystemExplorer(absolutePath: string) {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
  await revealItemInDir(absolutePath)
}

// 常量
const MIN_TREE_HEIGHT = 100
const MIN_PREVIEW_HEIGHT = 150

const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/md', 'application/markdown'])
const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const textEncoder = new TextEncoder()

function findDirectory(nodes: FileTreeNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.path === path) return node.type === 'directory'
    if (node.children && findDirectory(node.children, path)) return true
  }
  return false
}

function hasTreePath(nodes: FileTreeNode[], path: string): boolean {
  return nodes.some(node => node.path === path || (node.children ? hasTreePath(node.children, path) : false))
}

function isMarkdownPreview(language: string, mimeType?: string): boolean {
  if (language === 'markdown' || language === 'mdx') return true
  if (!mimeType) return false
  return MARKDOWN_MIME_TYPES.has(mimeType.split(';', 1)[0].toLowerCase())
}

function isHtmlPreview(language: string, mimeType?: string): boolean {
  if (language === 'html') return true
  if (!mimeType) return false
  return HTML_MIME_TYPES.has(mimeType.split(';', 1)[0].toLowerCase())
}

function byteOffsetToCodeUnitIndex(text: string, byteOffset: number): number {
  let bytes = 0
  let index = 0

  while (index < text.length && bytes < byteOffset) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break

    const char = String.fromCodePoint(codePoint)
    const charBytes = textEncoder.encode(char).length
    if (bytes + charBytes > byteOffset) break

    bytes += charBytes
    index += char.length
  }

  return Math.min(index, text.length)
}

function getSearchMatchRanges(match: TextSearchMatch): TargetLineRange[] {
  return match.submatches
    .map(submatch => ({
      from: byteOffsetToCodeUnitIndex(match.lines.text, submatch.start),
      to: byteOffsetToCodeUnitIndex(match.lines.text, submatch.end),
    }))
    .filter(range => range.to > range.from)
}

interface FileExplorerProps {
  revealFile?: PreviewFile
  revealRevision?: number
  mode?: 'tree' | 'preview' | 'both'
  onOpenFile?: () => void
  panelTabId: string
  directory?: string
  /** 数据所属服务器（右侧面板跟随焦点 session 时传入；缺省用活动服务器） */
  serverId?: string
  previewFile: PreviewFile | null
  previewFiles: PreviewFile[]
  position?: 'bottom' | 'right'
  isPanelResizing?: boolean
  sessionId?: string | null
}

export const FileExplorer = memo(function FileExplorer({
  mode = 'both',
  onOpenFile,
  panelTabId,
  directory: requestedDirectory,
  serverId,
  previewFile,
  previewFiles,
  position = 'right',
  isPanelResizing = false,
  sessionId,
  revealFile,
  revealRevision,
}: FileExplorerProps) {
  const { t } = useTranslation(['components', 'common'])
  const workspaceRoot = useWorkspaceRoot(serverId)
  const directory =
    isWithinWorkspace(requestedDirectory, workspaceRoot) &&
    (!previewFile || isProjectFilePath(previewFile.path, requestedDirectory!))
      ? requestedDirectory
      : undefined
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const fileContextMenuRef = useRef<HTMLDivElement>(null)
  const searchRequestIdRef = useRef(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<TextSearchMatch[]>([])
  const [fileResults, setFileResults] = useState<string[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number
    y: number
    absolutePath: string
    path: string
    isDirectory: boolean
  } | null>(null)
  const canRevealFiles = canRevealInSystemExplorer()
  const revealInSystemExplorerLabel = useMemo(() => getRevealInSystemExplorerLabel(t), [t])
  const [searchError, setSearchError] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadFolderRef = useRef('')
  const [fileOperationError, setFileOperationError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [uploadTransfer, setUploadTransfer] = useState<TransferProgress | null>(null)
  const [downloadTransfer, setDownloadTransfer] = useState<TransferProgress | null>(null)
  const [downloadName, setDownloadName] = useState('')
  const uploadingRef = useRef(false)
  const [downloading, setDownloading] = useState(false)
  const [addingContext, setAddingContext] = useState(false)
  const addingContextRef = useRef(false)
  const {
    splitHeight: treeHeight,
    isResizing,
    resetSplitHeight,
    handleResizeStart,
    handleTouchResizeStart,
  } = useVerticalSplitResize({
    containerRef,
    primaryRef: treeRef,
    cssVariableName: '--tree-height',
    minPrimaryHeight: MIN_TREE_HEIGHT,
    minSecondaryHeight: MIN_PREVIEW_HEIGHT,
  })

  // 综合 resize 状态 - 外部面板 resize 或内部 resize
  const isAnyResizing = isPanelResizing || isResizing

  const {
    tree,
    isLoading,
    error,
    expandedPaths,
    toggleExpand,
    expandPath,
    previewContent,
    previewLoading,
    previewError,
    loadPreview,
    clearPreview,
    fileStatus,
    refresh,
    softRefresh,
  } = useFileExplorer({
    directory,
    projectRoot: workspaceRoot || null,
    autoLoad: mode !== 'preview',
    sessionId: sessionId || undefined,
    serverId,
    consumerId: `file-explorer-${panelTabId}`,
  })
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null)
  const startedRevealRef = useRef<string | null>(null)
  const handledRevealRef = useRef<string | null>(null)
  useEffect(() => {
    if (!revealFile || mode === 'preview' || !directory) return
    const key = `${serverId}:${directory}:${revealFile.path}:${revealRevision}`
    if (handledRevealRef.current === key) return
    if (startedRevealRef.current !== key) {
      startedRevealRef.current = key
      invalidateDirectoryCache(directory, serverId)
      void softRefresh()
      setSearchQuery('')
      setSelectedTreePath(revealFile.path)
    }
    const parts = revealFile.path.replace(/\\/g, '/').split('/')
    const ancestorPaths = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    const nextAncestor = ancestorPaths.find(path => !expandedPaths.has(path) && hasTreePath(tree, path))
    if (nextAncestor) {
      expandPath(nextAncestor)
      return
    }
    if (ancestorPaths.some(path => !expandedPaths.has(path))) return
    handledRevealRef.current = key
    setSearchQuery('')
    setSelectedTreePath(revealFile.path)
  }, [revealFile, revealRevision, directory, mode, expandPath, serverId, softRefresh, expandedPaths, tree])
  useEffect(() => {
    if (!selectedTreePath || mode === 'preview') return
    const target = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? []).find(
      element => element.dataset.filePath === selectedTreePath,
    )
    target?.scrollIntoView({ block: 'nearest' })
  }, [selectedTreePath, tree, expandedPaths, mode])

  // 当 previewFile 改变时加载预览
  useEffect(() => {
    if (previewFile && !isEditableFile(previewFile.path) && !isOfficeFile(previewFile.path)) {
      loadPreview(previewFile.path)
    } else {
      clearPreview()
    }
  }, [previewFile, loadPreview, clearPreview])

  const handleRefresh = useCallback(async () => {
    invalidateDirectoryCache(directory, serverId)
    await refresh()
    if (previewFile && !isEditableFile(previewFile.path) && !isOfficeFile(previewFile.path)) {
      await loadPreview(previewFile.path)
    }
  }, [loadPreview, previewFile, refresh, directory, serverId])

  const uploadFiles = useCallback(
    async (files: File[], folder = '') => {
      if (!directory || uploadingRef.current || files.length === 0) return
      uploadingRef.current = true
      const targetServer = serverId ?? serverStore.getActiveServerId()
      setUploading(true)
      setFileOperationError(null)
      const total = files.reduce((sum, file) => sum + file.size, 0)
      let completed = 0
      let last: TransferProgress = { loaded: 0, total, phase: 'preparing' }
      setUploadTransfer(last)
      try {
        for (const file of files) {
          setUploadProgress(file.name)
          await uploadProjectFile(file, folder, directory, targetServer, {
            onProgress: progress => {
              last = {
                loaded: completed + progress.loaded,
                total,
                phase: progress.phase === 'completed' ? 'processing' : progress.phase,
              }
              setUploadTransfer(last)
            },
          })
          completed += file.size
        }
        setUploadTransfer({ loaded: total, total, phase: 'completed' })
      } catch (error) {
        setUploadTransfer({ ...last, phase: 'failed' })
        setFileOperationError(error instanceof Error ? error.message : t('fileExplorer.uploadFailed'))
      } finally {
        invalidateDirectoryCache(directory, targetServer)
        await refresh()
        setUploading(false)
        uploadingRef.current = false
      }
    },
    [directory, serverId, refresh, t],
  )

  const selectUpload = useCallback((folder = '') => {
    uploadFolderRef.current = folder
    uploadInputRef.current?.click()
  }, [])

  const downloadPath = useCallback(
    async (path: string) => {
      if (!directory || !isProjectFilePath(path, directory)) return
      if (downloading) return
      setDownloading(true)
      setFileOperationError(null)
      setDownloadName(path.split(/[\\/]/).pop() || 'file')
      let last: TransferProgress = { loaded: 0, phase: 'preparing' }
      setDownloadTransfer(last)
      try {
        const bytes = await readFileBytes(path, directory, serverId ?? serverStore.getActiveServerId(), {
          onProgress: progress => {
            last = progress
            setDownloadTransfer(progress)
          },
        })
        saveData(bytes, path.split(/[\\/]/).pop() || 'file')
        setDownloadTransfer({ loaded: bytes.length, total: bytes.length, phase: 'completed' })
      } catch (error) {
        setDownloadTransfer({ ...last, phase: 'failed' })
        setFileOperationError(error instanceof Error ? error.message : t('fileExplorer.downloadFailed'))
      } finally {
        setDownloading(false)
      }
    },
    [directory, serverId, t, downloading],
  )

  // 处理文件点击
  const handleFileClick = useCallback(
    (node: FileTreeNode) => {
      if (!directory || !isProjectFilePath(node.path, directory)) return
      if (node.type === 'directory') {
        toggleExpand(node.path)
      } else {
        setSelectedTreePath(node.path)
        layoutStore.openFilePreview({ path: node.path, name: node.name, directory, serverId }, position)
        onOpenFile?.()
      }
    },
    [toggleExpand, position, directory, serverId, onOpenFile],
  )

  const resolveAbsolutePath = useCallback(
    (path: string, absolute?: string) => {
      if (absolute) return absolute
      if (!directory) return null
      return toAbsolutePath(path, directory)
    },
    [directory],
  )

  const handleFileContextMenu = useCallback(
    (event: React.MouseEvent, path: string, absolute?: string) => {
      const absolutePath = resolveAbsolutePath(path, absolute)
      if (!absolutePath || !directory || !isProjectFilePath(path, directory)) return
      event.preventDefault()
      event.stopPropagation()
      setFileContextMenu({
        x: Math.min(event.clientX, window.innerWidth - 200),
        y: Math.min(event.clientY, window.innerHeight - 160),
        absolutePath,
        path,
        isDirectory: findDirectory(tree, path),
      })
    },
    [resolveAbsolutePath, tree, directory],
  )

  const handleRevealInSystemExplorer = useCallback(() => {
    if (!fileContextMenu) return
    const absolutePath = fileContextMenu.absolutePath
    setFileContextMenu(null)
    void revealPathInSystemExplorer(absolutePath).catch(() => {})
  }, [fileContextMenu])

  useEffect(() => {
    if (!fileContextMenu) return

    const handleClickOutside = (event: MouseEvent) => {
      if (fileContextMenuRef.current && !fileContextMenuRef.current.contains(event.target as Node)) {
        setFileContextMenu(null)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileContextMenu(null)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [fileContextMenu])

  // 关闭预览
  const handleClosePreview = useCallback(() => {
    layoutStore.closeAllFilePreviews(panelTabId)
    resetSplitHeight()
  }, [panelTabId, resetSplitHeight])

  const handleActivatePreview = useCallback(
    (path: string) => {
      layoutStore.activateFilePreview(panelTabId, path)
    },
    [panelTabId],
  )

  const handleClosePreviewTab = useCallback(
    (path: string) => {
      layoutStore.closeFilePreview(panelTabId, path)
    },
    [panelTabId],
  )

  const handleReorderPreviewTabs = useCallback(
    (draggedPath: string, targetPath: string) => {
      layoutStore.reorderFilePreviews(panelTabId, draggedPath, targetPath)
    },
    [panelTabId],
  )

  // 是否显示预览
  const showPreview = Boolean(previewFile) || previewLoading || Boolean(previewError)
  const trimmedSearchQuery = searchQuery.trim()
  const isSearchingText = trimmedSearchQuery.length > 0

  useEffect(() => {
    if (!directory || !trimmedSearchQuery) {
      searchRequestIdRef.current += 1
      return
    }

    const requestId = ++searchRequestIdRef.current
    const timer = window.setTimeout(() => {
      setSearchLoading(true)
      setSearchResults([])
      setFileResults([])
      setSearchError(null)

      let fileDone = false
      let textDone = false
      const maybeFinish = () => {
        if (fileDone && textDone && requestId === searchRequestIdRef.current) {
          setSearchLoading(false)
        }
      }

      // 文件名搜索（失败静默，不阻断内容搜索）
      searchFiles(trimmedSearchQuery, { directory, limit: 50, serverId })
        .then(paths => {
          if (requestId !== searchRequestIdRef.current) return
          setFileResults(paths.filter(path => isProjectFilePath(path, directory)))
        })
        .catch(() => {
          // 文件名搜索失败不报错
        })
        .finally(() => {
          fileDone = true
          maybeFinish()
        })

      // 内容搜索
      searchText(trimmedSearchQuery, directory, serverId)
        .then(results => {
          if (requestId !== searchRequestIdRef.current) return
          setSearchResults(results.filter(match => isProjectFilePath(match.path.text, directory)))
        })
        .catch(err => {
          if (requestId !== searchRequestIdRef.current) return
          setSearchResults([])
          setSearchError(err instanceof Error ? err.message : t('fileExplorer.textSearchFailed'))
        })
        .finally(() => {
          textDone = true
          maybeFinish()
        })
    }, 250)

    return () => {
      window.clearTimeout(timer)
    }
  }, [directory, trimmedSearchQuery, serverId, t])

  const handleSearchResultClick = useCallback(
    (match: TextSearchMatch) => {
      const path = match.path.text
      const name = path.split(/[/\\]/).pop() || path
      layoutStore.openFilePreview(
        {
          path,
          name,
          directory,
          serverId,
          targetLine: match.line_number,
          targetKey: `${path}:${match.line_number}:${match.absolute_offset}:${Date.now()}`,
          targetRanges: getSearchMatchRanges(match),
        },
        position,
      )
      onOpenFile?.()
    },
    [position, directory, serverId, onOpenFile],
  )

  const handleFileResultClick = useCallback(
    (path: string) => {
      const name = path.split(/[/\\]/).pop() || path
      layoutStore.openFilePreview({ path, name, directory, serverId }, position)
      onOpenFile?.()
    },
    [position, directory, serverId, onOpenFile],
  )

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (!value.trim()) {
      setSearchResults([])
      setFileResults([])
      setSearchLoading(false)
      setSearchError(null)
    }
  }, [])

  // 没有选择目录
  if (!directory) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-base)] gap-2 p-4">
        <img
          src={getMaterialIconUrl('folder', 'directory', false)}
          alt=""
          width={32}
          height={32}
          className="opacity-30"
          onError={e => {
            e.currentTarget.style.visibility = 'hidden'
          }}
        />
        <span className="text-center">
          {t(requestedDirectory && workspaceRoot ? 'fileExplorer.outsideWorkspace' : 'fileExplorer.selectProject')}
        </span>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full min-h-0">
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        disabled={uploading}
        onChange={event => {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          void uploadFiles(files, uploadFolderRef.current)
        }}
      />
      <TransferProgressBar progress={uploadTransfer} label={t('fileExplorer.uploading', { name: uploadProgress })} />
      <TransferProgressBar progress={downloadTransfer} label={`${t('common:download')} ${downloadName}`} />
      {addingContext && (
        <div role="status" className="px-3 py-1 text-[length:var(--fs-xs)] text-text-400">
          {t('fileExplorer.addingContext')}
        </div>
      )}
      {fileOperationError && (
        <div role="alert" className="px-3 py-1 text-[length:var(--fs-xs)] text-danger-100 break-words">
          {fileOperationError}
        </div>
      )}
      {/* File Tree - 使用 CSS 变量控制高度 */}
      {mode !== 'preview' && (
        <div
          ref={treeRef}
          className="overflow-hidden flex flex-col shrink-0"
          style={
            {
              '--tree-height': treeHeight !== null ? `${treeHeight}px` : '40%',
              height: mode !== 'tree' && showPreview ? 'var(--tree-height)' : '100%',
              minHeight: mode !== 'tree' && showPreview ? MIN_TREE_HEIGHT : undefined,
              flex: mode === 'tree' ? 1 : undefined,
            } as React.CSSProperties
          }
        >
          {/* Tree Header */}
          <div className="px-3 pt-2 text-[length:var(--fs-xxs)] font-mono text-text-400 truncate" title={directory}>
            {directory}
          </div>
          <div className="relative flex h-10 items-center gap-2 px-3 shrink-0">
            <div className="relative group min-w-0 flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-400 w-3.5 h-3.5 group-focus-within:text-accent-main-100 transition-colors" />
              <input
                type="text"
                name="file-explorer-text-search"
                value={searchQuery}
                onChange={e => handleSearchQueryChange(e.target.value)}
                placeholder={t('fileExplorer.searchFiles')}
                aria-label={t('fileExplorer.searchFiles')}
                autoComplete="off"
                className="w-full bg-bg-200/40 hover:bg-bg-200/60 focus:bg-bg-000 border border-transparent focus:border-border-200 rounded-lg py-1 pl-[30px] pr-7 text-[length:var(--fs-xs)] text-text-100 placeholder:text-text-400/70 focus-visible:ring-1 focus-visible:ring-border-200 focus-visible:ring-inset transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => handleSearchQueryChange('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center text-text-400 hover:text-text-100 rounded transition-colors"
                  aria-label={t('fileExplorer.clearSearch')}
                  title={t('fileExplorer.clearSearch')}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => selectUpload()}
              disabled={uploading}
              aria-label={t('fileExplorer.upload')}
              title={t('fileExplorer.upload')}
              className="p-1 text-text-400 hover:text-text-100 disabled:opacity-50"
            >
              <UploadIcon size={14} />
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              aria-label={t('common:refresh')}
              className="inline-flex h-6 w-6 items-center justify-center text-text-400 hover:text-text-100 hover:bg-bg-200/50 rounded-md transition-colors disabled:opacity-50"
              title={t('common:refresh')}
            >
              <RetryIcon size={12} className={isLoading ? 'animate-spin' : ''} />
            </button>
            <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
          </div>

          {/* Tree Content */}
          <div
            className="flex-1 overflow-auto panel-scrollbar-y"
            onDragOver={event => {
              event.preventDefault()
            }}
            onDrop={event => {
              event.preventDefault()
              if (event.dataTransfer.files.length) void uploadFiles(Array.from(event.dataTransfer.files))
            }}
          >
            {isSearchingText ? (
              <TextSearchResults
                results={searchResults}
                fileResults={fileResults}
                isLoading={searchLoading}
                error={searchError}
                onSelect={handleSearchResultClick}
                onSelectFile={handleFileResultClick}
                onContextMenuFile={handleFileContextMenu}
                directory={directory}
              />
            ) : isLoading && tree.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
                {t('common:loading')}
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-20 text-danger-100 text-[length:var(--fs-sm)] gap-1 px-4">
                <AlertCircleIcon size={16} />
                <span className="text-center">{error}</span>
              </div>
            ) : tree.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
                {t('fileExplorer.noFilesFound')}
              </div>
            ) : (
              <div className="py-1">
                {tree.map(node => (
                  <FileTreeItem
                    key={node.path}
                    node={node}
                    depth={0}
                    expandedPaths={expandedPaths}
                    fileStatus={fileStatus}
                    onClick={handleFileClick}
                    onContextMenu={handleFileContextMenu}
                    selectedPath={selectedTreePath}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {fileContextMenu &&
        createPortal(
          <div
            ref={fileContextMenuRef}
            className="fixed z-[9999] bg-bg-100 border border-border-200 rounded-lg shadow-lg p-1 min-w-[160px]"
            style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          >
            {!fileContextMenu.isDirectory && (
              <>
                <button
                  type="button"
                  disabled={addingContext}
                  className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-bg-200/60 rounded-md disabled:opacity-50"
                  onClick={() => {
                    if (addingContextRef.current) return
                    addingContextRef.current = true
                    setAddingContext(true)
                    const source = {
                      path: fileContextMenu.path,
                      directory,
                      serverId: serverId ?? serverStore.getActiveServerId(),
                    }
                    setFileContextMenu(null)
                    setFileOperationError(null)
                    void addFileContextToChat(source)
                      .then(added => {
                        if (!added) setFileOperationError(t('fileExplorer.chatContextFailed'))
                      })
                      .catch(() => setFileOperationError(t('fileExplorer.chatContextFailed')))
                      .finally(() => {
                        addingContextRef.current = false
                        setAddingContext(false)
                      })
                  }}
                >
                  {t('fileExplorer.addFileToChat')}
                </button>
                <button
                  type="button"
                  className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-bg-200/60 rounded-md"
                  onClick={() => {
                    layoutStore.openFilePreview(
                      {
                        path: fileContextMenu.path,
                        name: fileContextMenu.path.split(/[\\/]/).pop() || 'file',
                        directory,
                        serverId,
                      },
                      'right',
                    )
                    setFileContextMenu(null)
                    onOpenFile?.()
                  }}
                >
                  {t('fileExplorer.open')}
                </button>
                <button
                  type="button"
                  className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-bg-200/60 rounded-md"
                  onClick={() => {
                    void downloadPath(fileContextMenu.path)
                    setFileContextMenu(null)
                  }}
                >
                  {t('common:download')}
                </button>
              </>
            )}
            {fileContextMenu.isDirectory && (
              <>
                <button
                  type="button"
                  className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-bg-200/60 rounded-md"
                  onClick={() => {
                    toggleExpand(fileContextMenu.path)
                    setFileContextMenu(null)
                  }}
                >
                  {t('fileExplorer.expandFolder')}
                </button>
                <button
                  type="button"
                  className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-bg-200/60 rounded-md"
                  onClick={() => {
                    selectUpload(fileContextMenu.path)
                    setFileContextMenu(null)
                  }}
                >
                  {t('fileExplorer.uploadHere')}
                </button>
              </>
            )}
            {canRevealFiles && (
              <button
                type="button"
                onClick={handleRevealInSystemExplorer}
                className="w-full px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200/60 hover:text-text-100 rounded-md transition-colors"
              >
                {revealInSystemExplorerLabel}
              </button>
            )}
          </div>,
          document.body,
        )}

      {/* Resize Handle - 与标签栏同色 */}
      {mode === 'both' && showPreview && (
        <div
          className={`
            h-1.5 cursor-row-resize shrink-0 relative
            hover:bg-accent-main-100/50 active:bg-accent-main-100 transition-colors
            ${isResizing ? 'bg-accent-main-100' : 'bg-bg-200/60'}
          `}
          onMouseDown={handleResizeStart}
          onTouchStart={handleTouchResizeStart}
        />
      )}

      {/* Preview Area */}
      {mode !== 'tree' && (showPreview || mode === 'preview') && (
        <div className="flex-1 flex flex-col min-h-0" style={{ minHeight: MIN_PREVIEW_HEIGHT }}>
          <FilePreview
            key={`${serverId ?? ''}:${directory ?? ''}:${previewFile?.path ?? ''}`}
            previewFiles={previewFiles}
            path={previewFile?.path ?? null}
            targetLine={previewFile?.targetLine}
            targetKey={previewFile?.targetKey}
            targetRanges={previewFile?.targetRanges}
            content={previewContent}
            isLoading={previewLoading}
            error={previewError}
            onClose={handleClosePreview}
            onActivatePreview={handleActivatePreview}
            onClosePreview={handleClosePreviewTab}
            onReorderPreview={handleReorderPreviewTabs}
            isResizing={isAnyResizing}
            directory={directory}
            serverId={serverId}
            onLoadPreview={() => {
              if (previewFile) void loadPreview(previewFile.path, true)
            }}
          />
        </div>
      )}
    </div>
  )
})

interface TextSearchResultsProps {
  results: TextSearchMatch[]
  fileResults: string[]
  isLoading: boolean
  error: string | null
  onSelect: (match: TextSearchMatch) => void
  onSelectFile: (path: string) => void
  onContextMenuFile?: (event: React.MouseEvent, path: string, absolute?: string) => void
  directory?: string
}

const TextSearchResults = memo(function TextSearchResults({
  results,
  fileResults,
  isLoading,
  error,
  onSelect,
  onSelectFile,
  onContextMenuFile,
  directory,
}: TextSearchResultsProps) {
  const { t } = useTranslation(['components', 'common'])

  const hasFiles = fileResults.length > 0
  const hasText = results.length > 0

  // 拖拽到输入框实现 @mention，与文件树项行为一致
  const handlePointerDragStart = useCallback(
    (e: PointerEvent<HTMLButtonElement>, path: string) => {
      if (!directory) return
      const name = path.split(/[/\\]/).pop() || path
      startInternalDrag(e, {
        kind: 'file-mention',
        file: {
          type: 'file',
          path,
          absolute: toAbsolutePath(path, directory),
          name,
        },
      })
    },
    [directory],
  )

  if (isLoading && !hasFiles && !hasText) {
    return (
      <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
        {t('common:loading')}
      </div>
    )
  }

  if (error && !hasFiles && !hasText) {
    return (
      <div className="flex flex-col items-center justify-center h-20 text-danger-100 text-[length:var(--fs-sm)] gap-1 px-4">
        <AlertCircleIcon size={16} />
        <span className="text-center">{error}</span>
      </div>
    )
  }

  if (!hasFiles && !hasText) {
    return (
      <div className="flex items-center justify-center h-20 text-text-400 text-[length:var(--fs-sm)]">
        {t('fileExplorer.noTextMatches')}
      </div>
    )
  }

  return (
    <div className="py-1">
      {hasFiles && (
        <>
          <div className="px-2 py-1 text-[length:var(--fs-xxs)] font-medium text-text-500 uppercase tracking-wide">
            {t('fileExplorer.fileMatches')}
          </div>
          {fileResults.map(path => {
            const name = path.split(/[/\\]/).pop() || path
            return (
              <button
                key={`file:${path}`}
                type="button"
                onPointerDown={e => handlePointerDragStart(e, path)}
                onClick={() => onSelectFile(path)}
                onContextMenu={event => onContextMenuFile?.(event, path)}
                className="w-full px-2 py-1.5 text-left hover:bg-bg-200/50 transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <img
                    src={getMaterialIconUrl(path, 'file', false)}
                    alt=""
                    width={16}
                    height={16}
                    draggable={false}
                    className="shrink-0"
                    loading="lazy"
                    decoding="async"
                    onError={e => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                  <span className="truncate text-[length:var(--fs-sm)] text-text-200">{name}</span>
                </div>
                <div className="mt-0.5 truncate pl-[22px] text-[length:var(--fs-xxs)] text-text-500">{path}</div>
              </button>
            )
          })}
        </>
      )}
      {hasText && (
        <>
          {hasFiles && (
            <div className="mt-1 px-2 py-1 text-[length:var(--fs-xxs)] font-medium text-text-500 uppercase tracking-wide">
              {t('fileExplorer.contentMatches')}
            </div>
          )}
          {results.map((match, index) => {
            const path = match.path.text
            const name = path.split(/[/\\]/).pop() || path
            const line = match.lines.text.trim()

            return (
              <button
                key={`${path}:${match.line_number}:${match.absolute_offset}:${index}`}
                type="button"
                onPointerDown={e => handlePointerDragStart(e, path)}
                onClick={() => onSelect(match)}
                onContextMenu={event => onContextMenuFile?.(event, path)}
                className="w-full px-2 py-1.5 text-left hover:bg-bg-200/50 transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <img
                    src={getMaterialIconUrl(path, 'file', false)}
                    alt=""
                    width={16}
                    height={16}
                    draggable={false}
                    className="shrink-0"
                    loading="lazy"
                    decoding="async"
                    onError={e => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                  <span className="truncate text-[length:var(--fs-sm)] text-text-200">{name}</span>
                  <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-500">:{match.line_number}</span>
                </div>
                <div className="mt-0.5 truncate pl-[22px] font-mono text-[length:var(--fs-xxs)] text-text-400">
                  {line}
                </div>
                <div className="mt-0.5 truncate pl-[22px] text-[length:var(--fs-xxs)] text-text-500">{path}</div>
              </button>
            )
          })}
        </>
      )}
      {isLoading && (
        <div className="px-2 py-1.5 text-center text-[length:var(--fs-xs)] text-text-500">{t('common:loading')}</div>
      )}
    </div>
  )
})

// ============================================
// File Tree Item
// ============================================

interface FileTreeItemProps {
  selectedPath?: string | null
  node: FileTreeNode
  depth: number
  expandedPaths: Set<string>
  fileStatus: Map<string, { status: string }>
  onClick: (node: FileTreeNode) => void
  onContextMenu?: (event: React.MouseEvent, path: string, absolute?: string) => void
}

const FileTreeItem = memo(function FileTreeItem({
  node,
  depth,
  expandedPaths,
  fileStatus,
  onClick,
  onContextMenu,
  selectedPath,
}: FileTreeItemProps) {
  const isExpanded = expandedPaths.has(node.path)
  const isDirectory = node.type === 'directory'
  // node.path 可能用反斜杠（Windows），statusMap key 统一用正斜杠
  const status = fileStatus.get(node.path) || fileStatus.get(node.path.replace(/\\/g, '/'))

  // 状态颜色
  const statusColor = useMemo(() => {
    if (!status) return null
    switch (status.status) {
      case 'added':
        return 'text-success-100'
      case 'modified':
        return 'text-warning-100'
      case 'deleted':
        return 'text-danger-100'
      default:
        return null
    }
  }, [status])

  // 拖拽到输入框实现 @mention。使用 pointer 拖拽，避免 Tauri 原生文件 drop 接管 HTML5 DnD。
  const handlePointerDragStart = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      const fileData = {
        type: (isDirectory ? 'folder' : 'file') as 'file' | 'folder',
        path: node.path, // 相对路径
        absolute: node.absolute, // 绝对路径
        name: node.name,
      }
      startInternalDrag(e, { kind: 'file-mention', file: fileData })
    },
    [node.path, node.absolute, node.name, isDirectory],
  )

  return (
    <div>
      <button
        type="button"
        data-file-path={node.path}
        aria-current={!isDirectory && selectedPath === node.path ? 'true' : undefined}
        onPointerDown={handlePointerDragStart}
        onClick={() => onClick(node)}
        onContextMenu={event => onContextMenu?.(event, node.path, node.absolute)}
        className={`
          w-full flex items-center gap-1 px-2 py-0.5 text-left cursor-default
          select-none hover:bg-bg-200/50 transition-colors text-[length:var(--fs-sm)]
          text-text-300
          ${node.ignored ? 'opacity-50' : ''} ${selectedPath === node.path ? 'bg-accent-main-100/10 ring-1 ring-inset ring-accent-main-100/30' : ''}
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* Expand/Collapse Icon */}
        {isDirectory ? (
          <span className="w-4 h-4 flex items-center justify-center text-text-400 shrink-0">
            {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* File/Folder Icon - Material Icon Theme */}
        <img
          src={getMaterialIconUrl(node.path, isDirectory ? 'directory' : 'file', isExpanded)}
          alt=""
          width={16}
          height={16}
          draggable={false}
          className="shrink-0"
          loading="lazy"
          decoding="async"
          onError={e => {
            e.currentTarget.style.visibility = 'hidden'
          }}
        />

        {/* Name */}
        <span className={`truncate flex-1 ${statusColor || ''}`}>{node.name}</span>

        {/* Loading Indicator */}
        {node.isLoading && (
          <span className="w-3 h-3 border border-text-400 border-t-transparent rounded-full animate-spin shrink-0" />
        )}
      </button>

      {/* Children */}
      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              fileStatus={fileStatus}
              onClick={onClick}
              selectedPath={selectedPath}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
})

// ============================================
// File Preview
// ============================================

interface FilePreviewProps {
  onLoadPreview: () => void
  serverId?: string
  previewFiles: PreviewFile[]
  path: string | null
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
  content: FileContent | null
  isLoading: boolean
  error: string | null
  onClose: () => void
  onActivatePreview: (path: string) => void
  onClosePreview: (path: string) => void
  onReorderPreview: (draggedPath: string, targetPath: string) => void
  isResizing?: boolean
  directory?: string
}

function FilePreview({
  previewFiles,
  path,
  targetLine,
  targetKey,
  targetRanges,
  content,
  isLoading,
  error,
  onClose,
  onActivatePreview,
  onClosePreview,
  onReorderPreview,
  isResizing = false,
  directory,
  serverId,
  onLoadPreview,
}: FilePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const scrollRef = useRef<HTMLDivElement>(null)

  // 获取文件名
  const fileName = path?.split(/[/\\]/).pop() || 'Untitled'
  const language = path ? detectLanguage(path) : 'text'
  const [downloadError, setDownloadError] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const downloadingRef = useRef(false)
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const onDirtyChange = useCallback(() => setDraftRevision(value => value + 1), [])
  const editable = !!path && !!directory && isEditableFile(path)
  const office = !!path && !!directory && isOfficeFile(path)
  const [officeEditing, setOfficeEditing] = useState(false)

  // 下载当前文件
  const handleDownload = useCallback(() => {
    if (!path || downloadingRef.current) return
    downloadingRef.current = true
    setDownloading(true)
    setDownloadError(false)
    let last: TransferProgress = { loaded: 0, phase: 'preparing' }
    setTransferProgress(last)
    void readFileBytes(path, directory, serverId ?? serverStore.getActiveServerId(), {
      onProgress: progress => {
        last = progress
        setTransferProgress(progress)
      },
    })
      .then(bytes => {
        saveData(bytes, fileName, content?.mimeType)
        setTransferProgress({ loaded: bytes.length, total: bytes.length, phase: 'completed' })
      })
      .catch(() => {
        setDownloadError(true)
        setTransferProgress({ ...last, phase: 'failed' })
      })
      .finally(() => {
        downloadingRef.current = false
        setDownloading(false)
      })
  }, [content?.mimeType, fileName, path, directory, serverId])

  const previewTabItems = useMemo<PreviewTabsBarItem[]>(() => {
    void draftRevision
    return previewFiles.map(file => ({
      id: file.path,
      title: file.path,
      closeTitle: `${t('common:close')} ${file.name}`,
      iconPath: file.path,
      label: (
        <span className="block whitespace-nowrap text-[length:var(--fs-xs)] font-mono">
          {file.name}
          {hasDirtyFileDraft(file.path, directory, serverId) ? ' ●' : ''}
        </span>
      ),
    }))
  }, [previewFiles, t, directory, serverId, draftRevision])

  // 处理内容类型分发
  const displayContent = useMemo(() => {
    if (!content) return null

    if (/\.docx$/i.test(path || '')) return { type: 'word' as const, base64: content.content }
    if (/\.(?:xlsx|pptx)$/i.test(path || '')) return { type: 'officePreview' as const, base64: content.content }
    if (/\.(?:doc|xls|ppt)$/i.test(path || '')) return { type: 'legacyWord' as const }
    if (isOfficeFile(path || ''))
      return { type: 'binary' as const, mimeType: content.mimeType || 'application/octet-stream' }

    const category = getPreviewCategory(content.mimeType)

    if (isHtmlPreview(language, content.mimeType)) {
      return {
        type: 'html' as const,
        text: isBinaryContent(content.encoding) ? decodeBase64Text(content.content) : content.content,
      }
    }

    if (isMarkdownPreview(language, content.mimeType)) {
      const text = isBinaryContent(content.encoding) ? decodeBase64Text(content.content) : content.content
      return {
        type: 'markdown' as const,
        text,
      }
    }

    // 文本型可渲染媒体（如 SVG）— 同时提供渲染和源码
    // 优先级最高：即使以 base64 传输，也支持解码为文本查看
    if (isTextualMedia(content.mimeType)) {
      const isBase64 = isBinaryContent(content.encoding)
      const text = isBase64 ? decodeBase64Text(content.content) : content.content
      const dataUrl = isBase64
        ? buildDataUrl(content.mimeType!, content.content)
        : buildTextDataUrl(content.mimeType!, content.content)
      return {
        type: 'textMedia' as const,
        text,
        dataUrl,
        category: category!,
        mimeType: content.mimeType!,
      }
    }

    // 二进制 + 可预览的媒体类型
    if (isBinaryContent(content.encoding) && category) {
      return {
        type: 'media' as const,
        category,
        dataUrl: buildDataUrl(content.mimeType!, content.content),
        mimeType: content.mimeType!,
      }
    }

    // 二进制 + 不可预览
    if (content.type === 'binary' || isBinaryContent(content.encoding)) {
      return {
        type: 'binary' as const,
        mimeType: content.mimeType || 'application/octet-stream',
      }
    }

    // diff 渲染交给 Changes 面板，Files 预览只显示文件内容
    // if (content.patch && content.patch.hunks.length > 0) {
    //   return {
    //     type: 'diff' as const,
    //     hunks: content.patch.hunks,
    //   }
    // }

    // 显示文件内容
    return {
      type: 'text' as const,
      text: content.content,
    }
  }, [content, language, path])

  // 全屏内容
  const fullscreenContent = useMemo((): ReactNode => {
    if (!displayContent) return null
    switch (displayContent.type) {
      case 'officePreview':
        return (
          <Suspense fallback={null}>
            <OfficeFilePreview key={path} path={path!} base64={displayContent.base64} />
          </Suspense>
        )
      case 'word':
        return <WordFilePreview key={path} base64={displayContent.base64} />
      case 'legacyWord':
        return <div className="p-4 text-text-400">{t('fileExplorer.legacyWord')}</div>
      case 'media':
        return (
          <MediaPreview
            category={displayContent.category}
            dataUrl={displayContent.dataUrl}
            mimeType={displayContent.mimeType}
            fileName={fileName}
          />
        )
      case 'binary':
        return <BinaryPlaceholder mimeType={displayContent.mimeType} fileName={fileName} onDownload={handleDownload} />
      case 'textMedia':
        return (
          <TextMediaPreview
            key={targetKey ?? path ?? fileName}
            dataUrl={displayContent.dataUrl}
            text={displayContent.text}
            language={language || 'xml'}
            fileName={fileName}
            isResizing={false}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      case 'markdown':
        return (
          <MarkdownFilePreview
            key={targetKey ?? path ?? fileName}
            text={displayContent.text}
            isResizing={false}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      case 'html':
        return (
          <HtmlFilePreview
            key={targetKey ?? path ?? fileName}
            text={displayContent.text}
            fileName={fileName}
            filePath={path ?? fileName}
            directory={directory}
            serverId={serverId}
            isResizing={false}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      case 'text':
        return (
          <CodePreview
            code={displayContent.text}
            language={language || 'text'}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        )
      default:
        return null
    }
  }, [
    directory,
    displayContent,
    fileName,
    handleDownload,
    language,
    path,
    targetKey,
    targetLine,
    targetRanges,
    t,
    serverId,
  ])

  const fullscreenHeaderRight = useMemo(
    () =>
      content ? (
        <div className="flex items-center min-w-0">
          {transferProgress && (
            <div className="w-56 max-w-[45vw]">
              <TransferProgressBar progress={transferProgress} label={`${t('common:download')} ${fileName}`} />
            </div>
          )}
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="p-1.5 text-text-400 hover:text-text-100 hover:bg-bg-200/60 rounded-lg transition-colors"
            title={`${t('common:save')} ${fileName}`}
          >
            <DownloadIcon size={14} />
          </button>
        </div>
      ) : null,
    [content, fileName, handleDownload, t, transferProgress, downloading],
  )

  const fullscreenLayer = useMemo(
    () =>
      fullscreenContent
        ? {
            id: `file-preview:${path || fileName}`,
            title: fileName,
            headerRight: fullscreenHeaderRight,
            content:
              directory && path ? (
                <FileContextBoundary
                  source={{ path, directory, serverId: serverId ?? serverStore.getActiveServerId() }}
                >
                  {fullscreenContent}
                </FileContextBoundary>
              ) : (
                fullscreenContent
              ),
            deferContent: displayContent?.type === 'html',
          }
        : null,
    [displayContent?.type, fileName, fullscreenContent, fullscreenHeaderRight, path, directory, serverId],
  )
  const { isOpen: isFullscreenOpen, open: openFullscreen } = useFullscreenLayer(fullscreenLayer)

  return (
    <div className="flex flex-col h-full relative">
      <PreviewTabsBar
        items={previewTabItems}
        activeId={path}
        closeAllTitle={t('common:closeAllTabs')}
        onActivate={onActivatePreview}
        onClose={onClosePreview}
        onCloseAll={onClose}
        onReorder={onReorderPreview}
        tabWidthClassName="w-auto max-w-none min-w-max"
        rightActions={
          path ? (
            <>
              {!editable && !office && (
                <button
                  onClick={openFullscreen}
                  className="p-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors"
                  title={t('contentBlock.fullscreen')}
                >
                  <MaximizeIcon size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                aria-label={`${t('common:download')} ${fileName}`}
                className="flex items-center gap-1 px-2 py-1 text-text-400 hover:text-text-100 hover:bg-bg-300/50 rounded transition-colors disabled:opacity-50"
                title={`${t('common:download')} ${fileName}`}
              >
                <DownloadIcon size={12} />
                <span className="text-[length:var(--fs-xs)]">{t('common:download')}</span>
              </button>
              {office && !officeEditing && (
                <button
                  type="button"
                  onClick={() => setOfficeEditing(true)}
                  className="px-2 py-1 rounded hover:bg-bg-300/50 text-[length:var(--fs-xs)]"
                >
                  {t('fileExplorer.edit')}
                </button>
              )}
              {!editable && !officeEditing && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftRevision(value => value + 1)
                    if (!office) onLoadPreview()
                  }}
                  className="px-2 py-1 rounded hover:bg-bg-300/50 text-[length:var(--fs-xs)]"
                >
                  {t('fileExplorer.reloadFile')}
                </button>
              )}
            </>
          ) : null
        }
      />
      {path && (
        <div
          className="px-3 py-1 text-[length:var(--fs-xxs)] text-text-400 font-mono truncate border-b border-border-200/40"
          title={`${directory ?? ''}/${path}`}
        >
          {directory} / {path}
        </div>
      )}
      {downloadError && (
        <div role="alert" className="px-3 py-1 text-danger-100">
          {t('fileExplorer.downloadFailed')}
        </div>
      )}
      <TransferProgressBar progress={transferProgress} label={`${t('common:download')} ${fileName}`} />

      {/* Preview Content */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto panel-scrollbar">
        <FileContextBoundary
          source={{
            path: path || fileName,
            directory: directory || '',
            serverId: serverId ?? serverStore.getActiveServerId(),
          }}
        >
          {office && officeEditing ? (
            <Suspense fallback={<div className="p-3 text-text-400">{t('common:loading')}</div>}>
              <OnlyOfficeEditor
                key={`${serverId}:${directory}:${path}`}
                path={path!}
                directory={directory!}
                serverId={serverId ?? serverStore.getActiveServerId()}
                mode="edit"
                onPreview={() => {
                  setOfficeEditing(false)
                  setDraftRevision(value => value + 1)
                }}
              />
            </Suspense>
          ) : editable ? (
            <Suspense fallback={<div className="p-3 text-text-400">{t('common:loading')}</div>}>
              <FileWorkspace
                key={`${serverId}:${directory}:${path}`}
                path={path!}
                directory={directory!}
                serverId={serverId ?? serverStore.getActiveServerId()}
                onDirtyChange={onDirtyChange}
              />
            </Suspense>
          ) : office ? (
            <Suspense fallback={<div className="p-3 text-text-400">{t('common:loading')}</div>}>
              <OfficeDocumentPreview
                key={`${path}:${draftRevision}`}
                path={path!}
                directory={directory!}
                serverId={serverId ?? serverStore.getActiveServerId()}
              />
            </Suspense>
          ) : isLoading ? (
            <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
              {t('common:loading')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-danger-100 text-[length:var(--fs-sm)] gap-1 px-4">
              <AlertCircleIcon size={16} />
              <span className="text-center">{error}</span>
            </div>
          ) : office && !/\.docx$/i.test(path || '') ? (
            <Suspense fallback={<div className="p-3 text-text-400">{t('common:loading')}</div>}>
              <OfficeDocumentPreview
                key={path}
                path={path!}
                directory={directory!}
                serverId={serverId ?? serverStore.getActiveServerId()}
                base64={content?.content}
              />
            </Suspense>
          ) : displayContent?.type === 'officePreview' ? (
            <Suspense fallback={<div className="p-3 text-text-400">{t('common:loading')}</div>}>
              <OfficeFilePreview key={path} path={path!} base64={displayContent.base64} />
            </Suspense>
          ) : displayContent?.type === 'word' ? (
            <WordFilePreview key={path} base64={displayContent.base64} />
          ) : displayContent?.type === 'legacyWord' ? (
            <div className="p-4 text-text-400">{t('fileExplorer.legacyWord')}</div>
          ) : displayContent?.type === 'media' ? (
            isFullscreenOpen ? null : (
              <MediaPreview
                category={displayContent.category}
                dataUrl={displayContent.dataUrl}
                mimeType={displayContent.mimeType}
                fileName={fileName}
              />
            )
          ) : displayContent?.type === 'binary' ? (
            <BinaryPlaceholder mimeType={displayContent.mimeType} fileName={fileName} onDownload={handleDownload} />
          ) : displayContent?.type === 'textMedia' ? (
            <TextMediaPreview
              key={targetKey ?? path ?? fileName}
              dataUrl={displayContent.dataUrl}
              text={displayContent.text}
              language={language || 'xml'}
              fileName={fileName}
              isResizing={isResizing}
              targetLine={targetLine}
              targetKey={targetKey}
              targetRanges={targetRanges}
            />
          ) : displayContent?.type === 'markdown' ? (
            <MarkdownFilePreview
              key={targetKey ?? path ?? fileName}
              text={displayContent.text}
              isResizing={isResizing}
              targetLine={targetLine}
              targetKey={targetKey}
              targetRanges={targetRanges}
            />
          ) : displayContent?.type === 'html' ? (
            isFullscreenOpen ? null : (
              <HtmlFilePreview
                key={targetKey ?? path ?? fileName}
                text={displayContent.text}
                fileName={fileName}
                filePath={path ?? fileName}
                directory={directory}
                serverId={serverId}
                isResizing={isResizing}
                targetLine={targetLine}
                targetKey={targetKey}
                targetRanges={targetRanges}
              />
            )
          ) : // diff 渲染已移至 Changes 面板
          // ) : displayContent?.type === 'diff' ? (
          //   <DiffPreview hunks={displayContent.hunks} isResizing={isResizing} />
          displayContent?.type === 'text' ? (
            <CodePreview
              code={displayContent.text}
              language={language || 'text'}
              isResizing={isResizing}
              targetLine={targetLine}
              targetKey={targetKey}
              targetRanges={targetRanges}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">
              {t('fileExplorer.openHint')}
            </div>
          )}
        </FileContextBoundary>
      </div>
    </div>
  )
}

// ============================================
// Media Preview - 路由到具体渲染器
// ============================================

interface MediaPreviewProps {
  category: PreviewCategory
  dataUrl: string
  mimeType: string
  fileName: string
}

function MediaPreview({ category, dataUrl, mimeType, fileName }: MediaPreviewProps) {
  const [source, setSource] = useState('')
  useEffect(() => {
    let disposed = false
    let objectUrl = ''
    void fetch(dataUrl)
      .then(response => response.blob())
      .then(blob => {
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setSource(objectUrl)
      })
      .catch(() => {})
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [dataUrl])
  if (!source) return null
  switch (category) {
    case 'image':
      return <ImagePreview key={source} dataUrl={source} fileName={fileName} />
    case 'audio':
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
          <div className="text-text-400 text-[length:var(--fs-sm)]">{formatMimeType(mimeType)}</div>
          <audio controls src={source} className="w-full max-w-xs" />
        </div>
      )
    case 'video':
      return (
        <div className="flex items-center justify-center h-full p-4">
          <video controls src={source} className="max-w-full max-h-full rounded" />
        </div>
      )
    case 'pdf':
      return <iframe src={source} title={fileName} className="w-full h-full min-h-80 border-0" />
  }
}

// ============================================
// Image Preview - 缩放 + 拖拽平移
// 直接滚轮缩放（以鼠标为锚点），左键拖拽平移
// ============================================

const MIN_ZOOM = 0.05
const MAX_ZOOM = 20
const ZOOM_FACTOR = 1.15 // 每次滚轮的缩放倍率

interface ImagePreviewProps {
  dataUrl: string
  fileName: string
}

function ImagePreview({ dataUrl, fileName }: ImagePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const containerRef = useRef<HTMLDivElement>(null)
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 })
  const scaleRef = useRef(1) // 同步访问，避免 stale closure
  const [scale, setScale] = useState(1)
  const [fitScale, setFitScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [initialized, setInitialized] = useState(false)
  const [imageError, setImageError] = useState(false)
  const dragRef = useRef({ active: false, startX: 0, startY: 0 })

  // fit-to-container scale
  const computeFitScale = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !naturalSize.w || !naturalSize.h) return 1
      const rect = el.getBoundingClientRect()
      return Math.max(MIN_ZOOM, Math.min(rect.width / naturalSize.w, rect.height / naturalSize.h, 1))
    },
    [naturalSize],
  )

  // 图片加载后初始化
  useEffect(() => {
    const container = containerRef.current
    if (!container || !naturalSize.w || !naturalSize.h) return

    const updateFitScale = () => {
      const nextFitScale = computeFitScale(container)
      setFitScale(previous => (Math.abs(previous - nextFitScale) < 0.001 ? previous : nextFitScale))

      if (!initialized) {
        scaleRef.current = nextFitScale
        setScale(nextFitScale)
        setTranslate({ x: 0, y: 0 })
        setInitialized(true)
      }
    }

    updateFitScale()

    const resizeObserver = new ResizeObserver(updateFitScale)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [naturalSize, initialized, computeFitScale])

  // 滚轮缩放 — 以鼠标位置为锚点
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // 鼠标相对容器中心
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const factor = e.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR
      const oldScale = scaleRef.current
      const newScale = Math.min(Math.max(oldScale * factor, MIN_ZOOM), MAX_ZOOM)
      const ratio = newScale / oldScale
      scaleRef.current = newScale
      setScale(newScale)
      setTranslate(t => ({
        x: cx - ratio * (cx - t.x),
        y: cy - ratio * (cy - t.y),
      }))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // 拖拽平移
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      dragRef.current.startX = e.clientX
      dragRef.current.startY = e.clientY
      setTranslate(t => ({ x: t.x + dx, y: t.y + dy }))
    }
    const onUp = () => {
      if (dragRef.current.active) {
        dragRef.current.active = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [])

  const zoomIn = useCallback(() => {
    const s = Math.min(scaleRef.current * 1.25, MAX_ZOOM)
    scaleRef.current = s
    setScale(s)
  }, [])

  const zoomOut = useCallback(() => {
    const s = Math.max(scaleRef.current / 1.25, MIN_ZOOM)
    scaleRef.current = s
    setScale(s)
  }, [])

  const zoomFit = useCallback(() => {
    scaleRef.current = fitScale
    setScale(fitScale)
    setTranslate({ x: 0, y: 0 })
  }, [fitScale])

  const zoomActual = useCallback(() => {
    scaleRef.current = 1
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [])

  const isFit = Math.abs(scale - fitScale) < 0.001 && translate.x === 0 && translate.y === 0
  const isActual = Math.abs(scale - 1) < 0.001 && translate.x === 0 && translate.y === 0

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" style={{ contain: 'size layout' }}>
      {imageError && (
        <div role="alert" className="p-3 text-danger-100">
          {t('fileExplorer.imageFailed')}
        </div>
      )}
      {/* Zoom toolbar */}
      <div className="shrink-0 flex items-center justify-center gap-1.5 px-2 py-1 border-b border-border-100/30 bg-bg-100/50 text-[length:var(--fs-xxs)]">
        <button
          onClick={zoomOut}
          className="px-1.5 py-0.5 rounded hover:bg-bg-200 text-text-300 hover:text-text-100 transition-colors"
        >
          −
        </button>
        <span className="w-10 text-center text-text-400 tabular-nums">{Math.round(scale * 100)}%</span>
        <button
          onClick={zoomIn}
          className="px-1.5 py-0.5 rounded hover:bg-bg-200 text-text-300 hover:text-text-100 transition-colors"
        >
          +
        </button>
        <span className="w-px h-3 bg-border-200 mx-1" />
        <button
          onClick={zoomFit}
          className={`px-1.5 py-0.5 rounded transition-colors ${isFit ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('fileExplorer.fit')}
        </button>
        <button
          onClick={zoomActual}
          className={`px-1.5 py-0.5 rounded transition-colors ${isActual ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('fileExplorer.oneToOne')}
        </button>
      </div>
      {/* Image area */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden relative cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
      >
        <img
          src={dataUrl}
          alt={fileName}
          draggable={false}
          className="absolute left-1/2 top-1/2 select-none"
          style={{
            transform: `translate(-50%, -50%) translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: 'center center',
          }}
          onLoad={e => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget
            setNaturalSize(previous => (previous.w === w && previous.h === h ? previous : { w, h }))
          }}
          onError={() => setImageError(true)}
        />
      </div>
    </div>
  )
}

// ============================================
// Text Media Preview - 文本型可渲染媒体（如 SVG）
// 支持 Preview / Code 两种视图切换
// ============================================

interface TextMediaPreviewProps {
  dataUrl: string
  text: string
  language: string
  fileName: string
  isResizing?: boolean
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

function TextMediaPreview({
  dataUrl,
  text,
  language,
  fileName,
  isResizing = false,
  targetLine,
  targetKey,
  targetRanges,
}: TextMediaPreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const [mode, setMode] = useState<'preview' | 'code'>(targetLine ? 'code' : 'preview')

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border-100/30 bg-bg-100/50 text-[length:var(--fs-xxs)]">
        <button
          onClick={() => setMode('preview')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'preview' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:preview')}
        </button>
        <button
          onClick={() => setMode('code')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'code' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:code')}
        </button>
      </div>
      {/* Content */}
      {mode === 'preview' ? (
        <ImagePreview dataUrl={dataUrl} fileName={fileName} />
      ) : (
        <div className="flex-1 min-h-0">
          <CodePreview
            code={text}
            language={language}
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        </div>
      )}
    </div>
  )
}

interface HtmlFilePreviewProps {
  serverId?: string
  text: string
  fileName: string
  filePath: string
  directory?: string
  isResizing?: boolean
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

function HtmlFilePreview({
  text,
  fileName,
  filePath,
  directory,
  serverId,
  isResizing = false,
  targetLine,
  targetKey,
  targetRanges,
}: HtmlFilePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const [mode, setMode] = useState<'preview' | 'code'>(targetLine ? 'code' : 'preview')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border-100/30 bg-bg-100/50 px-2 py-1 text-[length:var(--fs-xxs)]">
        <button
          type="button"
          onClick={() => setMode('preview')}
          className={`rounded px-2 py-0.5 transition-colors ${mode === 'preview' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:preview')}
        </button>
        <button
          type="button"
          onClick={() => setMode('code')}
          className={`rounded px-2 py-0.5 transition-colors ${mode === 'code' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:code')}
        </button>
      </div>
      {mode === 'preview' ? (
        <div className="min-h-0 flex-1">
          <HtmlFilePreviewFrame
            html={text}
            title={fileName}
            filePath={filePath}
            directory={directory}
            serverId={serverId}
            isResizing={isResizing}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <CodePreview
            code={text}
            language="html"
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        </div>
      )}
    </div>
  )
}

interface MarkdownFilePreviewProps {
  text: string
  isResizing?: boolean
  targetLine?: number
  targetKey?: string
  targetRanges?: readonly TargetLineRange[]
}

function MarkdownFilePreview({
  text,
  isResizing = false,
  targetLine,
  targetKey,
  targetRanges,
}: MarkdownFilePreviewProps) {
  const { t } = useTranslation(['components', 'common'])
  const [mode, setMode] = useState<'preview' | 'code'>(targetLine ? 'code' : 'preview')

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border-100/30 bg-bg-100/50 text-[length:var(--fs-xxs)]">
        <button
          onClick={() => setMode('preview')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'preview' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:preview')}
        </button>
        <button
          onClick={() => setMode('code')}
          className={`px-2 py-0.5 rounded transition-colors ${mode === 'code' ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200 hover:text-text-100'}`}
        >
          {t('common:code')}
        </button>
      </div>

      {mode === 'preview' ? (
        <div className="flex-1 min-h-0 overflow-auto panel-scrollbar px-5 py-4">
          <MarkdownRenderer content={text} />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <CodePreview
            code={text}
            language="markdown"
            isResizing={isResizing}
            targetLine={targetLine}
            targetKey={targetKey}
            targetRanges={targetRanges}
          />
        </div>
      )}
    </div>
  )
}

// ============================================
// Binary Placeholder - 不可预览的二进制文件
// ============================================

interface BinaryPlaceholderProps {
  mimeType: string
  fileName: string
  onDownload?: () => void
}

function BinaryPlaceholder({ mimeType, fileName, onDownload }: BinaryPlaceholderProps) {
  const { t } = useTranslation(['components', 'common'])

  return (
    <div className="flex flex-col items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] gap-2 p-4">
      <img
        src={getMaterialIconUrl(fileName, 'file')}
        alt=""
        width={32}
        height={32}
        className="opacity-50"
        onError={e => {
          e.currentTarget.style.visibility = 'hidden'
        }}
      />
      <span className="font-medium text-text-300">{fileName}</span>
      <span>{formatMimeType(mimeType)}</span>
      <span className="text-text-500 text-[length:var(--fs-xxs)]">{t('components:fileExplorer.binaryFile')}</span>
      {onDownload && (
        <button
          onClick={onDownload}
          className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-bg-200 hover:bg-bg-300 text-text-200 rounded transition-colors text-[length:var(--fs-xs)]"
        >
          <DownloadIcon size={12} />
          {t('common:download')}
        </button>
      )}
    </div>
  )
}

// ============================================
// Diff Preview
// ============================================

interface DiffPreviewProps {
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
  isResizing?: boolean
}

// 当前未在 Files 预览中使用，保留供 Changes 面板等复用
export function DiffPreview({ hunks, isResizing = false }: DiffPreviewProps) {
  return (
    <div
      className={`font-mono text-[length:var(--fs-code)] leading-relaxed ${isResizing ? 'whitespace-pre overflow-hidden' : ''}`}
      style={{ contain: 'content' }}
    >
      {hunks.map((hunk, hunkIdx) => (
        <div key={hunkIdx} className="border-b border-border-100/30 last:border-0">
          {/* Hunk Header */}
          <div className="px-3 py-1 bg-bg-200/50 text-text-400 text-[length:var(--fs-xxs)]">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {/* Lines */}
          <div>
            {hunk.lines.map((line, lineIdx) => {
              const type = line[0]
              let bgClass = ''
              let textClass = 'text-text-300'

              if (type === '+') {
                bgClass = 'bg-success-100/10'
                textClass = 'text-success-100'
              } else if (type === '-') {
                bgClass = 'bg-danger-100/10'
                textClass = 'text-danger-100'
              }

              return (
                <div key={lineIdx} className={`px-3 py-0.5 ${bgClass} ${textClass}`}>
                  <span className="select-none opacity-50 w-4 inline-block">{type || ' '}</span>
                  <span>{line.slice(1)}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
