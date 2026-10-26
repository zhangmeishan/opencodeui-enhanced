import { extToMime } from './tauri'
import { detectLanguage } from './languageUtils'

export function isEditableFile(path: string) {
  if (isOfficeFile(path) || /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|exe|dll|bin)$/i.test(path)) return false
  return (
    /\.(?:txt|text|rst|adoc|asciidoc|md|markdown|mdown|mkd|mdx|tex|ltx|bib|log|csv|tsv|json|jsonl|ndjson|ipynb|jsonc|json5|ya?ml|toml|ini|cfg|conf|xml|xhtml|svg|html?|css|scss|sass|less|[cm]?jsx?|tsx?|py|pyi|rb|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|sql|vue|svelte|r|lua|pl|exs?|erl|hs|scala|ps1|fish|vim|tf|proto|graphql|gql|prisma|env|mmd|mermaid)$/i.test(
      path,
    ) ||
    detectLanguage(path) !== 'text' ||
    !path.split('/').pop()?.includes('.')
  )
}

export function isOfficeFile(path: string): boolean {
  return /\.(?:docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp|rtf)$/i.test(path)
}

export function getFileMime(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() || ''
  return extToMime(extension)
}

export function needsOriginalFilePreview(path: string): boolean {
  return isOfficeFile(path) || /\.(?:pdf|png|jpe?g|gif|webp|bmp|svg|avif|ico|mp3|wav|mp4|webm)$/i.test(path)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function validateImagePreview(base64: string, path: string): void {
  if (!/\.png$/i.test(path)) return
  const header = atob(base64.slice(0, 44))
  if (header.length < 24 || header.slice(1, 4) !== 'PNG') throw new Error('Invalid PNG image')
  const bytes = Uint8Array.from(header, char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const width = view.getUint32(16),
    height = view.getUint32(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000) {
    throw new Error('Image dimensions exceed the browser preview limit. Download it instead.')
  }
}
