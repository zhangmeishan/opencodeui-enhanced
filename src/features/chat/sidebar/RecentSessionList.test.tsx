import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession } from '../../../api'
import type { RecentSession } from './useRecentSessions'
import { RecentSessionList } from './RecentSessionList'

const { entries, deleteMock, renameMock, refreshMock, clearMock, errorMock } = vi.hoisted(() => ({
  entries: [] as RecentSession[],
  deleteMock: vi.fn(),
  renameMock: vi.fn(),
  refreshMock: vi.fn(),
  clearMock: vi.fn(),
  errorMock: vi.fn(),
}))
vi.mock('./useRecentSessions', () => ({
  useRecentSessions: (_: string[], search: string) => ({
    sessions: entries.filter(entry => entry.session.title.includes(search)),
    allSessions: entries,
    loading: false,
    failedServerIds: [],
    refresh: refreshMock,
    removeLocal: vi.fn(),
  }),
}))
vi.mock('../../../api', () => ({ deleteSession: deleteMock, updateSession: renameMock }))
vi.mock('../../../utils/sessionLifecycle', () => ({ clearSessionRuntimeState: clearMock }))
vi.mock('../../../utils', () => ({ uiErrorHandler: errorMock }))
vi.mock('../../../hooks/useInputCapabilities', () => ({ useInputCapabilities: () => ({ preferTouchUi: false }) }))
vi.mock('../../../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => 'local', onServerChange: () => () => {} },
}))
vi.mock('../../../store/pinnedSessionsStore', () => ({ pinnedSessionsStore: { update: vi.fn(), unpin: vi.fn() } }))
vi.mock('../../sessions/SessionList', () => ({
  SessionListItem: (props: {
    session: ApiSession
    activeSessionKey: string
    isSelected: boolean
    isChecked: boolean
    isEditMode: boolean
    onSelect: () => void
    onDelete: () => void
    onRename: (title: string) => void
    onToggleCheck: (options: { shiftKey: boolean }) => void
  }) => (
    <div data-testid={props.activeSessionKey} aria-selected={props.isSelected}>
      <button
        onClick={event => (props.isEditMode ? props.onToggleCheck({ shiftKey: event.shiftKey }) : props.onSelect())}
        aria-pressed={props.isChecked}
      >
        {props.session.title}
      </button>
      <button onClick={props.onDelete}>Delete</button>
      <button onClick={() => props.onRename('New title')}>Rename</button>
    </div>
  ),
}))
vi.mock('../../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm }: { isOpen: boolean; onConfirm: () => void }) =>
    isOpen ? <button onClick={onConfirm}>Confirm delete</button> : null,
}))

describe('RecentSessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteMock.mockResolvedValue(true)
    renameMock.mockResolvedValue({})
    entries.splice(
      0,
      entries.length,
      ...['local', 'remote'].map(serverId => ({
        key: `${serverId}::same`,
        serverId,
        session: {
          id: 'same',
          title: `${serverId} chat`,
          directory: `/${serverId}/project`,
          time: { created: 1, updated: 2 },
        } as ApiSession,
      })),
    )
  })

  const renderList = (selectedSessionId = 'remote::same') => {
    const props = {
      serverIds: ['local', 'remote'],
      directory: '/project',
      search: '',
      selectedSessionId,
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
    }
    return { ...render(<RecentSessionList {...props} />), props }
  }

  it('uses a scrollable region and selects and highlights the correct server', () => {
    const { props } = renderList()
    expect(screen.getByRole('region')).toHaveClass('overflow-y-auto', 'min-h-0')
    expect(screen.getByTestId('local::same')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('remote::same')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'remote chat' }))
    expect(props.onSelectSession).toHaveBeenCalledWith({ ...entries[1].session, serverId: 'remote' })
  })

  it('renames a chat using its own directory and server', async () => {
    renderList()
    fireEvent.click(within(screen.getByTestId('remote::same')).getByText('Rename'))
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
    expect(renameMock).toHaveBeenCalledWith('same', { title: 'New title' }, '/remote/project', 'remote')
  })

  it('deletes the selected chat on its server and clears the matching runtime state', async () => {
    const { props } = renderList()
    fireEvent.click(within(screen.getByTestId('remote::same')).getByText('Delete'))
    expect(deleteMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Confirm delete'))
    await waitFor(() => expect(props.onNewSession).toHaveBeenCalledOnce())
    expect(deleteMock).toHaveBeenCalledWith('same', '/remote/project', 'remote')
    expect(clearMock).toHaveBeenCalledWith('remote::same')
  })

  it('retains the current chat when deletion fails', async () => {
    deleteMock.mockRejectedValueOnce(new Error('failed'))
    const { props } = renderList()
    fireEvent.click(within(screen.getByTestId('remote::same')).getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm delete'))
    await waitFor(() => expect(errorMock).toHaveBeenCalled())
    expect(props.onNewSession).not.toHaveBeenCalled()
    expect(clearMock).not.toHaveBeenCalled()
  })

  it('supports selecting and deleting chats across servers', async () => {
    renderList()
    fireEvent.click(screen.getByRole('button', { name: /manage/i }))
    fireEvent.click(screen.getByRole('button', { name: 'local chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'remote chat' }))
    const deleteSelected = screen.getByRole('button', { name: /delete.*2/i })
    fireEvent.click(deleteSelected)
    fireEvent.click(screen.getByText('Confirm delete'))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2))
    expect(deleteMock).toHaveBeenCalledWith('same', '/local/project', 'local')
    expect(deleteMock).toHaveBeenCalledWith('same', '/remote/project', 'remote')
  })

  it('deletes selected chats that become hidden by a search filter', async () => {
    const { props, rerender } = renderList()
    fireEvent.click(screen.getByRole('button', { name: /manage/i }))
    fireEvent.click(screen.getByRole('button', { name: 'local chat' }))
    rerender(<RecentSessionList {...props} search="remote" />)
    expect(screen.queryByRole('button', { name: 'local chat' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /delete.*1/i }))
    fireEvent.click(screen.getByText('Confirm delete'))
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('same', '/local/project', 'local'))
    expect(props.onNewSession).not.toHaveBeenCalled()
  })

  it('does not clear a newly selected session when deletion of the previous session completes late', async () => {
    let complete!: () => void
    deleteMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          complete = resolve
        }),
    )
    const { props, rerender } = renderList()
    fireEvent.click(within(screen.getByTestId('remote::same')).getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm delete'))
    rerender(<RecentSessionList {...props} selectedSessionId="local::same" />)
    complete()
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
    expect(props.onNewSession).not.toHaveBeenCalled()
  })

  it('does not navigate or refresh an unmounted project after a delayed delete completes', async () => {
    let complete!: () => void
    deleteMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          complete = resolve
        }),
    )
    const { props, unmount } = renderList()
    fireEvent.click(within(screen.getByTestId('remote::same')).getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm delete'))
    unmount()
    complete()
    await waitFor(() => expect(clearMock).toHaveBeenCalled())
    expect(props.onNewSession).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })
})
