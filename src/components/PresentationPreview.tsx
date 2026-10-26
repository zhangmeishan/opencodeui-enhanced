import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readPresentationPreview, type PresentationPreview as Presentation } from '../utils/presentationPreview'

export function PresentationPreview({ base64 }: { base64: string }) {
  const { t } = useTranslation('components')
  const host = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<{ source: string; presentation?: Presentation; error?: boolean } | null>(null)
  const [width, setWidth] = useState(640)
  useEffect(() => {
    let disposed = false
    void readPresentationPreview(base64)
      .then(presentation => {
        if (!disposed) setResult({ source: base64, presentation })
      })
      .catch(() => {
        if (!disposed) setResult({ source: base64, error: true })
      })
    return () => {
      disposed = true
    }
  }, [base64])
  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => setWidth(Math.max(100, element.clientWidth - 32))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const presentation = result?.source === base64 ? result.presentation : null
  const scale = presentation ? width / presentation.width : 1
  return (
    <div ref={host} className="p-4 space-y-4">
      <p className="text-[length:var(--fs-xs)] text-text-400">{t('fileExplorer.slideLayoutHint')}</p>
      {result?.source === base64 && result.error ? (
        <p role="alert">{t('fileExplorer.officePreviewFailed')}</p>
      ) : !presentation ? (
        <p role="status">{t('common:loading')}</p>
      ) : (
        presentation.slides.map(slide => (
          <section key={slide.name}>
            <h3 className="mb-2 text-[length:var(--fs-xs)] text-text-400">
              {t('fileExplorer.slideNumber', { number: slide.name })}
            </h3>
            <div
              className="relative overflow-hidden rounded border border-border-200 shadow-sm"
              style={{ width, height: presentation.height * scale }}
            >
              <div
                style={{
                  position: 'relative',
                  width: presentation.width,
                  height: presentation.height,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  background: slide.background,
                  color: '#222',
                }}
              >
                {slide.elements.map((element, index) => (
                  <div
                    key={index}
                    style={{
                      position: 'absolute',
                      left: element.x,
                      top: element.y,
                      width: element.width,
                      height: element.height,
                      transform: `rotate(${element.rotation}deg)`,
                      background: element.fill,
                      border: element.stroke ? `1px solid ${element.stroke}` : undefined,
                      borderRadius: element.rounded ? 12 : 0,
                      overflow: 'hidden',
                    }}
                  >
                    {element.image && (
                      <img src={element.image} alt="" className="w-full h-full object-contain" draggable={false} />
                    )}
                    {element.paragraphs?.map((paragraph, number) => (
                      <p
                        key={number}
                        style={{
                          padding: '2px 8px',
                          fontFamily: 'Arial, sans-serif',
                          fontSize: paragraph.size,
                          fontWeight: paragraph.bold ? 700 : 400,
                          color: paragraph.color,
                          textAlign: paragraph.align,
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.15,
                        }}
                      >
                        {paragraph.text || '\u00a0'}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>
        ))
      )}
    </div>
  )
}
