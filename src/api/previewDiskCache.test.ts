import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_DISK_CACHE_MAX_AGE_MS } from '../utils/previewLimits'
import { fileChecksum } from '../utils/fileChecksum'

async function alterPayload(key: string, value: unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('opencode-preview-cache-v1', 1)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('payload', 'readwrite')
      tx.objectStore('payload').put(value, fileChecksum(new TextEncoder().encode(key)))
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('persistent preview storage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('survives a fresh module instance like closing and reopening the page', async () => {
    const first = await import('./previewDiskCache')
    await first.writePreviewDiskCache('server-a:/project/report.pdf', 'hash-a', 'bytes', new Uint8Array([0, 255, 1]))
    vi.resetModules()
    const reopened = await import('./previewDiskCache')
    expect(
      Array.from(
        (await reopened.readPreviewDiskCache('server-a:/project/report.pdf', 'hash-a', 'bytes')) as Uint8Array,
      ),
    ).toEqual([0, 255, 1])
  })

  it('rejects changed versions and does not allow another server or variant to reuse the payload', async () => {
    const cache = await import('./previewDiskCache')
    await cache.writePreviewDiskCache('server-a:/project/report', 'old', 'bytes', new Uint8Array([1]))
    expect(await cache.readPreviewDiskCache('server-b:/project/report', 'old', 'bytes')).toBeUndefined()
    expect(await cache.readPreviewDiskCache('server-a:/project/report', 'new', 'bytes')).toBeUndefined()
    expect(await cache.readPreviewDiskCache('server-a:/project/report', 'old', 'bytes')).toBeUndefined()
    await cache.writePreviewDiskCache('server-a:/project/report', 'new', 'bytes', new Uint8Array([2]))
    expect(await cache.readPreviewDiskCache('server-a:/project/report', 'new', 'file-content')).toBeUndefined()
  })

  it('keeps binary and native file content intact and expires old entries', async () => {
    const cache = await import('./previewDiskCache')
    const content = { type: 'text', content: '中文\n<script>example</script>', mimeType: 'text/plain' }
    await cache.writePreviewDiskCache('text', 'hash', 'file-content', content)
    expect(await cache.readPreviewDiskCache('text', 'hash', 'file-content')).toEqual(content)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + PREVIEW_DISK_CACHE_MAX_AGE_MS + 1000)
    expect(await cache.readPreviewDiskCache('text', 'hash', 'file-content')).toBeUndefined()
  })

  it('evicts least recently used entries and supports clearing persistent data', async () => {
    const cache = await import('./previewDiskCache')
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    for (let index = 0; index < 64; index++)
      await cache.writePreviewDiskCache(`${index}`, 'hash', 'bytes', new Uint8Array([index]))
    await cache.readPreviewDiskCache('0', 'hash', 'bytes')
    await cache.writePreviewDiskCache('64', 'hash', 'bytes', new Uint8Array([64]))
    expect(await cache.readPreviewDiskCache('1', 'hash', 'bytes')).toBeUndefined()
    expect(Array.from((await cache.readPreviewDiskCache('0', 'hash', 'bytes')) as Uint8Array)).toEqual([0])
    await cache.clearPreviewDiskCache()
    expect(await cache.readPreviewDiskCache('0', 'hash', 'bytes')).toBeUndefined()
  })

  it('treats unavailable storage and rejected writes as cache misses', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const cache = await import('./previewDiskCache')
    await expect(cache.writePreviewDiskCache('file', 'hash', 'bytes', new Uint8Array([1]))).resolves.toBeUndefined()
    expect(await cache.readPreviewDiskCache('file', 'hash', 'bytes')).toBeUndefined()
  })

  it('falls back when the browser quota prevents writes', async () => {
    const { IDBObjectStore } = await import('fake-indexeddb')
    const cache = await import('./previewDiskCache')
    await cache.writePreviewDiskCache('existing', 'hash', 'bytes', new Uint8Array([1]))
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Quota reached', 'QuotaExceededError')
    })
    await expect(cache.writePreviewDiskCache('new', 'hash', 'bytes', new Uint8Array([2]))).resolves.toBeUndefined()
    put.mockRestore()
    expect(await cache.readPreviewDiskCache('new', 'hash', 'bytes')).toBeUndefined()
    expect(Array.from((await cache.readPreviewDiskCache('existing', 'hash', 'bytes')) as Uint8Array)).toEqual([1])
  })

  it('does not accept unsupported payloads', async () => {
    const cache = await import('./previewDiskCache')
    await cache.writePreviewDiskCache('invalid', 'hash', 'file-content', { content: 'hello', type: 'unknown' })
    expect(await cache.readPreviewDiskCache('invalid', 'hash', 'file-content')).toBeUndefined()
  })

  it('rejects same-length corrupted native preview contents and altered MIME metadata', async () => {
    const cache = await import('./previewDiskCache')
    const original = { type: 'text', content: 'original', mimeType: 'text/plain' }
    await cache.writePreviewDiskCache('native', 'hash', 'file-content', original)
    await alterPayload('native', { ...original, content: 'modified' })
    expect(await cache.readPreviewDiskCache('native', 'hash', 'file-content')).toBeUndefined()
    await cache.writePreviewDiskCache('native', 'hash', 'file-content', original)
    await alterPayload('native', { ...original, mimeType: 'text/html' })
    expect(await cache.readPreviewDiskCache('native', 'hash', 'file-content')).toBeUndefined()
  })

  it('rejects corrupted bytes and stores only explicitly supported preview fields', async () => {
    const cache = await import('./previewDiskCache')
    await cache.writePreviewDiskCache('bytes', 'hash', 'bytes', new Uint8Array([1, 2]))
    await alterPayload('bytes', new Uint8Array([2, 1]))
    expect(await cache.readPreviewDiskCache('bytes', 'hash', 'bytes')).toBeUndefined()
    await cache.writePreviewDiskCache('native', 'hash', 'file-content', {
      type: 'text',
      content: 'safe',
      extra: new Uint8Array(1000),
    })
    expect(await cache.readPreviewDiskCache('native', 'hash', 'file-content')).toEqual({
      type: 'text',
      content: 'safe',
    })
  })

  it('recovers after opening the database fails temporarily', async () => {
    const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('Temporarily unavailable', 'InvalidStateError')
    })
    const cache = await import('./previewDiskCache')
    expect(await cache.readPreviewDiskCache('file', 'hash', 'bytes')).toBeUndefined()
    await cache.writePreviewDiskCache('file', 'hash', 'bytes', new Uint8Array([7]))
    expect(Array.from((await cache.readPreviewDiskCache('file', 'hash', 'bytes')) as Uint8Array)).toEqual([7])
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('recovers after an already open connection becomes unusable', async () => {
    const { IDBDatabase } = await import('fake-indexeddb')
    const cache = await import('./previewDiskCache')
    await cache.writePreviewDiskCache('file', 'hash', 'bytes', new Uint8Array([7]))
    const transact = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('Connection closed', 'InvalidStateError')
    })
    expect(await cache.readPreviewDiskCache('file', 'hash', 'bytes')).toBeUndefined()
    transact.mockRestore()
    expect(Array.from((await cache.readPreviewDiskCache('file', 'hash', 'bytes')) as Uint8Array)).toEqual([7])
  })

  it('bounds a blocked database open and permits a later retry', async () => {
    const cache = await import('./previewDiskCache')
    const actualOpen = indexedDB.open.bind(indexedDB)
    let abandoned: IDBOpenDBRequest | undefined
    vi.spyOn(indexedDB, 'open')
      .mockImplementationOnce(() => {
        abandoned = {} as IDBOpenDBRequest
        return abandoned
      })
      .mockImplementation(actualOpen)
    vi.useFakeTimers()
    try {
      const miss = cache.readPreviewDiskCache('file', 'hash', 'bytes')
      await vi.advanceTimersByTimeAsync(2001)
      expect(await miss).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
    await cache.writePreviewDiskCache('file', 'hash', 'bytes', new Uint8Array([7]))
    expect(Array.from((await cache.readPreviewDiskCache('file', 'hash', 'bytes')) as Uint8Array)).toEqual([7])
    const close = vi.fn()
    Object.defineProperty(abandoned!, 'result', { value: { close } })
    abandoned!.onsuccess?.(new Event('success'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('serializes concurrent writes from two page instances while enforcing the shared entry bound', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    const first = await import('./previewDiskCache')
    await first.writePreviewDiskCache('seed', 'hash', 'bytes', new Uint8Array([0]))
    vi.resetModules()
    const second = await import('./previewDiskCache')
    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        (index % 2 ? first : second).writePreviewDiskCache(`file-${index}`, 'hash', 'bytes', new Uint8Array([index])),
      ),
    )
    let count = 0
    for (let index = 0; index < 80; index++)
      if (await first.readPreviewDiskCache(`file-${index}`, 'hash', 'bytes')) count++
    expect(count).toBe(64)
  })

  it('enforces the byte budget without loading retained payloads into memory', async () => {
    vi.doMock('../utils/previewLimits', () => ({
      PREVIEW_DISK_CACHE_BYTES: 8,
      PREVIEW_DISK_CACHE_ENTRIES: 64,
      PREVIEW_DISK_CACHE_MAX_AGE_MS: 86400000,
    }))
    try {
      const cache = await import('./previewDiskCache')
      await cache.writePreviewDiskCache('a', 'hash', 'bytes', new Uint8Array(5))
      await cache.writePreviewDiskCache('b', 'hash', 'bytes', new Uint8Array(5))
      expect(await cache.readPreviewDiskCache('a', 'hash', 'bytes')).toBeUndefined()
      expect(((await cache.readPreviewDiskCache('b', 'hash', 'bytes')) as Uint8Array).byteLength).toBe(5)
      await cache.writePreviewDiskCache('oversized', 'hash', 'bytes', new Uint8Array(9))
      expect(await cache.readPreviewDiskCache('oversized', 'hash', 'bytes')).toBeUndefined()
    } finally {
      vi.doUnmock('../utils/previewLimits')
    }
  })
})
