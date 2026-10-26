import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentItem } from './AttachmentItem'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { selectionAttachment } from '../../utils/chatContext'
import { AttachmentPreview } from './AttachmentPreview'

const actions = vi.hoisted(() => ({ open: vi.fn(), contextMenu: vi.fn() }))
vi.mock('./useChatFileActions', () => ({ useChatFileActions: () => ({ ...actions, controls: null }) }))
vi.mock('./AttachmentDetailModal', () => ({ AttachmentDetailModal: () => null }))
const file = {
  id: 'file',
  type: 'file' as const,
  displayName: 'report.pdf',
  mime: 'application/pdf',
  url: 'file:///workspace/report.pdf',
}
describe('message file cards', () => {
  beforeEach(() => vi.clearAllMocks())
  it('opens a workspace file by left click and exposes the file context menu on right click', () => {
    render(
      <SessionNavigationContext.Provider
        value={{ navigateToSession: vi.fn(), currentSessionId: 'remote::session', currentDirectory: '/workspace' }}
      >
        <AttachmentItem attachment={file} expandable />
      </SessionNavigationContext.Provider>,
    )
    const card = screen.getByRole('button', { name: 'report.pdf' })
    fireEvent.click(card)
    expect(actions.open).toHaveBeenCalledWith(file.url)
    fireEvent.contextMenu(card)
    expect(actions.contextMenu).toHaveBeenCalledWith(expect.anything(), file.url)
  })
  it('keeps draft attachment removal and inspection separate from opening a project file', () => {
    const onRemove = vi.fn()
    render(
      <SessionNavigationContext.Provider value={{ navigateToSession: vi.fn(), currentSessionId: 'remote::session' }}>
        <AttachmentItem attachment={file} onRemove={onRemove} />
      </SessionNavigationContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    expect(onRemove).toHaveBeenCalledWith(file.id)
    expect(actions.open).not.toHaveBeenCalled()
  })
  it('shows only a compact file/range reference until the user explicitly expands selected text', async () => {
    const attachment = selectionAttachment(
      { path: 'src/code.ts', directory: '/project', serverId: 'remote' },
      { text: 'const total = subtotal + tax;', startLine: 12, startColumn: 3, endLine: 12, endColumn: 32 },
    )
    render(<AttachmentPreview attachments={[attachment]} variant="rail" onRemove={vi.fn()} />)
    expect(screen.getByText('Selection')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Selection.*L12:C3–L12:C32/ })).toBeInTheDocument()
    expect(screen.getByText('Selection')).toHaveClass('sr-only')
    expect(screen.queryByText('const total = subtotal + tax;')).not.toBeInTheDocument()
    expect(screen.getByText('code.ts:12:3-12:32')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Selection.*code.ts/ }))
    await waitFor(() => expect(screen.getByText(/Source: src\/code.ts:12:3-12:32/)).toBeInTheDocument())
    expect(screen.getByText(/Source: src\/code.ts:12:3-12:32/)).toHaveTextContent('const total = subtotal + tax;')
    expect(actions.open).not.toHaveBeenCalled()
  })
})
