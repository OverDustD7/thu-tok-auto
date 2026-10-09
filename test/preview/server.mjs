// Dev-only isolated preview for lib/ui.js. It never touches the network and never
// asks the Host for anything: the widget is served exactly as the bundle serves it
// (same file, same URL path, same endpoints) with fabricated, redacted snapshots.
//
//   node test/preview/server.mjs [port]      # default http://127.0.0.1:8799
//
// Query parameters on the page:
//   ?scenario=ok|no-progress|partial|needs-login|offline|expired|busy|idle|long
//   ?scheme=dark|light   (dark flattens the shipped prefers-color-scheme rules,
//                         because the browser tooling cannot emulate the OS setting)
//   ?width=260           (sidebar width in px; 54 collapsed and 280 expanded are the
//                         host's real widths, 200 the narrow-but-expanded band)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
// Read per request: editing the shell or lib/ui.js should not require a restart.
const uiSource = () => fs.readFileSync(path.join(repo, 'lib', 'ui.js'), 'utf8')
const shell = () => fs.readFileSync(path.join(here, 'shell.html'), 'utf8')

const HOUR = 3600e3
const scenarios = {
  ok: () => ({
    auto: true, status: 'ok', loggedIn: true, via: 'mint', syncDetail: 'created',
    providerName: 'DeepSeek (THU)', credentialWritten: true, credentialPresent: true,
    lastGetAt: Date.now() - 20 * 60e3, expiresAt: Date.now() + 5.4 * HOUR, serverValid: true,
  }),
  'no-progress': () => ({
    auto: true, status: 'no-progress', loggedIn: true, via: 'mint', syncDetail: 'synced',
    providerName: 'DeepSeek (THU)', credentialPresent: true, renewalNoProgress: true,
    lastGetAt: Date.now() - 60e3, expiresAt: Date.now() + 40 * 60e3, serverValid: true,
    nearlyOut: true,
    err: '拿到的是同一张令牌：到期时间未前进，到期后需要重新登录',
  }),
  partial: () => ({
    auto: true, status: 'partial', loggedIn: true, via: 'mint', syncDetail: 'synced',
    providerName: 'DeepSeek (THU)', credentialPresent: true, lastGetAt: Date.now() - 60e3,
    expiresAt: Date.now() + 4 * HOUR, serverValid: true,
    err: '模型配置同步失败：Config field "providers.madmodel.models" is not volatile；',
  }),
  'needs-login': () => ({
    auto: true, status: 'needs-login', loggedIn: false, loginReason: 'renewal-unavailable',
    refreshBlocked: true, lastGetAt: Date.now() - 6.2 * HOUR, expiresAt: 0,
    err: '免登录签发已关闭、SSO 会话已过期：当前令牌仍可用，到期后需重新登录一次',
  }),
  offline: () => ({
    auto: true, status: 'ok', offline: true, loggedIn: true, via: 'reuse',
    syncDetail: '', providerName: 'DeepSeek (THU)', credentialPresent: true,
    lastGetAt: Date.now() - 32 * 60e3, expiresAt: Date.now() + 3 * HOUR, serverValid: true,
    err: '网络不可达：连不上 madmodel 站点，稍后自动重试',
  }),
  expired: () => ({
    auto: false, status: 'expired', loggedIn: false, refreshBlocked: false,
    lastGetAt: Date.now() - 8 * HOUR, expiresAt: Date.now() - 2 * HOUR,
    err: 'Token 已过期，点击 Get 重新获取',
  }),
  busy: () => ({
    auto: true, busy: true, status: 'refreshing', loggedIn: true, via: 'sso',
    providerName: 'DeepSeek (THU)', lastGetAt: Date.now() - 59 * 60e3,
    expiresAt: Date.now() + 4 * HOUR,
  }),
  idle: () => ({ auto: false, status: 'idle', loggedIn: false, lastGetAt: 0, expiresAt: 0 }),
  // One very long sentence: the state line is capped at three lines so a failure report
  // can never grow the footer over the buttons beneath it (2026-10-04).
  long: () => ({
    auto: true, status: 'partial', loggedIn: true, via: 'mint', syncDetail: 'synced',
    providerName: 'DeepSeek (THU)', credentialPresent: true, lastGetAt: Date.now() - 60e3,
    expiresAt: Date.now() + 4 * HOUR, serverValid: true,
    err: '模型配置同步失败：写入 providers.madmodel.models 时被拒绝，站点返回的模型清单包含一个已下线的条目，' +
      '插件没有覆盖你现有的模型设置；Token 本身已写入并可用，可以先用着，' +
      '等下一次自动刷新时重试；如果连续三次都失败，请把这段文字连同悬停提示一起反馈。',
  }),
}

let scenario = 'ok'
let autoOverride = null

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(shell())
    return
  }
  if (url.pathname === '/thu-tok-auto/ui.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(uiSource())
    return
  }
  if (url.pathname === '/__scenario') {
    scenario = url.searchParams.get('name') || 'ok'
    autoOverride = null
    json(res, { scenario })
    return
  }
  if (url.pathname === '/thu-tok-auto/api/status') {
    const payload = (scenarios[scenario] || scenarios.ok)()
    // An Auto click has to be visible in the next status read, otherwise this
    // harness would prove nothing about the toggle.
    if (autoOverride !== null) payload.auto = autoOverride
    json(res, payload)
    return
  }
  if (url.pathname === '/thu-tok-auto/api/get-tok') {
    // What a click would report, per scenario: the point is the wording and the
    // button state, not a real credential.
    const replies = {
      ok: { status: 'ok', via: 'mint', syncDetail: 'created', providerName: 'DeepSeek (THU)', expiresAt: Date.now() + 6 * HOUR },
      'no-progress': { status: 'no-progress', via: 'mint', renewalNoProgress: true, err: '拿到的是同一张令牌：到期时间未前进，到期后需要重新登录', loginRequired: false },
      partial: { status: 'partial', via: 'mint', err: '模型配置同步失败：Config field is not volatile；' },
      'needs-login': { status: 'needs-login', loginRequired: true },
      offline: { status: 'ok', offline: true, via: 'none', err: '网络不可达：连不上 madmodel 站点，稍后自动重试' },
      expired: { status: 'needs-login', loginRequired: true },
      busy: { status: 'ok', via: 'reuse' },
      idle: { status: 'ok', via: 'mint' },
      long: { status: 'partial', via: 'mint', err: '模型配置同步失败：写入 providers.madmodel.models 时被拒绝。' },
    }
    json(res, replies[scenario] || replies.ok)
    return
  }
  if (url.pathname === '/thu-tok-auto/api/open-login') {
    json(res, { launched: true })
    return
  }
  if (url.pathname === '/thu-tok-auto/api/set-auto') {
    // Flip a real flag so the panel's aria-pressed tracks the answer instead of
    // echoing a constant.
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let want = null
      try { want = JSON.parse(body || '{}').on } catch (e) { want = null }
      const current = autoOverride === null ? !!(scenarios[scenario] || scenarios.ok)().auto : autoOverride
      autoOverride = typeof want === 'boolean' ? want : !current
      json(res, { auto: autoOverride })
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

const port = Number(process.argv[2] || 8799)
server.listen(port, '127.0.0.1', () => {
  console.log('preview on http://127.0.0.1:' + port + '/?scenario=ok')
})
