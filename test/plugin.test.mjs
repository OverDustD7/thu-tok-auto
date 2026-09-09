import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { test, before } from 'node:test'
import { createCore, AUTO_REFRESH_MS, AUTO_RETRY_MS, CRED_REF } from '../lib/core.js'

const tk = () => 't' + Math.random().toString(36).slice(2) + 'k'

function okResponse(payload, status = 200) {
  return { status, ok: status < 400, location: '', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}
const authOk = () => okResponse({ success: true })

function createRuntime(options = {}) {
  const seen = []
  const spawns = []
  const updates = []
  const saves = []
  const timers = []
  let stateData = options.stateData ?? null
  let credential = options.credential ?? ''
  const settings = { providers: { ...(options.providers || {}) } }

  const http = async (url, opts) => {
    seen.push({ url, headers: (opts && opts.headers) || {} })
    const custom = options.http && options.http({ url, headers: (opts && opts.headers) || {} })
    if (custom !== undefined) return custom
    if (url.endsWith('/model-api/auth-login/check')) {
      if (/\/auth-login\/check\?ticket=/.test(url)) return checkOk('ticket-token')
      return options.mint ? checkOk(options.mint) : { status: 401, ok: false, location: '', text: '' }
    }
    if (url.endsWith('/model-api/auth-login')) return authOk()
    return { status: 500, ok: false, location: '', text: '' }
  }
  const cdp = options.cdp || (async () => ({ ok: false, running: false, reason: 'no-devtools' }))

  const core = createCore({
    logger: { error() {}, log() {} },
    http,
    cdp,
    env: {
      home: options.home || 'C:\\Users\\test',
      temp: 'C:\\Temp',
      localAppData: options.localAppData || '',
      cwd: 'C:\\work',
    },
    clock: { now: () => (options.now !== undefined ? options.now : Date.now()) },
    stateIO: {
      async mkdir(p) { return { ok: true } },
      async load() { return { ok: true, data: stateData } },
      async save(p, data) {
        saves.push(data)
        stateData = { ...data }
        return { ok: true }
      },
    },
    settings: {
      async describe() { return [{ ns: 'llm-pi-ai' }] },
      async get(ns) { return ns === 'llm-pi-ai' ? settings : undefined },
      async update(ns, patch) {
        assert.equal(ns, 'llm-pi-ai')
        assert.equal(Object.getPrototypeOf(patch), Object.prototype, 'settings patch must be a plain Host-realm object')
        assert.equal(Object.getPrototypeOf(patch.providers), Object.prototype, 'nested patch must be a plain object')
        updates.push(patch)
        for (const [id, value] of Object.entries(patch.providers)) {
          if (!settings.providers[id]) settings.providers[id] = {}
          Object.assign(settings.providers[id], structuredClone(value))
        }
      },
    },
    credentials: {
      async resolve() { return credential ? { value: credential, source: 'test' } : undefined },
      async set(_ref, value) { credential = value },
    },
    findExecutable: async (c) => (options.findExe !== undefined ? options.findExe(c) : c),
    spawnBrowser: options.spawnBrowser || (async (exe, argv) => { spawns.push({ exe, argv }); return { pid: 4321 } }),
    timer: {
      interval(fn, ms) {
        const entry = { fn, ms, disposed: false }
        timers.push(entry)
        return () => { entry.disposed = true }
      },
    },
  })
  return {
    core, seen, spawns, updates, saves, timers, settings,
    get credential() { return credential },
    get stateData() { return stateData },
  }
}

const checkOk = (token) => okResponse({ success: true, data: token })

const run = async (rt) => {
  await rt.core.init()
  return rt.core.getTok()
}

test('bundle entry exports a Cordis plugin with host services injected', async () => {
  const entry = await import('../lib/index.js?t=' + Date.now())
  assert.equal(entry.name, 'thu-tok-auto')
  assert.deepEqual(entry.inject, ['settings', 'credentials', 'timer', 'webServer', 'connection'])
  const ui = fs.readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8')
  new vm.Script(ui, { filename: 'lib/ui.js' }) // parses as a plain script (no module syntax)
})

test('fresh mint creates a valid minimal llm-pi-ai route without exposing the token', async () => {
  const token = tk()
  const rt = createRuntime({
    mint: token,
    providers: { existing: { baseURL: 'https://example.invalid/v1' } },
  })
  const result = await run(rt)
  assert.equal(result.status, 'ok')
  assert.equal(result.busy, false)
  assert.equal(rt.credential, token)
  assert.deepEqual(rt.settings.providers.madmodel, {
    displayName: 'DeepSeek (THU)',
    apiKeyEnv: 'MADMODEL_API_KEY',
    api: 'openai-completions',
    reasoning: 'medium',
    baseURL: 'https://madmodel.cs.tsinghua.edu.cn/v1',
    models: [{
      id: 'DeepSeek-V4-Flash-0731',
      name: 'DeepSeek-V4-Flash (THU)',
      contextWindow: 150000,
      reasoningEfforts: { minimal: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    }],
  })
  assert.deepEqual(Object.keys(rt.updates.at(-1).providers), ['madmodel'], 'unrelated providers must not be copied into the user layer')
  assert.equal('token' in rt.stateData, false, 'token must never enter the state file')
  assert.equal(rt.stateData.lastGetAt > 0, true)
  assert.ok(rt.saves.every((s) => !('token' in s)))
})

test('an existing MadModel route keeps user-owned fields and only receives the credential reference', async () => {
  const rt = createRuntime({
    mint: tk(),
    providers: {
      custom: {
        displayName: 'My Campus Gateway',
        apiKeyEnv: 'OLD_KEY',
        api: 'openai-completions',
        baseURL: 'https://madmodel.cs.tsinghua.edu.cn/v1',
        models: [{ id: 'custom-model', contextWindow: 100000 }],
      },
    },
  })
  await run(rt)
  assert.equal(rt.settings.providers.custom.apiKeyEnv, 'MADMODEL_API_KEY')
  assert.equal(rt.settings.providers.custom.displayName, 'My Campus Gateway')
  assert.deepEqual(rt.settings.providers.custom.models, [{ id: 'custom-model', contextWindow: 100000 }])
  assert.deepEqual(Object.keys(rt.updates.at(-1).providers.custom), ['apiKeyEnv'])
  assert.equal((await rt.core.state()).providerName, 'My Campus Gateway')
})

test('reusing a still-valid token preserves its original local issuance time', async () => {
  const token = tk()
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: 123456, auto: false, cookies: 'session=abc', ssoCookies: '' },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  const result = await run(rt)
  assert.equal(result.via, 'reuse')
  assert.equal(result.lastGetAt, 123456)
})

test('a non-MadModel provider using the madmodel key is never overwritten', async () => {
  const original = { displayName: 'Other service', baseURL: 'https://example.invalid/v1', apiKeyEnv: 'OTHER_KEY' }
  const rt = createRuntime({ mint: tk(), providers: { madmodel: original } })
  const result = await run(rt)
  assert.equal(result.status, 'error')
  assert.match(result.err, /已被其他配置占用/)
  assert.deepEqual(rt.settings.providers.madmodel, original)
  assert.equal(rt.updates.length, 0)
})

test('legacy state migration removes plaintext tokens without overwriting a newer DSH credential', async () => {
  const rt = createRuntime({
    credential: 'newer-credential-token',
    stateData: {
      token: 'stale-legacy-token',
      lastGetAt: Date.now() + 24 * 3600e3,
      auto: false,
      cookies: {},
      ssoCookies: [],
    },
  })
  const state = await rt.core.state()
  assert.equal(rt.credential, 'newer-credential-token')
  assert.equal('token' in rt.stateData, false)
  assert.equal(state.lastGetAt, 0, 'a corrupt future timestamp must not suppress refresh indefinitely')
  assert.equal(rt.stateData.cookies, '')
  assert.equal(rt.stateData.ssoCookies, '')
})

test('capture fallback writes a minted token to credentials and provider settings', async () => {
  let mintAllowed = false
  const token = tk()
  const rt = createRuntime({
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) {
        return mintAllowed ? checkOk(token) : { status: 401, ok: false, location: '', text: '' }
      }
      return { status: 401, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) return { ok: false, running: false, reason: 'no-devtools' }
      return { ok: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [] }
    },
    findExe: () => 'C:\\Fake\\msedge.exe',
  })
  const first = await run(rt)
  assert.equal(first.loginRequired, true)
  const opened = await rt.core.openLogin()
  assert.equal(opened.launched, true)
  assert.equal(rt.spawns.length, 1)
  assert.ok(rt.spawns[0].argv.join(' ').includes('--remote-debugging-port='))
  mintAllowed = true
  const capture = rt.timers.find((t) => t.ms === 2500)
  assert.ok(capture, 'capture poll timer must be registered')
  await capture.fn()
  const state = await rt.core.state()
  assert.equal(state.status, 'ok')
  assert.equal(state.credentialWritten, true)
  assert.equal(rt.credential, token)
  assert.equal(state.provider, 'llm-pi-ai/madmodel')
  assert.equal(state.providerName, 'DeepSeek (THU)')
})

test('SSO replay refuses an off-domain redirect before sending cookies', async () => {
  const seen = []
  const rt = createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: 'sso=secret' },
    http({ url }) {
      seen.push(url)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.startsWith('https://id.tsinghua.edu.cn/')) {
        return { status: 302, ok: false, location: 'https://evil.example/?ticket=stolen', text: '' }
      }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  const result = await run(rt)
  assert.equal(result.loginRequired, true)
  assert.equal(seen.some((u) => u.startsWith('https://evil.example/')), false)
})

test('SSO replay resolves query-only redirects without changing the callback path', async () => {
  const expectedPath = '/do/off/ui/auth/login/form/d736f067a6705ab942df52f958a0f23b/0'
  const rt = createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: 'sso=secret' },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.includes('/model-api/auth-login/check?ticket=relative-ticket')) return checkOk('sso-token')
      const parsed = new URL(url)
      if (parsed.hostname === 'id.tsinghua.edu.cn' && parsed.search !== '?ticket=relative-ticket') {
        return { status: 302, ok: false, location: '?ticket=relative-ticket', text: '' }
      }
      if (parsed.hostname === 'id.tsinghua.edu.cn') {
        assert.equal(parsed.pathname, expectedPath)
        return { status: 200, ok: true, location: '', text: '' }
      }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  const result = await run(rt)
  assert.equal(result.via, 'sso')
  assert.equal(rt.credential, 'sso-token')
})

test('persisted Auto refresh runs from the Host timer without a browser page', async () => {
  const token = tk()
  const rt = createRuntime({
    mint: token,
    stateData: { lastGetAt: 1, auto: true, cookies: '', ssoCookies: '' },
  })
  await rt.core.init()
  await rt.core.autoTick()
  assert.equal(rt.credential, token)
})

test('Auto tick is throttled by AUTO_RETRY_MS after a run', async () => {
  const rt = createRuntime({
    mint: tk(),
    stateData: { lastGetAt: 1, auto: true, cookies: '', ssoCookies: '' },
    now: 1_000_000_000_000,
  })
  await rt.core.init()
  await rt.core.autoTick() // first attempt runs and mints
  const firstAt = rt.saves.at(-1)?.lastGetAt
  assert.ok(firstAt > 0)
  await rt.core.autoTick() // immediately after: throttled, no new mint
  assert.equal(rt.saves.at(-1)?.lastGetAt, firstAt)
})

test('openLogin reports no-debug-port when every port is taken', async () => {
  const rt = createRuntime({
    cdp: async () => ({ ok: false, running: true, reason: 'busy' }),
  })
  await rt.core.init()
  const opened = await rt.core.openLogin()
  assert.equal(opened.launched, false)
  assert.equal(opened.reason, 'no-debug-port')
})

test('openLogin recognizes a per-user browser install and reports spawn failures', async () => {
  const local = 'C:\\Users\\test\\AppData\\Local'
  let chosen = ''
  const rt = createRuntime({
    localAppData: local,
    findExe: (candidate) => candidate === local + '\\Google\\Chrome\\Application\\chrome.exe' ? candidate : null,
    spawnBrowser: async (exe) => {
      chosen = exe
      throw new Error('spawn failed')
    },
  })
  await rt.core.init()
  const opened = await rt.core.openLogin()
  assert.equal(chosen, local + '\\Google\\Chrome\\Application\\chrome.exe')
  assert.equal(opened.launched, false)
  assert.equal(opened.reason, 'error')
  assert.equal((await rt.core.state()).browserOpen, false)
})

test('disposing the core stops capture and prevents stale timer callbacks', async () => {
  let cdpCalls = 0
  const rt = createRuntime({
    cdp: async (arg) => {
      cdpCalls++
      if (arg.probeOnly) return { ok: false, running: false, reason: 'no-devtools' }
      return { ok: true, token: '', url: '', cookies: [] }
    },
    findExe: () => 'C:\\Fake\\msedge.exe',
  })
  await rt.core.init()
  await rt.core.openLogin()
  const capture = rt.timers.find((t) => t.ms === 2500)
  assert.ok(capture)
  const callsBeforeDispose = cdpCalls
  rt.core.dispose()
  assert.equal(capture.disposed, true)
  await capture.fn()
  assert.equal(cdpCalls, callsBeforeDispose)
  assert.equal((await rt.core.state()).browserOpen, false)
})

// ---------------------------------------------------------------- host shell
function fakeRes() {
  const out = { code: 200, headers: {}, body: '' }
  const res = {
    destroyed: false, writableEnded: false,
    writeHead(code, headers) { out.code = code; out.headers = headers },
    end(body) { out.body = String(body) },
  }
  return { res, out }
}
function fakeReq(method, headers, payload) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers || {}
  req.resume = () => {}
  const data = Buffer.from(payload === undefined ? '{}' : JSON.stringify(payload))
  setImmediate(() => {
    if (data.length) req.emit('data', data)
    req.emit('end')
  })
  return req
}

function fakeRawReq(method, headers, payload) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers || {}
  req.resume = () => {}
  const data = Buffer.from(payload || '')
  setImmediate(() => {
    if (data.length) req.emit('data', data)
    req.emit('end')
  })
  return req
}

function hostShellCtx(overrides = {}) {
  const routes = []
  const indexListeners = []
  const intervals = []
  const effects = []
  const settings = {
    describe: async () => [{ ns: 'llm-pi-ai' }],
    get: async () => ({ providers: {} }),
    update: async () => {},
  }
  const credentials = { resolve: async () => undefined, set: async () => {} }
  const services = {
    webServer: {
      register(e) {
        e.disposed = false
        routes.push(e)
        return () => { e.disposed = true }
      },
    },
    connection: { requestRejection() { return undefined } },
    timer: {
      interval(fn, ms) {
        const entry = { fn, ms, disposed: false }
        intervals.push(entry)
        return () => { entry.disposed = true }
      },
    },
    settings,
    credentials,
  }
  const ctx = {
    get(name) { return name in overrides ? overrides[name] : services[name] },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => {}
    },
    on(name, fn) {
      assert.equal(name, 'webserver/index-inject')
      indexListeners.push(fn)
      return () => {
        const at = indexListeners.indexOf(fn)
        if (at >= 0) indexListeners.splice(at, 1)
      }
    },
    interval(fn, ms) { return services.timer.interval(fn, ms) },
  }
  return { ctx, routes, indexListeners, intervals, effects }
}

const shellHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-tok-auto-shell-'))
before(() => {
  // Isolate the real state directory used by the shell (fs-backed stateIO).
  const dir = path.join(shellHome, '.dsh', 'madmodel')
  fs.mkdirSync(dir, { recursive: true })
  // A fresh lastGetAt so set-auto does not trigger an immediate (network) tick.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    lastGetAt: Date.now(), auto: false, cookies: '', ssoCookies: '',
  }))
  process.env.THU_TOK_AUTO_HOME = shellHome
})

test('host shell registers API routes, injects the UI script once, and starts Auto on a 30s timer', async () => {
  const { ctx, routes, indexListeners, intervals, effects } = hostShellCtx()
  const entry = await import('../lib/index.js?t=' + Date.now())
  await entry.apply(ctx)
  await new Promise((r) => setTimeout(r, 80)) // let the async init settle
  const paths = routes.map((r) => r.path)
  assert.deepEqual(paths, [
    '/thu-tok-auto/api/status',
    '/thu-tok-auto/api/get-tok',
    '/thu-tok-auto/api/open-login',
    '/thu-tok-auto/api/set-auto',
    '/thu-tok-auto/ui.js',
  ])
  assert.equal(indexListeners.length, 1)
  const table = []
  indexListeners[0](table)
  assert.deepEqual(table, [{ kind: 'script-src', placement: 'body', src: '/thu-tok-auto/ui.js' }])
  const autoTimer = intervals.find((i) => i.ms === 30000)
  assert.ok(autoTimer)
  assert.equal(effects.length, 1)
  effects[0]()
  assert.equal(autoTimer.disposed, true)
  assert.equal(routes.every((r) => r.disposed), true)
  assert.equal(indexListeners.length, 0)
})

test('host shell rejects untrusted requests before invoking handlers', async () => {
  const { ctx, routes } = hostShellCtx({ connection: { requestRejection() { return 401 } } })
  const entry = await import('../lib/index.js?t=' + Date.now())
  await entry.apply(ctx)
  const status = routes.find((r) => r.path === '/thu-tok-auto/api/status')

  const { res, out } = fakeRes()
  await status.handler(fakeReq('GET'), res)
  assert.equal(out.code, 401)
  assert.equal(JSON.parse(out.body).ok, false)

  const other = hostShellCtx({ connection: { requestRejection() { return 409 } } })
  const entry2 = await import('../lib/index.js?t=' + Date.now())
  await entry2.apply(other.ctx)
  const s2 = other.routes.find((r) => r.path === '/thu-tok-auto/api/status')
  const { res: r2, out: o2 } = fakeRes()
  await s2.handler(fakeReq('GET'), r2)
  assert.equal(o2.code, 403, 'unexpected rejection codes must be normalized to a safe denial')
})

test('host shell fails closed when the DSH trust checker throws', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const { ctx, routes } = hostShellCtx({ connection: { requestRejection() { throw new Error('trust unavailable') } } })
    const entry = await import('../lib/index.js?t=' + Date.now())
    await entry.apply(ctx)
    const status = routes.find((r) => r.path === '/thu-tok-auto/api/status')
    const { res, out } = fakeRes()
    await status.handler(fakeReq('GET'), res)
    assert.equal(out.code, 403)
  } finally {
    console.error = originalError
  }
})

test('host shell GET status and POST set-auto round-trip through real http/fs wiring', async () => {
  const { ctx, routes } = hostShellCtx()
  const entry = await import('../lib/index.js?t=' + Date.now())
  await entry.apply(ctx)
  await new Promise((r) => setTimeout(r, 80))
  const statusRoute = routes.find((r) => r.path === '/thu-tok-auto/api/status')
  const setAutoRoute = routes.find((r) => r.path === '/thu-tok-auto/api/set-auto')

  const { res, out } = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res)
  const snap = JSON.parse(out.body)
  assert.equal(snap.auto, false)
  assert.equal(out.code, 200)

  const { res: r2, out: o2 } = fakeRes()
  await setAutoRoute.handler(fakeReq('POST', { 'content-type': 'application/json' }, { on: true }), r2)
  assert.equal(JSON.parse(o2.body).auto, true)
  assert.equal(o2.code, 200)

  // Real fs-backed state file at THU_TOK_AUTO_HOME\.dsh\madmodel\state.json,
  // written atomically, and containing no plaintext token.
  const statePath = path.join(process.env.THU_TOK_AUTO_HOME, '.dsh', 'madmodel', 'state.json')
  assert.equal(fs.existsSync(statePath), true)
  const file = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(file.auto, true)
  assert.equal('token' in file, false)

  // Non-JSON POST is refused with 415.
  const { res: r3, out: o3 } = fakeRes()
  await setAutoRoute.handler(fakeReq('POST', { 'content-type': 'text/plain' }, { on: false }), r3)
  assert.equal(o3.code, 415)

  // Invalid JSON, invalid field types and oversized bodies have specific 4xx responses.
  const { res: r4, out: o4 } = fakeRes()
  await setAutoRoute.handler(fakeRawReq('POST', { 'content-type': 'application/json' }, '{'), r4)
  assert.equal(o4.code, 400)

  const { res: r5, out: o5 } = fakeRes()
  await setAutoRoute.handler(fakeReq('POST', { 'content-type': 'application/json' }, { on: 'true' }), r5)
  assert.equal(o5.code, 400)

  const { res: r6, out: o6 } = fakeRes()
  await setAutoRoute.handler(fakeRawReq('POST', { 'content-type': 'application/json' }, 'x'.repeat(70 * 1024)), r6)
  assert.equal(o6.code, 413)

  const { res: r7, out: o7 } = fakeRes()
  await statusRoute.handler(fakeReq('POST'), r7)
  assert.equal(o7.code, 405)
  assert.equal(o7.headers.Allow, 'GET')
})

test('host shell survives a missing webServer (never shuts the profile down)', async () => {
  const { ctx } = hostShellCtx({ webServer: undefined, connection: undefined })
  const entry = await import('../lib/index.js?t=' + Date.now())
  await entry.apply(ctx) // must not throw
})
