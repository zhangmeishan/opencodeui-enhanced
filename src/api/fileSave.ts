import { readVerifiedFile } from './previewCache'
import { fileChecksum } from '../utils/fileChecksum'
import { TEXT_PREVIEW_BYTES } from '../utils/previewLimits'
import { uploadProjectFile } from './fileUpload'

export { fileChecksum }

export async function saveProjectFile(
  path: string,
  bytes: Uint8Array,
  originalHash: string,
  directory: string,
  serverId: string,
): Promise<void> {
  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  await uploadProjectFile(
    new File([new Uint8Array(bytes)], normalized.slice(slash + 1)),
    slash < 0 ? '' : normalized.slice(0, slash),
    directory,
    serverId,
    { expectedHash: originalHash },
  )
}

export async function readEditableFile(
  path: string,
  directory: string,
  serverId: string,
  signal?: AbortSignal,
  options: { reload?: boolean } = {},
) {
  const bytes = await readVerifiedFile(path, directory, serverId, {
    maxBytes: TEXT_PREVIEW_BYTES,
    signal,
    ...(options.reload ? { reload: true } : {}),
  })
  return { bytes, hash: fileChecksum(bytes) }
}
