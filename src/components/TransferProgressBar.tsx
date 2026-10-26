import { useTranslation } from 'react-i18next'
import { formatTransferBytes, transferPercent, type TransferProgress } from '../utils/transferProgress'

export function TransferProgressBar({
  progress,
  label,
}: {
  progress: TransferProgress | null | undefined
  label: string
}) {
  const { t } = useTranslation('components')
  if (!progress) return null
  const percent = transferPercent(progress)
  const size = `${formatTransferBytes(progress.loaded)}${progress.total !== undefined ? ` / ${formatTransferBytes(progress.total)}` : ''}`
  return (
    <div className="w-full min-w-0 shrink-0 px-3 py-2 text-[length:var(--fs-xs)]" data-transfer-phase={progress.phase}>
      <div className="mb-1 flex items-center gap-2 text-text-400">
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums">
          {size}
          {percent !== undefined ? ` · ${percent}%` : ''}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${t(`fileTransfer.${progress.phase}`)} · ${size}${percent !== undefined ? ` · ${percent}%` : ''}`}
        className="h-1.5 overflow-hidden rounded-full bg-bg-300"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-150 ${progress.phase === 'failed' ? 'bg-danger-100' : progress.phase === 'completed' ? 'bg-success-100' : 'bg-accent-main-100'} ${percent === undefined && progress.phase !== 'failed' ? 'animate-pulse' : ''}`}
          style={{ width: `${percent ?? (progress.phase === 'failed' ? 0 : 35)}%` }}
        />
      </div>
      <div role="status" className={`mt-1 ${progress.phase === 'failed' ? 'text-danger-100' : 'text-text-400'}`}>
        {t(`fileTransfer.${progress.phase}`)}
      </div>
    </div>
  )
}
