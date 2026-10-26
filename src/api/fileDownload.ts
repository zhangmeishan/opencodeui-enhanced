import { createPtySession, getPtyConnectUrl, removePtySession } from './pty'
import { connectTauriPty } from './ptyBridge'
import { isWindowsPathMode } from '../utils/directoryUtils'
import { isTauri } from '../utils/tauri'
import { createProgressReporter, type ProgressCallback } from '../utils/transferProgress'
import i18n from '../i18n'

const MAX_ENCODED_LENGTH = 128 * 1024 * 1024

/** Read original bytes: /file/content is a preview API and omits binary documents. */
export async function readFileBytes(
  path: string,
  directory: string | undefined,
  serverId: string,
  options: { signal?: AbortSignal; maxBytes?: number; onProgress?: ProgressCallback; fingerprintOnly?: boolean } = {},
): Promise<Uint8Array> {
  if (!path || path.includes('\0')) throw new Error('Invalid file path')
  options.signal?.throwIfAborted()
  const report = createProgressReporter(options.onProgress)
  report({ loaded: 0, phase: 'preparing' })
  const token = crypto.randomUUID().replace(/-/g, '')
  const start = `OCUI_${token}_START`
  const end = `OCUI_${token}_END`
  const fail = `OCUI_${token}_ERROR`
  const sizeMarker = `OCUI_${token}_SIZE_`
  // The path is an argument, never shell source. Wait for the connection before producing output.
  const windows = isWindowsPathMode(serverId)
  const encodedPath = btoa(Array.from(new TextEncoder().encode(path), byte => String.fromCharCode(byte)).join(''))
  let script = windows
    ? `$null = [Console]::ReadLine(); try { $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $b = [IO.File]::ReadAllBytes($p); [Console]::WriteLine('${sizeMarker}'+$b.Length); [Console]::WriteLine('${start}'); [Console]::WriteLine([Convert]::ToBase64String($b)); [Console]::WriteLine('${end}') } catch { [Console]::WriteLine('${fail}') }; $null = [Console]::ReadLine()`
    : `read -r ready; if [ -f "$1" ] && [ -r "$1" ]; then size=$(wc -c < "$1") || exit 1; printf '\\n${sizeMarker}%s\\n${start}\\n' "$size"; if base64 < "$1"; then printf '\\n${end}\\n'; else printf '\\n${fail}\\n'; fi; else printf '\\n${fail}\\n'; fi; read -r done`
  if (options.fingerprintOnly) {
    script = windows
      ? `$null=[Console]::ReadLine(); try { $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $hash=(Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower(); [Console]::WriteLine('${start}'); [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($hash))); [Console]::WriteLine('${end}') } catch { [Console]::WriteLine('${fail}') }; $null=[Console]::ReadLine()`
      : `read -r ready; if [ -f "$1" ] && [ -r "$1" ]; then hash=$(sha256sum < "$1" 2>/dev/null || shasum -a 256 < "$1" 2>/dev/null); hash=\${hash%% *}; if [ "\${#hash}" = 64 ]; then printf '\\n${start}\\n'; printf '%s' "$hash" | base64; printf '\\n${end}\\n'; else printf '\\n${fail}\\n'; fi; else printf '\\n${fail}\\n'; fi; read -r done`
  }
  const pty = await createPtySession(
    {
      command: windows ? 'powershell.exe' : 'sh',
      args: windows ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script, 'download', path],
      cwd: directory,
      title: 'File download',
    },
    directory,
    serverId,
  )
  let close: (() => void) | undefined
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let tail = ''
      let started = false
      let received = 0
      let total: number | undefined
      let encodedLength = 0
      let padding = 0
      const chunks: string[] = []
      const markerLength = Math.max(start.length, end.length, fail.length, sizeMarker.length + 32)
      function appendPayload(payload: string) {
        chunks.push(payload)
        const compact = payload.replace(/\s/g, '')
        encodedLength += compact.length
        padding += (compact.match(/=/g) || []).length
        const loaded = Math.max(0, Math.floor((encodedLength * 3) / 4) - padding)
        report({ loaded: total === undefined ? loaded : Math.min(total, loaded), total, phase: 'transferring' })
      }
      let settled = false
      let decoding = false
      const timer = setTimeout(() => finish(new Error('File download timed out')), 60_000)
      function finish(error?: Error, bytes?: Uint8Array) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else {
          report({ loaded: bytes!.length, total: bytes!.length, phase: 'completed' })
          resolve(bytes!)
        }
      }
      function abort() {
        finish(new DOMException('File read cancelled', 'AbortError'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) return abort()
      function onMessage(chunk: string) {
        if (settled || decoding) return
        received += chunk.length
        if (received > Math.min(MAX_ENCODED_LENGTH, (options.maxBytes ?? 96 * 1024 * 1024) * 1.38 + 2048))
          return finish(new Error(i18n.t('components:fileExplorer.previewTooLarge')))
        tail += chunk
        if (tail.includes(fail)) return finish(new Error('Could not read file'))
        if (!started) {
          const match = tail.match(new RegExp(`${sizeMarker}\\s*(\\d+)\\r?\\n`))
          if (match) {
            const size = Number(match[1])
            if (!Number.isSafeInteger(size) || size > (options.maxBytes ?? 96 * 1024 * 1024))
              return finish(new Error(i18n.t('components:fileExplorer.previewTooLarge')))
            total = size
          }
          const begin = tail.indexOf(start)
          if (begin < 0) {
            tail = tail.slice(-markerLength)
            return
          }
          started = true
          tail = tail.slice(begin + start.length)
        }
        const stop = tail.indexOf(end)
        if (stop < 0) {
          // Keep only the possible marker prefix; don't repeatedly scan the full file.
          if (tail.length > markerLength) {
            appendPayload(tail.slice(0, -markerLength))
            tail = tail.slice(-markerLength)
          }
          return
        }
        try {
          appendPayload(tail.slice(0, stop))
          const encoded = chunks.join('').replace(/\s/g, '')
          decoding = true
          report({ loaded: Math.max(0, Math.floor((encodedLength * 3) / 4) - padding), total, phase: 'processing' })
          void (async () => {
            const bytes = new Uint8Array(Math.floor(encoded.length / 4) * 3)
            let offset = 0
            for (let index = 0; index < encoded.length; index += 256 * 1024) {
              if (settled) return
              const binary = atob(encoded.slice(index, index + 256 * 1024))
              for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i)
              if (encoded.length > 256 * 1024) await new Promise(resolve => setTimeout(resolve, 0))
            }
            if (offset > (options.maxBytes ?? 96 * 1024 * 1024))
              throw new Error(i18n.t('components:fileExplorer.previewTooLarge'))
            if (total !== undefined && offset !== total) throw new Error('File size changed or download is incomplete')
            finish(undefined, bytes.subarray(0, offset))
          })().catch(() => finish(new Error('Invalid file download data')))
        } catch {
          finish(new Error('Invalid file download data'))
        }
      }
      if (isTauri()) {
        let send: ((data: string) => void) | undefined
        let connected = false
        void connectTauriPty({
          ptyId: pty.id,
          directory,
          serverId,
          onConnected: () => {
            connected = true
            send?.('\n')
          },
          onMessage,
          onDisconnected: () => finish(new Error('File download connection closed')),
          onError: message => finish(new Error(message)),
        })
          .then(connection => {
            close = connection.close
            send = connection.send
            if (settled) connection.close()
            else if (connected) connection.send('\n')
          })
          .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
      } else {
        try {
          const socket = new WebSocket(getPtyConnectUrl(pty.id, directory, undefined, serverId))
          close = () => socket.close()
          socket.onopen = () => socket.send('\n')
          socket.onmessage = event => {
            // PTY cursor metadata is a binary frame, file output is UTF-8 text.
            if (typeof event.data === 'string') onMessage(event.data)
          }
          socket.onerror = () => finish(new Error('File download connection failed'))
          socket.onclose = () => finish(new Error('File download connection closed'))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
  } finally {
    close?.()
    await removePtySession(pty.id, directory, serverId).catch(() => {})
  }
}

export async function readFileFingerprint(
  path: string,
  directory: string,
  serverId: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readFileBytes(path, directory, serverId, { fingerprintOnly: true, maxBytes: 1024, signal })
  const hash = new TextDecoder().decode(bytes)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(i18n.t('components:fileExplorer.previewFreshnessFailed'))
  return hash
}
