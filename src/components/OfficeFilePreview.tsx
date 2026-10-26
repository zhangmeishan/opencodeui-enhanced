import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readOfficePreview, type OfficePreviewSection } from '../utils/officePreview'

export function OfficeFilePreview({ base64, path }: { base64: string; path: string }) {
  const { t } = useTranslation('components')
  const [result, setResult] = useState<{
    base64: string
    path: string
    sections?: OfficePreviewSection[]
    error?: boolean
  } | null>(null)
  const sections = result?.base64 === base64 && result.path === path ? result.sections : null
  const error = result?.base64 === base64 && result.path === path && result.error
  const spreadsheet = /\.xlsx$/i.test(path)
  useEffect(() => {
    let disposed = false
    void readOfficePreview(base64, path)
      .then(value => {
        if (!disposed) setResult({ base64, path, sections: value })
      })
      .catch(() => {
        if (!disposed) setResult({ base64, path, error: true })
      })
    return () => {
      disposed = true
    }
  }, [base64, path])
  if (error)
    return (
      <div role="alert" className="p-4 text-text-400">
        {t('fileExplorer.officePreviewFailed')}
      </div>
    )
  if (!sections)
    return (
      <div role="status" className="p-4 text-text-400">
        {t('common:loading')}
      </div>
    )
  return (
    <div className="p-4 space-y-5 text-[length:var(--fs-sm)]">
      <p className="text-text-400">
        {t(spreadsheet ? 'fileExplorer.sheetPreviewHint' : 'fileExplorer.slidePreviewHint')}
      </p>
      {sections.map(section => (
        <section key={section.name} className="border border-border-200 rounded overflow-auto">
          <h3 className="px-3 py-2 font-medium bg-bg-200">
            {spreadsheet ? section.name : t('fileExplorer.slideNumber', { number: section.name })}
          </h3>
          {spreadsheet ? (
            <table className="border-collapse w-full">
              <thead className="sticky top-0 bg-bg-200">
                <tr>
                  <th className="p-1 border border-border-200" />
                  {Array.from({ length: Math.max(0, ...section.rows.map(row => row.length)) }, (_, index) => {
                    let value = index + 1,
                      label = ''
                    while (value) {
                      label = String.fromCharCode(65 + ((value - 1) % 26)) + label
                      value = Math.floor((value - 1) / 26)
                    }
                    return (
                      <th key={index} className="px-2 py-1 border border-border-200 text-text-400 font-normal">
                        {label}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, i) => (
                  <tr key={i}>
                    <th className="p-1 border border-border-200 text-text-400">{section.rowNumbers?.[i] || i + 1}</th>
                    {Array.from({ length: Math.max(0, ...section.rows.map(row => row.length)) }, (_, j) => (
                      <td key={j} className="px-2 py-1 border border-border-200 whitespace-pre-wrap min-w-20">
                        {row[j] || ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-4 space-y-2">
              {section.rows.map((row, i) => (
                <p key={i} className="whitespace-pre-wrap">
                  {row[0]}
                </p>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
