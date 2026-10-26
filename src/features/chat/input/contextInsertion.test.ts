import { describe, expect, it } from 'vitest'
import { insertContextReference, syncAttachmentRanges } from './contextInsertion'
import type { Attachment } from '../../attachment/types'
const reference: Attachment = {
  id: 'ref',
  type: 'text',
  displayName: 'note.txt:2:1-3:8',
  content: 'selected\ncontent',
  contextReference: { kind: 'selection', text: 'selected\ncontent' },
}
describe('inline selected-text references', () => {
  it('inserts at the caret, replaces only the selected input range and rebases existing ranges', () => {
    const first = insertContextReference('before replace after', [], reference, 7, 14)
    expect(first.text).toBe('before ⟦note.txt:2:1-3:8⟧  after')
    expect(first.cursor).toBe(first.attachments[0].textRange!.end + 1)
    const second = insertContextReference(first.text, first.attachments, { ...reference, id: 'second' }, 0)
    for (const attachment of second.attachments)
      expect(second.text.slice(attachment.textRange!.start, attachment.textRange!.end)).toBe(
        attachment.textRange!.value,
      )
  })
  it('keeps referenced content when text before it changes and removes it on overlapping edits', () => {
    const result = insertContextReference('hello ', [], reference, 6)
    const shifted = syncAttachmentRanges(result.attachments, result.text, 'prefix ' + result.text)
    expect(shifted).toHaveLength(1)
    expect(shifted[0].textRange!.start).toBe(13)
    const changed = 'prefix ' + result.text.replace('note.txt', 'other.txt')
    expect(syncAttachmentRanges(shifted, 'prefix ' + result.text, changed)).toEqual([])
  })
  it('uses one-line labels without copying the selected text into the composer', () => {
    const result = insertContextReference('', [], { ...reference, displayName: 'name\n⟦bad⟧.txt' }, 0)
    expect(result.text).not.toMatch(/[\r\n]/)
    expect(result.text).not.toContain('selected')
    expect(result.attachments[0].content).toBe('selected\ncontent')
  })
  it('removes only the context whose anchor is overlapped when replacing text', () => {
    const first = insertContextReference('x ', [], reference, 2)
    const second = insertContextReference(
      first.text,
      first.attachments,
      { ...reference, id: 'second' },
      first.text.length,
    )
    const range = second.attachments[0].textRange!
    const replacement = insertContextReference(
      second.text,
      second.attachments,
      { ...reference, id: 'replacement' },
      range.start,
      range.end,
    )
    expect(replacement.attachments.map(attachment => attachment.id)).toEqual(['second', 'replacement'])
    for (const attachment of replacement.attachments)
      expect(replacement.text.slice(attachment.textRange!.start, attachment.textRange!.end)).toBe(
        attachment.textRange!.value,
      )
  })
})
