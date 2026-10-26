import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from './FileExplorer'
import type { DesktopPlatform } from '../utils/tauri'
import { layoutStore } from '../store/layoutStore'
import { readFileBytes } from '../api/fileDownload'
import { saveData } from '../utils/downloadUtils'
import { uploadProjectFile } from '../api/fileUpload'
import { FullscreenProvider } from '../contexts/FullscreenContext'
import { registerChatContextReceiver } from '../utils/chatContext'
import { paneLayoutStore } from '../store/paneLayoutStore'

const officeMount = vi.hoisted(() => vi.fn())
vi.mock('./OnlyOfficeEditor', () => ({
  OnlyOfficeEditor: ({ onPreview, mode }: { onPreview: () => void; mode: string }) => {
    officeMount(mode)
    return (
      <button type="button" onClick={onPreview}>
        Return to preview
      </button>
    )
  },
}))
vi.mock('./WordFilePreview', () => ({ WordFilePreview: () => <div>Local document preview</div> }))

vi.mock('../api/fileDownload', () => ({ readFileBytes: vi.fn() }))
vi.mock('../api/fileUpload', () => ({ uploadProjectFile: vi.fn() }))
vi.mock('../utils/downloadUtils', () => ({ saveData: vi.fn() }))
const boundary = vi.hoisted(() => ({ root: 'C:/repo' }))
vi.mock('../hooks/useWorkspaceRoot', () => ({ useWorkspaceRoot: () => boundary.root }))

const { useFileExplorerMock, isTauriMock, isTauriMobileMock, getDesktopPlatformMock, revealItemInDirMock } = vi.hoisted(
  () => ({
    useFileExplorerMock: vi.fn(),
    isTauriMock: vi.fn(() => true),
    isTauriMobileMock: vi.fn(() => false),
    getDesktopPlatformMock: vi.fn((): DesktopPlatform => 'windows'),
    revealItemInDirMock: vi.fn(async (_path: string | string[]) => {}),
  }),
)

vi.mock('../hooks', () => ({
  useFileExplorer: (options?: unknown) => useFileExplorerMock(options),
}))

vi.mock('../hooks/useVerticalSplitResize', () => ({
  useVerticalSplitResize: () => ({
    splitHeight: 200,
    isResizing: false,
    resetSplitHeight: vi.fn(),
    handleResizeStart: vi.fn(),
    handleTouchResizeStart: vi.fn(),
  }),
}))

vi.mock('../utils/tauri', () => ({
  extToMime: () => 'text/plain',
  isTauri: () => isTauriMock(),
  isTauriMobile: () => isTauriMobileMock(),
  getDesktopPlatform: () => getDesktopPlatformMock(),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (path: string | string[]) => revealItemInDirMock(path),
}))

vi.mock('../lib/internalDragCore', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/internalDragCore')>()),
  startInternalDrag: vi.fn(),
}))

describe('FileExplorer', () => {
  beforeEach(() => {
    boundary.root = 'C:/repo'
    officeMount.mockClear()
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(false)
    getDesktopPlatformMock.mockReturnValue('windows')
    revealItemInDirMock.mockClear()
    useFileExplorerMock.mockReturnValue({
      tree: [
        {
          name: 'app.ts',
          path: 'src/app.ts',
          absolute: 'C:/repo/src/app.ts',
          type: 'file',
          ignored: false,
        },
      ],
      isLoading: false,
      error: null,
      expandedPaths: new Set<string>(),
      toggleExpand: vi.fn(),
      expandPath: vi.fn(),
      refresh: vi.fn(),
      softRefresh: vi.fn(),
      previewContent: null,
      previewLoading: false,
      previewError: null,
      loadPreview: vi.fn(),
      clearPreview: vi.fn(),
      fileStatus: new Map(),
    })
  })

  it('reveals the selected file in the system explorer from the context menu', async () => {
    render(
      <FileExplorer panelTabId="files-1" directory="C:/repo" previewFile={null} previewFiles={[]} position="right" />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in File Explorer' }))

    await waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith('C:/repo/src/app.ts')
    })
  })

  it('hides the reveal action outside desktop Tauri', () => {
    isTauriMock.mockReturnValue(false)

    render(
      <FileExplorer panelTabId="files-1" directory="C:/repo" previewFile={null} previewFiles={[]} position="right" />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    expect(screen.queryByRole('button', { name: 'Reveal in File Explorer' })).not.toBeInTheDocument()
  })

  it('uses Finder wording on macOS', async () => {
    getDesktopPlatformMock.mockReturnValue('macos')

    render(
      <FileExplorer panelTabId="files-1" directory="C:/repo" previewFile={null} previewFiles={[]} position="right" />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    })

    await waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith('C:/repo/src/app.ts')
    })
  })

  it('opens a left-side file in the right panel with the selected project and server', () => {
    boundary.root = '/repo-b'
    const open = vi.spyOn(layoutStore, 'openFilePreview').mockReturnValue(true)
    render(
      <FileExplorer
        mode="tree"
        panelTabId="sidebar-files"
        directory="/repo-b"
        serverId="server-b"
        previewFile={null}
        previewFiles={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'app.ts' }))
    expect(open).toHaveBeenCalledWith(
      { path: 'src/app.ts', name: 'app.ts', directory: '/repo-b', serverId: 'server-b' },
      'right',
    )
    open.mockRestore()
  })

  it('provides browser context menu open and download actions', async () => {
    boundary.root = '/repo-b'
    isTauriMock.mockReturnValue(false)
    vi.mocked(readFileBytes).mockResolvedValue(new Uint8Array([0, 255]))
    render(
      <FileExplorer
        mode="tree"
        panelTabId="sidebar-files"
        directory="/repo-b"
        serverId="server-b"
        previewFile={null}
        previewFiles={[]}
      />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    expect(screen.getByRole('button', { name: 'Open in right panel' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saveData).toHaveBeenCalledWith(new Uint8Array([0, 255]), 'app.ts'))
    expect(readFileBytes).toHaveBeenCalledWith(
      'src/app.ts',
      '/repo-b',
      'server-b',
      expect.objectContaining({ onProgress: expect.any(Function) }),
    )
  })

  it('adds the selected file from the left menu to the focused chat as actual file context', async () => {
    boundary.root = '/repo-b'
    vi.mocked(readFileBytes).mockResolvedValue(new TextEncoder().encode('File content for model'))
    const receive = vi.fn(() => true)
    const cleanup = registerChatContextReceiver(paneLayoutStore.getFocusedPaneId()!, receive)
    try {
      render(
        <FileExplorer
          mode="tree"
          panelTabId="sidebar-files"
          directory="/repo-b"
          serverId="server-b"
          previewFile={null}
          previewFiles={[]}
        />,
      )
      fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add file to chat' }))
      await waitFor(() =>
        expect(receive).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: 'app.ts',
            content: expect.stringContaining('File content for model'),
          }),
          expect.anything(),
        ),
      )
      expect(readFileBytes).toHaveBeenCalledWith('src/app.ts', '/repo-b', 'server-b')
    } finally {
      cleanup()
    }
  })

  it('uploads selected files to the current project and refreshes the tree', async () => {
    boundary.root = '/repo-b'
    vi.mocked(uploadProjectFile).mockResolvedValue(undefined)
    const { container } = render(
      <FileExplorer
        mode="tree"
        panelTabId="sidebar-files"
        directory="/repo-b"
        serverId="server-b"
        previewFile={null}
        previewFiles={[]}
      />,
    )
    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await waitFor(() =>
      expect(uploadProjectFile).toHaveBeenCalledWith(
        file,
        '',
        '/repo-b',
        'server-b',
        expect.objectContaining({ onProgress: expect.any(Function) }),
      ),
    )
    expect(useFileExplorerMock.mock.results.at(-1)!.value.refresh).toHaveBeenCalled()
  })

  it('shows aggregate acknowledged progress for multiple uploads and resets correctly after a failure', async () => {
    boundary.root = '/repo-b'
    vi.mocked(uploadProjectFile).mockReset()
    let finishFirst!: () => void
    let rejectSecond!: (error: Error) => void
    vi.mocked(uploadProjectFile)
      .mockImplementationOnce((_file, _folder, _directory, _server, options) => {
        options?.onProgress?.({ loaded: 50, total: 100, phase: 'transferring' })
        return new Promise<void>(resolve => {
          finishFirst = resolve
        })
      })
      .mockImplementationOnce((_file, _folder, _directory, _server, options) => {
        options?.onProgress?.({ loaded: 50, total: 100, phase: 'transferring' })
        return new Promise<void>((_resolve, reject) => {
          rejectSecond = reject
        })
      })
      .mockResolvedValue(undefined)
    const { container } = render(
      <FileExplorer
        mode="tree"
        panelTabId="files"
        directory="/repo-b"
        serverId="server-b"
        previewFile={null}
        previewFiles={[]}
      />,
    )
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(['a'.repeat(100)], 'one.txt'), new File(['b'.repeat(100)], 'two.txt')] },
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    await act(async () => {
      finishFirst()
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75')
    await act(async () => {
      rejectSecond(new Error('Upload interrupted'))
    })
    expect(screen.getByText('Transfer failed')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75')
    fireEvent.change(input, { target: { files: [new File(['x'], 'retry.txt')] } })
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100'))
    expect(screen.getByText('Transfer complete')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows download byte progress before completion and marks interrupted downloads as failed', async () => {
    boundary.root = '/repo-b'
    let rejectDownload!: (error: Error) => void
    vi.mocked(readFileBytes).mockImplementationOnce((_path, _directory, _server, options) => {
      options?.onProgress?.({ loaded: 25, total: 100, phase: 'transferring' })
      return new Promise<Uint8Array>((_resolve, reject) => {
        rejectDownload = reject
      })
    })
    render(
      <FileExplorer
        mode="tree"
        panelTabId="files"
        directory="/repo-b"
        serverId="server-b"
        previewFile={null}
        previewFiles={[]}
      />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    await act(async () => {
      rejectDownload(new Error('Connection closed'))
    })
    expect(screen.getByText('Transfer failed')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '100')
  })

  it('opens Office directly without downloading the file into the browser first', async () => {
    boundary.root = '/repo'
    useFileExplorerMock.mockReturnValue({
      ...useFileExplorerMock(),
      previewContent: {
        type: 'binary',
        encoding: 'base64',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: 'UEs=',
      },
    })
    const file = { path: 'report.docx', name: 'report.docx' }
    const { rerender } = render(
      <FullscreenProvider>
        <FileExplorer
          mode="preview"
          panelTabId="files"
          directory="/repo"
          serverId="server-b"
          previewFile={file}
          previewFiles={[file]}
        />
      </FullscreenProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Return to preview' })).toBeInTheDocument()
    expect(officeMount).toHaveBeenLastCalledWith('view')
    expect(useFileExplorerMock.mock.results.at(-1)!.value.loadPreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByRole('button', { name: 'Return to preview' })).toBeInTheDocument()
    expect(officeMount).toHaveBeenLastCalledWith('edit')
    fireEvent.click(screen.getByRole('button', { name: 'Return to preview' }))
    expect(await screen.findByRole('button', { name: 'Return to preview' })).toBeInTheDocument()
    expect(officeMount).toHaveBeenLastCalledWith('view')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByRole('button', { name: 'Return to preview' })
    officeMount.mockClear()
    const next = { path: 'second.docx', name: 'second.docx' }
    rerender(
      <FullscreenProvider>
        <FileExplorer
          mode="preview"
          panelTabId="files"
          directory="/repo"
          serverId="server-b"
          previewFile={next}
          previewFiles={[file, next]}
        />
      </FullscreenProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Return to preview' })).toBeInTheDocument()
    expect(officeMount).toHaveBeenCalled()
    expect(screen.queryByText(/ONLYOFFICE/)).not.toBeInTheDocument()
  })

  it('does not browse or load an editor for an outside project or escaping file path', () => {
    boundary.root = '/repo'
    const { rerender } = render(
      <FileExplorer
        mode="preview"
        panelTabId="files"
        directory="/etc"
        serverId="server-b"
        previewFile={{ path: 'notes.md', name: 'notes.md' }}
        previewFiles={[]}
      />,
    )
    expect(
      screen.getByText("This project's directory is outside the selected server's working directory."),
    ).toBeInTheDocument()
    expect(useFileExplorerMock.mock.calls.at(-1)![0].directory).toBeUndefined()
    rerender(
      <FileExplorer
        mode="preview"
        panelTabId="files"
        directory="/repo"
        serverId="server-b"
        previewFile={{ path: '../outside.docx', name: 'outside.docx' }}
        previewFiles={[]}
      />,
    )
    expect(useFileExplorerMock.mock.calls.at(-1)![0].directory).toBeUndefined()
    expect(officeMount).not.toHaveBeenCalled()
  })

  it('expands ancestors and highlights the requested file in the left tree', async () => {
    boundary.root = '/repo'
    const expandPath = vi.fn()
    useFileExplorerMock.mockReturnValue({
      ...useFileExplorerMock(),
      expandPath,
      expandedPaths: new Set<string>(),
      tree: [
        {
          name: 'src',
          path: 'src',
          absolute: '/repo/src',
          type: 'directory',
          children: [
            {
              name: 'deep',
              path: 'src/deep',
              absolute: '/repo/src/deep',
              type: 'directory',
              children: [
                {
                  name: 'report.pdf',
                  path: 'src/deep/report.pdf',
                  absolute: '/repo/src/deep/report.pdf',
                  type: 'file',
                },
              ],
            },
          ],
        },
      ],
    })
    const view = render(
      <FileExplorer
        mode="tree"
        panelTabId="sidebar-files"
        directory="/repo"
        serverId="remote"
        previewFile={null}
        previewFiles={[]}
        revealFile={{ path: 'src/deep/report.pdf', name: 'report.pdf', directory: '/repo', serverId: 'remote' }}
        revealRevision={1}
      />,
    )
    expect(expandPath).toHaveBeenCalledWith('src')
    expect(screen.queryByRole('button', { name: 'report.pdf' })).not.toBeInTheDocument()
    const state = useFileExplorerMock.mock.results.at(-1)!.value
    useFileExplorerMock.mockReturnValue({ ...state, expandedPaths: new Set(['src']) })
    const props = {
      mode: 'tree' as const,
      panelTabId: 'sidebar-files',
      directory: '/repo',
      serverId: 'remote',
      previewFile: null,
      previewFiles: [],
      revealFile: { path: 'src/deep/report.pdf', name: 'report.pdf', directory: '/repo', serverId: 'remote' },
      revealRevision: 1,
    }
    view.rerender(<FileExplorer {...props} previewFiles={[]} />)
    expect(expandPath).toHaveBeenCalledWith('src/deep')
    useFileExplorerMock.mockReturnValue({ ...state, expandedPaths: new Set(['src', 'src/deep']) })
    view.rerender(<FileExplorer {...props} previewFiles={[]} />)
    expect(screen.getByRole('button', { name: 'report.pdf' })).toHaveAttribute('aria-current', 'true')
    expect(state.softRefresh).toHaveBeenCalledTimes(1)
  })

  it('downloads original bytes from the preview file server through the visible Download button', async () => {
    boundary.root = '/repo'
    vi.mocked(readFileBytes).mockResolvedValue(new Uint8Array([0, 255, 12]))
    vi.mocked(saveData).mockClear()
    useFileExplorerMock.mockReturnValue({
      ...useFileExplorerMock(),
      previewContent: {
        type: 'binary',
        encoding: 'base64',
        content: 'UEs=',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    })
    const file = { path: 'report.docx', name: 'report.docx' }
    render(
      <FullscreenProvider>
        <FileExplorer
          mode="preview"
          panelTabId="files"
          directory="/repo"
          serverId="remote"
          previewFile={file}
          previewFiles={[file]}
        />
      </FullscreenProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download report.docx' }))
    await waitFor(() =>
      expect(saveData).toHaveBeenCalledWith(new Uint8Array([0, 255, 12]), 'report.docx', expect.anything()),
    )
    expect(readFileBytes).toHaveBeenCalledWith(
      'report.docx',
      '/repo',
      'remote',
      expect.objectContaining({ onProgress: expect.any(Function) }),
    )
  })
})
