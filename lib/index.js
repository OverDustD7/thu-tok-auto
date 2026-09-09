'use strict';
// THU Tok Auto — DSH profile bundle (Cordis plugin) entry.
//
// Runs directly in the DSH host process: no node:vm sandbox, no subprocess helpers.
// Node's built-in fetch / WebSocket / fs / child_process provide the environment;
// DSH services provide settings, credentials, timers, the web server and request auth.
//
// Client UI is a plain global script (lib/ui.js) injected into the web app's HTML
// by webServer.tapIndex, talking to the JSON API below. Because the script tag is
// regenerated on every full page load, the buttons survive F5 (unlike the dynamic
// session-plugin form) while Host-side Auto keeps running regardless.
import fs from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createCore } from './core.js'

const name = 'thu-tok-auto'
const inject = ['settings', 'credentials', 'timer', 'webServer', 'connection']

const jsonParse = function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } }

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const done = (error, value) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) { req.destroy(); return done(new Error('body too large')) }
      chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { done(null, text ? JSON.parse(text) : {}) } catch (e) { done(new Error('invalid JSON')) }
    }
    const onError = (e) => done(e)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function json(res, value, code = 200) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

function apply(ctx) {
  const disposers = []
  const dispose = () => {
    for (const fn of disposers.splice(0).reverse()) { try { fn() } catch (e) { /* best-effort cleanup */ } }
  }
  try {
    const timer = ctx.get('timer')
    const settingsSvc = ctx.get('settings')
    const credSvc = ctx.get('credentials')
    const webServer = ctx.get('webServer')
    const connection = ctx.get('connection')
    if (!webServer || typeof webServer.register !== 'function') throw new Error('webServer service unavailable')
    if (!timer || typeof timer.interval !== 'function') throw new Error('timer service unavailable')
    if (!connection || typeof connection.requestRejection !== 'function') throw new Error('需要支持 connection.requestRejection 的 DSH 宿主。')

    const core = createCore({
      logger: console,
      clock: { now: () => Date.now() },
      // THU_TOK_AUTO_HOME lets tests (or users) relocate the state directory.
      env: {
        home: process.env.THU_TOK_AUTO_HOME || process.env.USERPROFILE || process.env.HOME || '',
        temp: process.env.TEMP || process.env.TMP || '',
        cwd: process.cwd(),
      },
      settings: settingsSvc,
      credentials: credSvc,
      timer,
      // Node 内置 fetch：与动态版子进程 helper 相同的语义（redirect manual 保留 Location）。
      http: async (url, options) => {
        const init = { redirect: options.follow === false ? 'manual' : 'follow', signal: AbortSignal.timeout(options.timeoutMs || 25000) }
        if (options.headers) init.headers = options.headers
        try {
          const r = await fetch(url, init)
          const text = await r.text()
          return { status: r.status, ok: r.ok, location: r.headers.get('location') || '', text }
        } catch (e) { return { error: String((e && e.message) || e) } }
      },
      // CDP 捕获：仅连本机 127.0.0.1 / localhost / [::1] 且端口匹配的调试端面，
      // 页面按 Tsinghua 域名打分选择，绝不回退到任意页面。
      cdp: async (arg) => {
        const port = arg.port || 9333
        const deadline = Date.now() + (arg.timeoutMs || 20000)
        let pages = null
        while (Date.now() < deadline) {
          try {
            const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) })
            if (r.ok) { pages = await r.json(); break }
          } catch (e) {}
          await new Promise((r) => setTimeout(r, 300))
        }
        if (!pages || !pages.length) return { ok: false, running: false, reason: 'no-devtools' }
        let target = null
        const hostname = (u) => { try { return new URL(u).hostname.toLowerCase() } catch (e) { return '' } }
        const score = (u) => {
          const h = hostname(u)
          if (h === 'madmodel.cs.tsinghua.edu.cn') return 3
          if (h === 'id.tsinghua.edu.cn' || h === 'oauth.tsinghua.edu.cn') return 2
          if (h === 'tsinghua.edu.cn' || h.endsWith('.tsinghua.edu.cn')) return 1
          return 0
        }
        let best = 0
        for (const p of pages) {
          if (p.type === 'page') {
            const s = score(p.url || '')
            if (s > best) { best = s; target = p }
          }
        }
        if (!target || !target.webSocketDebuggerUrl) return { ok: false, running: true, reason: 'no-target' }
        if (arg.probeOnly) return { ok: true, running: true, url: target.url || '' }
        let debuggerUrl = null
        try { debuggerUrl = new URL(target.webSocketDebuggerUrl) } catch (e) {}
        const debuggerHost = debuggerUrl ? debuggerUrl.hostname.toLowerCase() : ''
        if (!debuggerUrl || debuggerUrl.protocol !== 'ws:' ||
            (debuggerHost !== '127.0.0.1' && debuggerHost !== 'localhost' && debuggerHost !== '[::1]') ||
            Number(debuggerUrl.port) !== port) return { ok: false, running: true, reason: 'unsafe-debugger-url' }
        const ws = new WebSocket(debuggerUrl.href)
        let nextId = 1
        const pending = {}
        const send = (method, params) => new Promise((resolve, reject) => {
          const id = nextId++
          pending[id] = { resolve, reject }
          try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { delete pending[id]; reject(e); return }
          setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('cdp timeout ' + method)) } }, 8000)
        })
        ws.onmessage = (ev) => {
          try {
            const m = jsonParse(ev.data)
            if (m && m.id && pending[m.id]) { pending[m.id].resolve(m); delete pending[m.id] }
          } catch (e) {}
        }
        await new Promise((resolve, reject) => {
          ws.onopen = resolve
          ws.onerror = () => reject(new Error('ws error'))
          setTimeout(() => reject(new Error('ws open timeout')), 6000)
        })
        try { await send('Network.enable', {}) } catch (e) {}
        let ck = null
        try { ck = await send('Network.getAllCookies', {}) } catch (e) {}
        let ev = null
        try {
          ev = await send('Runtime.evaluate', {
            expression: "(function(){try{var u=window.localStorage.getItem('user');var t='';if(u){try{t=(JSON.parse(u).token)||''}catch(e){}}return JSON.stringify({token:t,url:location.href})}catch(e){return JSON.stringify({error:String(e)})}})()",
            returnByValue: true,
          })
        } catch (e) {}
        const cookies = (ck && ck.result && ck.result.cookies) || []
        const picked = []
        for (const c of cookies) {
          const d = String(c.domain || '').toLowerCase().replace(/^\.+/, '')
          if (d === 'tsinghua.edu.cn' || d.endsWith('.tsinghua.edu.cn')) picked.push({ name: c.name, value: c.value, domain: d, secure: !!c.secure, httpOnly: !!c.httpOnly })
        }
        let token = ''
        let url = ''
        try {
          const rv = ev && ev.result && ev.result.result && ev.result.result.value
          if (rv) { const j = jsonParse(rv); url = typeof j.url === 'string' ? j.url : ''; if (hostname(url) === 'madmodel.cs.tsinghua.edu.cn' && typeof j.token === 'string') token = j.token }
        } catch (e) {}
        try { ws.close() } catch (e) {}
        return { ok: true, token, url, cookies: picked }
      },
      // 状态文件：%USERPROFILE%\.dsh\madmodel\state.json，原子写（tmp + rename + chmod 0600），
      // 与 0.2.x 动态版同一路径，正式版无缝接管已有数据。
      stateIO: {
        async mkdir(path) { try { fs.mkdirSync(path, { recursive: true }); return { ok: true } } catch (e) { return { ok: false, error: String((e && e.message) || e) } } },
        async load(path) {
          try {
            if (fs.existsSync(path)) return { ok: true, data: jsonParse(fs.readFileSync(path, 'utf8')) }
            return { ok: true, data: null }
          } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        },
        async save(path, data) {
          try {
            fs.mkdirSync(dirname(path), { recursive: true })
            const tmp = path + '.tmp-' + process.pid
            fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
            fs.renameSync(tmp, path)
            try { fs.chmodSync(path, 0o600) } catch (e) {}
            return { ok: true }
          } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        },
      },
      findExecutable: async (candidate) => {
        try { return fs.existsSync(candidate) ? candidate : null } catch (e) { return null }
      },
      spawnBrowser: (exe, argv) => {
        const child = spawn(exe, argv, {
          cwd: process.env.SystemRoot || 'C:\\Windows',
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
        child.on('error', () => {})
        return { pid: child.pid }
      },
    })

    const rejectReq = (req) => {
      try { return connection.requestRejection(req) } catch (e) { return undefined }
    }
    function route(method, endpoint, handler) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/thu-tok-auto/api/' + endpoint,
        handler: async (req, res) => {
          try {
            const rejection = rejectReq(req)
            if (rejection !== undefined) return json(res, { ok: false, error: rejection === 401 ? '请先登录 DSH。' : '请求来源不受信任。' }, rejection)
            if (req.method !== method) return json(res, { ok: false, error: '请求方法不支持。' }, 405)
            if (method === 'POST') {
              if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, { ok: false, error: '仅接受 application/json。' }, 415)
              const body = await readBody(req)
              return json(res, await handler(body))
            }
            return json(res, await handler(undefined))
          } catch (e) { json(res, { ok: false, error: String((e && e.message) || e) }, 500) }
        },
      }))
    }
    route('GET', 'status', () => core.state())
    route('POST', 'get-tok', () => core.getTok())
    route('POST', 'open-login', () => core.openLogin())
    route('POST', 'set-auto', (body) => core.setAuto(!!(body && body.on)))

    const uiUrl = new URL('./ui.js', import.meta.url)
    if (fs.existsSync(uiUrl)) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/thu-tok-auto/ui.js',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
          res.end(fs.readFileSync(uiUrl, 'utf8'))
        },
      }))
      disposers.push(webServer.tapIndex((html) => {
        if (html.includes('/thu-tok-auto/ui.js')) return html
        const tag = '<script defer src="/thu-tok-auto/ui.js"></script>'
        return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
      }))
    }

    // Auto-refresh lives in the Host: it keeps running no matter what the page does.
    core.init().catch((e) => console.error('[thu-tok-auto] initial load', e))
    disposers.push(timer.interval(() => {
      return core.autoTick().catch((e) => console.error('[thu-tok-auto] auto tick', e))
    }, 30000))

    ctx.effect(() => dispose)
    return
  } catch (e) {
    console.error('[thu-tok-auto] 插件未启用：', (e && e.message) || e)
    dispose()
    return
  }
}

export { name, inject, apply }