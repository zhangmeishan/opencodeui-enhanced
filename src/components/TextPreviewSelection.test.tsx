import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TextFilePreview } from './TextFilePreview'
import { FileContextBoundary } from './FileContextBoundary'
import { renderMarkdownToHtml } from './markdownHtmlRenderer'
import { EditorView } from '@codemirror/view'

const add = vi.hoisted(() => vi.fn())
vi.mock('../utils/chatContext', () => ({
  addFileContextToChat: add,
  captureChatContextTarget: () => ({ paneId: 'pane', sessionId: 'remote::chat' }),
}))
vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(content, false) }} />
  ),
}))
vi.mock('../hooks/useSyntaxHighlight', () => ({
  useSyntaxHighlightRef: () => ({ tokensRef: { current: null }, version: 0 }),
}))
const source = { path: 'note.md', directory: '/project', serverId: 'remote' }

describe('text preview selected source coordinates', () => {
  beforeEach(() => {
    add.mockReset().mockResolvedValue(true)
    window.getSelection()?.removeAllRanges()
  })
  it('passes exact original lines and columns from a rendered Markdown selection, including repeats', async () => {
    render(
      <FileContextBoundary source={source}>
        <TextFilePreview {...source} text={'# Title\n\n[repeat](https://repeat.example)\n\n**repeat**'} />
      </FileContextBoundary>,
    )
    const word = await screen.findByText('repeat', { selector: 'strong' })
    const range = document.createRange()
    range.selectNodeContents(word)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(word)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(add).toHaveBeenCalledWith(
      source,
      { text: 'repeat', startLine: 5, startColumn: 3, endLine: 5, endColumn: 9 },
      expect.anything(),
    )
  })
  it('updates mapping when the current unsaved preview text changes', async () => {
    const view = render(
      <FileContextBoundary source={source}>
        <TextFilePreview {...source} text={'**old**'} />
      </FileContextBoundary>,
    )
    await screen.findByText('old', { selector: 'strong' })
    view.rerender(
      <FileContextBoundary source={source}>
        <TextFilePreview {...source} text={'\n\n**new**'} />
      </FileContextBoundary>,
    )
    const word = await screen.findByText('new', { selector: 'strong' })
    const range = document.createRange()
    range.selectNodeContents(word)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(word)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(add).toHaveBeenCalledWith(
      source,
      { text: 'new', startLine: 3, startColumn: 3, endLine: 3, endColumn: 6 },
      expect.anything(),
    )
  })
  it('maps CSV display cells back to the quoted field in the original', async () => {
    const file = { ...source, path: 'data.csv' }
    render(
      <FileContextBoundary source={file}>
        <TextFilePreview {...file} text={'name,note\nx,"hello, world"'} />
      </FileContextBoundary>,
    )
    const cell = screen.getByRole('cell', { name: 'hello, world' })
    const range = document.createRange()
    range.selectNodeContents(cell)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(cell)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(add).toHaveBeenCalledWith(
      file,
      { text: 'hello, world', startLine: 2, startColumn: 4, endLine: 2, endColumn: 16 },
      expect.anything(),
    )
  })
  it('maps CodeMirror pretty-print coordinates to compact JSON original columns', async () => {
    const file = { ...source, path: 'data.json' }
    const { container } = render(
      <FileContextBoundary source={file}>
        <TextFilePreview {...file} text={'{"message":"hello"}'} />
      </FileContextBoundary>,
    )
    await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy())
    const editor = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    const at = editor.state.doc.toString().indexOf('hello')
    act(() => editor.dispatch({ selection: { anchor: at, head: at + 5 } }))
    fireEvent.contextMenu(container.querySelector('.cm-content')!)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(add).toHaveBeenCalledWith(
      file,
      { text: 'hello', startLine: 1, startColumn: 13, endLine: 1, endColumn: 18 },
      expect.anything(),
    )
  })
  it('keeps selected generated text with a fuzzy marker and no invented coordinates', async () => {
    render(
      <FileContextBoundary source={source}>
        <TextFilePreview {...source} text={'**original**'} />
      </FileContextBoundary>,
    )
    const word = await screen.findByText('original', { selector: 'strong' })
    word.textContent = 'generated'
    const range = document.createRange()
    range.selectNodeContents(word)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(word)
    await act(async () => fireEvent.click(screen.getByRole('menuitem')))
    expect(add).toHaveBeenCalledWith(
      source,
      {
        text: 'generated',
        fuzzy: true,
        location: expect.any(String),
      },
      expect.anything(),
    )
  })
  it.each([
    ['**original**', '**modified**', 'strong'],
    ['- original', '- modified', 'li'],
  ])(
    'rejects a menu selection when the draft was updated after the menu opened (%s)',
    async (initial, updated, selector) => {
      const view = render(
        <FileContextBoundary source={source}>
          <TextFilePreview {...source} text={initial} />
        </FileContextBoundary>,
      )
      const word = await screen.findByText('original', { selector })
      const range = document.createRange()
      range.selectNodeContents(word)
      window.getSelection()?.addRange(range)
      fireEvent.contextMenu(word)
      expect(screen.getByRole('menuitem')).toBeInTheDocument()
      view.rerender(
        <FileContextBoundary source={source}>
          <TextFilePreview {...source} text={updated} />
        </FileContextBoundary>,
      )
      await screen.findByText('modified', { selector })
      fireEvent.click(screen.getByRole('menuitem'))
      expect(screen.getByRole('alert')).toHaveTextContent('could not be mapped reliably')
      expect(add).not.toHaveBeenCalled()
    },
  )
  it('maps an escaped-quote CSV cell exactly and uses a fuzzy range for a multi-cell selection', async () => {
    const file = { ...source, path: 'data.csv' }
    render(
      <FileContextBoundary source={file}>
        <TextFilePreview {...file} text={'name,note\nx,"say ""hello"""'} />
      </FileContextBoundary>,
    )
    const cell = screen.getByRole('cell', { name: 'say "hello"' })
    const range = document.createRange()
    range.selectNodeContents(cell)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(cell)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(add).toHaveBeenCalledWith(
      file,
      { text: 'say "hello"', startLine: 2, startColumn: 4, endLine: 2, endColumn: 17 },
      expect.anything(),
    )
    add.mockClear()
    const cross = document.createRange()
    cross.setStart(screen.getByRole('cell', { name: 'x' }).firstChild!, 0)
    cross.setEnd(cell.firstChild!, 3)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(cross)
    fireEvent.contextMenu(cell)
    await act(async () => fireEvent.click(screen.getByRole('menuitem')))
    expect(add).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ text: 'xsay', fuzzy: true, startLine: 2 }),
      expect.anything(),
    )
  })
  it('adds an unsupported Markdown list selection with an approximate source range', async () => {
    render(
      <FileContextBoundary source={source}>
        <TextFilePreview {...source} text={'- first\n- second'} />
      </FileContextBoundary>,
    )
    const word = await screen.findByText('second', { selector: 'li' })
    const range = document.createRange()
    range.selectNodeContents(word)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(word)
    await act(async () => fireEvent.click(screen.getByRole('menuitem')))
    expect(add).toHaveBeenCalledWith(
      source,
      {
        text: 'second',
        startLine: 2,
        startColumn: 3,
        endLine: 2,
        endColumn: 9,
        fuzzy: true,
      },
      expect.anything(),
    )
  })
  it('accepts range-free fuzzy iframe selections only for the current source snapshot', async () => {
    const file = { ...source, path: 'dynamic.html' }
    const { container } = render(
      <FileContextBoundary source={file}>
        <TextFilePreview {...file} text={'<p>original</p>'} />
      </FileContextBoundary>,
    )
    const frame = await waitFor(() => {
      expect(container.querySelector('iframe')).toBeTruthy()
      return container.querySelector('iframe')!
    })
    const selection = { text: 'generated', fuzzy: true, location: 'Source range unavailable' }
    act(() =>
      frame.dispatchEvent(
        new CustomEvent('opencode-preview-selection', {
          bubbles: true,
          detail: { text: selection.text, x: 0, y: 0, selection, mappedSource: '<p>original</p>' },
        }),
      ),
    )
    await act(async () => fireEvent.click(screen.getByRole('menuitem')))
    expect(add).toHaveBeenCalledWith(file, selection, expect.anything())
    add.mockClear()
    act(() =>
      frame.dispatchEvent(
        new CustomEvent('opencode-preview-selection', {
          bubbles: true,
          detail: { text: selection.text, x: 0, y: 0, selection, mappedSource: '<p>stale</p>' },
        }),
      ),
    )
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    expect(add).not.toHaveBeenCalled()
  })
})
