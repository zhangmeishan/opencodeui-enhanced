import http from 'node:http'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath, stat, rename, readdir, copyFile, chmod, rm } from 'node:fs/promises'
import { extname, basename, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const formats = {
  docx: 'word',
  doc: 'word',
  odt: 'word',
  rtf: 'word',
  xlsx: 'cell',
  xls: 'cell',
  ods: 'cell',
  pptx: 'slide',
  ppt: 'slide',
  odp: 'slide',
}
const editable = new Set(['docx', 'xlsx', 'pptx'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const equal = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const inside = (root, path) => {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status })
}

export function signToken(payload, secret) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${signature}`
}
export function verifyToken(token, secret) {
  try {
    const [head, body, signature, extra] = String(token).split('.')
    if (extra || JSON.parse(Buffer.from(head, 'base64url')).alg !== 'HS256') throw new Error()
    const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
    if (!equal(signature, expected)) throw new Error()
    const payload = JSON.parse(Buffer.from(body, 'base64url'))
    if (payload.exp && payload.exp < Date.now() / 1000) throw new Error()
    return payload
  } catch {
    fail(401, 'Invalid or expired document token')
  }
}

function baseUrl(value, name) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(`Invalid ${name}`)
  return url.href.replace(/\/$/, '')
}
export async function loadConfig(path, env = process.env) {
  const raw = JSON.parse(await readFile(path, 'utf8'))
  const secret = env.ONLYOFFICE_JWT_SECRET
  if (!secret || secret.length < 32) throw new Error('ONLYOFFICE_JWT_SECRET must contain at least 32 characters')
  const mappings = await Promise.all(
    (raw.mappings || []).map(async item => {
      const apiUrls = item.apiUrls ?? (item.apiUrl ? [item.apiUrl] : [])
      if (!item.id || !Array.isArray(apiUrls) || !apiUrls.length || !Array.isArray(item.roots) || !item.roots.length)
        throw new Error('Invalid Office mapping')
      const auth = item.auth ?? 'basic'
      if (!['none', 'basic'].includes(auth)) throw new Error(`Invalid auth mode for mapping ${item.id}`)
      const username = auth === 'basic' ? env[item.usernameEnv] : undefined,
        password = auth === 'basic' ? env[item.passwordEnv] : undefined
      if (auth === 'basic' && (!username || !password)) throw new Error(`Missing credentials for mapping ${item.id}`)
      const normalizedUrls = apiUrls.map(value => {
        if (typeof value !== 'string' || !value) throw new Error(`Invalid apiUrls for mapping ${item.id}`)
        if (value.startsWith('/') && !value.startsWith('//') && !/[?#]/.test(value))
          return value.replace(/\/+$/, '') || '/'
        return baseUrl(value, `apiUrls for ${item.id}`)
      })
      const roots = await Promise.all(
        item.roots.map(async root => ({
          remote: root.remote.replace(/\\/g, '/').replace(/\/$/, '') || '/',
          local: await realpath(root.local),
        })),
      )
      return { id: item.id, apiUrls: normalizedUrls, auth, username, password, roots }
    }),
  )
  if (!mappings.length) throw new Error('At least one directory mapping is required')
  if (new Set(mappings.map(item => item.id)).size !== mappings.length)
    throw new Error('Office mapping IDs must be unique')
  return {
    secret,
    mappings,
    port: Number(env.OFFICE_BRIDGE_PORT || 8093),
    host: env.OFFICE_BRIDGE_HOST || '0.0.0.0',
    documentServerPublicUrl: baseUrl(raw.documentServerPublicUrl, 'documentServerPublicUrl'),
    documentServerInternalUrl: baseUrl(raw.documentServerInternalUrl, 'documentServerInternalUrl'),
    bridgeDocumentUrl: baseUrl(raw.bridgeDocumentUrl, 'bridgeDocumentUrl'),
    frontendOrigins: raw.frontendOrigins.map(value => new URL(value).origin),
    dataDirectory: resolve(env.OFFICE_BRIDGE_DATA || './office-data'),
    maxBytes: raw.maxBytes || 50 * 1024 * 1024,
  }
}

async function jsonBody(request, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) fail(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    fail(400, 'Invalid JSON request')
  }
}
function authorize(request, mapping) {
  if (mapping.auth === 'none') return
  const expected = `Basic ${Buffer.from(`${mapping.username}:${mapping.password}`).toString('base64')}`
  if (!equal(request.headers.authorization || '', expected))
    fail(401, 'Office access requires the configured username and password')
}
function matchMapping(config, requested, frontendOrigin) {
  let url
  try {
    url = new URL(requested)
  } catch {
    fail(400, 'Invalid OpenCode URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail(400, 'Invalid OpenCode URL')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const matches = config.mappings.filter(item =>
    (item.apiUrls ?? [item.apiUrl]).some(value =>
      value.startsWith('/')
        ? url.origin === frontendOrigin && pathname === value
        : `${url.origin}${pathname === '/' ? '' : pathname}` === value.replace(/\/+$/, ''),
    ),
  )
  if (!matches.length) fail(403, 'This OpenCode service has no Office directory mapping')
  if (matches.length > 1) fail(409, 'Ambiguous Office mapping: assign each OpenCode URL to exactly one mapping')
  return matches[0]
}
async function resolveDocument(mapping, directory, file) {
  if (typeof directory !== 'string' || typeof file !== 'string' || !file || /[\0\r\n]/.test(directory + file))
    fail(400, 'Invalid document path')
  const remote = directory.replace(/\\/g, '/').replace(/\/$/, '') || '/'
  const root = mapping.roots
    .filter(root => remote === root.remote || remote.startsWith(root.remote === '/' ? '/' : `${root.remote}/`))
    .sort((a, b) => b.remote.length - a.remote.length)[0]
  if (!root || file.startsWith('/') || /^[a-z]:/i.test(file))
    fail(403, 'Document path is outside the allowed project roots')
  const path = resolve(root.local, remote.slice(root.remote.length).replace(/^\//, ''), file.replace(/\\/g, '/'))
  const canonical = await realpath(path)
  if (!inside(root.local, canonical) || canonical !== path)
    fail(403, 'Symlinks and paths outside project roots are not allowed')
  const info = await stat(canonical)
  if (!info.isFile()) fail(400, 'Not a regular file')
  const extension = extname(path).slice(1).toLowerCase()
  if (!formats[extension]) fail(415, 'Unsupported Office format')
  return { path, extension, mode: info.mode, size: info.size }
}
async function readLimited(response, maxBytes) {
  if (!response.ok) fail(502, 'Document server did not return the saved file')
  if (Number(response.headers.get('content-length')) > maxBytes) fail(413, 'Saved document is too large')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) fail(413, 'Saved document is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Pure Node service. Browser requests use mapping credentials; document-server requests use signed capabilities. */
export async function createOfficeBridge(config, { fetchImpl = fetch } = {}) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 })
  const sessions = new Map(),
    locks = new Set()
  const persist = async session => {
    const path = resolve(config.dataDirectory, `${session.id}.json`),
      temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600 })
    await rename(temporary, path)
  }
  for (const name of await readdir(config.dataDirectory))
    if (/^[\da-f-]+\.json$/.test(name)) {
      try {
        const session = JSON.parse(await readFile(resolve(config.dataDirectory, name), 'utf8'))
        if (session.expires > Date.now() && session.id === name.slice(0, -5)) sessions.set(session.id, session)
        else if (session.id === name.slice(0, -5))
          await Promise.all([
            rm(resolve(config.dataDirectory, name), { force: true }),
            rm(resolve(config.dataDirectory, `${session.id}.source`), { force: true }),
          ])
      } catch {
        /* Ignore incomplete journals. */
      }
    }
  const sessionPath = async session => {
    const mapping = config.mappings.find(item => item.id === session.mappingId)
    if (!mapping) fail(403, 'Mapping no longer exists')
    return resolveDocument(mapping, session.directory, session.file)
  }
  const capability = (session, operation) =>
    signToken({ id: session.id, operation, exp: Math.floor(session.expires / 1000) }, config.secret)
  const getSession = (url, operation) => {
    const token = verifyToken(url.searchParams.get('token'), config.secret)
    if (token.operation !== operation) fail(403, 'Invalid document operation')
    const session = sessions.get(token.id)
    if (!session || session.expires < Date.now()) fail(410, 'Document session expired; reopen the file')
    return session
  }
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  const server = http.createServer({ requestTimeout: 60_000, headersTimeout: 30_000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const url = new URL(request.url, 'http://bridge')
    try {
      if (url.pathname === '/health' && request.method === 'GET') return send(response, 200, { healthy: true })
      if (url.pathname.startsWith('/context-plugin/') && request.method === 'GET') {
        return send(response, 404, { message: 'Office selection integration is disabled' })
      }
      if (url.pathname === '/config' && request.method === 'POST') {
        if (!config.frontendOrigins.includes(request.headers.origin)) fail(403, 'Frontend origin is not allowed')
        const body = await jsonBody(request)
        if (body.mode !== undefined && !['view', 'edit'].includes(body.mode)) fail(400, 'Invalid document mode')
        const mapping = matchMapping(config, body.serverUrl, request.headers.origin)
        authorize(request, mapping)
        for (const [id, previous] of sessions)
          if (previous.expires < Date.now()) {
            sessions.delete(id)
            await Promise.all([
              rm(resolve(config.dataDirectory, `${id}.json`), { force: true }),
              rm(resolve(config.dataDirectory, `${id}.source`), { force: true }),
            ])
          }
        if (sessions.size >= 1000) fail(503, 'Office session capacity reached; retry after older sessions expire')
        const document = await resolveDocument(mapping, body.directory, body.path)
        if (document.size > config.maxBytes) fail(413, 'Document is too large')
        const source = await readFile(document.path),
          sourceHash = hash(source)
        if (source.length > config.maxBytes) fail(413, 'Document is too large')
        const canEdit = body.mode !== 'view' && editable.has(document.extension)
        const sessionMode = canEdit ? 'edit' : 'view'
        let session = Array.from(sessions.values()).find(
          item =>
            item.mappingId === mapping.id &&
            item.directory === body.directory &&
            item.file === body.path &&
            item.hash === sourceHash &&
            item.mode === sessionMode &&
            !item.closed &&
            !item.error &&
            item.expires > Date.now() + 60_000,
        )
        if (!session) {
          session = {
            id: randomUUID(),
            mappingId: mapping.id,
            directory: body.directory,
            file: body.path,
            mode: sessionMode,
            hash: sourceHash,
            key: hash(`${mapping.id}:${document.path}:${sourceHash}:${randomUUID()}`),
            expires: Date.now() + 7 * 86400_000,
            error: '',
            closed: false,
          }
          await writeFile(resolve(config.dataDirectory, `${session.id}.source`), source, { mode: 0o600 })
          await persist(session)
          sessions.set(session.id, session)
        }
        const editorConfig = {
          document: {
            fileType: document.extension,
            key: session.key,
            title: basename(document.path),
            url: `${config.bridgeDocumentUrl}/file?token=${encodeURIComponent(capability(session, 'read'))}`,
            permissions: {
              edit: canEdit,
              review: canEdit,
              comment: canEdit,
              fillForms: canEdit,
              modifyFilter: canEdit,
              modifyContentControl: canEdit,
              download: true,
              print: true,
            },
          },
          documentType: formats[document.extension],
          type: 'desktop',
          width: '100%',
          height: '100%',
          editorConfig: {
            mode: canEdit ? 'edit' : 'view',
            lang: body.language === 'zh-CN' ? 'zh-CN' : 'en',
            callbackUrl: `${config.bridgeDocumentUrl}/callback?token=${encodeURIComponent(capability(session, 'callback'))}`,
            user: {
              id: hash(`${mapping.id}:${mapping.username ?? session.id}`).slice(0, 24),
              name: mapping.username || 'Office user',
            },
            customization: {
              forcesave: canEdit,
              autosave: canEdit,
              ...(canEdit ? {} : { compactToolbar: true, toolbar: false, hideRightMenu: true }),
            },
          },
        }
        editorConfig.token = signToken(editorConfig, config.secret)
        return send(response, 200, {
          scriptUrl: `${config.documentServerPublicUrl}/web-apps/apps/api/documents/api.js`,
          config: editorConfig,
          sessionToken: capability(session, 'status'),
          editable: canEdit,
        })
      }
      if (url.pathname === '/file' && request.method === 'GET') {
        const session = getSession(url, 'read')
        await sessionPath(session)
        const bytes = await readFile(resolve(config.dataDirectory, `${session.id}.source`))
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
          'cache-control': 'no-store',
        })
        return response.end(bytes)
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        const session = getSession(url, 'status')
        return send(response, 200, {
          savedAt: session.savedAt || null,
          error: session.error || '',
          closed: !!session.closed,
        })
      }
      if (url.pathname === '/callback' && request.method === 'POST') {
        const session = getSession(url, 'callback')
        const body = await jsonBody(request)
        const signed = request.headers.authorization?.replace(/^Bearer /i, '') || body.token
        const claims = verifyToken(signed, config.secret)
        const event = claims.payload || claims
        if (event.key !== session.key) fail(403, 'Document key mismatch')
        if ([3, 7].includes(event.status)) {
          session.error = 'Document server could not save the file'
          await persist(session)
          return send(response, 200, { error: 0 })
        }
        if (![2, 6].includes(event.status)) {
          if (event.status === 4) {
            session.closed = true
            await persist(session)
          }
          return send(response, 200, { error: 0 })
        }
        if (session.mode === 'view') fail(403, 'Read-only document sessions cannot save changes')
        const document = await sessionPath(session)
        const lockKey = document.path
        if (locks.has(lockKey)) return send(response, 409, { error: 1 })
        locks.add(lockKey)
        try {
          if (!editable.has(document.extension))
            fail(403, 'Legacy formats are view-only; convert to docx/xlsx/pptx first')
          const savedUrl = new URL(event.url)
          const publicUrl = new URL(config.documentServerPublicUrl),
            internalUrl = new URL(config.documentServerInternalUrl)
          if (
            ![publicUrl.origin, internalUrl.origin].includes(savedUrl.origin) ||
            savedUrl.username ||
            savedUrl.password
          )
            fail(403, 'Saved-file URL is not a configured document server')
          // Route downloads through the configured internal service; never follow redirects.
          let savedPath = savedUrl.pathname
          if (savedUrl.origin === publicUrl.origin) {
            const prefix = publicUrl.pathname.replace(/\/+$/, '')
            if (prefix && savedPath !== prefix && !savedPath.startsWith(`${prefix}/`))
              fail(403, 'Saved-file URL is outside the configured document server path')
            if (prefix) savedPath = savedPath.slice(prefix.length) || '/'
          } else {
            const prefix = internalUrl.pathname.replace(/\/+$/, '')
            if (prefix && savedPath !== prefix && !savedPath.startsWith(`${prefix}/`))
              fail(403, 'Saved-file URL is outside the configured internal document server path')
            if (prefix) savedPath = savedPath.slice(prefix.length) || '/'
          }
          const downloadUrl = new URL(internalUrl.href)
          downloadUrl.pathname = `${internalUrl.pathname.replace(/\/+$/, '')}/${savedPath.replace(/^\/+/, '')}`
          downloadUrl.search = savedUrl.search
          const bytes = await readLimited(
            await fetchImpl(downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) }),
            config.maxBytes,
          )
          if (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 75)
            fail(502, 'Saved document is not an Office package')
          const original = await readFile(document.path)
          const currentHash = hash(original),
            newHash = hash(bytes)
          if (currentHash !== session.hash && currentHash !== newHash) {
            const recovery = `${session.id}-${Date.now()}.${document.extension}`
            await writeFile(resolve(config.dataDirectory, recovery), bytes, { mode: 0o600 })
            fail(409, `File changed outside ONLYOFFICE. Edited copy retained in bridge data: ${recovery}`)
          }
          if (currentHash === newHash) {
            session.hash = newHash
          } else if (newHash !== session.hash) {
            await copyFile(document.path, `${document.path}.office-${Date.now()}-${session.id}.bak`)
            const temporary = `${document.path}.${randomUUID()}.tmp`
            try {
              await writeFile(temporary, bytes, { mode: document.mode })
              await chmod(temporary, document.mode)
              if (hash(await readFile(document.path)) !== session.hash)
                fail(409, 'File changed during save; original was not replaced')
              await rename(temporary, document.path)
            } finally {
              await rm(temporary, { force: true })
            }
            session.hash = hash(bytes)
          }
          session.savedAt = new Date().toISOString()
          session.error = ''
          if (event.status === 2) session.closed = true
          // Reopening an active force-saved session (or restarting Docs) must
          // retrieve the latest accepted version, not its original snapshot.
          const snapshot = resolve(config.dataDirectory, `${session.id}.source`)
          const snapshotTemp = `${snapshot}.${randomUUID()}.tmp`
          await writeFile(snapshotTemp, bytes, { mode: 0o600 })
          await rename(snapshotTemp, snapshot)
          await persist(session)
          return send(response, 200, { error: 0 })
        } catch (error) {
          session.error = error.message
          await persist(session)
          return send(response, error.status || 500, { error: 1, message: error.message })
        } finally {
          locks.delete(lockKey)
        }
      }
      send(response, 404, { message: 'Unknown Office bridge route' })
    } catch (error) {
      send(response, error.status || 500, {
        message: error.status ? error.message : 'Office bridge could not access this document',
      })
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = await loadConfig(process.env.OFFICE_BRIDGE_CONFIG || './office-bridge/config.json')
  const server = await createOfficeBridge(config)
  server.listen(config.port, config.host, () => console.log(`Office bridge listening on ${config.host}:${config.port}`))
}
