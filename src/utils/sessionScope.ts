import { normalizeWorkspacePath } from './workspaceBoundary'

/** Exact working-directory scope. Unix paths are case sensitive. */
export function sessionDirectoryKey(directory: string | undefined): string | undefined {
  if (!directory) return undefined
  const normalized = normalizeWorkspacePath(directory)
  if (!normalized) return undefined
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

export function matchesSessionDirectory(directory: string | undefined, expected: string | undefined) {
  const key = sessionDirectoryKey(expected)
  return key !== undefined && sessionDirectoryKey(directory) === key
}
