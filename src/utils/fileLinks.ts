const LOCAL_FILE_LINK_PREFIX = '#opencode-local-file:'

/** Only explicit file schemes need rewriting before HTML sanitization. */
export function getExplicitFileLinkPath(href?: string | null): string | null {
  return href && /^(?:file:|sandbox:)/i.test(href) ? getFileLinkPath(href) : null
}

/** Resolve workspace file links without treating web URLs or fragment links as files. */
export function getFileLinkPath(href?: string | null): string | null {
  if (!href) return null
  let value = href.trim()
  try {
    if (value.startsWith(LOCAL_FILE_LINK_PREFIX)) {
      value = decodeURIComponent(value.slice(LOCAL_FILE_LINK_PREFIX.length))
    } else if (/^file:\/\//i.test(value)) {
      const url = new URL(value)
      if (url.hostname && url.hostname !== 'localhost') return null
      value = decodeURIComponent(url.pathname)
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1)
    } else {
      if (value.startsWith('sandbox:/')) value = value.slice('sandbox:'.length)
      if (
        !/^[a-z]:[\\/]/i.test(value) &&
        (/^[a-z][a-z\d+.-]*:/i.test(value) || /^[#?]/.test(value) || value.startsWith('//'))
      )
        return null
      value = decodeURIComponent(value)
    }
    value = value.replace(/#L\d+(?:-L?\d+)?$/, '')
    return value && !/[\0\r\n]/.test(value) ? value : null
  } catch {
    return null
  }
}
