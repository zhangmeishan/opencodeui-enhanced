import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnlyOfficeEditor } from './OnlyOfficeEditor'
import { registerChatContextReceiver } from '../utils/chatContext'
import { paneLayoutStore } from '../store/paneLayoutStore'

vi.mock('../api/http', () => ({
  getApiBaseUrl: () => 'http://localhost/api-mason',
  getAuthHeader: () => ({ Authorization: 'Basic test' }),
}))
describe('ONLYOFFICE editor without selection integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.DocsAPI
  })
  it.each(['edit', 'view'] as const)(
    'opens %s mode without selection controls or message listeners and cleans up the editor',
    async mode => {
      const destroyEditor = vi.fn(),
        create = vi.fn()
      window.DocsAPI = {
        DocEditor: class {
          constructor(...args: unknown[]) {
            create(...args)
          }
          destroyEditor = destroyEditor
        },
      }
      const fetchMock = vi.fn(
        async (url: string, _options?: RequestInit) =>
          new Response(
            JSON.stringify(
              url.includes('/status')
                ? { savedAt: '2026-01-01T00:00:00Z' }
                : {
                    scriptUrl: 'http://office.example/web-apps/apps/api/documents/api.js',
                    config: {
                      document: { key: 'test', permissions: { edit: mode === 'edit' } },
                      editorConfig: { mode },
                    },
                    sessionToken: 'token',
                    editable: mode === 'edit',
                  },
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
      )
      vi.stubGlobal('fetch', fetchMock)
      const receive = vi.fn(() => true)
      const cleanup = registerChatContextReceiver(paneLayoutStore.getFocusedPaneId()!, receive)
      const { unmount } = render(
        <OnlyOfficeEditor
          path="report.docx"
          directory="/project"
          serverId="server-b"
          mode={mode}
          onPreview={vi.fn()}
        />,
      )
      try {
        await waitFor(() => expect(create).toHaveBeenCalledOnce())
        const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
        expect(body).toMatchObject({
          serverUrl: 'http://localhost/api-mason',
          directory: '/project',
          path: 'report.docx',
          mode,
        })
        expect(body.contextChannel).toBeUndefined()
        const editorOptions = create.mock.calls[0][1]
        expect(editorOptions.editorConfig.mode).toBe(mode)
        expect(editorOptions.document.permissions.edit).toBe(mode === 'edit')
        if (mode === 'view') expect(screen.getByText('Preview · Read-only')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Add selection to chat' })).not.toBeInTheDocument()
        act(() =>
          window.dispatchEvent(
            new MessageEvent('message', {
              origin: window.location.origin,
              data: { type: 'opencode-office-selection', text: 'Must not insert' },
            }),
          ),
        )
        expect(receive).not.toHaveBeenCalled()
        if (mode === 'view') expect(fetchMock).toHaveBeenCalledTimes(1)
      } finally {
        unmount()
        cleanup()
      }
      expect(destroyEditor).toHaveBeenCalledOnce()
    },
  )
  it('offers preview when the bridge returns the frontend HTML fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>frontend</html>', { headers: { 'content-type': 'text/html' } })),
    )
    const preview = vi.fn()
    render(<OnlyOfficeEditor path="report.docx" directory="/project" serverId="server-b" onPreview={preview} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('not configured')
    fireEvent.click(screen.getByRole('button', { name: 'Preview / download' }))
    expect(preview).toHaveBeenCalledOnce()
  })
  it('retains Office authentication', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })),
    )
    render(<OnlyOfficeEditor path="report.xlsx" directory="/project" serverId="server-b" onPreview={vi.fn()} />)
    expect(await screen.findByLabelText('Office password')).toHaveAttribute('type', 'password')
  })
  it('refuses an editable configuration returned for preview instead of silently opening an editor', async () => {
    const create = vi.fn(),
      fallback = vi.fn()
    window.DocsAPI = {
      DocEditor: class {
        constructor(...args: unknown[]) {
          create(...args)
        }
        destroyEditor = vi.fn()
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              scriptUrl: 'http://office.example/web-apps/apps/api/documents/api.js',
              config: { document: { permissions: { edit: true } }, editorConfig: { mode: 'edit' } },
              sessionToken: 'token',
              editable: true,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    render(
      <OnlyOfficeEditor
        path="report.docx"
        directory="/project"
        serverId="remote"
        mode="view"
        onPreview={vi.fn()}
        onUnavailable={fallback}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('did not return a read-only configuration')
    expect(create).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })
})
