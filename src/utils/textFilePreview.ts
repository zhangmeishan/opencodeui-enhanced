export type TextPreviewKind = 'html' | 'svg' | 'markdown' | 'table' | 'json' | 'jsonl' | 'mermaid' | 'source'

export function textPreviewKind(path: string): TextPreviewKind {
  const extension = path.split('.').pop()?.toLowerCase()
  if (['html', 'htm', 'xhtml'].includes(extension || '')) return 'html'
  if (extension === 'svg') return 'svg'
  if (['md', 'markdown', 'mdown', 'mkd', 'mdx'].includes(extension || '')) return 'markdown'
  if (['csv', 'tsv'].includes(extension || '')) return 'table'
  if (extension === 'json' || extension === 'ipynb') return 'json'
  if (['jsonl', 'ndjson'].includes(extension || '')) return 'jsonl'
  if (['mmd', 'mermaid'].includes(extension || '')) return 'mermaid'
  return 'source'
}

/** Parse quoted fields, escaped quotes and embedded newlines without rendering unbounded tables. */
export function parseDelimitedPreview(text: string, delimiter: ',' | '\t', maxRows = 200, maxColumns = 50) {
  const rows: string[][] = []
  const ranges: { starts: number[]; ends: number[] }[][] = []
  let rowRanges: { starts: number[]; ends: number[] }[] = [],
    starts: number[] = [],
    ends: number[] = []
  let row: string[] = [],
    field = '',
    quoted = false,
    closedQuote = false,
    truncated = false
  let columnCount = 0,
    invalid = false
  const addField = () => {
    if (columnCount++ < maxColumns) {
      row.push(field)
      rowRanges.push({ starts, ends })
    } else truncated = true
    field = ''
    starts = []
    ends = []
    closedQuote = false
  }
  const addRow = () => {
    addField()
    rows.push(row)
    ranges.push(rowRanges)
    rowRanges = []
    row = []
    columnCount = 0
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          starts.push(i)
          ends.push(i + 2)
          i++
        } else {
          quoted = false
          closedQuote = true
        }
      } else {
        field += char
        starts.push(i)
        ends.push(i + 1)
      }
      continue
    }
    if (char === delimiter) addField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      addRow()
      if (rows.length >= maxRows) {
        truncated ||= i < text.length - 1
        return { rows, ranges, truncated, invalid }
      }
    } else if (char === '"' && field === '' && !closedQuote) quoted = true
    else {
      if (closedQuote) invalid = true
      field += char
      starts.push(i)
      ends.push(i + 1)
    }
  }
  if (field || row.length || columnCount || closedQuote || quoted) addRow()
  return { rows, ranges, truncated, invalid: invalid || quoted }
}

export function formatJsonPreview(text: string, lines = false): { text: string; invalid: boolean } {
  try {
    return {
      text: lines
        ? text
            .split(/\r?\n/)
            .filter(line => line.trim())
            .map(line => JSON.stringify(JSON.parse(line), null, 2))
            .join('\n\n')
        : JSON.stringify(JSON.parse(text), null, 2),
      invalid: false,
    }
  } catch {
    return { text, invalid: true }
  }
}
