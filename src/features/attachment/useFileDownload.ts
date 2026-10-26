import { useCallback, useMemo, useRef, useState } from 'react'
import { useSessionNavigation } from '../../contexts/SessionNavigationContext'
import { splitSessionKey } from '../../utils/sessionKey'
import { serverStore } from '../../store/serverStore'
import { readFileBytes } from '../../api/fileDownload'
import { saveData } from '../../utils/downloadUtils'
import { getFileLinkPath } from '../../utils/fileLinks'
import type { Attachment } from './types'
import { readResponseBytes, type TransferProgress } from '../../utils/transferProgress'

export function canDownloadAttachment(attachment: Attachment): boolean {
  return (attachment.type === 'file' && !!attachment.url) || attachment.content !== undefined
}

export function useFileDownload() {
  const { currentSessionId, currentDirectory } = useSessionNavigation()
  const serverId = currentSessionId ? splitSessionKey(currentSessionId).serverId : serverStore.getActiveServerId()
  const pending = useRef(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [fileName, setFileName] = useState('')

  const download = useCallback(
    async (pathOrAttachment: string | Attachment) => {
      if (pending.current) return
      pending.current = true
      setIsDownloading(true)
      setError(false)
      let last: TransferProgress = { loaded: 0, phase: 'preparing' }
      const report = (value: TransferProgress) => {
        last = value
        setProgress(value)
      }
      report(last)
      try {
        const attachment = typeof pathOrAttachment === 'string' ? undefined : pathOrAttachment
        const url = typeof pathOrAttachment === 'string' ? pathOrAttachment : attachment?.url
        const path = getFileLinkPath(url)
        const fileName = (attachment?.displayName || path || 'attachment').split(/[\\/]/).pop() || 'attachment'
        setFileName(fileName)
        if (url && /^(?:data:|https?:\/\/)/i.test(url)) {
          const response = await fetch(url)
          if (!response.ok) throw new Error('File download failed')
          const bytes = await readResponseBytes(response, report)
          saveData(bytes, fileName, attachment?.mime || 'application/octet-stream')
          report({ loaded: bytes.length, total: bytes.length, phase: 'completed' })
        } else if (path) {
          const bytes = await readFileBytes(path, currentDirectory, serverId, { onProgress: report })
          saveData(bytes, fileName, attachment?.mime || 'application/octet-stream')
          report({ loaded: bytes.length, total: bytes.length, phase: 'completed' })
        } else if (attachment?.content !== undefined) {
          const bytes = new TextEncoder().encode(attachment.content)
          saveData(bytes, fileName, 'text/plain;charset=utf-8')
          report({ loaded: bytes.length, total: bytes.length, phase: 'completed' })
        } else {
          throw new Error('No file to download')
        }
      } catch (err) {
        console.warn('[FileDownload] Failed:', err)
        setError(true)
        report({ ...last, phase: 'failed' })
      } finally {
        pending.current = false
        setIsDownloading(false)
      }
    },
    [currentDirectory, serverId],
  )

  return useMemo(
    () => ({ download, isDownloading, error, progress, fileName }),
    [download, isDownloading, error, progress, fileName],
  )
}
