import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficeDocumentPreview } from './OfficeDocumentPreview'
const read = vi.hoisted(() => vi.fn())
vi.mock('../api/previewCache', () => ({ readVerifiedFile: read }))

vi.mock('./OnlyOfficeEditor', () => ({
  OnlyOfficeEditor: ({
    mode,
    onPreview,
    onUnavailable,
  }: {
    mode: string
    onPreview: () => void
    onUnavailable: () => void
  }) => (
    <div>
      <span>Office mode: {mode}</span>
      <button onClick={onPreview}>Basic</button>
      <button onClick={onUnavailable}>Unavailable</button>
    </div>
  ),
}))
vi.mock('./PresentationPreview', () => ({ PresentationPreview: () => <div>Slide layout with images</div> }))
vi.mock('./OfficeFilePreview', () => ({ OfficeFilePreview: () => <div>Basic spreadsheet</div> }))

describe('Office document viewer', () => {
  beforeEach(() => {
    read.mockReset()
  })
  it('opens PPTX using the read-only document viewer and falls back to visual local slides', async () => {
    render(<OfficeDocumentPreview path="slides.pptx" base64="UEs=" directory="/project" serverId="remote" />)
    expect(await screen.findByText('Office mode: view')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Unavailable'))
    expect(await screen.findByText('Slide layout with images')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Office mode: view')).toBeInTheDocument()
  })
  it('supports the spreadsheet fallback without entering edit mode', async () => {
    render(<OfficeDocumentPreview path="budget.xlsx" base64="UEs=" directory="/project" serverId="remote" />)
    await screen.findByText('Office mode: view')
    fireEvent.click(screen.getByText('Basic'))
    expect(await screen.findByText('Basic spreadsheet')).toBeInTheDocument()
  })
  it('does not read the entire Office file until the user actually needs the local fallback', async () => {
    read.mockResolvedValue(new Uint8Array([1, 2, 3]))
    render(<OfficeDocumentPreview path="slides.pptx" directory="/project" serverId="remote" />)
    await screen.findByText('Office mode: view')
    expect(read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Unavailable'))
    await screen.findByText('Slide layout with images')
    expect(read).toHaveBeenCalledWith(
      'slides.pptx',
      '/project',
      'remote',
      expect.objectContaining({ maxBytes: 12 * 1024 * 1024 }),
    )
  })
  it('shows an actionable fallback error for oversized local previews while retaining retry', async () => {
    read.mockRejectedValue(new Error('too large'))
    render(<OfficeDocumentPreview path="slides.pptx" directory="/project" serverId="remote" />)
    await screen.findByText('Office mode: view')
    fireEvent.click(screen.getByText('Unavailable'))
    expect(await screen.findByRole('alert')).toHaveTextContent('limit: 12 MB')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
