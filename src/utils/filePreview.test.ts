import { describe, expect, it } from 'vitest'
import { isEditableFile, validateImagePreview } from './filePreview'

describe('file preview limits and editability', () => {
  it.each(['main.py', 'paper.tex', 'README.md', 'Dockerfile'])('supports editing %s', path => {
    expect(isEditableFile(path)).toBe(true)
  })
  it.each(['image.png', 'report.pdf', 'old.doc', 'archive.zip', 'data.xlsx', 'slides.pptx'])(
    'keeps %s out of the text editor',
    path => {
      expect(isEditableFile(path)).toBe(false)
    },
  )
  it('rejects PNGs with enormous decoded dimensions before passing them to the image decoder', () => {
    const bytes = new Uint8Array(33)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(bytes.buffer)
    view.setUint32(16, 30000)
    view.setUint32(20, 30000)
    expect(() => validateImagePreview(btoa(String.fromCharCode(...bytes)), 'large.png')).toThrow(/dimensions/)
  })
})
