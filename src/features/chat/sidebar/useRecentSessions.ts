import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSessions, subscribeToServerEvents, type ApiSession } from '../../../api'
import { serverStore } from '../../../store/serverStore'
import { makeSessionKey } from '../../../utils/sessionKey'
import { matchesSessionDirectory, sessionDirectoryKey } from '../../../utils/sessionScope'

export interface RecentSession {
  key: string
  serverId: string
  session: ApiSession
}
const EMPTY_SESSIONS: Record<string, ApiSession[]> = {}

export function useRecentSessions(serverIds: string[], search: string, directory: string | undefined) {
  const serverIdsKey = JSON.stringify(serverIds)
  const directoryKey = sessionDirectoryKey(directory)
  const scopeKey = JSON.stringify([serverIds, directoryKey])
  const [snapshot, setSnapshot] = useState<{ scope: string; byServer: Record<string, ApiSession[]> }>({
    scope: scopeKey,
    byServer: {},
  })
  const byServer = snapshot.scope === scopeKey ? snapshot.byServer : EMPTY_SESSIONS
  const [loading, setLoading] = useState(true)
  const [failedServerIds, setFailedServerIds] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const removeLocal = useCallback(
    (keys: Set<string>) => {
      setSnapshot(previous =>
        previous.scope !== scopeKey
          ? previous
          : {
              ...previous,
              byServer: Object.fromEntries(
                Object.entries(previous.byServer).map(([serverId, sessions]) => [
                  serverId,
                  sessions.filter(session => !keys.has(makeSessionKey(serverId, session.id))),
                ]),
              ),
            },
      )
    },
    [scopeKey],
  )

  useEffect(() => {
    const ids = JSON.parse(serverIdsKey) as string[]
    let cancelled = false
    const versions = new Map<string, number>()
    const changes = new Map<string, Map<string, ApiSession | null>>()
    const pendingServers = new Set<string>()
    const writeServer = (serverId: string, update: (sessions: ApiSession[]) => ApiSession[]) => {
      if (cancelled) return
      setSnapshot(previous => {
        if (cancelled) return previous
        const existing = previous.scope === scopeKey ? previous.byServer : {}
        return { scope: scopeKey, byServer: { ...existing, [serverId]: update(existing[serverId] ?? []) } }
      })
    }
    setFailedServerIds([])
    setLoading(ids.length > 0 && !!directoryKey)
    if (!directoryKey) return

    const fetchServer = async (serverId: string) => {
      if (cancelled) return
      const version = (versions.get(serverId) ?? 0) + 1
      versions.set(serverId, version)
      pendingServers.add(serverId)
      setLoading(true)
      const isCurrent = () => !cancelled && versions.get(serverId) === version
      try {
        // The API uses an increasing limit rather than an offset. Continue until
        // the response is shorter than the requested limit, including old chats.
        let limit = 100
        while (isCurrent()) {
          const data = await getSessions({ directory, roots: false, limit }, serverId)
          if (!isCurrent()) return
          const merged = new Map(data.map(session => [session.id, session]))
          changes.get(serverId)?.forEach((session, id) => {
            if (session) merged.set(id, session)
            else merged.delete(id)
          })
          writeServer(serverId, () =>
            [...merged.values()].filter(session => matchesSessionDirectory(session.directory, directory)),
          )
          if (data.length < limit) break
          limit *= 2
        }
        if (isCurrent()) setFailedServerIds(previous => previous.filter(id => id !== serverId))
      } catch {
        if (isCurrent()) {
          setFailedServerIds(previous => (previous.includes(serverId) ? previous : [...previous, serverId]))
        }
      } finally {
        if (isCurrent()) {
          pendingServers.delete(serverId)
          setLoading(pendingServers.size > 0)
        }
      }
    }

    const unsubscribes = ids.map(serverId => {
      const upsert = (session: ApiSession) => {
        if (cancelled) return
        // Overlay live events on in-flight snapshots without fetching again on
        // every streaming update.
        const journal = changes.get(serverId) ?? new Map<string, ApiSession | null>()
        journal.set(session.id, session)
        changes.set(serverId, journal)
        writeServer(serverId, previous =>
          [session, ...previous.filter(item => item.id !== session.id)].filter(item =>
            matchesSessionDirectory(item.directory, directory),
          ),
        )
      }
      return subscribeToServerEvents(serverId, {
        onSessionCreated: upsert,
        onSessionUpdated: upsert,
        onSessionDeleted: sessionId => {
          if (cancelled) return
          const journal = changes.get(serverId) ?? new Map<string, ApiSession | null>()
          journal.set(sessionId, null)
          changes.set(serverId, journal)
          writeServer(serverId, previous => previous.filter(session => session.id !== sessionId))
        },
        onReconnected: () => {
          if (cancelled) return
          changes.delete(serverId)
          void fetchServer(serverId)
        },
      })
    })
    unsubscribes.push(
      serverStore.onServerChange((serverId, reason) => {
        if (cancelled) return
        if (reason !== 'server-switch' && ids.includes(serverId)) {
          changes.delete(serverId)
          writeServer(serverId, () => [])
          void fetchServer(serverId)
        }
      }),
    )
    void Promise.all(ids.map(fetchServer))
    return () => {
      cancelled = true
      unsubscribes.forEach(unsubscribe => unsubscribe())
    }
  }, [serverIdsKey, revision, scopeKey, directory, directoryKey])

  const allSessions = useMemo(() => {
    const ids = JSON.parse(serverIdsKey) as string[]
    return ids
      .flatMap(serverId =>
        (byServer[serverId] ?? [])
          .filter(session => matchesSessionDirectory(session.directory, directory))
          .map(session => ({
            key: makeSessionKey(serverId, session.id),
            serverId,
            session,
          })),
      )
      .sort((a, b) => {
        const difference =
          (b.session.time?.updated ?? b.session.time?.created ?? 0) -
          (a.session.time?.updated ?? a.session.time?.created ?? 0)
        return difference || a.key.localeCompare(b.key)
      })
  }, [byServer, serverIdsKey, directory])
  const sessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return allSessions.filter(
      ({ session }) =>
        !query || `${session.title ?? ''}\n${session.directory ?? ''}`.toLocaleLowerCase().includes(query),
    )
  }, [allSessions, search])

  return { sessions, allSessions, loading, failedServerIds, refresh, removeLocal }
}
