import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Header } from './Header'

const meta = vi.hoisted(() => ({
  sessionId: null as string | null,
  sessionTitle: 'New session',
  sessionDirectory: '/workspace',
}))
vi.mock('../../store', () => ({ useHeaderSessionMeta: () => meta, messageStore: {} }))
vi.mock('../../store/layoutStore', () => ({
  useLayoutStore: () => ({ rightPanelOpen: false, bottomPanelOpen: false }),
  layoutStore: {},
}))
vi.mock('../../contexts/useSessionContext', () => ({ useSessionContext: () => ({ refresh: vi.fn() }) }))
vi.mock('../../contexts/useDirectory', () => ({ useDirectory: () => ({ currentDirectory: '/workspace' }) }))
vi.mock('./chatViewport', () => ({
  useChatViewport: () => ({ presentation: { isCompact: false }, interaction: { sidebarBehavior: 'docked' } }),
}))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./ShareDialog', () => ({
  ShareDialog: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen && meta.sessionId ? (
      <div role="dialog">
        <button onClick={onClose}>Cancel sharing</button>
      </div>
    ) : null,
}))

const props = { models: [], modelsLoading: false, selectedModelKey: null, onModelChange: vi.fn() }

describe('session share entry', () => {
  beforeEach(() => {
    meta.sessionId = null
  })

  it('does not queue a share dialog before the first message creates a session', () => {
    const { rerender } = render(<Header {...props} />)
    const share = screen.getByRole('button', { name: 'Share session' })
    expect(share).toBeDisabled()
    fireEvent.click(share)
    meta.sessionId = 'server-b::created-on-send'
    rerender(<Header {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share session' })).toBeEnabled()
  })

  it('opens only explicitly, closes on cancel, and does not follow a different conversation', () => {
    meta.sessionId = 'server-b::session-1'
    const { rerender } = render(<Header {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share session' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sharing' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share session' }))
    meta.sessionId = 'server-a::session-2'
    rerender(<Header {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    meta.sessionId = 'server-b::session-1'
    rerender(<Header {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
