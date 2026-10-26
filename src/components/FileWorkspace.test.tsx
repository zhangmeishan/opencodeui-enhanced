import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileWorkspace } from './FileWorkspace'
import { clearFileDrafts } from '../store/fileDraftStore'
import { readEditableFile, saveProjectFile, fileChecksum } from '../api/fileSave'

vi.mock('../api/fileSave', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/fileSave')>()),
  readEditableFile: vi.fn(),
  saveProjectFile: vi.fn(),
}))
vi.mock('./FileCodeEditor', () => ({
  FileCodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="editor" defaultValue={value} onChange={event => onChange(event.target.value)} />
  ),
}))
vi.mock('./MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('./HtmlFilePreviewFrame', () => ({
  HtmlFilePreviewFrame: ({ html, serverId }: { html: string; serverId: string }) => (
    <div data-testid="html-preview" data-server={serverId}>
      {html}
    </div>
  ),
}))

describe('file editing workspace', () => {
  beforeEach(() => {
    clearFileDrafts()
    vi.clearAllMocks()
  })
  const props = { path: 'notes.md', directory: '/project', serverId: 'server-b', onDirtyChange: vi.fn() }
  function load(text: string) {
    const bytes = new TextEncoder().encode(text)
    vi.mocked(readEditableFile).mockResolvedValue({ bytes, hash: fileChecksum(bytes) })
  }
  it('preserves BOM, whitespace and CRLF while saving edits to the bound server', async () => {
    load('\uFEFF  original\r\n\r\n')
    vi.mocked(saveProjectFile).mockResolvedValue(undefined)
    render(<FileWorkspace {...props} />)
    await screen.findByLabelText('editor')
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: '  modified\n\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save · Ctrl+S' }))
    await waitFor(() => expect(saveProjectFile).toHaveBeenCalledOnce())
    const [path, bytes, hash, directory, serverId] = vi.mocked(saveProjectFile).mock.calls[0]
    expect(path).toBe('notes.md')
    expect(directory).toBe('/project')
    expect(serverId).toBe('server-b')
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe('\uFEFF  modified\r\n\r\n')
    expect(hash).toBe(fileChecksum(new TextEncoder().encode('\uFEFF  original\r\n\r\n')))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  })
  it('keeps unsaved text across tab switches and preserves it after a failed save', async () => {
    load('original')
    vi.mocked(saveProjectFile).mockRejectedValue(new Error('File changed externally'))
    const { unmount } = render(<FileWorkspace {...props} />)
    fireEvent.change(await screen.findByLabelText('editor'), { target: { value: 'my edits' } })
    unmount()
    render(<FileWorkspace {...props} />)
    expect(await screen.findByLabelText('editor')).toHaveValue('my edits')
    fireEvent.click(screen.getByRole('button', { name: 'Save · Ctrl+S' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File changed externally')
    expect(screen.getByLabelText('editor')).toHaveValue('my edits')
    expect(screen.getByRole('button', { name: 'Save · Ctrl+S' })).toBeEnabled()
  })
  it('prevents refresh from silently discarding an unsaved buffer', async () => {
    load('original')
    render(<FileWorkspace {...props} />)
    fireEvent.change(await screen.findByLabelText('editor'), { target: { value: 'changed' } })
    const event = new Event('beforeunload', { cancelable: true })
    act(() => window.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
  })
  it('revalidates a clean draft on reopen so external changes cannot leave an old preview', async () => {
    load('original')
    const first = render(<FileWorkspace {...props} />)
    expect(await screen.findByLabelText('editor')).toHaveValue('original')
    first.unmount()
    load('updated externally')
    render(<FileWorkspace {...props} />)
    expect(await screen.findByLabelText('editor')).toHaveValue('updated externally')
    expect(readEditableFile).toHaveBeenCalledTimes(2)
  })
  it('revalidates clean content on window focus but preserves an unsaved buffer', async () => {
    load('original')
    render(<FileWorkspace {...props} />)
    await screen.findByLabelText('editor')
    load('external change')
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(screen.getByLabelText('editor')).toHaveValue('external change'))
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'my unsaved change' } })
    load('another external change')
    act(() => window.dispatchEvent(new Event('focus')))
    expect(screen.getByLabelText('editor')).toHaveValue('my unsaved change')
    expect(readEditableFile).toHaveBeenCalledTimes(2)
  })
  it('forces a network read for Reload and preserves preview mode on focus revalidation', async () => {
    load('original')
    render(<FileWorkspace {...props} />)
    await screen.findByLabelText('editor')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    load('latest')
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument())
    await screen.findByText('latest', { selector: 'div' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() =>
      expect(readEditableFile).toHaveBeenLastCalledWith(
        props.path,
        props.directory,
        props.serverId,
        expect.any(AbortSignal),
        { reload: true },
      ),
    )
  })

  it('previews the current unsaved HTML draft and keeps the editor mounted across mode switches', async () => {
    load('<h1>Original</h1>')
    vi.mocked(saveProjectFile).mockResolvedValue(undefined)
    render(<FileWorkspace {...props} path="index.html" />)
    const editor = await screen.findByLabelText('editor')
    fireEvent.change(editor, { target: { value: '<h1>Changed</h1>' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByTestId('html-preview')).toHaveTextContent('<h1>Changed</h1>')
    expect(screen.getByTestId('html-preview')).toHaveAttribute('data-server', 'server-b')
    expect(editor.closest('.hidden')).not.toBeNull()
    expect(saveProjectFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('editor')).toBe(editor)
    expect(editor).toHaveValue('<h1>Changed</h1>')
    fireEvent.click(screen.getByRole('button', { name: 'Save · Ctrl+S' }))
    await waitFor(() => expect(saveProjectFile).toHaveBeenCalledOnce())
    expect(new TextDecoder().decode(vi.mocked(saveProjectFile).mock.calls[0][1])).toBe('<h1>Changed</h1>')
  })
  it.each(['notes.txt', 'main.py', 'paper.tex', 'script.ts', 'settings.yaml'])(
    'does not offer a redundant source preview for %s',
    async path => {
      load('original text')
      render(<FileWorkspace {...props} path={path} />)
      await screen.findByLabelText('editor')
      expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save · Ctrl+S' })).toBeInTheDocument()
    },
  )
})
