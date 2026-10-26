import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession } from '../../../api'
import type { EventCallbacks } from '../../../types/api/event'
import { useRecentSessions } from './useRecentSessions'

const { getSessionsMock, subscribeMock, serverChangeMock } = vi.hoisted(() => ({
  getSessionsMock: vi.fn(),
  subscribeMock: vi.fn(),
  serverChangeMock: vi.fn(),
}))
vi.mock('../../../api', () => ({ getSessions: getSessionsMock, subscribeToServerEvents: subscribeMock }))
vi.mock('../../../store/serverStore', () => ({ serverStore: { onServerChange: serverChangeMock } }))

const session = (id: string, updated?: number, created = 0): ApiSession =>
  ({
    id,
    title: id,
    directory: '/workspace/demo',
    time: { updated, created },
  }) as ApiSession

describe('useRecentSessions', () => {
  let callbacks: Record<string, EventCallbacks>
  beforeEach(() => {
    callbacks = {}
    getSessionsMock.mockReset().mockResolvedValue([])
    subscribeMock.mockReset().mockImplementation((id: string, events: EventCallbacks) => {
      callbacks[id] = events
      return vi.fn()
    })
    serverChangeMock.mockReset().mockReturnValue(vi.fn())
  })

  it('loads all pages and sorts by update time with creation time as fallback', async () => {
    const data = Array.from({ length: 235 }, (_, index) => session(`chat-${index}`, index))
    data.push(session('created-only', undefined, 500))
    getSessionsMock.mockImplementation(({ limit }: { limit: number }) => Promise.resolve(data.slice(0, limit)))
    const { result } = renderHook(() => useRecentSessions(['local'], '', '/workspace/demo'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getSessionsMock.mock.calls.map(([params]) => params.limit)).toEqual([100, 200, 400])
    expect(getSessionsMock).toHaveBeenCalledWith({ directory: '/workspace/demo', roots: false, limit: 400 }, 'local')
    expect(result.current.sessions).toHaveLength(236)
    expect(result.current.sessions.slice(0, 3).map(entry => entry.session.id)).toEqual([
      'created-only',
      'chat-234',
      'chat-233',
    ])
  })

  it('merges servers chronologically without confusing identical IDs and searches all loaded chats', async () => {
    getSessionsMock.mockImplementation((_: unknown, serverId: string) =>
      Promise.resolve([session('same-id', serverId === 'local' ? 20 : 40), session(`${serverId}-old`, 1)]),
    )
    const { result, rerender } = renderHook(
      ({ search }) => useRecentSessions(['local', 'remote'], search, '/workspace/demo'),
      {
        initialProps: { search: '' },
      },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sessions.slice(0, 2).map(entry => entry.key)).toEqual(['remote::same-id', 'local::same-id'])
    rerender({ search: 'LOCAL-OLD' })
    expect(result.current.sessions.map(entry => entry.key)).toEqual(['local::local-old'])
    expect(getSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('preserves live updates, new children and deletions when an older request resolves', async () => {
    let resolve!: (sessions: ApiSession[]) => void
    getSessionsMock.mockImplementation(
      () =>
        new Promise<ApiSession[]>(done => {
          resolve = done
        }),
    )
    const { result } = renderHook(() => useRecentSessions(['local'], '', '/workspace/demo'))
    const updated = session('updated', 100)
    const child = { ...session('child', 200), parentID: 'updated' }
    act(() => {
      callbacks.local.onSessionUpdated?.(updated)
      callbacks.local.onSessionCreated?.(child)
      callbacks.local.onSessionDeleted?.('deleted')
    })
    await act(async () => {
      resolve([session('updated', 1), session('deleted', 2), session('old', 0)])
    })
    expect(result.current.sessions.map(entry => entry.session.id)).toEqual(['child', 'updated', 'old'])
    expect(getSessionsMock).toHaveBeenCalledTimes(1)
    act(() => callbacks.local.onSessionUpdated?.(session('old', 300)))
    expect(result.current.sessions[0].session.id).toBe('old')
    expect(getSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('ignores results from a removed server and unsubscribes on unmount', async () => {
    let resolveOld!: (sessions: ApiSession[]) => void
    const unsubscribe = vi.fn()
    subscribeMock.mockReturnValue(unsubscribe)
    getSessionsMock.mockImplementation((_: unknown, id: string) =>
      id === 'old'
        ? new Promise<ApiSession[]>(done => {
            resolveOld = done
          })
        : Promise.resolve([session('new-chat', 1)]),
    )
    const { result, rerender, unmount } = renderHook(({ ids }) => useRecentSessions(ids, '', '/workspace/demo'), {
      initialProps: { ids: ['old'] },
    })
    rerender({ ids: ['new'] })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => resolveOld([session('stale', 999)]))
    expect(result.current.sessions.map(entry => entry.key)).toEqual(['new::new-chat'])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('keeps successful servers visible on failure and supports retry', async () => {
    getSessionsMock.mockImplementation((_: unknown, id: string) =>
      id === 'offline' ? Promise.reject(new Error('offline')) : Promise.resolve([session('visible', 1)]),
    )
    const { result } = renderHook(() => useRecentSessions(['local', 'offline'], '', '/workspace/demo'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failedServerIds).toEqual(['offline'])
    expect(result.current.sessions.map(entry => entry.key)).toEqual(['local::visible'])
    getSessionsMock.mockResolvedValue([session('recovered', 2)])
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.failedServerIds).toEqual([])
    expect(result.current.sessions).toHaveLength(2)
  })

  it('restricts qiujing-thesis to its exact directory even when the API returns global project sessions', async () => {
    const directory = '/home/masonzms/qiujing-thesis'
    const own = { ...session('thesis', 10), directory }
    getSessionsMock.mockResolvedValue([
      own,
      { ...session('other-project', 100), directory: '/home/masonzms/opencodeui' },
      { ...session('similar-prefix', 99), directory: `${directory}-backup` },
      { ...session('nested-project', 98), directory: `${directory}/experiments` },
      { ...session('different-case', 97), directory: '/home/masonzms/Qiujing-thesis' },
      { ...session('different-user', 96), directory: '/home/other/qiujing-thesis' },
      { ...session('unknown-directory', 95), directory: undefined },
    ])
    const { result } = renderHook(() => useRecentSessions(['masonzms'], '', directory))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getSessionsMock).toHaveBeenCalledWith({ directory, roots: false, limit: 100 }, 'masonzms')
    expect(result.current.sessions.map(entry => entry.key)).toEqual(['masonzms::thesis'])
    act(() => {
      callbacks.masonzms.onSessionCreated?.({
        ...session('foreign-event', 1000),
        directory: '/home/masonzms/another-project',
      })
      callbacks.masonzms.onSessionUpdated?.({ ...own, title: 'Updated thesis' })
    })
    expect(result.current.sessions.map(entry => entry.session.title)).toEqual(['Updated thesis'])
    act(() => callbacks.masonzms.onSessionUpdated?.({ ...own, directory: '/another' }))
    expect(result.current.sessions).toEqual([])
  })

  it('hides the previous project immediately and ignores its late requests and event callbacks', async () => {
    const first = '/home/masonzms/another-project',
      second = '/home/masonzms/qiujing-thesis'
    let resolveRefresh!: (value: ApiSession[]) => void
    getSessionsMock.mockResolvedValueOnce([{ ...session('first', 1), directory: first }])
    const { result, rerender } = renderHook(({ directory }) => useRecentSessions(['masonzms'], '', directory), {
      initialProps: { directory: first },
    })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    const oldCallbacks = callbacks.masonzms
    getSessionsMock.mockImplementationOnce(
      () =>
        new Promise<ApiSession[]>(resolve => {
          resolveRefresh = resolve
        }),
    )
    act(() => result.current.refresh())
    getSessionsMock.mockResolvedValueOnce([{ ...session('thesis', 2), directory: second }])
    rerender({ directory: second })
    expect(result.current.sessions).toEqual([])
    await waitFor(() => expect(result.current.sessions.map(entry => entry.session.id)).toEqual(['thesis']))
    await act(async () => {
      oldCallbacks.onSessionCreated?.({ ...session('stale-event', 100), directory: first })
      resolveRefresh([{ ...session('stale-response', 101), directory: first }])
    })
    expect(result.current.sessions.map(entry => entry.session.id)).toEqual(['thesis'])
  })

  it('does not request global sessions while a project directory is unresolved', async () => {
    const { result } = renderHook(() => useRecentSessions(['masonzms'], '', undefined))
    expect(result.current.sessions).toEqual([])
    expect(getSessionsMock).not.toHaveBeenCalled()
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it('clears old endpoint data and ignores late snapshots when a server runtime changes', async () => {
    let onChange!: (id: string, reason: string) => void
    serverChangeMock.mockImplementation(listener => {
      onChange = listener
      return vi.fn()
    })
    getSessionsMock.mockResolvedValueOnce([session('old-endpoint', 1)])
    const { result } = renderHook(() => useRecentSessions(['local'], '', '/workspace/demo'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let resolveNew!: (sessions: ApiSession[]) => void
    getSessionsMock.mockImplementationOnce(
      () =>
        new Promise<ApiSession[]>(resolve => {
          resolveNew = resolve
        }),
    )
    act(() => onChange('local', 'server-runtime-updated'))
    expect(result.current.sessions).toEqual([])
    await act(async () => resolveNew([session('new-endpoint', 2)]))
    expect(result.current.sessions.map(entry => entry.session.id)).toEqual(['new-endpoint'])
    act(() => onChange('unrelated', 'server-runtime-updated'))
    expect(getSessionsMock).toHaveBeenCalledTimes(2)
  })
})
