import { describe, expect, it } from 'vitest'
import {
  fuzzyPreviewSelection,
  resolveDomPreviewSelection,
  resolveFormattedPreviewSelection,
  resolveHtmlPreviewSelection,
} from './fuzzyPreviewSelection'
import { registerPreviewSource } from './previewSelection'

describe('approximate preview selections', () => {
  it('preserves exact formatted and HTML positions without marking them fuzzy', () => {
    expect(resolveFormattedPreviewSelection({ text: '{"a":1}', kind: 'json' }, '{\n  "a": 1\n}', 9, 10)).toEqual({
      text: '1',
      startLine: 1,
      startColumn: 6,
      endLine: 1,
      endColumn: 7,
    })
    expect(resolveHtmlPreviewSelection('<p>hello</p>', 'hello', 0, 5)).toEqual({
      text: 'hello',
      startLine: 1,
      startColumn: 4,
      endLine: 1,
      endColumn: 9,
    })
  })
  it('relaxes case, punctuation and presentation whitespace but explicitly marks the range', () => {
    const result = fuzzyPreviewSelection('prefix\n**Hello**, _WORLD_!', 'hello world')
    expect(result).toEqual({
      text: 'hello world',
      fuzzy: true,
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 18,
    })
  })
  it('uses document order to find later repeated text, even beyond 128 occurrences', () => {
    const source = Array.from({ length: 200 }, () => '- repeat').join('\n')
    expect(fuzzyPreviewSelection(source, 'repeat', 1)).toMatchObject({ fuzzy: true, startLine: 200, startColumn: 3 })
  })
  it('permits small text differences in an approximate range', () => {
    const result = fuzzyPreviewSelection('the quick brown fox jumps', 'quick brwn fox')
    expect(result).toEqual({
      fuzzy: true,
      text: 'quick brwn fox',
      startLine: 1,
      startColumn: 5,
      endLine: 1,
      endColumn: 20,
    })
  })
  it('keeps generated text without inventing a range when there is no candidate', () => {
    expect(fuzzyPreviewSelection('original', 'generated')).toEqual({
      text: 'generated',
      fuzzy: true,
      location: expect.any(String),
    })
  })
  it('preserves UTF-16 coordinates around Chinese and emoji', () => {
    expect(fuzzyPreviewSelection('前缀\n**中文😀**', '中文😀')).toEqual({
      text: '中文😀',
      fuzzy: true,
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 7,
    })
  })
  it('falls back for dynamic HTML and transformed JSON text', () => {
    expect(resolveHtmlPreviewSelection('<p>hello</p><script>update()</script>', 'hello', 0, 5)).toMatchObject({
      text: 'hello',
      fuzzy: true,
      startColumn: 4,
    })
    expect(
      resolveFormattedPreviewSelection({ text: '{"a":"hello  world"}', kind: 'json' }, '{"a":"hello world"}', 6, 17),
    ).toMatchObject({
      text: 'hello world',
      fuzzy: true,
    })
  })
  it('rejects invalid offset ranges instead of guessing', () => {
    for (const [from, to] of [
      [-1, 3],
      [2, 2],
      [0, 10],
      [0.5, 2],
      [NaN, 2],
    ]) {
      expect(resolveHtmlPreviewSelection('<p>abc</p>', 'abc', from, to)).toBeNull()
      expect(resolveFormattedPreviewSelection({ text: 'abc', kind: 'json' }, 'abc', from, to)).toBeNull()
    }
  })
  it('uses DOM order for repeated words in unsupported Markdown lists and rejects selections outside the root', () => {
    const root = document.createElement('div')
    root.innerHTML = '<ul><li>repeat</li><li>repeat</li></ul>'
    document.body.append(root)
    const cleanup = registerPreviewSource(root, { kind: 'markdown', text: '- repeat\n- repeat' })
    const range = document.createRange()
    range.selectNodeContents(root.querySelectorAll('li')[1])
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(resolveDomPreviewSelection(root, selection)).toEqual({
      text: 'repeat',
      fuzzy: true,
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 9,
    })
    const outside = document.createTextNode('outside')
    document.body.append(outside)
    range.selectNodeContents(outside)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(resolveDomPreviewSelection(root, selection)).toBeNull()
    cleanup()
    root.remove()
    outside.remove()
    selection.removeAllRanges()
  })
})
