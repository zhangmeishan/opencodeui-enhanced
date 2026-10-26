import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBox } from './InputBox'
import { addFileContextToChat } from '../../utils/chatContext'
import { paneLayoutStore } from '../../store/paneLayoutStore'

let selectedFiles: File[] = []

vi.mock('../attachment', () => ({
  AttachmentPreview: ({ attachments }: { attachments: Array<{ id: string }> }) => (
    <div data-testid="attachment-count">{attachments.length}</div>
  ),
}))

vi.mock('./chatViewport', () => ({
  useChatViewport: () => ({
    presentation: { surfaceVariant: 'desktop', isCompact: false },
    interaction: {
      mode: 'pointer',
      touchCapable: false,
      sidebarBehavior: 'docked',
      rightPanelBehavior: 'docked',
      bottomPanelBehavior: 'docked',
      outlineInteraction: 'pointer',
      enableCollapsedInputDock: false,
    },
  }),
}))

vi.mock('../mention', () => ({
  MentionMenu: () => null,
  detectMentionTrigger: () => null,
  normalizePath: (value: string) => value,
  toFileUrl: (value: string) => value,
}))

vi.mock('../slash-command', () => ({
  SlashCommandMenu: () => null,
}))

vi.mock('./input/InputToolbar', () => ({
  InputToolbar: ({
    onFilesSelected,
    onSend,
    canSend,
  }: {
    onFilesSelected: (files: File[]) => void
    onSend: () => void
    canSend: boolean
  }) => (
    <>
      <button type="button" onClick={() => onFilesSelected(selectedFiles)}>
        attach file
      </button>
      <button type="button" disabled={!canSend} onClick={onSend}>
        send
      </button>
    </>
  ),
}))

vi.mock('./input/InputFooter', () => ({
  InputFooter: () => null,
}))

vi.mock('./input/UndoStatus', () => ({
  UndoStatus: () => null,
}))

vi.mock('../../hooks', () => ({
  useIsMobile: () => false,
  usePresence: (show: boolean) => ({ shouldRender: show, ref: { current: null } }),
}))

vi.mock('../../store/messageStoreHooks', () => ({
  useMessages: () => [],
}))

vi.mock('../../store/keybindingStore', () => ({
  keybindingStore: {
    getKey: () => null,
  },
  matchesKeybinding: () => false,
}))

describe('InputBox attachment handling', () => {
  beforeEach(() => {
    selectedFiles = []
  })

  it('inserts a selection as a compact card into the focused input and sends its actual text', async () => {
    const { focusedPaneId, focusedSessionId } = paneLayoutStore.getSnapshot()
    const onSend = vi.fn(() => true)
    render(<InputBox paneId={focusedPaneId!} sessionId={focusedSessionId} onSend={onSend} />)
    await act(async () => {
      expect(
        await addFileContextToChat(
          { path: 'code.ts', directory: '/project', serverId: 'remote' },
          { text: 'selected unsaved code', startLine: 4, startColumn: 3, endLine: 6, endColumn: 8 },
        ),
      ).toBe(true)
    })
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0')
    expect(screen.getByRole('textbox')).toHaveValue('⟦code.ts:4:3-6:8⟧ ')
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    const sent = onSend.mock.calls[0] as unknown as [
      string,
      Array<{ type: string; displayName: string; content: string }>,
    ]
    expect(sent[1][0]).toMatchObject({
      type: 'text',
      displayName: 'code.ts:4:3-6:8',
      content: expect.stringContaining('selected unsaved code'),
    })
  })

  it('does not insert context into a disabled input', async () => {
    const { focusedPaneId, focusedSessionId } = paneLayoutStore.getSnapshot()
    render(<InputBox paneId={focusedPaneId!} sessionId={focusedSessionId} onSend={vi.fn()} disabled />)
    await act(async () => {
      expect(
        await addFileContextToChat(
          { path: 'code.ts', directory: '/project', serverId: 'remote' },
          { text: 'selected' },
        ),
      ).toBe(false)
    })
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0')
  })

  it('inserts a single-line reference at the retained caret and keeps the caret immediately after it', async () => {
    const { focusedPaneId, focusedSessionId } = paneLayoutStore.getSnapshot()
    const onSend = vi.fn(() => true)
    render(<InputBox paneId={focusedPaneId!} sessionId={focusedSessionId} onSend={onSend} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'before after' } })
    input.focus()
    input.setSelectionRange(7, 7)
    input.blur()
    await act(async () => {
      await addFileContextToChat(
        { path: 'note.txt', directory: '/project', serverId: 'remote' },
        { text: 'actual\nmultiline content', startLine: 2, startColumn: 1, endLine: 3, endColumn: 8 },
      )
    })
    expect(input.value).toBe('before ⟦note.txt:2:1-3:8⟧ after')
    expect(input.value).not.toContain('\n')
    await waitFor(() => expect(input.selectionStart).toBe('before ⟦note.txt:2:1-3:8⟧ '.length))
    expect(input.selectionEnd).toBe(input.selectionStart)
    expect(input).toHaveFocus()
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0')
    // Typing before the marker shifts its range rather than losing the context.
    fireEvent.change(input, { target: { value: `prefix ${input.value}` } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    const sent = onSend.mock.calls[0] as unknown as [
      string,
      Array<{ textRange: { start: number; end: number; value: string }; content: string }>,
    ]
    expect(sent[1]).toHaveLength(1)
    expect(sent[0].slice(sent[1][0].textRange.start, sent[1][0].textRange.end)).toBe('⟦note.txt:2:1-3:8⟧')
    expect(sent[1][0].content).toContain('actual\nmultiline content')
  })

  it('removes selected context when its inline marker is deleted', async () => {
    const { focusedPaneId, focusedSessionId } = paneLayoutStore.getSnapshot()
    const onSend = vi.fn(() => true)
    render(<InputBox paneId={focusedPaneId!} sessionId={focusedSessionId} onSend={onSend} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'question ' } })
    input.setSelectionRange(input.value.length, input.value.length)
    await act(async () => {
      await addFileContextToChat({ path: 'note.txt', directory: '/project', serverId: 'remote' }, { text: 'selected' })
    })
    fireEvent.change(input, { target: { value: 'question ' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect((onSend.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([])
  })
  it('inserts two identical selection labels at their distinct caret locations without losing either context', async () => {
    const { focusedPaneId, focusedSessionId } = paneLayoutStore.getSnapshot()
    const onSend = vi.fn(() => true)
    render(<InputBox paneId={focusedPaneId!} sessionId={focusedSessionId} onSend={onSend} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'left right' } })
    input.setSelectionRange(5, 5)
    const source = { path: 'same.txt', directory: '/project', serverId: 'remote' }
    await act(async () => {
      await addFileContextToChat(source, { text: 'first context' })
    })
    input.setSelectionRange(0, 0)
    await act(async () => {
      await addFileContextToChat(source, { text: 'second context' })
    })
    expect(input.value).toBe('⟦same.txt⟧ left ⟦same.txt⟧ right')
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    const sent = onSend.mock.calls[0] as unknown as [
      string,
      Array<{ textRange: { value: string; start: number; end: number }; content: string }>,
    ]
    expect(sent[1]).toHaveLength(2)
    for (const attachment of sent[1])
      expect(sent[0].slice(attachment.textRange.start, attachment.textRange.end)).toBe(attachment.textRange.value)
    expect(sent[1][0].content).toContain('first context')
    expect(sent[1][1].content).toContain('second context')
  })

  it('accepts files whose mime is inferred from the filename extension', async () => {
    selectedFiles = [new File(['image'], 'photo.png')]

    render(
      <InputBox
        paneId="pane-test"
        onSend={vi.fn()}
        fileCapabilities={{ image: true, pdf: false, audio: false, video: false }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))

    await waitFor(() => {
      expect(screen.getByTestId('attachment-count')).toHaveTextContent('1')
    })
  })

  it('sends documents and unknown file types unchanged to the server even for a text-only model', async () => {
    selectedFiles = [new File(['\0binary'], '报告.docx'), new File(['archive'], 'data.custom')]
    const onSend = vi.fn(() => true)
    render(
      <InputBox
        paneId="test"
        onSend={onSend}
        fileCapabilities={{ image: false, pdf: false, audio: false, video: false }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('2'))
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    const attachments = onSend.mock.calls[0] as unknown as [
      string,
      Array<{ displayName: string; mime: string; url: string }>,
    ]
    expect(attachments[1][0]).toMatchObject({
      displayName: '报告.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect(attachments[1][0].url).toBe(
      `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${btoa('\0binary')}`,
    )
    expect(attachments[1][1].mime).toBe('application/octet-stream')
  })

  it('normalizes text files so OpenCode can expand their contents', async () => {
    selectedFiles = [new File(['{"message":"hello"}'], 'data.json', { type: 'application/json' })]
    const onSend = vi.fn(() => true)
    render(<InputBox paneId="test" onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('1'))
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    expect(onSend).toHaveBeenCalledWith(
      '',
      [expect.objectContaining({ mime: 'text/plain', url: expect.stringMatching(/^data:text\/plain;base64,/) })],
      expect.any(Object),
    )
  })

  it('preserves the document and text on failure and resends both on retry', async () => {
    selectedFiles = [new File(['pdf'], 'report.pdf', { type: 'application/pdf' })]
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<InputBox paneId="test" onSend={onSend} sendError="Server rejected attachment" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'review this report' } })
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('1'))
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server rejected attachment'))
    expect(screen.getByRole('textbox')).toHaveValue('review this report')
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('0'))
    expect(onSend.mock.calls[1]).toEqual(onSend.mock.calls[0])
  })

  it('accepts pasted and dropped documents', async () => {
    render(<InputBox paneId="test" onSend={vi.fn()} />)
    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' })
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] },
    })
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('1'))
    fireEvent.drop(screen.getByRole('textbox').closest('[data-input-box]')!, { dataTransfer: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('2'))
  })

  it('does not add attachments when input is disabled', async () => {
    selectedFiles = [new File(['pdf'], 'report.pdf')]
    render(<InputBox paneId="test" onSend={vi.fn()} disabled />)
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0')
  })

  it('discards a pending file read after switching conversations', async () => {
    const readers: FileReader[] = []
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      readers.push(this)
    })
    selectedFiles = [new File(['pdf'], 'report.pdf')]
    const { rerender } = render(<InputBox paneId="test" sessionId="server-a::session-1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    rerender(<InputBox paneId="test" sessionId="server-b::session-2" onSend={vi.fn()} />)
    const reader = readers[0]
    Object.defineProperty(reader, 'result', { value: 'data:application/pdf;base64,cGRm' })
    await act(async () => reader.onload?.call(reader, new ProgressEvent('load') as ProgressEvent<FileReader>))
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    read.mockRestore()
  })

  it('shows a read error and allows selecting the file again', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(function (this: FileReader) {
      this.onerror?.call(this, new ProgressEvent('error') as ProgressEvent<FileReader>)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    selectedFiles = [new File(['pdf'], 'report.pdf')]
    render(<InputBox paneId="test" onSend={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not read an attachment'))
    fireEvent.click(screen.getByRole('button', { name: 'attach file' }))
    await waitFor(() => expect(screen.getByTestId('attachment-count')).toHaveTextContent('1'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    read.mockRestore()
    warn.mockRestore()
  })
})
