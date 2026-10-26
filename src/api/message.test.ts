import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractUserMessageContent, sendMessageAsync } from './message'
import { selectionAttachment } from '../utils/chatContext'

const { promptAsync, getSDKClient } = vi.hoisted(() => ({ promptAsync: vi.fn(), getSDKClient: vi.fn() }))
vi.mock('./sdk', () => ({
  getSDKClient,
  unwrap: (result: { error?: unknown }) => {
    if (result.error) throw result.error
  },
}))
vi.mock('../utils/directoryUtils', () => ({ formatPathForApi: (path?: string) => path }))
vi.mock('../store/serverStore', () => ({ serverStore: { getActiveServerId: () => 'server-a' } }))

const params = {
  sessionId: 'server-b::session-1',
  text: 'review report',
  directory: '/workspace/b',
  attachments: [
    {
      id: 'pdf',
      type: 'file' as const,
      displayName: '报告.pdf',
      mime: 'application/pdf',
      url: 'data:application/pdf;base64,AA==',
    },
  ],
  model: { providerID: 'provider', modelID: 'model' },
}

describe('message submission', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    getSDKClient.mockReturnValue({ session: { promptAsync } })
  })
  afterEach(() => vi.useRealTimers())

  it('submits text and attachments to the conversation server', async () => {
    promptAsync.mockResolvedValue({})
    await sendMessageAsync(params)
    expect(getSDKClient).toHaveBeenCalledWith('server-b')
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session-1',
        directory: '/workspace/b',
        parts: [
          { type: 'text', text: 'review report' },
          expect.objectContaining({ type: 'file', filename: '报告.pdf', url: params.attachments[0].url }),
        ],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends context card contents to the model as synthetic text, even without a file URL', async () => {
    promptAsync.mockResolvedValue({})
    await sendMessageAsync({
      ...params,
      attachments: [
        {
          id: 'context',
          type: 'text',
          displayName: 'code.ts:2-4',
          content: 'Source: code.ts:2-4\n\nActual selected code',
        },
      ],
    })
    expect(promptAsync.mock.calls[0][0].parts).toEqual([
      { type: 'text', text: params.text },
      { type: 'text', text: 'Source: code.ts:2-4\n\nActual selected code', synthetic: true },
    ])
  })

  it('restores user context cards when reusing a previous prompt without copying unrelated synthetic messages', () => {
    const content = 'Source: src/code.ts:2-4\nDirectory: /project\nServer: remote\n\nSelected code'
    const restored = extractUserMessageContent({
      parts: [
        { type: 'text', text: 'Explain this' },
        { type: 'text', text: content, synthetic: true },
        { type: 'text', text: 'Tool-generated notice', synthetic: true },
      ],
    })
    expect(restored.text).toBe('Explain this')
    expect(restored.attachments).toEqual([
      expect.objectContaining({ type: 'text', displayName: 'code.ts:2-4', content }),
    ])
  })
  it('sends precisely the selected snapshot and retains coordinates after the message is restored', async () => {
    promptAsync.mockResolvedValue({})
    const attachment = selectionAttachment(
      { path: 'src/report.ts', directory: '/workspace/b', serverId: 'server-b' },
      { text: 'ONLY this fragment', startLine: 5, startColumn: 7, endLine: 5, endColumn: 25 },
    )
    const token = '⟦report.ts:5:7-5:25⟧'
    attachment.textRange = { value: token, start: 7, end: 7 + token.length }
    await sendMessageAsync({ ...params, attachments: [attachment] })
    const parts = promptAsync.mock.calls[0][0].parts
    expect(parts).toHaveLength(2)
    expect(parts[1]).toMatchObject({ type: 'text', synthetic: true })
    expect(parts[1].text).toContain('ONLY this fragment')
    const restored = extractUserMessageContent({ parts })
    expect(restored.attachments[0].contextReference).toEqual(attachment.contextReference)
    expect(restored.attachments[0].contextReference?.text).toBe('ONLY this fragment')
    expect(restored.attachments[0].textRange).toEqual(attachment.textRange)
  })

  it('aborts a stalled submission and permits a subsequent request', async () => {
    promptAsync
      .mockImplementationOnce(
        (_params, { signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      )
      .mockResolvedValueOnce({})
    const request = sendMessageAsync(params)
    const assertion = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    await sendMessageAsync(params)
    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates backend rejection and clears its timeout', async () => {
    promptAsync.mockResolvedValue({ error: new Error('Attachment rejected') })
    await expect(sendMessageAsync(params)).rejects.toThrow('Attachment rejected')
    expect(vi.getTimerCount()).toBe(0)
  })
})
