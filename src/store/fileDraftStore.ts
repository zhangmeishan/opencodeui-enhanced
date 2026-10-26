import { serverStore } from './serverStore'

export interface FileDraft {
  key: string
  path: string
  directory: string
  serverId: string
  hash: string
  original: Uint8Array
  text: string
  savedText: string
  bom: boolean
  eol: '\n' | '\r\n'
  dirty: boolean
  saving?: boolean
}
const drafts = new Map<string, FileDraft>()
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', event => {
    if (hasUnsavedFileDrafts()) {
      event.preventDefault()
      event.returnValue = ''
    }
  })
export function fileDraftKey(path: string, directory = '', serverId?: string) {
  return `${serverId ?? serverStore.getActiveServerId()}\0${directory}\0${path}`
}
export function getFileDraft(key: string) {
  return drafts.get(key)
}
export function putFileDraft(draft: FileDraft) {
  // Retain unsaved buffers, but don't keep every previously opened document in memory.
  if (drafts.size >= 10)
    for (const [key, value] of drafts)
      if (!value.dirty && key !== draft.key) {
        drafts.delete(key)
        break
      }
  drafts.set(draft.key, draft)
}
export function discardFileDraft(key: string) {
  drafts.delete(key)
}
export function hasDirtyFileDraft(path: string, directory = '', serverId?: string) {
  return drafts.get(fileDraftKey(path, directory, serverId))?.dirty ?? false
}
export function hasUnsavedFileDrafts() {
  return Array.from(drafts.values()).some(draft => draft.dirty)
}
export function clearFileDrafts() {
  drafts.clear()
}
