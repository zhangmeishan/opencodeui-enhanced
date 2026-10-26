import { useEffect, useLayoutEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { detectLanguage } from '../utils/languageUtils'

interface Props {
  value: string
  path: string
  onChange: (value: string) => void
  onSave: () => void
  disabled?: boolean
  isVisible?: boolean
}
export function FileCodeEditor({ value, path, onChange, onSave, disabled = false, isVisible = true }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSave })
  const initial = useRef(value)
  const readonly = useRef(new Compartment())
  useLayoutEffect(() => {
    callbacks.current = { onChange, onSave }
  }, [onChange, onSave])
  useLayoutEffect(() => {
    if (!host.current) return
    const language = new Compartment()
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          indentOnInput(),
          highlightSelectionMatches(),
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                callbacks.current.onSave()
                return true
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          syntaxHighlighting(defaultHighlightStyle),
          language.of([]),
          readonly.current.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of(update => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
          }),
          EditorView.contentAttributes.of({ 'aria-label': path, spellcheck: 'false' }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--color-bg-100)', color: 'var(--color-text-100)' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
            '.cm-gutters': { backgroundColor: 'transparent', color: '#888', borderRight: '1px solid #8883' },
            '.cm-content': { caretColor: 'currentColor' },
            '.cm-activeLine': { backgroundColor: '#8881' },
            '.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    })
    viewRef.current = view
    let disposed = false
    const name = detectLanguage(path)
    const description =
      languages.find(item => item.alias.includes(name) || item.name.toLowerCase() === name) ??
      languages.find(item => item.extensions.includes(path.split('.').pop() || ''))
    if (description)
      void description
        .load()
        .then(support => {
          if (!disposed) view.dispatch({ effects: language.reconfigure(support) })
        })
        .catch(() => {})
    return () => {
      disposed = true
      view.destroy()
      viewRef.current = null
    }
  }, [path])
  useEffect(() => {
    const view = viewRef.current
    if (view) view.dispatch({ effects: readonly.current.reconfigure(EditorState.readOnly.of(disabled)) })
  }, [disabled])
  useEffect(() => {
    if (!isVisible) return
    const frame = requestAnimationFrame(() => viewRef.current?.requestMeasure())
    return () => cancelAnimationFrame(frame)
  }, [isVisible])
  return <div ref={host} className="h-full min-h-0 overflow-hidden text-[length:var(--fs-code)]" />
}
