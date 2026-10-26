import { createPtySession, getPtyConnectUrl, removePtySession } from './pty'
import { connectTauriPty } from './ptyBridge'
import { isWindowsPathMode } from '../utils/directoryUtils'
import { isTauri } from '../utils/tauri'
import { readFileAsDataUrl } from '../features/chat/input/inputUtils'
import i18n from '../i18n'
import { createProgressReporter, type ProgressCallback } from '../utils/transferProgress'

/** Upload into an existing project directory; existing files are never overwritten. */
export async function uploadProjectFile(
  file: File,
  folder: string,
  directory: string,
  serverId: string,
  options: { expectedHash?: string; onProgress?: ProgressCallback } = {},
): Promise<void> {
  if (!file.name || /[\\/\0\r\n]/.test(file.name) || file.name === '.' || file.name === '..')
    throw new Error(i18n.t('components:fileExplorer.invalidFilename'))
  if (file.size > 64 * 1024 * 1024) throw new Error(i18n.t('components:fileExplorer.uploadTooLarge'))
  const path = `./${folder ? `${folder.replace(/[/\\]+$/, '')}/` : ''}${file.name}`
  if (
    /[\0\r\n]/.test(folder) ||
    folder.startsWith('/') ||
    /^[a-z]:/i.test(folder) ||
    folder.split(/[\\/]/).includes('..')
  )
    throw new Error(i18n.t('components:fileExplorer.invalidFilename'))
  const report = createProgressReporter(options.onProgress)
  report({ loaded: 0, total: file.size, phase: 'preparing' })
  const data = (await readFileAsDataUrl(file)).split(',')[1] || ''
  const token = `OCUI_${crypto.randomUUID().replace(/-/g, '')}`
  const windows = isWindowsPathMode(serverId)
  const encodedPath = btoa(Array.from(new TextEncoder().encode(path), byte => String.fromCharCode(byte)).join(''))
  const expected = options.expectedHash
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid file checksum')
  const unixHash = `actual=$(sha256sum < "$1" 2>/dev/null || shasum -a 256 < "$1" 2>/dev/null); actual=\${actual%% *}; [ "$actual" = '${expected ?? ''}' ]`
  const windowsHash = `(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -eq '${expected ?? ''}'`
  const script = windows
    ? `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $tmp=$null; try { if (Test-Path -LiteralPath $p) { [Console]::WriteLine('${token}_EXISTS') } else { [Console]::WriteLine('${token}_READY'); $data=[Text.StringBuilder]::new(); $i=0; while (($line=[Console]::ReadLine()) -ne '${token}_END') { if ($null -eq $line) { throw 'closed' }; $null=$data.Append($line); $i++; [Console]::WriteLine('${token}_ACK_'+$i) }; $tmp=$p+'.${token}.tmp'; [IO.File]::WriteAllBytes($tmp,[Convert]::FromBase64String($data.ToString())); [IO.File]::Move($tmp,$p); [Console]::WriteLine('${token}_DONE') } } catch { [Console]::WriteLine('${token}_ERROR') } finally { if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp } }; $null=[Console]::ReadLine()`
    : `stty -echo; tmp=''; trap '[ -z "$tmp" ] || rm -f -- "$tmp" "$tmp.b64"' EXIT; trap 'exit 1' HUP TERM; if [ -e "$1" ] || [ -L "$1" ]; then printf '\\n${token}_EXISTS\\n'; else tmp=$(mktemp "$1.upload.XXXXXX") || { printf '\\n${token}_ERROR\\n'; exit 1; }; printf '\\n${token}_READY\\n'; i=0; complete=0; while IFS= read -r line; do if [ "$line" = '${token}_END' ]; then complete=1; break; fi; printf '%s\\n' "$line"; i=$((i+1)); printf '${token}_ACK_%s\\n' "$i" >&3; done 3>&1 > "$tmp.b64"; if [ "$complete" = 1 ] && (base64 -d < "$tmp.b64" > "$tmp" 2>/dev/null || base64 -D < "$tmp.b64" > "$tmp" 2>/dev/null) && ln "$tmp" "$1"; then printf '\\n${token}_DONE\\n'; else printf '\\n${token}_ERROR\\n'; fi; rm -f -- "$tmp.b64"; fi; read -r done`
  const saveScript = expected
    ? windows
      ? script
          .replace('if (Test-Path -LiteralPath $p)', `if (!(Test-Path -LiteralPath $p) -or !(${windowsHash}))`)
          .replace(
            '[IO.File]::Move($tmp,$p);',
            `if (!(${windowsHash})) { [Console]::WriteLine('${token}_EXISTS'); throw 'conflict' }; $backup=$p+'.${token}.bak'; [IO.File]::Replace($tmp,$p,$backup);`,
          )
      : script
          .replace('if [ -e "$1" ] || [ -L "$1" ];', `if [ ! -f "$1" ] || [ -L "$1" ] || ! ( ${unixHash} );`)
          .replace(
            '&& ln "$tmp" "$1"',
            `&& ( ${unixHash} ) && cp -p -- "$1" "$1.${token}.bak" && chmod "$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")" "$tmp" && mv -f -- "$tmp" "$1"`,
          )
          .replace(
            "stty -echo; tmp='';",
            `stty -echo; tmp=''; lock="$1.ocui-save-lock"; if ! mkdir -- "$lock"; then printf '\\n${token}_EXISTS\\n'; exit 1; fi;`,
          )
          .replace(`rm -f -- "$tmp" "$tmp.b64"' EXIT`, `rm -f -- "$tmp" "$tmp.b64"; rmdir -- "$lock"' EXIT`)
    : script
  const pty = await createPtySession(
    {
      command: windows ? 'powershell.exe' : 'sh',
      args: windows ? ['-NoProfile', '-NonInteractive', '-Command', saveScript] : ['-c', saveScript, 'upload', path],
      cwd: directory,
      title: 'File upload',
    },
    directory,
    serverId,
  )
  let close: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let tail = ''
      let settled = false
      let sent = false
      let offset = 0
      let sequence = 0
      let send: ((text: string) => void) | undefined
      let timer = setTimeout(() => finish(new Error(i18n.t('components:fileExplorer.uploadFailed'))), 120_000)
      function finish(error?: Error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else {
          report({ loaded: file.size, total: file.size, phase: 'completed' })
          resolve()
        }
      }
      function transmit() {
        if (sent || settled || !send || !tail.includes(`${token}_READY`)) return
        sent = true
        report({ loaded: 0, total: file.size, phase: 'transferring' })
        nextChunk()
      }
      function nextChunk() {
        if (settled || !send) return
        // Wait for acknowledgement so large uploads cannot overrun the PTY input buffer.
        if (offset < data.length) {
          sequence++
          const chunk = data.slice(offset, offset + 2048)
          offset += chunk.length
          send(`${chunk}\n`)
        } else {
          report({ loaded: file.size, total: file.size, phase: 'processing' })
          send(`${token}_END\n`)
        }
      }
      function onMessage(chunk: string) {
        if (settled) return
        clearTimeout(timer)
        timer = setTimeout(() => finish(new Error(i18n.t('components:fileExplorer.uploadFailed'))), 120_000)
        tail = (tail + chunk).slice(-4096)
        if (tail.includes(`${token}_EXISTS`))
          finish(
            new Error(i18n.t(expected ? 'components:fileExplorer.saveConflict' : 'components:fileExplorer.fileExists')),
          )
        else if (tail.includes(`${token}_ERROR`)) finish(new Error(i18n.t('components:fileExplorer.uploadFailed')))
        else if (tail.includes(`${token}_DONE`)) finish()
        else if (
          sent &&
          (tail.includes(`${token}_ACK_${sequence}\r\n`) || tail.includes(`${token}_ACK_${sequence}\n`))
        ) {
          tail = ''
          report({ loaded: Math.min(file.size, Math.floor((offset * 3) / 4)), total: file.size, phase: 'transferring' })
          nextChunk()
        } else transmit()
      }
      if (isTauri()) {
        void connectTauriPty({
          ptyId: pty.id,
          directory,
          serverId,
          onConnected: () => {},
          onMessage,
          onDisconnected: () => finish(new Error('Upload connection closed')),
          onError: message => finish(new Error(message)),
        })
          .then(connection => {
            close = connection.close
            send = connection.send
            if (settled) close()
            else transmit()
          })
          .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
      } else {
        try {
          const socket = new WebSocket(getPtyConnectUrl(pty.id, directory, undefined, serverId))
          close = () => socket.close()
          socket.onopen = () => {
            send = text => socket.send(text)
            transmit()
          }
          socket.onmessage = event => {
            if (typeof event.data === 'string') onMessage(event.data)
          }
          socket.onerror = () => finish(new Error('Upload connection failed'))
          socket.onclose = () => finish(new Error('Upload connection closed'))
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
