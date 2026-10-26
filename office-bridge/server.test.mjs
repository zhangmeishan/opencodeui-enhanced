// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOfficeBridge, loadConfig, signToken, verifyToken } from './server.mjs'

const secret = 'local-test-secret-that-is-at-least-32-characters'
const origin = 'http://localhost:2635'
const authorization = `Basic ${Buffer.from('office:test-password').toString('base64')}`
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

describe('ONLYOFFICE bridge with isolated local files', () => {
  let directory, project, server, base, config, fetchImpl
  beforeEach(async () => {
    directory = await mkdtemp(resolve('scripts/.office-test-'))
    project = resolve(directory, 'project')
    await mkdir(project)
    await writeFile(resolve(project, 'report.docx'), Buffer.from('PK\x03\x04original'))
    fetchImpl = vi.fn(async () => new Response(Buffer.from('PK\x03\x04edited')))
    config = {
      secret,
      mappings: [
        {
          id: 'main',
          apiUrl: '/api',
          username: 'office',
          password: 'test-password',
          roots: [{ remote: '/workspace', local: await realpath(project) }],
        },
      ],
      documentServerPublicUrl: 'http://office.example',
      documentServerInternalUrl: 'http://document-server',
      bridgeDocumentUrl: 'http://office-bridge:8093',
      frontendOrigins: [origin],
      dataDirectory: resolve(directory, 'data'),
      maxBytes: 1024 * 1024,
    }
    server = await createOfficeBridge(config, { fetchImpl })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterEach(async () => {
    await new Promise(done => server.close(done))
    await rm(directory, { recursive: true, force: true })
  })
  async function open(overrides = {}, headers = {}) {
    return fetch(`${base}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, authorization, ...headers },
      body: JSON.stringify({ serverUrl: `${origin}/api`, directory: '/workspace', path: 'report.docx', ...overrides }),
    })
  }
  async function callback(session, payload, token) {
    const url = new URL(session.config.editorConfig.callbackUrl)
    return fetch(`${base}${url.pathname}${url.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token || signToken(payload, secret)}` },
      body: JSON.stringify({ ...payload, token: token || signToken(payload, secret) }),
    })
  }

  it('returns a signed editor config with a snapshot URL and preserves document keys for concurrent opens', async () => {
    const session = await (await open()).json()
    expect(session.editable).toBe(true)
    const claims = verifyToken(session.config.token, secret)
    expect(claims.document.key).toBe(session.config.document.key)
    const again = await (await open()).json()
    expect(again.config.document.key).toBe(session.config.document.key)
    const fileUrl = new URL(session.config.document.url)
    const response = await fetch(`${base}${fileUrl.pathname}${fileUrl.search}`)
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('PK\x03\x04original')
    const status = await (await fetch(`${base}/status?token=${encodeURIComponent(session.sessionToken)}`)).json()
    expect(status.error).toBe('')
  })

  it('opens presentations and spreadsheets in a signed read-only viewer without selection plugins', async () => {
    for (const extension of ['docx', 'pptx', 'xlsx', 'ppt', 'xls', 'odp', 'ods']) {
      await writeFile(resolve(project, `report.${extension}`), Buffer.from('PK\x03\x04original'))
      const session = await (await open({ path: `report.${extension}`, mode: 'view' })).json()
      expect(session.editable).toBe(false)
      expect(session.config.document.permissions.edit).toBe(false)
      expect(session.config.document.permissions).toMatchObject({
        review: false,
        comment: false,
        fillForms: false,
        modifyFilter: false,
        modifyContentControl: false,
      })
      expect(session.config.editorConfig.mode).toBe('view')
      const claims = verifyToken(session.config.token, secret)
      expect(claims.document.permissions.edit).toBe(false)
      expect(session.config.editorConfig.plugins).toBeUndefined()
    }
  })
  it('keeps preview and editing keys separate and prevents preview callbacks from modifying modern documents', async () => {
    const editor = await (await open({ mode: 'edit' })).json()
    const viewer = await (await open({ mode: 'view' })).json()
    expect(viewer.config.document.key).not.toBe(editor.config.document.key)
    expect((await (await open({ mode: 'view' })).json()).config.document.key).toBe(viewer.config.document.key)
    expect((await (await open({ mode: 'edit' })).json()).config.document.key).toBe(editor.config.document.key)
    expect(viewer.config.editorConfig.customization).toMatchObject({
      forcesave: false,
      autosave: false,
      toolbar: false,
    })
    const write = { key: viewer.config.document.key, status: 6, url: 'http://office.example/cache/changed.docx' }
    expect((await callback(viewer, write)).status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await readFile(resolve(project, 'report.docx'), 'utf8')).toBe('PK\x03\x04original')
    expect((await callback(editor, { ...write, key: editor.config.document.key })).status).toBe(200)
  })
  it('rejects invalid mode values rather than upgrading them to edit permissions', async () => {
    expect((await open({ mode: 'preview' })).status).toBe(400)
  })

  it('does not serve obsolete Office selection plugins', async () => {
    const params = new URLSearchParams({
      origin: 'http://untrusted.example',
      channel: '12345678-1234-1234-1234-123456789abc',
    })
    expect((await fetch(`${base}/context-plugin/config.json?${params}`)).status).toBe(404)
    params.set('origin', origin)
    params.set('channel', '<script>')
    expect((await fetch(`${base}/context-plugin/index.html?${params}`)).status).toBe(404)
  })
  it('rejects wrong credentials, wrong origins, unknown servers and escaping paths', async () => {
    expect((await open({}, { authorization: '' })).status).toBe(401)
    expect((await open({}, { origin: 'http://untrusted.example' })).status).toBe(403)
    expect((await open({ serverUrl: `${origin}/other` })).status).toBe(403)
    expect((await open({ path: '../secret.docx' })).status).not.toBe(200)
    await writeFile(resolve(directory, 'outside.docx'), 'outside')
    await symlink(resolve(directory, 'outside.docx'), resolve(project, 'link.docx'))
    expect((await open({ path: 'link.docx' })).status).toBe(403)
  })
  it('saves force-save and close callbacks, retains backups and reports saved status', async () => {
    const session = await (await open()).json()
    const event = { key: session.config.document.key, status: 6, url: 'http://office.example/cache/edited.docx' }
    expect((await callback(session, event)).status).toBe(200)
    expect(await readFile(resolve(project, 'report.docx'), 'utf8')).toBe('PK\x03\x04edited')
    expect((await readdir(project)).some(name => name.endsWith('.bak'))).toBe(true)
    expect(fetchImpl.mock.calls[0][0].href).toBe('http://document-server/cache/edited.docx')
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error')
    const status = await (await fetch(`${base}/status?token=${encodeURIComponent(session.sessionToken)}`)).json()
    expect(status.savedAt).toBeTruthy()
    const fileUrl = new URL(session.config.document.url)
    const reopened = await fetch(`${base}${fileUrl.pathname}${fileUrl.search}`)
    expect(Buffer.from(await reopened.arrayBuffer()).toString()).toBe('PK\x03\x04edited')
    expect((await callback(session, { ...event, status: 2 })).status).toBe(200)
    expect((await (await open()).json()).config.document.key).not.toBe(session.config.document.key)
  })
  it('rejects unsigned callbacks and untrusted download hosts', async () => {
    const session = await (await open()).json()
    const event = { key: session.config.document.key, status: 2, url: 'http://evil.example/file.docx' }
    expect((await callback(session, event, signToken(event, 'wrong-secret'))).status).toBe(401)
    expect((await callback(session, event)).status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('keeps external edits and retains the Office result for recovery on conflict', async () => {
    const session = await (await open()).json()
    await writeFile(resolve(project, 'report.docx'), 'external modification')
    const response = await callback(session, {
      key: session.config.document.key,
      status: 2,
      url: 'http://office.example/cache/file.docx',
    })
    expect(response.status).toBe(409)
    expect(await readFile(resolve(project, 'report.docx'), 'utf8')).toBe('external modification')
    const recovery = (await readdir(config.dataDirectory)).find(name => name.endsWith('.docx'))
    expect(hash(await readFile(resolve(config.dataDirectory, recovery)))).toBe(hash(Buffer.from('PK\x03\x04edited')))
  })
  it('accepts the signed payload wrapper used by document server callbacks and restores sessions after restart', async () => {
    const session = await (await open()).json()
    const event = { key: session.config.document.key, status: 6, url: 'http://office.example/cache/file.docx' }
    expect((await callback(session, event, signToken({ payload: event }, secret))).status).toBe(200)
    await new Promise(done => server.close(done))
    server = await createOfficeBridge(config, { fetchImpl })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${server.address().port}`
    const status = await fetch(`${base}/status?token=${encodeURIComponent(session.sessionToken)}`)
    expect(status.status).toBe(200)
  })

  it('opens legacy formats in read-only mode and rejects write callbacks', async () => {
    await writeFile(resolve(project, 'legacy.doc'), 'legacy document')
    const session = await (await open({ path: 'legacy.doc' })).json()
    expect(session.editable).toBe(false)
    expect(session.config.editorConfig.mode).toBe('view')
    expect(
      (
        await callback(session, {
          key: session.config.document.key,
          status: 2,
          url: 'http://office.example/cache/file.docx',
        })
      ).status,
    ).toBe(403)
    expect(await readFile(resolve(project, 'legacy.doc'), 'utf8')).toBe('legacy document')
  })

  it('does not treat an unchanged callback as saved when the source was changed externally', async () => {
    const session = await (await open()).json()
    fetchImpl.mockResolvedValue(new Response(Buffer.from('PK\x03\x04original')))
    await writeFile(resolve(project, 'report.docx'), 'external edit')
    expect(
      (
        await callback(session, {
          key: session.config.document.key,
          status: 6,
          url: 'http://office.example/cache/file.docx',
        })
      ).status,
    ).toBe(409)
    const status = await (await fetch(`${base}/status?token=${encodeURIComponent(session.sessionToken)}`)).json()
    expect(status.error).toContain('changed outside')
    expect(status.savedAt).toBeNull()
  })

  it('allows explicitly disabled password login while still requiring signed document callbacks', async () => {
    config.mappings[0].auth = 'none'
    const sessionResponse = await open({}, { authorization: '' })
    expect(sessionResponse.status).toBe(200)
    const session = await sessionResponse.json()
    const event = { key: session.config.document.key, status: 2, url: 'http://office.example/cache/file.docx' }
    expect((await callback(session, event, signToken(event, 'invalid-secret'))).status).toBe(401)
    expect((await open({}, { origin: 'https://unknown.example', authorization: '' })).status).toBe(403)
  })

  it('isolates two services even when both expose /workspace/report.docx and use public URLs', async () => {
    const second = resolve(directory, 'second')
    await mkdir(second)
    await writeFile(resolve(second, 'report.docx'), Buffer.from('PK\x03\x04second-service'))
    config.frontendOrigins.push('https://chat.example.com')
    config.mappings[0].apiUrls = ['/api', 'https://opencode-a.example.com']
    config.mappings[0].auth = 'none'
    config.mappings.push({
      id: 'second',
      apiUrls: ['/api-mason', 'https://opencode-b.example.com:8443'],
      auth: 'none',
      roots: [{ remote: '/workspace', local: await realpath(second) }],
    })
    const headers = { origin: 'https://chat.example.com', authorization: '' }
    const a = await (await open({ serverUrl: 'https://chat.example.com/api' }, headers)).json()
    const b = await (await open({ serverUrl: 'https://chat.example.com/api-mason' }, headers)).json()
    expect(a.config.document.key).not.toBe(b.config.document.key)
    for (const [session, contents] of [
      [a, 'PK\x03\x04original'],
      [b, 'PK\x03\x04second-service'],
    ]) {
      const fileUrl = new URL(session.config.document.url)
      expect(await (await fetch(`${base}${fileUrl.pathname}${fileUrl.search}`)).text()).toBe(contents)
    }
    const direct = await (await open({ serverUrl: 'https://opencode-b.example.com:8443' }, headers)).json()
    expect(direct.config.document.key).toBe(b.config.document.key)
    expect((await open({ serverUrl: 'https://wrong-host.example/api' }, headers)).status).toBe(403)
    expect(
      (await callback(b, { key: b.config.document.key, status: 6, url: 'http://office.example/cache/file.docx' }))
        .status,
    ).toBe(200)
    expect(await readFile(resolve(project, 'report.docx'), 'utf8')).toBe('PK\x03\x04original')
    expect(await readFile(resolve(second, 'report.docx'), 'utf8')).toBe('PK\x03\x04edited')
  })

  it('rejects ambiguous URL mappings instead of choosing the wrong service', async () => {
    config.mappings.push({ ...config.mappings[0], id: 'duplicate-url' })
    expect((await open()).status).toBe(409)
  })

  it('strips the public ONLYOFFICE subpath when downloading a saved document internally', async () => {
    config.documentServerPublicUrl = 'https://lcj.lychee-nlp2ai.com/onlyoffice'
    const session = await (await open()).json()
    expect(session.scriptUrl).toBe('https://lcj.lychee-nlp2ai.com/onlyoffice/web-apps/apps/api/documents/api.js')
    const response = await callback(session, {
      key: session.config.document.key,
      status: 6,
      url: 'https://lcj.lychee-nlp2ai.com/onlyoffice/cache/file.docx?token=test&expires=123',
    })
    expect(response.status).toBe(200)
    expect(fetchImpl.mock.calls[0][0].href).toBe('http://document-server/cache/file.docx?token=test&expires=123')
    expect(await readFile(resolve(project, 'report.docx'), 'utf8')).toBe('PK\x03\x04edited')
  })

  it('rejects saved-file URLs outside the configured public subpath', async () => {
    config.documentServerPublicUrl = 'https://lcj.lychee-nlp2ai.com/onlyoffice'
    const session = await (await open()).json()
    const response = await callback(session, {
      key: session.config.document.key,
      status: 6,
      url: 'https://lcj.lychee-nlp2ai.com/other/file.docx',
    })
    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps internal saved-file URLs working when the browser uses a public subpath', async () => {
    config.documentServerPublicUrl = 'https://lcj.lychee-nlp2ai.com/onlyoffice'
    const session = await (await open()).json()
    const response = await callback(session, {
      key: session.config.document.key,
      status: 6,
      url: 'http://document-server/cache/file.docx',
    })
    expect(response.status).toBe(200)
    expect(fetchImpl.mock.calls[0][0].href).toBe('http://document-server/cache/file.docx')
  })

  it('loads none/basic auth independently per service and supports legacy apiUrl configs', async () => {
    const path = resolve(directory, 'config.json')
    const raw = {
      documentServerPublicUrl: 'https://office.example.com',
      documentServerInternalUrl: 'http://onlyoffice',
      bridgeDocumentUrl: 'http://office-bridge:8093',
      frontendOrigins: ['https://chat.example.com'],
      mappings: [
        {
          id: 'none',
          auth: 'none',
          apiUrls: ['/api', 'https://opencode-a.example.com'],
          roots: [{ remote: '/workspace', local: project }],
        },
        {
          id: 'basic',
          apiUrl: '/api-mason',
          usernameEnv: 'OFFICE_USER',
          passwordEnv: 'OFFICE_PASSWORD',
          roots: [{ remote: '/different/root', local: project }],
        },
      ],
    }
    await writeFile(path, JSON.stringify(raw))
    const loaded = await loadConfig(path, {
      ONLYOFFICE_JWT_SECRET: secret,
      OFFICE_USER: 'user',
      OFFICE_PASSWORD: 'password',
    })
    expect(loaded.mappings[0]).toMatchObject({ auth: 'none', apiUrls: ['/api', 'https://opencode-a.example.com'] })
    expect(loaded.mappings[1]).toMatchObject({ auth: 'basic', apiUrls: ['/api-mason'], username: 'user' })
    await expect(loadConfig(path, { ONLYOFFICE_JWT_SECRET: secret })).rejects.toThrow('Missing credentials')
    raw.mappings = [raw.mappings[0]]
    await writeFile(path, JSON.stringify(raw))
    await expect(loadConfig(path, { ONLYOFFICE_JWT_SECRET: secret })).resolves.toMatchObject({
      mappings: [expect.objectContaining({ auth: 'none' })],
    })
  })
})
