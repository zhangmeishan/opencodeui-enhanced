import type { Attachment } from '../../attachment/types'

/** Rebase attachment ranges through one textarea replacement. Overlaps are removed. */
export function rebaseAttachmentRanges(
  attachments: Attachment[],
  from: number,
  to: number,
  insertedLength: number,
): Attachment[] {
  const delta = insertedLength - (to - from)
  return attachments.flatMap(attachment => {
    const range = attachment.textRange
    if (!range || range.end <= from) return [attachment]
    if (range.start >= to)
      return [{ ...attachment, textRange: { ...range, start: range.start + delta, end: range.end + delta } }]
    return []
  })
}

export function syncAttachmentRanges(attachments: Attachment[], oldText: string, newText: string): Attachment[] {
  if (oldText === newText) return attachments
  let from = 0
  while (from < oldText.length && from < newText.length && oldText[from] === newText[from]) from++
  let oldEnd = oldText.length,
    newEnd = newText.length
  while (oldEnd > from && newEnd > from && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return rebaseAttachmentRanges(attachments, from, oldEnd, newEnd - from).filter(
    attachment =>
      !attachment.textRange ||
      newText.slice(attachment.textRange.start, attachment.textRange.end) === attachment.textRange.value,
  )
}

export function insertContextReference(
  text: string,
  attachments: Attachment[],
  attachment: Attachment,
  start: number,
  end = start,
) {
  const from = Math.max(0, Math.min(start, text.length)),
    to = Math.max(from, Math.min(end, text.length))
  const label = attachment.displayName.replace(/[\r\n⟦⟧]/g, ' ')
  const token = `⟦${label}⟧`
  const prefix = from > 0 && !/\s/.test(text[from - 1]) ? ' ' : ''
  const insertion = `${prefix}${token} `
  const next = {
    ...attachment,
    textRange: { value: token, start: from + prefix.length, end: from + prefix.length + token.length },
  }
  return {
    text: text.slice(0, from) + insertion + text.slice(to),
    attachments: [...rebaseAttachmentRanges(attachments, from, to, insertion.length), next],
    cursor: from + insertion.length,
  }
}
