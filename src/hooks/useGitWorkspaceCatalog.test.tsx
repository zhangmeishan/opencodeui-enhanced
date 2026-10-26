import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitWorkspaceCatalog } from './useGitWorkspaceCatalog'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const getCurrentProjectMock = vi.fn()
const listWorktreesMock = vi.fn()
const subscribeToEventsMock = vi.fn()
const onServerChangeMock = vi.fn()
let latestServerChange: ((id: string, reason: string) => void) | undefined

vi.mock('../api', () => ({
  getCurrentProject: (...args: unknown[]) => getCurrentProjectMock(...args),
  listWorktrees: (...args: unknown[]) => listWorktreesMock(...args),
}))

vi.mock('../api/events', () => ({
  subscribeToServerEvents: (...args: unknown[]) => subscribeToEventsMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    onServerChange: (...args: unknown[]) => onServerChangeMock(...args),
    getActiveServerId: () => 'local',
    subscribe: () => () => {},
  },
}))

describe('useGitWorkspaceCatalog', () => {
  beforeEach(() => {
    getCurrentProjectMock.mockReset()
    listWorktreesMock.mockReset()
    subscribeToEventsMock.mockReset()
    onServerChangeMock.mockReset()
    latestServerChange = undefined

    subscribeToEventsMock.mockReturnValue(vi.fn())
    onServerChangeMock.mockImplementation(listener => {
      latestServerChange = listener
      return vi.fn()
    })
    listWorktreesMock.mockResolvedValue(['C:/repo', 'C:/repo-worktree'])
  })

  it('refetches workspace metadata on server endpoint changes while stale requests are in flight', async () => {
    const staleRequest = createDeferred<{ vcs: string; worktree: string }>()
    const freshRequest = createDeferred<{ vcs: string; worktree: string }>()

    getCurrentProjectMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise)

    const directories = ['C:\\repo']
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories))

    await waitFor(() => expect(getCurrentProjectMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      latestServerChange?.('local', 'local-runtime-url')
      await Promise.resolve()
    })

    expect(getCurrentProjectMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve({ vcs: 'git', worktree: 'C:/repo' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
    })

    await act(async () => {
      staleRequest.resolve({ vcs: 'git', worktree: 'C:/stale' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.catalog.get('C:/repo')?.rootDirectory).toBe('C:/repo')
    expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
  })

  it('does not reuse another server metadata for an identical directory when the new lookup fails', async () => {
    const directories = ['/workspace/qiujing-thesis']
    getCurrentProjectMock.mockResolvedValueOnce({ vcs: 'git', worktree: '/workspace/root-a' })
    listWorktreesMock.mockResolvedValueOnce(['/workspace/root-a', '/workspace/qiujing-thesis'])
    const { result, rerender } = renderHook(({ serverId }) => useGitWorkspaceCatalog(directories, serverId), {
      initialProps: { serverId: 'server-a' },
    })
    await waitFor(() => expect(result.current.catalog.get(directories[0])?.rootDirectory).toBe('/workspace/root-a'))
    getCurrentProjectMock.mockRejectedValueOnce(new Error('server-b unavailable'))
    rerender({ serverId: 'server-b' })
    expect(result.current.catalog.size).toBe(0)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.catalog.size).toBe(0)
    expect(getCurrentProjectMock).toHaveBeenLastCalledWith('/workspace/qiujing-thesis', 'server-b')
    expect(subscribeToEventsMock).toHaveBeenLastCalledWith('server-b', expect.anything())
  })

  it('ignores unrelated server changes and keeps Linux worktrees differing only by case distinct', async () => {
    const directories = ['/workspace/qiujing-thesis']
    getCurrentProjectMock.mockResolvedValue({ vcs: 'git', worktree: '/workspace/qiujing-thesis' })
    listWorktreesMock.mockResolvedValue(['/workspace/qiujing-thesis', '/workspace/Qiujing-thesis'])
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories, 'masonzms'))
    await waitFor(() => expect(result.current.catalog.get(directories[0])?.workspaces).toHaveLength(2))
    act(() => latestServerChange?.('other-user', 'server-runtime-updated'))
    expect(getCurrentProjectMock).toHaveBeenCalledTimes(1)
    expect(result.current.catalog.size).toBe(1)
  })
})
