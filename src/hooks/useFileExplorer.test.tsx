import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorer } from './useFileExplorer'
import { changeScopeStore } from '../store/changeScopeStore'
import { readFileBytes } from '../api/fileDownload'
import { clearPreviewCache } from '../api/previewCache'

vi.mock('../api/fileDownload', () => ({
  readFileBytes: vi.fn(),
  readFileFingerprint: vi.fn(async () => 'fingerprint'),
}))
vi.mock('../utils/fileChecksum', () => ({ fileChecksum: () => 'fingerprint' }))

const { listDirectory, getFileContent, getFileStatus, getSessionDiff, getLastTurnDiff, getVcsDiff } = vi.hoisted(
  () => ({
    listDirectory: vi.fn(),
    getFileContent: vi.fn(),
    getFileStatus: vi.fn(),
    getSessionDiff: vi.fn(),
    getLastTurnDiff: vi.fn(),
    getVcsDiff: vi.fn(),
  }),
)

vi.mock('../api', () => ({
  listDirectory,
  getFileContent,
  getFileStatus,
  getSessionDiff,
  getLastTurnDiff,
  getVcsDiff,
}))

describe('useFileExplorer change scope', () => {
  beforeEach(() => {
    changeScopeStore.clearAll()
    vi.clearAllMocks()
    getFileContent.mockReset()
    vi.mocked(readFileBytes).mockReset()
    clearPreviewCache()

    listDirectory.mockResolvedValue([
      { name: 'src', path: 'src', absolute: '/repo/src', type: 'directory', ignored: false },
      { name: 'session.ts', path: 'src/session.ts', absolute: '/repo/src/session.ts', type: 'file', ignored: false },
      { name: 'turn.ts', path: 'src/turn.ts', absolute: '/repo/src/turn.ts', type: 'file', ignored: false },
    ])
    getFileContent.mockResolvedValue({ type: 'text', content: 'test' })
    getFileStatus.mockResolvedValue([])
    getVcsDiff.mockResolvedValue([])
    getSessionDiff.mockResolvedValue([
      {
        file: 'src/session.ts',
        before: 'const session = 1',
        after: 'const session = 2',
        additions: 1,
        deletions: 1,
      },
    ])
    getLastTurnDiff.mockResolvedValue([
      {
        file: 'src/turn.ts',
        before: '',
        after: 'const turn = 1',
        additions: 1,
        deletions: 0,
      },
    ])
  })

  it('keeps a preview requested by the consuming component on its first effect', async () => {
    function PreviewConsumer() {
      const preview = useFileExplorer({ directory: '/repo', autoLoad: false })
      const { loadPreview } = preview
      useEffect(() => {
        void loadPreview('report.txt')
      }, [loadPreview])
      return <div>{preview.previewContent?.content || 'loading preview'}</div>
    }
    render(<PreviewConsumer />)
    await screen.findByText('test')
  })

  it('clears old tree and ignores a late preview when the project becomes unavailable', async () => {
    let resolvePreview!: (value: { type: 'text'; content: string }) => void
    getFileContent.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolvePreview = resolve
        }),
    )
    const { result, rerender } = renderHook(
      ({ directory }: { directory: string | undefined }) => useFileExplorer({ directory, autoLoad: true }),
      { initialProps: { directory: '/repo' as string | undefined } },
    )
    await waitFor(() => expect(result.current.tree.length).toBeGreaterThan(0))
    let request!: Promise<void>
    act(() => {
      request = result.current.loadPreview('old.txt')
    })
    await waitFor(() => expect(getFileContent).toHaveBeenCalled())
    rerender({ directory: undefined })
    expect(result.current.tree).toEqual([])
    await act(async () => {
      resolvePreview({ type: 'text', content: 'old project secret' })
      await request
    })
    expect(result.current.previewContent).toBeNull()
    expect(result.current.fileStatus.size).toBe(0)
  })

  it('updates file statuses when the shared change mode changes', async () => {
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: true, sessionId: 'session-1' }))

    await waitFor(() => {
      expect(result.current.fileStatus.get('src/turn.ts')?.status).toBe('added')
    })

    expect(getLastTurnDiff).toHaveBeenCalledWith('session-1', '/repo', undefined)

    act(() => {
      changeScopeStore.setMode('session-1', 'session')
    })

    await waitFor(() => {
      expect(result.current.fileStatus.get('src/session.ts')?.status).toBe('modified')
    })

    expect(result.current.fileStatus.get('src/turn.ts')).toBeUndefined()
    expect(getSessionDiff).toHaveBeenCalledWith('session-1', '/repo', undefined)
  })

  it('restores expanded folders per directory when switching projects', async () => {
    listDirectory.mockImplementation(async (parentPath: string, directory: string) => {
      if (parentPath === '') {
        return [{ name: 'src', path: 'src', absolute: `${directory}/src`, type: 'directory', ignored: false }]
      }

      if (parentPath === 'src') {
        return [
          {
            name: directory === '/repo-a' ? 'a.ts' : 'b.ts',
            path: `src/${directory === '/repo-a' ? 'a.ts' : 'b.ts'}`,
            absolute: `${directory}/src/${directory === '/repo-a' ? 'a.ts' : 'b.ts'}`,
            type: 'file',
            ignored: false,
          },
        ]
      }

      return []
    })

    const { result, rerender } = renderHook(({ directory }) => useFileExplorer({ directory, autoLoad: true }), {
      initialProps: { directory: '/repo-a' },
    })

    await waitFor(() => {
      expect(result.current.tree).toHaveLength(1)
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    await waitFor(() => {
      expect(result.current.expandedPaths.has('src')).toBe(true)
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts')
    })

    rerender({ directory: '/repo-b' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
      expect(result.current.tree[0]?.children?.[0]?.path).toBeUndefined()
      expect(result.current.expandedPaths.has('src')).toBe(false)
    })

    rerender({ directory: '/repo-a' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-a/src')
      expect(result.current.expandedPaths.has('src')).toBe(true)
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts')
    })
  })

  it('ignores stale child loads after switching directories', async () => {
    let resolveRepoAChildren: (
      nodes: Array<{ name: string; path: string; absolute: string; type: 'file'; ignored: boolean }>,
    ) => void

    listDirectory.mockImplementation((parentPath: string, directory: string) => {
      if (parentPath === '') {
        return Promise.resolve([
          { name: 'src', path: 'src', absolute: `${directory}/src`, type: 'directory', ignored: false },
        ])
      }

      if (parentPath === 'src' && directory === '/repo-a') {
        return new Promise(resolve => {
          resolveRepoAChildren = resolve
        })
      }

      if (parentPath === 'src' && directory === '/repo-b') {
        return Promise.resolve([
          { name: 'b.ts', path: 'src/b.ts', absolute: '/repo-b/src/b.ts', type: 'file', ignored: false },
        ])
      }

      return Promise.resolve([])
    })

    const { result, rerender } = renderHook(({ directory }) => useFileExplorer({ directory, autoLoad: true }), {
      initialProps: { directory: '/repo-a' },
    })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-a/src')
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    rerender({ directory: '/repo-b' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    await waitFor(() => {
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/b.ts')
    })

    await act(async () => {
      resolveRepoAChildren!([
        { name: 'a.ts', path: 'src/a.ts', absolute: '/repo-a/src/a.ts', type: 'file', ignored: false },
      ])
    })

    expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
    expect(result.current.tree[0]?.children?.map(child => child.path)).toEqual(['src/b.ts'])
  })

  it('loads PDF and Word preview bytes without using the lossy preview API', async () => {
    vi.mocked(readFileBytes).mockResolvedValue(new Uint8Array([0, 255, 42]))
    const { result } = renderHook(() =>
      useFileExplorer({ directory: '/repo-b', serverId: 'server-b', autoLoad: false }),
    )
    await act(async () => result.current.loadPreview('report.pdf'))
    expect(result.current.previewContent).toEqual({
      type: 'binary',
      content: 'AP8q',
      encoding: 'base64',
      mimeType: 'application/pdf',
    })
    await act(async () => result.current.loadPreview('report.docx'))
    expect(result.current.previewContent?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(getFileContent).not.toHaveBeenCalled()
    expect(readFileBytes).toHaveBeenLastCalledWith(
      'report.docx',
      '/repo-b',
      'server-b',
      expect.objectContaining({ maxBytes: 48 * 1024 * 1024 }),
    )
  })

  it('keeps identical directory paths on different servers in separate preview caches', async () => {
    getFileContent.mockImplementation(async (_path, _directory, serverId) => ({ type: 'text', content: serverId }))
    const { result, rerender } = renderHook(
      ({ serverId }) => useFileExplorer({ directory: '/repo', serverId, autoLoad: false }),
      { initialProps: { serverId: 'server-a' } },
    )
    await act(async () => result.current.loadPreview('notes.txt'))
    expect(result.current.previewContent?.content).toBe('server-a')
    rerender({ serverId: 'server-b' })
    await act(async () => result.current.loadPreview('notes.txt'))
    expect(result.current.previewContent?.content).toBe('server-b')
  })

  it('loads PNGs through the native API without creating a terminal and blocks oversized previews', async () => {
    getFileContent.mockResolvedValueOnce({
      type: 'text',
      content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4eoAAAAASUVORK5CYII=',
      encoding: 'base64',
      mimeType: 'image/png',
    })
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', serverId: 'server-b', autoLoad: false }))
    await act(async () => result.current.loadPreview('image.png'))
    expect(readFileBytes).not.toHaveBeenCalled()
    expect(result.current.previewContent?.mimeType).toBe('image/png')
    getFileContent.mockResolvedValueOnce({
      type: 'text',
      content: 'A'.repeat(65 * 1024 * 1024),
      encoding: 'base64',
      mimeType: 'image/png',
    })
    await act(async () => result.current.loadPreview('huge.png'))
    expect(result.current.previewContent).toBeNull()
    expect(result.current.previewError).toContain('preview limit')
  })

  it('rejects parent traversal without sending a file read request', async () => {
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', serverId: 'server-b', autoLoad: false }))
    await act(async () => result.current.loadPreview('../private/report.docx'))
    expect(getFileContent).not.toHaveBeenCalled()
    expect(readFileBytes).not.toHaveBeenCalled()
    expect(result.current.previewError).toContain('outside')
  })

  it('reloads document preview after editing instead of showing the cached version', async () => {
    vi.mocked(readFileBytes)
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockResolvedValueOnce(new Uint8Array([2]))
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', serverId: 'server-b', autoLoad: false }))
    await act(async () => result.current.loadPreview('report.docx'))
    await act(async () => result.current.loadPreview('report.docx'))
    expect(readFileBytes).toHaveBeenCalledOnce()
    await act(async () => result.current.loadPreview('report.docx', true))
    expect(readFileBytes).toHaveBeenCalledTimes(2)
    expect(result.current.previewContent?.content).toBe('Ag==')
  })
})
