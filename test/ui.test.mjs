import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = fs.readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8')
const settle = () => new Promise((resolve) => setImmediate(resolve))

// Minimal DOM fixture: execute the shipped script and click its real listeners.
function browserFixture(respond, before) {
  const nodes = []
  function element(tag) {
    const node = {
      tag, children: [], parentNode: null, className: '', textContent: '', title: '', listeners: {},
      get parentElement() { return this.parentNode },
      get isConnected() { return !!this.root || !!this.parentNode?.isConnected },
      get firstChild() { return this.children[0] || null },
      appendChild(child) { return this.insertBefore(child, null) },
      insertBefore(child, before) {
        if (child.parentNode) child.parentNode.removeChild(child)
        const at = before ? this.children.indexOf(before) : this.children.length
        assert.ok(at >= 0)
        this.children.splice(at, 0, child)
        child.parentNode = this
        return child
      },
      removeChild(child) {
        this.children.splice(this.children.indexOf(child), 1)
        child.parentNode = null
      },
      addEventListener(name, fn) { this.listeners[name] = fn },
      getAttribute(name) { return this[name] || null },
      setAttribute(name, value) { this[name] = String(value) },
      removeAttribute(name) { delete this[name] },
    }
    nodes.push(node)
    return node
  }
  const body = element('body'); body.root = true
  const head = element('head'); head.root = true
  const foot = body.appendChild(element('div')); foot.className = 'sidebar_footArea'
  const remote = foot.appendChild(element('button')); remote.textContent = 'Remote'
  const settings = foot.appendChild(element('button')); settings['aria-label'] = 'Settings'
  const live = () => nodes.filter((n) => n.isConnected)
  // Selector-aware enough for every query the widget makes, so a fixture can also model a
  // sidebar that has a footer but no settings row yet (2026-10-04 real-run shape).
  const pick = (sel) => {
    const s = String(sel)
    if (s === '.mmtok-box') return live().find((n) => String(n.className).indexOf('mmtok-box') === 0) || null
    if (s.indexOf('script[') === 0) return null
    if (s.indexOf('button[') === 0) {
      const label = String(settings['aria-label'] || settings.title || '')
      return label === '设置' || label === 'Settings' ? settings : null
    }
    if (s.indexOf('[data-slot') === 0) {
      return live().find((n) => String(n['data-slot'] || '').indexOf('sidebar.foot') === 0) || null
    }
    if (s.indexOf('[class*=') === 0) {
      return live().find((n) => /footArea|footerActions|SidebarRoot/.test(String(n.className))) || null
    }
    return null
  }
  const intervals = new Map()
  let nextId = 0
  const calls = []
  const infos = []
  const document = {
    readyState: 'complete', body, head,
    createElement: element,
    getElementById: (id) => nodes.find((n) => n.id === id && n.isConnected),
    querySelector: (sel) => pick(sel),
    querySelectorAll: (sel) => (String(sel).indexOf('script[') === 0
      ? []
      : nodes.filter((n) => n.tag === 'button' && n.isConnected)),
    addEventListener() {}, removeEventListener() {},
  }
  const context = vm.createContext({
    document,
    setInterval(fn, ms) { const id = ++nextId; intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { intervals.delete(id) },
    fetch: async (url, init) => {
      calls.push({ url, init })
      const response = await respond(url, init)
      return { ok: response.status < 400, status: response.status, json: async () => response.data }
    },
  })
  // window === the page global, like a browser: the widget writes window.__mmtok* and the
  // fixture wants to read both that state and the one-line diagnostics it logs.
  context.window = context
  context.console = { info: (...args) => infos.push(args.join(' ')) }
  if (before) before({ body, head, foot, remote, settings, context })
  vm.runInContext(source, context)
  return { context, nodes, body, foot, remote, settings, intervals, calls, infos,
    boxEl: () => nodes.find((n) => String(n.className).indexOf('mmtok-box') === 0 && n.isConnected),
    getButton: () => nodes.find((n) => n.tag === 'button' && n.textContent === 'Get' && n.isConnected),
    dotEl: () => nodes.find((n) => String(n.className).indexOf('mmtok-dot') === 0 && n.isConnected),
    stateEl: () => nodes.find((n) => String(n.className).indexOf('mmtok-state') === 0 && n.isConnected),
  }
}

test('UI Get and login fallback send JSON accepted by the Host contract', async () => {
  const fixture = browserFixture(async (url, init) => {
    if (init.method === 'POST') {
      assert.equal(init.headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(init.body), {})
      return { status: 200, data: url.endsWith('/get-tok') ? { loginRequired: true } : { launched: true } }
    }
    assert.equal(init.headers, undefined)
    return { status: 200, data: { status: 'idle' } }
  })
  await settle()
  assert.equal(fixture.foot.firstChild.className, 'mmtok-box')
  fixture.getButton().listeners.click()
  await settle()
  assert.deepEqual(fixture.calls.filter((c) => c.init.method === 'POST').map((c) => c.url), [
    '/thu-tok-auto/api/get-tok', '/thu-tok-auto/api/open-login',
  ])
  assert.equal(fixture.getButton().disabled, false)
})

test('UI network failure releases Get and status polling recovers', async () => {
  const fixture = browserFixture(async (_url, init) => {
    if (init.method === 'POST') throw new Error('offline')
    return { status: 200, data: { status: 'ok', credentialWritten: true, providerName: 'Custom THU' } }
  })
  await settle()
  fixture.getButton().listeners.click()
  await settle()
  assert.equal(fixture.getButton().disabled, false)
  assert.match(fixture.getButton().title, /offline/)
  Array.from(fixture.intervals.values()).find((i) => i.ms === 10000).fn()
  await settle()
  assert.match(fixture.getButton().title, /Custom THU/)
})

// 2026-10-04: the panel reported `DSH 通信失败：Failed to fetch` on the real machine and that one
// sentence could not be told apart from a dead API path, a refused origin or a click that never
// reached this handler. The client keeps the readings the browser already has, and quotes them.
test('UI records the request reading when the browser itself fails the fetch', async () => {
  const fixture = browserFixture(async (_url, init) => {
    if (init.method === 'POST') throw new TypeError('Failed to fetch')
    return { status: 200, data: { status: 'idle' } }
  })
  await settle()
  fixture.getButton().listeners.click()
  await settle()
  const diag = fixture.context.window.__mmtokUiDiag
  assert.equal(diag.clicks, 1)
  assert.equal(diag.failures, 1)
  assert.equal(diag.lastFailure.method, 'POST')
  assert.equal(diag.lastFailure.endpoint, 'get-tok')
  assert.equal(diag.lastFailure.status, 0)
  assert.equal(diag.lastFailure.name, 'TypeError')
  assert.match(diag.lastFailureText, /^POST \/thu-tok-auto\/api\/get-tok；没有收到响应状态/)
  assert.match(diag.lastFailureText, /错误类型 TypeError/)
  assert.match(fixture.getButton().title, /Failed to fetch/)
  assert.match(fixture.getButton().title, /没有收到响应状态/)
})

test('UI tells an answered-but-refused request apart from a reply that never came', async () => {
  const fixture = browserFixture(async (_url, init) => {
    if (init.method === 'POST') return { status: 403, data: { ok: false, error: '请求来源不受信任。' } }
    return { status: 200, data: { status: 'idle' } }
  })
  await settle()
  fixture.getButton().listeners.click()
  await settle()
  const diag = fixture.context.window.__mmtokUiDiag
  assert.equal(diag.lastResponse.status, 403)
  assert.equal(diag.lastFailure.status, 403)
  assert.match(diag.lastFailureText, /响应 HTTP 403/)
  // The successful poll is still on record as the last *successful* request.
  assert.equal(diag.lastOk.endpoint, 'status')
  assert.match(fixture.getButton().title, /请求来源不受信任。/)
  assert.match(fixture.getButton().title, /HTTP 403/)
})

test('UI duplicate loads keep one widget, and a 404 says so instead of vanishing', async () => {
  let removed = false
  const fixture = browserFixture(async () => ({ status: removed ? 404 : 200, data: { status: 'idle' } }))
  await settle()
  vm.runInContext(source, fixture.context)
  await settle()
  // render (1s), refresh (10s), mount retry (2s) and the waiting-login poll (2s) — the
  // last one exists so a finished login is noticed within a second or two instead of
  // waiting for the next 10s refresh (2026-10-04, requirement A).
  assert.equal(fixture.intervals.size, 4)
  assert.equal(fixture.nodes.filter((n) => n.className === 'mmtok-box' && n.isConnected).length, 1)
  removed = true
  Array.from(fixture.intervals.values()).find((i) => i.ms === 10000).fn()
  await settle()
  // A missing API used to delete the widget on the spot: the panel disappeared and nothing
  // on the page said why, which is indistinguishable from a broken build — the exact shape
  // of the 2026-10-04 real run. The widget now stays, states the fact and keeps polling.
  assert.equal(fixture.intervals.size, 4)
  assert.ok(fixture.boxEl())
  assert.match(fixture.stateEl().textContent, /插件接口未就绪/)
  assert.match(fixture.getButton().title, /HTTP 404/)
})

test('UI takes over when an earlier injection left its flag but no widget', async () => {
  const fixture = browserFixture(async () => ({ status: 200, data: { status: 'idle' } }))
  await settle()
  const box = fixture.boxEl()
  assert.ok(box)
  // The 2026-10-04 shape: the guard flag says "already loaded", the node the widget lived
  // in was replaced by a sidebar re-render, and nothing is left on the page. A later load
  // must mount rather than return because of a flag that outlived its widget.
  box.parentNode.removeChild(box)
  // Clear the guard flag *inside* the page: a contextified global keeps its own copy, so
  // deleting the property from here would not be visible to the script.
  vm.runInContext('delete window.__mmtokUiCleanup', fixture.context)
  vm.runInContext(source, fixture.context)
  await settle()
  assert.equal(fixture.context.window.__mmtokUiDiag.takeovers, 1)
  assert.equal(fixture.nodes.filter((n) => n.className === 'mmtok-box' && n.isConnected).length, 1)
  assert.equal(fixture.context.window.__mmtokUiDiag.lastMount, 'foot')
})

test('UI reports a missing anchor once and mounts as soon as the sidebar appears', async () => {
  const fixture = browserFixture(
    async () => ({ status: 200, data: { status: 'idle' } }),
    // A page whose sidebar has not rendered yet: there is no footer to hang the widget on.
    ({ body, foot }) => { body.removeChild(foot) },
  )
  await settle()
  assert.equal(fixture.boxEl(), undefined)
  assert.equal(fixture.context.window.__mmtokUiDiag.mounted, false)
  assert.equal(fixture.context.window.__mmtokUiDiag.lastMount, 'failed:no-anchor')
  // Exactly one line in the console, not one per two-second attempt.
  assert.equal(fixture.infos.filter((line) => line.indexOf('控件未挂载') >= 0).length, 1)
  fixture.body.appendChild(fixture.foot)
  Array.from(fixture.intervals.values()).filter((i) => i.ms === 2000).pop().fn()
  await settle()
  assert.ok(fixture.boxEl(), 'the widget must mount once its host container exists')
  assert.equal(fixture.boxEl().parentNode, fixture.foot)
  assert.equal(fixture.context.window.__mmtokUiDiag.lastMount, 'foot')
})

test('UI still mounts without a settings trigger, above the footer', async () => {
  const fixture = browserFixture(
    async () => ({ status: 200, data: { status: 'idle' } }),
    ({ settings }) => { settings['aria-label'] = ''; settings.title = ''; settings.textContent = 'Help' },
  )
  await settle()
  assert.ok(fixture.boxEl(), 'the widget must park in the sidebar container instead of waiting forever')
  assert.equal(fixture.boxEl().parentNode, fixture.foot)
  assert.equal(fixture.context.window.__mmtokUiDiag.lastMount, 'sidebar-container')
})

test('UI states what is wrong in text, not by colour alone', async () => {
  const fixture = browserFixture(async () => ({
    status: 200,
    data: { status: 'needs-login', loginReason: 'renewal-unavailable' },
  }))
  await settle()
  const dot = fixture.dotEl()
  // Red dot AND a label AND a sentence: read the same way with any colour vision.
  assert.equal(dot.className, 'mmtok-dot mmtok-bad')
  assert.match(dot.getAttribute('aria-label'), /需要登录/)
  assert.equal(fixture.stateEl().className, 'mmtok-state')
  assert.match(fixture.stateEl().textContent, /需要登录/)
  assert.equal(fixture.stateEl().getAttribute('aria-live'), 'polite')
})

test('UI stays quiet when healthy and speaks up when a sync half-failed', async () => {
  const healthy = browserFixture(async () => ({
    status: 200,
    data: { status: 'ok', syncDetail: 'synced', providerName: 'DeepSeek (THU)' },
  }))
  await settle()
  assert.equal(healthy.stateEl().className, 'mmtok-state mmtok-hidden')
  assert.equal(healthy.stateEl().textContent, '')
  assert.equal(healthy.dotEl().className, 'mmtok-dot mmtok-ok')

  const partial = browserFixture(async () => ({
    status: 200,
    data: { status: 'partial', err: '模型配置同步失败：boom', credentialPresent: true },
  }))
  await settle()
  // A working token with an unwritable config is not "ok" and not "failed".
  assert.equal(partial.dotEl().className, 'mmtok-dot mmtok-stale')
  assert.match(partial.stateEl().textContent, /模型配置未同步/)
})

test('UI calls an outage an outage, not a dead token', async () => {
  const fixture = browserFixture(async () => ({
    status: 200,
    data: {
      status: 'ok',
      offline: true,
      loggedIn: true,
      providerName: 'DeepSeek (THU)',
      expiresAt: Date.now() + 3 * 3600e3,
    },
  }))
  await settle()
  // The token is still good; only the site is unreachable. Amber = "not verified".
  assert.equal(fixture.dotEl().className, 'mmtok-dot mmtok-stale')
  assert.match(fixture.dotEl().getAttribute('aria-label'), /网络不可达/)
  assert.match(fixture.stateEl().textContent, /网络不可达/)
  assert.match(fixture.stateEl().textContent, /Token 仍可用/)
})

test('UI walks the one-click run through waiting, working and done by polling alone', async () => {
  // What the user sees between the click and the credential existing, in order. The
  // plugin's own timers drive it: nothing here clicks anything a second time
  // (2026-10-04 audit, item 3).
  let phase = 'waiting-login'
  const fixture = browserFixture(async () => ({
    status: 200,
    data: { status: phase, loginWait: phase !== 'ok', browserOpen: phase !== 'ok', credentialPresent: phase === 'ok' },
  }))
  await settle()
  assert.match(fixture.stateEl().textContent, /等待登录/)
  assert.match(fixture.stateEl().textContent, /无需再点 Get/)
  assert.equal(fixture.dotEl().className, 'mmtok-dot mmtok-busy')

  const poll = () => {
    for (const interval of Array.from(fixture.intervals.values())) {
      if (interval.ms === 1000 || interval.ms === 2000 || interval.ms === 10000) interval.fn()
    }
  }
  phase = 'processing'
  poll()
  await settle()
  assert.match(fixture.stateEl().textContent, /正在处理/)

  phase = 'ok'
  poll()
  await settle()
  assert.match(fixture.stateEl().textContent, /登录成功/, 'the login the user just did is reported as the thing that finished it')
  assert.equal(fixture.dotEl().className, 'mmtok-dot mmtok-ok')
  assert.equal(fixture.getButton().disabled, false)
})

test('UI names the build and turns "请重新登录" into something the user can do', async () => {
  // The 2026-10-04 dead end: the panel asked for a login and gave no way to start one.
  // With the renewal channel blocked, a click really does open the window, so the text
  // says so; the hover text carries the loaded version and the last run's facts, which
  // is how a real machine answers "did the restart pick up the new build?".
  const fixture = browserFixture(async () => ({
    status: 200,
    data: {
      status: 'no-progress',
      version: '0.3.9',
      refreshBlocked: true,
      loginReason: 'renewal-unavailable',
      loggedIn: true,
      credentialPresent: true,
      providerName: 'DeepSeek (THU)',
      expiresAt: Date.now() + 4 * 3600e3 + 59 * 60e3,
      trace: {
        at: Date.now() - 120e3, bg: 0, mint: 'fail', sso: 'fail', reuse: 1, verdict: 'yes',
        via: 'reuse', expBefore: 0, expAfter: 0, ms: 1500, waitMs: 0, opened: 'launched',
      },
    },
  }))
  await settle()
  assert.match(fixture.stateEl().textContent, /续期未生效/)
  assert.match(fixture.stateEl().textContent, /点一次 Get 打开登录窗口重新登录/)
  const box = fixture.nodes.filter((n) => String(n.className).indexOf('mmtok-box') === 0 && n.isConnected).pop()
  assert.match(box.title, /THU Tok Auto v0\.3\.9/)
  assert.match(box.title, /上次点击 00:02 前/, 'a manual trace says it was a click')
  assert.match(box.title, /SSO失败/)
  assert.match(box.title, /复用旧令牌/)
  assert.match(box.title, /登录窗口已打开/)
})

test('UI keeps the last click and the last automatic run apart', async () => {
  // The 2026-10-04 real run had exactly one trace on disk and it belonged to the Auto
  // tick, so the click the user made left no evidence at all. An hourly tick overwrites
  // "the last run" by design; it must not overwrite the last click (report §12 item 2).
  const fixture = browserFixture(async () => ({
    status: 200,
    data: {
      status: 'ok',
      version: '0.3.10',
      credentialPresent: true,
      expiresAt: Date.now() + 3 * 3600e3,
      trace: { at: Date.now() - 60e3, bg: 1, via: 'reuse', opened: 'none', verdict: 'yes' },
      manualTrace: { at: Date.now() - 3600e3, bg: 0, via: 'reuse', opened: 'launched', verdict: 'yes' },
    },
  }))
  await settle()
  const box = fixture.nodes.filter((n) => String(n.className).indexOf('mmtok-box') === 0 && n.isConnected).pop()
  assert.match(box.title, /上次点击 01:00 前/)
  assert.match(box.title, /上次自动 00:01 前/)
  // The click line keeps its own facts: it is the run that opened the window.
  assert.match(box.title, /上次点击 01:00 前：[^\n]*登录窗口已打开/)
  assert.doesNotMatch(box.title, /上次自动[^\n]*登录窗口已打开/)
})

test('the panel prints the Auto interval the host reports, and the old label only for an old host', async () => {
  // The cadence lives in one place (core's AUTO_REFRESH_MS, carried as autoEveryMs). The
  // 2026-10-04 audit found the hover text hardcoded to 01:00, so the widget would have kept
  // promising an hourly Auto after the schedule moved to 20 minutes (report §20).
  const button = (f, text) => f.nodes.find((n) => n.tag === 'button' && String(n.textContent).indexOf(text) === 0 && n.isConnected)
  const elapsed = (f) => f.nodes.find((n) => String(n.className).indexOf('mmtok-elapsed') === 0 && n.isConnected)
  const boxOf = (f) => f.nodes.filter((n) => String(n.className).indexOf('mmtok-box') === 0 && n.isConnected).pop()

  const fresh = browserFixture(async () => ({
    status: 200,
    data: { status: 'ok', version: '0.3.14', auto: true, autoEveryMs: 20 * 60e3, credentialPresent: true },
  }))
  await settle()
  assert.match(boxOf(fresh).title, /Auto 已开启：计时超过 00:20 自动获取/)
  assert.match(button(fresh, 'Auto').title, /00:20/)
  assert.match(elapsed(fresh).title, /超过 00:20 自动刷新/)

  // A host that has not been restarted serves no such field and still runs the hourly core:
  // the fallback names that cadence instead of advertising one this build cannot keep.
  const old = browserFixture(async () => ({
    status: 200,
    data: { status: 'ok', version: '0.3.13', auto: true, credentialPresent: true },
  }))
  await settle()
  assert.match(boxOf(old).title, /Auto 已开启：计时超过 01:00 自动获取/)
  assert.match(button(old, 'Auto').title, /01:00/)
})

test('a click stays a click when the server is already busy', async () => {
  // 0.3.9's `if (store.busy) return` dropped the click on the floor with no request, no
  // notice and no state change: the user saw a dead button. Our own in-flight request may
  // still be de-duplicated, but a *server-side* run must never swallow the click.
  const posts = []
  const fixture = browserFixture(async (url, init) => {
    if (init.method === 'POST') {
      posts.push(url)
      return { status: 200, data: { status: 'ok' } }
    }
    return { status: 200, data: { status: 'ok', busy: true, credentialPresent: true } }
  })
  await settle()
  assert.equal(fixture.getButton().disabled, false, 'a busy server never disables the only door')
  fixture.getButton().listeners.click()
  await settle()
  assert.deepEqual(posts, ['/thu-tok-auto/api/get-tok'], 'the click has to reach the server even when it says busy')
  // And the click is visibly queued rather than looking lost.
  assert.match(fixture.stateEl().textContent, /排队/)
  assert.equal(fixture.getButton().disabled, false)
})

test('UI follows its container width, not the browser window', async () => {
  // 2026-10-04 real machine: the host sidebar was collapsed to a ~54px rail, which leaves
  // this widget about 34px. Get, Auto and the clock each took a line of their own and the
  // state sentence one character per line, stretching the footer over Remote and Settings.
  // The layout has to follow the container the widget was inserted into; the viewport is
  // never consulted, because a narrow window with an expanded sidebar must stay full.
  const fixture = browserFixture(async () => ({
    status: 200,
    data: { status: 'needs-login', loginReason: 'renewal-unavailable' },
  }))
  await settle()
  const box = fixture.boxEl()
  const tick = () => Array.from(fixture.intervals.values()).find((i) => i.ms === 1000).fn()

  // Narrow window, wide container: not a collapsed sidebar.
  fixture.context.window.innerWidth = 54
  box.clientWidth = 240
  tick()
  assert.equal(box.className, 'mmtok-box', 'the viewport must never decide the layout')
  assert.equal(fixture.getButton().disabled, false)

  // The collapsed rail: one status entry, and the sentence stays in the live region
  // instead of being deleted along with the space it needed.
  box.clientWidth = 34
  tick()
  assert.equal(box.className, 'mmtok-box mmtok-compact')
  assert.match(fixture.stateEl().textContent, /需要登录/)
  assert.equal(fixture.stateEl().getAttribute('aria-live'), 'polite')
  assert.match(box.title, /需要登录/, 'the collapsed entry keeps the whole report on hover')

  // A zero width means "not laid out yet", which is not a reason to flip the layout.
  box.clientWidth = 0
  tick()
  assert.equal(box.className, 'mmtok-box mmtok-compact')

  // Expanded again: the controls come back on their own.
  box.clientWidth = 260
  tick()
  assert.equal(box.className, 'mmtok-box')
})

// The public contracts the panel owes the Host (2026-10-05, requirement B). Each of these
// has already been wrong once on the real machine, and each is a promise the user reads in
// words: a click is never swallowed, a 404 is asked again, a failure keeps the status the
// Host actually sent, and Auto is the Host's answer rather than the widget's wish.

test('a second click on an in-flight request is counted, not sent twice', async () => {
  // Our own in-flight POST is the only thing that may be de-duplicated — a *server-side*
  // run must let the click through (see the test above). And the click is a fact even when
  // its request is held back: that counter is what makes a swallowed click impossible to
  // hide, which is exactly what the 2026-10-04 real run could not tell apart from a dead
  // ladder.
  let release = null
  const posts = []
  const fixture = browserFixture(async (url, init) => {
    if (init.method === 'POST') {
      posts.push(url)
      if (posts.length === 1) await new Promise((resolve) => { release = resolve })
      return { status: 200, data: { status: 'ok', credentialPresent: true } }
    }
    return { status: 200, data: { status: 'ok', credentialPresent: true } }
  })
  await settle()
  const diag = fixture.context.window.__mmtokUiDiag

  fixture.getButton().listeners.click()
  assert.equal(posts.length, 1, 'the first click is a real request')
  assert.equal(fixture.getButton().getAttribute('aria-busy'), 'true')

  fixture.getButton().listeners.click()
  assert.equal(diag.clicks, 2, 'a click is a fact even when its request is held back')
  assert.equal(posts.length, 1, 'our own in-flight request is not sent a second time')
  assert.match(fixture.stateEl().textContent, /正在获取 Token/, 'the panel still says a fetch is in progress')
  assert.equal(fixture.getButton().disabled, false, 'the door is never locked')
  // Round 16: the swallow is visible. The guard's own sentence could never be read while `busy`
  // was set (stateText ui.js:243 and statusLine ui.js:194 consult `busy` first), so the second
  // click used to leave no trace at all — and a panel that says nothing reads as a dead button.
  // `store.dupClick` is set by the guard alone, rides on the busy line, and is taken back the
  // moment this request ends.
  assert.match(fixture.stateEl().textContent, /这次点击没有重复发起请求/, '第二次点击必须在面板上看得见')
  assert.match(fixture.dotEl().getAttribute('title'), /这次点击没有重复发起请求/, '悬停提示也要说同一句')
  assert.equal(fixture.dotEl().getAttribute('aria-label'), '状态：正在获取 Token', '圆点的 aria-label 是状态词，不塞整句进去')

  // The guard is released by the answer, not by a timer: the next click goes out again.
  release()
  await settle(); await settle(); await settle()
  assert.equal(fixture.getButton().getAttribute('aria-busy'), 'false')
  assert.doesNotMatch(fixture.stateEl().textContent, /这次点击没有重复发起请求/, '请求一结束就把重复提示收回，它不是常驻状态')
  assert.doesNotMatch(fixture.dotEl().getAttribute('title'), /这次点击没有重复发起请求/)
  fixture.getButton().listeners.click()
  assert.equal(posts.length, 2, 'once the answer lands, the next click is a new request')
})

test('a 404 keeps asking every 10 seconds and heals without a reload', async () => {
  // "仍在每 10 秒重试" is a promise the panel makes in words. One test already proves the
  // widget stays on screen and says so; this one proves the promise is kept — every tick is
  // another request — and that the same widget recovers when the API comes back.
  let removed = false
  const fixture = browserFixture(async () => (removed
    ? { status: 404, data: null }
    : { status: 200, data: { status: 'ok', credentialPresent: true, expiresAt: Date.now() + 3 * 3600e3 } }))
  await settle()
  const statusCalls = () => fixture.calls.filter((c) => c.url === '/thu-tok-auto/api/status').length
  const poll = () => Array.from(fixture.intervals.values()).find((i) => i.ms === 10000).fn()

  removed = true
  const before = statusCalls()
  poll()
  await settle()
  assert.match(fixture.stateEl().textContent, /插件接口未就绪（HTTP 404）/)
  assert.match(fixture.stateEl().textContent, /仍在每 10 秒重试/)
  assert.equal(fixture.intervals.size, 4, 'a 404 does not tear the widget down')

  poll()
  await settle()
  assert.equal(statusCalls(), before + 2, 'the next tick asks again instead of quoting a frozen error')

  removed = false
  poll()
  await settle()
  assert.equal(statusCalls(), before + 3)
  assert.doesNotMatch(fixture.stateEl().textContent, /插件接口未就绪/)
  assert.match(fixture.dotEl().getAttribute('aria-label'), /Token 有效/)
  assert.equal(fixture.boxEl().isConnected, true, 'the same widget heals; nothing is remounted')
})

test('an answered failure keeps its status even when the body is not ours', async () => {
  // A Host or proxy error page is not our JSON, so `data` is null. Calling that
  // "服务器返回了无效数据" would hide the two facts the user needs: that the Host answered at
  // all, and with which status. The status has to outrank an unreadable body.
  const fixture = browserFixture(async (url, init) => (init.method === 'POST'
    ? { status: 500, data: null }
    : { status: 200, data: { status: 'ok', credentialPresent: true } }))
  await settle()
  fixture.getButton().listeners.click()
  await settle()
  const diag = fixture.context.window.__mmtokUiDiag
  assert.equal(diag.lastResponse.status, 500, 'the Host answered: this is not a dead network')
  assert.equal(diag.lastFailure.status, 500)
  assert.equal(diag.lastFailure.method, 'POST')
  assert.equal(diag.lastFailure.endpoint, 'get-tok')
  assert.match(diag.lastFailureText, /^POST \/thu-tok-auto\/api\/get-tok；/)
  assert.match(diag.lastFailureText, /响应 HTTP 500/)
  assert.match(fixture.stateEl().textContent, /请求失败（HTTP 500）/)
  assert.doesNotMatch(fixture.stateEl().textContent, /无效数据/)
  assert.match(fixture.getButton().title, /HTTP 500/, 'the reading is on the control the user clicked')
  assert.equal(fixture.getButton().disabled, false, 'a refused request still leaves a way to retry')
})

test('every request is same-origin and page-relative, which is what carries the session', async () => {
  // The Host authorises this API with the DSH session cookie. `credentials: 'omit'` or an
  // absolute URL would make every call a cookie-less cross-origin request — the
  // `Failed to fetch` shape the panel must never manufacture for itself.
  const fixture = browserFixture(async () => ({
    status: 200,
    data: { status: 'ok', auto: false, autoEveryMs: 20 * 60e3, credentialPresent: true },
  }))
  await settle()
  fixture.getButton().listeners.click()
  await settle()
  fixture.nodes.find((n) => n.tag === 'button' && String(n.textContent).indexOf('Auto') === 0 && n.isConnected)
    .listeners.click()
  await settle()

  const seen = fixture.calls.map((c) => c.init.method + ' ' + c.url)
  assert.ok(seen.includes('GET /thu-tok-auto/api/status'), seen.join(', '))
  assert.ok(seen.includes('POST /thu-tok-auto/api/get-tok'), seen.join(', '))
  assert.ok(seen.includes('POST /thu-tok-auto/api/set-auto'), seen.join(', '))
  for (const call of fixture.calls) {
    assert.equal(call.init.credentials, 'same-origin', call.url)
    assert.equal(call.url.indexOf('/thu-tok-auto/api/'), 0, call.url + ' must stay relative to the page')
    if (call.init.method === 'GET') assert.equal(call.init.body, undefined)
    else assert.equal(call.init.headers['Content-Type'], 'application/json')
  }
})

test('Auto is the host answer: it survives a reload and never turns green on its own', async () => {
  // The switch is persisted by the Host (state.json) and this panel only reports it: a fresh
  // page shows the stored value with no click at all, and a click changes nothing until the
  // Host has answered. A green button is a claim that a schedule is running, so it may not
  // be painted optimistically.
  let on = true
  let answer = null
  const bodies = []
  const fixture = browserFixture(async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body)
      bodies.push(body)
      on = body.on
      await new Promise((resolve) => { answer = resolve })
      return { status: 200, data: { status: 'ok', auto: on } }
    }
    return {
      status: 200,
      data: { status: 'ok', version: '0.3.20', auto: on, autoEveryMs: 20 * 60e3, credentialPresent: true },
    }
  })
  await settle()
  const autoBtn = () => fixture.nodes.find((n) => n.tag === 'button'
    && String(n.textContent).indexOf('Auto') === 0 && n.isConnected)

  assert.equal(autoBtn().className, 'mmtok-btn mmtok-auto-on', 'a reload reports the stored switch')
  assert.equal(autoBtn().textContent, 'Auto ✓', 'the state is in words as well as in colour')
  assert.equal(autoBtn().getAttribute('aria-pressed'), 'true')
  assert.match(autoBtn().title, /Auto 已开启：计时超过 00:20/)

  autoBtn().listeners.click()
  await settle()
  assert.deepEqual(bodies, [{ on: false }], 'the click posts the state it wants and nothing else')
  assert.equal(autoBtn().className, 'mmtok-btn mmtok-auto-on', 'no answer yet: the old state stands')
  assert.equal(autoBtn().getAttribute('aria-pressed'), 'true')

  answer()
  await settle(); await settle(); await settle()
  assert.equal(autoBtn().className, 'mmtok-btn', 'the Host said off, so the button is off')
  assert.equal(autoBtn().textContent, 'Auto')
  assert.equal(autoBtn().getAttribute('aria-pressed'), 'false')
  assert.doesNotMatch(autoBtn().title, /已开启/)

  // The next poll re-reads the Host: the panel does not remember a wish of its own.
  Array.from(fixture.intervals.values()).find((i) => i.ms === 10000).fn()
  await settle()
  assert.equal(autoBtn().textContent, 'Auto')
  assert.equal(autoBtn().getAttribute('aria-pressed'), 'false')
})
