import { readFileBytes, readFileFingerprint } from './fileDownload'
import { fileChecksum } from '../utils/fileChecksum'
import { PREVIEW_CACHE_BYTES } from '../utils/previewLimits'
import { serverStore } from '../store/serverStore'
import i18n from '../i18n'
import { readPreviewDiskCache, writePreviewDiskCache, type PreviewDiskKind } from './previewDiskCache'

interface Entry {
  fingerprint: string
  value: unknown
  size: number
}
const entries = new Map<string, Entry>()
let retainedBytes = 0
let generation = 0

export function clearPreviewCache() {
  generation++
  entries.clear()
  retainedBytes = 0
}
serverStore.onServerChange(() => clearPreviewCache())

/** Always validate remotely before reuse. Never serve stale data on validation failure. */
export async function verifiedPreview<T>(options: {
  path: string
  directory: string
  serverId: string
  variant: string
  signal?: AbortSignal
  reload?: boolean
  load: () => Promise<T>
  size: (value: T) => number
  checksum?: (value: T) => string
  diskKind?: PreviewDiskKind
}): Promise<T> {
  const { path, directory, serverId, variant, signal } = options
  const key = JSON.stringify([serverId, directory, path, variant])
  const requestGeneration = generation
  signal?.throwIfAborted()
  const fingerprint = await readFileFingerprint(path, directory, serverId, signal)
  signal?.throwIfAborted()
  if (generation !== requestGeneration) throw new DOMException('File source changed', 'AbortError')
  const cached = entries.get(key)
  if (
    cached &&
    !options.reload &&
    cached.fingerprint === fingerprint &&
    generation === requestGeneration &&
    (!options.checksum || options.checksum(cached.value as T) === fingerprint)
  ) {
    entries.delete(key)
    entries.set(key, cached)
    return cached.value as T
  }
  if (cached) {
    entries.delete(key)
    retainedBytes -= cached.size
  }
  const retain = (value: T, size: number) => {
    if (generation !== requestGeneration || !Number.isSafeInteger(size) || size < 0 || size > PREVIEW_CACHE_BYTES)
      return
    const replaced = entries.get(key)
    if (replaced) {
      entries.delete(key)
      retainedBytes -= replaced.size
    }
    while (entries.size && (retainedBytes + size > PREVIEW_CACHE_BYTES || entries.size >= 8)) {
      const oldest = entries.keys().next().value!
      retainedBytes -= entries.get(oldest)!.size
      entries.delete(oldest)
    }
    entries.set(key, { fingerprint, value, size })
    retainedBytes += size
  }
  if (options.diskKind && !options.reload) {
    const persisted = (await readPreviewDiskCache(key, fingerprint, options.diskKind)) as T | undefined
    signal?.throwIfAborted()
    if (generation !== requestGeneration) throw new DOMException('File source changed', 'AbortError')
    if (persisted !== undefined && (!options.checksum || options.checksum(persisted) === fingerprint)) {
      // Disk reads can take time; check again before presenting their contents.
      const afterDisk = await readFileFingerprint(path, directory, serverId, signal)
      signal?.throwIfAborted()
      if (generation !== requestGeneration) throw new DOMException('File source changed', 'AbortError')
      if (afterDisk !== fingerprint) throw new Error(i18n.t('components:fileExplorer.previewChanged'))
      retain(persisted, options.size(persisted))
      return persisted
    }
  }
  const value = await options.load()
  signal?.throwIfAborted()
  const after = await readFileFingerprint(path, directory, serverId, signal)
  signal?.throwIfAborted()
  if (generation !== requestGeneration) throw new DOMException('File source changed', 'AbortError')
  if (fingerprint !== after || (options.checksum && options.checksum(value) !== after)) {
    throw new Error(i18n.t('components:fileExplorer.previewChanged'))
  }
  const size = options.size(value)
  retain(value, size)
  if (options.diskKind)
    void writePreviewDiskCache(key, fingerprint, options.diskKind, value).catch(() => {
      /* Optional cache writes must not reject a completed file read. */
    })
  return value
}

export function readVerifiedFile(
  path: string,
  directory: string,
  serverId: string,
  options: { maxBytes: number; signal?: AbortSignal; reload?: boolean },
) {
  return verifiedPreview({
    path,
    directory,
    serverId,
    variant: `bytes:${options.maxBytes}`,
    signal: options.signal,
    reload: options.reload,
    load: () => readFileBytes(path, directory, serverId, options),
    size: bytes => bytes.byteLength,
    checksum: fileChecksum,
    diskKind: 'bytes',
  })
}
