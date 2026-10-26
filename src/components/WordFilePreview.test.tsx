import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { WordFilePreview } from './WordFilePreview'

describe('Word document preview', () => {
  it('renders a docx document locally into an isolated frame', async () => {
    const zip = new JSZip()
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    )
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文档预览测试</w:t></w:r></w:p></w:body></w:document>',
    )
    const base64 = await zip.generateAsync({ type: 'base64' })
    render(<WordFilePreview base64={base64} />)
    const frame = screen.getByTitle('Word document preview') as HTMLIFrameElement
    await waitFor(() => expect(frame.contentDocument?.body.textContent).toContain('文档预览测试'))
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(
      frame.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toContain("default-src 'none'")
  })
})
