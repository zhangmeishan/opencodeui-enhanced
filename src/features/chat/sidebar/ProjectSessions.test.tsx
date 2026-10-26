import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession } from '../../../api'
import type { EventCallbacks } from '../../../types/api/event'
import { SidePanel } from './SidePanel'

const fixture = vi.hoisted(() => ({
  directory: '/home/masonzms/qiujing-thesis',
  serverId: 'masonzms',
  getSessions: vi.fn(),
  events: new Map<string, EventCallbacks>(),
}))
const root = '/home/masonzms'
const catalog = new Map()
const saved = [
  { path: '/home/masonzms/qiujing-thesis', addedAt: 1 },
  { path: '/home/masonzms/other-project', addedAt: 2 },
]
const servers = [
  { id: 'masonzms', name: 'masonzms' },
  { id: 'other-user', name: 'Other user' },
]
vi.mock('../../../hooks', () => ({
  useDirectory: () => ({
    currentDirectory: fixture.directory,
    savedDirectories: saved,
    recentProjects: {},
    pathInfo: { directory: root },
    setCurrentDirectory: vi.fn(),
    removeDirectory: vi.fn(),
  }),
  useKeybindingLabel: () => '',
  useGitWorkspaceCatalog: () => ({ catalog }),
  useVcsInfo: () => ({ vcsInfo: null, isLoading: false }),
}))
vi.mock('../../../hooks/useInputCapabilities', () => ({ useInputCapabilities: () => ({ preferTouchUi: false }) }))
vi.mock('../../../contexts/useSessionContext', () => ({
  useSessionContext: () => ({ search: '', setSearch: vi.fn() }),
}))
vi.mock('../../../store/multiServerStore', () => ({
  useMultiServerStore: () => ({
    enabled: true,
    subscribedServerIds: servers.map(server => server.id),
    focusedServerId: fixture.serverId,
  }),
  multiServerStore: { getFocusedServerId: () => fixture.serverId },
}))
vi.mock('../../../hooks/useServerStore', () => ({ useServerStore: () => ({ activeServer: servers[0], servers }) }))
vi.mock('../../../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => 'masonzms', onServerChange: () => () => {} },
}))
vi.mock('../../../store/pinnedSessionsStore', () => ({ pinnedSessionsStore: { update: vi.fn(), unpin: vi.fn() } }))
vi.mock('../../../utils/serverWorkspaces', () => ({ readServerWorkspaces: () => saved.map(item => item.path) }))
vi.mock('../../../utils/perServerStorage', () => ({
  subscribePerServerStorageVersion: () => () => {},
  getStorageVersion: () => 0,
}))
vi.mock('../../../utils/sessionLifecycle', () => ({ clearSessionRuntimeState: vi.fn() }))
vi.mock('../../../api', () => ({
  getSessions: fixture.getSessions,
  subscribeToConnectionState: () => () => {},
  subscribeToServerEvents: (id: string, callbacks: EventCallbacks) => {
    fixture.events.set(id, callbacks)
    return () => fixture.events.delete(id)
  },
  deleteSession: vi.fn(),
  updateSession: vi.fn(),
}))
vi.mock('../../../components/FileExplorer', () => ({ FileExplorer: () => <div>File tree</div> }))
vi.mock('./SidebarFooter', () => ({ SidebarFooter: () => null }))
vi.mock('../../../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('../../sessions/SessionList', () => ({
  SessionListItem: ({ session, onSelect }: { session: ApiSession; onSelect: () => void }) => (
    <button onClick={onSelect}>{session.title}</button>
  ),
}))

function session(id: string, directory: string): ApiSession {
  return {
    id,
    title: id,
    directory,
    projectID: 'shared-global-project',
    time: { created: 1, updated: 2 },
  } as ApiSession
}

describe('selected project → scoped request → session list', () => {
  beforeEach(() => {
    fixture.directory = `${root}/qiujing-thesis`
    fixture.serverId = 'masonzms'
    fixture.events.clear()
    fixture.getSessions.mockReset()
  })

  it('isolates qiujing-thesis from other projects and users even when the backend shares a global project ID', async () => {
    fixture.getSessions.mockResolvedValue([
      session('Thesis discussion', `${root}/qiujing-thesis`),
      session('Unrelated discussion', `${root}/other-project`),
      session('Backup discussion', `${root}/qiujing-thesis-backup`),
    ])
    const onSelectSession = vi.fn()
    const props = {
      onNewSession: vi.fn(),
      onSelectSession,
      selectedSessionId: null,
      onAddProject: vi.fn(),
      onToggleSidebar: vi.fn(),
    }
    const { rerender } = render(<SidePanel {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Thesis discussion' }))
    expect(onSelectSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'Thesis discussion', directory: `${root}/qiujing-thesis`, serverId: 'masonzms' }),
    )
    expect(fixture.getSessions).toHaveBeenCalledWith(
      { directory: `${root}/qiujing-thesis`, roots: false, limit: 100 },
      'masonzms',
    )
    expect(fixture.getSessions.mock.calls.every(([, serverId]) => serverId === 'masonzms')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Unrelated discussion' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Backup discussion' })).not.toBeInTheDocument()
    act(() =>
      fixture.events.get('masonzms')?.onSessionCreated?.(session('Foreign live event', `${root}/other-project`)),
    )
    expect(screen.queryByRole('button', { name: 'Foreign live event' })).not.toBeInTheDocument()

    fixture.directory = `${root}/other-project`
    rerender(<SidePanel {...props} />)
    expect(screen.queryByRole('button', { name: 'Thesis discussion' })).not.toBeInTheDocument()
    await screen.findByRole('button', { name: 'Unrelated discussion' })
    expect(fixture.getSessions).toHaveBeenLastCalledWith(
      { directory: `${root}/other-project`, roots: false, limit: 100 },
      'masonzms',
    )

    fixture.getSessions.mockResolvedValue([session('Other server discussion', fixture.directory)])
    fixture.serverId = 'other-user'
    rerender(<SidePanel {...props} />)
    expect(screen.queryByRole('button', { name: 'Unrelated discussion' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Other server discussion' })).toBeInTheDocument())
    expect(fixture.getSessions).toHaveBeenLastCalledWith(
      { directory: fixture.directory, roots: false, limit: 100 },
      'other-user',
    )
  })
})
