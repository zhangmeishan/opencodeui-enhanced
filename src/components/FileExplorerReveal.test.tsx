import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from './FileExplorer'

const { listDirectory } = vi.hoisted(() => ({ listDirectory: vi.fn() }))
vi.mock('../hooks', async () => ({ useFileExplorer: (await import('../hooks/useFileExplorer')).useFileExplorer }))
vi.mock('../hooks/useAutoRefresh', () => ({ useAutoRefresh: () => {} }))
vi.mock('../hooks/useWorkspaceRoot', () => ({ useWorkspaceRoot: () => '/repo' }))
vi.mock('../api', () => ({
  listDirectory,
  getFileStatus: vi.fn(async () => []),
  getFileContent: vi.fn(),
  getSessionDiff: vi.fn(),
  getLastTurnDiff: vi.fn(),
  getVcsDiff: vi.fn(),
}))

describe('file reveal with actual asynchronous directory loading', () => {
  beforeEach(() => {
    listDirectory.mockReset().mockImplementation(async (path: string) => {
      if (!path) return [{ name: 'src', path: 'src', absolute: '/repo/src', type: 'directory' }]
      if (path === 'src')
        return [{ name: 'nested', path: 'src/nested', absolute: '/repo/src/nested', type: 'directory' }]
      if (path === 'src/nested')
        return [
          { name: 'report.pdf', path: 'src/nested/report.pdf', absolute: '/repo/src/nested/report.pdf', type: 'file' },
        ]
      return []
    })
  })
  it('waits for ancestors to arrive before expanding deeper folders and highlights the final file', async () => {
    render(
      <FileExplorer
        mode="tree"
        panelTabId="sidebar-files"
        directory="/repo"
        serverId="remote"
        previewFile={null}
        previewFiles={[]}
        revealRevision={1}
        revealFile={{ path: 'src/nested/report.pdf', name: 'report.pdf', directory: '/repo', serverId: 'remote' }}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'report.pdf' })).toHaveAttribute('aria-current', 'true'),
    )
    expect(listDirectory).toHaveBeenCalledWith('src', '/repo', 'remote')
    expect(listDirectory).toHaveBeenCalledWith('src/nested', '/repo', 'remote')
    expect(listDirectory.mock.calls.filter(([path]) => path === '')).toHaveLength(2)
  })
})
