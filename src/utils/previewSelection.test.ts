import { describe, expect, it } from 'vitest'
import {
  mapDomSelection,
  mapFormattedSelection,
  mapHtmlPreviewSelection,
  registerPreviewSource,
} from './previewSelection'
import { renderMarkdownToHtml } from '../components/markdownHtmlRenderer'
import { EditorState } from '@codemirror/state'

function selectText(root: HTMLElement, text: string, occurrence = 0) {
  const walker = document.createTreeWalker(root, 4)
  let node: Node | null
  while ((node = walker.nextNode())) {
    let cursor = 0,
      at: number
    while ((at = node.textContent!.indexOf(text, cursor)) >= 0) {
      if (!occurrence--) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + text.length)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return selection
      }
      cursor = at + text.length
    }
  }
  throw new Error('Selection not found')
}

describe('rendered preview to original text ranges', () => {
  it('maps repeated Markdown link labels to the occurrence actually selected, excluding hidden destinations', () => {
    const text = '# Heading\n\n[repeat](https://repeat.example/repeat)\n\n**repeat** and end'
    const root = document.createElement('div')
    document.body.append(root)
    root.innerHTML = renderMarkdownToHtml(text, false)
    const cleanup = registerPreviewSource(root, { text, kind: 'markdown' })
    const selection = selectText(root, 'repeat', 1)
    expect(mapDomSelection(root, selection)).toEqual({
      text: 'repeat',
      startLine: 5,
      startColumn: 3,
      endLine: 5,
      endColumn: 9,
    })
    cleanup()
    root.remove()
  })
  it('maps formatted JSON to compact original columns, not pretty-print lines', () => {
    const text = '{"x":1,"message":"hello"}',
      displayed = JSON.stringify(JSON.parse(text), null, 2)
    const from = displayed.indexOf('hello')
    expect(mapFormattedSelection({ text, kind: 'json' }, displayed, from, from + 5)).toEqual({
      text: 'hello',
      startLine: 1,
      startColumn: 19,
      endLine: 1,
      endColumn: 24,
    })
  })
  it('maps HTML entities and duplicate text while ignoring markup, style and script contents', () => {
    const source = '<style>hello</style>\n<p title="hello">hello &amp; world</p>\n<p>hello</p>'
    const displayed = 'hello & worldhello'
    expect(mapHtmlPreviewSelection(source, displayed, 13, 18)).toEqual({
      text: 'hello',
      startLine: 3,
      startColumn: 4,
      endLine: 3,
      endColumn: 9,
    })
    expect(mapHtmlPreviewSelection(source, displayed, 6, 7)).toEqual({
      text: '&',
      startLine: 2,
      startColumn: 24,
      endLine: 2,
      endColumn: 29,
    })
  })
  it('rejects dynamic rendered content that does not match the original', () => {
    expect(mapHtmlPreviewSelection('<p>original</p>', 'generated', 0, 9)).toBeNull()
    expect(mapFormattedSelection({ text: '{"x":1}', kind: 'json' }, '{"x":2}', 5, 6)).toBeNull()
  })
  it('preserves both boundaries of selected leading and trailing whitespace', () => {
    const source = '**  repeat  **'
    // Plain HTML is used here to exercise literal spaces, without Markdown
    // emphasis parsing rules changing the chosen example.
    const html = '<pre>  repeat  </pre>'
    expect(mapHtmlPreviewSelection(html, '  repeat  ', 0, 10)).toEqual({
      text: '  repeat  ',
      startLine: 1,
      startColumn: 6,
      endLine: 1,
      endColumn: 16,
    })
    expect(mapFormattedSelection({ text: source, kind: 'source' }, source, 2, 12)).toEqual({
      text: '  repeat  ',
      startLine: 1,
      startColumn: 3,
      endLine: 1,
      endColumn: 13,
    })
  })
  it('does not erase JSON string whitespace to make a mismatched preview appear equivalent', () => {
    expect(
      mapFormattedSelection({ text: '{"message":"a b"}', kind: 'json' }, '{\n  "message": "ab"\n}', 16, 18),
    ).toBeNull()
    expect(mapFormattedSelection({ text: '{"message":"a  b"}', kind: 'json' }, '{"message":"a b"}', 12, 15)).toBeNull()
    expect(mapFormattedSelection({ text: '{"2":"x","1":"y"}', kind: 'json' }, '{"1":"y","2":"x"}', 6, 7)).toBeNull()
  })
  it('rejects formatting-only selection boundaries rather than silently trimming them', () => {
    const source = '{"x":1}',
      displayed = '{\n  "x": 1\n}'
    expect(mapFormattedSelection({ text: source, kind: 'json' }, displayed, 1, 4)).toBeNull()
    expect(mapFormattedSelection({ text: source, kind: 'json' }, displayed, -1, 5)).toBeNull()
    expect(mapFormattedSelection({ text: source, kind: 'json' }, displayed, 5, 500)).toBeNull()
  })
  it('never searches a later block for deindented Markdown children', () => {
    const source = '> repeated\n> text\n\nrepeated\ntext'
    const root = document.createElement('div')
    document.body.append(root)
    root.innerHTML = renderMarkdownToHtml(source, false)
    const cleanup = registerPreviewSource(root, { text: source, kind: 'markdown' })
    expect(mapDomSelection(root, selectText(root, 'repeated'))).toBeNull()
    cleanup()
    root.remove()
  })
  it('round-trips every character boundary for repeated HTML text, entities, Unicode and spaces', () => {
    const source = '<p> 中文😀 &amp; repeat </p><p>repeat</p>',
      displayed = ' 中文😀 & repeat repeat'
    const cases = [
      { needle: '中文😀', occurrence: 0, raw: '中文😀' },
      { needle: '&', occurrence: 0, raw: '&amp;' },
      { needle: 'repeat', occurrence: 0, raw: 'repeat' },
      { needle: 'repeat', occurrence: 1, raw: 'repeat' },
      { needle: ' repeat ', occurrence: 0, raw: ' repeat ' },
    ]
    for (const item of cases) {
      let at = -1,
        sourceAt = -1
      for (let count = 0; count <= item.occurrence; count++) {
        at = displayed.indexOf(item.needle, at + 1)
        sourceAt = source.indexOf(item.raw, sourceAt + 1)
      }
      const mapped = mapHtmlPreviewSelection(source, displayed, at, at + item.needle.length)!
      expect(mapped).not.toBeNull()
      expect(mapped.startColumn! - 1).toBe(sourceAt)
      expect(mapped.endColumn! - 1).toBe(sourceAt + item.raw.length)
      expect(source.slice(mapped.startColumn! - 1, mapped.endColumn! - 1)).toBe(item.raw)
    }
    // Selecting half of an entity-expanded emoji cannot express a source boundary.
    expect(mapHtmlPreviewSelection('<p>&#x1f600;</p>', '😀', 0, 1)).toBeNull()
  })
  it.each([
    ['plain repeated plain', 'plain', 1],
    ['# Header\n\n**repeat** and *repeat*', 'repeat', 1],
    ['[same](same) and same', 'same', 1],
    ['中文 **😀word** tail', '😀word', 0],
    ['first\n\nsecond `literal` tail', 'literal', 0],
    ['first\n\n~~remove~~ and remove', 'remove', 1],
    ['prefix [label][ref]\n\n[ref]: https://label', 'label', 0],
  ] as const)('verifies all substring boundaries for Markdown %s', (source, word, occurrence) => {
    const root = document.createElement('div')
    document.body.append(root)
    root.innerHTML = renderMarkdownToHtml(source, false)
    const cleanup = registerPreviewSource(root, { text: source, kind: 'markdown' })
    const selected = selectText(root, word, occurrence)
    const wordRange = selected.getRangeAt(0).cloneRange()
    const expected = mapDomSelection(root, selected)
    expect(expected).not.toBeNull()
    const offset = (line: number, column: number) =>
      source
        .split('\n')
        .slice(0, line - 1)
        .reduce((sum, item) => sum + item.length + 1, 0) +
      column -
      1
    const sourceStart = offset(expected!.startLine!, expected!.startColumn!)
    expect(source.slice(sourceStart, offset(expected!.endLine!, expected!.endColumn!))).toBe(word)
    for (let from = 0; from < word.length; from++)
      for (let to = from + 1; to <= word.length; to++) {
        const range = wordRange.cloneRange()
        range.setStart(wordRange.startContainer, wordRange.startOffset + from)
        range.setEnd(wordRange.startContainer, wordRange.startOffset + to)
        selected.removeAllRanges()
        selected.addRange(range)
        const mapped = mapDomSelection(root, selected)!
        expect(mapped).not.toBeNull()
        expect(offset(mapped.startLine!, mapped.startColumn!)).toBe(sourceStart + from)
        expect(offset(mapped.endLine!, mapped.endColumn!)).toBe(sourceStart + to)
        const editor = EditorState.create({ doc: source })
        const editorStart = editor.doc.lineAt(sourceStart + from),
          editorEnd = editor.doc.lineAt(sourceStart + to)
        expect([mapped.startLine, mapped.startColumn, mapped.endLine, mapped.endColumn]).toEqual([
          editorStart.number,
          sourceStart + from - editorStart.from + 1,
          editorEnd.number,
          sourceStart + to - editorEnd.from + 1,
        ])
      }
    cleanup()
    root.remove()
  })
})
