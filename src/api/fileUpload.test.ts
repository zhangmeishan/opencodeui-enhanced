// @vitest-environment node
/// <reference types="node" />
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadProjectFile } from './fileUpload'
import { createPtySession, removePtySession } from './pty'
import { fileChecksum, saveProjectFile } from './fileSave'
import { readFileFingerprint } from './fileDownload'
import type { TransferProgress } from '../utils/transferProgress'

const runtime = vi.hoisted(() => ({ child: null as ChildProcessWithoutNullStreams | null, output: '', error: '' }))
vi.mock('./pty', () => ({
  createPtySession: vi.fn(),
  removePtySession: vi.fn(),
  getPtyConnectUrl: () => 'ws://test/upload',
}))
vi.mock('./ptyBridge', () => ({ connectTauriPty: vi.fn() }))
vi.mock('../utils/directoryUtils', () => ({ isWindowsPathMode: () => false }))
vi.mock('../utils/tauri', () => ({ isTauri: () => false }))
vi.mock('../features/chat/input/inputUtils', () => ({
  readFileAsDataUrl: async (file: File) =>
    `data:application/octet-stream;base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`,
}))

class LocalSocket {
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor() {
    const child = runtime.child!
    child.stdout.on('data', chunk => {
      this.onmessage?.({ data: chunk.toString() })
    })
    queueMicrotask(() => {
      this.onopen?.()
      if (runtime.output) this.onmessage?.({ data: runtime.output })
    })
  }
  send(text: string) {
    runtime.child!.stdin.write(text)
  }
  close() {
    runtime.child!.stdin.end('\n')
  }
}

describe('project uploads using an isolated local shell', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(resolve('scripts/.upload-test-'))
    runtime.output = ''
    runtime.error = ''
    vi.stubGlobal('WebSocket', LocalSocket)
    vi.mocked(createPtySession).mockImplementation(async params => {
      const child = spawn(params.command!, params.args!, { cwd: directory })
      runtime.child = child
      child.stdout.on('data', chunk => {
        runtime.output += chunk.toString()
      })
      child.stderr.on('data', chunk => {
        runtime.error += chunk.toString()
      })
      return {
        id: 'upload',
        title: 'Upload',
        command: 'sh',
        args: [],
        cwd: directory,
        status: 'running',
        pid: child.pid!,
      }
    })
    vi.mocked(removePtySession).mockImplementation(async () => {
      const child = runtime.child
      if (child && child.exitCode === null) {
        await new Promise<void>(done => {
          child.once('exit', () => done())
          if (!child.stdin.writableEnded) child.stdin.end('\n')
        })
      }
      return true
    })
    vi.clearAllMocks()
  })
  afterEach(async () => {
    runtime.child?.kill()
    await rm(directory, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('uploads binary bytes through acknowledged chunks and leaves no temporary files', async () => {
    const bytes = Uint8Array.from({ length: 128 * 1024 + 7 }, (_, i) => i % 256)
    const updates: TransferProgress[] = []
    await uploadProjectFile(new File([bytes], '报告.pdf'), '', directory, 'server-b', {
      onProgress: progress => updates.push(progress),
    })
    expect(updates[0]).toEqual({ loaded: 0, total: bytes.length, phase: 'preparing' })
    expect(updates.some(progress => progress.phase === 'transferring')).toBe(true)
    expect(updates.some(progress => progress.phase === 'processing')).toBe(true)
    expect(updates.at(-1)).toEqual({ loaded: bytes.length, total: bytes.length, phase: 'completed' })
    expect(
      updates.every(
        (progress, index) =>
          progress.loaded <= bytes.length && (index === 0 || progress.loaded >= updates[index - 1].loaded),
      ),
    ).toBe(true)
    expect(new Uint8Array(await readFile(`${directory}/报告.pdf`))).toEqual(bytes)
    expect(await readdir(directory)).toEqual(['报告.pdf'])
    expect(createPtySession).toHaveBeenCalledWith(expect.anything(), directory, 'server-b')
    expect(removePtySession).toHaveBeenCalledWith('upload', directory, 'server-b')
  }, 15_000)

  it('verifies fingerprints using the actual isolated shell for ordinary, empty and special-character files', async () => {
    const name = "hash ' $(unexpected).txt"
    for (const text of ['original', 'modified', '']) {
      runtime.output = ''
      await writeFile(resolve(directory, name), text)
      expect(await readFileFingerprint(name, directory, 'server-b')).toBe(fileChecksum(new TextEncoder().encode(text)))
    }
    expect((await readdir(directory)).sort()).toEqual([name])
  })

  it('preserves existing files and rejects the duplicate', async () => {
    await writeFile(`${directory}/report.txt`, 'original')
    const progress = vi.fn()
    await expect(
      uploadProjectFile(new File(['replacement'], 'report.txt'), '', directory, 'server-b', { onProgress: progress }),
    ).rejects.toThrow(/already exists/)
    expect(progress.mock.calls.some(([value]) => value.phase === 'completed')).toBe(false)
    expect(await readFile(`${directory}/report.txt`, 'utf8')).toBe('original')
    expect(await readdir(directory)).toEqual(['report.txt'])
  })

  it('treats special characters in filenames as data and supports empty files', async () => {
    const name = "quote' $(touch unexpected);`test`.txt"
    await uploadProjectFile(new File([], name), '', directory, 'server-b')
    expect(await readFile(`${directory}/${name}`, 'utf8')).toBe('')
    expect(await readdir(directory)).toEqual([name])
  })

  it('rejects path traversal before creating a terminal', async () => {
    await expect(
      uploadProjectFile(new File(['data'], 'report.pdf'), '../outside', directory, 'server-b'),
    ).rejects.toThrow()
    expect(createPtySession).not.toHaveBeenCalled()
  })

  it('saves changed files with a checksum guard, atomic replacement and original backup', async () => {
    const original = new TextEncoder().encode('  original\r\n\r\n')
    await writeFile(`${directory}/notes.txt`, original, { mode: 0o640 })
    const updated = new TextEncoder().encode('  修改\r\n\r\n')
    await saveProjectFile('notes.txt', updated, fileChecksum(original), directory, 'server-b')
    expect(new Uint8Array(await readFile(`${directory}/notes.txt`))).toEqual(updated)
    const names = await readdir(directory)
    const backup = names.find(name => name.endsWith('.bak'))!
    expect(new Uint8Array(await readFile(`${directory}/${backup}`))).toEqual(original)
    expect(names).toHaveLength(2)
  })

  it('rejects saving over an externally modified file and keeps the latest file intact', async () => {
    const original = new TextEncoder().encode('original')
    await writeFile(`${directory}/notes.txt`, 'changed externally')
    await expect(
      saveProjectFile('notes.txt', new TextEncoder().encode('my edit'), fileChecksum(original), directory, 'server-b'),
    ).rejects.toThrow(/changed|being saved/)
    expect(await readFile(`${directory}/notes.txt`, 'utf8')).toBe('changed externally')
    expect(await readdir(directory)).toEqual(['notes.txt'])
  })
})
