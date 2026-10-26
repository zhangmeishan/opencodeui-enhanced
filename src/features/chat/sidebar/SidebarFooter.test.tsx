import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarFooter } from './SidebarFooter'

const meta = vi.hoisted(() => ({ sessionId: null as string | null }))
vi.mock('../../../store', () => ({ useHasMessages: () => false, useShareSessionMeta: () => meta }))
vi.mock('../../../hooks', () => ({
  useTheme: () => ({ mode: 'light', setThemeWithAnimation: vi.fn(), isWideMode: false, toggleWideMode: vi.fn() }),
  useSessionStats: () => ({ contextUsed: 0, contextLimit: 1000, totalCost: 0, contextPercent: 0 }),
  formatTokens: () => '0',
  formatCost: () => '0',
}))
vi.mock('./ContextDetailsDialog', () => ({ ContextDetailsDialog: () => null }))
vi.mock('../ShareDialog', () => ({
  ShareDialog: ({ isOpen }: { isOpen: boolean }) => (isOpen && meta.sessionId ? <div role="dialog">Share</div> : null),
}))

describe('sidebar sharing', () => {
  beforeEach(() => {
    meta.sessionId = null
  })

  it('does not defer sharing until a session is created by sending a message', async () => {
    const { rerender } = render(<SidebarFooter showLabels connectionState="connected" />)
    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[0])
    const share = screen.getByRole('button', { name: 'Share Chat' })
    expect(share).toBeDisabled()
    fireEvent.click(share)
    meta.sessionId = 'server-b::new-session'
    await act(async () => {
      rerender(<SidebarFooter showLabels connectionState="connected" />)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
