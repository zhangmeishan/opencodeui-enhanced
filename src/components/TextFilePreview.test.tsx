import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextFilePreview } from './TextFilePreview'

vi.mock('./CodePreview', () => ({
  CodePreview: ({ code, language }: { code: string; language: string }) => (
    <pre data-testid="source" data-language={language}>
      {code}
    </pre>
  ),
}))
vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}))
vi.mock('./HtmlFilePreviewFrame', () => ({
  HtmlFilePreviewFrame: ({ html, serverId, directory }: { html: string; serverId: string; directory: string }) => (
    <div data-testid="html" data-server={serverId} data-directory={directory}>
      {html}
    </div>
  ),
}))
const props = { directory: '/project', serverId: 'server-b' }
describe('text preview rendering', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('binds HTML resource reads to the file project and server', () => {
    render(<TextFilePreview {...props} text="<h1>Hello</h1>" path="index.html" />)
    expect(screen.getByTestId('html')).toHaveAttribute('data-server', 'server-b')
    expect(screen.getByTestId('html')).toHaveAttribute('data-directory', '/project')
  })
  it('renders table values as text instead of injecting markup', () => {
    render(<TextFilePreview {...props} text={'name,value\n<script>alert(1)</script>,"a,b"'} path="data.csv" />)
    expect(screen.getByRole('cell', { name: '<script>alert(1)</script>' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'a,b' })).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })
  it('preserves malformed data and program source in read-only previews', () => {
    const { rerender } = render(<TextFilePreview {...props} text="{unfinished" path="data.json" />)
    expect(screen.getByRole('status')).toHaveTextContent('original source')
    expect(screen.getByTestId('source')).toHaveTextContent('{unfinished')
    rerender(<TextFilePreview {...props} text="print(42)" path="main.py" />)
    expect(screen.getByTestId('source')).toHaveAttribute('data-language', 'python')
  })
  it('isolates SVG as an image and releases its Blob URL when the draft changes or closes', async () => {
    const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    const revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = create
        static revokeObjectURL = revoke
      },
    )
    const { rerender, unmount } = render(
      <TextFilePreview {...props} text={'<svg xmlns="http://www.w3.org/2000/svg"/>'} path="icon.svg" />,
    )
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:first'))
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByRole('alert')).toHaveTextContent('could not be rendered')
    rerender(
      <TextFilePreview
        {...props}
        text={'<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>'}
        path="icon.svg"
      />,
    )
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:second'))
    expect(revoke).toHaveBeenCalledWith('blob:first')
    unmount()
    expect(revoke).toHaveBeenCalledWith('blob:second')
  })
  it('previews Markdown aliases and standalone Mermaid files', async () => {
    const { rerender } = render(<TextFilePreview {...props} text="# Heading" path="README.markdown" />)
    expect(await screen.findByTestId('markdown')).toHaveTextContent('# Heading')
    rerender(<TextFilePreview {...props} text="graph TD; A-->B" path="flow.mmd" />)
    expect(await screen.findByTestId('markdown')).toHaveTextContent('```mermaid')
  })
})
