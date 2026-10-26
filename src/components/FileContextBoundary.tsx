import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { useTranslation } from 'react-i18next'
import { isEditableFile } from '../utils/filePreview'
import { previewRoot, previewSource } from '../utils/previewSelection'
import {
  fuzzyPreviewSelection,
  resolveDomPreviewSelection,
  resolveFormattedPreviewSelection,
  selectionPosition,
} from '../utils/fuzzyPreviewSelection'
import {
  addFileContextToChat,
  captureChatContextTarget,
  type ChatContextTarget,
  type ContextSelection,
  type FileContextSource,
} from '../utils/chatContext'

export function FileContextBoundary({ source, children }: { source: FileContextSource; children: ReactNode }) {
  const { t } = useTranslation('components')
  const root = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    selection: ContextSelection
    source: FileContextSource
    target: ChatContextTarget | null
    validate?: () => boolean
  } | null>(null)
  const sourceRef = useRef(source)
  useLayoutEffect(() => {
    sourceRef.current = source
  }, [source])
  const [error, setError] = useState(false)
  const [mappingError, setMappingError] = useState(false)
  const show = (x: number, y: number, selection: ContextSelection, validate?: () => boolean) => {
    if (!isEditableFile(sourceRef.current.path) || !selection.text.trim()) return
    setMappingError(false)
    setMenu({
      x: Math.max(0, Math.min(x, window.innerWidth - 240)),
      y: Math.max(0, Math.min(y, window.innerHeight - 60)),
      selection,
      source: sourceRef.current,
      target: captureChatContextTarget(),
      validate,
    })
  }
  useEffect(() => {
    const host = root.current
    if (!host) return
    const fromFrame = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          x: number
          y: number
          text: string
          selection?: ContextSelection
          mappingFailed?: boolean
          mappedSource?: string
        }>
      ).detail
      if (detail?.mappingFailed) {
        setMenu(null)
        setMappingError(true)
        return
      }
      if (detail && typeof detail.text === 'string') {
        const frameRoot = previewRoot(event.target instanceof Element ? event.target : null)
        if (
          frameRoot &&
          ((!detail.selection?.fuzzy && (!detail.selection?.startLine || !detail.selection?.startColumn)) ||
            detail.mappedSource !== previewSource(frameRoot)?.text)
        ) {
          setMenu(null)
          setMappingError(true)
          return
        }
        show(
          detail.x,
          detail.y,
          detail.selection || { text: detail.text, location: t('fileExplorer.renderedSelection') },
          frameRoot ? () => previewSource(frameRoot)?.text === detail.mappedSource : undefined,
        )
      }
    }
    host.addEventListener('opencode-preview-selection', fromFrame)
    const attached = new Map<HTMLIFrameElement, () => void>()
    const scan = () => {
      for (const [frame, cleanup] of attached) {
        if (!host.contains(frame)) {
          cleanup()
          attached.delete(frame)
        }
      }
      host.querySelectorAll('iframe').forEach(frame => {
        if (attached.has(frame)) return
        let doc: Document | null = null
        const handler = (event: MouseEvent) => {
          if (!isEditableFile(sourceRef.current.path)) return
          const text = doc?.getSelection()?.toString() || ''
          if (!text.trim()) return
          event.preventDefault()
          const frameRoot = previewRoot(frame)
          if (frameRoot) {
            const original = previewSource(frameRoot)
            const selected = doc?.getSelection()
            if (!original || !selected?.rangeCount || !doc?.body) {
              setMenu(null)
              setMappingError(true)
              return
            }
            const rect = frame.getBoundingClientRect()
            show(
              rect.left + event.clientX,
              rect.top + event.clientY,
              fuzzyPreviewSelection(original.text, text, selectionPosition(doc.body, selected.getRangeAt(0))),
              () => previewSource(frameRoot) === original && frameRoot.isConnected,
            )
            return
          }
          const rect = frame.getBoundingClientRect()
          show(rect.left + event.clientX, rect.top + event.clientY, {
            text,
            location: t('fileExplorer.renderedSelection'),
          })
        }
        const load = () => {
          doc?.removeEventListener('contextmenu', handler)
          try {
            doc = frame.contentDocument
            doc?.addEventListener('contextmenu', handler)
          } catch {
            doc = null
          }
        }
        load()
        frame.addEventListener('load', load)
        attached.set(frame, () => {
          doc?.removeEventListener('contextmenu', handler)
          frame.removeEventListener('load', load)
        })
      })
    }
    scan()
    const observer = new MutationObserver(scan)
    observer.observe(host, { childList: true, subtree: true })
    return () => {
      host.removeEventListener('opencode-preview-selection', fromFrame)
      observer.disconnect()
      attached.forEach(clean => clean())
    }
  }, [t])
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', close)
    }
  }, [menu])
  return (
    <div
      ref={root}
      className="h-full min-h-0 flex flex-col"
      onContextMenuCapture={event => {
        if (!isEditableFile(source.path)) return
        setMenu(null)
        const element = event.target instanceof Element ? event.target : null
        const editor = element?.closest('.cm-editor')
        const selectedNode = window.getSelection()?.anchorNode
        const renderedRoot =
          previewRoot(element) ||
          previewRoot(selectedNode?.nodeType === 1 ? (selectedNode as Element) : selectedNode?.parentElement || null)
        let selection: ContextSelection | null = null
        if (editor) {
          const view = EditorView.findFromDOM(editor as HTMLElement)
          const range = view?.state.selection.main
          if (view && range && !range.empty)
            selection = {
              text: view.state.sliceDoc(range.from, range.to),
              startLine: view.state.doc.lineAt(range.from).number,
              startColumn: range.from - view.state.doc.lineAt(range.from).from + 1,
              endLine: view.state.doc.lineAt(range.to).number,
              endColumn: range.to - view.state.doc.lineAt(range.to).from + 1,
            }
          if (view && range && !range.empty && renderedRoot) {
            const original = previewSource(renderedRoot)
            selection = original
              ? resolveFormattedPreviewSelection(original, view.state.doc.toString(), range.from, range.to)
              : null
            if (!selection) {
              event.preventDefault()
              event.stopPropagation()
              setMappingError(true)
              return
            }
          }
        } else if (
          element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLInputElement && element.type !== 'password')
        ) {
          const from = element.selectionStart,
            to = element.selectionEnd
          if (from !== null && to !== null && to > from) {
            const start = element.value.slice(0, from).split('\n'),
              end = element.value.slice(0, to).split('\n')
            selection = {
              text: element.value.slice(from, to),
              startLine: start.length,
              startColumn: start.at(-1)!.length + 1,
              endLine: end.length,
              endColumn: end.at(-1)!.length + 1,
            }
          }
        } else {
          const selected = window.getSelection()
          if (
            selected?.anchorNode &&
            selected.focusNode &&
            root.current?.contains(selected.anchorNode) &&
            root.current.contains(selected.focusNode)
          ) {
            selection = renderedRoot
              ? resolveDomPreviewSelection(renderedRoot, selected!)
              : { text: selected!.toString(), location: t('fileExplorer.renderedSelection') }
            if (renderedRoot && selected!.toString().trim() && !selection) {
              event.preventDefault()
              event.stopPropagation()
              setMappingError(true)
              return
            }
          }
        }
        if (!selection?.text.trim()) return
        event.preventDefault()
        event.stopPropagation()
        const expectedSource = renderedRoot ? previewSource(renderedRoot) : undefined
        show(
          event.clientX,
          event.clientY,
          selection,
          renderedRoot ? () => previewSource(renderedRoot) === expectedSource && renderedRoot.isConnected : undefined,
        )
      }}
    >
      {error && (
        <p role="alert" className="px-3 py-2 text-danger-100 text-[length:var(--fs-xs)]">
          {t('fileExplorer.chatContextFailed')}
        </p>
      )}
      {mappingError && (
        <p role="alert" className="px-3 py-2 text-danger-100 text-[length:var(--fs-xs)]">
          {t('fileExplorer.previewSelectionUnmapped')}
        </p>
      )}
      {children}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[10000] rounded-lg border border-border-200 bg-bg-100 p-1 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="px-3 py-2 rounded-md text-[length:var(--fs-sm)] hover:bg-bg-200"
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                const selection = menu.selection
                setMenu(null)
                if (menu.validate && !menu.validate()) {
                  setMappingError(true)
                  return
                }
                setError(false)
                void addFileContextToChat(menu.source, selection, menu.target)
                  .then(added => setError(!added))
                  .catch(() => setError(true))
              }}
            >
              {t('fileExplorer.addSelectionToChat')}
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
