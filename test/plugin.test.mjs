import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const hostSource = fs.readFileSync(new URL('../lib/host.js', import.meta.url), 'utf8')
const clientSource = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function completed(payload) {
  const text = JSON.stringify(payload)
  return {
    pid: 1234,
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom() { return { text } } },
      stderr: { readFrom() { return { text: '' } } },
    },
  }
}

async function createRuntime(options = {}) {
  const handlers = new Map()
  const timers = []
  const spawns = []
  const updates = []
  let stateData = options.stateData ?? null
  let credential = options.credential ?? ''
  const settings = { providers: { ...(options.providers || {}) } }

  const subprocess = {
    async resolveExecutable(candidate) { return candidate },
    spawn(spec) {
      spawns.push(spec)
      const mode = spec.argv[1] === '-e' ? spec.argv[3] : null
      if (!mode) return completed({ ok: true })
      const args = JSON.parse(spec.stdio.stdin.data)
      if (mode === 'env') return completed({ home: 'C:\\Users\\test', temp: 'C:\\Temp', cwd: 'C:\\work' })
      if (mode === 'mkdir') return completed({ ok: true })
      if (mode === 'state') {
        if (args.op === 'load') return completed({ ok: true, data: stateData })
        stateData = structuredClone(args.data)
        return completed({ ok: true })
      }
      if (mode === 'get') return completed(options.get ? options.get(args) : { status: 500, text: '' })
      if (mode === 'wscdp') {
        return completed(options.wscdp ? options.wscdp(args) : { ok: false, running: false, reason: 'no-devtools' })
      }
      return completed({ ok: false, error: `unexpected mode ${mode}` })
    },
  }
  const settingsService = {
    async describe() { return [{ ns: 'llm-pi-ai' }] },
    async get(ns) { return ns === 'llm-pi-ai' ? settings : undefined },
    async update(ns, patch) {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(Object.getPrototypeOf(patch), Object.prototype, 'settings patch must use the Host realm')
      assert.equal(Object.getPrototypeOf(patch.providers), Object.prototype, 'nested patch must use the Host realm')
      updates.push(patch)
      for (const [id, value] of Object.entries(patch.providers)) {
        settings.providers[id] = { ...(settings.providers[id] || {}), ...structuredClone(value) }
      }
    },
  }
  const credentials = {
    async resolve() { return credential ? { value: credential, source: 'test' } : undefined },
    async set(_ref, value) { credential = value },
  }
  const services = {
    subprocess,
    timer: { interval(fn, ms) { const entry = { fn, ms, disposed: false }; timers.push(entry); return () => { entry.disposed = true } } },
    fs: { async resolve() { return 'C:\\work' }, processPath(value) { return value } },
    settings: settingsService,
    credentials,
  }
  const context = vm.createContext({
    console,
    harness: { handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) } },
  })
  const plugin = new vm.Script(`(function () {\n${hostSource}\n})()`, { filename: 'lib/host.js' }).runInContext(context)
  assert.deepEqual(Array.from(plugin.inject), ['subprocess', 'timer', 'fs', 'settings', 'credentials'])
  plugin.apply({
    get(name) { return services[name] },
    interval(fn, ms) { return services.timer.interval(fn, ms) },
  })
  await handlers.get('mmtok/init')()
  return {
    handlers, timers, spawns, updates, settings,
    get credential() { return credential },
    get stateData() { return stateData },
  }
}

test('dynamic Host and Client halves compile in their function-body format', () => {
  new vm.Script(`(function () {\n${hostSource}\n})()`)
  new vm.Script(`(function () {\n${clientSource}\n})()`)
})

test('Client half mounts the overlay using declared lifecycle APIs only', async () => {
  const calls = []
  const registrations = []
  let css = ''
  const context = vm.createContext({
    console: { error() {} },
    React: {},
    styles: { insert(value) { css = value; return () => {} } },
    host: {
      call(method) {
        calls.push(method)
        return Promise.resolve({ auto: false, busy: false, status: 'idle' })
      },
    },
  })
  const plugin = new vm.Script(`(function () {\n${clientSource}\n})()`, { filename: 'lib/client.js' }).runInContext(context)
  assert.deepEqual(Array.from(plugin.inject), ['timer', 'slots'])
  plugin.apply({
    interval() { return () => {} },
    effect(fn) { fn(); return () => {} },
    slots: {
      inject(name, fn) { assert.equal(name, 'shell.overlay'); return fn() },
      register(meta, component) { registrations.push({ meta, component }); return () => {} },
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].meta.id, 'mmtok-actions')
  assert.match(css, /\.mmtok-box/)
  assert.ok(calls.includes('mmtok/init'))
  assert.ok(calls.includes('mmtok/state'))
  assert.equal(calls.includes('mmtok/sync-profile'), false)
  assert.doesNotThrow(() => plugin.apply({ interval() { throw new Error('synthetic mount failure') } }))
})

test('fresh mint creates a valid minimal llm-pi-ai route without exposing the token', async () => {
  const token = 'secret-fresh-token'
  const runtime = await createRuntime({
    providers: { existing: { baseURL: 'https://example.invalid/v1' } },
    get(args) {
      if (args.url.endsWith('/model-api/auth-login/check')) {
        return { status: 200, text: JSON.stringify({ success: true, data: token }) }
      }
      return { status: 500, text: '' }
    },
  })
  const result = await runtime.handlers.get('mmtok/get-tok')()
  assert.equal(result.status, 'ok')
  assert.equal(result.busy, false)
  assert.equal(runtime.credential, token)
  assert.deepEqual(runtime.settings.providers.madmodel, {
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
  assert.deepEqual(Object.keys(runtime.updates.at(-1).providers), ['madmodel'], 'unrelated providers must not be copied into the user layer')
  assert.equal('token' in runtime.stateData, false)
  assert.equal('tokenPreview' in result, false)
  assert.ok(runtime.spawns.every(spec => !spec.argv.join(' ').includes(token)), 'token must not enter a subprocess command line')
})

test('an existing MadModel route keeps user-owned fields and only receives the credential reference', async () => {
  const runtime = await createRuntime({
    providers: {
      custom: {
        displayName: 'My Campus Gateway',
        apiKeyEnv: 'OLD_KEY',
        api: 'openai-completions',
        baseURL: 'https://madmodel.cs.tsinghua.edu.cn/v1',
        models: [{ id: 'custom-model', contextWindow: 100000 }],
      },
    },
    get(args) {
      if (args.url.endsWith('/model-api/auth-login/check')) {
        return { status: 200, text: JSON.stringify({ success: true, data: 'fresh-token' }) }
      }
      return { status: 500, text: '' }
    },
  })
  await runtime.handlers.get('mmtok/get-tok')()
  assert.equal(runtime.settings.providers.custom.apiKeyEnv, 'MADMODEL_API_KEY')
  assert.equal(runtime.settings.providers.custom.displayName, 'My Campus Gateway')
  assert.deepEqual(runtime.settings.providers.custom.models, [{ id: 'custom-model', contextWindow: 100000 }])
  assert.deepEqual(Object.keys(runtime.updates.at(-1).providers.custom), ['apiKeyEnv'])
})

test('reusing a still-valid token preserves its original local issuance time', async () => {
  const token = 'secret-reused-token'
  const runtime = await createRuntime({
    credential: token,
    stateData: { lastGetAt: 123456, auto: false, cookies: 'session=abc', ssoCookies: '' },
    get(args) {
      if (args.url.endsWith('/check')) return { status: 503, text: '' }
      if (args.url.endsWith('/auth-login')) return { status: 200, text: JSON.stringify({ success: true }) }
      return { status: 500, text: '' }
    },
  })
  const result = await runtime.handlers.get('mmtok/get-tok')()
  assert.equal(result.via, 'reuse')
  assert.equal(result.lastGetAt, 123456)
  assert.ok(runtime.spawns.every(spec => !spec.argv.join(' ').includes(token)))
})

test('legacy state migration removes plaintext tokens without overwriting a newer DSH credential', async () => {
  const runtime = await createRuntime({
    credential: 'newer-credential-token',
    stateData: {
      token: 'stale-legacy-token',
      lastGetAt: Date.now() + 24 * 3600e3,
      auto: false,
      cookies: {},
      ssoCookies: [],
    },
  })
  const state = await runtime.handlers.get('mmtok/state')()
  assert.equal(runtime.credential, 'newer-credential-token')
  assert.equal('token' in runtime.stateData, false)
  assert.equal(state.lastGetAt, 0, 'a corrupt future timestamp must not suppress refresh indefinitely')
  assert.equal(runtime.stateData.cookies, '')
  assert.equal(runtime.stateData.ssoCookies, '')
})

test('capture fallback writes a minted token to credentials and provider settings', async () => {
  let mintAllowed = false
  const token = 'secret-capture-token'
  const runtime = await createRuntime({
    get(args) {
      if (args.url.endsWith('/model-api/auth-login/check')) {
        return mintAllowed
          ? { status: 200, text: JSON.stringify({ success: true, data: token }) }
          : { status: 401, text: '' }
      }
      return { status: 401, text: '' }
    },
    wscdp(args) {
      if (args.probeOnly) return { ok: false, running: false, reason: 'no-devtools' }
      return { ok: true, token: '', url: 'https://madmodel.cs.tsinghua.edu.cn/', cookies: [] }
    },
  })
  const first = await runtime.handlers.get('mmtok/get-tok')()
  assert.equal(first.loginRequired, true)
  const opened = await runtime.handlers.get('mmtok/open-login')()
  assert.equal(opened.launched, true)
  mintAllowed = true
  const captureTimer = runtime.timers.find(entry => entry.ms === 2500)
  assert.ok(captureTimer)
  await captureTimer.fn()
  const state = await runtime.handlers.get('mmtok/state')()
  assert.equal(state.status, 'ok')
  assert.equal(state.credentialWritten, true)
  assert.equal(runtime.credential, token)
  assert.equal(state.provider, 'llm-pi-ai/madmodel')
})

test('SSO replay refuses an off-domain redirect before sending cookies', async () => {
  const seen = []
  const runtime = await createRuntime({
    stateData: { lastGetAt: 0, auto: false, cookies: '', ssoCookies: 'sso=secret' },
    get(args) {
      seen.push(args)
      if (args.url.endsWith('/model-api/auth-login/check')) return { status: 401, text: '' }
      if (args.url.startsWith('https://id.tsinghua.edu.cn/')) {
        return { status: 302, location: 'https://evil.example/?ticket=stolen', text: '' }
      }
      return { status: 500, text: '' }
    },
  })
  const result = await runtime.handlers.get('mmtok/get-tok')()
  assert.equal(result.loginRequired, true)
  assert.equal(seen.some(request => request.url.startsWith('https://evil.example/')), false)
  assert.equal(seen.find(request => request.url.startsWith('https://id.tsinghua.edu.cn/')).headers.Cookie, 'sso=secret')
})

test('persisted Auto refresh runs from the Host timer without a Client page', async () => {
  const token = 'secret-auto-token'
  const runtime = await createRuntime({
    stateData: { lastGetAt: 1, auto: true, cookies: '', ssoCookies: '' },
    get(args) {
      if (args.url.endsWith('/model-api/auth-login/check')) {
        return { status: 200, text: JSON.stringify({ success: true, data: token }) }
      }
      return { status: 500, text: '' }
    },
  })
  const autoTimer = runtime.timers.find(entry => entry.ms === 30000)
  assert.ok(autoTimer)
  await autoTimer.fn()
  assert.equal(runtime.credential, token)
})

test('helper state writes are overwrite-safe and accept sensitive input through stdin', async () => {
  const runtime = await createRuntime()
  const helper = runtime.spawns.find(spec => spec.argv[3] === 'env').argv[2]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thu-tok-auto-'))
  const target = path.join(dir, 'state.json')
  try {
    for (const auto of [false, true]) {
      const run = spawnSync(process.execPath, ['-e', helper, 'state'], {
        input: JSON.stringify({ op: 'save', path: target, data: { auto } }),
        encoding: 'utf8',
      })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(JSON.parse(run.stdout).ok, true)
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { auto: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CDP helper accepts only exact Tsinghua hosts and never falls back to an arbitrary page', () => {
  assert.match(hostSource, /h === 'madmodel\.cs\.tsinghua\.edu\.cn'/)
  assert.match(hostSource, /reason: 'unsafe-debugger-url'/)
  assert.match(hostSource, /if \(!target \|\| !target\.webSocketDebuggerUrl\)/)
  assert.doesNotMatch(hostSource, /for \(const p of pages\) \{ if \(p\.type === 'page'\) \{ target = p/)
  assert.doesNotMatch(clientSource, /tokenPreview|mmtok\/sync-profile|AUTO_MS/)
})
