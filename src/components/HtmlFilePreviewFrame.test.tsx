import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HtmlFilePreviewFrame } from './HtmlFilePreviewFrame'

const themeMock = vi.hoisted(() => ({ resolvedTheme: 'light' as 'light' | 'dark' }))
const resolveHtmlPreviewResources = vi.hoisted(() =>
  vi.fn(async (html: string, _path?: string, _directory?: string) => html),
)

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: themeMock.resolvedTheme }),
}))

vi.mock('./htmlPreviewResources', () => ({ resolveHtmlPreviewResources }))

describe('HtmlFilePreviewFrame', () => {
  beforeEach(() => {
    themeMock.resolvedTheme = 'light'
    resolveHtmlPreviewResources.mockReset()
    resolveHtmlPreviewResources.mockImplementation(async (html: string) => html)
  })

  it('bridges a selected HTML preview fragment only from its own frame', () => {
    const { container } = render(<HtmlFilePreviewFrame html="<p>Selected HTML</p>" title="selection.html" />)
    const frame = screen.getByTitle('selection.html') as HTMLIFrameElement
    const srcDoc = frame.getAttribute('srcdoc')!
    const id = srcDoc.match(/type:'opencode-html-selection',id:("[^"]+")/)![1]
    const listener = vi.fn()
    container.addEventListener('opencode-preview-selection', listener)
    const data = { type: 'opencode-html-selection', id: JSON.parse(id), text: 'Selected HTML', x: 10, y: 20 }
    window.dispatchEvent(new MessageEvent('message', { source: window, data }))
    expect(listener).not.toHaveBeenCalled()
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }))
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail).toEqual({ text: 'Selected HTML', x: 10, y: 20 })
  })
  it('maps iframe selection offsets to the original HTML source before sending a context request', () => {
    const { container } = render(
      <div data-text-file-preview>
        <HtmlFilePreviewFrame html={'<p>hello &amp; world</p>\n<p>hello</p>'} title="mapped.html" />
      </div>,
    )
    const frame = screen.getByTitle('mapped.html') as HTMLIFrameElement
    const id = JSON.parse(frame.getAttribute('srcdoc')!.match(/type:'opencode-html-selection',id:("[^"]+")/)![1])
    const listener = vi.fn()
    container.addEventListener('opencode-preview-selection', listener)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'opencode-html-selection',
          id,
          text: 'hello',
          x: 0,
          y: 0,
          displayed: 'hello & world\nhello',
          from: 14,
          to: 19,
        },
      }),
    )
    expect(listener.mock.calls[0][0].detail.selection).toEqual({
      text: 'hello',
      startLine: 2,
      startColumn: 4,
      endLine: 2,
      endColumn: 9,
    })
  })
  it('ignores a selection message from the previous document after replacing HTML in the same frame', () => {
    const view = render(<HtmlFilePreviewFrame html="<p>old</p>" title="selection.html" />)
    const frame = screen.getByTitle('selection.html') as HTMLIFrameElement
    const id = JSON.parse(frame.getAttribute('srcdoc')!.match(/type:'opencode-html-selection',id:("[^"]+")/)![1])
    const listener = vi.fn()
    view.container.addEventListener('opencode-preview-selection', listener)
    view.rerender(<HtmlFilePreviewFrame html="<p>new</p>" title="selection.html" />)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'opencode-html-selection', id, text: 'old', x: 0, y: 0, displayed: 'old', from: 0, to: 3 },
      }),
    )
    expect(listener).not.toHaveBeenCalled()
  })
  it.each(['hello', 'generated'])('bridges a fuzzy selection from dynamic HTML (%s)', text => {
    const html = '<p>hello</p><script>update()</script>'
    const { container } = render(
      <div data-text-file-preview>
        <HtmlFilePreviewFrame html={html} title="dynamic.html" />
      </div>,
    )
    const frame = screen.getByTitle('dynamic.html') as HTMLIFrameElement
    const id = JSON.parse(frame.getAttribute('srcdoc')!.match(/type:'opencode-html-selection',id:("[^"]+")/)![1])
    const listener = vi.fn()
    container.addEventListener('opencode-preview-selection', listener)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'opencode-html-selection', id, text, x: 1, y: 2, displayed: text, from: 0, to: text.length },
      }),
    )
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail).toMatchObject({
      mappedSource: html,
      selection: { text, fuzzy: true },
    })
    expect(listener.mock.calls[0][0].detail.mappingFailed).toBeUndefined()
  })

  it('renders a file as a script-enabled opaque-origin sandbox', () => {
    render(
      <HtmlFilePreviewFrame
        html={'<main>Preview</main><script>document.body.dataset.ready="yes"</script>'}
        title="index.html"
      />,
    )

    const frame = screen.getByTitle('index.html')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.getAttribute('srcdoc')).toContain('name="viewport" content="width=device-width, initial-scale=1"')
    expect(frame.getAttribute('srcdoc')).toContain('<main>Preview</main>')
    expect(frame.getAttribute('srcdoc')).toContain('html{height:100%;width:100%;margin:0;overflow:hidden}')
    expect(frame.getAttribute('srcdoc')).toContain('body{height:100%;width:100%;margin:0;overflow:auto')
    expect(frame.getAttribute('srcdoc')).toContain('::-webkit-scrollbar-thumb')
    expect(frame.getAttribute('srcdoc')).toContain('rgba(100,100,100,.35)')
    expect(frame.getAttribute('srcdoc')).toContain('opencode-html-interaction')
  })

  it('preserves an existing document viewport instead of injecting a duplicate', () => {
    render(
      <HtmlFilePreviewFrame
        html={'<html><head><meta name="viewport" content="width=640"></head><body>Preview</body></html>'}
        title="custom-viewport.html"
      />,
    )

    const srcDoc = screen.getByTitle('custom-viewport.html').getAttribute('srcdoc') ?? ''
    expect(srcDoc.match(/name="viewport"/g)).toHaveLength(1)
    expect(srcDoc).toContain('name="viewport" content="width=640"')
  })

  it('renders an empty HTML file as a blank document instead of loading forever', () => {
    render(<HtmlFilePreviewFrame html="" title="empty.html" />)
    expect(screen.getByTitle('empty.html')).toHaveAttribute('srcdoc')
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('updates theme without replacing the preview document', async () => {
    const view = render(<HtmlFilePreviewFrame html={'<main>Preview</main>'} title="index.html" />)
    const frame = screen.getByTitle('index.html') as HTMLIFrameElement
    const initialSrcDoc = frame.getAttribute('srcdoc')
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')

    themeMock.resolvedTheme = 'dark'
    view.rerender(<HtmlFilePreviewFrame html={'<main>Preview</main>'} title="index.html" />)

    await waitFor(() => {
      expect(frame).toHaveStyle({ colorScheme: 'dark' })
      expect(postMessage).toHaveBeenCalledWith({ type: 'opencode-html-theme', theme: 'dark' }, '*')
    })
    expect(screen.getByTitle('index.html')).toBe(frame)
    expect(frame.getAttribute('srcdoc')).toBe(initialSrcDoc)
  })

  it('does not capture pointer input while its panel is resizing', () => {
    render(<HtmlFilePreviewFrame html={'<main>Preview</main>'} title="index.html" isResizing />)

    expect(screen.getByTitle('index.html')).toHaveClass('pointer-events-none')
  })

  it('does not show a stale file while a newly selected file is resolving', async () => {
    let resolveFirst!: (value: string) => void
    let resolveSecond!: (value: string) => void
    resolveHtmlPreviewResources.mockImplementation(
      (_html: string, path?: string) =>
        new Promise<string>(resolve => {
          if (path === 'first.html') resolveFirst = resolve
          else resolveSecond = resolve
        }),
    )
    const view = render(
      <HtmlFilePreviewFrame html={'<main>First source</main>'} title="first.html" filePath="first.html" />,
    )
    expect(view.container.querySelector('[aria-busy="true"]')).toBeInTheDocument()

    view.rerender(
      <HtmlFilePreviewFrame html={'<main>Second source</main>'} title="second.html" filePath="second.html" />,
    )
    await act(async () => {
      resolveFirst('<main>Resolved first</main>')
      await Promise.resolve()
    })
    expect(screen.queryByTitle('second.html')).not.toBeInTheDocument()

    await act(async () => {
      resolveSecond('<main>Resolved second</main>')
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTitle('second.html').getAttribute('srcdoc')).toContain('Resolved second'))
  })

  it('resolves relative resources using the preview file server', async () => {
    render(
      <HtmlFilePreviewFrame
        html='<img src="logo.png">'
        title="page.html"
        filePath="page.html"
        directory="/project"
        serverId="server-b"
      />,
    )
    await waitFor(() =>
      expect(resolveHtmlPreviewResources).toHaveBeenCalledWith(
        '<img src="logo.png">',
        'page.html',
        '/project',
        'server-b',
      ),
    )
  })

  it('does not reuse resources from a different server with the same path', async () => {
    resolveHtmlPreviewResources.mockImplementation(
      async (_html: string, _path?: string, _directory?: string, serverId?: string) => `<main>${serverId}</main>`,
    )
    const view = render(
      <HtmlFilePreviewFrame
        html="<main>source</main>"
        title="page.html"
        filePath="page.html"
        directory="/project"
        serverId="server-a"
      />,
    )
    await waitFor(() => expect(screen.getByTitle('page.html').getAttribute('srcdoc')).toContain('server-a'))
    view.rerender(
      <HtmlFilePreviewFrame
        html="<main>source</main>"
        title="page.html"
        filePath="page.html"
        directory="/project"
        serverId="server-b"
      />,
    )
    await waitFor(() => expect(screen.getByTitle('page.html').getAttribute('srcdoc')).toContain('server-b'))
    expect(screen.getByTitle('page.html').getAttribute('srcdoc')).not.toContain('server-a')
  })
})
