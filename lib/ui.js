// THU Tok Auto — browser UI (plain global script, no framework).
// Injected into every full page load through DSH's structured index table.
//
// Placement (per spec): inside the DSH sidebar foot, right ABOVE the settings
// row. If other plugins (e.g. Remote's sidebar.footer.action entry) already sit
// above settings, the widget is inserted at the very top of the foot area —
// i.e. above the topmost button. If the foot area cannot be located, the widget
// is inserted directly above the settings row; if the settings trigger is not
// found at all, the widget stays hidden and mounting is retried every 2s.
(function () {
  'use strict';
  if (typeof window.__mmtokUiCleanup === 'function') window.__mmtokUiCleanup()
  else if (window.__mmtokUiLoaded) return
  window.__mmtokUiLoaded = true

  var API = '/thu-tok-auto/api'
  var store = {
    auto: false, busy: false, lastGetAt: 0, loggedIn: false, status: 'idle', err: '',
    expiresAt: 0, browserOpen: false, provider: '', providerName: '', credentialWritten: false,
  }
  var box = null
  var dotEl = null
  var getBtn = null
  var autoBtn = null
  var elapsedEl = null
  var warnEl = null
  var intervalIds = []

  function cleanup() {
    for (var i = 0; i < intervalIds.length; i++) clearInterval(intervalIds[i])
    intervalIds = []
    document.removeEventListener('DOMContentLoaded', boot)
    if (box && box.parentNode) box.parentNode.removeChild(box)
    var style = document.getElementById('mmtok-style')
    if (style && style.parentNode) style.parentNode.removeChild(style)
    box = null
    window.__mmtokUiLoaded = false
    if (window.__mmtokUiCleanup === cleanup) window.__mmtokUiCleanup = null
  }
  window.__mmtokUiCleanup = cleanup

  var pad = function (n) { return (n < 10 ? '0' : '') + n }
  var fmt = function (ms) {
    if (!ms || ms < 0) return '--:--'
    var sec = Math.floor(ms / 1000)
    var hh = Math.floor(sec / 3600)
    if (hh >= 100) return 'Too Long!'
    return pad(hh) + ':' + pad(Math.floor((sec % 3600) / 60))
  }
  var remainText = function (at) {
    if (!at) return ''
    var ms = at - Date.now()
    if (ms <= 0) return ''
    var min = Math.floor(ms / 60000)
    return Math.floor(min / 60) + 'h' + pad(min % 60) + 'm'
  }
  // One-line current-state summary (used by the dot and the Get button).
  var statusLine = function () {
    var s = store
    if (s.busy) return '正在获取 Token…'
    if (s.status === 'needs-login') return '需要登录：点击 Get 打开登录窗口'
    if (s.status === 'error') return '出错了：' + (s.err || '未知错误')
    if (s.status === 'expired') return 'Token 已过期，点击 Get 重新获取'
    if (s.status === 'refreshing') return '正在自动刷新 Token…'
    if (s.status === 'ok') return s.credentialWritten
      ? '已更新 ' + (s.providerName || 'DeepSeek (THU)') + ' 模型配置'
      : '已获取 Token'
    return '尚未获取 Token，点击 Get 获取'
  }
  // Multi-line hover text for the whole widget.
  var titleText = function () {
    var s = store
    var lines = ['THU Tok Auto']
    lines.push(statusLine())
    var info = []
    if (s.lastGetAt) info.push('上次获取 ' + fmt(Date.now() - s.lastGetAt) + ' 前')
    if (s.expiresAt) {
      var rem = remainText(s.expiresAt)
      info.push(rem ? ('Token 剩余 ' + rem) : 'Token 已过期')
    }
    if (info.length) lines.push(info.join(' · '))
    lines.push(s.auto
      ? 'Auto 已开启：计时超过 05:50 自动获取，点击 Auto 关闭'
      : 'Auto 已关闭：点击开启，计时超过 05:50 自动获取')
    return lines.join('\n')
  }

  function jsonRequest(method, endpoint, body) {
    var init = {
      method: method,
      credentials: 'same-origin',
    }
    if (method === 'POST' || body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body === undefined ? {} : body)
    }
    return fetch(API + '/' + endpoint, init).then(function (r) {
      return r.json().catch(function () { return null }).then(function (data) {
        if (!r.ok) {
          var error = new Error((data && data.error) || ('请求失败（HTTP ' + r.status + '）'))
          error.status = r.status
          throw error
        }
        if (!data) throw new Error('服务器返回了无效数据')
        return data
      })
    })
  }

  function showRequestError(error) {
    if (error && error.status === 404) { cleanup(); return }
    store.busy = false
    store.status = 'error'
    store.err = 'DSH 通信失败：' + String((error && error.message) || error || '未知错误')
    render()
  }

  var refresh = function () {
    return jsonRequest('GET', 'status').then(function (s) {
      if (!s) return
      store.auto = !!s.auto; store.busy = !!s.busy; store.lastGetAt = s.lastGetAt || 0
      store.loggedIn = !!s.loggedIn; store.status = s.status || 'idle'; store.err = s.err || ''
      store.expiresAt = s.expiresAt || 0
      store.browserOpen = !!s.browserOpen; store.provider = s.provider || ''
      store.providerName = s.providerName || ''
      store.credentialWritten = !!s.credentialWritten
      render()
    }).catch(showRequestError)
  }

  var runGet = function () {
    if (store.busy) return
    store.busy = true
    render()
    jsonRequest('POST', 'get-tok').then(function (r) {
      if (r && r.loginRequired) {
        return jsonRequest('POST', 'open-login')
      }
    }).then(function () { return refresh() }).catch(showRequestError)
  }

  var setAuto = function (on) {
    return jsonRequest('POST', 'set-auto', { on: on }).then(function (r) {
      if (r) store.auto = !!r.auto
    }).then(function () { return refresh() }).catch(showRequestError)
  }

  // ---- sidebar foot placement ---------------------------------------------
  function findSettingsTrigger() {
    var q = document.querySelector('button[aria-label="设置"], button[title="设置"], button[aria-label="Settings"], button[title="Settings"]')
    if (q) return q
    var all = document.querySelectorAll('button')
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].getAttribute('aria-label') || all[i].title || all[i].textContent || '').trim()
      if (t === '设置' || t.toLowerCase() === 'settings') return all[i]
    }
    return null
  }
  function footAreaOf(trigger) {
    // settings trigger -> triggerRow -> [data-slot=sidebar.settings] -> settingsArea -> footArea
    var node = trigger
    var foot = null
    for (var i = 0; i < 6 && node; i++) {
      var cls = String(node.className || '')
      if (cls.indexOf('footArea') >= 0 || cls.indexOf('footerActions') >= 0) { foot = node; break }
      node = node.parentElement
    }
    return foot
  }
  function tryMount() {
    if (box && box.isConnected) return true
    ensureDom()
    var trigger = findSettingsTrigger()
    if (!trigger) return false
    var foot = footAreaOf(trigger)
    if (foot) {
      // Above EVERY existing footer button (Remote et al.): insert as first child.
      foot.insertBefore(box, foot.firstChild)
    } else {
      // Degrade: directly above the settings row.
      if (!trigger.parentElement) return false
      trigger.parentElement.insertBefore(box, trigger)
    }
    return box.isConnected
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
    warnEl = document.createElement('span')
    warnEl.className = 'mmtok-timer-status'
    elapsedEl = document.createElement('span')
    elapsedEl.className = 'mmtok-elapsed'
    elapsedEl.textContent = '--:--'
    btns.appendChild(dotEl)
    btns.appendChild(getBtn)
    btns.appendChild(autoBtn)
    btns.appendChild(warnEl)
    btns.appendChild(elapsedEl)
    box.appendChild(btns)
  }

  function render() {
    if (!box || !box.isConnected) return
    var s = store
    box.title = titleText()
    dotEl.className = 'mmtok-dot mmtok-' + (s.busy ? 'busy' : s.status === 'ok' ? 'ok' : 'off')
    dotEl.title = statusLine()
    getBtn.className = 'mmtok-btn' + (s.busy ? ' mmtok-disabled' : '')
    getBtn.disabled = !!s.busy
    getBtn.textContent = 'Get'
    getBtn.title = statusLine() + '\n点击获取最新 Token 并写入 DeepSeek (THU) 模型配置'
    autoBtn.className = 'mmtok-btn' + (s.auto ? ' mmtok-auto-on' : '')
    autoBtn.textContent = s.auto ? 'Auto ✓' : 'Auto'
    autoBtn.title = s.auto
      ? 'Auto 已开启：计时超过 05:50 自动获取，点击关闭'
      : 'Auto 已关闭：点击开启，计时超过 05:50 自动获取'
    var el = fmt(s.lastGetAt ? Date.now() - s.lastGetAt : 0)
    elapsedEl.textContent = el
    elapsedEl.title = '距上次获取 ' + el + (s.auto ? '，超过 05:50 自动刷新' : '，超过 05:50 后可点击 Auto 开启自动刷新')
    warnEl.textContent = s.status === 'needs-login' ? '⚠' : ''
    warnEl.title = '需要登录：点击 Get 打开登录窗口'
  }

  // Sidebar-foot widget: buttons left, timer pushed flush right, no divider
  // lines. Auto ON = green button labeled "Auto ✓" (matches the original look).
  var css = [
    '.mmtok-box{display:block;padding:6px 10px 6px 11px;width:100%;box-sizing:border-box;pointer-events:auto;}',
    '.mmtok-btns{display:inline-flex;align-items:center;gap:12px;width:100%;max-width:100%;box-sizing:border-box;}',
    '.mmtok-btn{font-size:14px;line-height:1.6;padding:0 8px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;flex:none;}',
    '.mmtok-btn:hover{border-color:rgba(128,128,128,.85);background:rgba(128,128,128,.18);}',
    '.mmtok-btn.mmtok-auto-on{background:#4caf50;color:#fff;border-color:#4caf50;}',
    '.mmtok-disabled{opacity:.5;cursor:default;}',
    '.mmtok-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
    '.mmtok-ok{background:#4caf50;}',
    '.mmtok-busy{background:#ffb300;animation:mmtok-pulse 1s infinite;}',
    '.mmtok-off{background:#9e9e9e;}',
    '@keyframes mmtok-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '.mmtok-timer-status{min-width:0;color:#ffb300;font-size:14px;flex:none;}',
    '.mmtok-elapsed{margin-left:auto;font-size:14px;font-variant-numeric:tabular-nums;color:inherit;user-select:none;line-height:1;font-family:ui-monospace,Consolas,monospace;flex:none;padding-right:0;}',
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
    tryMount()
    refresh()
    // Re-mount if the sidebar re-renders (React swaps nodes) or was missing.
    intervalIds.push(setInterval(function () { render() }, 1000))
    intervalIds.push(setInterval(function () { refresh() }, 10000))
    intervalIds.push(setInterval(function () { tryMount() }, 2000))
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
