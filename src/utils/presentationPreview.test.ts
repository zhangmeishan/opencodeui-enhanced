import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { readPresentationPreview } from './presentationPreview'

describe('basic slide layout', () => {
  it('uses presentation order and preserves text positions, styles, images and dimensions', async () => {
    const zip = new JSZip()
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="two"/><p:sldId r:id="one"/></p:sldIdLst><p:sldSz cx="960000" cy="540000"/></p:presentation>',
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="two" Target="slides/slide2.xml"/><Relationship Id="one" Target="slides/slide1.xml"/></Relationships>',
    )
    for (const n of [1, 2])
      zip.file(
        `ppt/slides/slide${n}.xml`,
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="10000" y="20000"/><a:ext cx="300000" cy="80000"/></a:xfrm><a:solidFill><a:srgbClr val="ff0000"/></a:solidFill></p:spPr><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2400" b="1"/><a:t>Slide ${n}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm></p:spPr><a:blip r:embed="image"/></p:pic></p:spTree></p:cSld></p:sld>`,
      )
    zip.file(
      'ppt/slides/_rels/slide2.xml.rels',
      '<Relationships><Relationship Id="image" Target="../media/image.png"/></Relationships>',
    )
    zip.file('ppt/media/image.png', new Uint8Array([0, 1, 2]))
    const preview = await readPresentationPreview(await zip.generateAsync({ type: 'base64' }))
    expect(preview.width).toBe(960)
    expect(preview.height).toBe(540)
    expect(preview.slides[0].elements[0]).toMatchObject({
      x: 10,
      y: 20,
      width: 300,
      height: 80,
      fill: '#ff0000',
      paragraphs: [{ text: 'Slide 2', bold: true, align: 'center' }],
    })
    expect(preview.slides[0].elements[1].image).toBe('data:image/png;base64,AAEC')
    expect(preview.slides[1].elements[0].paragraphs?.[0].text).toBe('Slide 1')
  })
  it('rejects corrupt or unsupported archives', async () => {
    await expect(readPresentationPreview('not a zip')).rejects.toThrow()
    const zip = new JSZip()
    zip.file('irrelevant.txt', 'nothing')
    await expect(readPresentationPreview(await zip.generateAsync({ type: 'base64' }))).rejects.toThrow('No slides')
  })
})
