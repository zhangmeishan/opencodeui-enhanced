// ============================================
// File Search API Functions
// 基于 @opencode-ai/sdk: /file, /find/file, /find/symbol 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { FileNode, FileContent, FileStatusItem, SymbolInfo, TextSearchMatch } from './types'
import { serverStore } from '../store/serverStore'

const ROOT_DIRECTORY_CACHE_TTL_MS = 10_000

const rootDirectoryCache = new Map<string, { data: FileNode[]; expiresAt: number }>()
const rootDirectoryInflight = new Map<string, Promise<FileNode[]>>()

export function invalidateDirectoryCache(directory?: string, serverId?: string): void {
  const key = getRootDirectoryCacheKey(directory, serverId)
  rootDirectoryCache.delete(key)
  rootDirectoryInflight.delete(key)
}

function isRootDirectoryPath(path: string): boolean {
  return path === '' || path === '.' || path === './'
}

function getRootDirectoryCacheKey(directory?: string, serverId?: string): string {
  return `${serverId ?? serverStore.getActiveServerId()}::${formatPathForApi(directory, serverId) ?? ''}`
}

async function fetchDirectory(path: string, directory?: string, serverId?: string): Promise<FileNode[]> {
  const sdk = getSDKClient(serverId)
  const isAbsolute = /^[a-zA-Z]:/.test(path) || path.startsWith('/')

  if (isAbsolute && !directory) {
    return unwrap(await sdk.file.list({ directory: formatPathForApi(path, serverId), path: '' }))
  }

  return unwrap(await sdk.file.list({ path, directory: formatPathForApi(directory, serverId) }))
}

/**
 * 搜索文件或目录
 */
export async function searchFiles(
  query: string,
  options: {
    directory?: string
    type?: 'file' | 'directory'
    limit?: number
    serverId?: string
  } = {},
): Promise<string[]> {
  const sdk = getSDKClient(options.serverId)
  return unwrap(
    await sdk.find.files({
      query,
      directory: formatPathForApi(options.directory, options.serverId),
      type: options.type,
      limit: options.limit,
    }),
  ) as string[]
}

/**
 * 列出目录内容
 */
export async function listDirectory(path: string, directory?: string, serverId?: string): Promise<FileNode[]> {
  if (!isRootDirectoryPath(path)) {
    return fetchDirectory(path, directory, serverId)
  }

  const key = getRootDirectoryCacheKey(directory, serverId)
  const now = Date.now()
  const cached = rootDirectoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.data
  }

  const inflight = rootDirectoryInflight.get(key)
  if (inflight) {
    return inflight
  }

  const request = fetchDirectory(path === '' ? '.' : path, directory, serverId)
    .then(data => {
      if (rootDirectoryInflight.get(key) === request) {
        rootDirectoryCache.set(key, { data, expiresAt: Date.now() + ROOT_DIRECTORY_CACHE_TTL_MS })
      }
      return data
    })
    .finally(() => {
      if (rootDirectoryInflight.get(key) === request) rootDirectoryInflight.delete(key)
    })

  rootDirectoryInflight.set(key, request)
  return request
}

export async function prefetchRootDirectory(directory?: string, serverId?: string): Promise<void> {
  await listDirectory('.', directory, serverId)
}

/**
 * 读取文件内容
 */
export async function getFileContent(path: string, directory?: string, serverId?: string): Promise<FileContent> {
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.file.read({ path, directory: formatPathForApi(directory, serverId) }))
}

/**
 * 获取文件 git 状态
 */
export async function getFileStatus(directory?: string, serverId?: string): Promise<FileStatusItem[]> {
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.file.status({ directory: formatPathForApi(directory, serverId) }))
}

/**
 * 搜索代码符号
 */
export async function searchSymbols(query: string, directory?: string, serverId?: string): Promise<SymbolInfo[]> {
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.find.symbols({ query, directory: formatPathForApi(directory, serverId) }))
}

/**
 * 搜索文件正文内容
 */
export async function searchText(pattern: string, directory?: string, serverId?: string): Promise<TextSearchMatch[]> {
  const sdk = getSDKClient(serverId)
  return unwrap(await sdk.find.text({ pattern, directory: formatPathForApi(directory, serverId) }))
}

/**
 * 搜索目录（便捷方法）
 */
export async function searchDirectories(query: string, baseDirectory?: string, limit: number = 50): Promise<string[]> {
  return searchFiles(query, {
    directory: baseDirectory,
    type: 'directory',
    limit,
  })
}
