import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPreviewCache, readVerifiedFile } from './previewCache'
import { fileChecksum } from '../utils/fileChecksum'

const { read, fingerprint, onChange } = vi.hoisted(() => ({ read: vi.fn(), fingerprint: vi.fn(), onChange: vi.fn() }))
vi.mock('./fileDownload', () => ({ readFileBytes: read, readFileFingerprint: fingerprint }))
vi.mock('../store/serverStore', () => ({ serverStore: { onServerChange: onChange } }))
const options = { maxBytes: 8 * 1024 * 1024 }

describe('verified bounded preview cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPreviewCache()
  })
  function content(text: string) {
    const bytes = new TextEncoder().encode(text)
    read.mockResolvedValue(bytes)
    fingerprint.mockResolvedValue(fileChecksum(bytes))
    return bytes
  }
  it('reuses bytes across component remounts but verifies a remote checksum on every open', async () => {
    const bytes = content('same file')
    expect(await readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(bytes)
    expect(await readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(bytes)
    expect(read).toHaveBeenCalledOnce()
    expect(fingerprint).toHaveBeenCalledTimes(3)
  })
  it('fetches edited content even when file size and timestamps could be unchanged', async () => {
    content('old')
    await readVerifiedFile('notes.txt', '/project', 'server-a', options)
    const changed = content('new')
    expect(await readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(changed)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('fails closed on deletion, permission error or offline validation rather than showing the old file', async () => {
    content('cached')
    await readVerifiedFile('notes.txt', '/project', 'server-a', options)
    fingerprint.mockRejectedValueOnce(new Error('missing'))
    await expect(readVerifiedFile('notes.txt', '/project', 'server-a', options)).rejects.toThrow('missing')
    expect(read).toHaveBeenCalledOnce()
  })
  it('isolates server and directory identities and supports a forced reload', async () => {
    content('data')
    await readVerifiedFile('notes.txt', '/project', 'server-a', options)
    await readVerifiedFile('notes.txt', '/other', 'server-a', options)
    await readVerifiedFile('notes.txt', '/project', 'server-b', options)
    await readVerifiedFile('notes.txt', '/project', 'server-a', { ...options, reload: true })
    expect(read).toHaveBeenCalledTimes(4)
  })
  it('rejects a file changing during transfer and does not cache its bytes', async () => {
    const old = new TextEncoder().encode('old'),
      changed = new TextEncoder().encode('new')
    fingerprint.mockResolvedValueOnce(fileChecksum(old)).mockResolvedValueOnce(fileChecksum(changed))
    read.mockResolvedValue(old)
    await expect(readVerifiedFile('notes.txt', '/project', 'server-a', options)).rejects.toThrow(
      /changed while loading/,
    )
    content('new')
    await readVerifiedFile('notes.txt', '/project', 'server-a', options)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('does not return an in-flight result after the source cache has been invalidated', async () => {
    content('data')
    let resolve!: (bytes: Uint8Array) => void
    read.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>(done => {
          resolve = done
        }),
    )
    const request = readVerifiedFile('notes.txt', '/project', 'server-a', options)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    clearPreviewCache()
    resolve(new TextEncoder().encode('data'))
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('evicts the least recently used file once the entry bound is reached', async () => {
    content('data')
    for (let index = 0; index < 9; index++) await readVerifiedFile(`${index}.txt`, '/project', 'server-a', options)
    await readVerifiedFile('0.txt', '/project', 'server-a', options)
    expect(read).toHaveBeenCalledTimes(10)
  })
  it('does not return cached binary bytes that a caller has mutated', async () => {
    const bytes = content('original')
    const first = await readVerifiedFile('notes.txt', '/project', 'server-a', options)
    first[0] = 0
    read.mockResolvedValue(new TextEncoder().encode('original'))
    expect(await readVerifiedFile('notes.txt', '/project', 'server-a', options)).toEqual(
      new TextEncoder().encode('original'),
    )
    expect(read).toHaveBeenCalledTimes(2)
    expect(bytes[0]).toBe(0)
  })
})
