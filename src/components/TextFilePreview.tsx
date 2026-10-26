import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CodePreview } from './CodePreview'
import { HtmlFilePreviewFrame } from './HtmlFilePreviewFrame'
import { detectLanguage } from '../utils/languageUtils'
import { formatJsonPreview, parseDelimitedPreview, textPreviewKind } from '../utils/textFilePreview'
import { registerPreviewSource, registerCellSource } from '../utils/previewSelection'

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer').then(module => ({ default: module.MarkdownRenderer })))

function SvgPreview({ text, path }: { text: string; path: string }) {
  const { t } = useTranslation('components')
  const image = useRef<HTMLImageElement>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    if (image.current) image.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [text])
  if (failedSource === text)
    return (
      <div className="p-3">
        <p role="alert" className="text-text-400 mb-3">
          {t('fileExplorer.svgPreviewFailed')}
        </p>
        <CodePreview code={text} language="xml" />
      </div>
    )
  // Image context does not execute SVG scripts or expose the application's DOM.
  return (
    <div className="h-full overflow-auto p-4 flex items-start justify-center">
      <img ref={image} alt={path} onError={() => setFailedSource(text)} className="max-w-full object-contain" />
    </div>
  )
}

type TextFilePreviewProps = { text: string; path: string; directory: string; serverId: string }

export function TextFilePreview(props: TextFilePreviewProps) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (root.current)
      return registerPreviewSource(root.current, { text: props.text, kind: textPreviewKind(props.path) })
  }, [props.text, props.path])
  return (
    <div ref={root} data-text-file-preview className="h-full min-h-0">
      <TextFilePreviewContent {...props} />
    </div>
  )
}

function TextFilePreviewContent({ text, path, directory, serverId }: TextFilePreviewProps) {
  const { t } = useTranslation('components')
  const kind = textPreviewKind(path)
  const table = useMemo(
    () => (kind === 'table' ? parseDelimitedPreview(text, /\.tsv$/i.test(path) ? '\t' : ',') : null),
    [kind, path, text],
  )
  const formatted = useMemo(
    () => (kind === 'json' || kind === 'jsonl' ? formatJsonPreview(text, kind === 'jsonl') : null),
    [kind, text],
  )
  if (kind === 'html')
    return <HtmlFilePreviewFrame html={text} title={path} filePath={path} directory={directory} serverId={serverId} />
  if (kind === 'svg') return <SvgPreview key={path} text={text} path={path} />
  if (kind === 'markdown' || kind === 'mermaid') {
    // Choose a fence longer than any run in the source so diagrams remain one code block.
    let fenceLength = 3
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1)
    const fence = '`'.repeat(fenceLength)
    const content = kind === 'mermaid' ? `${fence}mermaid\n${text}\n${fence}` : text
    return (
      <div className="p-4">
        {/\.mdx$/i.test(path) && (
          <p className="text-text-400 mb-3 text-[length:var(--fs-xs)]">{t('fileExplorer.mdxPreviewHint')}</p>
        )}
        <Suspense fallback={<div>{t('common:loading')}</div>}>
          <MarkdownRenderer content={content} />
        </Suspense>
      </div>
    )
  }
  if (table && !table.invalid)
    return (
      <div className="p-3 overflow-auto h-full">
        {table.truncated && (
          <p role="status" className="mb-2 text-text-400 text-[length:var(--fs-xs)]">
            {t('fileExplorer.tablePreviewLimit')}
          </p>
        )}
        <table className="border-collapse w-full text-[length:var(--fs-sm)]">
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                <th aria-hidden="true" className="border border-border-200 p-1 text-text-400 font-normal">
                  {i + 1}
                </th>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    data-source-from={table.ranges[i][j].starts[0] ?? 0}
                    ref={element => {
                      if (element)
                        registerCellSource(element, text, cell, table.ranges[i][j].starts, table.ranges[i][j].ends)
                    }}
                    className="border border-border-200 px-2 py-1 whitespace-pre-wrap break-words min-w-20"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  return (
    <div className="h-full min-h-0 flex flex-col">
      {(formatted?.invalid || table?.invalid) && (
        <p role="status" className="px-3 py-2 text-text-400 text-[length:var(--fs-xs)]">
          {t('fileExplorer.invalidStructuredPreview')}
        </p>
      )}
      {/\.(tex|ltx|bib|vue|svelte|jsx|tsx|mdx)$/i.test(path) && (
        <p className="px-3 py-2 text-text-400 text-[length:var(--fs-xs)]">{t('fileExplorer.sourcePreviewHint')}</p>
      )}
      <div className="flex-1 min-h-0">
        <CodePreview code={formatted?.text ?? text} language={formatted ? 'json' : detectLanguage(path)} />
      </div>
    </div>
  )
}
