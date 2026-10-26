import JSZip from 'jszip'

const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export interface OfficePreviewSection {
  name: string
  rows: string[][]
  rowNumbers?: number[]
}
function xml(source: string) {
  if (/<!DOCTYPE/i.test(source)) throw new Error('Unsupported document')
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid document')
  return doc
}

/** Local, read-only content preview. No document editing service is contacted. */
export async function readOfficePreview(
  base64: string,
  path: string,
  options: { complete?: boolean } = {},
): Promise<OfficePreviewSection[]> {
  if (base64.length > 17 * 1024 * 1024) throw new Error('Document exceeds the preview limit')
  const zip = await JSZip.loadAsync(base64, { base64: true })
  const entries = Object.values(zip.files)
  const size = entries.reduce(
    (sum, entry) =>
      sum + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    0,
  )
  if (entries.length > 2000 || size > 32 * 1024 * 1024) throw new Error('Document exceeds the preview limit')
  if (/\.docx$/i.test(path)) {
    const part = zip.file('word/document.xml')
    if (!part) throw new Error('Invalid document')
    const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    const rows = Array.from(xml(await part.async('string')).getElementsByTagNameNS(ns, 'p'), paragraph => [
      Array.from(paragraph.getElementsByTagNameNS(ns, 't'), node => node.textContent || '').join(''),
    ])
    return [{ name: path.split(/[\\/]/).pop() || path, rows }]
  }
  if (/\.xlsx$/i.test(path)) {
    const stringsPart = zip.file('xl/sharedStrings.xml')
    const strings = stringsPart
      ? Array.from(
          xml(await stringsPart.async('string')).getElementsByTagNameNS(sheetNS, 'si'),
          node => node.textContent || '',
        )
      : []
    const workbookPart = zip.file('xl/workbook.xml')
    const relationsPart = zip.file('xl/_rels/workbook.xml.rels')
    const names = new Map<string, string>()
    if (workbookPart && relationsPart) {
      const relationships = Array.from(xml(await relationsPart.async('string')).getElementsByTagName('Relationship'))
      for (const sheet of Array.from(
        xml(await workbookPart.async('string')).getElementsByTagNameNS(sheetNS, 'sheet'),
      )) {
        const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
        const target = relationships.find(node => node.getAttribute('Id') === id)?.getAttribute('Target')
        if (target)
          names.set(
            target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`,
            sheet.getAttribute('name') || '',
          )
      }
    }
    const sections: OfficePreviewSection[] = []
    let contextSize = 0
    const sheetOrder = [...names.keys()]
    for (const entry of entries
      .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
      .sort((a, b) =>
        sheetOrder.length
          ? sheetOrder.indexOf(a.name) - sheetOrder.indexOf(b.name)
          : a.name.localeCompare(b.name, undefined, { numeric: true }),
      )
      .slice(0, options.complete ? undefined : 20)) {
      const doc = xml(await entry.async('string'))
      const sourceRows = Array.from(doc.getElementsByTagNameNS(sheetNS, 'row')).slice(
        0,
        options.complete ? undefined : 200,
      )
      const rows = sourceRows.map(row => {
        const values: string[] = []
        let nextColumn = 0
        for (const cell of Array.from(row.getElementsByTagNameNS(sheetNS, 'c'))) {
          const reference = cell.getAttribute('r')
          const column = reference?.match(/^[A-Z]+/)?.[0]
          let index = 0
          if (column) for (const char of column) index = index * 26 + char.charCodeAt(0) - 64
          else index = nextColumn + 1
          nextColumn = index
          if (index > (options.complete ? 16384 : 50)) continue
          const raw = cell.getElementsByTagNameNS(sheetNS, 'v')[0]?.textContent || ''
          const value = (
            cell.getAttribute('t') === 's'
              ? strings[Number(raw)] || ''
              : cell.getAttribute('t') === 'inlineStr'
                ? cell.getElementsByTagNameNS(sheetNS, 'is')[0]?.textContent || ''
                : raw
          ).slice(0, options.complete ? undefined : 10000)
          if (options.complete) {
            // Sparse sheets can put one cell in column XFD; do not expand
            // thousands of empty columns for every row in chat context.
            const text = `${reference || `${index}:${row.getAttribute('r') || ''}`}=${value}`
            contextSize += text.length
            if (contextSize > 2 * 1024 * 1024)
              throw new Error('Document context exceeds the size limit; select a smaller section')
            values.push(text)
          } else values[index - 1] = value
        }
        return Array.from({ length: Math.min(values.length, options.complete ? 16384 : 50) }, (_, i) => values[i] || '')
      })
      sections.push({
        name: names.get(entry.name) || entry.name.split('/').pop()!,
        rows,
        rowNumbers: sourceRows.map((row, index) => Number(row.getAttribute('r')) || index + 1),
      })
    }
    return sections
  }
  if (/\.pptx$/i.test(path)) {
    const sections: OfficePreviewSection[] = []
    const presentation = zip.file('ppt/presentation.xml')
    const relations = zip.file('ppt/_rels/presentation.xml.rels')
    let orderedPaths: string[] = []
    if (presentation && relations) {
      const links = Array.from(xml(await relations.async('string')).getElementsByTagName('Relationship'))
      orderedPaths = Array.from(
        xml(await presentation.async('string')).getElementsByTagNameNS(
          'http://schemas.openxmlformats.org/presentationml/2006/main',
          'sldId',
        ),
      )
        .map(node => {
          const id = node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
          const target = links.find(link => link.getAttribute('Id') === id)?.getAttribute('Target')
          return target ? (target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`) : ''
        })
        .filter(Boolean)
    }
    const slideEntries = orderedPaths.length
      ? orderedPaths.map(path => zip.file(path)).filter((entry): entry is JSZip.JSZipObject => !!entry)
      : entries
          .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const entry of slideEntries.slice(0, options.complete ? undefined : 100)) {
      const doc = xml(await entry.async('string'))
      const rows = Array.from(doc.getElementsByTagNameNS(drawingNS, 'p'))
        .slice(0, options.complete ? undefined : 200)
        .map(node => [
          Array.from(node.getElementsByTagNameNS(drawingNS, 't'), text => text.textContent || '')
            .join('')
            .slice(0, options.complete ? undefined : 10000),
        ])
        .filter(row => row[0])
      sections.push({ name: String(sections.length + 1), rows })
    }
    return sections
  }
  throw new Error('Unsupported preview format')
}
