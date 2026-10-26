import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileDownload } from './useFileDownload'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { readFileBytes } from '../../api/fileDownload'
import { saveData } from '../../utils/downloadUtils'

vi.mock('../../api/fileDownload', () => ({ readFileBytes: vi.fn() }))
vi.mock('../../utils/downloadUtils', () => ({ saveData: vi.fn() }))

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SessionNavigationContext.Provider
      value={{ navigateToSession: vi.fn(), currentSessionId: 'server-b::session-1', currentDirectory: '/workspace/b' }}
    >
      {children}
    </SessionNavigationContext.Provider>
  )
}

describe('attachment downloads', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('downloads non-image data attachments with their original filename and mime', async () => {
    const bytes = new Uint8Array([0, 255, 42])
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useFileDownload(), { wrapper })
    await act(async () =>
      result.current.download({
        id: '1',
        type: 'file',
        displayName: '报告.pdf',
        mime: 'application/pdf',
        url: 'data:application/pdf;base64,AP8q',
      }),
    )
    expect(saveData).toHaveBeenCalledWith(bytes, '报告.pdf', 'application/pdf')
    expect(readFileBytes).not.toHaveBeenCalled()
  })

  it('preserves empty text attachments', async () => {
    const { result } = renderHook(() => useFileDownload(), { wrapper })
    await act(async () => result.current.download({ id: '1', type: 'text', displayName: 'empty.txt', content: '' }))
    const [bytes, fileName, mime] = vi.mocked(saveData).mock.calls[0]
    expect(Array.from(bytes)).toEqual([])
    expect(fileName).toBe('empty.txt')
    expect(mime).toBe('text/plain;charset=utf-8')
  })

  it('prevents duplicate downloads while a file is being read', async () => {
    let resolve!: (data: Uint8Array) => void
    vi.mocked(readFileBytes).mockImplementation(
      () =>
        new Promise(done => {
          resolve = done
        }),
    )
    const { result } = renderHook(() => useFileDownload(), { wrapper })
    let promise!: Promise<void>
    act(() => {
      promise = result.current.download('report.pdf')
    })
    expect(result.current.isDownloading).toBe(true)
    await act(async () => result.current.download('report.pdf'))
    expect(readFileBytes).toHaveBeenCalledOnce()
    await act(async () => {
      resolve(new Uint8Array([42]))
      await promise
    })
    expect(result.current.isDownloading).toBe(false)
    expect(saveData).toHaveBeenCalledOnce()
  })

  it('exposes byte progress and replaces it with a failure state without reporting success', async () => {
    let rejectDownload!: (error: Error) => void
    vi.mocked(readFileBytes).mockImplementationOnce((_path, _directory, _server, options) => {
      options?.onProgress?.({ loaded: 400, total: 1000, phase: 'transferring' })
      return new Promise<Uint8Array>((_resolve, reject) => {
        rejectDownload = reject
      })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useFileDownload(), { wrapper })
      let request!: Promise<void>
      act(() => {
        request = result.current.download('report.pdf')
      })
      expect(result.current.progress).toEqual({ loaded: 400, total: 1000, phase: 'transferring' })
      await act(async () => {
        rejectDownload(new Error('interrupted'))
        await request
      })
      expect(result.current.progress).toEqual({ loaded: 400, total: 1000, phase: 'failed' })
      expect(result.current.error).toBe(true)
      expect(saveData).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
