import type { Attachment } from '../features/attachment/types'

/** Recognize app-created snapshots when restoring an earlier user prompt. */
export function contextAttachmentFromText(text: string, id?: string): Attachment | null {
  const match = /^Source: ([^\r\n]+)\nDirectory: [^\r\n]*\nServer: [^\r\n]+\n(?:Context: ([^\r\n]+)\n)?\n/.exec(text)
  if (!match) return null
  let reference: Attachment['contextReference']
  let path: string | undefined
  let textRange: Attachment['textRange']
  if (match[2]) {
    try {
      const meta = JSON.parse(match[2])
      if (meta.version === 1 && (meta.kind === 'selection' || meta.kind === 'file') && typeof meta.path === 'string') {
        path = meta.path
        const range = meta.range
        const validRange =
          range &&
          ['startLine', 'startColumn', 'endLine', 'endColumn'].every(
            key => Number.isSafeInteger(range[key]) && range[key] > 0,
          ) &&
          (range.endLine > range.startLine ||
            (range.endLine === range.startLine && range.endColumn >= range.startColumn))
        reference = {
          kind: meta.kind,
          text: text.slice(match[0].length),
          ...(validRange ? { range } : {}),
          ...(typeof meta.location === 'string' ? { location: meta.location } : {}),
          ...(meta.fuzzy === true ? { fuzzy: true } : {}),
        }
        const inline = meta.inlineRange
        if (
          inline &&
          typeof inline.value === 'string' &&
          Number.isSafeInteger(inline.start) &&
          Number.isSafeInteger(inline.end) &&
          inline.start >= 0 &&
          inline.end - inline.start === inline.value.length
        )
          textRange = inline
      }
    } catch {
      /* Preserve readable legacy content if metadata is unavailable. */
    }
  }
  return {
    id: id || crypto.randomUUID(),
    type: 'text',
    category: 'user',
    displayName: match[1].split(/[\\/]/).pop() || match[1],
    content: text,
    ...(reference ? { contextReference: reference, relativePath: path } : {}),
    ...(textRange ? { textRange } : {}),
  }
}

/** Persist the visible inline anchor alongside its hidden selected-text snapshot. */
export function serializeContextAttachment(attachment: Attachment): string {
  const content = attachment.content || ''
  if (!attachment.contextReference || !attachment.textRange) return content
  return content.replace(/^Context: ([^\r\n]+)$/m, (line, json: string) => {
    try {
      return `Context: ${JSON.stringify({ ...JSON.parse(json), inlineRange: attachment.textRange })}`
    } catch {
      return line
    }
  })
}
