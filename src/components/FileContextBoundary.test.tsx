import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContextBoundary } from './FileContextBoundary'
import { FileCodeEditor } from './FileCodeEditor'

const addMock = vi.hoisted(() => vi.fn())
vi.mock('../utils/chatContext', () => ({
  addFileContextToChat: addMock,
  captureChatContextTarget: () => ({ paneId: 'pane', sessionId: 'remote::session' }),
}))
const source = { path: 'notes.txt', directory: '/project', serverId: 'remote' }
const target = { paneId: 'pane', sessionId: 'remote::session' }

describe('preview selection context menu', () => {
  beforeEach(() => {
    addMock.mockReset().mockResolvedValue(true)
    window.getSelection()?.removeAllRanges()
  })
  it('captures selected rendered text before the menu moves focus and keeps the file origin', async () => {
    render(
      <FileContextBoundary source={source}>
        <p>Selected paragraph</p>
      </FileContextBoundary>,
    )
    const paragraph = screen.getByText('Selected paragraph')
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(paragraph, { clientX: 100, clientY: 100 })
    window.getSelection()?.removeAllRanges()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add selection to chat' }))
    expect(addMock).toHaveBeenCalledWith(
      source,
      { text: 'Selected paragraph', location: 'Rendered preview selection' },
      target,
    )
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
  it('reads CodeMirror selection with its exact line range, including unsaved text', async () => {
    const { container } = render(
      <FileContextBoundary source={source}>
        <FileCodeEditor path="notes.txt" value={'first\nsecond\nthird'} onChange={vi.fn()} onSave={vi.fn()} />
      </FileContextBoundary>,
    )
    const { EditorView } = await import('@codemirror/view')
    const editor = container.querySelector('.cm-editor') as HTMLElement
    const view = EditorView.findFromDOM(editor)!
    view.dispatch({ changes: { from: 6, to: 12, insert: 'edited' }, selection: { anchor: 6, head: 12 } })
    fireEvent.contextMenu(container.querySelector('.cm-content')!)
    fireEvent.click(screen.getByRole('menuitem'))
    expect(addMock).toHaveBeenCalledWith(
      source,
      { text: 'edited', startLine: 2, startColumn: 1, endLine: 2, endColumn: 7 },
      target,
    )
  })
  it('normalizes backward multiline selections and preserves an exclusive end at the next line', async () => {
    const { container } = render(
      <FileContextBoundary source={source}>
        <FileCodeEditor path="notes.txt" value={'abc\ndef\nghi'} onChange={vi.fn()} onSave={vi.fn()} />
      </FileContextBoundary>,
    )
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ selection: { anchor: 8, head: 1 } })
    fireEvent.contextMenu(container.querySelector('.cm-content')!)
    fireEvent.click(screen.getByRole('menuitem'))
    expect(addMock).toHaveBeenCalledWith(
      source,
      { text: 'bc\ndef\n', startLine: 1, startColumn: 2, endLine: 3, endColumn: 1 },
      target,
    )
  })
  it('supports textarea selections even when the child handles its own context menu', () => {
    render(
      <FileContextBoundary source={source}>
        <textarea
          aria-label="plain editor"
          defaultValue={'first\nsecond'}
          onContextMenu={event => event.stopPropagation()}
        />
      </FileContextBoundary>,
    )
    const input = screen.getByLabelText('plain editor') as HTMLTextAreaElement
    input.setSelectionRange(8, 11)
    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem'))
    expect(addMock).toHaveBeenCalledWith(
      source,
      { text: 'con', startLine: 2, startColumn: 3, endLine: 2, endColumn: 6 },
      target,
    )
  })
  it('uses editor UTF-16 columns for Chinese text and emoji instead of byte offsets', async () => {
    const { container } = render(
      <FileContextBoundary source={source}>
        <FileCodeEditor path="notes.txt" value={'中文😀文字'} onChange={vi.fn()} onSave={vi.fn()} />
      </FileContextBoundary>,
    )
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ selection: { anchor: 2, head: 5 } })
    fireEvent.contextMenu(container.querySelector('.cm-content')!)
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(addMock).toHaveBeenCalledWith(
      source,
      { text: '😀文', startLine: 1, startColumn: 3, endLine: 1, endColumn: 6 },
      target,
    )
  })
  it('pins the file source when the menu opens, even if the preview switches before the action', async () => {
    const { rerender } = render(
      <FileContextBoundary source={source}>
        <p>Selected text</p>
      </FileContextBoundary>,
    )
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('Selected text'))
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(screen.getByText('Selected text'))
    rerender(
      <FileContextBoundary source={{ ...source, path: 'different.txt' }}>
        <p>Selected text</p>
      </FileContextBoundary>,
    )
    fireEvent.click(screen.getByRole('menuitem'))
    await waitFor(() =>
      expect(addMock).toHaveBeenCalledWith(source, expect.objectContaining({ text: 'Selected text' }), target),
    )
  })
  it('captures text selected inside a same-origin document preview iframe', async () => {
    const { container } = render(
      <FileContextBoundary source={source}>
        <iframe title="Word preview" />
      </FileContextBoundary>,
    )
    const frame = container.querySelector('iframe')!
    const doc = frame.contentDocument!
    doc.body.innerHTML = '<p>Selected Word paragraph</p>'
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('p')!)
    doc.getSelection()!.addRange(range)
    fireEvent.load(frame)
    fireEvent.contextMenu(doc.querySelector('p')!, { clientX: 5, clientY: 10 })
    await screen.findByRole('menuitem')
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem'))
    })
    expect(addMock).toHaveBeenCalledWith(
      source,
      { text: 'Selected Word paragraph', location: 'Rendered preview selection' },
      target,
    )
  })
  it('keeps the browser menu when nothing is selected and closes on Escape', () => {
    render(
      <FileContextBoundary source={source}>
        <p>Text</p>
      </FileContextBoundary>,
    )
    fireEvent.contextMenu(screen.getByText('Text'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('Text'))
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(screen.getByText('Text'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it.each(['report.docx', 'budget.xlsx', 'slides.pptx', 'legacy.doc', 'report.pdf'])(
    'does not offer selection-to-chat for non-text preview %s',
    path => {
      render(
        <FileContextBoundary source={{ ...source, path }}>
          <p>Office text</p>
        </FileContextBoundary>,
      )
      const range = document.createRange()
      range.selectNodeContents(screen.getByText('Office text'))
      window.getSelection()?.addRange(range)
      fireEvent.contextMenu(screen.getByText('Office text'))
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
      expect(addMock).not.toHaveBeenCalled()
    },
  )
  it('surfaces a failed insertion so the selection is not silently lost', async () => {
    addMock.mockResolvedValue(false)
    render(
      <FileContextBoundary source={source}>
        <p>Text</p>
      </FileContextBoundary>,
    )
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('Text'))
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(screen.getByText('Text'))
    fireEvent.click(screen.getByRole('menuitem'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add context')
  })
})
