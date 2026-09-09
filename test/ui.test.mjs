import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = fs.readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8')
const settle = () => new Promise((resolve) => setImmediate(resolve))

// Minimal DOM fixture: execute the shipped script and click its real listeners.
function browserFixture(respond) {
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
    }
    nodes.push(node)
    return node
  }
  const body = element('body'); body.root = true
  const head = element('head'); head.root = true
  const foot = body.appendChild(element('div')); foot.className = 'sidebar_footArea'
  const remote = foot.appendChild(element('button')); remote.textContent = 'Remote'
  const settings = foot.appendChild(element('button')); settings['aria-label'] = 'Settings'
  const intervals = new Map()
  let nextId = 0
  const calls = []
  const document = {
    readyState: 'complete', body, head,
    createElement: element,
    getElementById: (id) => nodes.find((n) => n.id === id && n.isConnected),
    querySelector: () => settings,
    querySelectorAll: () => nodes.filter((n) => n.tag === 'button' && n.isConnected),
    addEventListener() {}, removeEventListener() {},
  }
  const context = vm.createContext({
    document, window: {},
    setInterval(fn, ms) { const id = ++nextId; intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { intervals.delete(id) },
    fetch: async (url, init) => {
      calls.push({ url, init })
      const response = await respond(url, init)
      return { ok: response.status < 400, status: response.status, json: async () => response.data }
    },
  })
  vm.runInContext(source, context)
  return { context, nodes, foot, remote, intervals, calls,
    getButton: () => nodes.find((n) => n.tag === 'button' && n.textContent === 'Get' && n.isConnected),
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

test('UI duplicate loads and a removed API clean up nodes and timers', async () => {
  let removed = false
  const fixture = browserFixture(async () => ({ status: removed ? 404 : 200, data: { status: 'idle' } }))
  await settle()
  vm.runInContext(source, fixture.context)
  await settle()
  assert.equal(fixture.intervals.size, 3)
  assert.equal(fixture.nodes.filter((n) => n.className === 'mmtok-box' && n.isConnected).length, 1)
  removed = true
  Array.from(fixture.intervals.values()).find((i) => i.ms === 10000).fn()
  await settle()
  assert.equal(fixture.intervals.size, 0)
  assert.equal(fixture.getButton(), undefined)
})
