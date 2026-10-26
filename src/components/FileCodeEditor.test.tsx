import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileCodeEditor } from './FileCodeEditor'

describe('code editing', () => {
  it.each([
    ['main.py', 'def hello():\n    return 42\n'],
    ['main.ts', 'const answer: number = 42\n'],
    ['paper.tex', '\\section{Test}\n\\textbf{hello}\n'],
  ])('loads language highlighting for %s and supports Ctrl+S', async (path, value) => {
    const save = vi.fn()
    const { container } = render(<FileCodeEditor value={value} path={path} onChange={vi.fn()} onSave={save} />)
    await waitFor(() => expect(container.querySelector('.cm-content span')).toBeTruthy())
    const editor = screen.getByLabelText(path)
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    expect(save).toHaveBeenCalledOnce()
    expect(container.querySelector('.cm-lineNumbers')).toBeInTheDocument()
  })
})
