import type { ContextSelection } from './chatContext'
import {
  mapDomSelection,
  mapFormattedSelection,
  mapHtmlPreviewSelection,
  previewSource,
  sourceSelection,
} from './previewSelection'

/** Approximation is explicit even when the relaxed search finds a literal match. */
export function fuzzyPreviewSelection(source: string, text: string, relativePosition = 0): ContextSelection {
  const unknown: ContextSelection = { text, fuzzy: true, location: '模糊匹配：未找到可靠原文范围' }
  if (!source || !text.trim()) return unknown
  // Bounded relaxed normalization: ignore presentation punctuation/whitespace,
  // retain original offsets, and never parse or execute rendered content.
  const normalize = (input: string, offsets = false) => {
    const chunks: string[] = [],
      starts: number[] = [],
      ends: number[] = []
    for (let index = 0; index < input.length; ) {
      const point = input.codePointAt(index)!,
        char = String.fromCodePoint(point)
      if (/[\p{L}\p{N}\p{S}]/u.test(char)) {
        const value = char.toLowerCase()
        chunks.push(value)
        if (offsets)
          for (let unit = 0; unit < value.length; unit++) {
            starts.push(index)
            ends.push(index + char.length)
          }
      }
      index += char.length
    }
    return { text: chunks.join(''), starts, ends }
  }
  // Keep memory and work bounded on very large documents/selections.
  if (source.length > 2 * 1024 * 1024 || text.length > 8192) return unknown
  const original = normalize(source, true),
    selected = normalize(text)
  if (!selected.text) return unknown
  const hint = Math.max(0, Math.min(1, Number.isFinite(relativePosition) ? relativePosition : 0))
  const candidates: { from: number; to: number; score: number }[] = []
  let nearest = -1
  let cursor = 0
  for (;;) {
    const at = original.text.indexOf(selected.text, cursor)
    if (at < 0) break
    if (nearest < 0 || Math.abs(at / original.text.length - hint) < Math.abs(nearest / original.text.length - hint))
      nearest = at
    cursor = at + 1
  }
  if (nearest >= 0) candidates.push({ from: nearest, to: nearest + selected.text.length, score: 1 })
  if (!candidates.length && selected.text.length >= 6) {
    // Match runs around the beginning, middle and end, allowing rendering gaps
    // or small text differences within a bounded local window.
    const length = Math.min(16, Math.max(3, Math.floor(selected.text.length / 4)))
    const anchors = [0, Math.floor((selected.text.length - length) / 2), selected.text.length - length]
    const starts = new Set<number>()
    for (const position of anchors) {
      let at = Math.max(0, Math.floor(hint * original.text.length) - selected.text.length * 4)
      for (let count = 0; count < 32; count++) {
        const found = original.text.indexOf(selected.text.slice(position, position + length), at)
        if (found < 0) break
        starts.add(Math.max(0, found - position))
        at = found + length
      }
      // Also search the start of the document when markup makes the position hint drift.
      const first = original.text.indexOf(selected.text.slice(position, position + length))
      if (first >= 0) starts.add(Math.max(0, first - position))
    }
    for (const guess of starts) {
      const from = Math.max(0, guess - length),
        to = Math.min(original.text.length, guess + selected.text.length * 2 + length)
      const window = original.text.slice(from, to)
      let at = 0,
        matched = 0,
        first = -1,
        last = -1
      for (const char of selected.text) {
        const found = window.indexOf(char, at)
        if (found < 0) continue
        first = first < 0 ? from + found : first
        last = from + found + char.length
        matched += char.length
        at = found + char.length
      }
      const score = matched / selected.text.length
      if (score >= 0.7 && first >= 0 && last - first <= selected.text.length * 2)
        candidates.push({ from: first, to: last, score })
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.from / Math.max(1, original.text.length) - hint) -
        Math.abs(b.from / Math.max(1, original.text.length) - hint),
  )
  const best = candidates[0]
  if (!best) return unknown
  const mapped = sourceSelection(source, original.starts[best.from], original.ends[best.to - 1], text)
  return mapped ? { ...mapped, fuzzy: true } : unknown
}

/** Only a genuine mapping failure falls back; invalid ranges remain invalid. */
export function resolveFormattedPreviewSelection(
  source: Parameters<typeof mapFormattedSelection>[0],
  displayed: string,
  from: number,
  to: number,
): ContextSelection | null {
  if (!validRange(displayed, from, to)) return null
  return (
    mapFormattedSelection(source, displayed, from, to) ||
    fuzzyPreviewSelection(source.text, displayed.slice(from, to), from / Math.max(1, displayed.length))
  )
}

export function resolveHtmlPreviewSelection(source: string, displayed: string, from: number, to: number) {
  if (!validRange(displayed, from, to)) return null
  return (
    mapHtmlPreviewSelection(source, displayed, from, to) ||
    fuzzyPreviewSelection(source, displayed.slice(from, to), from / Math.max(1, displayed.length))
  )
}

function validRange(text: string, from: number, to: number) {
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from && to <= text.length
}

export function resolveDomPreviewSelection(root: HTMLElement, selection: Selection): ContextSelection | null {
  const source = previewSource(root)
  if (!source || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const exact = mapDomSelection(root, selection)
  if (exact) return exact
  return fuzzyPreviewSelection(source.text, selection.toString(), selectionPosition(root, range))
}

/** A document-order hint helps disambiguate repeated words without asserting exactness. */
export function selectionPosition(root: HTMLElement, range: Range): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const point = range.cloneRange()
  point.collapse(true)
  let total = 0,
    before = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script,style,template,button,[aria-hidden="true"],.sr-only,.cm-gutters')) continue
    if (node === range.startContainer) before += range.startOffset
    else {
      const end = root.ownerDocument.createRange()
      end.selectNodeContents(node)
      end.collapse(false)
      if (end.compareBoundaryPoints(Range.START_TO_START, point) <= 0) before += node.textContent?.length || 0
    }
    total += node.textContent?.length || 0
  }
  return before / Math.max(1, total)
}
