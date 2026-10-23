import { extToMime } from '../../../utils/tauri'

// ============================================
// 文本样式常量
// ============================================

export const TEXT_STYLE: React.CSSProperties = {
  fontFamily: 'var(--font-ui-sans)',
  fontSize: 'var(--fs-base)',
  fontWeight: 400,
  lineHeight: '1.43',
  letterSpacing: 'normal',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
}

// ============================================
// detectSlashTrigger - 检测斜杠命令触发
// 只在文本最开头触发
// ============================================

export function detectSlashTrigger(text: string, cursorPos: number): { query: string; startIndex: number } | null {
  // 斜杠命令只能在文本最开头
  if (!text.startsWith('/')) return null

  // 提取 / 之后到光标的文本作为 query
  const query = text.slice(1, cursorPos)

  // 如果 query 中包含空格或换行，说明命令已经输入完毕
  if (query.includes(' ') || query.includes('\n')) {
    return null
  }

  return { query, startIndex: 0 }
}

// ============================================
// File helpers
// ============================================

export function ensureFileMime(file: File): File {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const inferred = extToMime(ext)
  // OpenCode expands only text/plain data URLs into readable message context.
  const mime = inferred === 'text/plain' || file.type.startsWith('text/') ? 'text/plain' : file.type || inferred
  if (file.type === mime) return file

  return new File([file], file.name, {
    type: mime,
    lastModified: file.lastModified,
  })
}

export function getMimeFromPath(path: string): string {
  const fileName = path.split(/[/\\]/).pop() || path
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return extToMime(ext)
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const chunkSize = 0x8000
  let binary = ''

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }

  return `data:${mime};base64,${btoa(binary)}`
}

/** 读取文件为 data URL */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read file'))
    }
    reader.onerror = reject
    reader.onabort = () => reject(new Error('File read cancelled'))
    reader.readAsDataURL(file)
  })
}
