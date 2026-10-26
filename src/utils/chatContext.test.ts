import JSZip from 'jszip'
import { contextAttachmentFromText, serializeContextAttachment } from './contextSnapshot'
import { insertContextReference } from '../features/chat/input/contextInsertion'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addFileContextToChat,
  fileContextAttachment,
  registerChatContextReceiver,
  selectionAttachment,
} from './chatContext'

const { target, readMock, draftMock } = vi.hoisted(() => ({
  target: { focusedPaneId: 'pane-a', focusedSessionId: 'remote::session-a' as string | null },
  readMock: vi.fn(),
  draftMock: vi.fn(),
}))
vi.mock('../store/paneLayoutStore', () => ({ paneLayoutStore: { getSnapshot: () => target } }))
vi.mock('../api/fileDownload', () => ({ readFileBytes: readMock }))
vi.mock('../store/fileDraftStore', () => ({ getFileDraft: draftMock, fileDraftKey: () => 'key' }))
const source = { path: 'src/report.txt', directory: '/project', serverId: 'remote' }

describe('chat context snapshots', () => {
  beforeEach(() => {
    target.focusedPaneId = 'pane-a'
    target.focusedSessionId = 'remote::session-a'
    readMock.mockReset().mockResolvedValue(new TextEncoder().encode('Full file text'))
    draftMock.mockReset()
  })
  it('uses a compact label and preserves the complete selection, source and line numbers', () => {
    const attachment = selectionAttachment(source, {
      text: 'const answer = 42\nreturn answer',
      startLine: 10,
      endLine: 11,
    })
    expect(attachment.displayName).toBe('report.txt:10-11')
    expect(attachment.content).toContain('Source: src/report.txt:10-11')
    expect(attachment.content).toContain('Server: remote')
    expect(attachment.content).toContain('const answer = 42\nreturn answer')
  })
  it('uses unsaved editor text without rereading the disk', async () => {
    draftMock.mockReturnValue({ text: 'Unsaved buffer', dirty: true })
    expect((await fileContextAttachment(source)).content).toContain('Unsaved buffer')
    expect(readMock).not.toHaveBeenCalled()
  })
  it('reads from the source server and passes context only to the captured pane', async () => {
    const receive = vi.fn(() => true),
      other = vi.fn(() => true)
    const cleanup = registerChatContextReceiver('pane-a', receive)
    const cleanupOther = registerChatContextReceiver('pane-b', other)
    expect(await addFileContextToChat(source)).toBe(true)
    expect(readMock).toHaveBeenCalledWith(source.path, '/project', 'remote')
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Full file text') }),
      { paneId: 'pane-a', sessionId: 'remote::session-a' },
    )
    expect(other).not.toHaveBeenCalled()
    cleanup()
    cleanupOther()
  })
  it('does not insert a late file into a newly selected session', async () => {
    let resolve!: (bytes: Uint8Array) => void
    readMock.mockImplementation(
      () =>
        new Promise<Uint8Array>(done => {
          resolve = done
        }),
    )
    const receive = vi.fn(() => true)
    const cleanup = registerChatContextReceiver('pane-a', receive)
    const result = addFileContextToChat(source)
    target.focusedSessionId = 'remote::different'
    resolve(new TextEncoder().encode('late'))
    expect(await result).toBe(false)
    expect(receive).not.toHaveBeenCalled()
    cleanup()
  })
  it('extracts actual Office text rather than referencing an unreadable binary path', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Document context</w:t></w:r></w:p></w:document>',
    )
    readMock.mockResolvedValue(await zip.generateAsync({ type: 'uint8array' }))
    const attachment = await fileContextAttachment({ ...source, path: 'report.docx' })
    expect(attachment.type).toBe('text')
    expect(attachment.content).toContain('Document context')
  })
  it('sends selected image bytes for vision-capable conversations', () => {
    expect(selectionAttachment(source, { text: '', imageUrl: 'data:image/png;base64,AA==' })).toMatchObject({
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,AA==',
    })
  })
  it('retains exact one-based line/column coordinates, selected text and metadata across send/restore', () => {
    const selected = { text: 'answer\nreturn', startLine: 10, startColumn: 7, endLine: 11, endColumn: 7 }
    const attachment = selectionAttachment(source, selected)
    expect(attachment.displayName).toBe('report.txt:10:7-11:7')
    expect(attachment.contextReference).toEqual({
      kind: 'selection',
      text: selected.text,
      range: { startLine: 10, startColumn: 7, endLine: 11, endColumn: 7 },
    })
    const restored = contextAttachmentFromText(attachment.content!)
    expect(restored?.contextReference).toEqual(attachment.contextReference)
    expect(restored?.relativePath).toBe(source.path)
    expect(restored?.content).toBe(attachment.content)
  })
  it('distinguishes the whole-file action from a rendered Office selection', async () => {
    draftMock.mockReturnValue({ text: 'whole file', dirty: true })
    expect((await fileContextAttachment(source)).contextReference?.kind).toBe('file')
    expect(selectionAttachment(source, { text: 'some cells', location: 'Sheet1!A2:B5' }).contextReference).toEqual({
      kind: 'selection',
      text: 'some cells',
      location: 'Sheet1!A2:B5',
    })
  })
  it.each([true, false])(
    'preserves fuzzy labels, selected text and accuracy across inline insertion and send/restore (range: %s)',
    hasRange => {
      const selected = {
        text: 'rendered\nselection',
        fuzzy: true,
        ...(hasRange
          ? { startLine: 3, startColumn: 2, endLine: 4, endColumn: 8 }
          : { location: 'No matching source range' }),
      }
      const attachment = selectionAttachment(source, selected)
      const label = `report.txt${hasRange ? ':3:2-4:8' : ''}:模糊`
      expect(attachment.displayName).toBe(label)
      expect(attachment.content).toContain(`Source: src/${label}\n`)
      expect(attachment.content).toContain('"fuzzy":true')
      expect(attachment.contextReference?.range).toEqual(
        hasRange ? { startLine: 3, startColumn: 2, endLine: 4, endColumn: 8 } : undefined,
      )
      const inserted = insertContextReference('before after', [], attachment, 7)
      expect(inserted.text).toBe(`before ⟦${label}⟧ after`)
      const restored = contextAttachmentFromText(serializeContextAttachment(inserted.attachments[0]))!
      expect(restored.displayName).toBe(label)
      expect(restored.contextReference).toEqual(attachment.contextReference)
      expect(restored.textRange).toEqual(inserted.attachments[0].textRange)
      expect(restored.contextReference?.text).toBe(selected.text)
    },
  )
  it('rejects toolbar replies when the captured chat has changed', async () => {
    const receive = vi.fn(() => true)
    const cleanup = registerChatContextReceiver('pane-a', receive)
    const captured = { paneId: 'pane-a', sessionId: 'remote::session-a' }
    target.focusedSessionId = 'remote::different'
    expect(await addFileContextToChat(source, { text: 'selected' }, captured)).toBe(false)
    expect(receive).not.toHaveBeenCalled()
    cleanup()
  })
  it('rejects selection insertion for Office files even if called outside the preview UI', async () => {
    const receive = vi.fn(() => true),
      cleanup = registerChatContextReceiver('pane-a', receive)
    try {
      expect(await addFileContextToChat({ ...source, path: 'report.docx' }, { text: 'selected Office content' })).toBe(
        false,
      )
      expect(receive).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })
})
