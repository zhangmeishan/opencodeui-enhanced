import { useEffect, useState, useSyncExternalStore } from 'react'
import { getPath } from '../api/client'
import { serverStore } from '../store/serverStore'

/** The boundary belongs to the file's server, which may differ from the focused chat. */
export function useWorkspaceRoot(serverId?: string): string | undefined {
  const endpoint = useSyncExternalStore(serverStore.subscribe.bind(serverStore), () => {
    const id = serverId ?? serverStore.getActiveServerId()
    return `${id}\0${serverStore.getServerBaseUrl(id)}`
  })
  const [result, setResult] = useState<{ endpoint: string; root: string } | null>(null)
  useEffect(() => {
    let disposed = false
    const id = serverId ?? serverStore.getActiveServerId()
    void getPath(id)
      .then(info => {
        if (!disposed) setResult({ endpoint, root: info.directory })
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [serverId, endpoint])
  return result?.endpoint === endpoint ? result.root : undefined
}
