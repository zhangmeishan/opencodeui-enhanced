import type { Attachment, ContextReference } from '../features/attachment/types'
import { paneLayoutStore } from '../store/paneLayoutStore'
import { readFileBytes } from '../api/fileDownload'
import { getMimeFromPath, bytesToDataUrl } from '../features/chat/input/inputUtils'
import { readOfficePreview } from './officePreview'
import { getFileDraft, fileDraftKey } from '../store/fileDraftStore'
import { isEditableFile } from './filePreview'

export interface FileContextSource {
  path: string
  directory: string
  serverId: string
}
export interface ContextSelection {
  text: string
  startLine?: number
  endLine?: number
  startColumn?: number
  endColumn?: number
  location?: string
  imageUrl?: string
  fuzzy?: boolean
}
export type ChatContextTarget = { paneId: string; sessionId: string | null }
type Target = ChatContextTarget
type Receiver = (attachment: Attachment, target: Target) => boolean
const receivers = new Map<string, Receiver>()

export function registerChatContextReceiver(paneId: string, receive: Receiver) {
  receivers.set(paneId, receive)
  return () => {
    if (receivers.get(paneId) === receive) receivers.delete(paneId)
  }
}

export function captureChatContextTarget(): Target | null {
  const { focusedPaneId, focusedSessionId } = paneLayoutStore.getSnapshot()
  return focusedPaneId ? { paneId: focusedPaneId, sessionId: focusedSessionId } : null
}

export function selectionAttachment(
  source: FileContextSource,
  selection: ContextSelection,
  kind: 'selection' | 'file' = 'selection',
): Attachment {
  const positions = [selection.startLine, selection.startColumn, selection.endLine, selection.endColumn]
  const sourceRange =
    positions.every(value => Number.isSafeInteger(value) && value! > 0) &&
    (selection.endLine! > selection.startLine! ||
      (selection.endLine === selection.startLine && selection.endColumn! >= selection.startColumn!))
      ? {
          startLine: selection.startLine!,
          startColumn: selection.startColumn!,
          endLine: selection.endLine!,
          endColumn: selection.endColumn!,
        }
      : undefined
  const range = sourceRange
    ? `:${sourceRange.startLine}:${sourceRange.startColumn}-${sourceRange.endLine}:${sourceRange.endColumn}`
    : selection.startLine
      ? `:${selection.startLine}${selection.endLine && selection.endLine !== selection.startLine ? `-${selection.endLine}` : ''}`
      : ''
  if (selection.imageUrl && /^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(selection.imageUrl))
    return {
      id: crypto.randomUUID(),
      type: 'file',
      category: 'user',
      displayName: `${source.path.split(/[\\/]/).pop()} (selection)`,
      relativePath: source.path,
      mime: selection.imageUrl.slice(5, selection.imageUrl.indexOf(';')),
      url: selection.imageUrl,
    }
  const contextReference: ContextReference = {
    kind,
    text: selection.text,
    ...(sourceRange ? { range: sourceRange } : {}),
    ...(selection.location ? { location: selection.location } : {}),
    ...(selection.fuzzy ? { fuzzy: true } : {}),
  }
  return {
    id: crypto.randomUUID(),
    type: 'text',
    category: 'user',
    displayName: `${source.path.split(/[\\/]/).pop()}${range}${selection.fuzzy ? ':模糊' : ''}`,
    relativePath: source.path,
    contextReference,
    content: `Source: ${source.path}${range}${selection.fuzzy ? ':模糊' : ''}\nDirectory: ${source.directory}\nServer: ${source.serverId}\nContext: ${JSON.stringify({ version: 1, path: source.path, kind, range: sourceRange, coordinates: sourceRange ? '1-based UTF-16; end exclusive' : undefined, location: selection.location, ...(selection.fuzzy ? { fuzzy: true, accuracy: sourceRange ? 'approximate source range; not exact coordinates' : 'source range unavailable; rendered text only' } : {}) })}\n\n${selection.text}`,
  }
}

export async function fileContextAttachment(source: FileContextSource): Promise<Attachment> {
  const draft = getFileDraft(fileDraftKey(source.path, source.directory, source.serverId))
  if (draft?.dirty || draft?.saving) return selectionAttachment(source, { text: draft.text }, 'file')
  const bytes = await readFileBytes(source.path, source.directory, source.serverId)
  const mime = getMimeFromPath(source.path)
  if (/\.(docx|pptx|xlsx)$/i.test(source.path)) {
    const base64 = bytesToDataUrl(bytes, mime).split(',')[1]
    const sections = await readOfficePreview(base64, source.path, { complete: true })
    const text = sections
      .map(section => `${section.name}\n${section.rows.map(row => row.join('\t')).join('\n')}`)
      .join('\n\n')
    if (!text.trim()) throw new Error('No readable document content')
    if (text.length > 2 * 1024 * 1024)
      throw new Error('Document context exceeds the size limit; select a smaller section')
    return selectionAttachment(source, { text }, 'file')
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.includes('\0') && bytes.length <= 2 * 1024 * 1024) return selectionAttachment(source, { text }, 'file')
  } catch {
    /* Binary files use their actual bytes. */
  }
  return {
    id: crypto.randomUUID(),
    type: 'file',
    category: 'user',
    displayName: source.path.split(/[\\/]/).pop() || source.path,
    relativePath: source.path,
    mime,
    url: bytesToDataUrl(bytes, mime),
  }
}

export async function addFileContextToChat(
  source: FileContextSource,
  selection?: ContextSelection,
  capturedTarget?: ChatContextTarget | null,
) {
  if (selection && !isEditableFile(source.path)) return false
  const target = capturedTarget === undefined ? captureChatContextTarget() : capturedTarget
  if (!target || !receivers.has(target.paneId)) return false
  const receiver = receivers.get(target.paneId)!
  const attachment = selection ? selectionAttachment(source, selection) : await fileContextAttachment(source)
  const current = captureChatContextTarget()
  if (
    !current ||
    current.paneId !== target.paneId ||
    current.sessionId !== target.sessionId ||
    receivers.get(target.paneId) !== receiver
  )
    return false
  return receiver(attachment, target)
}
