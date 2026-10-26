import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TransferProgressBar } from './TransferProgressBar'

describe('transfer progress display', () => {
  it('shows bytes, percentage and success on the same progress bar', () => {
    const { rerender } = render(
      <TransferProgressBar label="Upload report.pdf" progress={{ loaded: 512, total: 1024, phase: 'transferring' }} />,
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText(/512 B \/ 1.0 KB/)).toBeInTheDocument()
    rerender(
      <TransferProgressBar label="Upload report.pdf" progress={{ loaded: 1024, total: 1024, phase: 'completed' }} />,
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('status')).toHaveTextContent('Transfer complete')
  })
  it('shows indeterminate progress without inventing a percentage and distinguishes failure', () => {
    const { rerender } = render(
      <TransferProgressBar label="Download report" progress={{ loaded: 500, phase: 'transferring' }} />,
    )
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    rerender(<TransferProgressBar label="Download report" progress={{ loaded: 500, phase: 'failed' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Transfer failed')
  })
})
