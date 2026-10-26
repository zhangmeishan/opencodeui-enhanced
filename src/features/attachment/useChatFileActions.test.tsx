import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { useChatFileActions } from './useChatFileActions'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  activate: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  sidebar: vi.fn(),
  download: vi.fn(),
}))
vi.mock('../../api/client', () => ({ getPath: mocks.getPath }))
vi.mock('../../store/layoutStore', () => ({
  layoutStore: { activateServerScope: mocks.activate, openFilePreview: mocks.open, setSidebarExpanded: mocks.sidebar },
}))
vi.mock('../../store/fileNavigationStore', () => ({ fileNavigationStore: { reveal: mocks.reveal } }))
vi.mock('./useFileDownload', () => ({
  useFileDownload: () => ({ download: mocks.download, isDownloading: false, error: false }),
}))
function Harness() {
  const { open, contextMenu, controls } = useChatFileActions()
  return (
    <>
      <button
        onClick={() => void open('output/report.pdf')}
        onContextMenu={event => contextMenu(event, 'output/report.pdf')}
      >
        report.pdf
      </button>
      {controls}
    </>
  )
}
describe('chat file actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPath.mockResolvedValue({ directory: '/workspace' })
    mocks.open.mockReturnValue(true)
  })
  const renderFile = () => {
    const focusPane = vi.fn()
    const value = {
      navigateToSession: vi.fn(),
      currentSessionId: 'remote::session',
      currentDirectory: '/workspace/project',
      focusPane,
    }
    return {
      ...render(
        <SessionNavigationContext.Provider value={value}>
          <Harness />
        </SessionNavigationContext.Provider>,
      ),
      value,
      focusPane,
    }
  }
  it('opens on the originating server, reveals the left tree and does not download on left click', async () => {
    const { focusPane } = renderFile()
    fireEvent.click(screen.getByText('report.pdf'))
    await waitFor(() => expect(mocks.reveal).toHaveBeenCalled())
    const file = { path: 'output/report.pdf', name: 'report.pdf', directory: '/workspace/project', serverId: 'remote' }
    expect(mocks.getPath).toHaveBeenCalledWith('remote')
    expect(focusPane).toHaveBeenCalledOnce()
    expect(mocks.activate).toHaveBeenCalledWith('remote')
    expect(mocks.open).toHaveBeenCalledWith(file, 'right')
    expect(mocks.reveal).toHaveBeenCalledWith(file, 'remote::session')
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it('downloads only when explicitly chosen from the context menu', () => {
    renderFile()
    fireEvent.contextMenu(screen.getByText('report.pdf'))
    expect(screen.getByRole('menuitem', { name: 'Open in right panel' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))
    expect(mocks.download).toHaveBeenCalledWith('output/report.pdf')
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('does not reveal or switch the left tree when the user cancels discarding dirty files', async () => {
    mocks.open.mockReturnValue(false)
    renderFile()
    fireEvent.click(screen.getByText('report.pdf'))
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    expect(mocks.reveal).not.toHaveBeenCalled()
    expect(mocks.sidebar).not.toHaveBeenCalled()
  })
  it('ignores a late path lookup after navigating to another session', async () => {
    let resolve!: (value: { directory: string }) => void
    mocks.getPath.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        }),
    )
    const { value, rerender } = renderFile()
    fireEvent.click(screen.getByText('report.pdf'))
    rerender(
      <SessionNavigationContext.Provider value={{ ...value, currentSessionId: 'other::session' }}>
        <Harness />
      </SessionNavigationContext.Provider>,
    )
    await act(async () => resolve({ directory: '/workspace' }))
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('reports path lookup failures and permits retry without downloading', async () => {
    mocks.getPath.mockRejectedValueOnce(new Error('offline'))
    renderFile()
    fireEvent.click(screen.getByText('report.pdf'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open this file')
    expect(mocks.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('report.pdf'))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mocks.download).not.toHaveBeenCalled()
  })
})
