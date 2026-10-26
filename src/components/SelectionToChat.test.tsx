import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { FileContextBoundary } from './FileContextBoundary'
import { FileCodeEditor } from './FileCodeEditor'
import { registerChatContextReceiver } from '../utils/chatContext'
import { AttachmentPreview } from '../features/attachment/AttachmentPreview'
import type { Attachment } from '../features/attachment/types'
import { contextAttachmentFromText } from '../utils/contextSnapshot'

const scope = vi.hoisted(() => ({ focusedPaneId: 'chat-pane', focusedSessionId: 'remote::session' }))
vi.mock('../store/paneLayoutStore', () => ({ paneLayoutStore: { getSnapshot: () => scope } }))
vi.mock('../features/attachment/AttachmentDetailModal', () => ({ AttachmentDetailModal: () => null }))
vi.mock('../features/attachment/useChatFileActions', () => ({ useChatFileActions: () => ({ controls: null }) }))

function Harness() {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  useEffect(
    () =>
      registerChatContextReceiver('chat-pane', attachment => {
        setAttachments(previous => [...previous, attachment])
        return true
      }),
    [],
  )
  return (
    <>
      <FileContextBoundary source={{ path: 'src/code.ts', directory: '/project', serverId: 'remote' }}>
        <FileCodeEditor
          path="src/code.ts"
          value={'const one = 1;\nconst two = 2;\n'}
          onChange={vi.fn()}
          onSave={vi.fn()}
        />
      </FileContextBoundary>
      <AttachmentPreview
        attachments={attachments}
        variant="rail"
        onRemove={id => setAttachments(previous => previous.filter(attachment => attachment.id !== id))}
      />
      <button
        onClick={() =>
          setAttachments(attachments.map(attachment => contextAttachmentFromText(attachment.content!, attachment.id)!))
        }
      >
        Restore sent reference
      </button>
    </>
  )
}

describe('editor selection → chat reference integration', () => {
  beforeEach(() => {
    scope.focusedSessionId = 'remote::session'
  })
  it('captures unsaved text and columns, previews the exact excerpt and preserves it after restore', async () => {
    const { container } = render(<Harness />)
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    act(() => view.dispatch({ changes: { from: 27, to: 28, insert: '99' }, selection: { anchor: 21, head: 29 } }))
    const selected = view.state.sliceDoc(21, 29)
    fireEvent.contextMenu(container.querySelector('.cm-content')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add selection to chat' }))
    expect(await screen.findByText('Selection')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /L2:C7–L2:C15/ })).toBeInTheDocument()
    expect(screen.queryByText(selected)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore sent reference' }))
    expect(screen.getByRole('button', { name: /L2:C7–L2:C15/ })).toBeInTheDocument()
    expect(screen.queryByText(selected)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Selection.*code.ts/ }))
    await waitFor(() => expect(screen.getByText(/Source: src\/code.ts/)).toHaveTextContent(selected.trim()))
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    await waitFor(() => expect(screen.queryByText('Selection')).not.toBeInTheDocument())
  })
  it('does not add a stale context menu selection to a different conversation', async () => {
    const { container } = render(<Harness />)
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }))
    fireEvent.contextMenu(container.querySelector('.cm-content')!)
    scope.focusedSessionId = 'remote::other'
    fireEvent.click(screen.getByRole('menuitem'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add context')
    expect(screen.queryByText('Selection')).not.toBeInTheDocument()
  })
})
