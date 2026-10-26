import type { ContextSelection } from './chatContext'
import type { TextPreviewKind } from './textFilePreview'
import { marked, type Token } from 'marked'

interface Projection {
  text: string
  starts: number[]
  ends: number[]
}
interface PreviewSource {
  text: string
  kind: TextPreviewKind
}
const sources = new WeakMap<HTMLElement, PreviewSource>()

export function registerPreviewSource(root: HTMLElement, source: PreviewSource) {
  sources.set(root, source)
  return () => {
    sources.delete(root)
  }
}

/** Same one-based UTF-16, end-exclusive coordinates as the editable CodeMirror document. */
export function sourceSelection(source: string, from: number, to: number, text: string): ContextSelection | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > source.length)
    return null
  const before = source.slice(0, from),
    through = source.slice(0, to)
  return {
    text,
    startLine: before.split('\n').length,
    startColumn: from - before.lastIndexOf('\n'),
    endLine: through.split('\n').length,
    endColumn: to - through.lastIndexOf('\n'),
  }
}

function literal(text: string, base = 0): Projection {
  return {
    text,
    starts: Array.from({ length: text.length }, (_, index) => base + index),
    ends: Array.from({ length: text.length }, (_, index) => base + index + 1),
  }
}

function htmlProjection(source: string, base = 0): Projection | null {
  // Executable/dynamic HTML cannot provide a stable correspondence to source.
  // Do not guess positions for DOM that scripts or event handlers can rewrite.
  if (/<(?:script|template|iframe|textarea|select)\b|\son[a-z]+\s*=|\bcontenteditable\s*=/i.test(source)) return null
  const result: Projection = { text: '', starts: [], ends: [] },
    chunks: string[] = []
  const append = (text: string, from: number, to: number) => {
    chunks.push(text)
    for (let index = 0; index < text.length; index++) {
      result.starts.push(base + from)
      result.ends.push(base + to)
    }
  }
  for (let offset = 0; offset < source.length; ) {
    if (/^<style\b/i.test(source.slice(offset, offset + 7))) {
      const style = /^<style\b[^>]*>[\s\S]*?<\/style\s*>/i.exec(source.slice(offset))
      if (!style) return null
      offset += style[0].length
      continue
    }
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4)
      if (end < 0) return null
      offset = end + 3
      continue
    }
    if (source[offset] === '<') {
      const tag = /^(?:<!doctype\s[^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>)/i.exec(source.slice(offset))
      if (!tag) return null
      offset += tag[0].length
      continue
    }
    if (source[offset] === '&') {
      const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/i.exec(source.slice(offset))
      if (!entity) return null // Semicolon-less entities are parser-context dependent.
      const decoder = document.createElement('textarea')
      decoder.innerHTML = entity[0]
      append(decoder.value, offset, offset + entity[0].length)
      offset += entity[0].length
      continue
    }
    append(source[offset], offset, offset + 1)
    offset++
  }
  result.text = chunks.join('')
  return result
}

function markdownProjection(source: string): Projection | null {
  const result: Projection = { text: '', starts: [], ends: [] },
    chunks: string[] = []
  const append = (value: Projection | null) => {
    if (!value) return false
    chunks.push(value.text)
    for (let index = 0; index < value.starts.length; index++) {
      result.starts.push(value.starts[index])
      result.ends.push(value.ends[index])
    }
    return true
  }
  const textProjection = (text: string, base: number): Projection | null => {
    // Decode entities, but do not treat literal text tokens as HTML markup.
    const escaped = /[<&]/.test(text)
    if (!escaped) return literal(text, base)
    const value: Projection = { text: '', starts: [], ends: [] },
      pieces: string[] = []
    for (let index = 0; index < text.length; ) {
      const entity = text[index] === '&' ? /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/i.exec(text.slice(index)) : null
      if (entity) {
        const decoder = document.createElement('textarea')
        decoder.innerHTML = entity[0]
        pieces.push(decoder.value)
        for (let j = 0; j < decoder.value.length; j++) {
          value.starts.push(base + index)
          value.ends.push(base + index + entity[0].length)
        }
        index += entity[0].length
      } else {
        pieces.push(text[index])
        value.starts.push(base + index)
        value.ends.push(base + index + 1)
        index++
      }
    }
    value.text = pieces.join('')
    return value
  }
  const inline = (tokens: Token[], raw: string, base: number): boolean => {
    let offset = 0
    for (const token of tokens) {
      // Token raw must consume exactly this parent, never search later source.
      if (!raw.startsWith(token.raw, offset)) return false
      const at = base + offset
      offset += token.raw.length
      if (token.type === 'image') continue
      if (token.type === 'br') continue
      if (token.type === 'html') {
        if (!append(htmlProjection(token.raw, at))) return false
        continue
      }
      if (token.type === 'text') {
        if (!append(textProjection(token.raw, at))) return false
      } else if (token.type === 'escape') {
        if (!('text' in token) || token.raw !== '\\' + token.text || !append(literal(String(token.text), at + 1)))
          return false
      } else if (token.type === 'codespan') {
        const fence = /^`+/.exec(token.raw)?.[0]
        if (!fence || !token.raw.endsWith(fence)) return false
        const inner = token.raw.slice(fence.length, -fence.length)
        // Code spans can normalize newlines/spaces. Only an exact inner match is safe.
        if (inner !== token.text || !append(literal(inner, at + fence.length))) return false
      } else if (token.type === 'link') {
        // Only explicit/referenced [label] links; autolinks are rejected conservatively.
        if (
          !token.raw.startsWith('[') ||
          !token.raw.startsWith(token.text, 1) ||
          token.raw[1 + token.text.length] !== ']'
        )
          return false
        if (!token.tokens || !inline(token.tokens, token.text, at + 1)) return false
      } else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
        const count = token.type === 'em' ? 1 : 2
        const marker = token.raw.slice(0, count)
        if (!token.raw.endsWith(marker) || token.raw.slice(count, -count) !== token.text) return false
        if (!token.tokens || !inline(token.tokens, token.text, at + count)) return false
      } else return false
    }
    return offset === raw.length
  }
  const blocks = (tokens: Token[], raw: string, base: number): boolean => {
    let offset = 0
    for (const token of tokens) {
      if (!raw.startsWith(token.raw, offset)) return false
      const at = base + offset
      offset += token.raw.length
      if (token.type === 'space' || token.type === 'def' || token.type === 'hr') continue
      if (token.type === 'paragraph' || token.type === 'text') {
        if (!('tokens' in token) || !token.tokens || !token.raw.startsWith(token.text)) return false
        if (!/^\s*$/.test(token.raw.slice(token.text.length)) || !inline(token.tokens, token.text, at)) return false
      } else if (token.type === 'heading') {
        const prefix = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(token.raw)
        if (!prefix || !token.raw.startsWith(token.text, prefix[0].length)) return false
        if (!token.tokens || !inline(token.tokens, token.text, at + prefix[0].length)) return false
      } else if (token.type === 'code') {
        const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw)
        if (!fence || !token.raw.startsWith(token.text, fence[0].length)) return false
        if (!append(literal(token.text, at + fence[0].length))) return false
      } else if (token.type === 'html') {
        if (!append(htmlProjection(token.raw, at))) return false
      } else return false // Deindented lists, blockquotes, tables and math need explicit source maps.
    }
    return offset === raw.length
  }
  if (!blocks(marked.lexer(source), source, 0)) return null
  result.text = chunks.join('')
  return result
}

function projection(source: string, kind: TextPreviewKind): Projection | null {
  if (kind === 'markdown') return markdownProjection(source)
  if (kind === 'html' || kind === 'svg') return htmlProjection(source)
  // CSV/TSV positions come from parser-generated cell spans, never by erasing delimiters.
  if (kind === 'table' || kind === 'mermaid') return null
  return literal(source)
}

/** Align only non-space characters in order. Source gaps retain their actual whitespace. */
function align(original: Projection, displayed: string, json = false): Projection | null {
  const result: Projection = {
    text: displayed,
    starts: new Array(displayed.length).fill(-1),
    ends: new Array(displayed.length).fill(-1),
  }
  const significant = (text: string) => {
    const indexes: number[] = []
    let string = false,
      escaped = false
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (!/\s/.test(char) || (json && string)) indexes.push(index)
      if (json) {
        if (char === '"' && !escaped) string = !string
        escaped = string && char === '\\' && !escaped
      }
    }
    return indexes
  }
  const a = significant(original.text),
    b = significant(displayed)
  if (a.length !== b.length || a.some((offset, index) => original.text[offset] !== displayed[b[index]])) return null
  for (let index = 0; index < a.length; index++) {
    result.starts[b[index]] = original.starts[a[index]]
    result.ends[b[index]] = original.ends[a[index]]
  }
  // Preserve selectable whitespace only for runs with identical actual source
  // characters; formatting-only whitespace has no source location.
  for (let index = 0; index <= a.length; index++) {
    const aFrom = index ? a[index - 1] + 1 : 0,
      aTo = index < a.length ? a[index] : original.text.length
    const bFrom = index ? b[index - 1] + 1 : 0,
      bTo = index < b.length ? b[index] : displayed.length
    if (original.text.slice(aFrom, aTo) !== displayed.slice(bFrom, bTo)) continue
    for (let j = 0; j < bTo - bFrom; j++) {
      result.starts[bFrom + j] = original.starts[aFrom + j]
      result.ends[bFrom + j] = original.ends[aFrom + j]
    }
  }
  return result
}

function mappedSelection(
  source: string,
  map: Projection,
  from: number,
  to: number,
  text: string,
): ContextSelection | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > map.text.length)
    return null
  if (map.starts[from] < 0 || map.ends[to - 1] < 0) return null
  // A partial decoded entity/surrogate expansion does not have an exact source boundary.
  if (from > 0 && map.starts[from] === map.starts[from - 1]) return null
  if (to < map.text.length && map.ends[to - 1] === map.ends[to]) return null
  return sourceSelection(source, map.starts[from], map.ends[to - 1], text)
}

export function mapFormattedSelection(
  source: PreviewSource,
  displayed: string,
  from: number,
  to: number,
): ContextSelection | null {
  if (displayed === source.text) return sourceSelection(source.text, from, to, displayed.slice(from, to))
  const original = projection(source.text, source.kind)
  if (!original) return null
  const map = align(original, displayed, source.kind === 'json' || source.kind === 'jsonl')
  return map ? mappedSelection(source.text, map, from, to, displayed.slice(from, to)) : null
}

function previewTextNodes(root: Node): Text[] {
  const doc = root.ownerDocument || document,
    walker = doc.createTreeWalker(root, 4),
    nodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (
      !parent ||
      parent.closest(
        'script,style,template,button,[role="status"],[role="alert"],.sr-only,.cm-gutters,.cm-announced,[aria-hidden="true"]',
      )
    )
      continue
    nodes.push(node as Text)
  }
  return nodes
}

export function mapDomSelection(root: HTMLElement, selection: Selection): ContextSelection | null {
  const source = sources.get(root)
  if (!source || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const cell = (
    range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement
  )?.closest<HTMLElement>('[data-source-from]')
  if (cell && cell.contains(range.endContainer)) {
    const decoded = cell.textContent || ''
    // Quoted/escaped cells require the parser's per-character offsets.
    const offsets = cellOffsets.get(cell)
    if (!offsets || offsets.text !== decoded || offsets.source !== source.text) return null
    return domRange(root, range, selection.toString(), offsets.map, cell, source.text)
  }
  const original = projection(source.text, source.kind)
  if (!original) return null
  const nodes = previewTextNodes(root),
    displayed = nodes.map(node => node.data).join('')
  const map = align(original, displayed)
  return map ? domRange(root, range, selection.toString(), map, root, source.text) : null
}

function domRange(
  _root: HTMLElement,
  range: Range,
  text: string,
  map: Projection,
  mappedRoot: HTMLElement,
  source: string,
) {
  const nodes = previewTextNodes(mappedRoot)
  const offsetAt = (container: Node, offset: number) => {
    const point = mappedRoot.ownerDocument.createRange()
    point.setStart(container, offset)
    point.collapse(true)
    let length = 0
    for (const node of nodes) {
      if (node === container) return length + offset
      const start = mappedRoot.ownerDocument.createRange()
      start.setStart(node, 0)
      start.collapse(true)
      if (point.compareBoundaryPoints(0, start) <= 0) return length
      length += node.length
    }
    return length
  }
  const from = offsetAt(range.startContainer, range.startOffset),
    to = offsetAt(range.endContainer, range.endOffset)
  if (text.replace(/\s/g, '') !== map.text.slice(from, to).replace(/\s/g, '')) return null
  return mappedSelection(source, map, from, to, text)
}

const cellOffsets = new WeakMap<HTMLElement, { text: string; source: string; map: Projection }>()
export function registerCellSource(
  element: HTMLElement,
  source: string,
  text: string,
  starts: number[],
  ends: number[],
) {
  cellOffsets.set(element, { text, source, map: { text, starts, ends } })
}
export function previewRoot(element: Element | null) {
  return element?.closest<HTMLElement>('[data-text-file-preview]') || null
}
export function previewSource(root: HTMLElement) {
  return sources.get(root)
}
export function mapHtmlPreviewSelection(source: string, displayed: string, from: number, to: number) {
  const original = htmlProjection(source)
  if (!original) return null
  const map = align(original, displayed)
  return map ? mappedSelection(source, map, from, to, displayed.slice(from, to)) : null
}
