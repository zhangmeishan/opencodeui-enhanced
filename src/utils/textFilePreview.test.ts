import { describe, expect, it } from 'vitest'
import { formatJsonPreview, parseDelimitedPreview, textPreviewKind } from './textFilePreview'
import { isEditableFile } from './filePreview'
import { detectLanguage } from './languageUtils'

describe('text file preview formats', () => {
  it.each([
    ['page.HTML', 'html'],
    ['page.htm', 'html'],
    ['page.xhtml', 'html'],
    ['diagram.svg', 'svg'],
    ['README.markdown', 'markdown'],
    ['README.mkd', 'markdown'],
    ['app.mdx', 'markdown'],
    ['data.csv', 'table'],
    ['data.tsv', 'table'],
    ['package.json', 'json'],
    ['records.jsonl', 'jsonl'],
    ['data.ndjson', 'jsonl'],
    ['diagram.mmd', 'mermaid'],
    ['paper.tex', 'source'],
    ['main.py', 'source'],
    ['app.vue', 'source'],
    ['settings.yaml', 'source'],
    ['notes.txt', 'source'],
  ])('provides the correct preview for %s', (path, kind) => {
    expect(isEditableFile(path)).toBe(true)
    expect(textPreviewKind(path)).toBe(kind)
  })
  it('parses CSV quotes, multiline fields, escaped quotes and trailing empty columns', () => {
    expect(parseDelimitedPreview('name,value,note\r\n"a,b","line1\nline2","say ""hello"""\r\nx,3,', ',').rows).toEqual([
      ['name', 'value', 'note'],
      ['a,b', 'line1\nline2', 'say "hello"'],
      ['x', '3', ''],
    ])
  })
  it('bounds tabular rows and columns and flags malformed quoting', () => {
    const limited = parseDelimitedPreview('a\tb\tc\n1\t2\t3\n4\t5\t6', '\t', 2, 2)
    expect(limited.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(limited.truncated).toBe(true)
    expect(parseDelimitedPreview('"unfinished', ',').invalid).toBe(true)
    expect(parseDelimitedPreview('"closed"invalid', ',').invalid).toBe(true)
    expect(parseDelimitedPreview('', ',').rows).toEqual([])
  })
  it('formats JSON only for presentation and falls back for invalid JSON', () => {
    expect(formatJsonPreview('{"x":1}')).toEqual({ text: '{\n  "x": 1\n}', invalid: false })
    expect(formatJsonPreview('{incomplete')).toEqual({ text: '{incomplete', invalid: true })
    expect(formatJsonPreview('{"x":1}\n\n{"x":2}', true).invalid).toBe(false)
  })
  it('recognizes missing language aliases', () => {
    expect(detectLanguage('index.htm')).toBe('html')
    expect(detectLanguage('icon.svg')).toBe('xml')
    expect(detectLanguage('config.jsonc')).toBe('jsonc')
    expect(detectLanguage('main.mjs')).toBe('javascript')
  })
})
