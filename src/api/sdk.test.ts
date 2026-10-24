import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'

const { createOpencodeClientMock, getActiveBaseUrlMock, getActiveAuthMock, isTauriMock } = vi.hoisted(() => ({
  createOpencodeClientMock: vi.fn((config: unknown) => ({ config })),
  getActiveBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
  getActiveAuthMock: vi.fn(() => null),
  isTauriMock: vi.fn(() => false),
}))

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: createOpencodeClientMock,
}))

vi.mock('../store/serverStore', () => ({
  makeBasicAuthHeader: vi.fn(() => 'Basic token'),
  serverStore: {
    getActiveBaseUrl: getActiveBaseUrlMock,
    getActiveAuth: getActiveAuthMock,
  },
}))

vi.mock('../utils/tauri', () => ({
  isTauri: isTauriMock,
}))

type MockClient = {
  config: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }
}

describe('sdk request lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    getActiveBaseUrlMock.mockReturnValue('http://127.0.0.1:4096')
    getActiveAuthMock.mockReturnValue(null)
    isTauriMock.mockReturnValue(false)
    const { abortInFlightApiRequests, invalidateSDKClient } = await import('./sdk')
    abortInFlightApiRequests('reset test state')
    invalidateSDKClient()
  })

  it('aborts in-flight SDK requests when the server endpoint changes', async () => {
    const { abortInFlightApiRequests, getSDKClient } = await import('./sdk')
    let signal: AbortSignal | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })

    const client = getSDKClient() as unknown as MockClient
    const request = client.config.fetch('http://127.0.0.1:4096/project/current')

    abortInFlightApiRequests('Server endpoint changed')

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
  })

  it('prevents stale SDK clients from starting new requests after endpoint changes', async () => {
    const { abortInFlightApiRequests, getSDKClient } = await import('./sdk')
    const client = getSDKClient() as unknown as MockClient
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    abortInFlightApiRequests('Server endpoint changed')

    await expect(client.config.fetch('http://127.0.0.1:4096/project/current')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('honors the abort signal carried on the SDK Request object', async () => {
    const { getSDKClient } = await import('./sdk')
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const client = getSDKClient() as unknown as MockClient
    const request = client.config.fetch(new Request('http://127.0.0.1:4096/session/test/prompt_async', { method: 'POST', signal: controller.signal }))
    controller.abort(new DOMException('Message submission timed out', 'TimeoutError'))
    await expect(request).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it.each(['en', 'zh-CN'])('reports HTML 413 responses as an upload limit error in %s', async language => {
    const previousLanguage = i18n.language
    await i18n.changeLanguage(language)
    try {
      const { getSDKClient } = await import('./sdk')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>413 Request Entity Too Large</html>', {
        status: 413,
        headers: { 'content-type': 'text/html' },
      }))
      const client = getSDKClient() as unknown as MockClient
      await expect(client.config.fetch('http://127.0.0.1:4096/session/test/prompt_async')).rejects.toThrow(
        i18n.t('common:errors.requestTooLarge'),
      )
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })

  it('preserves successful empty submission responses', async () => {
    const { getSDKClient } = await import('./sdk')
    const response = new Response(null, { status: 204 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const client = getSDKClient() as unknown as MockClient
    expect(await client.config.fetch('http://127.0.0.1:4096/session/test/prompt_async')).toBe(response)
  })
})
