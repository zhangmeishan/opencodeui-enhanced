import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectDialog } from './ProjectDialog'
import { getPath, listDirectory } from '../../api'

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}))

vi.mock('../../api', () => ({
  getPath: vi.fn().mockResolvedValue({ directory: '/workspace/project', home: '/home/user' }),
  listDirectory: vi.fn().mockResolvedValue([
    { name: '.config', type: 'directory', absolute: '/workspace/project/.config' },
    { name: 'src', type: 'directory', absolute: '/workspace/project/src' },
    { name: 'docs', type: 'directory', absolute: '/workspace/project/docs' },
  ]),
}))

describe('ProjectDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initializes from path api and loads directory entries', async () => {
    render(<ProjectDialog isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByDisplayValue('/workspace/project/')).toBeInTheDocument()
    expect(await screen.findByText('.config')).toBeInTheDocument()
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(await screen.findByText('docs')).toBeInTheDocument()

    expect(screen.getByText('Add current')).toBeInTheDocument()
  })

  it('reloads the same directory when reopened', async () => {
    const { rerender } = render(<ProjectDialog key="first" isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByText('src')).toBeInTheDocument()

    rerender(<ProjectDialog key="closed" isOpen={false} onClose={vi.fn()} onSelect={vi.fn()} />)
    rerender(<ProjectDialog key="second" isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() => expect(vi.mocked(getPath).mock.calls.length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(vi.mocked(listDirectory).mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(await screen.findByText('src')).toBeInTheDocument()
  })

  it('starts within the work directory and prevents navigation and typed paths outside it', async () => {
    const select = vi.fn()
    render(<ProjectDialog isOpen initialPath="/home/user" onClose={vi.fn()} onSelect={select} />)
    const input = await screen.findByDisplayValue('/workspace/project/')
    expect(screen.queryByText('.. (parent)')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: '/etc/' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add current' })).toBeDisabled()
    expect(await screen.findByText("Choose a directory within this server's working directory.")).toBeInTheDocument()
    expect(vi.mocked(listDirectory).mock.calls.some(([path]) => path === '/etc/')).toBe(false)
  })

  it('returns to the root but cannot go above it with the keyboard', async () => {
    render(<ProjectDialog isOpen initialPath="/workspace/project/src" onClose={vi.fn()} onSelect={vi.fn()} />)
    const input = await screen.findByDisplayValue('/workspace/project/src/')
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    await waitFor(() => expect(input).toHaveValue('/workspace/project/'))
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    expect(input).toHaveValue('/workspace/project/')
  })
})
