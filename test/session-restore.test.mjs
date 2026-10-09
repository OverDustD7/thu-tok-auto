// Requirement 1 (2026-10-05 round 16): the session the plugin already holds has to be inside
// the browser *before* its first request to the site.
//
// This is deliberately not a test of call order. A real node:http server plays the debug
// endpoint and the site, and the browser stand-in is a WebSocket-shaped object that performs a
// real HTTP GET when it is told to `Page.navigate` — with the cookies it was actually handed,
// matched by domain and path the way a browser decides. The assertion reads the bytes the site
// received, so a restore that only looked right would fail here.
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { planSessionRestore, createSessionRestorer } from '../lib/index.js'

const UUID = 'e6678d25-1f2a-4a1b-9c3d-5e6f7a8b9c0d'
const OTHER_UUID = '11111111-2222-3333-4444-555555555555'
const NOW = 1791108083039 // 2026-10-05T02:41:23Z, the round-14 fixture time
// The dated cookie has to still be alive when this suite runs for real, so its expiry is
// measured from the wall clock while the *plan* is fed the fixture time above.
const LATER = Math.floor(Date.now() / 1000) + 3600

// Cookies as `state.cookieJar` holds them: CDP seconds, -1 = session (no expiry).
const jar = [
  { name: 'JSESSIONID', value: 'FIXTURE-JSESSION-VALUE', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, expires: -1 },
  { name: 'TSINGHUA_ID', value: 'FIXTURE-TSINGHUA-VALUE', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, sameSite: 'Lax', expires: LATER },
]

function fakeBrowser(state) {
  const instances = []
  class FakeWs {
    constructor(url) {
      this.url = url
      this.jar = []
      this.closed = false
      instances.push(this)
      setTimeout(() => { if (this.onopen) this.onopen() }, 0)
    }
    header(url) {
      const u = new URL(url)
      const nowSec = Math.floor(Date.now() / 1000)
      const parts = []
      for (const c of this.jar) {
        const d = String(c.domain || '').replace(/^\./, '')
        if (!(u.hostname === d || u.hostname.endsWith('.' + d))) continue
        if (!u.pathname.startsWith(String(c.path || '/'))) continue
        if (c.expires && c.expires > 0 && c.expires <= nowSec) continue
        parts.push(c.name + '=' + c.value)
      }
      return parts.join('; ')
    }
    // The real request: this is the byte that has to carry the cookie.
    visit(url) {
      const header = this.header(url)
      return new Promise((resolve) => {
        const u = new URL(url)
        const req = http.request({
          host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
          headers: header ? { Cookie: header } : {},
        }, (res) => { res.resume(); res.on('end', () => resolve()) })
        req.on('error', () => resolve())
        req.end()
      })
    }
    send(raw) {
      const msg = JSON.parse(raw)
      const back = (payload) => {
        setTimeout(() => { if (this.onmessage && !this.closed) this.onmessage({ data: JSON.stringify(payload) }) }, 0)
      }
      if (msg.method === 'Network.setCookie') {
        state.setCalls.push(msg.params)
        if (state.refuseCookies) return back({ id: msg.id, result: { success: false } })
        this.jar.push(msg.params)
        return back({ id: msg.id, result: { success: true } })
      }
      if (msg.method === 'Page.navigate') {
        state.navigated.push(msg.params.url)
        this.visit(msg.params.url).then(() => back({ id: msg.id, result: { frameId: 'F1' } }), () => back({ id: msg.id, result: { frameId: 'F1' } }))
        return
      }
      back({ id: msg.id, result: {} })
    }
    close() { this.closed = true }
  }
  return { FakeWs, instances }
}

async function withFixture(options, fn) {
  const state = {
    versionId: options.versionId === undefined ? UUID : options.versionId,
    pageUrl: options.pageUrl === undefined ? 'about:blank' : options.pageUrl,
    pageWsPort: options.pageWsPort,
    refuseCookies: !!options.refuseCookies,
    setCalls: [], navigated: [], site: [],
  }
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/json/version') {
      const ws = state.versionId ? 'ws://127.0.0.1:' + server.address().port + '/devtools/browser/' + state.versionId : ''
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ Browser: 'fake', webSocketDebuggerUrl: ws }))
    }
    if (path === '/json/list') {
      const pagePort = state.pageWsPort === undefined ? server.address().port : state.pageWsPort
      const list = state.pageUrl === null ? [] : [{
        id: 'P1', type: 'page', url: state.pageUrl,
        webSocketDebuggerUrl: 'ws://127.0.0.1:' + pagePort + '/devtools/page/P1',
      }]
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(list))
    }
    state.site.push({ path, cookie: req.headers.cookie || '', agent: req.headers['user-agent'] || '' })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>fixture site</title>ok')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const browser = fakeBrowser(state)
  const restore = createSessionRestorer({ WebSocket: browser.FakeWs, now: () => NOW })
  try {
    return await fn({ port, state, browser, restore, target: 'http://127.0.0.1:' + port + '/authLogin' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the first request the restored browser makes to the site already carries the saved session', async () => {
  await withFixture({}, async ({ port, state, browser, restore, target }) => {
    const r = await restore({ port, uuid: UUID, url: target, jar })
    assert.equal(r.ok, true, 'the restore has to report success')
    assert.equal(r.instanceMatched, true, 'the instance identity was checked before anything was sent')
    assert.equal(r.sent, 2, 'both usable cookies were accepted by the browser')
    assert.equal(r.navigated, true)
    assert.equal(state.setCalls.length, 2, 'the cookies went in over CDP, not by a shortcut')
    // The point of the whole exercise: what the site received.
    assert.equal(state.site.length, 1, 'exactly one request reached the site')
    const got = state.site[0].cookie
    assert.match(got, /JSESSIONID=FIXTURE-JSESSION-VALUE/, 'the session cookie was on the first request')
    assert.match(got, /TSINGHUA_ID=FIXTURE-TSINGHUA-VALUE/, 'and so was the second one')
    assert.equal(state.site[0].path, '/authLogin')
    // Session cookies are sent without an expiry; the persistent one keeps its own.
    const session = state.setCalls.find((c) => c.name === 'JSESSIONID')
    const kept = state.setCalls.find((c) => c.name === 'TSINGHUA_ID')
    assert.equal('expires' in session, false, 'a session cookie must not be given a fake expiry')
    assert.equal(kept.expires, LATER, 'a dated cookie keeps the expiry it had')
    assert.equal(kept.sameSite, 'Lax')
    assert.equal(session.httpOnly, true)
    // Values never come back out of the restore.
    assert.equal(JSON.stringify(r).includes('FIXTURE'), false, 'the report carries names, never values')
    assert.equal(browser.instances.length, 1, 'one page socket, opened once')
    assert.equal(browser.instances[0].closed, true, 'and it is closed again')
  })
})

test('a browser answering with another instance id is never handed a cookie', async () => {
  await withFixture({ versionId: OTHER_UUID }, async ({ port, state, browser, restore, target }) => {
    const r = await restore({ port, uuid: UUID, url: target, jar })
    assert.equal(r.reason, 'not-ours')
    assert.equal(r.instanceMatched, false)
    assert.equal(r.sent, 0)
    assert.equal(state.site.length, 0, 'no request of ours may reach the site through a stranger')
    assert.equal(browser.instances.length, 0, 'and no page socket is even opened')
  })
})

test('the plan keeps the identity fields, drops what is expired or foreign, and never rewrites a domain', () => {
  const mixed = [
    ...jar,
    { name: 'OTHER_SITE', value: 'FIXTURE-OTHER', domain: 'example.com', path: '/', secure: true, httpOnly: true, expires: -1 },
    { name: 'DOT_DOMAIN_ELSEWHERE', value: 'FIXTURE-DOT', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: -1 },
    { name: 'STALE', value: 'FIXTURE-STALE', domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, expires: Math.floor(NOW / 1000) - 10 },
    { name: 'BAD PATH', value: 'FIXTURE-BADPATH', domain: '127.0.0.1', path: 'nope', secure: false, httpOnly: false, expires: -1 },
    { name: 'WILD_SAMESITE', value: 'FIXTURE-WILD', domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, sameSite: 'Whatever', expires: -1 },
  ]
  const plan = planSessionRestore(mixed, 'http://127.0.0.1:9333/authLogin', NOW)
  assert.equal(plan.ok, true)
  assert.equal(plan.host, '127.0.0.1')
  assert.deepEqual(plan.cookies.map((c) => c.name), ['JSESSIONID', 'TSINGHUA_ID', 'WILD_SAMESITE'], 'only cookies that belong to this host and are still valid')
  assert.deepEqual(plan.skipped.sort(), ['BAD PATH', 'DOT_DOMAIN_ELSEWHERE', 'OTHER_SITE', 'STALE'])
  assert.equal('sameSite' in plan.cookies.find((c) => c.name === 'WILD_SAMESITE'), false, 'an unknown SameSite value is dropped rather than sent')
  // A domain is a fact about where the cookie came from; it is never widened to fit the target.
  assert.equal(plan.cookies.every((c) => c.domain === '127.0.0.1'), true)
  assert.equal(planSessionRestore(jar, 'http://example.com/authLogin', NOW).why, 'unsafe-target', 'plain http is only spoken to this machine')
  assert.equal(planSessionRestore([], 'http://127.0.0.1:9333/authLogin', NOW).why, 'no-cookies')
  assert.equal(planSessionRestore(jar, 'not a url', NOW).why, 'bad-url')
  assert.equal(JSON.stringify(plan).includes('FIXTURE-STALE'), false)
})

test('the browser decides by path: a cookie for another path stays home', async () => {
  const scoped = jar.concat([{ name: 'DEEP', value: 'FIXTURE-DEEP', domain: '127.0.0.1', path: '/other/', secure: false, httpOnly: false, expires: -1 }])
  assert.deepEqual(planSessionRestore(scoped, 'http://127.0.0.1:9/authLogin', NOW).cookies.map((c) => c.name), ['JSESSIONID', 'TSINGHUA_ID', 'DEEP'], 'the plan hands over what the jar holds for this host')
  await withFixture({}, async ({ port, state, restore, target }) => {
    const r = await restore({ port, uuid: UUID, url: target, jar: scoped })
    assert.equal(r.ok, true)
    assert.equal(r.sent, 3)
    const got = state.site[0].cookie
    assert.match(got, /JSESSIONID=/)
    assert.equal(got.includes('FIXTURE-DEEP'), false, 'a path that does not cover /authLogin is not sent there')
  })
})

test('a cookie the browser refuses is named, and a navigation without one is not a restore', async () => {
  await withFixture({ refuseCookies: true }, async ({ port, state, restore, target }) => {
    const r = await restore({ port, uuid: UUID, url: target, jar })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-cookie-accepted')
    assert.deepEqual(r.failed, ['JSESSIONID', 'TSINGHUA_ID'], 'the refusal is reported by name')
    assert.equal(r.sent, 0)
    assert.equal(state.site.length, 1, 'the page was still navigated')
    assert.equal(state.site[0].cookie, '', 'and it arrived without the session — which is why this counts as a failure')
  })
})

test('a page socket on another port, or no blank page, is refused before anything is sent', async () => {
  await withFixture({ pageWsPort: 1 }, async ({ port, state, browser, restore, target }) => {
    const r = await restore({ port, uuid: UUID, url: target, jar })
    assert.equal(r.reason, 'no-blank-target')
    assert.equal(r.instanceMatched, true, 'the browser itself was ours; the page target was not usable')
    assert.equal(state.setCalls.length, 0)
    assert.equal(browser.instances.length, 0)
  })
  await withFixture({ pageUrl: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/login' }, async ({ port, state, restore, target }) => {
    const r = await restore({ port, uuid: UUID, url: target, jar })
    assert.equal(r.reason, 'no-blank-target', 'an already-navigated page is not a blank slate we may write to')
    assert.equal(state.site.length, 0)
  })
})

test('nothing is attempted without an identity or a reachable endpoint', async () => {
  await withFixture({}, async ({ port, state, browser, restore, target }) => {
    const noId = await restore({ port, uuid: '', url: target, jar })
    assert.equal(noId.reason, 'no-identity')
    const badPort = await restore({ port: 80, uuid: UUID, url: target, jar })
    assert.equal(badPort.reason, 'bad-port')
    const silent = await restore({ port: port + 1, uuid: UUID, url: target, jar })
    assert.equal(silent.reason, 'endpoint-silent')
    assert.equal(state.setCalls.length, 0)
    assert.equal(browser.instances.length, 0)
    assert.equal(state.site.length, 0)
  })
})
