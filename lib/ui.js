// THU Tok Auto — browser UI (plain global script, no framework).
// Injected into every full page load by the host's webServer.tapIndex, so the
// buttons survive F5 (unlike the dynamic session-plugin form). Talks to the
// JSON API at /thu-tok-auto/api/*; Auto refresh itself runs Host-side.
(function () {
  'use strict';
  if (window.__mmtokUiLoaded) return
  window.__mmtokUiLoaded = true

  var API = '/thu-tok-auto/api'
  var store = {
    auto: false, busy: false, lastGetAt: 0, loggedIn: false, status: 'idle', err: '',
    expiresAt: 0, browserOpen: false, provider: '', credentialWritten: false,
  }
  var box = null
  var dotEl = null
  var getBtn = null
  var autoBtn = null
  var elapsedEl = null
  var warnEl = null

  var pad = function (n) { return (n < 10 ? '0' : '') + n }
  var fmt = function (ms) {
    if (!ms || ms < 0) return '--:--'
    var sec = Math.floor(ms / 1000)
    var hh = Math.floor(sec / 3600)
    if (hh >= 100) return 'Too Long!'
    return pad(hh) + ':' + pad(Math.floor((sec % 3600) / 60))
  }
  var expiresText = function (at) {
    if (!at) return ''
    var ms = at - Date.now()
    if (ms <= 0) return '已过期'
    var min = Math.floor(ms / 60000)
    return '剩余 ' + Math.floor(min / 60) + 'h' + pad(min % 60) + 'm'
  }
  var statusText = function () {
    var s = store
    var t = ''
    if (s.busy) t = '获取中…'
    else if (s.status === 'needs-login') t = s.browserOpen ? '需要登录 · 窗口已打开' : '需要登录'
    else if (s.status === 'error') t = '出错：' + (s.err || '')
    else if (s.status === 'expired') t = 'token 已过期 · 点 Get'
    else if (s.status === 'ok') {
      t = s.credentialWritten ? ('已写入 ' + (s.provider || 'DeepSeek (THU)')) : 'token 已获取'
      var ex = expiresText(s.expiresAt)
      if (ex) t += ' · ' + ex
    } else if (s.status === 'refreshing') t = '获取中…'
    else t = '未获取 · 点 Get'
    if (s.err && s.status !== 'error') t += ' · ' + s.err
    return t
  }
  var titleText = function () {
    var s = store
    var parts = ['THU Tok Auto']
    if (s.lastGetAt) parts.push('距上次获取 ' + fmt(Date.now() - s.lastGetAt))
    if (s.expiresAt) parts.push('token ' + expiresText(s.expiresAt))
    if (s.auto) parts.push('Auto 开启：超过 05:50 自动刷新')
    parts.push('Get / Auto 在左下角侧边栏')
    return parts.join(' · ')
  }

  function jsonRequest(method, endpoint, body) {
    return fetch(API + '/' + endpoint, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (r) { return r.json().catch(function () { return null }) })
  }

  var refresh = function () {
    return jsonRequest('GET', 'status').then(function (s) {
      if (!s) return
      store.auto = !!s.auto; store.busy = !!s.busy; store.lastGetAt = s.lastGetAt || 0
      store.loggedIn = !!s.loggedIn; store.status = s.status || 'idle'; store.err = s.err || ''
      store.expiresAt = s.expiresAt || 0
      store.browserOpen = !!s.browserOpen; store.provider = s.provider || ''
      store.credentialWritten = !!s.credentialWritten
      render()
    }).catch(function () {})
  }

  var runGet = function () {
    if (store.busy) return
    store.busy = true
    render()
    jsonRequest('POST', 'get-tok').then(function (r) {
      if (r && r.loginRequired) {
        return jsonRequest('POST', 'open-login').catch(function () {})
      }
    }).catch(function () {}).then(function () { return refresh() })
  }

  var setAuto = function (on) {
    return jsonRequest('POST', 'set-auto', { on: on }).then(function (r) {
      if (r) store.auto = !!r.auto
    }).then(function () { return refresh() }).catch(function () {})
  }

  function ensureDom() {
    if (box && document.body && box.isConnected) return
    if (box && box.parentNode) box.parentNode.removeChild(box)
    box = document.createElement('div')
    box.className = 'mmtok-box'
    var btns = document.createElement('div')
    btns.className = 'mmtok-btns'
    dotEl = document.createElement('span')
    dotEl.className = 'mmtok-dot mmtok-off'
    getBtn = document.createElement('button')
    getBtn.className = 'mmtok-btn'
    getBtn.textContent = 'Get'
    getBtn.addEventListener('click', runGet)
    autoBtn = document.createElement('button')
    autoBtn.className = 'mmtok-btn'
    autoBtn.textContent = 'Auto'
    autoBtn.addEventListener('click', function () { setAuto(!store.auto) })
    var sep = document.createElement('span')
    sep.className = 'mmtok-sep'
    elapsedEl = document.createElement('span')
    elapsedEl.className = 'mmtok-elapsed'
    elapsedEl.textContent = '--:--'
    warnEl = document.createElement('span')
    warnEl.className = 'mmtok-timer-status'
    btns.appendChild(dotEl)
    btns.appendChild(getBtn)
    btns.appendChild(autoBtn)
    btns.appendChild(sep)
    btns.appendChild(elapsedEl)
    btns.appendChild(warnEl)
    box.appendChild(btns)
    document.body.appendChild(box)
  }

  function render() {
    ensureDom()
    var s = store
    box.title = titleText()
    dotEl.className = 'mmtok-dot mmtok-' + (s.busy ? 'busy' : s.status === 'ok' ? 'ok' : 'off')
    getBtn.className = 'mmtok-btn' + (s.busy ? ' mmtok-disabled' : '')
    getBtn.disabled = !!s.busy
    getBtn.textContent = s.busy ? '…' : 'Get'
    getBtn.title = statusText() + '\n点击获取最新 token：校园网自动签发并写入 THU Tok Auto (MadModel) 模型配置'
    autoBtn.className = 'mmtok-btn' + (s.auto ? ' mmtok-auto-on' : '')
    autoBtn.textContent = s.auto ? 'Auto ✓' : 'Auto'
    autoBtn.title = s.auto ? 'Auto 已开启：计时超过 05:50 自动 Get（点击关闭）' : '开启 Auto：计时超过 05:50 自动 Get'
    elapsedEl.textContent = fmt(s.lastGetAt ? Date.now() - s.lastGetAt : 0)
    warnEl.textContent = s.busy ? '…' : (s.status === 'needs-login' ? '⚠' : '')
  }

  var css = [
    '.mmtok-box{position:fixed;left:8px;bottom:114px;z-index:900;pointer-events:auto;}',
    '.mmtok-btns{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:7px;background:transparent;border:1px solid rgba(128,128,128,.4);width:max-content;}',
    '.mmtok-btn{font-size:14px;line-height:1.5;padding:0 6px;border-radius:5px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;flex:none;}',
    '.mmtok-btn:hover{border-color:rgba(128,128,128,.85);background:rgba(128,128,128,.18);}',
    '.mmtok-btn.mmtok-auto-on{background:#4caf50;color:#fff;border-color:#4caf50;}',
    '.mmtok-btn.mmtok-auto-on:hover{background:#43a047;border-color:#43a047;color:#fff;}',
    '.mmtok-disabled{opacity:.5;cursor:default;}',
    '.mmtok-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
    '.mmtok-ok{background:#4caf50;}',
    '.mmtok-busy{background:#ffb300;animation:mmtok-pulse 1s infinite;}',
    '.mmtok-off{background:#9e9e9e;}',
    '@keyframes mmtok-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '.mmtok-sep{width:1px;height:14px;background:rgba(128,128,128,.5);flex:none;}',
    '.mmtok-elapsed{font-size:14px;font-variant-numeric:tabular-nums;color:inherit;user-select:none;line-height:1;font-family:ui-monospace,Consolas,monospace;}',
    '.mmtok-timer-status{min-width:8px;color:#ffb300;font-size:14px;}',
  ].join('')

  function injectStyle() {
    var id = 'mmtok-style'
    if (document.getElementById(id)) return
    var style = document.createElement('style')
    style.id = id
    style.textContent = css
    document.head.appendChild(style)
  }

  function boot() {
    injectStyle()
    ensureDom()
    refresh()
    setInterval(function () { render() }, 1000)
    setInterval(function () { refresh() }, 10000)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()