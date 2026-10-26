import type { PreviewFile } from '../store/layoutStore'
import { getFileLinkPath } from './fileLinks'
import { isWithinWorkspace, normalizeWorkspacePath } from './workspaceBoundary'

/** Resolve links against the message's directory, then produce a project-relative path. */
export function resolveChatFile(
  href: string,
  directory: string | undefined,
  serverId: string,
  root: string,
): PreviewFile {
  const path = getFileLinkPath(href)?.replace(/#L\d+(?:-L?\d+)?$/, '')
  if (!path) throw new Error('Invalid file link')
  const absolute = /^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\')
  const full = normalizeWorkspacePath(absolute ? path : `${directory || root}/${path}`)
  if (!full || !isWithinWorkspace(full, root)) throw new Error('File is outside the workspace')
  const base =
    directory && isWithinWorkspace(directory, root) && isWithinWorkspace(full, directory)
      ? normalizeWorkspacePath(directory)!
      : normalizeWorkspacePath(root)!
  const relative = full.slice(base.endsWith('/') ? base.length : base.length + 1)
  if (!relative) throw new Error('Not a file path')
  const line = href.match(/#L(\d+)(?:-L?\d+)?$/)?.[1]
  return {
    path: relative,
    name: full.split('/').pop()!,
    directory: base,
    serverId,
    ...(line ? { targetLine: Number(line), targetKey: crypto.randomUUID() } : {}),
  }
}
