import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useWorkspaceRoot } from './useWorkspaceRoot'
import { getPath } from '../api/client'

vi.mock('../api/client', () => ({ getPath: vi.fn() }))
vi.mock('../store/serverStore', () => ({
  serverStore: {
    subscribe: () => () => {},
    getActiveServerId: () => 'active-server',
    getServerBaseUrl: (id: string) => `http://${id}`,
  },
}))
describe('file server working directory', () => {
  it('pins the root to the file server and ignores late results after switching servers', async () => {
    let resolveA!: (value: Awaited<ReturnType<typeof getPath>>) => void
    vi.mocked(getPath).mockImplementation((id?: string) =>
      id === 'server-a'
        ? (new Promise(resolve => {
            resolveA = resolve
          }) as ReturnType<typeof getPath>)
        : Promise.resolve({ directory: '/server-b' } as Awaited<ReturnType<typeof getPath>>),
    )
    const { result, rerender } = renderHook(({ id }) => useWorkspaceRoot(id), { initialProps: { id: 'server-a' } })
    expect(result.current).toBeUndefined()
    rerender({ id: 'server-b' })
    await waitFor(() => expect(result.current).toBe('/server-b'))
    await act(async () =>
      resolveA({ directory: '/server-a', home: '/home', state: '/state', config: '/config', worktree: '/server-a' }),
    )
    expect(result.current).toBe('/server-b')
  })
})
