import { useSyncExternalStore } from 'react'
import type { PreviewFile } from './layoutStore'

let snapshot: { file: PreviewFile; sessionId: string; revision: number } | null = null
const listeners = new Set<() => void>()
export const fileNavigationStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  reveal(file: PreviewFile, sessionId: string) {
    snapshot = { file, sessionId, revision: (snapshot?.revision ?? 0) + 1 }
    listeners.forEach(listener => listener())
  },
}
export function useFileNavigation() {
  return useSyncExternalStore(fileNavigationStore.subscribe, fileNavigationStore.getSnapshot)
}
