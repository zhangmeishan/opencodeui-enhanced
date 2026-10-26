import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileChecksum } from '../utils/fileChecksum'

const { read, fingerprint } = vi.hoisted(() => ({ read: vi.fn(), fingerprint: vi.fn() }))
vi.mock('./fileDownload', () => ({ readFileBytes: read, readFileFingerprint: fingerprint }))
vi.mock('../store/serverStore', () => ({ serverStore: { onServerChange: () => () => {} } }))
const options = { maxBytes: 8 * 1024 * 1024 }

describe('verified preview persistence integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
    read.mockReset()
    fingerprint.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())
  async function seed() {
    const cache = await import('./previewCache')
    const bytes = new TextEncoder().encode('old')
    read.mockResolvedValue(bytes)
    fingerprint.mockResolvedValue(fileChecksum(bytes))
    await cache.readVerifiedFile('notes.txt', '/project', 'server-a', options)
    // Wait behind the queued background disk write transaction.
    const disk = await import('./previewDiskCache')
    const key = JSON.stringify(['server-a', '/project', 'notes.txt', `bytes:${options.maxBytes}`])
    await vi.waitFor(async () =>
      expect(await disk.readPreviewDiskCache(key, fileChecksum(bytes), 'bytes')).toEqual(bytes),
    )
    cache.clearPreviewCache()
    return cache
  }
  it('reloads from disk after the memory cache is cleared while checking the server version', async () => {
    const cache = await seed()
    expect(await cache.readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(
      new TextEncoder().encode('old'),
    )
    expect(read).toHaveBeenCalledOnce()
    expect(fingerprint).toHaveBeenCalledTimes(4)
  })
  it('downloads the edited file instead of returning an old disk copy', async () => {
    const cache = await seed()
    const bytes = new TextEncoder().encode('new')
    read.mockResolvedValue(bytes)
    fingerprint.mockResolvedValue(fileChecksum(bytes))
    expect(await cache.readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(bytes)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('refuses offline disk contents and always honors forced reload', async () => {
    const cache = await seed()
    fingerprint.mockRejectedValueOnce(new Error('offline'))
    await expect(cache.readVerifiedFile('notes.txt', '/project', 'server-a', options)).rejects.toThrow('offline')
    expect(read).toHaveBeenCalledOnce()
    await cache.readVerifiedFile('notes.txt', '/project', 'server-a', { ...options, reload: true })
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('does not reuse a corrupted binary disk copy even when its metadata claims the current fingerprint', async () => {
    const cache = await seed()
    const disk = await import('./previewDiskCache')
    const key = JSON.stringify(['server-a', '/project', 'notes.txt', `bytes:${options.maxBytes}`])
    const hash = fileChecksum(new TextEncoder().encode('old'))
    await disk.writePreviewDiskCache(key, hash, 'bytes', new TextEncoder().encode('bad'))
    expect(await cache.readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(
      new TextEncoder().encode('old'),
    )
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('rejects a disk-hit result if the server changes during the disk read and subsequent verification', async () => {
    const cache = await seed()
    fingerprint
      .mockResolvedValueOnce(fileChecksum(new TextEncoder().encode('old')))
      .mockResolvedValueOnce(fileChecksum(new TextEncoder().encode('new')))
    await expect(cache.readVerifiedFile('notes.txt', '/project', 'server-a', options)).rejects.toThrow(
      'changed while loading',
    )
    expect(read).toHaveBeenCalledOnce()
  })
})
