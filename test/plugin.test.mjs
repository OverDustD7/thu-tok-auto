import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { test, before } from 'node:test'
import { createCore, extractModelList, toProviderModels, buildCookieHeader, jwtExpiry, AUTO_REFRESH_MS, AUTO_RETRY_MS, CAPTURE_TIMEOUT_MS, HEADLESS_TIMEOUT_MS, CRED_REF, MANUAL_WAIT_MS, SSO_LOGIN_URL } from '../lib/core.js'
import { createBrowserCloser, createApiHandlers } from '../lib/index.js'

const tk = () => 't' + Math.random().toString(36).slice(2) + 'k'

function okResponse(payload, status = 200) {
  return { status, ok: status < 400, location: '', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}
const authOk = () => okResponse({ success: true })

function createRuntime(options = {}) {
  const seen = []
  const spawns = []
  const closes = []
  const closesSync = []
  const updates = []
  const saves = []
  const timers = []
  const removes = []
  const removesSync = []
  let stateData = options.stateData ?? null
  let credential = options.credential ?? ''
  const settings = { providers: { ...(options.providers || {}) } }
  let settingsRevision = 1

  const http = async (url, opts) => {
    // The whole request shape, so a test can assert per-request limits (maxBytes)
    // and the redirect mode, not only which URL was asked for.
    const call = {
      url,
      headers: (opts && opts.headers) || {},
      follow: opts && opts.follow,
      timeoutMs: opts && opts.timeoutMs,
      maxBytes: opts && opts.maxBytes,
    }
    seen.push(call)
    const custom = options.http && options.http(call)
    if (custom !== undefined) return custom
    if (url.endsWith('/model-api/auth-login/check')) {
      if (/\/auth-login\/check\?ticket=/.test(url)) return checkOk('ticket-token')
      return options.mint ? checkOk(options.mint) : { status: 401, ok: false, location: '', text: '' }
    }
    if (url.endsWith('/model-api/auth-login')) return authOk()
    return { status: 500, ok: false, location: '', text: '' }
  }
  const cdp = options.cdp || (async () => ({ ok: false, running: false, reason: 'no-devtools' }))

  // The real dsh-settings contract, verified against the running Host on 2026-10-03:
  // describe() is synchronous and returns one descriptor per active namespace with
  // the projected live value; there has never been a get(ns). update(ns, patch)
  // deep-merges plain objects and replaces arrays wholesale (mergeLayers), so a
  // patch touching one provider has to leave its siblings alone.
  const settingsService = {
    describe() {
      return [{ ns: 'llm-pi-ai', value: structuredClone(settings), revision: settingsRevision }]
    },
  }
  // settingsMode: 'readonly' = describe() only (a Host whose settings plugin is off);
  // 'conflict' = another writer won the race (SettingsConflictError).
  if (options.settingsMode !== 'readonly') {
    settingsService.update = (ns, patch) => {
      if (options.settingsMode === 'conflict') {
        const err = new Error('Config revision conflict: expected 1, actual 2')
        err.code = 'SETTINGS_CONFLICT'
        throw err
      }
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(Object.getPrototypeOf(patch), Object.prototype, 'settings patch must be a plain Host-realm object')
      assert.equal(Object.getPrototypeOf(patch.providers), Object.prototype, 'nested patch must be a plain object')
      updates.push(patch)
      settingsRevision += 1
      for (const [id, value] of Object.entries(patch.providers)) {
        if (!settings.providers[id]) settings.providers[id] = {}
        Object.assign(settings.providers[id], structuredClone(value))
      }
    }
  }

  // The host's timer service, faithfully (2026-10-05 round 18): DSH hands the plugin
  // `ctx.get('timer')`, which offers interval and timeout and **has no sleep at all**. The
  // shipped reader used to call `deps.timer.sleep` while learning the identity of a browser it
  // had just started, so on the real machine the whole no-window run died with
  // "deps.timer.sleep is not a function" before it read a single page. This fixture must not
  // invent the method that hid that; a test that needs the wait to be observable hooks
  // `timerTimeout`.
  const hostTimer = {
    interval(fn, ms) {
      // A host whose timer service is gone is a real failure mode for the capture arm, and the
      // only thing that can throw *after* a browser was started (2026-10-05 round 14 A).
      if (options.timerInterval) return options.timerInterval(fn, ms)
      const entry = { fn, ms, disposed: false }
      timers.push(entry)
      return () => { entry.disposed = true }
    },
    // One-shot wait. The product wraps this in a promise, so firing `fn` immediately stands in
    // for a real 200 ms timer: the code under test cannot tell the difference.
    timeout(fn, ms) {
      if (options.timerTimeout) return options.timerTimeout(fn, ms)
      fn()
      return () => {}
    },
  }

  const core = createCore({
    logger: { error() {}, log() {} },
    http,
    cdp,
    // What the host reads from the bundle's package.json; the panel shows it.
    version: options.version || '',
    env: {
      home: options.home || 'C:\\Users\\test',
      temp: 'C:\\Temp',
      localAppData: options.localAppData || '',
      cwd: 'C:\\work',
    },
    clock: { now: options.clockNow || (() => (options.now !== undefined ? options.now : Date.now())) },
    // options.stateIO lets a test make the disk refuse a write on purpose — the one
    // failure that used to be silent (report §21.3, defect 2). The default keeps the
    // in-memory copy the way the real fs-backed store does.
    stateIO: options.stateIO || {
      async mkdir(p) { return { ok: true } },
      async load() { return { ok: true, data: stateData } },
      async save(p, data) {
        saves.push(data)
        stateData = { ...data }
        return { ok: true }
      },
      // 2026-10-05 round 17: a one-run carrier profile is a directory this plugin made, and the
      // only proof that it was cleaned up is that the seam was called with that path. `list` is
      // what the stale-directory sweep reads; the default here says "this state directory has
      // nothing in it", which is also what keeps the sweep from touching anything in a test.
      async list(p) { return options.listStateDir ? options.listStateDir(p) : { ok: true, entries: [] } },
      async rm(p) { removes.push(p); return { ok: true } },
      rmSync(p) { removesSync.push(p); return { ok: true } },
    },
    settings: settingsService,
    credentials: {
      async resolve() { return credential ? { value: credential, source: 'test' } : undefined },
      async set(_ref, value) { credential = value },
    },
    findExecutable: async (c) => (options.findExe !== undefined ? options.findExe(c) : c),
    spawnBrowser: options.spawnBrowser || (async (exe, argv) => { spawns.push({ exe, argv }); return { pid: 4321 } }),
    // Every call here is a browser this plugin opened being closed. Nothing else in
    // the plugin may close a browser, so counting these is the whole requirement C
    // surface (2026-10-04).
    closeBrowser: options.closeBrowser || (async (arg) => { closes.push(arg); return { closed: true, via: 'cdp' } }),
    // The synchronous twin, which is the one host exit uses: the host calls dispose without
    // awaiting it, so an async close there would be cut off by the process exiting
    // (2026-10-05 round 14 A). Kept apart from `closes` so a test can tell which path ran.
    closeBrowserSync: options.closeBrowserSync || ((arg) => { closesSync.push(arg); return { closed: true, via: 'kill', sync: true } }),
    // How long a close may take before the caller gives up on it — but keeps the lease
    // (2026-10-05 round 14 A). Tests shrink it so a hung closer costs milliseconds.
    closeBudgetMs: options.closeBudgetMs,
    // The factory CDP restore that hands the stored session to a browser this run started
    // (2026-10-05 round 16, requirement 1). Absent unless a test asks for it: a build with no
    // way to inject a session is a state the carrier has to survive rather than assume away.
    ...(options.sessionRestore ? { sessionRestore: options.sessionRestore } : {}),
    // Which profile directories browsers on this machine hold (2026-10-05 round 17). The real one
    // reads the Windows process table; a test injects the answer so the decision is hermetic and
    // the suite does not depend on what happens to be running on the machine.
    listBrowserProfiles: options.listBrowserProfiles || (async () => ({ ok: true, dirs: [] })),
    // The host's native hidden-page carrier (2026-10-04 round 10). Deliberately absent unless
    // a test asks for it: "this host cannot hand one out" is a state the plugin has to handle,
    // and the 122 assertions that predate the carrier all run on such a host.
    ...(options.hiddenTarget ? { hiddenTarget: options.hiddenTarget } : {}),
    timer: hostTimer,
  })
  return {
    core, seen, spawns, closes, closesSync, updates, saves, timers, settings, removes, removesSync,
    timer: hostTimer,
    get credential() { return credential },
    get stateData() { return stateData },
  }
}

const checkOk = (token) => okResponse({ success: true, data: token })

// What the plugin registers when the site's own list cannot be read.
const FALLBACK_MODELS = [
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek-V4.1-Flash (THU)',
    contextWindow: 1000000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  },
  {
    id: 'qwen3.8-27b',
    name: 'qwen3.8-27b (THU)',
    contextWindow: 1000000,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' },
  },
]

// Verbatim shape of the site's own front-end bundle (minified the same way).
const SITE_BUNDLE = 'var x=1;const W0={modelList:[{label:"DeepSeek-V4.1-Flash",value:"DeepSeek-V4.1-Flash",max_tokens:3,supportImage:!1,thinkingParam:"thinking",thinkingField:"reasoning_content",effortOptions:["low","high","max"]},{label:"DeepSeek-V4-Flash-Vision-Exp",value:"DeepSeek-V4-Flash-Vision-Exp",max_tokens:3,supportImage:!0,thinkingParam:"thinking",thinkingField:"reasoning_content",effortOptions:["low","medium","xhigh"]},{label:"qwen3.8-27b",value:"qwen3.8-27b",max_tokens:3,supportImage:!0,thinkingParam:"enable_thinking",thinkingField:"reasoning",effortOptions:["low","medium","xhigh"]},{label:"DeepSeek-R1-W8A8",value:"DeepSeek-R1-W8A8",max_tokens:3,supportImage:!1,thinkingParam:null,thinkingField:"content",effortOptions:["low","medium","high"]}]},after=2;'

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
    models: FALLBACK_MODELS,
  })
  assert.deepEqual(Object.keys(rt.updates.at(-1).providers), ['madmodel'], 'unrelated providers must not be copied into the user layer')
  assert.equal('token' in rt.stateData, false, 'token must never enter the state file')
  assert.equal(rt.stateData.lastGetAt > 0, true)
  assert.ok(rt.saves.every((s) => !('token' in s)))
})

test('an existing MadModel route gets the credential reference and the current model list', async () => {
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
  // The site retires and renames models over time; a stale list on an existing
  // route means every request fails with "模型不存在" until someone edits YAML.
  assert.deepEqual(rt.settings.providers.custom.models, FALLBACK_MODELS)
  assert.deepEqual(Object.keys(rt.updates.at(-1).providers.custom), ['apiKeyEnv', 'models'])
  assert.equal((await rt.core.state()).providerName, 'My Campus Gateway')
})

test('the provider takes the model list the site itself serves, minus the excluded ones', async () => {
  const rt = createRuntime({
    mint: tk(),
    http({ url }) {
      if (url === 'https://madmodel.cs.tsinghua.edu.cn/') {
        return okResponse('<script type="module" crossorigin src="/assets/js/index-abc.js"></script>')
      }
      if (url === 'https://madmodel.cs.tsinghua.edu.cn/assets/js/index-abc.js') return okResponse(SITE_BUNDLE)
      return undefined
    },
  })
  await run(rt)
  assert.deepEqual(rt.settings.providers.madmodel.models, FALLBACK_MODELS)
})

test('a route already carrying the live list is not rewritten on every Get', async () => {
  const rt = createRuntime({
    mint: tk(),
    providers: {
      madmodel: {
        displayName: 'DeepSeek (THU)',
        apiKeyEnv: 'MADMODEL_API_KEY',
        baseURL: 'https://madmodel.cs.tsinghua.edu.cn/v1',
        models: FALLBACK_MODELS,
      },
    },
  })
  await run(rt)
  assert.equal(rt.updates.length, 0, 'an unchanged route must not be written back')
})

test('extractModelList reads the site bundle and toProviderModels keeps only the wanted models', () => {
  const parsed = extractModelList(SITE_BUNDLE)
  assert.deepEqual(parsed.map((m) => m.id), [
    'DeepSeek-V4.1-Flash',
    'DeepSeek-V4-Flash-Vision-Exp',
    'qwen3.8-27b',
    'DeepSeek-R1-W8A8',
  ])
  assert.equal(parsed[0].supportImage, false)
  assert.equal(parsed[1].supportImage, true)
  assert.deepEqual(parsed[0].efforts, ['low', 'high', 'max'])

  const models = toProviderModels(parsed)
  assert.deepEqual(models.map((m) => m.id), ['DeepSeek-V4.1-Flash', 'qwen3.8-27b'])
  // The site marks V4.1-Flash text-only, but a real request read our test image.
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.deepEqual(models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(models[1].reasoningEfforts, { low: 'low', medium: 'medium', xhigh: 'xhigh' })

  assert.equal(extractModelList('nothing here'), null)
  assert.equal(extractModelList(''), null)
  assert.equal(toProviderModels([]), null)
  assert.equal(toProviderModels([{ id: 'DeepSeek-R1-W8A8', efforts: ['low'] }]), null, 'an all-excluded list must not replace the fallback')
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
  const token = tk()
  const rt = createRuntime({ mint: token, providers: { madmodel: original } })
  const result = await run(rt)
  // The token is real and is stored — only the config write is blocked by the id
  // clash — so the honest verdict is "partial" (amber plus the message on screen),
  // not "the credential is broken".
  assert.equal(result.status, 'partial')
  assert.match(result.err, /已被其他配置占用/)
  assert.equal(rt.credential, token)
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

test('a window that never yields a token is not papered over with an anonymous mint', async () => {
  let mintAllowed = false
  let checkHits = 0
  const token = tk()
  const rt = createRuntime({
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) {
        checkHits += 1
        return mintAllowed ? checkOk(token) : { status: 401, ok: false, location: '', text: '' }
      }
      if (url.endsWith('/model-api/auth-login')) return authOk()
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
  // One click is the whole protocol now: the run itself opened the window and started
  // watching it, so a second open-login has to be refused as already-open
  // (2026-10-04, requirement A).
  assert.equal(first.loginOpened, 'launched')
  const opened = await rt.core.openLogin()
  assert.equal(opened.launched, false)
  assert.equal(opened.reason, 'already-open')
  assert.equal(rt.spawns.length, 1)
  assert.ok(rt.spawns[0].argv.join(' ').includes('--remote-debugging-port='))
  const ladderHits = checkHits
  assert.equal(ladderHits, 1, 'the click\'s own ladder asked the signing endpoint once')
  mintAllowed = true
  const capture = rt.timers.find((t) => t.ms === 2500)
  assert.ok(capture, 'capture poll timer must be registered')
  await capture.fn()
  const state = await rt.core.state()
  // 2026-10-05 audit: the capture arm may not ask the signing endpoint (or spend the saved
  // session) on its own, once per poll, next to a login a person is doing — the side effects of
  // that extra probe could not be ruled out. A page with no token in it means exactly that:
  // wait, say so, and do not dress an anonymous issuance up as a finished renewal.
  assert.equal(checkHits, ladderHits, 'the capture arm never asked the signing endpoint again')
  assert.equal(state.status, 'waiting-login', 'no token in the page is said out loud, not papered over')
  assert.equal(rt.credential, '', 'and nothing else\'s token is stored as this login\'s result')
  assert.equal(state.credentialWritten, false)
  assert.equal(rt.closes.length, 0, 'nothing was written, so there is no "done" that may close a window')
  assert.equal(state.loginWait, true, 'the window is still the thing we are waiting on')
  assert.equal(rt.spawns.length, 1, 'and no browser was spent asking a second time')
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
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: 'sso=secret',
      cookieJar: [{ name: 'JSESSIONID', value: 'secret', domain: 'id.tsinghua.edu.cn', path: '/', secure: true, expires: -1 }],
    },
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

test('the Auto cadence is one measured number, and the snapshot publishes it', async () => {
  // 20 minutes is a measurement, not a taste: on 2026-10-04 the IDP session a replay needs
  // was still recognised ~45 min after a real login and already gone at 70 min, while the
  // token itself lives 6h — so an hourly plan spends most of its attempts on a dead session.
  // The panel prints this number, therefore the panel must be told it (report §20).
  assert.equal(AUTO_REFRESH_MS, 20 * 60e3)
  const rt = createRuntime({ stateData: { auto: false, cookies: '', ssoCookies: '' } })
  await rt.core.init()
  assert.equal((await rt.core.state()).autoEveryMs, AUTO_REFRESH_MS)
})

test('an Auto tick runs when the interval is up and not a minute before', async () => {
  const now = 1_800_000_000_000
  const early = createRuntime({
    mint: tk(),
    now,
    clockNow: () => now,
    stateData: { lastGetAt: now - (AUTO_REFRESH_MS - 60e3), auto: true, cookies: '', ssoCookies: '' },
  })
  await early.core.init()
  await early.core.autoTick()
  assert.ok(!early.credential, 'a tick inside the interval must not spend a request')

  const due = createRuntime({
    mint: tk(),
    now,
    clockNow: () => now,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS, auto: true, cookies: '', ssoCookies: '' },
  })
  await due.core.init()
  await due.core.autoTick()
  assert.ok(due.credential, 'the tick that is due has to actually run')
  assert.equal(due.saves.at(-1)?.lastTrace?.bg, 1, 'and it has to record itself as an unattended run')
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
  // The real contract: describe() is synchronous, and there is no get(ns).
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, revision: 1 }],
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

// --- renewal blocked (2026-09-29: the site retired anonymous mint, so a manual
// Get that fell back to reuse looked exactly like a dead button) -------------

test('a click that cannot renew hands over the login window while keeping the token', async () => {
  const token = tk()
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: Date.now() - 60e3, auto: false, cookies: '', ssoCookies: '' },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.loginRequired, true, 'a click that cannot renew must open the one door left')
  assert.equal(res.loginOpened, 'launched', 'and it opens it inside this very run')
  assert.equal(res.via, 'reuse', 'the token in hand is still the reused one')
  // "waiting-login" is the honest word while the window is up: the token was not
  // renewed, a login is being waited for (2026-10-04, A). The token itself is fine,
  // which is why closing the window puts the widget straight back to ok.
  assert.equal(res.status, 'waiting-login')
  assert.equal(res.refreshBlocked, true, 'the broken renewal path is still recorded')
  assert.equal(rt.credential, token, 'the still-valid token must be kept')
  assert.equal(rt.stateData.lastGetAt, res.lastGetAt, 'a reuse must not reset the baseline')
  assert.equal(rt.stateData.refreshBlocked, true, 'the note must be persisted for the next start')
  assert.equal(rt.spawns.length, 1)
})

test('a Get with no usable token is the case that asks for a login', async () => {
  const rt = createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '' },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.loginRequired, true, 'nothing usable left: the login window is the way out')
  assert.equal(res.status, 'waiting-login')
  assert.equal(res.loginOpened, 'launched')
  assert.equal(res.via, 'none')
  assert.equal(rt.spawns.length, 1, 'one click, one window, no second request needed')
})

test('a browser this plugin did not open is never used as a renewal source and never closed', async () => {
  // 2026-10-04 (B): the ladder lost its live-browser rung, so a merely running window
  // cannot be what keeps Auto alive — and since it was not started by this process it
  // must never be closed either (C).
  const token = tk()
  const cdpCalls = []
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: Date.now() - 60e3, auto: false, cookies: '', ssoCookies: '' },
    cdp: async (arg) => {
      cdpCalls.push(arg)
      return arg.probeOnly
        ? { ok: true, running: true }
        : { ok: true, token: token, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [] }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.notEqual(res.via, 'browser', 'the ladder has no live-browser rung any more')
  assert.equal(res.via, 'reuse', 'what is left is the token already in hand')
  assert.equal(rt.credential, token)
  // The leftover window is reused for watching, but it is not ours to close.
  assert.equal(rt.spawns.length, 0)
  assert.equal(rt.closes.length, 0)
})

test('cookie headers follow domain, path, secure and expiry', () => {
  const now = Date.now()
  const jar = [
    { name: 'a', value: '1', domain: 'id.tsinghua.edu.cn', path: '/' },
    { name: 'b', value: '2', domain: 'tsinghua.edu.cn', path: '/do/off' },
    { name: 'c', value: '3', domain: 'other.example', path: '/' },
    { name: 'd', value: '4', domain: 'id.tsinghua.edu.cn', path: '/', secure: true },
    { name: 'e', value: '5', domain: 'id.tsinghua.edu.cn', path: '/', expires: Math.floor((now - 1000) / 1000) },
  ]
  const header = buildCookieHeader(jar, 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/x/0?/authLogin', now)
  assert.ok(header.indexOf('b=2') !== -1, 'a path-scoped cookie applies to its own path')
  assert.ok(header.indexOf('b=2') < header.indexOf('a=1'), 'longer paths come first, as browsers order them')
  assert.equal(header.indexOf('c=3'), -1, 'other domains are excluded')
  assert.equal(header.indexOf('e=5'), -1, 'expired cookies are dropped')
  assert.ok(header.indexOf('d=4') !== -1, 'secure cookies are kept on https')
  assert.equal(buildCookieHeader(jar, 'http://id.tsinghua.edu.cn/').indexOf('d=4'), -1, 'secure cookies are dropped on http')
  assert.equal(buildCookieHeader(jar, 'not a url').indexOf('a=1'), -1, 'an unparsable target yields no header')
})

test('an Auto tick reuses a valid token but records that renewal is broken', async () => {
  const token = tk()
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: Date.now() - 2 * 3600e3, auto: true, cookies: '', ssoCookies: '' },
  })
  await rt.core.init()
  const snap = await rt.core.autoTick()
  assert.equal(snap.via, 'reuse', 'Auto keeps living on the valid token')
  assert.equal(snap.status, 'ok', 'a usable token keeps the widget green')
  assert.equal(snap.refreshBlocked, true, 'the broken renewal path is recorded for the hover note')
  assert.equal(snap.loginRequired, false, 'a background tick never opens a browser')
})

test('a remembered renewal block survives a reload without faking a warning', async () => {
  const rt = createRuntime({
    credential: tk(),
    stateData: {
      lastGetAt: Date.now() - 60e3, auto: false, cookies: '', ssoCookies: '',
      refreshBlocked: true, loginReason: 'renewal-unavailable',
    },
  })
  const snap = await rt.core.init()
  assert.equal(snap.status, 'ok', 'a working token outranks the remembered block')
  assert.equal(snap.refreshBlocked, true, 'the note survives the reload')
  assert.equal(snap.loginReason, 'renewal-unavailable')
})

test('a remembered block still means needs-login when there is no token at all', async () => {
  const rt = createRuntime({
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '',
      refreshBlocked: true, loginReason: 'renewal-unavailable',
    },
  })
  const snap = await rt.core.init()
  assert.equal(snap.status, 'needs-login', 'nothing usable and renewal is broken')
  assert.equal(snap.refreshBlocked, true)
})

test('open-login reports and records why no window appeared', async () => {
  const rt = createRuntime({ credential: tk(), findExe: () => false })
  await rt.core.init()
  const res = await rt.core.openLogin()
  assert.equal(res.launched, false)
  assert.equal(res.reason, 'no-browser')
  assert.equal((await rt.core.state()).loginReason, 'no-browser')
})

test('a second open-login while one is pending says so instead of doing nothing', async () => {
  const rt = createRuntime({ credential: tk() })
  await rt.core.init()
  rt.core.internal.state.browserOpen = true
  const res = await rt.core.openLogin()
  assert.equal(res.launched, false)
  assert.equal(res.reason, 'already-open')
  assert.equal((await rt.core.state()).loginReason, 'already-open')
})

test('saving an unchanged state does not rewrite the file', async () => {
  const rt = createRuntime({
    credential: tk(),
    stateData: { lastGetAt: Date.now() - 60e3, auto: false, cookies: '', ssoCookies: '' },
  })
  await rt.core.init()
  await rt.core.internal.saveState()
  const afterFirst = rt.saves.length
  await rt.core.internal.saveState()
  assert.equal(rt.saves.length, afterFirst, 'an unchanged snapshot must not be written twice')
})

test('the login window opens the Tsinghua SSO form with a debug port', async () => {
  const rt = createRuntime({ credential: tk() })
  await rt.core.init()
  const res = await rt.core.openLogin()
  assert.equal(res.launched, true)
  assert.equal(rt.spawns.length, 1, 'exactly one browser is launched')
  const argv = rt.spawns[0].argv
  assert.match(
    argv[argv.length - 1],
    /^https:\/\/id\.tsinghua\.edu\.cn\/do\/off\/ui\/auth\/login\/form\//,
    'must open the SSO form, not the site home page',
  )
  assert.ok(argv.some((a) => a.startsWith('--remote-debugging-port=')), 'the debug port is what makes the capture possible')
  assert.ok(argv.some((a) => a.startsWith('--user-data-dir=')), 'the dedicated profile keeps the session between attempts')
})

// --- panel honesty: the token's own expiry, and the server's verdict ---------

const jwtWith = (expSeconds, extra) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iat: expSeconds - 21600, exp: expSeconds, ...(extra || {}) })).toString('base64url')
  return header + '.' + payload + '.signature'
}

test('jwtExpiry reads the token itself instead of estimating', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  assert.equal(jwtExpiry(jwtWith(exp)), exp * 1000)
  assert.equal(jwtExpiry('not-a-jwt'), 0)
  assert.equal(jwtExpiry(''), 0)
  assert.equal(jwtExpiry('a.%%%.c'), 0)
  assert.equal(jwtExpiry(null), 0)
})

test('the panel uses the token expiry, not the last fetch time', async () => {
  const exp = Math.floor(Date.now() / 1000) + 600
  const token = jwtWith(exp)
  const rt = createRuntime({
    credential: token,
    // fetched a moment ago, so the old "lastGetAt + 6h" estimate would say 6 hours
    stateData: { lastGetAt: Date.now(), auto: false, cookies: '', ssoCookies: '' },
  })
  const snap = await rt.core.init()
  assert.equal(snap.expiresAt, exp * 1000, 'expiry comes from the token, not from when it was fetched')
  assert.equal(snap.status, 'ok')

  const gone = createRuntime({
    credential: jwtWith(Math.floor(Date.now() / 1000) - 3600),
    stateData: { lastGetAt: Date.now(), auto: false, cookies: '', ssoCookies: '' },
  })
  assert.equal((await gone.core.init()).status, 'expired', 'a token past its own exp is not "ok", whatever lastGetAt says')
})

test('a token the server refuses is reported instead of looking healthy', async () => {
  const token = tk()
  const rt = createRuntime({
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      if (url.endsWith('/model-api/auth-login')) {
        return { status: 200, ok: true, location: '', text: JSON.stringify({ success: false, status: 10003, message: 'nope' }) }
      }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.serverValid, false, 'the server verdict must be recorded')
  assert.equal(res.status, 'error')
  assert.match(String(res.err), /服务端不接受/, 'and must be visible, not swallowed')
})

test('the same token coming back again is not reported as a refresh', async () => {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    credential: token,
    stateData: {
      lastGetAt: Date.now() - 3600e3, auto: false, cookies: '', ssoCookies: '',
      tokenExpAt: exp * 1000, // the record already knows this token's expiry
    },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token) // mint hands back the same string
      if (url.endsWith('/model-api/auth-login')) return authOk() // and it is still valid, of course
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.expiryAdvanced, false, 'the expiry did not move forward')
  assert.notEqual(res.status, 'ok', 'a re-issued identical token must not look like a successful refresh')
  assert.match(String(res.err), /到期时间/, 'the panel has to say what actually happened')
  assert.equal(rt.stateData.tokenExpAt, exp * 1000)
})

test('a genuinely new token advances the expiry and is reported as a refresh', async () => {
  const oldExp = Math.floor(Date.now() / 1000) + 600
  const newExp = oldExp + 6 * 3600
  const rt = createRuntime({
    credential: jwtWith(oldExp),
    stateData: {
      lastGetAt: Date.now() - 3600e3, auto: false, cookies: '', ssoCookies: '',
      tokenExpAt: oldExp * 1000,
    },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(jwtWith(newExp))
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.expiryAdvanced, true)
  assert.equal(res.status, 'ok')
  assert.equal(rt.stateData.tokenExpAt, newExp * 1000, 'the stored expiry follows the new token')
})

// --- when a background tick may open the login window ------------------------

const stalledRuntime = (expSeconds, extra) => {
  const token = jwtWith(expSeconds)
  return (extra || {}).rt || createRuntime({
    credential: token,
    clockNow: (extra && extra.clockNow) || undefined,
    stateData: {
      lastGetAt: ((extra && extra.now) || Date.now()) - 3600e3,
      auto: true, cookies: '', ssoCookies: '', tokenExpAt: expSeconds * 1000,
    },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      // the old token is still accepted, but no path can extend its life
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
}

test('a background tick never asks for a login, however little life is left', async () => {
  const rt = stalledRuntime(Math.floor(Date.now() / 1000) + 1800) // 30 minutes left
  await rt.core.init()
  const snap = await rt.core.autoTick()
  // Nothing tried and failed on this run: it only reused the token it already had.
  // The danger is the closed renewal path plus the life left, not a phantom stall.
  assert.equal(snap.renewalNoProgress, false, 'a reuse is not a failed renewal')
  assert.equal(snap.refreshBlocked, true, 'no renewal source can extend this token')
  // 2026-10-04 (B): the old policy let a background tick pop a window when the token
  // was nearly out. An unattended machine must never stack windows; only an explicit
  // click may open one.
  assert.notEqual(snap.loginRequired, true, 'a background tick must not ask for a login')
  // 以前这里写 'none'：后台什么都没做，却读不出为什么。2026-10-05 起闸门的名字进 opened ——
  // 这一轮的梯子没留下"设备指纹页"的读数，所以连无窗口载体都没试（不是试了失败）。
  assert.equal(snap.loginOpened, 'no-evidence', 'a run that could not even try says which gate stopped it')
  assert.equal(snap.headlessFailReason, 'no-evidence', 'and the gate leaves its own name behind, not only the field it stopped')
  assert.equal(snap.nearlyOut, true)
  assert.equal(rt.spawns.length, 0)
})

test('a background tick stays quiet while hours of life remain', async () => {
  const rt = stalledRuntime(Math.floor(Date.now() / 1000) + 5 * 3600) // 5 hours left
  await rt.core.init()
  const snap = await rt.core.autoTick()
  assert.equal(snap.refreshBlocked, true)
  assert.notEqual(snap.loginRequired, true, 'plenty of life left: do not disturb the user')
})

test('background ticks never open a window, and an explicit click is what does', async () => {
  let now = Date.now()
  const rt = stalledRuntime(Math.floor(now / 1000) + 1800, { now, clockNow: () => now })
  await rt.core.init()
  const first = await rt.core.autoTick()
  assert.equal(first.loginRequired, false, 'an unattended tick stays quiet')
  assert.equal(rt.spawns.length, 0)
  now += 10 * 60e3
  const second = await rt.core.autoTick()
  assert.equal(second.loginRequired, false, 'and it stays quiet on the next one too')
  assert.equal(rt.spawns.length, 0, 'no window may be opened without a click')
  // ...while the click itself is the one thing allowed to open it (requirement A/B).
  const manual = await rt.core.getTok()
  assert.equal(manual.loginOpened, 'launched')
  assert.equal(rt.spawns.length, 1)
})

// --- an outage is not a broken credential -----------------------------------

test('a failed refresh keeps the token it has and blames the network', async () => {
  const exp = Math.floor(Date.now() / 1000) + 4 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: Date.now() - 3600e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: exp * 1000 },
    http: () => ({ error: 'fetch failed: getaddrinfo ENOTFOUND madmodel.cs.tsinghua.edu.cn' }),
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.offline, true, 'nothing reached the site at all')
  assert.equal(res.status, 'ok', 'an outage says nothing about the token in hand')
  assert.notEqual(res.loginRequired, true, 'an unreachable site is not a reason to ask for a login')
  assert.match(res.err, /网络不可达/)
  assert.equal(rt.credential, token, 'the credential is left exactly as it was')
})

test('an outage with no token is reported as an outage, not as a login problem', async () => {
  const rt = createRuntime({ http: () => ({ error: 'fetch failed: ENETUNREACH' }) })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.status, 'error')
  assert.equal(res.loginReason, 'offline')
  assert.equal(res.loginRequired, false, 'a login window cannot fix an unreachable site')
  assert.match(res.err, /网络不可达/)
})

test('a reuse is not a failed renewal', async () => {
  const exp = Math.floor(Date.now() / 1000) + 5 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: Date.now() - 3600e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: exp * 1000 },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.via, 'reuse', 'no renewal source handed over a token')
  assert.equal(res.renewalNoProgress, false, 'a reuse is the absence of a renewal, not a failed one')
  // The click could not renew, so it opened the one door left and the panel says it is
  // waiting for a login instead of pretending something was renewed (2026-10-04, A).
  assert.equal(res.loginOpened, 'launched')
  assert.equal(res.status, 'waiting-login')
  assert.equal(res.nearlyOut, false, 'five hours of life is not "nearly out"')
})

test('a settings write conflict keeps the token and reports a half-done run', async () => {
  const exp = Math.floor(Date.now() / 1000) + 4 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    settingsMode: 'conflict',
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(rt.credential, token, 'the minted token is still stored')
  assert.equal(res.status, 'partial', 'the token works; only the config write lost the race')
  assert.match(res.err, /模型配置写入失败/)
  assert.equal(rt.updates.length, 0, 'nothing was written')
})

test('the model-list reader asks for a cap that fits the site bundle', async () => {
  const rt = createRuntime({
    mint: tk(),
    http({ url }) {
      if (url === 'https://madmodel.cs.tsinghua.edu.cn/') {
        return okResponse('<script type="module" crossorigin src="/assets/js/index-abc.js"></script>')
      }
      if (url === 'https://madmodel.cs.tsinghua.edu.cn/assets/js/index-abc.js') return okResponse(SITE_BUNDLE)
      return undefined
    },
  })
  await run(rt)
  const page = rt.seen.find((c) => c.url === 'https://madmodel.cs.tsinghua.edu.cn/')
  const bundle = rt.seen.find((c) => c.url.endsWith('/assets/js/index-abc.js'))
  assert.ok(bundle, 'the bundle has to be requested at all')
  // The site's own bundle is ~2.2 MB; the generic 1 MiB answer cap silently
  // truncated it, so the live model list never arrived and the panel lied about
  // which models the route served.
  assert.ok(bundle.maxBytes >= 2.5 * 1024 * 1024, 'the bundle does not fit the generic cap')
})

// --- 2026-10-04: one click finishes the job, and only our own window is closed -----

test('the capture arm never spends the saved session itself: the ticket stays unspent', async () => {
  const ssoc = [
    { name: 'SESSION', value: 's-1', domain: 'id.tsinghua.edu.cn', path: '/', secure: true },
    { name: 'MADCOOKIE', value: 'm-1', domain: 'madmodel.cs.tsinghua.edu.cn', path: '/' },
  ]
  let ticks = 0
  const rt = createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '' },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) {
        // First hop: the SSO form. Signing in there ends in a redirect that carries
        // the one-shot ticket — exactly the shape the real site uses.
        if (url.indexOf('ticket=') === -1) {
          return {
            status: 302,
            ok: false,
            location: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/x/0?/authLogin?ticket=ST-1',
            text: '',
          }
        }
        return okResponse('<html>form</html>')
      }
      if (url.indexOf('/model-api/auth-login/check?ticket=') !== -1) return checkOk('sso-token')
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) return { ok: false, running: false }
      ticks += 1
      // The window is up and logged in, but the SPA has not written localStorage yet:
      // the session lives in its cookies.
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoc }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'launched')
  assert.equal(click.status, 'waiting-login')
  const idpBefore = rt.seen.filter((c) => c.url.indexOf('id.tsinghua.edu.cn') !== -1).length
  assert.equal(idpBefore, 0, 'the ladder had no session to replay, so it never spoke to the IDP')
  const capture = rt.timers.find((t) => t.ms === 2500)
  await capture.fn()
  const state = await rt.core.state()
  assert.equal(ticks, 1)
  // 2026-10-05 audit / D2 measurement: the saved IDP session is alive, and trading it for a
  // token means redeeming a one-shot ticket. The capture arm is not allowed to do that on its
  // own schedule (it used to, once per 2.5 s poll, next to a login a person was doing) — the
  // ladder is the only place that spends a session, and it decides when. What the arm must
  // still do is keep the session it just saw: that is the material the next ladder run needs.
  const idpAfter = rt.seen.filter((c) => c.url.indexOf('id.tsinghua.edu.cn') !== -1).length
  assert.equal(idpAfter, idpBefore, 'the capture arm never replayed the session by itself')
  assert.equal(rt.seen.filter((c) => /auth-login\/check\?ticket=/.test(c.url)).length, 0, 'and never redeemed a ticket')
  const saved = rt.saves[rt.saves.length - 1]
  assert.match(String(saved.ssoCookies), /SESSION=s-1/, 'the session the window carried is saved for the ladder')
  assert.equal(state.status, 'waiting-login', 'no token in the page yet: that is what the panel says')
  assert.equal(rt.credential, '', 'and no token appears from nowhere')
  assert.equal(state.credentialWritten, false)
  assert.equal(rt.closes.length, 0, 'nothing was written, so our window is still open and ours')
  assert.ok(rt.saves.length >= 1, 'the session is still persisted for the next start')
  assert.equal(state.loginWait, true)
})

test('a window that closes itself is confirmed gone rather than closed again', async () => {
  const exp = Math.floor(Date.now() / 1000) + 5 * 3600
  const token = jwtWith(exp)
  let now = Date.now()
  const rt = createRuntime({
    credential: token,
    clockNow: () => now,
    stateData: { lastGetAt: now - 3600e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: exp * 1000 },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    // Nothing answers on 9333 beyond the probe: the user shut the window.
    cdp: async () => ({ ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.status, 'waiting-login')
  const capture = rt.timers.find((t) => t.ms === 2500)
  for (let i = 0; i < 4; i++) { now += 2500; await capture.fn() } // 10s: past the close grace
  const state = await rt.core.state()
  assert.equal(state.status, 'ok', 'the token with hours left is untouched by the closed window')
  assert.match(state.err, /登录窗口已关闭/)
  assert.match(state.err, /现有令牌不受影响/)
  assert.equal(state.loginWait, false)
  assert.equal(rt.credential, token)
  // The closer is asked to settle a window that stopped answering — not to close one twice. With
  // the port silent and no process of ours alive its verdict is a probe reading, and it never
  // sends Browser.close to a browser that is not answering (createBrowserCloser's own tests pin
  // that); what matters here is that the run no longer *assumes* the window is gone
  // (2026-10-05 round 14 A).
  assert.equal(rt.closes.length, 1, 'a vanished window is confirmed, not assumed')
  assert.equal(rt.closes[0].reason, 'gone')
  assert.equal(rt.closes[0].port, 9333)
})

test('a login that never happens ends in an honest timeout and still closes our window', async () => {
  let now = Date.now()
  const rt = createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '' },
    clockNow: () => now,
    // Up and answering, but no token, no cookies, nothing to replay or mint.
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [] }),
  })
  await rt.core.init()
  await rt.core.getTok()
  const capture = rt.timers.find((t) => t.ms === 2500)
  now += CAPTURE_TIMEOUT_MS + 2500
  await capture.fn()
  const state = await rt.core.state()
  assert.equal(state.status, 'needs-login', 'nothing was captured: do not claim otherwise')
  assert.match(state.err, /登录等待超时/)
  assert.equal(state.loginWait, false)
  assert.equal(state.browserOpen, false)
  assert.equal(rt.closes.length, 1, 'a timeout must not leave the window behind')
  assert.equal(rt.closes[0].reason, 'timeout')
  // The timed-out click still has to leave its own record: this is the run the user will
  // look at when the panel seems to have done nothing.
  const trace = rt.stateData.lastTrace
  assert.equal(trace.bg, 0, 'the record belongs to the click, not to an Auto tick')
  assert.equal(trace.via, 'none', 'nothing was captured, and the record says so')
  assert.equal(trace.opened, 'launched', 'the window it opened is part of the record')
  assert.ok(trace.ms >= CAPTURE_TIMEOUT_MS, 'the record carries how long the wait really was')
})

test('disabling the plugin closes the window it opened, synchronously', async () => {
  const rt = createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '' },
    cdp: async (arg) => (arg.probeOnly ? { ok: false, running: false } : { ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()
  await rt.core.getTok()
  assert.equal(rt.spawns.length, 1)
  const verdict = rt.core.dispose()
  // No await, no event-loop turn: the host calls this and exits, so everything the close needs
  // has to have happened before dispose returns (2026-10-05 round 14 A).
  assert.equal(verdict.closed, true, 'unloading must not leave a stray window')
  assert.equal(rt.closes.length, 0, 'the async closer is not the one host exit uses')
  assert.equal(rt.closesSync.length, 1)
  assert.equal(rt.closesSync[0].reason, 'dispose')
  assert.equal(rt.closesSync[0].port, 9333, 'the port the browser was started on goes with it')
  // The lease is retired only by a confirmed close, and this one was confirmed: nothing is left
  // on record as a browser this plugin still owns.
  const after = await rt.core.state()
  assert.equal(after.owned, null)
})

test('an unreachable server is not a rejected token', async () => {
  const exp = Math.floor(Date.now() / 1000) + 4 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    mint: token,
    stateData: { lastGetAt: Date.now() - 3600e3, auto: true, cookies: '', ssoCookies: '', serverValid: true },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      // The validation call reaches something that is not the site: a proxy page, a
      // captive portal. Unparseable, so the verdict is "unknown", not "refused".
      if (url.endsWith('/model-api/auth-login')) return okResponse('<html>502 Bad Gateway</html>')
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.status, 'partial', 'written but unverified is not "ok"')
  assert.match(res.err, /未能向服务端校验/)
  assert.notEqual(rt.stateData.serverValid, false, 'an unreadable answer must not be recorded as a rejection')
  assert.equal(rt.credential, token)
})

test('a token the server really refuses is an error, not a shrug', async () => {
  const token = jwtWith(Math.floor(Date.now() / 1000) + 4 * 3600)
  const rt = createRuntime({
    mint: token,
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.status, 'error')
  assert.match(res.err, /服务端不接受/)
  assert.equal(rt.stateData.serverValid, false)
  assert.equal(rt.credential, token, 'the token is still stored: it may be a transient 401')
})

test('a reuse leaves the "no progress" fact alone instead of clearing it', async () => {
  const exp = Math.floor(Date.now() / 1000) + 5 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    credential: token,
    stateData: {
      lastGetAt: Date.now() - 600e3,
      auto: false,
      cookies: '',
      ssoCookies: '',
      tokenExpAt: exp * 1000,
      renewalNoProgress: true,
      refreshBlocked: true,
    },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.via, 'reuse')
  // The old code cleared this on every reuse, so an unchanged token could look like a
  // fresh one for exactly as long as the reuse path kept answering (risk 1 of the
  // 2026-10-04 review). A reuse neither proves nor disproves progress: it is silent.
  assert.equal(rt.stateData.renewalNoProgress, true, 'a reuse must not clear a standing "no progress"')
})

test('with the token nearly out, a retry is not dragged past the expiry by the backoff', async () => {
  let now = Date.now()
  const exp = Math.floor(now / 1000) + 1800 // 30 minutes left
  const token = jwtWith(exp)
  const rt = createRuntime({
    mint: token,
    clockNow: () => now,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: exp * 1000, status: 'error' },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      // Token written, server never vouched for it: "partial", i.e. not healthy.
      if (url.endsWith('/model-api/auth-login')) return okResponse('<html>nope</html>')
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const first = await rt.core.autoTick()
  assert.equal(first.status, 'partial')
  assert.ok(rt.seen.length > 0, 'the tick tried')
  const before = rt.seen.length
  now += AUTO_RETRY_MS + 1000 // past the retry floor, far inside a 30-minute backoff
  await rt.core.autoTick()
  assert.ok(rt.seen.length > before, 'a nearly-expired token retries at the floor, not after the backoff')
})

test('with hours of life left the backoff is respected', async () => {
  let now = Date.now()
  const exp = Math.floor(now / 1000) + 5 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    mint: token,
    clockNow: () => now,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: exp * 1000, status: 'error' },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      if (url.endsWith('/model-api/auth-login')) return okResponse('<html>nope</html>')
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  await rt.core.autoTick()
  const before = rt.seen.length
  now += AUTO_RETRY_MS + 1000
  await rt.core.autoTick()
  assert.equal(rt.seen.length, before, 'plenty of life left: the exponential backoff still applies')
})

// --- 2026-10-04 audit, defect 1+2: which instance is ours, and what counts as closed ---

// The close path reads /json/version through the same readResponseText() every other
// response goes through, so the fake has to be shaped like a real fetch Response.
function bodyOfJson(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  let sent = false
  return {
    getReader: () => ({
      read: async () => {
        if (sent) return { done: true, value: undefined }
        sent = true
        return { done: false, value: new Uint8Array(bytes) }
      },
      cancel: async () => {},
    }),
  }
}

// A stand-in DevTools endpoint: an HTTP surface that hands out one instance id and a
// WebSocket that answers Browser.close. Every option is a way a real close can go
// wrong, so the closer can be asked what it does when it is not simply told "yes".
function fakeCloser(options = {}) {
  let up = options.up !== false
  const id = options.id || 'aaaaaaaa-1111-2222-3333-444444444444'
  const sockets = []
  const sent = []
  class FakeSocket {
    constructor(url) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        if (options.dieOnOpen) { if (this.onclose) this.onclose({}); return }
        if (this.onopen) this.onopen({})
      })
    }
    send(data) {
      sent.push(String(data))
      const msg = JSON.parse(data)
      if (options.dieOnSend) { if (this.onclose) this.onclose({}); return }
      if (options.refuse) {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, error: { message: 'not allowed' } }) })
        return
      }
      // A browser that really closes stops answering on its port.
      if (options.reallyCloses) up = false
      if (options.answers !== false && this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: {} }) })
    }
    close() { this.closed = true }
  }
  const closer = createBrowserCloser({
    fetch: async (url) => {
      if (!up) throw new Error('ECONNREFUSED')
      const port = Number(new URL(url).port)
      return {
        ok: true,
        headers: { get: () => null },
        body: bodyOfJson({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/' + id }),
      }
    },
    WebSocket: FakeSocket,
    sleep: async () => {},
    isProcessAlive: (pid) => (typeof options.alive === 'function' ? options.alive(pid) : false),
    replyTimeoutMs: 30,
    settleTimeoutMs: options.settleTimeoutMs || 60,
    probeTimeoutMs: 10,
  })
  return { closer, sockets, sent, id }
}

test('a port re-bound by another instance is not ours: refuse, and do not even speak to it', async () => {
  const f = fakeCloser({ id: 'bbbbbbbb-1111-2222-3333-444444444444' })
  const r = await f.closer({ port: 9333, pid: 4321, uuid: 'aaaaaaaa-1111-2222-3333-444444444444', reason: 'timeout' })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'not-ours')
  assert.equal(f.sockets.length, 0, 'an instance that is not ours is never sent a close request')
})

test('with no recorded instance id the close path refuses instead of guessing', async () => {
  const f = fakeCloser({})
  const r = await f.closer({ port: 9333, pid: 4321, uuid: '', reason: 'timeout' })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'no-ownership-evidence')
  assert.equal(f.sent.length, 0, 'a pid and a port are not ownership evidence')
})

test('a close is reported only once the instance has really stopped answering', async () => {
  const f = fakeCloser({ reallyCloses: true })
  const r = await f.closer({ port: 9333, pid: 4321, uuid: f.id, reason: 'captured' })
  assert.equal(r.closed, true)
  assert.equal(r.verified, true, 'the verdict comes from the state afterwards, not the reply')
  assert.equal(r.answered, true)
  assert.match(f.sent[0], /Browser\.close/)
})

test('a request that is never answered is not a close', async () => {
  const f = fakeCloser({ answers: false })
  const r = await f.closer({ port: 9333, pid: 0, uuid: f.id, reason: 'captured' })
  assert.equal(r.closed, false, 'a timeout is not evidence that anything was closed')
  assert.equal(r.answered, false)
  assert.equal(r.reason, 'still-running')
})

test('a socket that dies mid-request is not a close either', async () => {
  const f = fakeCloser({ dieOnSend: true })
  const r = await f.closer({ port: 9333, pid: 0, uuid: f.id, reason: 'captured' })
  assert.equal(r.closed, false)
  assert.equal(r.answered, false, 'Browser.close dropping the socket is not the same as the browser exiting')
})

test('an error reply from the browser is not a close', async () => {
  const f = fakeCloser({ refuse: true })
  const r = await f.closer({ port: 9333, pid: 0, uuid: f.id, reason: 'captured' })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'refused-by-browser')
})

test('a silent endpoint with a live pid is not a close', async () => {
  const f = fakeCloser({ up: false, alive: () => true })
  const r = await f.closer({ port: 9333, pid: 4321, uuid: 'irrelevant', reason: 'dispose' })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'endpoint-silent-pid-alive', 'the pid we recorded is still alive: do not claim it is gone')
})

test('silence on the port with no live pid left counts as closed', async () => {
  const f = fakeCloser({ up: false })
  const r = await f.closer({ port: 9333, pid: 0, uuid: 'irrelevant', reason: 'gone' })
  assert.equal(r.closed, true)
  assert.equal(r.via, 'probe')
})

// --- 2026-10-04 audit, item 3: the whole chain, in the shape the site really uses ---

// The SSO cookie jar the capture arm would persist: one session cookie for the login
// host, one for the site. Replaying these is what requirement B rests on.
const ssoJar = [
  { name: 'SESSION', value: 's-1', domain: 'id.tsinghua.edu.cn', path: '/', secure: true },
  { name: 'MADCOOKIE', value: 'm-1', domain: 'madmodel.cs.tsinghua.edu.cn', path: '/' },
]

test('one click, then Auto renews from the stored session with no browser anywhere', async () => {
  let now = Date.now()
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const exp2 = exp1 + 5 * 3600
  const first = jwtWith(exp1)
  const second = jwtWith(exp2)
  let captureTicks = 0
  const rt = createRuntime({
    clockNow: () => now,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '' },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) {
        if (url.indexOf('ticket=') === -1) {
          return { status: 302, ok: false, location: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/x/0?/authLogin?ticket=ST-2', text: '' }
        }
        return okResponse('<html>form</html>')
      }
      if (url.indexOf('/model-api/auth-login/check?ticket=ST-2') !== -1) return checkOk(second)
      // Anonymous issuance is closed, exactly as it is on the live site.
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) return { ok: false, running: false }
      captureTicks += 1
      return { ok: true, running: true, token: first, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-1' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'launched', 'the click opens the temporary window')
  assert.equal(click.status, 'waiting-login', 'and the panel says what it is waiting for')

  // The user logs in; the capture arm finishes the job inside the same run. No second
  // getTok() is called anywhere in this test: one click is the whole interaction.
  const capture = rt.timers.find((t) => t.ms === 2500)
  assert.ok(capture, 'the capture arm watches the window it opened')
  await capture.fn()
  const afterCapture = await rt.core.state()
  assert.equal(afterCapture.status, 'ok')
  assert.equal(rt.credential, first)
  assert.equal(rt.closes.length, 1)
  assert.equal(rt.closes[0].uuid, 'uuid-1', 'the close carries the id the window identified itself with')

  // The window is closed and the port is dead. An hour later Auto has to renew from the
  // persisted session material alone: no browser may be read, opened or closed.
  const ticksBefore = captureTicks
  now += AUTO_REFRESH_MS + 60e3
  const tick = await rt.core.autoTick()
  assert.equal(tick.via, 'sso', 'the stored SSO session is the renewal path')
  assert.equal(tick.expiryAdvanced, true)
  assert.equal(jwtExpiry(rt.credential), exp2 * 1000, 'the JWT expiry strictly advanced')
  assert.equal(rt.credential, second)
  assert.equal(rt.spawns.length, 1, 'Auto opened no window')
  assert.equal(rt.closes.length, 1, 'and closed none')
  assert.equal(captureTicks, ticksBefore, 'Auto read no live browser')
  assert.equal((await rt.core.state()).status, 'ok')
  assert.equal(rt.stateData.serverValid, true, 'and the server had really accepted the token')
})

// --- 2026-10-04 real-machine audit, P1: a click's own record --------------------------

test('the click that logged in leaves its own record, and an Auto tick cannot overwrite it', async () => {
  let now = Date.now()
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const first = jwtWith(exp1)
  const rt = createRuntime({
    clockNow: () => now,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '' },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) {
        if (url.indexOf('ticket=') === -1) {
          return { status: 302, ok: false, location: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/x/0?/authLogin?ticket=ST-9', text: '' }
        }
        return okResponse('<html>form</html>')
      }
      if (url.indexOf('/model-api/auth-login/check?ticket=ST-9') !== -1) return checkOk(first)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: first, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-9' }),
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'launched')
  // The click's record has to exist from the moment the window opens: a click that leaves
  // no trace at all cannot be told apart from a click that never happened.
  assert.equal(rt.stateData.lastManualTrace.bg, 0)
  assert.equal(rt.stateData.lastManualTrace.opened, 'launched')
  const savesBefore = rt.saves.length
  const capture = rt.timers.find((t) => t.ms === 2500)
  await capture.fn()
  // The capture arm finishes long after getTok() returned, so it writes its own record.
  const trace = rt.stateData.lastTrace
  assert.equal(trace.bg, 0, 'the record belongs to the click, not to an Auto tick')
  assert.equal(trace.via, 'login', 'the token the window held is the one that was captured')
  assert.equal(trace.mint, 'skip', 'the mint rung was not the one that answered')
  assert.equal(trace.sso, 'skip', 'nothing was spent to ask: a token straight from the window says nothing about the session')
  assert.equal(trace.verdict, 'yes')
  assert.equal(trace.expBefore, 0, 'nothing was in hand before the login')
  assert.equal(trace.expAfter, exp1 * 1000)
  assert.equal(trace.opened, 'launched')
  assert.ok(trace.ms >= 0)
  assert.ok(rt.saves.length > savesBefore, 'the outcome is persisted, not only in memory')
  assert.equal(rt.stateData.lastManualTrace.at, trace.at, 'both slots hold this click')
  // Hours later the hourly tick writes its own record; the click's must stay readable.
  const clickAt = trace.at
  now += AUTO_REFRESH_MS + 60e3
  await rt.core.autoTick()
  assert.equal(rt.stateData.lastTrace.bg, 1, 'the tick took over the general slot')
  assert.equal(rt.stateData.lastManualTrace.at, clickAt, 'and left the click alone')
  assert.equal(rt.stateData.lastManualTrace.via, 'login')
})

test('a login that brought its own token does not spend the saved session to ask about the future', async () => {
  let now = Date.now()
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const first = jwtWith(exp1)
  const rt = createRuntime({
    clockNow: () => now,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '' },
    http({ url }) {
      // The SSO endpoint answers the login page instead of a ticket — exactly what the live
      // site did on 2026-10-04 once the saved session had gone stale. This run must not walk
      // into it at all: the window already handed over a token of its own.
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse('<html>login form</html>')
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: first, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-10' }),
  })
  await rt.core.init()
  await rt.core.getTok()
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(state.status, 'ok', 'the token the window held is valid and written')
  assert.equal(rt.credential, first, 'the token the window held was still written')
  assert.equal(state.err, '', 'no caveat is invented out of a round trip this run never needed')
  assert.equal(rt.stateData.lastTrace.sso, 'skip', 'the session was not spent just to ask')
  assert.equal(rt.stateData.lastTrace.via, 'login')
  assert.equal(rt.stateData.lastTrace.expAfter, exp1 * 1000)
  // An exchange nothing asked for is a side effect the plugin cannot vouch for: spending the
  // session mints a token nobody stores (2026-10-04 audit, requirement: remove that probe).
  assert.equal(rt.seen.filter((c) => c.url.indexOf('id.tsinghua.edu.cn') !== -1).length, 0)
})

// What the live IDP answered on 2026-10-04 while it still accepted the session: HTTP 200,
// no Location, and a self-submitting form whose hidden fields are a browser-computed device
// fingerprint (fingerprintjs2) plus material the site keeps in localStorage. The old code
// reported this as "the SSO session expired".
const IDP_FINGERPRINT_FORM = '<html><body><form action="/do/off/ui/auth/login/checkSingle" method="POST">'
  + '<input type="hidden" name="fingerPrint" id="fingerPrint">'
  + '<input type="hidden" name="fingerGenPrint" id="fingerGenPrint"></form></body></html>'
// A session that really is gone: the IDP answers a form a person has to fill in.
const IDP_LOGIN_FORM = '<html><body><form action="/do/off/ui/auth/login/check" method="POST">'
  + '<input type="text" name="userName"><input type="password" name="password"></form></body></html>'

test('the double-auth fingerprint form sends the background run to a headless browser of its own', async () => {
  const now = Date.now()
  const rt = createRuntime({
    clockNow: () => now,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()
  const state = await rt.core.state()
  // A background tick may not put a window on screen — and it does not need one: the device
  // page is exactly what a browser can do by itself, so the plugin opens a headless one of
  // its own and says so. What it must never do is fill that form in from Node: the
  // fingerprint is computed by a browser engine, and posting it here would invent one.
  assert.equal(state.headless, true, 'the panel can say this browser is ours and has nothing on screen')
  assert.equal(state.browserOpen, true)
  assert.equal(state.loginWait, true)
  assert.equal(state.status, 'processing')
  assert.ok(String(state.err).indexOf('后台浏览器') !== -1, 'the hint names a background browser, not a person')
  assert.equal(tick.loginOpened, 'headless')
  assert.equal(rt.spawns.length, 1, 'exactly one browser, and the plugin opened it')
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1, 'no window may appear for an unattended tick')
  assert.ok(
    rt.spawns[0].argv.some((a) => a.indexOf('--user-data-dir=') === 0 && a.endsWith(path.join('.dsh', 'madmodel', 'profile'))),
    'it uses the profile that holds the device material, not a fresh one',
  )
  assert.equal(rt.seen.filter((c) => c.url.indexOf('checkSingle') !== -1).length, 0)
  assert.ok(rt.timers.find((t) => t.ms === 2500), 'and the headless window is watched like any other')
})

test('the headless browser renews on its own, closes itself, and says the expiry moved', async () => {
  const now = Date.now()
  const exp1 = Math.floor(now / 1000) + 300
  const old = jwtWith(exp1)
  const exp2 = exp1 + 6 * 3600
  const renewed = jwtWith(exp2)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: renewed, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-h1' }),
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()
  assert.equal(tick.status, 'processing', 'the tick reports work in progress, not a login window')
  assert.equal(rt.spawns.length, 1)
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(rt.credential, renewed, 'the renewed token is what the store holds')
  assert.equal(jwtExpiry(rt.credential), exp2 * 1000, 'and its expiry strictly advanced')
  assert.equal(state.status, 'ok')
  assert.equal(state.headless, false, 'the browser is gone, so nothing claims it is still there')
  assert.equal(state.browserOpen, false)
  assert.equal(state.loginWait, false)
  assert.equal(rt.closes.length, 1, 'the browser this plugin opened is the one it closed')
  assert.equal(rt.closes[0].uuid, 'uuid-h1', 'and the close carries the id the window identified itself with')
  assert.equal(rt.stateData.lastTrace.opened, 'headless', 'the record says which kind of window did it')
  assert.equal(rt.stateData.lastTrace.via, 'login')
  assert.equal(rt.stateData.lastTrace.expAfter, exp2 * 1000)
})

test('a headless renewal that cannot move the expiry says so instead of calling it a refresh', async () => {
  const now = Date.now()
  const exp1 = Math.floor(now / 1000) + 300
  const old = jwtWith(exp1)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: old, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-h2' }),
  })
  await rt.core.init()
  await rt.core.autoTick()
  const credentialBefore = rt.credential
  const capture = rt.timers.find((t) => t.ms === 2500)
  await capture.fn()
  // The first sighting is not proof of anything: the page may still be loading. The second
  // one, after the device page has had its turn, is: this route cannot move the expiry.
  await capture.fn()
  const state = await rt.core.state()
  assert.equal(state.status, 'no-progress')
  assert.ok(String(state.err).indexOf('到期时间未前进') !== -1, 'the panel says the expiry did not move')
  assert.equal(state.renewalNoProgress, true)
  assert.equal(rt.credential, credentialBefore, 'a token that is not new is not written as one')
  assert.equal(rt.closes.length, 1, 'and the browser is closed either way')
  assert.equal(state.headless, false)
})

test('a headless attempt that never finishes asks for a person and buys half an hour of quiet', async () => {
  let now = Date.now()
  const exp1 = Math.floor(now / 1000) + 300
  const old = jwtWith(exp1)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly ? { ok: false, running: false } : { ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()
  await rt.core.autoTick()
  assert.equal(rt.spawns.length, 1)
  const capture = rt.timers.find((t) => t.ms === 2500)
  now += HEADLESS_TIMEOUT_MS + 1000
  await capture.fn()
  const state = await rt.core.state()
  assert.equal(state.loginReason, 'needs-manual-login')
  assert.ok(String(state.err).indexOf('后台免密续期') !== -1, 'the panel says the background attempt is what fell short')
  assert.ok(String(state.err).indexOf('现有令牌不受影响') !== -1)
  assert.equal(state.browserOpen, false)
  assert.equal(rt.closes.length, 1, 'even a failed attempt closes the browser it opened')
  // Half an hour of quiet, so a device page that will not pass does not cost a browser a tick.
  now += 10 * 60e3
  await rt.core.autoTick()
  assert.equal(rt.spawns.length, 1, 'a failure buys half an hour, not another browser every few minutes')
})

test('a background run that meets a real login form asks for a person instead of guessing', async () => {
  const now = Date.now()
  const rt = createRuntime({
    clockNow: () => now,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_LOGIN_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()
  assert.equal(rt.spawns.length, 0, 'a headless browser cannot type a password, so none is opened')
  assert.equal(tick.loginOpened, 'none')
  assert.equal(tick.loginRequired, true, 'a person is what this run needs, and the panel says so')
  // What the panel reads is the status the plugin keeps, not only the reply to this run.
  const state = await rt.core.state()
  assert.equal(state.loginReason, 'needs-manual-login')
  assert.match(String(state.err), /登录窗口/)
})

test('an Auto run that has come due uses one bounded headless browser, even with hours left on the token', async () => {
  // 0.3.12 gated this on "the token is nearly out" and returned not-due otherwise, which
  // made Auto's own schedule a no-op until the final hour — by which time the measured IDP
  // session is already gone (recognised at T+45 min, dead at T+70 min after a real login,
  // 2026-10-04 round 6). A due run and a click now take the same road.
  const now = Date.now()
  const exp1 = Math.floor(now / 1000) + 5 * 3600
  const old = jwtWith(exp1)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()
  assert.equal(rt.spawns.length, 1, 'the due run gets the one browser the device page needs')
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1, 'and it has no visible window')
  assert.equal(tick.loginOpened, 'headless')
  assert.equal(tick.loginRequired, false, 'a headless attempt needs nobody yet')
  const state = await rt.core.state()
  assert.equal(state.headless, true)
  assert.match(String(state.err), /后台浏览器/)
})

test('a click renews through the headless window when the device page is all that stands in the way', async () => {
  let now = Date.now()
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const exp2 = exp1 + 5 * 3600
  const old = jwtWith(exp1)
  const renewed = jwtWith(exp2)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) return { ok: false, running: false }
      return { ok: true, running: true, token: renewed, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-m1' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless', 'a click asks for the background browser before the visible window')
  assert.equal(click.loginRequired, false, 'nothing needs a person yet')
  assert.equal(rt.spawns.length, 1, 'one click, one browser — and it has no window')
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1)
  assert.equal((await rt.core.state()).browserOpen, true, 'the capture arm is now watching that browser')

  // The same capture arm finishes the renewal and closes the browser this run opened.
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(state.status, 'ok')
  assert.equal(rt.credential, renewed)
  assert.equal(jwtExpiry(rt.credential), exp2 * 1000, 'the expiry strictly advanced')
  assert.equal(rt.closes.length, 1)
  assert.equal(rt.closes[0].uuid, 'uuid-m1')
  assert.equal(state.headless, false, 'the headless flag goes with the window')
  assert.equal(state.expiresAt, exp2 * 1000)
})

test('a click still gets the visible window when the headless attempt cannot start', async () => {
  const now = Date.now()
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const attempts = []
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    spawnBrowser: async (exe, argv) => {
      attempts.push(argv)
      if (attempts.length === 1) throw new Error('boom')
      return { pid: 4321 }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(attempts.length, 2, 'the background try is made first, and the click still gets its door')
  assert.ok(attempts[0].indexOf('--headless=new') !== -1, 'the first try is the windowless one')
  assert.equal(attempts[1].indexOf('--headless=new'), -1, 'the fallback is the visible window')
  assert.equal(click.loginOpened, 'launched')
  assert.equal(click.status, 'waiting-login', 'and the panel waits for the person, as it always did')
})

test('an expired session asks for a manual login and opens nothing by itself', async () => {
  let now = Date.now()
  const dead = jwtWith(Math.floor(now / 1000) - 60)
  const rt = createRuntime({
    clockNow: () => now,
    credential: dead,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: jwtExpiry(dead) },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  assert.equal((await rt.core.state()).status, 'expired')
  const tick = await rt.core.autoTick()
  assert.equal(tick.loginRequired, false, 'a background tick never asks for a window')
  assert.equal(tick.loginOpened, 'no-evidence', 'no carrier was attempted, and the tick says why: no fingerprint-page reading')
  assert.equal(rt.spawns.length, 0, 'nothing was opened')
  assert.equal(tick.status, 'needs-login')
  assert.match(String(tick.err), /重新登录/, 'the panel says a login is what is needed')
})

// --- 2026-10-04 audit, item 4: what a token nobody vouched for may replace -----------

test('a candidate the server never answered about does not replace a credential that works', async () => {
  let now = Date.now()
  const expOld = Math.floor(now / 1000) + 5 * 3600
  const old = jwtWith(expOld)
  const candidate = jwtWith(Math.floor(now / 1000) + 6 * 3600)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - 2 * 3600e3, auto: false, cookies: '', ssoCookies: '', tokenExpAt: expOld * 1000 },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(candidate)
      // An answer the plugin cannot read: "unknown", not a yes.
      if (url.endsWith('/model-api/auth-login')) return okResponse('<html>portal</html>')
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.status, 'partial')
  assert.match(String(res.err), /未能向服务端校验/)
  assert.match(String(res.err), /已保留原凭据/)
  assert.equal(res.storedUnchanged, true)
  assert.equal(res.detail, 'kept-stored')
  assert.equal(res.fresh, false)
  assert.equal(res.expiryAdvanced, false)
  assert.equal(res.loginOpened, 'none')
  assert.equal(rt.credential, old, 'the credential that works is what stays in the store')
  assert.equal(res.serverValid, null, 'and the panel does not call anything verified')
  assert.equal(rt.stateData.lastGetAt, now - 2 * 3600e3, 'to the credential store this run did not happen')
  assert.equal(rt.updates.length, 0, 'no provider was touched')
  assert.equal(rt.spawns.length, 0)
})

test('a candidate the server refused does not replace a credential that works either', async () => {
  let now = Date.now()
  const expOld = Math.floor(now / 1000) + 5 * 3600
  const old = jwtWith(expOld)
  const candidate = jwtWith(Math.floor(now / 1000) + 6 * 3600)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - 2 * 3600e3, auto: false, cookies: '', ssoCookies: '', tokenExpAt: expOld * 1000 },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(candidate)
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.status, 'error', 'a refusal is reported as such')
  assert.match(String(res.err), /服务端不接受/)
  assert.match(String(res.err), /已保留原凭据/)
  assert.equal(res.storedUnchanged, true)
  assert.equal(rt.credential, old, 'a working credential outlives a refused candidate')
  assert.equal(rt.updates.length, 0)
  assert.equal(rt.stateData.refreshBlocked, true, 'and the block is recorded, not shown as a window')
  assert.equal(rt.spawns.length, 0, 'the user is not sent to log in over a credential that still works')
})

test('a token written while the server gave no answer does not look ok after a restart', async () => {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return checkOk(token)
      if (url.endsWith('/model-api/auth-login')) return okResponse('<html>portal</html>')
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const res = await rt.core.getTok()
  assert.equal(res.status, 'partial', 'written but unverified is not ok')
  assert.equal(res.unverified, true)
  assert.equal(rt.credential, token, 'with nothing better in hand the candidate is stored')
  assert.equal(rt.stateData.unverified, true, 'and the doubt is persisted, not only held in memory')

  // Restart: same state file, same credential, nothing re-asked. "Unknown" must not be
  // rounded up to ok just because the process is new.
  const again = createRuntime({
    credential: token,
    stateData: rt.stateData,
    http: () => ({ status: 500, ok: false, location: '', text: '' }),
  })
  const snap = await again.core.init()
  assert.equal(snap.status, 'partial')
  assert.equal(snap.unverified, true)
  assert.match(String(snap.err), /未能向服务端校验/)
  assert.equal(snap.serverValid, null)
})

test('a verdict is bound to the token it was about, and a refusal still counts', async () => {
  const exp = Math.floor(Date.now() / 1000) + 5 * 3600
  const y = jwtWith(exp)

  // The store holds y while the persisted verdict is a bare "true" with no token to
  // attach it to: after a restart that is unknown, not valid.
  const optimistic = createRuntime({
    credential: y,
    stateData: { lastGetAt: Date.now() - 600e3, auto: false, cookies: '', ssoCookies: '', serverValid: true, lastValidatedAt: Date.now(), tokenExpAt: jwtExpiry(y) },
  })
  const snap = await optimistic.core.init()
  assert.equal(snap.serverValid, null, 'a verdict about an unknown token is not inherited')
  assert.equal(snap.status, 'ok')

  // A persisted refusal is the conservative fact: the store still holds the very token
  // that was refused, so it keeps meaning something.
  const refused = createRuntime({
    credential: y,
    stateData: { lastGetAt: Date.now() - 600e3, auto: false, cookies: '', ssoCookies: '', serverValid: false, lastValidatedAt: Date.now(), tokenExpAt: jwtExpiry(y) },
  })
  const snap2 = await refused.core.init()
  assert.equal(snap2.serverValid, false)
  assert.equal(snap2.status, 'expired')
})

test('a standing "no progress" is still reported after a restart', async () => {
  const exp = Math.floor(Date.now() / 1000) + 5 * 3600
  const token = jwtWith(exp)
  const rt = createRuntime({
    credential: token,
    stateData: { lastGetAt: Date.now() - 600e3, auto: true, cookies: '', ssoCookies: '', tokenExpAt: exp * 1000, renewalNoProgress: true },
  })
  const snap = await rt.core.init()
  assert.equal(snap.status, 'no-progress', 'a restart must not wash this into ok')
  assert.equal(snap.renewalNoProgress, true)
})

// --- 2026-10-04 audit, item 5: never close a window the user is still logging into --

test('the login window is not closed while it still holds the same token', async () => {
  let now = Date.now()
  const expOld = Math.floor(now / 1000) + 5 * 3600
  const old = jwtWith(expOld)
  const fresh = jwtWith(expOld + 3600)
  let ticks = 0
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - 2 * 3600e3, auto: false, cookies: '', ssoCookies: '', tokenExpAt: expOld * 1000 },
    http({ url }) {
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) return { ok: false, running: false }
      ticks += 1
      return { ok: true, running: true, token: ticks === 1 ? old : fresh, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-9' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.status, 'waiting-login')

  const capture = rt.timers.find((t) => t.ms === 2500)
  now += 2500
  await capture.fn()
  const mid = await rt.core.state()
  assert.equal(mid.status, 'waiting-login', 'the page still holds the old token: the user is mid-login')
  assert.equal(mid.loginWait, true)
  assert.equal(rt.closes.length, 0, 'a window holding the same token is not closed')
  assert.equal(rt.credential, old)

  now += 2500
  await capture.fn()
  const done = await rt.core.state()
  assert.equal(done.status, 'ok')
  assert.equal(rt.credential, fresh, 'the new token the login produced is what gets written')
  assert.equal(rt.closes.length, 1)
  assert.equal(rt.closes[0].uuid, 'uuid-9', 'the close uses the id learned from this window')
  assert.equal(done.loginWait, false)
})

// --- the real 2026-10-04 run: a click swallowed by an in-flight tick, and what ----
// --- the panel could not say (no version, no trace, no way to start a login) ------

// The reported symptom: Get was clicked, aria-busy stayed false, the status text did
// not change, no window opened. The hourly Auto tick was in flight at that moment, and
// the busy guard answered the click with a bare, unchanged snapshot: no notice, no
// window, and (before this round) no record that the click had even arrived.
test('a click that lands on a run already in flight waits for it, then runs its own ladder', async () => {
  let release = null
  let released = false
  let mintCalls = 0
  let now = Date.now()
  const gate = new Promise((resolve) => { release = resolve })
  const rt = createRuntime({
    version: '9.9.9-test',
    clockNow: () => now,
    // The wait is measured on the injected clock, so the test drives it instead of sleeping
    // for real: each turn of the host timer advances the clock one poll and lets the other run
    // finish. The host timer has no sleep to hook — hooking one is what hid the real
    // "deps.timer.sleep is not a function" (2026-10-05 round 18).
    timerTimeout: async (fn, ms) => { now += ms; released = true; release(); await new Promise((r) => setTimeout(r, 0)); fn() },
    http: async (call) => {
      if (call.url.endsWith('/model-api/auth-login/check')) {
        mintCalls += 1
        if (mintCalls === 1 && !released) await gate
        return checkOk(mintCalls === 1 ? 'tok-first' : 'tok-second')
      }
      return undefined
    },
  })
  await rt.core.init()
  const inFlight = rt.core.getTok()          // the Auto tick, holding the run
  await new Promise((r) => setTimeout(r, 0)) // let it take the busy flag
  const click = await rt.core.getTok()       // the user's click, landing on top of it
  await inFlight

  assert.notEqual(click.detail, 'busy', 'the click waited instead of being refused')
  assert.equal(click.via, 'mint', 'the click ran its own ladder after the other run finished')
  assert.equal(click.trace.bg, 0, 'the trace records that this was a manual run')
  assert.equal(click.trace.mint, 'ok')
  assert.equal(click.trace.via, 'mint')
  assert.ok(click.trace.waitMs > 0, 'and how long it had to wait')
})

test('a click that finds the run still busy says so and leaves a trace', async () => {
  let release = null
  let mintCalls = 0
  let now = Date.now()
  const gate = new Promise((resolve) => { release = resolve })
  const rt = createRuntime({
    clockNow: () => now,
    // The wait is bounded by the clock: this host timer only advances it, so the run never
    // clears and the click has to give up and say so.
    timerTimeout: (fn, ms) => { now += ms; fn(); return () => {} },
    http: async (call) => {
      if (call.url.endsWith('/model-api/auth-login/check')) {
        mintCalls += 1
        if (mintCalls === 1) await gate
        return checkOk('tok')
      }
      return undefined
    },
  })
  await rt.core.init()
  const inFlight = rt.core.getTok()
  await new Promise((r) => setTimeout(r, 0))
  const click = await rt.core.getTok()

  assert.equal(click.detail, 'busy')
  assert.match(click.err, /还没结束|再点一次 Get/)
  assert.ok(click.trace.waitMs >= MANUAL_WAIT_MS, 'the wait ended at its stated bound, not by luck')
  assert.equal(rt.stateData.lastTrace.via, 'busy', 'the swallowed click is at least on record')
  release()
  await inFlight
})

// 宿主交给插件的 timer 只有 interval 与 timeout，**没有 sleep**。而读身份那一步从前的写法是
// `await deps.timer.sleep(gap)`：真机上它抛出 openLogin 的外层 catch，整轮无窗口续期就变成面板上
// 那句 `deps.timer.sleep is not a function；已关闭本次启动的浏览器（cdp）`，一个页面都没读到
// （2026-10-05 第十八轮，生产 11:51~12:02 的自然 Auto）。这条用例用宿主契约形状的 timer 跑完整条
// 启动路径；夹具里一旦被塞进 sleep，掩盖的就是真机上这一处崩溃。
test('a browser that answers late is still identified, with the timer the host really has', async () => {
  const now = Date.now()
  let probes = 0
  const rt = createRuntime({
    clockNow: () => now,
    mintState: 'dead',
    cdp: async (arg) => {
      if (arg.probeOnly) {
        probes += 1
        // 第 1 次：端口扫描，那一刻端口还是空的。第 2、3 次：刚起的那台还没开始应答。
        // 第 4 次：它报出自己的身份 —— 重试因此有意义，而等待只能用宿主真有的那个方法。
        if (probes === 1) return { ok: false, running: false, reason: 'no-devtools' }
        if (probes <= 3) return { ok: false, running: true, reason: 'no-instance-id' }
        return { ok: true, running: true, browserId: 'uuid-late' }
      }
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [], browserId: 'uuid-late' }
    },
  })
  assert.equal(typeof rt.timer.sleep, 'undefined', '宿主没有 sleep，这个夹具也不许有')
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(click.loginOpened, 'launched', '这一轮走到了「已经起了浏览器」')
  assert.equal(click.status, 'waiting-login')
  assert.equal(rt.spawns.length, 1)
  assert.equal(rt.stateData.browserUuid, 'uuid-late', '身份是重试之后学到的，不是跳过或猜的')
  assert.ok(probes >= 4, 'probes=' + probes)
})

// The other half of the same run: a second click while our own window is already open
// used to return an unchanged snapshot as well. It now names the state it is in.
test('a click while our login window is already open reports the wait instead of nothing', async () => {
  const rt = createRuntime({ mintState: 'dead' })
  const first = await run(rt)
  assert.equal(first.status, 'waiting-login')
  assert.equal(first.loginOpened, 'launched')

  const second = await rt.core.getTok()
  assert.equal(second.loginOpened, 'already-open')
  assert.equal(second.detail, 'waiting-login')
  assert.match(second.err, /登录窗口已打开/)
  assert.equal(second.loginRequired, true)
  assert.equal(rt.spawns.length, 1, 'no second browser is started for the same wait')
  assert.equal(rt.stateData.lastTrace.via, 'waiting-login')
  assert.equal(rt.stateData.lastTrace.opened, 'already-open')
})

// "请重新登录" is only half an instruction. When the window itself cannot start, the
// panel has to say that, because retrying is the only action left.
test('a login window that cannot start is reported, not swallowed', async () => {
  const rt = createRuntime({ findExe: () => false })
  const res = await run(rt)
  assert.equal(res.loginOpened, 'no-browser')
  // openLogin() itself already marks the run as failed ("未找到 Edge/Chrome"); what this
  // round adds is that the message says the window did not open and that a click is the
  // way to retry, instead of leaving the panel on a bare "请重新登录".
  assert.equal(res.status, 'error')
  assert.match(res.err, /登录窗口未能打开/)
  assert.match(res.err, /Edge|Chrome/)
  assert.equal(rt.spawns.length, 0)
  assert.equal(rt.stateData.lastTrace.opened, 'no-browser', 'the failure is in the run record too')
})

// What the panel must be able to answer on a real machine: which build answered, which
// rung produced the token, whether the server was asked, and did exp move.
test('the snapshot carries the loaded version and the last run as checkable facts', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = jwtWith(exp)
  const rt = createRuntime({ version: '9.9.9-test', mint: token })
  const snap = await run(rt)

  assert.equal(snap.version, '9.9.9-test')
  assert.equal(snap.trace.mint, 'ok')
  assert.equal(snap.trace.sso, 'skip', 'a minted token never needed the SSO replay')
  assert.equal(snap.trace.verdict, 'yes')
  assert.equal(snap.trace.via, 'mint')
  assert.equal(snap.trace.expAfter, exp * 1000)
  assert.equal(rt.stateData.lastTrace.via, 'mint', 'the trace survives the session')
  const asText = JSON.stringify(snap.trace)
  assert.ok(!asText.includes(token), 'the run record never carries the token itself')
  assert.ok(!asText.includes('token='), 'nor a ticket in a URL')
})

// The dead end the user actually hit: the token still works, every automatic rung is
// out, and the panel says "请重新登录" — so a click has to be able to start that login.
test('with the renewal channel blocked, a click opens the login window instead of dead-ending', async () => {
  const token = jwtWith(Math.floor(Date.now() / 1000) + 4 * 3600)
  const rt = createRuntime({
    credential: token,
    http: async (call) => {
      // The site closed anonymous issuance and the saved SSO session is gone, so the
      // ladder can only hand back the same token.
      if (call.url.includes('/model-api/auth-login/check')) return okResponse({ status: 10001, message: 'expired' })
      if (call.url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 200, ok: true, location: '', text: '<html>login form</html>' }
    },
    stateData: {
      lastGetAt: Date.now() - 3600e3, auto: true, cookies: '', ssoCookies: 'JSESSIONID=dead',
      refreshBlocked: true, loginReason: 'renewal-unavailable', renewalNoProgress: true,
    },
  })
  const res = await run(rt)

  assert.equal(res.offline, false)
  assert.equal(res.loginRequired, true, 'a manual click is allowed to ask for the login')
  assert.equal(res.loginOpened, 'launched', 'and the window really opens this time')
  assert.equal(res.status, 'waiting-login')
  assert.equal(rt.spawns.length, 1)
  assert.equal(rt.stateData.lastTrace.via, 'reuse', 'the record shows which rung answered')
  assert.equal(rt.stateData.lastTrace.opened, 'launched')
  assert.equal(rt.credential, token, 'the working credential is kept while the login waits')
})

// Counter-example: a background tick in exactly the same state must never open anything.
test('the same blocked ladder on a background tick opens no window', async () => {
  const token = jwtWith(Math.floor(Date.now() / 1000) + 4 * 3600)
  const rt = createRuntime({
    credential: token,
    http: async (call) => {
      if (call.url.includes('/model-api/auth-login/check')) return okResponse({ status: 10001 })
      if (call.url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 200, ok: true, location: '', text: '<html>login form</html>' }
    },
    stateData: { lastGetAt: Date.now() - 7200e3, auto: true, cookies: '', ssoCookies: 'JSESSIONID=dead' },
  })
  await rt.core.init()
  const res = await rt.core.autoTick()

  assert.equal(res.loginOpened, 'no-evidence', 'nothing was opened, and the record names the gate that stopped it')
  assert.equal(rt.spawns.length, 0)
  assert.equal(rt.credential, token)
})

// --- the wire the panel really speaks (2026-10-04 report §12, item 3) --------------
// 0.3.9 shipped 86 green tests and not one of them sent the request the widget sends:
// the shell tests drove `status` and `set-auto` through the real routes, while every
// get-tok test called core.getTok() directly. A suite that never speaks the wire cannot
// notice that the wire was never spoken to — which is how "the click did nothing"
// reached a real machine with everything green. These tests post the panel's own bytes
// into the route the host registered, so the contract under test is the one that runs.
function wireFixture(options = {}) {
  const parts = hostShellCtx({ credentials: options.credentials })
  const seen = []
  const spawns = []
  const cdpCalls = []
  let spawned = false
  const overrides = {
    http: async (url, opts) => {
      seen.push({ url, headers: (opts && opts.headers) || {} })
      // Anonymous issuance is retired (a bare check is refused) and the authorized
      // login is accepted. Nothing leaves this process.
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      cdpCalls.push(arg)
      // Before the spawn no debug endpoint answers; afterwards the port answers as the
      // window this process started (its DevTools instance id included).
      if (!spawned) return { ok: false, running: false }
      return { ok: true, running: true, url: 'https://madmodel.cs.tsinghua.edu.cn/', browserId: 'test-uuid' }
    },
    findExecutable: async (c) => c,
    spawnBrowser: async (exe, argv) => { spawned = true; spawns.push({ exe, argv }); return { pid: 4321 } },
    closeBrowser: async () => ({ closed: false, reason: 'not ours in this test' }),
  }
  return { ...parts, overrides, seen, spawns, cdpCalls }
}

function shellStateFile() {
  return JSON.parse(fs.readFileSync(path.join(process.env.THU_TOK_AUTO_HOME, '.dsh', 'madmodel', 'state.json'), 'utf8'))
}

test('get-tok takes its carrier from one validated boolean, and refuses every other body', async () => {
  const calls = []
  const core = {
    state: () => ({ ok: true }),
    getTok: async (opts) => { calls.push(opts); return { ok: true } },
    openLogin: async () => ({ launched: true }),
  }
  const handlers = createApiHandlers(core, {})
  const getTokRoute = handlers.find((h) => h.path === '/thu-tok-auto/api/get-tok')
  assert.ok(getTokRoute, 'the route the panel posts to must exist in the factory the host registers')

  // Byte for byte what lib/ui.js sends: a click.
  const click = fakeRes()
  await getTokRoute.handler(fakeReq('POST', { 'content-type': 'application/json' }, {}), click.res)
  assert.equal(click.out.code, 200)
  // What an operator's verification script sends: the same route, saying it is unattended.
  const bg = fakeRes()
  await getTokRoute.handler(fakeReq('POST', { 'content-type': 'application/json' }, { background: true }), bg.res)
  assert.equal(bg.out.code, 200)
  assert.deepEqual(
    calls,
    [{ background: false }, { background: true }],
    'the run is told which carrier it has, and nothing else rides along',
  )

  // A body nobody declared is refused, not ignored: answering 200 to a request whose intent
  // was silently dropped is how a panel ends up promising a window nobody opened.
  for (const body of [{ background: 'yes' }, { background: 1 }, { bg: true }, { background: true, extra: 1 }]) {
    const bad = fakeRes()
    await getTokRoute.handler(fakeReq('POST', { 'content-type': 'application/json' }, body), bad.res)
    assert.equal(bad.out.code, 400, JSON.stringify(body) + ' must never reach the core')
  }
  assert.equal(calls.length, 2, 'a refused body starts no run at all')
})

test('the panel\'s own POST opens the login window inside the run that click started', async () => {
  const token = tk()
  const fx = wireFixture({
    credentials: { resolve: async () => ({ value: token, source: 'test' }), set: async () => {} },
  })
  const entry = await import('../lib/index.js?t=' + Date.now())
  await entry.applyWithDeps(fx.ctx, fx.overrides)
  await new Promise((r) => setTimeout(r, 80)) // let the async init settle
  const route = fx.routes.find((r) => r.path === '/thu-tok-auto/api/get-tok')
  assert.ok(route, 'the host must register the exact path lib/ui.js posts to')

  // Byte for byte what lib/ui.js sends: POST + application/json + `{}`.
  const { res, out } = fakeRes()
  await route.handler(fakeReq('POST', { 'content-type': 'application/json' }, {}), res)
  assert.equal(out.code, 200)
  const body = JSON.parse(out.body)
  assert.equal(body.via, 'reuse', 'the site can no longer mint and there is no usable SSO material')
  assert.equal(body.loginRequired, true, 'a click that cannot renew asks for the login')
  assert.equal(body.loginOpened, 'launched', 'and opens the window inside that very run')
  assert.equal(fx.spawns.length, 1, 'one click, one window')
  assert.match(fx.spawns[0].argv[0], /^--remote-debugging-port=93\d\d$/)
  assert.equal(body.trace.bg, 0, 'the answer carries the record of this run')
  assert.equal(body.trace.opened, 'launched')

  // And the same two facts are on disk, in the slots the panel reads back.
  const file = shellStateFile()
  assert.equal(file.lastTrace.bg, 0)
  assert.equal(file.lastTrace.opened, 'launched')
  assert.equal(file.lastManualTrace.bg, 0, 'a click is recorded as a click')
  assert.equal(file.lastManualTrace.at, file.lastTrace.at, 'the click is both traces at once')
  assert.equal('token' in file, false, 'the state file never holds the credential')
})

test('a request that says it is background never opens a visible window', async () => {
  const token = tk()
  const fx = wireFixture({
    credentials: { resolve: async () => ({ value: token, source: 'test' }), set: async () => {} },
  })
  const entry = await import('../lib/index.js?t=' + Date.now())
  await entry.applyWithDeps(fx.ctx, fx.overrides)
  await new Promise((r) => setTimeout(r, 80))
  const route = fx.routes.find((r) => r.path === '/thu-tok-auto/api/get-tok')
  const { res, out } = fakeRes()
  await route.handler(fakeReq('POST', { 'content-type': 'application/json' }, { background: true }), res)
  const body = JSON.parse(out.body)
  assert.equal(out.code, 200)
  assert.notEqual(body.loginOpened, 'launched', 'an unattended run may not put a window on screen')
  assert.equal(fx.spawns.length, 0, 'and nothing in this fixture proves even a headless one is needed')
  assert.equal(body.trace.bg, 1, 'the run is recorded as automatic')
})

test('the last click is recorded apart from the last automatic run', async () => {
  let now = 1700000000000
  const rt = createRuntime({
    mint: 'tok-by-click',
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '' },
    clockNow: () => now,
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.via, 'mint')
  const manual = rt.stateData.lastManualTrace
  assert.ok(manual, 'a click leaves a record of its own')
  assert.equal(manual.bg, 0)
  assert.equal(manual.via, 'mint')
  assert.equal(manual.at, now)
  assert.equal(rt.stateData.lastTrace.bg, 0, 'and it is also the newest run')

  now += 2 * 3600e3                            // the token is old enough for the hourly tick
  await rt.core.autoTick()
  assert.equal(rt.stateData.lastTrace.bg, 1, 'the tick owns "上次自动"')
  assert.notEqual(rt.stateData.lastTrace.at, manual.at, 'the two slots are different runs')
  assert.deepEqual(rt.stateData.lastManualTrace, manual, 'and the tick cannot erase the click')

  // The panel reads both back after a restart.
  const back = createRuntime({ stateData: JSON.parse(JSON.stringify(rt.stateData)), clockNow: () => now })
  await back.core.init()
  const snap = await back.core.state()
  assert.deepEqual(snap.manualTrace, manual)
  assert.equal(snap.trace.bg, 1)

  // A 0.3.9 state file only ever had one trace. If the run it holds was a click, that
  // record is the click record; if it was a tick, there is no click to show.
  const legacyClick = createRuntime({
    stateData: { lastGetAt: 0, cookies: '', ssoCookies: '', lastTrace: { at: 123, bg: 0, via: 'mint', opened: 'none' } },
    clockNow: () => now,
  })
  await legacyClick.core.init()
  const legacySnap = await legacyClick.core.state()
  assert.equal(legacySnap.manualTrace.at, 123)
  assert.equal(legacySnap.manualTrace.via, 'mint')

  const legacyTick = createRuntime({
    stateData: { lastGetAt: 0, cookies: '', ssoCookies: '', lastTrace: { at: 5, bg: 1, via: 'reuse' } },
    clockNow: () => now,
  })
  await legacyTick.core.init()
  assert.equal((await legacyTick.core.state()).manualTrace, null, 'an automatic run is not a click record')
})

// --- 2026-10-04 eighth round: a run that worked must be read as it really was (report §21) --
// On the real machine a click really did open the window, and the renewal really did land —
// but the answer said browserOpen/loginWait/browserMine = false and 「上次点击」 still named
// the run before it, because the reply was a snapshot taken before the work started. Two of
// those runs also lost their record to a transient EPERM on the state file's rename, and the
// plugin kept quiet about it. These five tests pin the four fixes, each with the counter-
// example that used to pass instead.

test('the answer to a click describes the window that click opened, not the run before it', async () => {
  const now = 1791108083039
  // An earlier click's record, on disk: the run that follows must not hand it back as its own.
  const stale = { at: 111, bg: 0, mint: 'fail', sso: 'fail', reuse: 1, verdict: 'yes', via: 'reuse', expBefore: 1, expAfter: 1, ms: 5, waitMs: 0, opened: 'none' }
  const rt = createRuntime({
    clockNow: () => now,
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '',
      lastTrace: { ...stale }, lastManualTrace: { ...stale },
    },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_LOGIN_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(click.loginOpened, 'launched', 'the click opens the temporary window')
  // The four flags the real machine read as false while that window was on screen.
  assert.equal(click.browserOpen, true, 'the answer says a window is open')
  assert.equal(click.loginWait, true, 'and that it is being watched for the login')
  assert.equal(click.browserMine, true, 'and that it is one this plugin started, so cleanup may own it')
  assert.equal(click.headless, false, 'a click gets the visible window, never the windowless one')
  assert.equal(click.status, 'waiting-login')
  // Nothing may have closed it, and the arm that finishes the job has to be running.
  assert.equal(rt.closes.length, 0, 'a window waiting for a person is not closed by the run that opened it')
  const capture = rt.timers.find((t) => t.ms === 2500)
  assert.ok(capture, 'the capture arm watches the window this run opened')
  assert.equal(capture.disposed, false)
  // And the record in the answer is this run's, down to the millisecond the clock was asked for.
  assert.equal(click.trace.at, now, 'the answer carries this run’s record')
  assert.equal(click.manualTrace.at, now, 'and 「上次点击」 is this click')
  assert.equal(click.manualTrace.opened, 'launched')
  assert.equal(rt.stateData.lastManualTrace.at, now, 'the record on disk is this click too')
})

test('an unattended capture is filed as automatic even when a click used a window in the same process', async () => {
  let now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const exp2 = exp1 + 2 * 3600
  const exp3 = exp2 + 2 * 3600
  const tok1 = jwtWith(exp1)
  const tok3 = jwtWith(exp3)
  // Phase 1 is a click whose SSO session is already gone (a login form), so it opens the
  // visible window; phase 2 is an Auto tick that meets the device-fingerprint page. The same
  // process runs both, which is exactly how a stale carrier flag would mis-file the second.
  let phase = 1
  let spawned = false
  let live = { token: '', uuid: '' }
  const spawnedArgv = []
  const rt = createRuntime({
    clockNow: () => now,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '' },
    http({ url, headers }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(phase === 1 ? IDP_LOGIN_FORM : IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) {
        // Anonymous issuance is closed, exactly as on the live site: only a check that
        // carries the session cookie answers — and it answers with whatever the site holds.
        const cookie = String((headers && (headers.Cookie || headers.cookie)) || '')
        if (!cookie) return { status: 401, ok: false, location: '', text: '' }
        return checkOk(phase === 1 ? tok1 : tok3)
      }
      if (url.endsWith('/model-api/auth-login')) {
        // The site rotates the token when the person logs in, so the one this plugin holds
        // is refused — the very refusal the live ladder met before it turned to the IDP.
        const auth = String((headers && (headers.Authorization || headers.authorization)) || '')
        return auth.indexOf(phase === 1 ? tok1 : tok3) !== -1
          ? authOk()
          : { status: 401, ok: false, location: '', text: '' }
      }
      return { status: 500, ok: false, location: '', text: '' }
    },
    spawnBrowser: async (exe, argv) => {
      spawnedArgv.push(argv)
      spawned = true
      // Whatever window this is, the page inside it ends up holding a token and an id.
      live = phase === 1 ? { token: tok1, uuid: 'uuid-click' } : { token: tok3, uuid: 'uuid-tick' }
      const portArg = argv.find((a) => String(a).indexOf('--remote-debugging-port=') === 0)
      live.port = Number(String(portArg).split('=')[1])
      return { pid: 4321 }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) {
        // Only the port a window of ours really holds answers, and a window this plugin has
        // closed stops answering at once — a ghost on the port is how a real launch gets
        // refused as "busy". Every other candidate port is free.
        return spawned && !live.closed && arg.port === live.port
          ? { ok: true, running: true, browserId: live.uuid }
          : { ok: false, running: false }
      }
      return { ok: true, running: true, token: live.token, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: live.uuid }
    },
    // A closed window really does stop answering, which is what lets the next launch pick
    // that port again. The close is still recorded the way the runtime records it.
    closeBrowser: async (arg) => {
      rt.closes.push(arg)
      live.closed = true
      return { closed: true, via: 'cdp' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'launched')
  assert.ok(spawnedArgv[0].indexOf('--headless=new') === -1, 'the click gets the visible window')
  // The person logs in: the arm sees a token the server vouches for and finishes the click.
  await rt.timers.find((t) => t.ms === 2500).fn()
  const clickRecord = { ...rt.stateData.lastManualTrace }
  assert.equal(clickRecord.bg, 0, 'the click that opened the window is filed as a click')
  assert.equal(clickRecord.at, now)
  assert.equal(rt.credential, tok1)

  // Phase 2: Auto has come due and the device page is all that stands in the way.
  phase = 2
  now += AUTO_REFRESH_MS + 60e3
  const tick = await rt.core.autoTick()
  assert.equal(tick.loginOpened, 'headless', 'the tick gets the windowless browser')
  assert.equal(tick.loginRequired, false, 'and needs nobody yet')
  assert.ok(spawnedArgv[1].indexOf('--headless=new') !== -1)
  assert.equal(tick.trace.bg, 1, 'the tick’s own record says it was automatic')
  assert.deepEqual(rt.stateData.lastManualTrace, clickRecord, 'and it does not overwrite the click’s record')

  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(rt.credential, tok3, 'the headless window really renewed')
  assert.equal(state.trace.bg, 1, 'the capture of an unattended run is filed as automatic, not as a click')
  assert.equal(state.trace.opened, 'headless')
  assert.equal(state.trace.expAfter, exp3 * 1000, 'and it says the expiry moved')
  assert.deepEqual(state.manualTrace, clickRecord, 'a background capture may not become 「上次点击」')
  assert.equal(rt.closes.length, 2, 'both windows were closed by the plugin that opened them')
  assert.deepEqual(rt.closes.map((c) => c.uuid), ['uuid-click', 'uuid-tick'])
})

test('a background run beside a window of ours neither opens nor closes anything', async () => {
  const now = 1791108083039
  const rt = createRuntime({
    clockNow: () => now,
    // Auto is overdue, so the only reason this tick may do nothing is the window in hand.
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '' },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_LOGIN_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'launched')
  const manualRecord = { ...rt.stateData.lastManualTrace }

  const tick = await rt.core.autoTick()
  assert.equal(rt.spawns.length, 1, 'the tick stacks no second window beside the one in hand')
  assert.equal(rt.closes.length, 0, 'and closes nothing')
  assert.equal(tick.browserOpen, true, 'the window the click opened is still on screen')
  assert.equal(tick.loginWait, true)
  assert.equal(tick.browserMine, true)
  assert.equal(tick.headless, false)
  assert.deepEqual(rt.stateData.lastManualTrace, manualRecord, 'and its record is untouched')
  assert.equal(rt.timers.find((t) => t.ms === 2500).disposed, false, 'the capture arm keeps watching it')

  // The same rule for a second click: it is answered with the window already open.
  const again = await rt.core.getTok()
  assert.equal(again.detail, 'waiting-login')
  assert.equal(again.loginOpened, 'already-open')
  assert.equal(again.loginRequired, true)
  assert.equal(again.browserOpen, true, 'and the answer still describes the open window')
  assert.equal(again.browserMine, true)
  assert.equal(rt.spawns.length, 1, 'no second window is opened')
  assert.equal(rt.closes.length, 0, 'and the first one is not seized or closed')
})

test('a record the disk refuses is retried, and a record that never lands says so', async () => {
  const now = 1791108083039
  const stale = { at: 111, bg: 0, via: 'reuse', opened: 'none' }
  const makeRuntime = (refusals) => {
    const seen = { traceAttempts: 0 }
    let disk = {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '',
      lastTrace: { ...stale }, lastManualTrace: { ...stale },
    }
    const rt = createRuntime({
      clockNow: () => now,
      stateIO: {
        async mkdir() { return { ok: true } },
        async load() { return { ok: true, data: JSON.parse(JSON.stringify(disk)) } },
        async save(p, data) {
          // Only the write that carries *this* run's record may be refused here: a state
          // save that has nothing to do with the click must not count as the same event.
          if (data && data.lastTrace && data.lastTrace.at === now) {
            seen.traceAttempts += 1
            if (seen.traceAttempts <= refusals) return { ok: false, error: 'EPERM: operation not permitted, rename' }
          }
          disk = JSON.parse(JSON.stringify(data))
          return { ok: true }
        },
      },
      stateData: disk,
      http({ url }) {
        // The click the real machine made: no usable automatic rung left, so the window opens.
        if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_LOGIN_FORM)
        if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
        if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
        return { status: 500, ok: false, location: '', text: '' }
      },
    })
    return { rt, seen, diskAt: () => disk }
  }

  // (a) One refusal, then the retry gets it through: the run may not cry wolf.
  {
    const { rt, seen, diskAt } = makeRuntime(1)
    await rt.core.init()
    const res = await rt.core.getTok()
    assert.equal(res.loginOpened, 'launched', 'the click still opens its window')
    assert.equal(seen.traceAttempts, 2, 'the refused write is attempted a second time inside the run')
    assert.ok(String(res.err).indexOf('本次记录未能写入磁盘') === -1, 'the record landed, so nothing claims otherwise')
    assert.match(String(res.err), /登录窗口/, 'and the run still says what it did')
    assert.equal(res.trace.at, now)
    assert.equal(diskAt().lastManualTrace.at, now, 'the record really is on disk')
  }

  // (b) Counter-example: a disk that never accepts it. The capture still happened, so the
  // only honest thing left is to say the record did not reach the file — going quiet is how
  // 「上次点击」 keeps showing an older run as if it were this one.
  {
    const { rt, seen, diskAt } = makeRuntime(Infinity)
    await rt.core.init()
    const res = await rt.core.getTok()
    assert.equal(res.loginOpened, 'launched')
    assert.equal(seen.traceAttempts, 3, 'the retry is bounded, not endless')
    assert.match(String(res.err), /本次记录未能写入磁盘/)
    assert.equal(res.trace.at, now, 'the answer in hand still describes this run')
    assert.equal(diskAt().lastManualTrace.at, 111, 'while the file keeps the earlier one — which is what the note warns about')
  }
})

test('a rename the OS refuses is retried, and one that never goes through still lands the bytes', async () => {
  const dir = path.join(process.env.THU_TOK_AUTO_HOME, '.dsh', 'madmodel')
  const file = path.join(dir, 'state.json')
  // A tick fired by set-auto would write through the same seam and blur the count, so the
  // file starts fresh enough that Auto is not due.
  fs.writeFileSync(file, JSON.stringify({ lastGetAt: Date.now(), auto: false, cookies: '', ssoCookies: '' }))
  const realRename = fs.renameSync
  const fx = wireFixture({ credentials: { resolve: async () => undefined, set: async () => {} } })
  const entry = await import('../lib/index.js?t=' + Date.now())
  try {
    // The real fs-backed stateIO (lib/index.js), with the OS refusing the atomic swap the
    // way it did on 2026-10-04 18:01:23.
    let renames = 0
    fs.renameSync = function (from, to) {
      renames += 1
      if (renames <= 2) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e }
      return realRename(from, to)
    }
    await entry.applyWithDeps(fx.ctx, fx.overrides)
    await new Promise((r) => setTimeout(r, 80)) // let the async init settle
    const route = fx.routes.find((r) => r.path === '/thu-tok-auto/api/set-auto')
    assert.ok(route, 'the route the panel toggles Auto with')

    const base = renames
    const first = fakeRes()
    await route.handler(fakeReq('POST', { 'content-type': 'application/json' }, { on: true }), first.res)
    assert.equal(first.out.code, 200, 'a rename that had to be retried is not an error the panel sees')
    assert.equal(renames - base, 3, 'two refusals, then the swap goes through')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).auto, true, 'and the state really is on disk')

    // Counter-example: an OS that refuses every swap. The data still has to land, and the
    // temporary file may not pile up in the directory the user can see.
    let attempts = 0
    fs.renameSync = function () {
      attempts += 1
      const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e
    }
    const second = fakeRes()
    await route.handler(fakeReq('POST', { 'content-type': 'application/json' }, { on: false }), second.res)
    assert.equal(second.out.code, 200)
    assert.equal(attempts, 3, 'the atomic path is tried a bounded number of times')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).auto, false, 'the direct overwrite keeps the record')
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.indexOf('.tmp-') !== -1), [], 'and no temp file is left behind')
  } finally {
    fs.renameSync = realRename
  }
})

// --- 2026-10-04 round 9: the click that cannot finish without a person ---
// Report §22. A click whose device-page attempt runs out of time used to end as a lost run: the
// headless browser was closed, nothing was opened in its place, and the answer still said
// "processing" — a door that had already been shut. These tests pin the four things that make
// the click whole again: the window opens inside the same run (and only for a click), the
// sentence matches the carrier that failed, a second click is not promised a window that is not
// there, and a disk that refuses the state file is reported as such instead of as a detail.

test('a click whose windowless attempt falls short opens the one window in that same run', async () => {
  let now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const old = jwtWith(exp1)
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly ? { ok: false, running: false } : { ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()

  // The device page, not a dead session, is what the cookie-only walk cannot pass — so the click
  // spends its one automatic route first: a browser of the plugin's own with nothing on screen.
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless')
  assert.equal(click.loginRequired, false, 'nothing needs a person yet')
  assert.equal(click.offline, false, 'the site answered this run, so this is not an outage')
  assert.equal(click.browserOpen, true, 'and the answer describes the browser this run opened')
  assert.equal(click.headless, true)
  assert.equal(rt.spawns.length, 1)
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1)

  // A minute later that route has not finished. The click gets the door it has always had, in
  // this same request, with no second Get — and the browser kept to itself is gone.
  now += HEADLESS_TIMEOUT_MS + 1000
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(rt.closes.length, 1, 'the headless browser this run opened is closed')
  assert.equal(rt.spawns.length, 2, 'and exactly one visible window takes its place')
  assert.ok(rt.spawns[1].argv.indexOf('--headless=new') === -1, 'this one has a window, because a person has to use it')
  assert.equal(state.status, 'waiting-login')
  assert.equal(state.browserOpen, true)
  assert.equal(state.loginWait, true)
  assert.equal(state.browserMine, true)
  assert.equal(state.headless, false, 'what is open now is a window, and the panel says so')
  assert.match(String(state.err), /免密续期没能在后台完成/)
  assert.match(String(state.err), /无需再点 Get/)
  const arms = rt.timers.filter((t) => t.ms === 2500)
  assert.equal(arms.length, 2, 'the visible window is watched like any other')
  assert.equal(arms[0].disposed, true, 'the arm that watched the headless browser is over')
  assert.equal(arms[1].disposed, false)
})

test('a click whose door also fails says so instead of pretending a window exists', async () => {
  let now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const attempts = []
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    spawnBrowser: async (exe, argv) => {
      attempts.push(argv)
      // The headless browser starts; the visible one does not. This is the machine where the
      // click's last door will not open, and the answer has to say both reasons.
      if (attempts.length > 1) throw new Error('boom')
      return { pid: 4321 }
    },
    cdp: async (arg) => (arg.probeOnly ? { ok: false, running: false } : { ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless')
  assert.equal(attempts.length, 1)

  now += HEADLESS_TIMEOUT_MS + 1000
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(attempts.length, 2, 'the click really did try to open the visible window')
  assert.notEqual(state.status, 'waiting-login', 'nothing is waiting for a login that cannot start')
  assert.equal(state.browserOpen, false, 'and no open window is claimed')
  assert.equal(state.loginWait, false)
  assert.equal(state.browserMine, false)
  assert.match(String(state.err), /点击后的免密续期未在 1 分钟内完成（没有窗口）/, 'the failed attempt still says what it was')
  assert.match(String(state.err), /登录窗口未能打开/, 'and the window says why it is not there')
  assert.ok(String(state.err).indexOf('已为你打开登录窗口') === -1, 'the panel may not promise a window that does not exist')
})

test('a background attempt that falls short opens no window for anyone', async () => {
  let now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 5 * 3600
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly ? { ok: false, running: false } : { ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()
  assert.equal(tick.loginOpened, 'headless')

  // The same failure a click would answer with a window. An unattended machine has nobody to
  // use one, so this run gets a sentence and half an hour of quiet instead — never a window
  // the user did not ask for (2026-10-04 policy, requirement B).
  now += HEADLESS_TIMEOUT_MS + 1000
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(rt.spawns.length, 1, 'no visible window replaces the headless one')
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1)
  assert.equal(rt.closes.length, 1)
  assert.equal(state.browserOpen, false)
  assert.equal(state.headless, false)
  assert.equal(state.loginReason, 'needs-manual-login', 'a person is what would unblock it, and that is remembered')
  assert.match(String(state.err), /后台免密续期/, 'the sentence names the carrier that fell short')
  assert.ok(String(state.err).indexOf('已为你打开登录窗口') === -1)
  now += 10 * 60e3
  await rt.core.autoTick()
  assert.equal(rt.spawns.length, 1, 'and the failure buys half an hour, not a browser every tick')
})

test('a second click during a windowless renewal is not told a window is open', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly ? { ok: false, running: false } : { ok: false, running: false, reason: 'no-devtools' }),
  })
  await rt.core.init()
  const first = await rt.core.getTok()
  assert.equal(first.loginOpened, 'headless')

  // What is being watched decides what may be said about it: there is no window on screen, so
  // answering 「登录窗口已打开」 would send the user looking for something that is not there.
  const again = await rt.core.getTok()
  assert.equal(again.detail, 'processing-headless')
  assert.equal(again.loginOpened, 'headless')
  assert.equal(again.loginRequired, false, 'no person is needed yet')
  assert.equal(again.browserOpen, true)
  assert.equal(again.headless, true)
  assert.match(String(again.err), /后台/)
  assert.ok(String(again.err).indexOf('登录窗口') === -1, 'there is no window to call a login window')
  assert.equal(rt.spawns.length, 1, 'and no second browser is opened beside it')
  assert.equal(rt.closes.length, 0, 'nor is the one being watched seized or closed')
  assert.equal(again.trace.via, 'waiting-login')
  assert.equal(again.trace.opened, 'headless')
  assert.equal(rt.stateData.lastTrace.via, 'waiting-login')
  assert.equal(rt.stateData.lastTrace.opened, 'headless', 'the record on disk says which carrier was being watched')
})

test('the page the windowless browser is stuck on is read, filed, and stripped of anything secret', async () => {
  let now = 1791108083039
  const t0 = now
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  // A token-shaped run of characters in the two places a real page would carry one: the URL the
  // device page was reached with, and its own console error. Neither may reach the record.
  const SECRET = 'a'.repeat(30)
  const page = {
    title: '统一身份认证',
    path: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/' + SECRET,
    form: 'device-fingerprint',
    fp2: false,
    ready: true,
    errors: ['js TypeError: Fingerprint2 is not defined at https://id.tsinghua.edu.cn/x.js?ticket=' + SECRET],
  }
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: '', url: 'https://id.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-h1', page }),
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless')

  // The reading happens on a poll; the minute is only up on a later turn of the same arm (the
  // timeout is checked above the poll), so the two are fired separately on purpose.
  const arm = rt.timers.find((t) => t.ms === 2500)
  await arm.fn()
  const seen = await rt.core.state()
  assert.equal(seen.lastProbe.form, 'device-fingerprint', 'the panel knows which page the browser is on')
  assert.equal(seen.lastProbe.fp2, false, 'including whether that page ever loaded its own fingerprint library')

  now += HEADLESS_TIMEOUT_MS + 1000
  await arm.fn()
  const state = await rt.core.state()
  assert.equal(state.headlessFailReason, 'device-page', 'a device page is named as the reason a person is needed')
  assert.match(String(state.err), /设备确认页/, 'and the window that opens for it keeps that reason on the line')
  assert.match(String(state.err), /已为你打开登录窗口/)
  assert.equal(state.status, 'waiting-login')
  assert.equal(rt.spawns.length, 2, 'the window a person needs takes the headless browser\'s place')
  const probe = state.lastProbe
  assert.equal(probe.form, 'device-fingerprint')
  assert.equal(probe.ready, true)
  assert.equal(probe.at, t0, 'the reading is stamped with when it was taken')
  assert.ok(probe.path.endsWith('…'), 'the long opaque segment is elided, not stored')
  assert.equal(probe.errors.length, 1)
  assert.ok(probe.errors[0].indexOf('…') !== -1, 'and the console error is elided the same way')
  assert.ok(JSON.stringify(probe).indexOf(SECRET) === -1, 'no token-shaped run of characters reaches the record')
  assert.equal(rt.stateData.lastProbe.form, 'device-fingerprint', 'the reading is on disk, so a restart still knows it')
})

test('a state file the disk refuses is reported as a state-file failure, not as a detail', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 4 * 3600
  const exp2 = exp1 + 6 * 3600
  const old = jwtWith(exp1)
  const fresh = jwtWith(exp2)
  const makeRuntime = (refusals) => {
    const seen = { refused: 0 }
    let disk = { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', tokenExpAt: exp1 * 1000, lastTrace: { at: 111 }, lastManualTrace: { at: 111 } }
    const rt = createRuntime({
      clockNow: () => now,
      credential: old,
      mint: fresh,
      stateIO: {
        async mkdir() { return { ok: true } },
        async load() { return { ok: true, data: JSON.parse(JSON.stringify(disk)) } },
        async save(p, data) {
          // Every save this run makes carries the newly minted token; the first `refusals` of
          // them come back the way Windows refused the rename on 2026-10-04 18:01:23.
          if (data && data.tokenExpAt === exp2 * 1000 && seen.refused < refusals) {
            seen.refused += 1
            return { ok: false, error: 'EPERM: operation not permitted, rename' }
          }
          disk = JSON.parse(JSON.stringify(data))
          return { ok: true }
        },
      },
      stateData: disk,
    })
    return { rt, seen, diskAt: () => disk }
  }

  // (a) A disk that stumbles once is not a failure the panel talks about: the retry inside the
  // run gets the file down, so the run is allowed to read as the clean run it was.
  {
    const { rt, seen, diskAt } = makeRuntime(2)
    await rt.core.init()
    const res = await rt.core.getTok()
    assert.equal(seen.refused, 2, 'a refused write is retried inside the run')
    assert.equal(res.status, 'ok', 'the token was minted, verified and written — nothing else is wrong')
    assert.equal(res.stateDiskFailed, false)
    assert.ok(String(res.err).indexOf('状态文件未能写入') === -1, 'the file is on disk, so nothing claims otherwise')
    assert.equal(diskAt().tokenExpAt, exp2 * 1000)
  }

  // (b) Counter-example: a disk that never takes it. The token is in the credential store and
  // works, but nothing about it survives a restart — that is its own sentence, said as one,
  // instead of a bare `state:` prefix that reads like a detail.
  {
    const { rt, seen, diskAt } = makeRuntime(Infinity)
    await rt.core.init()
    const res = await rt.core.getTok()
    assert.ok(seen.refused >= 6, 'the retries happen, and they happen more than once per write')
    assert.equal(seen.refused % 3, 0, 'each write is retried a bounded number of times, not endlessly')
    assert.equal(res.status, 'error', 'a run that cannot be remembered is not reported as a clean one')
    assert.equal(res.stateDiskFailed, true)
    assert.match(String(res.err), /状态文件未能写入/)
    assert.match(String(res.err), /宿主重启后会回退/)
    assert.ok(String(res.err).indexOf('state:') === -1, 'no bare machine prefix where a sentence belongs')
    assert.equal(rt.credential, fresh, 'the credential store is a different store, and it did get the token')
    assert.equal(res.expiresAt, exp2 * 1000)
    assert.equal(diskAt().tokenExpAt, exp1 * 1000, 'while the file still holds the token it had before')
  }
})

// ---------------------------------------------------------------------------
// 第十轮：无窗口载体换代（正常 Edge + --no-startup-window + 原生隐藏页）
// ---------------------------------------------------------------------------
// 这一组测的只有一件事：**哪一条无窗口载体真的跑了**。宿主能给出隐藏页时用隐藏页（新引擎），
// 给不出时当场自证回退到内置无头壳（旧引擎），隐藏页在运行中死掉时点击拿到可见窗口、后台什么
// 也不弹。三条路都不许有窗口出现在屏幕上，也都不许把两条载体说成同一条。

// 宿主的 hiddenTarget 交回来的句柄：页面活在这条浏览器级连接上，所以句柄自带 close。测试记下
// 它被关过几次——隐藏页"自造自关"的客观读数就是这里加一。
const hiddenHandle = (over = {}) => {
  const h = {
    ok: true,
    targetId: 'T-1',
    browserId: 'uuid-hidden-1',
    closed: 0,
    send() { return Promise.resolve({}) },
    close() { h.closed += 1; return { closed: true } },
    ...over,
  }
  return h
}

test('an unattended run asks no host for a hidden page, and spends no throwaway browser on one', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 300
  const exp2 = exp1 + 6 * 3600
  const old = jwtWith(exp1)
  const renewed = jwtWith(exp2)
  // A token-shaped run of characters in the URL the device page was reached with: the reading
  // is filed, but never with the secret in it (round 9 requirement D, carried into round 10).
  const SECRET = 'b'.repeat(30)
  const page = {
    title: '统一身份认证',
    path: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/' + SECRET,
    form: 'device-fingerprint',
    fp2: false,
    ready: true,
    errors: [],
  }
  const asked = []
  const handle = hiddenHandle()
  const rt = createRuntime({
    clockNow: () => now,
    credential: old,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    // 宿主能给出隐藏页，生产路径也不再问它：`--no-startup-window` 起的浏览器没有 frame
    // target，Target.createTarget{hidden:true} 只会换来 -32000（2026-10-05 在活的真机实例上
    // 量到 /json/list = 0，生产 argv 探针 20 秒里 frame 恒 0）。问一次就是白起一台浏览器，
    // 再加一次"关不掉的证明" —— 第十二轮那台被留下的自有 Edge 就是这么来的。
    hiddenTarget: async (arg) => { asked.push(arg); return handle },
    cdp: async (arg) => {
      if (arg.probeOnly) return rt.spawns.length === 0 ? { ok: false, running: false } : { ok: true, running: true, browserId: 'uuid-shell-1' }
      return { ok: true, running: true, token: renewed, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-shell-1', page }
    },
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()

  assert.equal(asked.length, 0, 'the host was never asked for a hidden page')
  assert.equal(handle.closed, 0, 'and a page that was never created is never closed either')
  assert.equal(tick.loginOpened, 'headless', 'an unattended run names the carrier that really ran')
  assert.equal(tick.carrier, 'headless')
  assert.equal(tick.headless, true, 'no window means no window, whichever engine runs it')
  assert.equal(tick.loginRequired, false, 'nothing needs a person yet')
  assert.equal(rt.spawns.length, 1, 'one browser, and the plugin opened it')
  const argv = rt.spawns[0].argv
  assert.ok(argv.indexOf('--headless=new') !== -1, 'the built-in no-window shell is what runs')
  assert.equal(argv.indexOf('--no-startup-window'), -1, 'and no native browser is launched just to be thrown away')
  assert.equal(argv.some((a) => a.indexOf('http') === 0), true, 'the shell is launched straight at the device page — which is why no page has to be created for it')
  assert.ok(/^https:\/\/id\.tsinghua\.edu\.cn\//.test(String(argv[argv.length - 1])), 'the page it opens is the IDP one, not ours to invent')
  assert.equal(argv.join(' ').indexOf(SECRET), -1, 'and no session material rides along in the launch arguments')
  const opened = await rt.core.state()
  assert.equal(opened.carrierNote, '', 'nothing went wrong, so nothing claims a fallback')
  assert.match(String(opened.err), /后台浏览器/, 'the panel says which engine is running off screen')

  // The same capture arm finishes the renewal: credential written, expiry advanced, and the
  // browser this run opened is the one that gets closed.
  await rt.timers.find((t) => t.ms === 2500).fn()
  const state = await rt.core.state()
  assert.equal(rt.credential, renewed, 'the renewed token is what the store holds')
  assert.equal(jwtExpiry(rt.credential), exp2 * 1000, 'and its expiry strictly advanced')
  assert.equal(state.status, 'ok')
  assert.equal(state.headless, false, 'the browser is gone, so nothing claims it is still there')
  assert.equal(rt.closes.length, 1, 'self-spawned, self-closed')
  assert.equal(rt.closes[0].uuid, 'uuid-shell-1', 'the close carries the identity this run read off its own port')
  assert.equal(rt.closes[0].reason, 'captured')
  assert.equal(state.carrier, '', 'with the browser gone, no carrier is claimed')
  assert.equal(state.trace.opened, 'headless', 'the record keeps which carrier did the work')
  assert.equal(state.trace.carrier, 'headless')
  assert.equal(state.trace.bg, 1, 'and that the run was unattended')
  assert.equal(state.trace.expAfter, exp2 * 1000)
  assert.equal(state.lastProbe.form, 'device-fingerprint', 'the page the no-window browser reached is filed')
  assert.ok(JSON.stringify(state.lastProbe).indexOf(SECRET) === -1, 'without the token-shaped run of characters')
})

test('our own leftover browser that will not confirm its close is left alone, and the click takes another port with a profile of its own', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const leftover = 'uuid-leftover-1'
  const born = 'uuid-9334-1'
  const attempts = []
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar,
      tokenExpAt: exp1 * 1000, browserUuid: leftover, browserPort: 9333, browserPid: 4321, browserMine: true,
    },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    // 9333 answers with the very identity this plugin recorded — the only evidence that separates
    // "our own leftover" from "a stranger that happens to sit on 9333" — and it refuses to close.
    // Ports above it are free. 2026-10-05 real machine: this browser (PID 7560, --no-startup-window,
    // alive from 00:51) held 9333 all night while every Auto run failed, and the plugin's answer was
    // "close that browser by hand first" — a dead end, because 9334 was empty the whole time. It now
    // asks the leftover to close, and when that cannot be confirmed it leaves it exactly as it is and
    // carries on with a port and a profile of its own.
    cdp: async (arg) => {
      if (arg.probeOnly) {
        if (arg.port === 9333) return { ok: true, running: true, browserId: leftover }
        return { ok: false, running: false }
      }
      return { ok: true, running: true, token: '', url: '', cookies: [], browserId: born }
    },
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: false, reason: 'still-running' } },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.ok(attempts.length >= 1, 'the leftover was asked to close itself by its own identity')
  for (const a of attempts) {
    assert.equal(a.uuid, leftover, 'the close carries the identity that was read off the port')
    assert.equal(a.reason, 'leftover-own')
  }
  assert.equal(rt.spawns.length, 1, 'the click still gets a browser of its own instead of a dead end')
  const argv = rt.spawns[0].argv
  assert.ok(argv.indexOf('--remote-debugging-port=9334') !== -1, 'and it runs on the port that was free, not on the one in use')
  const userDataDir = argv.find((a) => a.indexOf('--user-data-dir=') === 0)
  assert.ok(userDataDir, 'a private --user-data-dir is on the command line')
  const profile = userDataDir.slice('--user-data-dir='.length)
  assert.notEqual(profile, LEASE_PROFILE, 'never the shared profile, which that leftover may still be holding')
  assert.equal(profile.indexOf('C:\\Users\\test\\.dsh\\madmodel\\run-'), 0, 'but a one-run directory under the same state directory')
  assert.equal(click.loginOpened, 'headless', 'the click is served, and by the no-window carrier')
  assert.equal(click.carrier, 'headless')
  assert.equal(click.browserOpen, true, 'the capture arm watches our own browser')
  const state = await rt.core.state()
  assert.equal(state.loginReason, '', 'no carrier failure is left behind: this run worked')
  assert.equal(state.carrierProfile, 'isolated', 'the state says this run used a profile of its own')
  assert.equal(state.portStrangers, 0, 'the leftover is ours, not a stranger')
  const said = String(click.err)
  assert.ok(said.indexOf('9333') !== -1, 'the visible line names the port that is in the way')
  assert.ok(said.indexOf(leftover) !== -1, 'and the instance identity, so the evidence is not lost')
  assert.ok(said.indexOf('still-running') !== -1, 'and the reason the browser itself gave')
  assert.ok(said.indexOf('9334') !== -1, 'and the port this run took instead')
  assert.ok(said.indexOf('独立临时 profile') !== -1, 'and that this run is not sharing a profile with it')
  assert.ok(said.indexOf('没有读它') !== -1, 'and that it was never read')
  assert.ok(!/先手动关掉那台浏览器/.test(said), 'and never sends the user off to close a browser by hand')
  assert.ok(!/需要.{0,4}登录/.test(said), 'a carrier problem is never dressed up as "log in by hand"')
  const saved = rt.saves[rt.saves.length - 1]
  assert.equal(saved.carrierProfile, 'isolated')
  assert.equal(saved.portStrangers, 0)
  assert.ok(String(saved.portNote).indexOf(leftover) !== -1, 'the leftover and its reading survive a restart')
  assert.equal(saved.owned.port, 9334, 'the lease describes the browser this run actually started')
  assert.equal(saved.owned.profile, profile, 'including the one-run profile it lives in')
})

test('a debug port that will not even answer a probe does not swallow the click\'s other readings', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const idpHtml = okResponse(IDP_FINGERPRINT_FORM)
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return idpHtml
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    // 2026-10-05 真机那次点击，最后的读数只剩一句 headlessFailReason="error"：探测 9333 时抛出
    // 的异常从 openLogin 里逃了出去，被最外层 catch 收成 { reason: 'error' }，端口号、身份、
    // 浏览器给的话一起没了。一个端口的异常是"这个端口谈不成"，不是"这一轮完了"。
    cdp: async (arg) => {
      if (arg.probeOnly) {
        if (arg.port === 9333) throw new Error('socket hang up')
        return rt.spawns.length === 0 ? { ok: false, running: false } : { ok: true, running: true, browserId: 'uuid-shell-2' }
      }
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [], browserId: 'uuid-shell-2' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(click.loginOpened, 'headless', 'the next free port still gets the click its no-window carrier')
  assert.equal(rt.spawns.length, 1, 'and exactly one browser was spent on it')
  const argv = rt.spawns[0].argv
  assert.ok(argv.indexOf('--remote-debugging-port=9334') !== -1, 'it runs on the port that answered, not on the one that threw')
  assert.ok(argv.indexOf('--headless=new') !== -1, 'the no-window shape is the one that actually works')
  const state = await rt.core.state()
  assert.notEqual(state.loginReason, 'needs-manual-login', 'a port that will not talk says nothing about the session')
  assert.match(String(state.err), /后台浏览器/, 'and the panel still describes the carrier that is running')

  // 全部端口都谈不成时，报的必须是"端口全不可用 + 第一个异常"，不是一句 error。
  const stuck = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return idpHtml
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async () => { throw new Error('socket hang up') },
  })
  await stuck.core.init()
  const stuckClick = await stuck.core.getTok()
  assert.equal(stuckClick.loginOpened, 'no-debug-port', 'a click with nowhere to put a browser says exactly that')
  assert.equal(stuck.spawns.length, 0, 'and spends no browser on a port it could not even talk to')
  assert.match(String(stuckClick.err), /9333-9343 均被占用/, 'the visible line names the range')
  assert.match(String(stuckClick.err), /探测时报错/, 'and says that probing is what failed')
  assert.match(String(stuckClick.err), /socket hang up/, 'with the first real error text, not a category word')
})

test('an unattended run that meets our own unclosable leftover leaves it alone and uses a carrier of its own', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 5 * 3600
  const leftover = 'uuid-leftover-2'
  const born = 'uuid-9334-2'
  const attempts = []
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: {
      lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar,
      tokenExpAt: exp1 * 1000, browserUuid: leftover, browserPort: 9333, browserMine: true,
    },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    cdp: async (arg) => {
      if (arg.probeOnly) {
        if (arg.port === 9333) return { ok: true, running: true, browserId: leftover }
        return { ok: false, running: false }
      }
      return { ok: true, running: true, token: '', url: '', cookies: [], browserId: born }
    },
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: false, reason: 'still-running' } },
  })
  await rt.core.init()
  const tick = await rt.core.autoTick()

  // 2026-10-05 真机：这里曾经什么都没有发生（opened:'carrier-blocked'），而 9334 空着。后台不该
  // 因为"上一台自有浏览器关不掉"就整夜不动，也不该为此把人叫来 —— 它换端口、用自己的 profile 干活。
  assert.equal(rt.spawns.length, 1, 'the due run still gets a browser, just not on the port that is in use')
  assert.equal(rt.spawns[0].argv.find((a) => a.indexOf('--remote-debugging-port=') === 0), '--remote-debugging-port=9334')
  const profile = rt.spawns[0].argv.find((a) => a.indexOf('--user-data-dir=') === 0).slice('--user-data-dir='.length)
  assert.equal(profile.indexOf('C:\\Users\\test\\.dsh\\madmodel\\run-'), 0, 'under a one-run profile, not the shared one')
  assert.ok(attempts.length >= 1, 'and that leftover is still asked to close by its own identity')
  assert.equal(tick.loginOpened, 'headless', 'the record names the carrier that ran')
  assert.equal(tick.loginRequired, false, 'a carrier problem is not something a person fixes by logging in')
  assert.ok(rt.timers.find((t) => t.ms === 2500), 'the capture arm is watching our own browser')
  const state = await rt.core.state()
  assert.notEqual(state.loginReason, 'carrier-blocked', 'the carrier is not recorded as blocked: it ran')
  assert.equal(state.loginReason, '', 'and nothing about the session is blamed')
  assert.equal(state.carrierProfile, 'isolated')
  assert.ok(String(state.err).indexOf('9333') !== -1, 'the visible line carries the port')
  assert.ok(String(state.err).indexOf(leftover) !== -1, 'and the identity of the browser in the way')
  assert.ok(String(state.err).indexOf('9334') !== -1, 'and the port this run took')
  assert.ok(!/需要.{0,4}登录/.test(String(state.err)), 'and it does not tell the user to log in again')
  assert.ok(!/先手动关掉那台浏览器/.test(String(state.err)), 'and it does not send anyone off to close a browser by hand')
  assert.equal(state.browserOpen, true)
})

test('perf: a renewal the failure backoff is holding back says so, and stops touching the browser', async () => {
  let now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 5 * 3600
  const leftover = 'uuid-leftover-5'
  const stranger = 'uuid-stranger-5'
  const attempts = []
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: {
      lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar,
      tokenExpAt: exp1 * 1000, browserUuid: leftover, browserPort: 9333, browserMine: true,
    },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    // 自有残留占着 9333 且关不掉，其余端口全是别人的浏览器：这一轮的载体确实起不来（第十七轮给
    // 这种局面留的判词是 no-debug-port，不再是"先手动关掉那台浏览器再点 Get"）。要证的仍然是
    // 退避本身：它有没有留下自己的名字、有没有忍住不去反复捅那台浏览器。
    cdp: async (arg) => {
      if (arg.probeOnly) {
        return arg.port === 9333
          ? { ok: true, running: true, browserId: leftover }
          : { ok: true, running: true, browserId: stranger }
      }
      return { ok: true, running: true, token: '', url: '', cookies: [], browserId: leftover }
    },
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: false, reason: 'still-running' } },
  })
  await rt.core.init()

  // 第一次：载体起不来（自有残留关不掉 + 其余端口都是别人的）——失败记忆 30 分钟退避。
  const first = await rt.core.autoTick()
  assert.equal(first.loginOpened, 'no-debug-port')
  assert.equal(rt.spawns.length, 0, 'no browser is put on a port that is not ours to take')
  const touched = attempts.length
  assert.ok(touched >= 1, 'the leftover was asked to close once, by its own identity')

  // 退避期内：连试都不试。以前这里写 opened:'none'，读不出 Auto 为什么不动。
  // （时钟往前走一点，好让这一轮仍然到点该续期 —— 否则 tick 会按"还没到时候"直接返回快照。）
  now += AUTO_REFRESH_MS + 60e3
  const held = await rt.core.autoTick()
  assert.equal(held.loginOpened, 'backoff', 'the record names the backoff instead of saying nothing')
  assert.equal(held.headlessFailReason, 'backoff', 'the gate leaves its own name behind, not the previous run\'s failure')
  assert.equal(held.loginRequired, false, 'a backoff is not something a person fixes by logging in')
  assert.equal(held.carrier, '')
  assert.equal(held.headless, false)
  assert.equal(rt.spawns.length, 0, 'nothing is spawned while the backoff holds')
  assert.equal(attempts.length, touched, 'and the browser in the way is not poked again on every tick')
  const heldState = await rt.core.state()
  assert.equal(heldState.loginReason, 'fingerprint-required', 'the gate does not overwrite the reason the session side gave')
  // 闸门不抢话：梯子已经写下"需要重新登录"时，那一句比"退避期还没过"对用户更有用。
  assert.match(String(heldState.err), /需要重新登录/, 'the sentence the ladder wrote survives the gate')
  assert.ok(String(heldState.err).indexOf('退避') === -1, 'the gate does not push its own sentence over a better one')
  assert.ok(String(heldState.err).indexOf(leftover) === -1, 'and the leftover\'s readings stay out of the gate\'s sentence')

  // 退避过去：照常再试一次（退避是时钟，不是永久关闭）。
  now += 31 * 60e3
  const again = await rt.core.autoTick()
  assert.equal(again.loginOpened, 'no-debug-port', 'once the backoff has passed the carrier is tried again')
  assert.ok(attempts.length > touched, 'and the browser in the way is asked to close again')
  assert.ok(!/先手动关掉那台浏览器/.test(String(again.err)), 'and the user is still not sent off to close it by hand')
})

test('a host that cannot hand out a hidden page goes straight to the shell, without a throwaway browser', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return { status: 401, ok: false, location: '', text: '' }
      return { status: 500, ok: false, location: '', text: '' }
    },
    // No hiddenTarget at all: an older host. Whether the native carrier is on offer is a fact
    // about the host, so it is settled before anything is spawned — a first cut launched the
    // native browser, failed to get a page and launched again, which is a browser spent on a
    // question the host had already answered (2026-10-04 round 10).
    cdp: async (arg) => (arg.probeOnly
      ? { ok: false, running: false }
      : { ok: true, running: true, token: '', url: 'https://id.tsinghua.edu.cn/', cookies: ssoJar, browserId: 'uuid-old' }),
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless', 'an older host keeps the carrier it has always had')
  assert.equal(click.carrier, 'headless')
  assert.equal(click.carrierNote, '', 'no fallback happened, so none is claimed')
  assert.match(String(click.err), /后台浏览器/, 'and the sentence for that carrier is unchanged')
  assert.equal(rt.spawns.length, 1, 'one browser, not one that is closed again a moment later')
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1)
  assert.equal(rt.spawns[0].argv.indexOf('--no-startup-window'), -1, 'a host without the hidden page never gets a UI-less normal Edge')
})

// ===========================================================================
// 第十二轮：真机（2026-10-04 22:27-22:31，生产 argv + 生产 profile）暴露的三件事
//
// 1) 无窗口启动的浏览器在前几秒**一个 DevTools 目标都没有**，那时去建隐藏页被
//    -32000「Hidden target can be created only when remote debugging is enabled」拒掉
//    （Chromium target_handler.cc 的判据是 RemoteDebuggingTargets(kFrame) 非空）；
// 2) 回退时 state.browserUuid 还是空的 ⇒ close 报 no-ownership-evidence ⇒ 第一台没被关，
//    第二台在同一个 profile 上被旧实例接管，约 10 s 后读成 'gone'、exp 一动不动；
// 3) via==='reuse' 时 expiryAdvanced 被无条件写成 true —— 复用了旧令牌却报"到期时间前进"。
// ===========================================================================

const FAKE_BROWSER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/**
 * 生产 hiddenTarget 用的是全局 fetch/WebSocket（createBrowserCloser 那两个依赖可注入，它这
 * 两个不是），所以夹具临时替换全局，并在 finally 里无论成败都换回来。
 * setup(state) 返回计划：{ fetchFails, wsUrl, answer(msg) -> {result|error} | null }。
 */
async function withFakeDevtools(setup, fn) {
  const realFetch = globalThis.fetch
  const realWs = globalThis.WebSocket
  const state = { fetchCalls: 0, methods: [], sockets: [], sent: [] }
  let plan = {}
  try {
    globalThis.fetch = async () => {
      state.fetchCalls += 1
      if (plan.fetchFails) throw new Error('connect ECONNREFUSED 127.0.0.1:9333')
      const wsUrl = plan.wsUrl === undefined
        ? ('ws://127.0.0.1:9333/devtools/browser/' + FAKE_BROWSER_ID)
        : plan.wsUrl
      return { ok: true, headers: { get: () => null }, body: bodyOfJson({ webSocketDebuggerUrl: wsUrl }) }
    }
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url
        this.readyState = 0
        this.sent = []
        state.sockets.push(this)
        queueMicrotask(() => { this.readyState = 1; if (this.onopen) this.onopen({}) })
      }
      send(text) {
        const msg = JSON.parse(text)
        state.methods.push(msg.method)
        this.sent.push(msg)
        const answer = plan.answer ? plan.answer(msg) : null
        const self = this
        queueMicrotask(() => {
          if (!answer || !self.onmessage) return
          self.onmessage({ data: JSON.stringify(Object.assign({ id: msg.id }, answer)) })
        })
      }
      close() { this.readyState = 3 }
    }
    plan = setup(state) || {}
    return await fn(state)
  } finally {
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWs
  }
}

/**
 * A DevTools endpoint that is not a browser, for the *reader* itself: it records every URL it is
 * asked for, in order, and every socket that gets opened. Round 18 is about exactly that order —
 * a page must not be touched before the browser on the port has been identified — so the two
 * recordings are the assertions.
 *
 *   routes.version: 'silent' (nothing listens) | { wsUrl }
 *   routes.list:    'silent' | [] (no page at all) | [ target, … ]
 *   routes.replies: { methodName: payload } — answers for the page socket
 */
async function withCountingEndpoint(routes, fn) {
  const realFetch = globalThis.fetch
  const realWs = globalThis.WebSocket
  const seen = { urls: [], sockets: [], methods: [] }
  const answer = (value) => ({ ok: true, status: 200, headers: { get: () => null }, body: bodyOfJson(value) })
  try {
    globalThis.fetch = async (url) => {
      const text = String(url)
      seen.urls.push(text)
      const kind = text.indexOf('/json/version') !== -1 ? 'version' : (text.indexOf('/json/list') !== -1 ? 'list' : 'other')
      const plan = routes[kind]
      if (plan === undefined || plan === 'silent') throw new Error('connect ECONNREFUSED 127.0.0.1:9333')
      return answer(kind === 'version' ? { webSocketDebuggerUrl: plan.wsUrl } : plan)
    }
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url
        this.readyState = 0
        seen.sockets.push(url)
        queueMicrotask(() => { this.readyState = 1; if (this.onopen) this.onopen({}) })
      }
      send(text) {
        const msg = JSON.parse(text)
        seen.methods.push(msg.method)
        const reply = (routes.replies || {})[msg.method]
        const self = this
        queueMicrotask(() => {
          if (reply === undefined || !self.onmessage) return
          self.onmessage({ data: JSON.stringify(Object.assign({ id: msg.id }, reply)) })
        })
      }
      close() { this.readyState = 3 }
    }
    const out = await fn(seen)
    return out
  } finally {
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWs
  }
}

/** The path of every DevTools URL the reader asked for, in order (`/json/version`, `/json/list`, …). */
const askedPaths = (seen) => seen.urls.map((u) => u.replace(/^.*?(\/json\/\w+).*$/, '$1'))

const DEVTOOLS_WS = 'ws://127.0.0.1:9333/devtools/browser/' + FAKE_BROWSER_ID

/** 生产的 carrierDefaults 要 apply 之后才挂上；照真实宿主的方式拿它。 */
async function productionCarrierDefaults() {
  const { ctx } = hostShellCtx()
  const entry = await import('../lib/index.js?t=' + Date.now() + '-' + Math.random())
  await entry.apply(ctx)
  return entry.carrierDefaults
}

/** 生产的 hiddenTarget 要 apply 之后才挂到 carrierDefaults 上；照真实宿主的方式拿它。 */
async function productionHiddenTarget() {
  const carrierDefaults = await productionCarrierDefaults()
  assert.equal(typeof carrierDefaults.hiddenTarget, 'function', '宿主 apply 之后这个依赖才存在')
  return carrierDefaults.hiddenTarget
}

// 读的那一步从前是「先读页面清单 → 挑一个目标 → 挑不到就 no-target → 最后才认身份」。而没有窗口
// 那台是停在 about:blank 上等会话交进来的（sessionRestore 先恢复 cookie 再 navigate），于是**每一次
// 冷启动**都被读成「端口上没有可读的页面」，run 在握手之前就死了（2026-10-05 第十八轮，真机
// deps.timer.sleep 那次崩溃之后暴露的第二处）。顺序必须是：先认身份，再谈页面。
test('the production reader identifies a cold browser before it asks for any page', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const out = await withCountingEndpoint(
    {
      version: { wsUrl: DEVTOOLS_WS },
      list: [{ id: 'page-1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/page-1' }],
      replies: { 'Network.enable': { result: {} }, 'Network.getAllCookies': { result: { cookies: [] } } },
    },
    async (seen) => ({ probe: await carrierDefaults.cdp({ port: 9333, timeoutMs: 2000, probeOnly: true }), seen }),
  )
  assert.equal(out.probe.ok, true, '一台只有 about:blank 的浏览器也是一台浏览器')
  assert.equal(out.probe.browserId, FAKE_BROWSER_ID, '身份来自 /json/version，跟有没有站点页面无关')
  assert.deepEqual(askedPaths(out.seen), ['/json/version'], '只问了一个问题，而且正是身份那个')
  assert.equal(out.seen.sockets.length, 0, '探测不开页面 socket，更不读 cookie')
})

test('a read refuses to touch a browser that is not the instance this run started', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const out = await withCountingEndpoint(
    {
      version: { wsUrl: DEVTOOLS_WS },
      list: [{ id: 'page-1', type: 'page', url: 'https://madmodel.cs.tsinghua.edu.cn/', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/page-1' }],
      replies: { 'Network.enable': { result: {} }, 'Network.getAllCookies': { result: { cookies: [] } } },
    },
    async (seen) => ({
      read: await carrierDefaults.cdp({ port: 9333, timeoutMs: 2000, probePage: true, uuid: 'ffffffff-1111-2222-3333-444444444444' }),
      seen,
    }),
  )
  assert.equal(out.read.ok, false, '端口上换了人，就一个字节都不许读')
  assert.equal(out.read.reason, 'not-ours')
  assert.equal(out.read.browserId, FAKE_BROWSER_ID, '它报出实际是谁，而不是假装读到了')
  assert.deepEqual(askedPaths(out.seen), ['/json/version'], '连页面清单都没问')
  assert.equal(out.seen.sockets.length, 0, '一个 socket 都没开：没读页面，也没读 cookie')
})

test('a port that cannot name itself is refused by name, not turned into "no target"', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const out = await withCountingEndpoint(
    // 应答了，但那个调试端面不是本机同端口 —— 身份无从证明，也就不许往下走。
    { version: { wsUrl: 'ws://10.0.0.9:9333/devtools/browser/' + FAKE_BROWSER_ID }, list: [] },
    async (seen) => ({
      probe: await carrierDefaults.cdp({ port: 9333, timeoutMs: 300, probeOnly: true }),
      read: await carrierDefaults.cdp({ port: 9333, timeoutMs: 300, probePage: true, uuid: FAKE_BROWSER_ID }),
      seen,
    }),
  )
  assert.equal(out.probe.ok, false)
  assert.equal(out.probe.running, true, '端口上确实有东西在应答，这一点要说清楚')
  assert.equal(out.probe.reason, 'no-instance-id', '失败要有名有姓，不能混成「没有目标」')
  assert.equal(out.probe.browserId, '')
  assert.equal(out.read.reason, 'no-instance-id', '读取被同一个具名理由挡下')
  assert.equal(out.seen.sockets.length, 0)
  assert.deepEqual(askedPaths(out.seen), ['/json/version', '/json/version'], '被拒的两次都只问了身份')
})

test('a cold about:blank page is read once the instance on the port is known', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const out = await withCountingEndpoint(
    {
      version: { wsUrl: DEVTOOLS_WS },
      list: [{ id: 'page-1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/page-1' }],
      replies: {
        'Network.enable': { result: {} },
        'Network.getAllCookies': {
          result: { cookies: [{ name: 'JSESSIONID', value: 'FIXTURE-ONLY', domain: '.tsinghua.edu.cn', path: '/', secure: true, httpOnly: true }] },
        },
        'Runtime.evaluate': { result: { result: { value: JSON.stringify({ token: '', url: 'about:blank' }) } } },
      },
    },
    async (seen) => ({
      read: await carrierDefaults.cdp({ port: 9333, timeoutMs: 2000, probePage: false, uuid: FAKE_BROWSER_ID }),
      seen,
    }),
  )
  assert.equal(out.read.ok, true, '身份对得上，就该读到那张空白页（会话恢复正发生在它上面）')
  assert.equal(out.read.url, 'about:blank')
  assert.equal(out.read.browserId, FAKE_BROWSER_ID)
  assert.equal(out.read.cookies.length, 1)
  assert.equal(out.read.cookies[0].name, 'JSESSIONID')
  assert.deepEqual(askedPaths(out.seen), ['/json/version', '/json/list'], '先验身份，再问页面')
  assert.ok(out.seen.methods.indexOf('Network.getAllCookies') !== -1)
})

test('the hidden carrier answers to the same identity rule, and a mismatch costs no request', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const handle = {
    targetId: 'hidden-1',
    browserId: FAKE_BROWSER_ID,
    send: async () => ({ result: {} }),
  }
  const out = await withCountingEndpoint(
    { version: { wsUrl: DEVTOOLS_WS }, list: [] },
    async (seen) => ({
      read: await carrierDefaults.cdp({
        port: 9333, timeoutMs: 500, hidden: handle, probePage: false,
        uuid: 'ffffffff-1111-2222-3333-444444444444',
      }),
      seen,
    }),
  )
  assert.equal(out.read.ok, false)
  assert.equal(out.read.reason, 'not-ours')
  assert.equal(out.read.browserId, FAKE_BROWSER_ID)
  assert.deepEqual(out.seen.urls, [], '句柄自带身份，连 /json/version 都不用问')
  assert.equal(out.seen.methods.length, 0)
})

// 第十八轮审计（2026-10-05）：身份这道闸不许有例外。此前 `uuid: ''` 时读取器跳过身份问题、直接去
// 问 /json/list —— 一个没说自己是谁的读，最后读的是端口上碰巧那一台。下面三条都拿真计数端点数：
// 零 /json/list、零页面 socket、零 Runtime/Cookie 读。
test('a page read with no identity of its own is refused before it asks anything', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const SITE_URL = 'https://madmodel.cs.tsinghua.edu.cn/model-api/x'
  const SITE_PAGE = [{ id: 'p1', type: 'page', url: SITE_URL, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/p1' }]
  const replies = {
    'Network.enable': { result: {} },
    'Network.getAllCookies': { result: { cookies: [{ name: 'JSESSIONID', value: 'FIXTURE-ONLY', domain: '.tsinghua.edu.cn', path: '/' }] } },
    'Runtime.evaluate': { result: { result: { value: JSON.stringify({ token: '', url: SITE_URL }) } } },
  }

  // ① 不带 uuid 的页面读：连 /json/version 都不问 —— 没有身份，就没有一个可接受的答案。
  const bare = await withCountingEndpoint({ version: { wsUrl: DEVTOOLS_WS }, list: SITE_PAGE, replies }, async (seen) => ({
    read: await carrierDefaults.cdp({ port: 9333, timeoutMs: 1200, probePage: false }),
    seen,
  }))
  assert.equal(bare.read.ok, false)
  assert.equal(bare.read.reason, 'no-ownership-evidence', '没说自己是谁 ⇒ 具名拒读，不是"读读看"')
  assert.deepEqual(bare.seen.urls, [], '一个请求都不发')
  assert.equal(bare.seen.sockets.length, 0)
  assert.equal(bare.seen.methods.length, 0)

  // ② 身份说了，但端口答不出自己的身份（页面清单本来是答得出来的）：一样拒读，一次 /json/list 都没有。
  const mute = await withCountingEndpoint({ version: 'silent', list: SITE_PAGE, replies }, async (seen) => ({
    read: await carrierDefaults.cdp({ port: 9333, timeoutMs: 400, probePage: false, uuid: FAKE_BROWSER_ID }),
    seen,
  }))
  assert.equal(mute.read.ok, false)
  assert.equal(mute.read.reason, 'no-devtools')
  assert.equal(mute.read.running, false)
  assert.ok(askedPaths(mute.seen).every((p) => p === '/json/version'), '身份没答上来就不许问页面')
  assert.equal(mute.seen.sockets.length, 0)

  // ③ 隐藏页句柄既没有 uuid、也没有自带身份：拒读，而且不碰那条连接上的任何命令（更不关它）。
  const blind = { targetId: 'h-blind', closed: 0, send: async () => { throw new Error('不该被调用') }, close() { blind.closed += 1; return { closed: true } } }
  const hidden = await withCountingEndpoint({ version: { wsUrl: DEVTOOLS_WS }, list: SITE_PAGE, replies }, async (seen) => ({
    read: await carrierDefaults.cdp({ port: 9333, timeoutMs: 500, hidden: blind, probePage: false }),
    seen,
  }))
  assert.equal(hidden.read.ok, false)
  assert.equal(hidden.read.reason, 'no-ownership-evidence')
  assert.deepEqual(hidden.seen.urls, [])
  assert.equal(hidden.seen.methods.length, 0)
  assert.equal(blind.closed, 0)
})

// 真机读数（2026-10-05 第十八轮冷启动探针）：新 profile 的 Edge 会自己开一个
// `edge://sync-confirmation-dialog/`，而且它排在页面清单**最前面**。它和我们的站点页一样打 0 分，
// 于是「没有站点页就退回第一个页面目标」会把浏览器内部页当成站点读回来 —— 那不是页面，是浏览器的
// 界面。能读的只有真实 http(s) 页与 about:blank（会话交接要 navigate 的那一页）。
test('a browser-internal page is not a page to read, and the blank one is the fallback', async () => {
  const carrierDefaults = await productionCarrierDefaults()
  const page = (id, url) => ({ id, type: 'page', url, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/' + id })
  const repliesFor = (url) => ({
    'Network.enable': { result: {} },
    'Network.getAllCookies': { result: { cookies: [] } },
    'Runtime.evaluate': { result: { result: { value: JSON.stringify({ token: '', url }) } } },
  })
  const LOCAL_PAGE = 'http://127.0.0.1:9483/authLogin'
  const options = { port: 9333, timeoutMs: 1200, probePage: false, uuid: FAKE_BROWSER_ID }

  const mixed = await withCountingEndpoint(
    {
      version: { wsUrl: DEVTOOLS_WS },
      list: [page('dialog', 'edge://sync-confirmation-dialog/'), page('local', LOCAL_PAGE)],
      replies: repliesFor(LOCAL_PAGE),
    },
    async (seen) => ({ read: await carrierDefaults.cdp(options), seen }),
  )
  assert.equal(mixed.read.ok, true)
  assert.equal(mixed.read.url, LOCAL_PAGE)
  assert.deepEqual(mixed.seen.sockets, ['ws://127.0.0.1:9333/devtools/page/local'],
    '读的是真实页面，不是排在前面的浏览器内部页')

  const blank = await withCountingEndpoint(
    {
      version: { wsUrl: DEVTOOLS_WS },
      list: [
        page('dialog', 'edge://sync-confirmation-dialog/'),
        page('other', 'http://127.0.0.1:9483/somewhere-else'),
        page('blank', 'about:blank'),
      ],
      replies: repliesFor('about:blank'),
    },
    async (seen) => ({ read: await carrierDefaults.cdp(options), seen }),
  )
  assert.equal(blank.read.url, 'about:blank')
  assert.deepEqual(blank.seen.sockets, ['ws://127.0.0.1:9333/devtools/page/blank'],
    '空白页才是会话交接要用的那一页，别的页面不该插队')

  const internalOnly = await withCountingEndpoint(
    {
      version: { wsUrl: DEVTOOLS_WS },
      list: [page('dialog', 'edge://sync-confirmation-dialog/'), page('ext', 'chrome://settings/')],
      replies: repliesFor(''),
    },
    async (seen) => ({ read: await carrierDefaults.cdp(options), seen }),
  )
  assert.equal(internalOnly.read.ok, false, '只有浏览器自己的界面时，不能假装读到了页面')
  assert.equal(internalOnly.read.running, true)
  assert.equal(internalOnly.read.reason, 'no-target')
  assert.equal(internalOnly.seen.sockets.length, 0, '一个页面 socket 都不许开')
  assert.deepEqual(askedPaths(internalOnly.seen), ['/json/version', '/json/list'])
})

test('perf: the production hidden-page opener waits for a real target instead of spending the request', async () => {
  const hiddenTarget = await productionHiddenTarget()
  const r = await withFakeDevtools((st) => ({
    answer(msg) {
      if (msg.method === 'Target.getTargets') return { result: { targetInfos: [] } }
      if (msg.method === 'Target.createTarget') return { error: { code: -32000, message: 'should not be asked' } }
      return null
    },
  }), async (st) => {
    const started = Date.now()
    const out = await hiddenTarget({ port: 9333, url: 'about:blank', timeoutMs: 900 })
    out.ms = Date.now() - started
    out.methods = st.methods.slice()
    out.fetchCalls = st.fetchCalls
    return out
  })
  assert.equal(r.ok, false, '没有目标就不能假装建出了隐藏页')
  assert.equal(r.reason, 'no-targets', '区分「等不到目标」与「建页被拒」')
  assert.ok(r.attempts >= 2, '在自己的时限内反复问，每次都要问到一个数（实测 attempts=' + r.attempts + '）')
  assert.equal(r.targetsSeen, 0)
  assert.equal(r.frameTargets, 0)
  // 这条就是真机 -32000 的根因：目标数为 0 时**一个建页请求都不该发**
  assert.equal(r.methods.indexOf('Target.createTarget'), -1, '目标为 0 时不许去建隐藏页')
  assert.equal(r.browserId, FAKE_BROWSER_ID, '失败也要带回这台浏览器的身份（回退时要靠它证明是自己的）')
  assert.equal(r.error, null, '没发过建页请求，就不许编一个浏览器错误码出来')
  assert.ok(r.ms < 3000, '它自己的时限说了算，不是把请求挂死（ms=' + r.ms + '）')
})

test('perf: the production hidden-page opener creates the page as soon as a target exists', async () => {
  const hiddenTarget = await productionHiddenTarget()
  const r = await withFakeDevtools(() => ({
    answer(msg) {
      if (msg.method === 'Target.getTargets') return { result: { targetInfos: [{ targetId: 'page-1', type: 'page' }] } }
      if (msg.method === 'Target.createTarget') return { result: { targetId: 'hidden-1' } }
      return null
    },
  }), async (st) => {
    const out = await hiddenTarget({ port: 9333, url: 'about:blank', timeoutMs: 900 })
    out.methods = st.methods.slice()
    out.sent = st.sockets.length ? st.sockets[0].sent.slice() : []
    return out
  })
  assert.equal(r.ok, true)
  assert.equal(r.targetId, 'hidden-1')
  assert.equal(r.attempts, 1, '目标已经在了：不等、不重试')
  assert.equal(r.targetsSeen, 1)
  assert.equal(r.frameTargets, 1, 'Chromium 数的是 frame 目标：有 page 才敢建隐藏页')
  assert.equal(r.browserId, FAKE_BROWSER_ID)
  assert.deepEqual(r.methods, ['Target.getTargets', 'Target.createTarget'])
  const created = r.sent.find((m) => m.method === 'Target.createTarget')
  assert.deepEqual(created.params, { url: 'about:blank', hidden: true, background: true })
  assert.equal(typeof r.send, 'function')
  assert.equal(typeof r.setOnEvent, 'function')
  assert.deepEqual(r.close(), { closed: true }, '句柄关一次就够')
  assert.equal(r.close().closed, false, '再关一次要说「已经关过了」，不能假装又关了一次')
})

test('perf: a browser whose targets are not frames is never asked for a hidden page', async () => {
  // Chromium 的判据是 RemoteDebuggingTargets(TargetType::kFrame) 非空：只有 worker/browser/
  // other 这类目标的浏览器，照样会被 -32000 拒。所以门要数 frame，而不是数「有几个目标」
  // （真机 22:30 那台无窗口浏览器就先报 0 个、后报 10 个——不数类型就会在 10 个非 frame
  // 目标上再撞一次 -32000）。
  const hiddenTarget = await productionHiddenTarget()
  const r = await withFakeDevtools(() => ({
    answer(msg) {
      if (msg.method === 'Target.getTargets') {
        return {
          result: {
            targetInfos: [
              { targetId: 'w-1', type: 'service_worker' },
              { targetId: 'w-2', type: 'shared_worker' },
              { targetId: 'b-1', type: 'browser' },
              { targetId: 'o-1', type: 'other' },
            ],
          },
        }
      }
      if (msg.method === 'Target.createTarget') return { error: { code: -32000, message: 'should not be asked' } }
      return null
    },
  }), async (st) => {
    const out = await hiddenTarget({ port: 9333, url: 'about:blank', timeoutMs: 700 })
    out.methods = st.methods.slice()
    return out
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-targets', '非 frame 目标不算数：说「等不到目标」，不说「建页被拒」')
  assert.equal(r.targetsSeen, 4, '读数照实带上：看得见它看到了什么')
  assert.equal(r.frameTargets, 0)
  assert.equal(r.methods.indexOf('Target.createTarget'), -1, 'frame 为 0 时不许去建隐藏页')
  assert.equal(r.error, null)
})

test('perf: the production hidden reader never closes the socket that is keeping the page alive', async () => {
  // 隐藏页的寿命绑在「创建它的那条浏览器级连接」上（round 10 真机读数：连接一断，目标就没了）。
  // 捕获臂每 2.5 s 经生产的 cdp 读一次页面——读的动作**不许**顺手关掉那条连接，否则真机上每
  // 一次读都会把页面读没，然后被误诊成 hidden-gone。这一条直接驱动生产实现
  // （carrierDefaults.cdp），不经过核心的定时器：只问"读"这一步会不会关连接。
  const carrierDefaults = await productionCarrierDefaults()
  const sent = []
  const makeHandle = () => {
    const handle = {
      targetId: 'T-1',
      browserId: FAKE_BROWSER_ID,
      closed: 0,
      send(method, params, sid) {
        sent.push({ method: method, params: params, sid: sid })
        if (method === 'Target.attachToTarget') return Promise.resolve({ result: { sessionId: 'S-1' } })
        if (method === 'Network.getAllCookies') {
          return Promise.resolve({ result: { cookies: [{ name: 'SESSION', value: 's-1', domain: '.tsinghua.edu.cn', path: '/', secure: true, httpOnly: true, expires: -1, session: true }] } })
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { result: { value: JSON.stringify({ token: 'T-1', url: 'https://madmodel.cs.tsinghua.edu.cn/model-api/x' }) } } })
        }
        return Promise.resolve({ result: {} })
      },
      close() { handle.closed += 1; return { closed: true, via: 'socket' } },
    }
    return handle
  }

  const handle = makeHandle()
  // 读之前先问端口"你是谁"（round-18 审计：认不出身份的读一律拒读）——隐藏页载体也照此办，
  // 而它认身份只需 /json/version，从不问页面清单。
  const out = await withCountingEndpoint({ version: { wsUrl: DEVTOOLS_WS } }, async (seen) => {
    const read = await carrierDefaults.cdp({ port: 9333, hidden: handle, probePage: false })
    assert.deepEqual(askedPaths(seen), ['/json/version'], '隐藏页载体也不问页面清单')
    return read
  })
  assert.equal(out.ok, true)
  assert.equal(out.hidden, true, '这一页是从那条连接上读的，走同一个 readCdpPage')
  assert.equal(out.token, 'T-1', '页面上的令牌照读不误')
  assert.equal(out.cookies.length, 1, 'cookie 也照读（过滤后剩 1 条）')
  assert.equal(handle.closed, 0, '读一次页面不等于关掉载体：创建它的那条连接要留到收尾')
  const attach = sent.find((m) => m.method === 'Target.attachToTarget')
  assert.equal(attach.params.flatten, true, '之后的每条命令都要带 sessionId，attach 就得 flatten')
  assert.equal(attach.params.targetId, 'T-1')
  const evals = sent.filter((m) => m.method === 'Runtime.evaluate')
  assert.ok(evals.length >= 1, '页面是被读过的，不是猜的')
  for (const e of evals) assert.equal(e.sid, 'S-1', '读页面用的是一条会话，不是在浏览器级连接上瞎猜')

  // 页面已经没了（连接一断，target 就跟着没了）：报 hidden-gone —— 而且仍然不是"读的人"去关连接。
  const dead = makeHandle()
  dead.send = (method) => Promise.resolve(method === 'Target.attachToTarget'
    ? { error: { code: -32001, message: 'Session with given id not found.' } }
    : { result: {} })
  const gone = await withCountingEndpoint({ version: { wsUrl: DEVTOOLS_WS } }, () => carrierDefaults.cdp({ port: 9333, hidden: dead, probePage: false }))
  assert.equal(gone.ok, false)
  assert.equal(gone.reason, 'hidden-gone', '读不出来是页面没了，不是读的人把它关了')
  assert.match(String(gone.error), /Session with given id not found/)
  assert.equal(dead.closed, 0, '这条连接的生死由收尾决定，不由读决定')
})

test('perf: no DevTools port means no-devtools, and no socket is opened', async () => {
  const hiddenTarget = await productionHiddenTarget()
  const r = await withFakeDevtools(() => ({ fetchFails: true }), async (st) => {
    const out = await hiddenTarget({ port: 9333, url: 'about:blank', timeoutMs: 700 })
    out.methods = st.methods.slice()
    out.fetchCalls = st.fetchCalls
    out.sockets = st.sockets.length
    return out
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-devtools', '端口不说话就说端口，不是别的失败')
  assert.equal(r.sockets, 0, '连不上就别开 WebSocket')
  assert.equal(r.methods.length, 0)
  assert.ok(r.fetchCalls >= 2, '在时限内反复问过（fetchCalls=' + r.fetchCalls + '）')
})

test('perf: a leftover we can prove closed is given up first, and only then is a browser spent', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const exp2 = exp1 + 5 * 3600
  const leftover = 'uuid-leftover-3'
  const born = 'uuid-born-3'
  const renewed = jwtWith(exp2)
  const attempts = []
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000,
      browserUuid: leftover, browserPort: 9333, browserPid: 4321, browserMine: true,
    },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
    // 端口上先是我们上一次运行留下的自有浏览器（身份对得上）：确证关掉之后端口空了，这一轮才
    // 起自己那台。顺序就是这条用例的重点——先自证关掉，再谈新载体。
    cdp: async (arg) => {
      if (arg.probeOnly) {
        if (!rt.spawns.length && !attempts.length) return { ok: true, running: true, browserId: leftover }
        if (!rt.spawns.length) return { ok: false, running: false }
        return { ok: true, running: true, browserId: born }
      }
      return { ok: true, running: true, token: renewed, url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: ssoJar, browserId: born }
    },
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: true, via: 'cdp', verified: true } },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(attempts.length, 1, 'the leftover is closed first, by the identity it answered with')
  assert.equal(attempts[0].uuid, leftover)
  assert.equal(attempts[0].port, 9333)
  assert.equal(attempts[0].reason, 'leftover-own')
  assert.equal(rt.spawns.length, 1, 'then — and only then — this run starts a browser of its own')
  assert.ok(rt.spawns[0].argv.indexOf('--headless=new') !== -1)
  assert.equal(click.loginOpened, 'headless')
  assert.equal(click.carrier, 'headless')
  assert.equal(click.carrierNote, '', 'no fallback happened, so none is claimed')
  assert.equal(click.browserOpen, true, 'the carrier that was started is the one being watched')

  await rt.timers.find((t) => t.ms === 2500).fn()
  assert.equal(rt.credential, renewed, 'the carrier that ran really renews')
  assert.equal(jwtExpiry(rt.credential), exp2 * 1000, 'and the expiry strictly advanced')
  assert.equal(attempts.length, 2)
  assert.equal(attempts[1].reason, 'captured', 'the run closes what it started, with its own identity')
  assert.equal(attempts[1].uuid, born)
})

test('perf: the identity of a leftover we could not close is kept, so the next run can try again', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const leftover = 'uuid-leftover-4'
  const born = 'uuid-9334-4'
  let leftoverPageReads = 0
  const attempts = []
  const http = ({ url }) => {
    if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
    if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
    if (url.endsWith('/model-api/auth-login')) return authOk()
    return { status: 500, ok: false, location: '', text: '' }
  }
  const cdp = async (arg) => {
    if (arg.probeOnly) {
      if (arg.port === 9333) return { ok: true, running: true, browserId: leftover }
      return { ok: false, running: false }
    }
    // 只有 9333 上那台的页面算"读别人的页面"；9334 是本次自己起的，读它是本分。
    if (arg.port === 9333) leftoverPageReads += 1
    return { ok: true, running: true, token: '', url: 'https://id.tsinghua.edu.cn/', cookies: ssoJar, browserId: arg.port === 9333 ? leftover : born }
  }
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000,
      browserUuid: leftover, browserPort: 9333, browserMine: false,
    },
    http,
    // browserMine 是 false（宿主刚重启，这个字段来自上一次运行）：它不许当门闩 —— 身份对得上
    // 就该再关一次，否则上一轮留下的那台永远关不掉（真机 2026-10-05：PID 7560 活了一整夜，
    // 之后每一次 Auto 都撞在它身上）。
    cdp,
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: false, reason: 'still-running' } },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(leftoverPageReads, 0, '在没有确证关掉它之前，它的页面一个字都不读')
  assert.equal(rt.spawns.length, 1, '本次自己的载体照起，但不在同一条端口、也不在同一个 profile 上')
  assert.equal(rt.spawns[0].argv.find((a) => a.indexOf('--remote-debugging-port=') === 0), '--remote-debugging-port=9334')
  assert.equal(
    rt.spawns[0].argv.find((a) => a.indexOf('--user-data-dir=') === 0).slice('--user-data-dir='.length).indexOf('C:\\Users\\test\\.dsh\\madmodel\\run-'),
    0,
    '同一个 profile 上也不许再起一台',
  )
  assert.ok(attempts.length >= 1, '试过按身份关它')
  for (const a of attempts) {
    assert.equal(a.uuid, leftover, 'browserMine=false 也要按身份去关——身份才是证据')
    assert.equal(a.reason, 'leftover-own')
  }
  assert.equal(click.loginOpened, 'headless', '点击被服务了，而不是死在"先去手动关一台浏览器"上')
  // 这条用例的命门：关不掉之后若把身份清掉，下一次运行就只能说「端口上有台不认识的浏览器」，
  // 再也关不掉它（旧代码就是这样把 leftover 变成永久住户的）。browserUuid 现在记的是"我正在
  // 驱动哪一台"（本次新起的那台），所以证据必须另有一个字段：portLeftover。
  const saved = rt.saves[rt.saves.length - 1]
  assert.equal(saved.portLeftover.id, leftover, '关不掉的证据要写进盘里：下一次运行还得靠它认亲')
  assert.equal(saved.portLeftover.port, 9333)
  assert.equal(saved.portLeftover.pid, 0, '没能证明已死的 pid 不许当成我们的带下去')
  assert.equal(saved.portLeftover.why, 'still-running', '连它当时给的理由一起留着')
  assert.equal(saved.owned.port, 9334, 'lease 描述的是本次真正在驱动的那台')

  // 下一次运行（宿主又重启了一次：lease 已退休、内存里的 browserUuid 也没了，盘上只剩这条证据）：
  // 它必须还能认出 9333 上那台并再试一次。
  const attempts2 = []
  const rt2 = createRuntime({
    clockNow: () => now,
    credential: jwtWith(exp1),
    stateData: { ...saved, owned: null, browserUuid: '', browserPort: 0, browserMine: false, browserOpen: false, loginWait: false, lastGetAt: 0 },
    http,
    cdp,
    closeBrowser: async (arg) => { attempts2.push(arg); return { closed: false, reason: 'still-running' } },
  })
  await rt2.core.init()
  const click2 = await rt2.core.getTok()
  assert.ok(attempts2.some((a) => a.uuid === leftover), '第二次运行仍然按身份去关它，而不是把它当陌生人放过')
  for (const a of attempts2) {
    assert.equal(a.uuid, leftover, '按身份关，不按盘上残留的旧字段关')
    assert.equal(a.pid, 0, 'lease 已经没了，那个 pid 就没有证据，不许交给 closer')
  }
  assert.equal(click2.loginOpened, 'headless')
})

test('perf: a browser on our debug port that we cannot prove is ours is never adopted', async () => {
  const now = 1791108083039
  const born = 'uuid-9334-stranger-test'
  let strangerPageReads = 0
  const rt = createRuntime({
    clockNow: () => now,
    credential: jwtWith(Math.floor(now / 1000) + 6 * 3600),
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      return { status: 401, ok: false, location: '', text: '' }
    },
    hiddenTarget: async () => ({ ok: false, reason: 'no-devtools' }),
    cdp: async (arg) => {
      if (arg.probeOnly) {
        if (arg.port === 9333) return { ok: true, running: true, url: '', browserId: 'uuid-stranger' }
        return { ok: false, running: false }
      }
      if (arg.port === 9333) strangerPageReads += 1
      return { ok: true, running: true, token: '', url: 'https://id.tsinghua.edu.cn/', cookies: ssoJar, browserId: born }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  // 2026-10-05 round 17：陌生实例不再是"整次失败、请用户先去关一台浏览器"的死路。它一个字都不许读、
  // 一次 close 都不许发，但本次运行必须换一条端口、换一个自己的临时 profile 把活干完。
  assert.equal(strangerPageReads, 0, '没有身份证据就不许读它的页面')
  assert.equal(rt.closes.length, 0, '不认识的东西，一次也不许去关')
  assert.equal(rt.closesSync.length, 0, '同步路径同样不许去关')
  assert.equal(rt.spawns.length, 1, '本次自己的载体照起，但不在它的端口上')
  assert.equal(rt.spawns[0].argv.find((a) => a.indexOf('--remote-debugging-port=') === 0), '--remote-debugging-port=9334')
  assert.equal(
    rt.spawns[0].argv.find((a) => a.indexOf('--user-data-dir=') === 0).slice('--user-data-dir='.length).indexOf('C:\\Users\\test\\.dsh\\madmodel\\run-'),
    0,
    '端口上有陌生人时，共享 profile 也不能用（同 profile 起出来的还是它的地盘）',
  )
  assert.equal(click.loginOpened, 'headless', '点击被服务了，而不是死在"先去手动关一台浏览器"上')
  assert.equal(click.carrier, 'headless')
  assert.equal(click.browserOpen, true)
  const snap = await rt.core.state()
  assert.equal(snap.portStrangers, 1, '陌生人要计数，读数里看得见')
  assert.equal(snap.carrierPort, 9334, '本次用的是哪条端口，读数里也要有')
  assert.equal(snap.carrierProfile, 'isolated')
  assert.match(String(snap.portNote), /9333/, '要把端口号说出来（9333-9343 里命中的是哪个）')
  assert.match(String(snap.portNote), /别的浏览器/, '说清端口上那台不是本插件的')
  assert.match(String(snap.portNote), /没有读也没有动它/, '说清本插件既没读它、也没动它')
  assert.match(String(snap.portNote), /9334/, '说清本次换到了哪条端口')
  assert.ok(!/先手动关掉那台浏览器/.test(String(snap.err)), '不给用户"先去手动关一台浏览器"的死路')
  assert.ok(!/重试不会变/.test(String(snap.err)), '换端口之后，重试是会变的')
  const saved = rt.saves[rt.saves.length - 1]
  assert.equal(saved.portStrangers, 1)
  assert.equal(saved.carrierProfile, 'isolated')
  assert.equal(saved.owned.port, 9334)
  assert.notEqual(saved.owned.profile, LEASE_PROFILE, 'lease 记的是本次真正用的那个 profile')
})

test('perf: reusing the stored token is not an advanced expiry', async () => {
  const exp = Math.floor(1791108083039 / 1000) + 6 * 3600
  const token = jwtWith(exp)
  // 梯子上没有一级能给出更长的寿命：mint（无 ticket 的 check）被拒、SSO 只给登录表单，
  // 而手里这个令牌服务端仍然认（auth-login 说话）⇒ 只剩复用这一条路。
  const rt = createRuntime({
    clockNow: () => 1791108083039,
    credential: token,
    stateData: { lastGetAt: 0, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp * 1000 },
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_LOGIN_FORM)
      if (url.endsWith('/model-api/auth-login/check')) return { status: 401, ok: false, location: '', text: '' }
      if (url.endsWith('/model-api/auth-login')) return authOk()
      return { status: 500, ok: false, location: '', text: '' }
    },
  })
  await rt.core.init()
  const snap = await rt.core.autoTick()
  assert.equal(snap.via, 'reuse', '这一轮只有复用可走（via=' + snap.via + '）')
  assert.equal(snap.fresh, false, '同一个令牌不算新令牌')
  assert.equal(snap.expiryAdvanced, false, '复用了旧令牌却报「到期时间前进」就是真机那个错字段')
  assert.equal(snap.renewalNoProgress, false, '复用是「没有续期」，不是「续期失败」')
  assert.equal(snap.status, 'ok', '令牌还有效，模子该是绿的')
  assert.equal(rt.stateData.tokenExpAt, exp * 1000, '复用的令牌不改进到期时间')
  assert.doesNotMatch(String(snap.err), /没有前进|未前进/, '复用不该被说成「续期未生效」')
  assert.equal(rt.spawns.length, 0, '后台这一次连浏览器都不该起')
  assert.equal(snap.loginOpened, 'none', '后台永远不开窗')
})

// --- 2026-10-05 round 14, requirement A: the owned lease ---------------------------------
//
// Four fields that lived only in memory were never enough evidence to close a leftover: the
// host exit path, a reload and the stop script all work in *other* processes, and a close that
// could not be confirmed used to erase the only thing that could recognise the browser. The
// lease is that evidence — what was spawned, when, on which port, under which private profile,
// with which instance id — and it is retired only by a close that is proven.

// A click that ends with a browser of ours running: the ladder can only replay the SSO chain
// (the device fingerprint page is as far as pure HTTP gets), so the click is offered the
// no-window carrier and one is started. The cdp probe keys on `spawns.length`, so the identity
// is answered as soon as a browser exists — the same order production sees.
function ownedRun(options = {}) {
  const now = options.now === undefined ? 1791108083039 : options.now
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const born = options.born || 'uuid-lease-1'
  let rt = null
  rt = createRuntime({
    clockNow: () => now,
    credential: options.credential === undefined ? jwtWith(exp1) : options.credential,
    stateData: options.stateData || {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000,
    },
    http({ url }) {
      const custom = options.http && options.http({ url })
      if (custom !== undefined) return custom
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_FINGERPRINT_FORM)
      // Everything else keeps the file's own defaults: the bare check is refused (anonymous
      // issuance is closed on the live site), auth-login accepts the token we hold.
      return undefined
    },
    cdp: options.cdp || (async (arg) => {
      if (arg.probeOnly) {
        return rt.spawns.length
          ? { ok: true, running: true, browserId: born }
          : { ok: false, running: false }
      }
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [], browserId: born }
    }),
    ...(options.closeBrowser ? { closeBrowser: options.closeBrowser } : {}),
    ...(options.sessionRestore ? { sessionRestore: options.sessionRestore } : {}),
    ...(options.listBrowserProfiles ? { listBrowserProfiles: options.listBrowserProfiles } : {}),
    ...(options.listStateDir ? { listStateDir: options.listStateDir } : {}),
    ...(options.closeBrowserSync ? { closeBrowserSync: options.closeBrowserSync } : {}),
    ...(options.closeBudgetMs ? { closeBudgetMs: options.closeBudgetMs } : {}),
    ...(options.timerInterval ? { timerInterval: options.timerInterval } : {}),
  })
  return rt
}

const LEASE_PROFILE = 'C:\\Users\\test\\.dsh\\madmodel\\profile'

test('a spawn writes an owned lease, so a later process can close what this one started', async () => {
  const rt = ownedRun()
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless', '这一次点击该拿到无窗口载体（' + String(click.err) + '）')
  assert.equal(rt.spawns.length, 1)

  const saved = rt.saves[rt.saves.length - 1]
  assert.ok(saved.owned, '浏览器还活着的时候，lease 就已经在盘上了')
  assert.equal(saved.owned.port, 9333, '端口是认亲的一半')
  assert.equal(saved.owned.pid, 4321, '本次 spawn 的 pid 是另一半（端点哑掉时只能靠进程表）')
  assert.equal(saved.owned.profile, LEASE_PROFILE, '专属 profile 目录才是把一棵进程树圈住的东西')
  assert.equal(saved.owned.exe, rt.spawns[0].exe, 'exe 一起记下：同名的陌生浏览器不许被牵连')
  assert.equal(saved.owned.spawnedAt, 1791108083039, '我们启动它的时刻（pid 被回收时必须靠这个否掉）')
  assert.match(String(saved.owned.spawnId), /^spawn-/, '这一次 spawn 的自有记号')
  assert.equal(saved.owned.uuid, 'uuid-lease-1', '实例自己答出来的身份——学到就落盘')

  const snap = await rt.core.state()
  assert.deepEqual(Object.keys(snap.owned).sort(), ['hasUuid', 'port', 'spawnId', 'spawnedAt'], '面板/接口看到的是读数，不是路径与 pid')
  assert.equal(snap.owned.port, 9333)
  assert.equal(snap.owned.hasUuid, true)
  assert.equal(snap.reap, null, '启动时没有遗留可收，就不该报一次收尾')
})

test('a host exit that cannot be confirmed keeps the lease instead of forgetting the browser', async () => {
  const attempts = []
  const rt = ownedRun({
    closeBrowserSync: (arg) => { attempts.push(arg); return { closed: false, reason: 'still-running' } },
  })
  await rt.core.init()
  await rt.core.getTok()
  assert.equal(rt.spawns.length, 1)

  const verdict = rt.core.dispose()
  assert.equal(verdict.closed, false, 'host 退出不 await，判词必须在返回时就定下')
  assert.equal(verdict.reason, 'still-running')
  assert.equal(attempts.length, 1, '同步这条路才是 host 退出走的路')
  assert.equal(attempts[0].reason, 'dispose')
  assert.equal(attempts[0].port, 9333, '带端口')
  assert.equal(attempts[0].pid, 4321, '带 pid（端点哑掉时的退路）')
  assert.equal(attempts[0].uuid, 'uuid-lease-1', '带实例身份，不只带端口')
  assert.equal(attempts[0].owned.profile, LEASE_PROFILE, '带上整份 lease：它才是进程表的判据')

  const snap = await rt.core.state()
  assert.ok(snap.owned, '没能确证关闭，证据就不许消失')
  assert.equal(snap.owned.port, 9333)
  assert.match(String(snap.err), /未能确认关闭/, '面板要照实说')
  assert.equal(rt.stateData.owned.port, 9333, '盘上也得留着——下一个进程才用得上它')
})

test('a reload takes charge of the browser its own lease names, and retires the lease only when the close is proven', async () => {
  const now = 1791108083039
  const leftover = 'uuid-leftover-lease'
  const attempts = []
  let pageReads = 0
  const rt = ownedRun({
    now,
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: (Math.floor(now / 1000) + 6 * 3600) * 1000,
      owned: {
        spawnId: 'spawn-left-1', uuid: leftover, port: 9333, pid: 4321, spawnedAt: now - 60e3,
        profile: LEASE_PROFILE, exe: 'C:\\edge.exe',
      },
    },
    cdp: async (arg) => {
      if (arg.probeOnly) return { ok: true, running: true, browserId: leftover }
      pageReads += 1
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [], browserId: leftover }
    },
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: true, via: 'cdp', verified: true } },
  })
  await rt.core.init()

  assert.equal(attempts.length, 1, '重载要先接管上一个进程留下的东西')
  assert.equal(attempts[0].reason, 'startup', '理由就是「启动时收尾」')
  assert.equal(attempts[0].port, 9333)
  assert.equal(attempts[0].pid, 4321, 'pid 一起带上：端点不应答时进程表还要用它')
  assert.equal(attempts[0].uuid, leftover)
  assert.equal(attempts[0].owned.spawnId, 'spawn-left-1', '整份 lease 跟着这次关闭一起走')
  assert.equal(pageReads, 0, '收尾不是读它的页面')

  const snap = await rt.core.state()
  assert.equal(snap.owned, null, '确证关掉了，lease 才退休')
  assert.equal(snap.reap.reason, 'startup')
  assert.equal(snap.reap.closed, true)
  assert.equal(snap.reap.port, 9333)
  assert.equal(snap.reap.via, 'cdp')
  assert.equal(rt.stateData.owned, null, '盘上也要退休，否则下一次重载还会去找一台已经没了的浏览器')
})

test('a stranger where our lease points is named and left alone, and the lease is kept', async () => {
  const now = 1791108083039
  const attempts = []
  const rt = ownedRun({
    now,
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: (Math.floor(now / 1000) + 6 * 3600) * 1000,
      owned: {
        spawnId: 'spawn-left-2', uuid: 'uuid-ours-gone', port: 9333, pid: 4321, spawnedAt: now - 60e3,
        profile: LEASE_PROFILE, exe: 'C:\\edge.exe',
      },
    },
    closeBrowser: async (arg) => { attempts.push(arg); return { closed: false, reason: 'not-ours', sawInstanceId: 'uuid-stranger' } },
  })
  await rt.core.init()

  assert.equal(attempts.length, 1, '试一次「按 lease 去关」是允许的——判据在 closer 手里')
  assert.equal(attempts[0].owned.uuid, 'uuid-ours-gone', '问的是「我记录的那台还在吗」')
  const snap = await rt.core.state()
  assert.equal(snap.reap.closed, false)
  assert.equal(snap.reap.why, 'not-ours', '答案要说清是「不是我们的」而不是「关不掉」')
  // 2026-10-05 round 17: 别人占着这条端口，不是"用户得先去手动关一台浏览器"的理由 —— 它是一条
  // 读数（下一次点击会自己换端口绕过去），而不是一个挡住整条链的 loginReason。原来这里断言的是
  // loginReason==='port-not-ours'，那正是真机上那句死路的来源。
  assert.equal(snap.loginReason, '', '不再把它记成阻断性的登录原因')
  assert.match(String(snap.portNote), /9333/, '把端口号说出来')
  assert.match(String(snap.portNote), /别的浏览器/, '说清端口上那台不是本插件的')
  assert.match(String(snap.portNote), /没有读它，也没有动它/, '说清本插件没有读它、也没有动它')
  assert.ok(!/先手动关掉那台浏览器/.test(String(snap.err)), '不给用户"先去手动关一台浏览器"的死路')
  assert.ok(snap.owned, '别人占着端口不是丢掉自己证据的理由')
  assert.equal(rt.stateData.owned.uuid, 'uuid-ours-gone')
})

test('a reap that cannot be confirmed says so and leaves the evidence on disk', async () => {
  const now = 1791108083039
  const rt = ownedRun({
    now,
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: (Math.floor(now / 1000) + 6 * 3600) * 1000,
      owned: {
        spawnId: 'spawn-left-3', uuid: 'uuid-leftover-3', port: 9333, pid: 4321, spawnedAt: now - 60e3,
        profile: LEASE_PROFILE, exe: 'C:\\edge.exe',
      },
    },
    closeBrowser: async () => ({ closed: false, reason: 'still-running' }),
  })
  await rt.core.init()
  const snap = await rt.core.state()
  assert.equal(snap.reap.closed, false)
  assert.equal(snap.reap.why, 'still-running')
  assert.match(String(snap.err), /未能确认关闭/, '「放弃」必须写成「没能确证」，不是「已关闭」')
  assert.ok(snap.owned, '证据留着，用户还能按它再关一次')
  assert.equal(rt.stateData.owned.pid, 4321)
})

test('a close that never answers is bounded, and the lease survives the timeout', async () => {
  const now = 1791108083039
  const rt = ownedRun({
    now,
    closeBudgetMs: 40,
    stateData: {
      lastGetAt: 0, auto: false, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: (Math.floor(now / 1000) + 6 * 3600) * 1000,
      owned: {
        spawnId: 'spawn-left-4', uuid: 'uuid-leftover-4', port: 9333, pid: 4321, spawnedAt: now - 60e3,
        profile: LEASE_PROFILE, exe: 'C:\\edge.exe',
      },
    },
    closeBrowser: () => new Promise(() => {}),
  })
  await rt.core.init()
  const snap = await rt.core.state()
  assert.equal(snap.reap.closed, false, '给不出答案的关闭不能把启动拖住')
  assert.equal(snap.reap.why, 'timeout')
  assert.match(String(snap.err), /未能确认关闭/)
  assert.equal(snap.owned.port, 9333, '超时只说明我们放弃了，不说明它关了')
  assert.equal(rt.stateData.owned.port, 9333)
})

test('a failure after the spawn closes the browser this run started, and says so on the click', async () => {
  const attempts = []
  // The fixture has to stop answering once the browser is closed — otherwise it lies about a
  // browser that is gone and the next port scan "finds" it (2026-10-05 round 14 A).
  let closedByUs = false
  const rt = ownedRun({
    // A password form, not the device page: this click goes straight to the visible window,
    // which is the one door a click always has. The failure below happens after it is started.
    http({ url }) {
      if (url.indexOf('id.tsinghua.edu.cn') !== -1) return okResponse(IDP_LOGIN_FORM)
      return undefined
    },
    cdp: async (arg) => {
      if (arg.probeOnly) {
        return rt.spawns.length && !closedByUs
          ? { ok: true, running: true, browserId: 'uuid-lease-1' }
          : { ok: false, running: false }
      }
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [], browserId: 'uuid-lease-1' }
    },
    timerInterval: () => { throw new Error('timer service is gone') },
    closeBrowser: async (arg) => { attempts.push(arg); closedByUs = true; return { closed: true, via: 'cdp', verified: true } },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(rt.spawns.length, 1, '浏览器是在失败之前起来的')
  assert.equal(attempts.length, 1, '抛异常不许把它留在世界上')
  assert.equal(attempts[0].reason, 'error')
  assert.equal(attempts[0].port, 9333)
  assert.equal(attempts[0].pid, 4321, '按本次 spawn 的 pid 关（lease 里就有）')
  assert.equal(click.loginOpened, 'error')
  assert.match(String(click.err), /timer service is gone/, '真实错误仍是这一行的头一句')
  assert.match(String(click.err), /已关闭本次启动的浏览器/, '并且说清那台浏览器后来怎么了')
  assert.equal(rt.stateData.owned, null, '确证关闭要写盘，不然下一个进程会去找一台已经没了的浏览器')
})

// Requirement 1 (2026-10-05 round 16). The stored session has to be inside the browser before
// its first request to the site: `--no-session-restore` means a fresh profile, and the cookie
// the HTTP ladder uses was never in it. The carrier therefore starts on about:blank, the
// factory CDP restore injects the jar, and only then does the page go to the SSO entry.
test('the no-window carrier lands on about:blank and is handed the stored session first', async () => {
  const calls = []
  const rt = ownedRun({
    sessionRestore: async (arg) => {
      calls.push(arg)
      return { ok: true, reason: '', host: 'id.tsinghua.edu.cn', sent: 2, failed: [], skipped: [], navigated: true, instanceMatched: true }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()

  assert.equal(click.loginOpened, 'headless', '这一次点击走无窗口载体（' + String(click.err) + '）')
  const argv = rt.spawns[0].argv
  assert.equal(argv[argv.length - 1], 'about:blank', '会话没注入之前，绝不先去站点')
  assert.equal(argv.some((a) => String(a).indexOf('id.tsinghua.edu.cn') !== -1), false, 'argv 里不许还留着 SSO 入口')
  assert.equal(calls.length, 1, '本次启动的浏览器、恰好恢复一次')
  assert.equal(calls[0].port, 9333)
  assert.equal(calls[0].uuid, 'uuid-lease-1', '给的是本次 spawn 学到的实例身份')
  assert.equal(calls[0].url, SSO_LOGIN_URL, '恢复之后要去的仍然是原 SSO 入口')
  assert.deepEqual(calls[0].jar.map((c) => c.name), ['SESSION', 'MADCOOKIE'], '整份 jar 进去，不是名字摘要')
  assert.equal(calls[0].jar[0].value, 's-1', '值也进去了——不然浏览器里没有会话')

  const snap = await rt.core.state()
  assert.equal(snap.restore.ok, true)
  assert.equal(snap.restore.sent, 2)
  assert.equal(JSON.stringify(snap.restore).includes('s-1'), false, '报告里只有名字与条数，没有值')
  assert.equal(rt.saves[rt.saves.length - 1].lastRestore.ok, true, '恢复的结果要落盘，刷新页面还看得见')
})

test('a click whose no-window attempt cannot restore its session closes it and still gets the one door', async () => {
  const attempts = []
  let closedByUs = false
  const rt = ownedRun({
    sessionRestore: async () => ({ ok: false, reason: 'not-ours', host: 'id.tsinghua.edu.cn', sent: 0, failed: [], skipped: [], navigated: false, instanceMatched: false }),
    cdp: async (arg) => {
      if (arg.probeOnly) {
        return rt.spawns.length && !closedByUs
          ? { ok: true, running: true, browserId: 'uuid-lease-1' }
          : { ok: false, running: false }
      }
      return { ok: true, running: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [], browserId: 'uuid-lease-1' }
    },
    closeBrowser: async (arg) => { attempts.push(arg); closedByUs = true; return { closed: true, via: 'cdp', verified: true } },
  })
  await rt.core.init()
  const before = rt.stateData.tokenExpAt
  const click = await rt.core.getTok()

  assert.equal(attempts.length, 1, '会话交不过去，那台无窗口载体就不许留在世界上')
  assert.equal(attempts[0].reason, 'restore-failed')
  assert.equal(attempts[0].port, 9333)
  assert.equal(rt.spawns.length, 2, '无窗口那条路走不通之后，点击仍拿到它一直有的那扇门')
  assert.equal(click.loginOpened, 'launched', '而那是可见窗口，不是"续期成功"')
  assert.match(String(click.err), /登录窗口已打开/, '说的是眼下该做什么，不是一句成功')
  const snap = await rt.core.state()
  assert.equal(snap.restore.ok, false)
  assert.equal(snap.restore.reason, 'not-ours')
  assert.equal(rt.stateData.lastRestore.reason, 'not-ours', '交不过去这件事留在盘上，窗口开着也读得到')
  assert.equal(rt.stateData.tokenExpAt, before, 'exp 一步没动：交不过去绝不等于续上了')
  assert.equal(rt.stateData.owned.port, 9333, '可见窗口那一台仍然带着 lease（下一次进程还要能关它）')
})

test('a background run whose session cannot be handed over says so and opens no window', async () => {
  const now = 1791108083039
  const exp1 = Math.floor(now / 1000) + 6 * 3600
  const rt = ownedRun({
    now,
    stateData: { lastGetAt: now - AUTO_REFRESH_MS - 60e3, auto: true, cookies: '', ssoCookies: '', cookieJar: ssoJar, tokenExpAt: exp1 * 1000 },
    sessionRestore: async () => ({ ok: false, reason: 'no-blank-target', host: 'id.tsinghua.edu.cn', sent: 0, failed: [], skipped: [], navigated: false, instanceMatched: true }),
  })
  await rt.core.init()
  const res = await rt.core.getTok({ background: true })

  assert.equal(rt.spawns.length, 1, '只起了一台无窗口载体')
  assert.equal(rt.closes.length, 1, '会话交不过去就当场关掉')
  assert.equal(rt.closes[0].reason, 'restore-failed')
  assert.notEqual(res.loginOpened, 'launched', '后台绝不许弹窗')
  assert.equal(res.loginOpened, 'session-restore-failed', 'trace 的 opened 要按它本来的名字记，不许是 none')
  assert.match(String(res.err), /没能把已保存的会话交给浏览器/, '后台的失败要写成人话')
  assert.match(String(res.err), /no-blank-target/, '并且带上具名的原因')
  assert.equal(rt.stateData.tokenExpAt, exp1 * 1000, 'exp 没动，就不许留下任何"续上了"的痕迹')
  const snap = await rt.core.state()
  assert.equal(snap.loginReason, 'session-restore-failed', '面板按这个名字取文案（ui.js 有它自己的那一句）')
  assert.equal(snap.restore.ok, false)
  assert.equal(rt.stateData.owned, null, '确证关闭后 lease 写回盘')
})

// 2026-10-05 round 17：端口冲突、隔离 profile、并发闸门、陈旧目录清扫 —— 这一轮新增的四条规矩。
test('two clicks that arrive together start one carrier, not two', async () => {
  const rt = ownedRun()
  await rt.core.init()
  const both = await Promise.all([rt.core.getTok(), rt.core.getTok()])
  assert.equal(both.length, 2)
  assert.equal(rt.spawns.length, 1, '两个调用同时读到 busy=false 的那个窗口必须被入口闸门挡住')
  const snap = await rt.core.state()
  assert.equal(snap.gate.held, false, '一次运行结束之后闸门不能留在手里（留在手里 = 后面每一次点击都排队）')
  assert.equal(snap.gate.waiters, 0)
})

test('the startup sweep removes only stale one-run directories this plugin made', async () => {
  const now = 1791108083039
  const base = 'C:\\Users\\test\\.dsh\\madmodel'
  const entries = [
    { name: 'run-stale', dir: base + '\\run-stale', mtimeMs: now - 25 * 3600e3 },
    { name: 'run-fresh', dir: base + '\\run-fresh', mtimeMs: now - 3600e3 },
    { name: 'run-held', dir: base + '\\run-held', mtimeMs: now - 25 * 3600e3 },
    { name: 'profile', dir: base + '\\profile', mtimeMs: now - 100 * 3600e3 },
  ]
  const rt = ownedRun({
    now,
    listStateDir: async () => ({ ok: true, entries }),
    // 真实的 lister（lib/index.js 的 createProfileLister）交出来的是 normalizePath 过的路径：
    // 小写、反斜杠、无尾分隔符。夹具必须照它的形状给，否则比不中。
    listBrowserProfiles: async () => ({ ok: true, dirs: [(base + '\\run-held').toLowerCase()] }),
  })
  await rt.core.init()
  assert.deepEqual(rt.removes, [base + '\\run-stale'], '只有"本次插件自己造的 + 足够旧 + 没人在用"的目录才删')
  const snap = await rt.core.state()
  assert.equal(snap.prune.reason, 'removed-stale')
  assert.ok(String(snap.prune.removed.join(',')).indexOf('run-stale') !== -1)
  assert.ok(!rt.removes.some((p) => p === base + '\\profile'), '共享 profile 不是本次运行造出来的，永远不在名单里')

  // 进程表读不出来（策略禁用 PowerShell、或命令失败）：宁可一个都不删。
  const rt2 = ownedRun({
    now,
    listStateDir: async () => ({ ok: true, entries }),
    listBrowserProfiles: async () => ({ ok: false, dirs: [], error: 'no-powershell' }),
  })
  await rt2.core.init()
  assert.deepEqual(rt2.removes, [], '读不到持有人就什么都不删')
  assert.equal((await rt2.core.state()).prune.reason, 'profile-holders-unknown')
})

test('a one-run profile is removed once its browser is closed, and the shared profile never is', async () => {
  const now = 1791108083039
  const rt = ownedRun({
    now,
    cdp: async (arg) => {
      if (arg.probeOnly) {
        return arg.port === 9333 ? { ok: true, running: true, browserId: 'uuid-stranger' } : { ok: false, running: false }
      }
      return { ok: true, running: true, token: '', url: 'https://id.tsinghua.edu.cn/', cookies: [], browserId: 'uuid-owned' }
    },
  })
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless')
  const profileDir = rt.spawns[0].argv.find((a) => a.indexOf('--user-data-dir=') === 0).slice('--user-data-dir='.length)
  assert.ok(profileDir.indexOf('run-') !== -1, '陌生实例占着端口时，本次运行必须用自己的临时 profile')
  await rt.core.dispose()
  assert.ok(rt.removesSync.indexOf(profileDir) !== -1, '确证关闭之后，本次自己造的那份目录要删掉')
  assert.ok(rt.removesSync.indexOf(LEASE_PROFILE) === -1, '共享 profile 不是本次运行造的，一个字节都不许动')
  assert.ok(rt.removes.indexOf(LEASE_PROFILE) === -1)
})

test('without the restore seam the carrier keeps its old address, so a half-built restore is not silent', async () => {
  const rt = ownedRun()
  await rt.core.init()
  const click = await rt.core.getTok()
  assert.equal(click.loginOpened, 'headless')
  const argv = rt.spawns[0].argv
  assert.equal(argv[argv.length - 1], SSO_LOGIN_URL, '没有恢复能力时，行为与本轮之前一模一样')
})
