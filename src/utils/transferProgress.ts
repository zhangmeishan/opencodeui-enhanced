export interface TransferProgress {
  loaded: number
  total?: number
  phase: 'preparing' | 'transferring' | 'processing' | 'completed' | 'failed'
}
export type ProgressCallback = (progress: TransferProgress) => void

/** Coalesce byte updates so fast streams do not render once per frame/chunk. */
export function createProgressReporter(callback?: ProgressCallback): ProgressCallback {
  let previous: TransferProgress | undefined
  let lastReportedAt = -Infinity
  return progress => {
    if (!callback) return
    const now = performance.now()
    if (progress.phase !== previous?.phase || progress.total !== previous?.total || now - lastReportedAt >= 100) {
      callback(progress)
      lastReportedAt = now
    }
    previous = progress
  }
}

export function transferPercent(progress: TransferProgress): number | undefined {
  if (progress.phase === 'completed') return 100
  if (progress.total === undefined || progress.total === 0) return undefined
  // Receiving every byte still leaves decoding/committing; only success reaches 100%.
  return Math.min(99, Math.max(0, Math.floor((progress.loaded / progress.total) * 100)))
}

export function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function readResponseBytes(response: Response, onProgress?: ProgressCallback): Promise<Uint8Array> {
  const report = createProgressReporter(onProgress)
  const length = Number(response.headers?.get('content-length'))
  const total =
    !response.headers?.get('content-encoding') && Number.isSafeInteger(length) && length > 0 ? length : undefined
  report({ loaded: 0, total, phase: 'transferring' })
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    report({ loaded: bytes.length, total: bytes.length, phase: 'processing' })
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      report({ loaded, total, phase: 'transferring' })
    }
  } finally {
    reader.releaseLock()
  }
  report({ loaded, total: loaded, phase: 'processing' })
  const result = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
