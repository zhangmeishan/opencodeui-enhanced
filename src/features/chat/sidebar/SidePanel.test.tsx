import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidePanel } from './SidePanel'
import { fileNavigationStore } from '../../../store/fileNavigationStore'

const { state, setSearchMock, setDirectoryMock } = vi.hoisted(() => ({
  state: {
    search: '',
    multi: false,
    subscribed: ['local'],
    focusedServerId: 'local',
    currentDirectory: '/workspace/project',
  },
  setSearchMock: vi.fn(),
  setDirectoryMock: vi.fn(),
}))
const servers = [
  { id: 'local', name: 'Local' },
  { id: 'remote', name: 'Remote' },
]
const emptyCatalog = new Map()
vi.mock('../../../hooks', () => ({
  useDirectory: () => ({
    currentDirectory: state.currentDirectory,
    savedDirectories: [{ path: '/workspace/project', addedAt: 1 }],
    recentProjects: {},
    pathInfo: { directory: '/workspace' },
    setCurrentDirectory: setDirectoryMock,
    removeDirectory: vi.fn(),
  }),
  useKeybindingLabel: () => 'Ctrl+N',
  useGitWorkspaceCatalog: () => ({ catalog: emptyCatalog }),
  useVcsInfo: () => ({ vcsInfo: { branch: 'main' }, isLoading: false }),
}))
vi.mock('../../../contexts/useSessionContext', () => ({
  useSessionContext: () => ({ search: state.search, setSearch: setSearchMock }),
}))
vi.mock('../../../store/multiServerStore', () => ({
  useMultiServerStore: () => ({
    enabled: state.multi,
    subscribedServerIds: state.subscribed,
    focusedServerId: state.focusedServerId,
  }),
  multiServerStore: { getFocusedServerId: () => state.focusedServerId },
}))
vi.mock('../../../hooks/useServerStore', () => ({ useServerStore: () => ({ activeServer: servers[0], servers }) }))
vi.mock('../../../utils/serverWorkspaces', () => ({ readServerWorkspaces: () => ['/workspace/project'] }))
vi.mock('../../../utils/perServerStorage', () => ({
  subscribePerServerStorageVersion: () => () => {},
  getStorageVersion: () => 0,
}))
vi.mock('../../../api', () => ({ subscribeToConnectionState: () => () => {} }))
vi.mock('../../../components/FileExplorer', () => ({
  FileExplorer: ({ directory, revealFile }: { directory: string; revealFile?: { path: string } }) => (
    <div>
      Files: {directory}
      {revealFile && <span>Reveal: {revealFile.path}</span>}
    </div>
  ),
}))
vi.mock('./SidebarFooter', () => ({ SidebarFooter: () => <div>Footer</div> }))
vi.mock('../../../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('./RecentSessionList', () => ({
  RecentSessionList: ({ serverIds, directory }: { serverIds: string[]; directory: string }) => (
    <div data-testid="recents" data-directory={directory}>
      {serverIds.join(',')}
    </div>
  ),
}))

describe('SidePanel navigation', () => {
  beforeEach(() => {
    state.search = ''
    state.multi = false
    state.focusedServerId = 'local'
    state.subscribed = ['local']
    state.currentDirectory = '/workspace/project'
    vi.clearAllMocks()
  })
  const props = () => ({
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    selectedSessionId: null,
    onAddProject: vi.fn(),
    onToggleSidebar: vi.fn(),
  })

  it('shows only Files and Recents and preserves switching back to the current file tree', async () => {
    render(<SidePanel {...props()} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Files', 'Sessions'])
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    await screen.findByText('Files: /workspace/project')
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    expect(screen.getByTestId('recents')).toHaveTextContent('local')
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    await screen.findByText('Files: /workspace/project')
  })

  it('opens sessions in the selected project on the focused server without mixing other subscribed servers', () => {
    state.multi = true
    state.focusedServerId = 'remote'
    state.subscribed = ['remote', 'local', 'unknown']
    render(<SidePanel {...props()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old chat' } })
    expect(setSearchMock).toHaveBeenCalledWith('old chat')
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('recents')).toHaveTextContent(/^remote$/)
    expect(screen.getByTestId('recents')).toHaveAttribute('data-directory', '/workspace/project')
  })

  it('allows opening the project selector and focusing search from the collapsed sidebar', async () => {
    const callbacks = props()
    const { rerender } = render(<SidePanel {...callbacks} isExpanded={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'project · main' }))
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce()
    rerender(<SidePanel {...callbacks} isExpanded />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'project · main', expanded: true })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTitle('/workspace'))
    expect(setDirectoryMock).toHaveBeenCalledWith('/workspace')
    rerender(<SidePanel {...callbacks} isExpanded={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search chats...' }))
    rerender(<SidePanel {...callbacks} isExpanded />)
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
  })

  it('switches to Files for the originating session and locates a sibling-project file without changing the chat directory', async () => {
    render(<SidePanel {...props()} selectedSessionId="local::chat" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    act(() =>
      fileNavigationStore.reveal(
        { path: 'shared/report.pdf', name: 'report.pdf', directory: '/workspace', serverId: 'local' },
        'local::chat',
      ),
    )
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await screen.findByText('Reveal: shared/report.pdf')
    expect(setDirectoryMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    expect(screen.getByTestId('recents')).toHaveAttribute('data-directory', '/workspace/project')
    act(() =>
      fileNavigationStore.reveal(
        { path: 'shared/report.pdf', name: 'report.pdf', directory: '/workspace', serverId: 'remote' },
        'remote::other',
      ),
    )
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true')
  })
})
