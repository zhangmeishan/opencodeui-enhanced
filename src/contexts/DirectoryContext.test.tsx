import { act, render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryProvider } from './DirectoryContext'
import { DirectoryContext } from './DirectoryContext.shared'

const state = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  focusedServerId: 'server-a',
  getPath: vi.fn(),
  getJSONFor: vi.fn(),
  setJSONFor: vi.fn(),
  setDirectory: vi.fn(),
  onServerChange: vi.fn(),
}))
vi.mock('../api', () => ({ getPath: (...args: unknown[]) => state.getPath(...args) }))
vi.mock('../hooks/useRouter', () => ({
  useRouter: () => ({ directory: state.directory, setDirectory: state.setDirectory }),
}))
vi.mock('../store/layoutStore', () => ({ layoutStore: {}, useLayoutStore: () => ({ sidebarExpanded: true }) }))
vi.mock('../store/serverStore', () => ({
  serverStore: { onServerChange: state.onServerChange, subscribe: () => () => {}, getActiveServerId: () => 'server-a' },
}))
vi.mock('../store/multiServerStore', () => ({
  multiServerStore: { getFocusedServerId: () => state.focusedServerId, isEnabled: () => true },
  useMultiServerStore: () => ({ enabled: true }),
}))
vi.mock('../utils/tauri', () => ({ isTauri: () => false }))
vi.mock('../utils', () => ({
  serverStorage: {
    getJSON: () => null,
    setJSON: () => {},
    getJSONFor: (...args: unknown[]) => state.getJSONFor(...args),
    setJSONFor: (...args: unknown[]) => state.setJSONFor(...args),
  },
  handleError: () => () => {},
  normalizeToForwardSlash: (value: string) => value,
  getDirectoryName: (path: string) => path.split('/').pop(),
  isSameDirectory: (a: string, b: string) => a === b,
}))

function Probe() {
  return <div>{useContext(DirectoryContext)?.currentDirectory || 'loading'}</div>
}
function ProjectsProbe() {
  const context = useContext(DirectoryContext)
  return <div>{context?.savedDirectories.map(item => item.path).join(',') || 'no saved projects'}</div>
}

describe('default project directory', () => {
  beforeEach(() => {
    state.directory = undefined
    state.focusedServerId = 'server-a'
    state.getPath.mockReset()
    state.getJSONFor.mockReset()
    state.setJSONFor.mockReset()
    state.setDirectory.mockReset()
    state.onServerChange.mockReset().mockReturnValue(() => {})
  })
  it('uses the OpenCode working directory when no project is selected', async () => {
    state.getPath.mockResolvedValue({ directory: '/opencode/workspace' })
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/opencode/workspace')).toBeInTheDocument())
  })
  it('keeps an explicitly selected project inside the root', async () => {
    state.directory = '/opencode/workspace/project'
    state.getPath.mockResolvedValue({ directory: '/opencode/workspace' })
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/opencode/workspace/project')).toBeInTheDocument())
  })
  it('falls back to the working directory for an outside URL project', async () => {
    state.directory = '/etc'
    state.getPath.mockResolvedValue({ directory: '/opencode/workspace' })
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/opencode/workspace')).toBeInTheDocument())
    expect(screen.queryByText('/etc')).not.toBeInTheDocument()
  })
  it('ignores a stale working directory response after changing servers', async () => {
    let resolveA!: (value: { directory: string }) => void
    state.getPath.mockImplementation((serverId: string) =>
      serverId === 'server-a'
        ? new Promise(done => {
            resolveA = done
          })
        : Promise.resolve({ directory: '/server-b' }),
    )
    const { rerender } = render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )
    state.focusedServerId = 'server-b'
    rerender(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/server-b')).toBeInTheDocument())
    await act(async () => resolveA({ directory: '/server-a' }))
    expect(screen.getByText('/server-b')).toBeInTheDocument()
  })

  it('does not display or persist server A projects into server B when both roots have the same path', async () => {
    state.getPath.mockResolvedValue({ directory: '/workspace' })
    state.getJSONFor.mockImplementation((key: string, serverId: string) =>
      key === 'opencode-saved-directories' ? [{ path: `/workspace/${serverId}`, name: serverId, addedAt: 1 }] : {},
    )
    const { rerender } = render(
      <DirectoryProvider>
        <ProjectsProbe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/workspace/server-a')).toBeInTheDocument())
    state.setJSONFor.mockClear()
    state.focusedServerId = 'server-b'
    rerender(
      <DirectoryProvider>
        <ProjectsProbe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/workspace/server-b')).toBeInTheDocument())
    expect(screen.queryByText('/workspace/server-a')).not.toBeInTheDocument()
    for (const [key, value, owner] of state.setJSONFor.mock.calls) {
      if (key === 'opencode-saved-directories' && owner === 'server-b')
        expect(value).toEqual([expect.objectContaining({ path: '/workspace/server-b' })])
    }
  })

  it('does not clear qiujing-thesis when another subscribed server reconnects or becomes active', async () => {
    state.directory = '/workspace/qiujing-thesis'
    state.getPath.mockResolvedValue({ directory: '/workspace' })
    let listener!: (id: string, reason: string) => void
    state.onServerChange.mockImplementation(callback => {
      listener = callback
      return () => {}
    })
    render(
      <DirectoryProvider>
        <Probe />
      </DirectoryProvider>,
    )
    await waitFor(() => expect(screen.getByText('/workspace/qiujing-thesis')).toBeInTheDocument())
    act(() => {
      listener('unrelated', 'server-runtime-updated')
      listener('unrelated', 'server-switch')
    })
    expect(state.getPath).toHaveBeenCalledTimes(1)
    expect(state.setDirectory).not.toHaveBeenCalled()
    expect(screen.getByText('/workspace/qiujing-thesis')).toBeInTheDocument()
  })
})
