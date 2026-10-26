import JSZip from 'jszip'

const pNS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const aNS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const rNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export interface SlideElement {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fill?: string
  stroke?: string
  rounded?: boolean
  image?: string
  paragraphs?: { text: string; size: number; color: string; bold: boolean; align: 'left' | 'center' | 'right' }[]
}
export interface PresentationPreview {
  width: number
  height: number
  slides: { name: string; background: string; elements: SlideElement[] }[]
}
function parseXml(source: string) {
  if (/<!DOCTYPE/i.test(source)) throw new Error('Invalid document')
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid document')
  return doc
}
function first(node: Element | Document, ns: string, name: string) {
  return node.getElementsByTagNameNS(ns, name)[0]
}
function number(value: string | null | undefined, fallback = 0) {
  const result = Number(value)
  return value != null && Number.isFinite(result) ? result : fallback
}
function resolvePart(base: string, target: string) {
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}
async function relationships(zip: JSZip, path: string) {
  const index = path.lastIndexOf('/')
  const part = zip.file(`${path.slice(0, index + 1)}_rels/${path.slice(index + 1)}.rels`)
  const map = new Map<string, string>()
  if (part)
    for (const node of Array.from(parseXml(await part.async('string')).getElementsByTagName('Relationship'))) {
      if (node.getAttribute('TargetMode') === 'External') continue
      map.set(node.getAttribute('Id') || '', resolvePart(path, node.getAttribute('Target') || ''))
    }
  return map
}
function color(node: Element | undefined, theme: Map<string, string>, fallback: string) {
  if (!node) return fallback
  const rgb = first(node, aNS, 'srgbClr')?.getAttribute('val')
  if (rgb && /^[\da-f]{6}$/i.test(rgb)) return `#${rgb}`
  const scheme = first(node, aNS, 'schemeClr')?.getAttribute('val') || ''
  return theme.get(scheme) || fallback
}

/** Basic offline slide layout. Complex diagrams/charts are handled by the full document viewer. */
export async function readPresentationPreview(base64: string): Promise<PresentationPreview> {
  if (base64.length > 17 * 1024 * 1024) throw new Error('Document exceeds preview limit')
  const zip = await JSZip.loadAsync(base64, { base64: true })
  const entries = Object.values(zip.files)
  const size = entries.reduce(
    (total, entry) =>
      total + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0),
    0,
  )
  if (entries.length > 2000 || size > 32 * 1024 * 1024) throw new Error('Document exceeds preview limit')
  const theme = new Map<string, string>([
    ['tx1', '#222222'],
    ['bg1', '#ffffff'],
  ])
  const themePart = zip.file('ppt/theme/theme1.xml')
  if (themePart) {
    const scheme = first(parseXml(await themePart.async('string')), aNS, 'clrScheme')
    for (const node of Array.from(scheme?.children || [])) {
      const value =
        first(node, aNS, 'srgbClr')?.getAttribute('val') || first(node, aNS, 'sysClr')?.getAttribute('lastClr')
      if (value && /^[\da-f]{6}$/i.test(value)) theme.set(node.localName, `#${value}`)
    }
    theme.set('tx1', theme.get('dk1') || '#222222')
    theme.set('bg1', theme.get('lt1') || '#ffffff')
  }
  const presentationPart = zip.file('ppt/presentation.xml')
  const presentation = presentationPart ? parseXml(await presentationPart.async('string')) : null
  const dimensions = presentation && first(presentation, pNS, 'sldSz')
  const width = Math.max(1, number(dimensions?.getAttribute('cx'), 12192000))
  const height = Math.max(1, number(dimensions?.getAttribute('cy'), 6858000))
  const presentationRelations = await relationships(zip, 'ppt/presentation.xml')
  const ordered = presentation
    ? Array.from(presentation.getElementsByTagNameNS(pNS, 'sldId'))
        .map(node => presentationRelations.get(node.getAttributeNS(rNS, 'id') || ''))
        .filter((path): path is string => !!path)
    : []
  const paths = ordered.length
    ? ordered
    : entries
        .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const slides: PresentationPreview['slides'] = []
  for (const path of paths.slice(0, 100)) {
    const part = zip.file(path)
    if (!part) continue
    const doc = parseXml(await part.async('string'))
    const relations = await relationships(zip, path)
    const tree = first(doc, pNS, 'spTree')
    const elements: SlideElement[] = []
    for (const node of Array.from(tree?.children || [])) {
      if (!['sp', 'pic', 'graphicFrame'].includes(node.localName)) continue
      const transform = first(node, aNS, 'xfrm') || first(node, pNS, 'xfrm')
      if (!transform) continue
      const off = first(transform, aNS, 'off'),
        ext = first(transform, aNS, 'ext')
      const element: SlideElement = {
        x: (number(off?.getAttribute('x')) / width) * 960,
        y: (number(off?.getAttribute('y')) / width) * 960,
        width: (number(ext?.getAttribute('cx')) / width) * 960,
        height: (number(ext?.getAttribute('cy')) / width) * 960,
        rotation: number(transform.getAttribute('rot')) / 60000,
      }
      const properties = first(node, pNS, 'spPr')
      const fill = properties && Array.from(properties.children).find(child => child.localName === 'solidFill')
      if (fill) element.fill = color(fill, theme, 'transparent')
      const line = properties && first(properties, aNS, 'ln')
      if (line && !first(line, aNS, 'noFill')) element.stroke = color(line, theme, '#888888')
      element.rounded = first(node, aNS, 'prstGeom')?.getAttribute('prst') === 'roundRect'
      const imageId = first(node, aNS, 'blip')?.getAttributeNS(rNS, 'embed')
      const imagePath = imageId && relations.get(imageId)
      if (imagePath && /\.(png|jpe?g|gif|webp)$/i.test(imagePath)) {
        const image = zip.file(imagePath)
        const extension = imagePath.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')
        if (image) element.image = `data:image/${extension};base64,${await image.async('base64')}`
      }
      const textBody = first(node, pNS, 'txBody')
      if (textBody)
        element.paragraphs = Array.from(textBody.getElementsByTagNameNS(aNS, 'p')).map(paragraph => {
          const props =
            first(paragraph, aNS, 'rPr') || first(paragraph, aNS, 'defRPr') || first(paragraph, aNS, 'endParaRPr')
          const alignment = first(paragraph, aNS, 'pPr')?.getAttribute('algn')
          return {
            text: Array.from(paragraph.getElementsByTagNameNS(aNS, 't'), text => text.textContent || '').join(''),
            size: Math.max(8, Math.min(120, (number(props?.getAttribute('sz'), 1800) / 100) * 1.333)),
            color: color(props, theme, theme.get('tx1')!),
            bold: props?.getAttribute('b') === '1',
            align:
              alignment === 'ctr' ? ('center' as const) : alignment === 'r' ? ('right' as const) : ('left' as const),
          }
        })
      elements.push(element)
    }
    slides.push({
      name: String(slides.length + 1),
      background: color(first(doc, pNS, 'bg'), theme, '#ffffff'),
      elements,
    })
  }
  if (!slides.length) throw new Error('No slides found')
  return { width: 960, height: (height / width) * 960, slides }
}
