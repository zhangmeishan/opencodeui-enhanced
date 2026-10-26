/** Lexical UI boundary. Server permissions/realpath checks remain the security boundary. */
export function normalizeWorkspacePath(value: string): string | null {
  if (!value || /[\0\r\n]/.test(value)) return null
  const path = value.replace(/\\/g, '/')
  if (/^[a-z]:[^/]/i.test(path)) return null
  const prefix = /^[a-z]:\//i.exec(path)?.[0] || (path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '')
  if (!prefix) return null
  const segments: string[] = []
  for (const segment of path.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else segments.push(segment)
  }
  return prefix + segments.join('/')
}

export function isWithinWorkspace(path: string | undefined, root: string | undefined): boolean {
  if (!path || !root) return false
  let normalizedPath = normalizeWorkspacePath(path),
    normalizedRoot = normalizeWorkspacePath(root)
  if (!normalizedPath || !normalizedRoot) return false
  if (/^[a-z]:/i.test(normalizedRoot) || normalizedRoot.startsWith('//')) {
    normalizedPath = normalizedPath.toLowerCase()
    normalizedRoot = normalizedRoot.toLowerCase()
  }
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
  )
}

export function isProjectFilePath(path: string, directory: string): boolean {
  const absolute = /^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\')
  return isWithinWorkspace(absolute ? path : `${directory}/${path}`, directory)
}
