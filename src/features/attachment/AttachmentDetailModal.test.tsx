import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentDetailModal } from './AttachmentDetailModal'
import type { Attachment } from './types'
import { FullscreenProvider } from '../../contexts'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { readFileBytes } from '../../api/fileDownload'
import { saveData } from '../../utils/downloadUtils'

vi.mock('../../api/fileDownload', () => ({ readFileBytes: vi.fn() }))
vi.mock('../../utils/downloadUtils', () => ({ saveData: vi.fn() }))

describe('AttachmentDetailModal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 0),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('stays mounted during close transition for text attachments', () => {
    const attachment: Attachment = {
      id: 'attachment-1',
      type: 'file',
      displayName: 'notes.txt',
      mime: 'text/plain',
      content: 'hello world',
    }

    const { rerender } = render(
      <FullscreenProvider>
        <AttachmentDetailModal attachment={attachment} isOpen={true} onClose={vi.fn()} />
      </FullscreenProvider>,
    )

    act(() => {
      vi.runAllTimers()
    })

    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText('hello world')).toBeInTheDocument()

    rerender(
      <FullscreenProvider>
        <AttachmentDetailModal attachment={attachment} isOpen={false} onClose={vi.fn()} />
      </FullscreenProvider>,
    )

    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(screen.getByText('notes.txt')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })

  it('exposes zoom controls with accessible labels for image attachments', () => {
    const attachment: Attachment = {
      id: 'attachment-2',
      type: 'file',
      displayName: 'diagram.png',
      mime: 'image/png',
      url: 'https://example.com/diagram.png',
    }

    render(
      <FullscreenProvider>
        <AttachmentDetailModal attachment={attachment} isOpen={true} onClose={vi.fn()} />
      </FullscreenProvider>,
    )

    const image = screen.getByAltText('diagram.png')
    fireEvent.load(image)

    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset (double-click / double-tap)' })).toBeInTheDocument()
  })

  it('retains the pane server in the global fullscreen download header', async () => {
    vi.mocked(readFileBytes).mockResolvedValue(new Uint8Array([0, 255]))
    vi.mocked(saveData).mockClear()
    render(
      <FullscreenProvider>
        <SessionNavigationContext.Provider value={{ navigateToSession: vi.fn(), currentSessionId: 'server-b::session-1', currentDirectory: '/workspace/b' }}>
          <AttachmentDetailModal attachment={{ id: 'pdf', type: 'file', displayName: 'report.pdf', mime: 'application/pdf', url: 'file:///workspace/b/report.pdf' }} isOpen onClose={vi.fn()} />
        </SessionNavigationContext.Provider>
      </FullscreenProvider>,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save to file' }))
    })
    expect(readFileBytes).toHaveBeenCalledWith('/workspace/b/report.pdf', '/workspace/b', 'server-b')
    expect(saveData).toHaveBeenCalledWith(new Uint8Array([0, 255]), 'report.pdf', 'application/pdf')
  })
})
