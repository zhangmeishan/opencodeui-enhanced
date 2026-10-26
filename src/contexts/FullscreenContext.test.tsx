import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FullscreenProvider } from './FullscreenContext'
import { useFullscreen } from './useFullscreen'
import { layoutStore } from '../store/layoutStore'

vi.mock('../components/FullscreenViewer', () => ({
  FullscreenViewer: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}))
function OpenFile() {
  const { openFullscreen } = useFullscreen()
  return (
    <button type="button" onClick={() => openFullscreen({ id: 'image', content: <div>Server A image</div> })}>
      Open image
    </button>
  )
}
describe('fullscreen service scope', () => {
  afterEach(() => vi.restoreAllMocks())
  it('removes the old service fullscreen content immediately when switching services', () => {
    layoutStore.activateServerScope('fullscreen-a')
    render(
      <FullscreenProvider>
        <OpenFile />
      </FullscreenProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
    expect(screen.getByText('Server A image')).toBeInTheDocument()
    act(() => layoutStore.activateServerScope('fullscreen-b'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
