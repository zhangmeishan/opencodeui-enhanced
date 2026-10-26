import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { readOfficePreview } from '../utils/officePreview'

describe('local read-only Office previews', () => {
  it('extracts spreadsheet cells with shared strings and preserves empty columns', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/sharedStrings.xml',
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>报告</t></si></sst>',
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>',
    )
    const sections = await readOfficePreview(await zip.generateAsync({ type: 'base64' }), 'report.xlsx')
    expect(sections[0].rows[0]).toEqual(['报告', '', '42'])
  })
  it('extracts slide text in numeric page order', async () => {
    const zip = new JSZip()
    for (const number of [10, 2])
      zip.file(
        `ppt/slides/slide${number}.xml`,
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>Slide ${number}</a:t></a:r></a:p></p:cSld></p:sld>`,
      )
    const sections = await readOfficePreview(await zip.generateAsync({ type: 'base64' }), 'slides.pptx')
    expect(sections.map(section => section.rows[0][0])).toEqual(['Slide 2', 'Slide 10'])
  })

  it('keeps sparse spreadsheet row numbers and includes later rows in complete chat context', async () => {
    const zip = new JSZip()
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    const rows = Array.from(
      { length: 205 },
      (_, index) =>
        `<row r="${index + 10}"><c r="C${index + 10}" t="inlineStr"><is><t>value ${index}</t></is></c></row>`,
    ).join('')
    zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${ns}"><sheetData>${rows}</sheetData></worksheet>`)
    const base64 = await zip.generateAsync({ type: 'base64' })
    const preview = await readOfficePreview(base64, 'budget.xlsx')
    expect(preview[0].rows).toHaveLength(200)
    expect(preview[0].rowNumbers?.[0]).toBe(10)
    const context = await readOfficePreview(base64, 'budget.xlsx', { complete: true })
    expect(context[0].rows).toHaveLength(205)
    expect(context[0].rows.at(-1)).toEqual(['C214=value 204'])
  })
})
