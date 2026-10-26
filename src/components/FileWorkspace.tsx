import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readEditableFile, saveProjectFile, fileChecksum } from '../api/fileSave'
import { FileCodeEditor } from './FileCodeEditor'
import { TextFilePreview } from './TextFilePreview'
import { fileDraftKey, getFileDraft, putFileDraft, discardFileDraft, type FileDraft } from '../store/fileDraftStore'
import { detectLanguage } from '../utils/languageUtils'
import { textPreviewKind } from '../utils/textFilePreview'

export function FileWorkspace({
  path,
  directory,
  serverId,
  onDirtyChange,
}: {
  path: string
  directory: string
  serverId: string
  onDirtyChange: () => void
}) {
  const { t } = useTranslation('components')
  const key = fileDraftKey(path, directory, serverId)
  const [draft, setDraft] = useState<FileDraft | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [revision, setRevision] = useState(0)
  const [reloadVersion, setReloadVersion] = useState(0)
  const draftRef = useRef<FileDraft | null>(null)
  const savingRef = useRef(false)
  const forceReloadRef = useRef(false)
  useEffect(() => {
    const revalidate = () => {
      const current = draftRef.current
      if (current?.key === key && !current.dirty && !current.saving && !savingRef.current)
        setReloadVersion(value => value + 1)
    }
    window.addEventListener('focus', revalidate)
    return () => window.removeEventListener('focus', revalidate)
  }, [key])
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    const load = async () => {
      setError('')
      setSaved(false)
      setDraft(null)
      draftRef.current = null
      try {
        let next = getFileDraft(key)
        // Dirty buffers are intentional local edits. Clean buffers must be
        // validated again: another app or the assistant may have changed disk.
        if (!next || (!next.dirty && !next.saving)) {
          const forceReload = forceReloadRef.current
          forceReloadRef.current = false
          const { bytes, hash } = await readEditableFile(path, directory, serverId, controller.signal, {
            reload: forceReload,
          })
          if (disposed) return
          let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (text.includes('\0')) throw new Error(t('fileExplorer.binaryNotEditable'))
          const eol = text.includes('\r\n') ? '\r\n' : '\n'
          text = text.replace(/\r\n/g, '\n')
          next = {
            key,
            path,
            directory,
            serverId,
            hash,
            original: bytes,
            text,
            savedText: text,
            bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
            eol,
            dirty: false,
          }
          putFileDraft(next)
        }
        if (!disposed) {
          draftRef.current = next
          setDraft(next)
        }
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => {
      disposed = true
      controller.abort()
    }
  }, [key, path, directory, serverId, t, reloadVersion])
  const changed = useCallback(() => {
    const current = draftRef.current
    if (!current) return
    current.dirty = current.text !== current.savedText
    putFileDraft(current)
    setRevision(value => value + 1)
    setSaved(false)
    onDirtyChange()
  }, [onDirtyChange])
  const save = useCallback(async () => {
    const current = draftRef.current
    if (!current || !current.dirty || savingRef.current) return
    savingRef.current = true
    current.saving = true
    setSaving(true)
    setError('')
    try {
      const textSnapshot = current.text
      const bytes = new TextEncoder().encode(
        `${current.bom ? '\uFEFF' : ''}${current.eol === '\r\n' ? textSnapshot.replace(/\r?\n/g, '\r\n') : textSnapshot}`,
      )
      await saveProjectFile(current.path, bytes, current.hash, current.directory, current.serverId)
      current.hash = fileChecksum(bytes)
      current.original = bytes
      current.savedText = textSnapshot
      current.dirty = current.text !== current.savedText
      putFileDraft(current)
      onDirtyChange()
      setSaved(true)
      setRevision(value => value + 1)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      savingRef.current = false
      current.saving = false
      setSaving(false)
    }
  }, [onDirtyChange])
  const current = draft?.key === key ? draft : null
  const hasPreview = textPreviewKind(path) !== 'source'
  const previewing = hasPreview && mode === 'preview'
  return (
    <div
      className="flex flex-col h-full min-h-0"
      data-revision={revision}
      onKeyDownCapture={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          void save()
        }
      }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-200/50 text-[length:var(--fs-xs)]">
        <span className="text-text-400 truncate flex-1">
          {detectLanguage(path)}
          {current?.dirty ? ' ●' : ''}
        </span>
        <button
          type="button"
          disabled={saving}
          className="px-2 py-1 hover:bg-bg-200 rounded"
          onClick={() => {
            if (current?.dirty && !window.confirm(t('fileExplorer.discardEdits'))) return
            discardFileDraft(key)
            draftRef.current = null
            forceReloadRef.current = true
            onDirtyChange()
            setReloadVersion(value => value + 1)
          }}
        >
          {t('fileExplorer.reloadFile')}
        </button>
        {current && hasPreview && (
          <button
            type="button"
            onClick={() => setMode(value => (value === 'edit' ? 'preview' : 'edit'))}
            className="px-2 py-1 hover:bg-bg-200 rounded"
          >
            {mode === 'edit' ? t('fileExplorer.previewSaved') : t('fileExplorer.edit')}
          </button>
        )}
        <button
          type="button"
          disabled={!current?.dirty || saving}
          onClick={() => void save()}
          className="px-2 py-1 rounded bg-bg-200 disabled:opacity-40"
        >
          {saving ? t('fileExplorer.saving') : t('fileExplorer.saveFile')}
        </button>
      </div>
      {error && (
        <div role="alert" className="p-2 text-danger-100 text-[length:var(--fs-sm)]">
          {error}
        </div>
      )}
      {saved && (
        <div role="status" className="px-3 py-1 text-success-100 text-[length:var(--fs-xs)]">
          {t('fileExplorer.fileSaved')}
        </div>
      )}
      {!current ? (
        <div className="p-3 text-text-400">{error ? '' : t('fileExplorer.loadingEditor')}</div>
      ) : previewing ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <TextFilePreview text={current.text} path={path} directory={directory} serverId={serverId} />
        </div>
      ) : null}
      {current && (
        <div className={!previewing ? 'flex-1 min-h-0' : 'hidden'}>
          <FileCodeEditor
            key={key}
            path={path}
            value={current.text}
            disabled={saving}
            isVisible={!previewing}
            onChange={text => {
              current.text = text
              changed()
            }}
            onSave={() => void save()}
          />
        </div>
      )}
    </div>
  )
}
