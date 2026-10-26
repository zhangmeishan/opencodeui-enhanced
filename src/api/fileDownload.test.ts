import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileBytes, readFileFingerprint } from './fileDownload'
import { createPtySession, getPtyConnectUrl, removePtySession } from './pty'
import { connectTauriPty } from './ptyBridge'

const platform = vi.hoisted(() => ({ windows: false, tauri: false }))
vi.mock('./pty', () => ({
  createPtySession: vi.fn(async () => ({ id: 'pty-download' })),
  getPtyConnectUrl: vi.fn(() => 'ws://server-b/pty/download'),
  removePtySession: vi.fn(async () => true),
}))
vi.mock('./ptyBridge', () => ({ connectTauriPty: vi.fn() }))
vi.mock('../utils/directoryUtils', () => ({ isWindowsPathMode: () => platform.windows }))
vi.mock('../utils/tauri', () => ({ isTauri: () => platform.tauri }))

class DownloadSocket {
  static current: DownloadSocket
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onclose?: () => void
  send = vi.fn()
  close = vi.fn()
  constructor() {
    DownloadSocket.current = this
  }
}

async function openDownload(
  path = '结果/report.pdf',
  onProgress?: import('../utils/transferProgress').ProgressCallback,
) {
  const promise = readFileBytes(path, '/workspace/b', 'server-b', { onProgress })
  await vi.waitFor(() => expect(getPtyConnectUrl).toHaveBeenCalled())
  const socket = DownloadSocket.current
  const params = vi.mocked(createPtySession).mock.calls[0][0]
  const script = params.args!.join(' ')
  const start = script.match(/OCUI_\w+_START/)![0]
  const end = script.match(/OCUI_\w+_END/)![0]
  return { promise, socket, params, start, end }
}

describe('original file download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platform.windows = false
    platform.tauri = false
    vi.stubGlobal('WebSocket', DownloadSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('preserves binary bytes across split frames and pins all requests to the pane server', async () => {
    const { promise, socket, start, end } = await openDownload()
    socket.onopen?.()
    expect(socket.send).toHaveBeenCalledWith('\n')
    const bytes = Uint8Array.from([0, 255, 128, 13, 10, 1])
    const base64 = btoa(String.fromCharCode(...bytes))
    socket.onmessage?.({ data: new ArrayBuffer(10) })
    socket.onmessage?.({ data: `\r\n${start.slice(0, 8)}` })
    socket.onmessage?.({ data: `${start.slice(8)}\r\n${base64.slice(0, 4)}\r\n` })
    socket.onmessage?.({ data: `${base64.slice(4)}\r\n${end}\r\n` })
    expect(await promise).toEqual(bytes)
    expect(createPtySession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace/b' }),
      '/workspace/b',
      'server-b',
    )
    expect(getPtyConnectUrl).toHaveBeenCalledWith('pty-download', '/workspace/b', undefined, 'server-b')
    expect(removePtySession).toHaveBeenCalledWith('pty-download', '/workspace/b', 'server-b')
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('tracks decoded-byte progress from split size metadata and finishes at the exact file size', async () => {
    const progress = vi.fn()
    const { promise, socket, start, end } = await openDownload('report.pdf', progress)
    const bytes = new Uint8Array(600).fill(42)
    const encoded = btoa(String.fromCharCode(...bytes))
    const header = `${start.replace('_START', '_SIZE_')}600\r\n`
    socket.onmessage?.({ data: header.slice(0, 20) })
    socket.onmessage?.({ data: `${header.slice(20)}${start}\r\n${encoded.slice(0, 400)}` })
    expect(
      progress.mock.calls.some(
        ([value]) => value.phase === 'transferring' && value.loaded > 0 && value.loaded < 600 && value.total === 600,
      ),
    ).toBe(true)
    socket.onmessage?.({ data: `${encoded.slice(400)}\r\n${end}\r\n` })
    expect(await promise).toEqual(bytes)
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({ loaded: 600, total: 600, phase: 'completed' })
  })

  it('does not report success when the declared size differs from the actual data', async () => {
    const progress = vi.fn()
    const { promise, socket, start, end } = await openDownload('report.pdf', progress)
    socket.onmessage?.({ data: `${start.replace('_START', '_SIZE_')}100\n${start}\nAA==\n${end}\n` })
    await expect(promise).rejects.toThrow()
    expect(progress.mock.calls.some(([value]) => value.phase === 'completed')).toBe(false)
  })

  it('passes special characters as an argument without interpolating the file path into shell code', async () => {
    const path = "./中文 ' $(touch unexpected);`name`.pdf"
    const { promise, socket, start, end, params } = await openDownload(path)
    expect(params.args!.slice(-1)).toEqual([path])
    expect(params.args![1]).not.toContain(path)
    socket.onmessage?.({ data: `${start}\n${end}` })
    expect(await promise).toEqual(new Uint8Array())
  })
  it('reads only a SHA-256 fingerprint for freshness checks, with the path kept as an argument', async () => {
    const path = "./报告 ' $(unexpected).pdf"
    const promise = readFileFingerprint(path, '/workspace/b', 'server-b')
    await vi.waitFor(() => expect(getPtyConnectUrl).toHaveBeenCalled())
    const args = vi.mocked(createPtySession).mock.calls[0][0].args!
    expect(args.at(-1)).toBe(path)
    expect(args[1]).toContain('sha256sum')
    expect(args[1]).not.toContain(path)
    const start = args[1].match(/OCUI_\w+_START/)![0],
      end = args[1].match(/OCUI_\w+_END/)![0]
    DownloadSocket.current.onmessage?.({ data: `${start}\n${btoa('a'.repeat(64))}\n${end}` })
    expect(await promise).toBe('a'.repeat(64))
  })

  it('rejects read errors and cleans up the temporary terminal', async () => {
    const { promise, socket, start } = await openDownload()
    socket.onmessage?.({ data: start.replace('_START', '_ERROR') })
    await expect(promise).rejects.toThrow('Could not read file')
    expect(removePtySession).toHaveBeenCalledOnce()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('rejects incomplete downloads on disconnect instead of saving truncated bytes', async () => {
    const { promise, socket, start } = await openDownload()
    socket.onmessage?.({ data: `${start}\nAA==` })
    socket.onclose?.()
    await expect(promise).rejects.toThrow('connection closed')
    expect(removePtySession).toHaveBeenCalledOnce()
  })

  it('rejects malformed file bytes rather than saving corrupted content', async () => {
    const { promise, socket, start, end } = await openDownload()
    socket.onmessage?.({ data: `${start}\n!invalid binary!\n${end}` })
    await expect(promise).rejects.toThrow('Invalid file download data')
    expect(removePtySession).toHaveBeenCalledOnce()
  })

  it('cancels pending reads and cleans up the temporary connection', async () => {
    const controller = new AbortController()
    const promise = readFileBytes('image.png', '/workspace/b', 'server-b', { signal: controller.signal })
    await vi.waitFor(() => expect(getPtyConnectUrl).toHaveBeenCalled())
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(removePtySession).toHaveBeenCalledOnce()
  })

  it('encodes Windows file paths as data instead of interpolating shell syntax', async () => {
    platform.windows = true
    const path = "C:\\output\\报告 ' $(unexpected).docx"
    const { promise, socket, start, end, params } = await openDownload(path)
    expect(params.command).toBe('powershell.exe')
    expect(params.args!.join(' ')).not.toContain(path)
    socket.onmessage?.({ data: `${start}\nAP8=\n${end}` })
    expect(await promise).toEqual(new Uint8Array([0, 255]))
  })

  it('times out and removes an unresponsive terminal', async () => {
    const { promise, socket } = await openDownload()
    vi.useFakeTimers()
    // Start another request so its deadline is controlled by fake timers.
    socket.onerror?.()
    await expect(promise).rejects.toThrow()
    const timeoutPromise = readFileBytes('report.pdf', '/workspace/b', 'server-b')
    const assertion = expect(timeoutPromise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(60_001)
    await assertion
    expect(removePtySession).toHaveBeenCalledTimes(2)
  })

  it('supports the Tauri bridge even when connected arrives before the connection promise resolves', async () => {
    platform.tauri = true
    const send = vi.fn()
    const close = vi.fn()
    vi.mocked(connectTauriPty).mockImplementation(async options => {
      options.onConnected()
      return { send, close }
    })
    const promise = readFileBytes('report.pdf', '/workspace/b', 'server-b')
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('\n'))
    const options = vi.mocked(connectTauriPty).mock.calls[0][0]
    const script = vi.mocked(createPtySession).mock.calls[0][0].args!.join(' ')
    options.onMessage(`${script.match(/OCUI_\w+_START/)![0]}\nAP8=\n${script.match(/OCUI_\w+_END/)![0]}`)
    expect(await promise).toEqual(new Uint8Array([0, 255]))
    expect(options.serverId).toBe('server-b')
    expect(close).toHaveBeenCalledOnce()
  })
})
