import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readEditableFile } from './fileSave'
import { TEXT_PREVIEW_BYTES } from '../utils/previewLimits'
const read = vi.hoisted(() => vi.fn())
vi.mock('./previewCache', () => ({ readVerifiedFile: read }))
describe('editable file size policy', () => {
  beforeEach(() => read.mockReset())
  it('accepts a text file above the former 2 MiB limit and retains a save checksum', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(65)
    read.mockResolvedValue(bytes)
    const result = await readEditableFile('large.log', '/project', 'remote')
    expect(result.bytes.length).toBe(3 * 1024 * 1024)
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(read).toHaveBeenCalledWith('large.log', '/project', 'remote', {
      maxBytes: TEXT_PREVIEW_BYTES,
      signal: undefined,
    })
    expect(TEXT_PREVIEW_BYTES).toBe(8 * 1024 * 1024)
  })
  it('passes an explicit reload through to the verified cache to bypass both cache layers', async () => {
    read.mockResolvedValue(new TextEncoder().encode('latest'))
    await readEditableFile('notes.txt', '/project', 'remote', undefined, { reload: true })
    expect(read).toHaveBeenCalledWith('notes.txt', '/project', 'remote', {
      maxBytes: TEXT_PREVIEW_BYTES,
      signal: undefined,
      reload: true,
    })
  })
})
