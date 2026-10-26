import {
  PREVIEW_DISK_CACHE_BYTES,
  PREVIEW_DISK_CACHE_ENTRIES,
  PREVIEW_DISK_CACHE_MAX_AGE_MS,
} from '../utils/previewLimits'
import { fileChecksum } from '../utils/fileChecksum'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export type PreviewDiskKind = 'bytes' | 'file-content'
interface Metadata {
  key: string
  fingerprint: string
  kind: PreviewDiskKind
  size: number
  createdAt: number
  usedAt: number
  payloadHash: string
}
const DATABASE = 'opencode-preview-cache-v1'
let connection: Promise<IDBDatabase | null> | undefined

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (connection) return connection
  connection = new Promise(resolve => {
    let finished = false
    const finish = (db: IDBDatabase | null) => {
      if (finished) {
        db?.close()
        return
      }
      finished = true
      clearTimeout(timer)
      resolve(db)
    }
    const timer = setTimeout(() => finish(null), 2000)
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        if (finished) {
          request.transaction?.abort()
          return
        }
        const db = request.result
        db.createObjectStore('metadata', { keyPath: 'key' })
        db.createObjectStore('payload')
      }
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          db.close()
          connection = undefined
        }
        db.onclose = () => {
          connection = undefined
        }
        finish(db)
      }
    } catch {
      finish(null)
    }
  })
  const opening = connection
  void opening.then(db => {
    if (!db && connection === opening) connection = undefined
  })
  return connection
}

/** Cache keys do not persist file paths or any connection credentials. */
function diskKey(key: string) {
  return fileChecksum(new TextEncoder().encode(key))
}
function validSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function payloadSize(value: unknown, kind: PreviewDiskKind): number | null {
  if (kind === 'bytes')
    return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
      ? value.byteLength
      : null
  if (!value || typeof value !== 'object') return null
  const content = value as { type?: unknown; content?: unknown; encoding?: unknown; mimeType?: unknown }
  if (
    (content.type !== 'text' && content.type !== 'binary') ||
    typeof content.content !== 'string' ||
    (content.encoding !== undefined && typeof content.encoding !== 'string') ||
    (content.mimeType !== undefined && typeof content.mimeType !== 'string')
  )
    return null
  return content.content.length * 2
}
function normalizedPayload(value: unknown, kind: PreviewDiskKind): unknown {
  if (kind === 'bytes') return value
  const content = value as { type: string; content: string; encoding?: string; mimeType?: string }
  return {
    type: content.type,
    content: content.content,
    ...(content.encoding !== undefined ? { encoding: content.encoding } : {}),
    ...(content.mimeType !== undefined ? { mimeType: content.mimeType } : {}),
  }
}
function payloadHash(value: unknown, kind: PreviewDiskKind): string {
  if (kind === 'bytes') return fileChecksum(value as Uint8Array)
  const content = value as { type: string; content: string; encoding?: string; mimeType?: string }
  const hash = sha256.create()
  hash.update(new TextEncoder().encode(JSON.stringify([content.type, content.encoding, content.mimeType])))
  // Hash exact UTF-16 units in bounded chunks without making another full-size
  // encoded copy of a large text/base64 preview.
  const buffer = new Uint8Array(16384)
  for (let offset = 0; offset < content.content.length; offset += buffer.length / 2) {
    const count = Math.min(buffer.length / 2, content.content.length - offset)
    for (let index = 0; index < count; index++) {
      const code = content.content.charCodeAt(offset + index)
      buffer[index * 2] = code & 255
      buffer[index * 2 + 1] = code >>> 8
    }
    hash.update(buffer.subarray(0, count * 2))
  }
  return bytesToHex(hash.digest())
}
function expired(meta: Metadata, now: number) {
  return (
    !validSize(meta.size) ||
    meta.size > PREVIEW_DISK_CACHE_BYTES ||
    typeof meta.payloadHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(meta.payloadHash) ||
    !Number.isFinite(meta.createdAt) ||
    !Number.isFinite(meta.usedAt) ||
    meta.createdAt > now ||
    now - meta.createdAt > PREVIEW_DISK_CACHE_MAX_AGE_MS
  )
}

/** IndexedDB failure never makes a file unreadable. Bound waits and fail to a cache miss. */
async function transact<T>(
  mode: IDBTransactionMode,
  fallback: T,
  action: (tx: IDBTransaction, set: (result: T) => void) => void,
): Promise<T> {
  const db = await database()
  if (!db) return fallback
  return new Promise(resolve => {
    let result = fallback,
      settled = false
    let tx: IDBTransaction | undefined
    const finish = (value: T) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
    }
    const timer = setTimeout(() => {
      try {
        tx?.abort()
      } catch {
        /* already closed */
      }
      finish(fallback)
    }, 3000)
    try {
      tx = db.transaction(['metadata', 'payload'], mode)
      tx.oncomplete = () => finish(result)
      tx.onabort = tx.onerror = () => finish(fallback)
      action(tx, value => {
        result = value
      })
    } catch {
      db.close()
      connection = undefined
      try {
        tx?.abort()
      } catch {
        /* already closed */
      }
      finish(fallback)
    }
  })
}

export async function readPreviewDiskCache(
  key: string,
  fingerprint: string,
  kind: PreviewDiskKind,
): Promise<unknown | undefined> {
  const id = diskKey(key)
  const record = await transact<{ value: unknown; hash: string } | undefined>('readwrite', undefined, (tx, set) => {
    const metadata = tx.objectStore('metadata'),
      payload = tx.objectStore('payload')
    const request = metadata.get(id)
    request.onsuccess = () => {
      try {
        const meta = request.result as Metadata | undefined
        if (!meta) return
        if (meta.fingerprint !== fingerprint || meta.kind !== kind || expired(meta, Date.now())) {
          metadata.delete(id)
          payload.delete(id)
          return
        }
        const read = payload.get(id)
        read.onsuccess = () => {
          try {
            if (payloadSize(read.result, kind) !== meta.size) {
              metadata.delete(id)
              payload.delete(id)
              return
            }
            metadata.put({ ...meta, usedAt: Date.now() })
            set({ value: read.result, hash: meta.payloadHash })
          } catch {
            tx.abort()
          }
        }
      } catch {
        tx.abort()
      }
    }
  })
  if (!record) return undefined
  try {
    return payloadHash(record.value, kind) === record.hash ? record.value : undefined
  } catch {
    return undefined
  }
}

export async function writePreviewDiskCache(
  key: string,
  fingerprint: string,
  kind: PreviewDiskKind,
  value: unknown,
): Promise<void> {
  const size = payloadSize(value, kind)
  if (size === null || size > PREVIEW_DISK_CACHE_BYTES) return
  value = normalizedPayload(value, kind)
  const checksum = payloadHash(value, kind)
  const id = diskKey(key)
  await transact('readwrite', false, (tx, set) => {
    const metadata = tx.objectStore('metadata'),
      payload = tx.objectStore('payload')
    // Only metadata is read for eviction; hundreds of MiB of payload stay on disk.
    const list = metadata.getAll()
    list.onsuccess = () => {
      try {
        const now = Date.now()
        const entries: Metadata[] = []
        for (const meta of list.result as Metadata[]) {
          if (meta.key === id || expired(meta, now)) {
            metadata.delete(meta.key)
            payload.delete(meta.key)
          } else entries.push(meta)
        }
        entries.sort((a, b) => a.usedAt - b.usedAt)
        let total = entries.reduce((sum, entry) => sum + entry.size, 0)
        while (
          entries.length &&
          (entries.length >= PREVIEW_DISK_CACHE_ENTRIES || total + size > PREVIEW_DISK_CACHE_BYTES)
        ) {
          const oldest = entries.shift()!
          total -= oldest.size
          metadata.delete(oldest.key)
          payload.delete(oldest.key)
        }
        metadata.put({
          key: id,
          fingerprint,
          kind,
          size,
          createdAt: now,
          usedAt: now,
          payloadHash: checksum,
        } satisfies Metadata)
        payload.put(value, id)
        set(true)
      } catch {
        tx.abort()
      }
    }
  })
}

export async function clearPreviewDiskCache(): Promise<void> {
  await transact('readwrite', false, (tx, set) => {
    tx.objectStore('metadata').clear()
    tx.objectStore('payload').clear()
    set(true)
  })
}
