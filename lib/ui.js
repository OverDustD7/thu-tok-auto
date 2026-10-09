// THU Tok Auto — browser UI (plain global script, no framework).
// Injected into every full page load through DSH's structured index table.
//
// Placement (per spec): inside the DSH sidebar foot, right ABOVE the settings
// row. If other plugins (e.g. Remote's sidebar.footer.action entry) already sit
// above settings, the widget is inserted at the very top of the foot area —
// i.e. above the topmost button. If the foot area cannot be located, the widget
// is inserted directly above the settings row; if the settings trigger is not
// found at all, the widget stays hidden and mounting is retried every 2s.
//
// Status is never colour-only. The dot carries an aria-label, and a second line
// appears as soon as something needs the user (login required, expired, renewal
// not advancing, model config not synced, or a token inside its last hour).
// Healthy states stay quiet and compact: one row, same height as before.
(function () {
  'use strict';
  // Diagnostic surface, readable in the page console (`__mmtokUiDiag`). The sidebar is the
  // only place this widget can report from, so when it never appears the page itself must
  // still be able to say why: counters and reasons only, never a token or a cookie.
  var diag = window.__mmtokUiDiag = {
    loads: 0, takeovers: 0, booted: false, mounted: false, mounts: 0, remounts: 0,
    lastMount: '', lastError: '', scriptTags: 0,
    // Request readings (2026-10-04): a click, the last response that arrived, and the
    // last failure with the URL the browser actually used. Counters and facts only —
    // never a token, never a cookie.
    clicks: 0, lastClickAt: 0, failures: 0,
    lastResponse: null, lastOk: null, lastFailure: null, lastFailureText: '',
  }
  diag.loads += 1
  diag.scriptTags = document.querySelectorAll('script[src*="thu-tok-auto/ui.js"]').length
  // A previous *injection* must not lock the page out of ever having a widget again. The
  // flag alone is not proof of life: it outlives its widget whenever the node it lived in
  // was replaced (sidebar re-render, collapsed rail, restored layout), and from then on
  // every later load returned here while the panel stayed empty and the console stayed
  // quiet. Only a live style tag plus a live box may keep us out (2026-10-04 real run).
  var previousAlive = window.__mmtokUiLoaded === true
    && !!document.getElementById('mmtok-style')
    && !!document.querySelector('.mmtok-box')
  if (typeof window.__mmtokUiCleanup === 'function') {
    try { window.__mmtokUiCleanup() } catch (e) { diag.lastError = 'cleanup: ' + String((e && e.message) || e) }
  } else if (previousAlive) {
    return
  } else if (window.__mmtokUiLoaded === true) {
    diag.takeovers += 1
  }
  window.__mmtokUiLoaded = true

  var API = '/thu-tok-auto/api'
  // A one-off notice ("已签发新令牌") is feedback, not a permanent label.
  var NOTICE_MS = 15 * 1000
  // The host sidebar has two real widths: a ~54px collapsed rail and a 260–280px
  // expanded panel (measured on the running DSH, 2026-10-04). At 54px this widget's
  // content box is ~34px wide, so the button row used to wrap one control per line
  // and the state sentence one character per line, stretching the footer to the
  // height of the sidebar. Below this width the widget becomes a single status
  // entry (the dot) instead. The width is read from the container the widget was
  // actually inserted into — never from the browser viewport, because a narrow
  // window with an expanded sidebar must still get the full row.
  var COMPACT_BOX_MAX_W = 150
  // Host-side reasons for a login window that did not open, in user terms.
  var LOGIN_REASON_TEXT = {
    'renewal-unavailable': '自动续期通道不可用（免登录签发已关闭、SSO 会话不可用）',
    // 2026-10-04 real evidence: with a session the IDP still recognises, the entry answers a
    // double-auth form that needs a browser-side device fingerprint — the session did not
    // expire, so this reason must not be reported as one.
    'fingerprint-required': 'SSO 会话仍被识别，但续期需浏览器完成设备指纹校验（点一次 Get 打开登录窗口）',
    // 2026-10-04 round 5: the background renewal either was refused (a real login form on
    // the other side) or ran in a headless browser of the plugin's own and did not finish.
    // Both mean the same thing to the user, and neither is "renewal is broken".
    'needs-manual-login': '需要本人登录一次：后台免密续期走不通，点一次 Get 打开登录窗口',
    offline: '网络不可达：连不上 madmodel 站点',
    // 2026-10-05 round 13: 载体失败不是会话失败，真人要做的事也不一样。端口上有本插件上
    // 一次留下的浏览器（身份对得上、却没能确证关掉）时，"再登录一次"是没有用的一句话 ——
    // 这两条必须与 needs-manual-login 分开，否则面板会让人去做一件帮不上忙的事。
    // 2026-10-05 round 17: 这两句从此不再让人去手动关浏览器 —— 插件会自己换端口、用自己的
    // 隔离 profile 继续，所以文案只说"发生过什么"和"重试会怎么做"。
    'carrier-blocked': '上一台自有浏览器没能确证关闭：重试会先再关它一次，关不掉就换端口与本次自己的隔离 profile 继续',
    // 2026-10-05 round 16: the carrier started and was ours, but the stored session never made it
    // into the browser (the endpoint answered, the cookies were not accepted, or no blank page was
    // there to write to). That is not an expired session and not a missing enrolment — the fix a
    // person has is the same door as ever, so the sentence has to say which step failed and then
    // point at the door, not claim the session is gone.
    'session-restore-failed': '无窗口续期没能把已保存的会话交给浏览器（Cookie 没被接受或白页打不开）：点一次 Get 打开登录窗口',
    'port-not-ours': '调试端口上答的是另一台浏览器（不是本插件启动的），插件不读它、也不动它：本次会换一条端口与自己的临时 profile 继续',
    'already-open': '登录窗口已打开，请在其中完成登录',
    reuse: '已复用现有的调试浏览器，请在它的窗口里登录',
    'no-debug-port': '调试端口 9333-9343 都被别的浏览器占着（插件不读也不动它们），等其中一个退出后重试',
    'no-browser': '未找到 Edge 或 Chrome，无法打开登录窗口',
    error: '打开登录窗口失败',
    disposed: '插件已停用',
  }
  var store = {
    auto: false, busy: false, lastGetAt: 0, loggedIn: false, status: 'idle', err: '',
    expiresAt: 0, nearlyOut: false, browserOpen: false, loginWait: false, provider: '', providerName: '',
    credentialWritten: false, credentialPresent: false, syncDetail: '',
    loginReason: '', refreshBlocked: false, offline: false, notice: '', noticeAt: 0,
    // Renewal without a window, and the reason it last failed, belong on the panel: without
    // them the visible line describes a login window that does not exist
    // (2026-10-04 round 9, requirements B and D).
    headless: false, headlessFailReason: '',
    // Which no-window carrier it was ('hidden' = the plugin's own normal Edge with no UI,
    // 'headless' = the built-in shell), and the browser's own reason when the native one
    // could not be used (2026-10-04 round 10).
    carrier: '', carrierNote: '',
    // True only when this click landed on a run the *server* already had in flight: it is
    // the difference between "working on what I started" and "queued behind someone else"
    // (2026-10-04 real run: a click in that window used to be dropped without a word).
    queued: false,
    // Set by the in-flight guard alone, and cleared the moment that request ends: it is the
    // one trace a *swallowed* click leaves on the panel (2026-10-05 round 16). The notice
    // below could never be read while `busy` was set, so the second click's only visible
    // effect was nothing at all — a panel that stays silent reads as a dead button.
    dupClick: false,
    // The loaded build and the last run's facts: the version answers "did the restart pick
    // up the new logic", the trace is what a real-machine report cites (2026-10-04).
    // `trace` is the last run of any kind, so a scheduled Auto tick overwrites a click's
    // record; `manualTrace` keeps the last *click* readable (report §12 item 2).
    version: '', trace: null, manualTrace: null,
    // How often Auto may fetch, as reported by the host; 0 means "the host did not say"
    // (an older core) and is formatted as that older core's hourly cadence.
    autoEveryMs: 0,
  }
  var box = null
  var dotEl = null
  var getBtn = null
  var autoBtn = null
  var stateEl = null
  var elapsedEl = null
  var intervalIds = []
  // Watching the mount container is how a sidebar collapse is noticed in the same
  // frame instead of up to a second later (the 1s render tick is the fallback).
  var widthObs = null
  var observedHost = null

  function cleanup() {
    for (var i = 0; i < intervalIds.length; i++) clearInterval(intervalIds[i])
    intervalIds = []
    document.removeEventListener('DOMContentLoaded', boot)
    if (widthObs) { try { widthObs.disconnect() } catch (e) { /* already gone */ } }
    widthObs = null
    observedHost = null
    if (box && box.parentNode) box.parentNode.removeChild(box)
    var style = document.getElementById('mmtok-style')
    if (style && style.parentNode) style.parentNode.removeChild(style)
    box = null
    dotEl = null
    getBtn = null
    autoBtn = null
    stateEl = null
    elapsedEl = null
    // A teardown must not leave a claim behind: the widget that mounts next reports the
    // server's facts, not this one's in-flight request.
    getPending = false
    store.busy = false
    store.queued = false
    window.__mmtokUiLoaded = false
    if (window.__mmtokUiCleanup === cleanup) window.__mmtokUiCleanup = null
  }
  window.__mmtokUiCleanup = cleanup

  var pad = function (n) { return (n < 10 ? '0' : '') + n }
  // Elapsed time is capped, not converted: this field is a fixed-width clock and
  // a three-digit hour count would push the row wider than the sidebar. (It used
  // to render the English string "Too Long!" here.)
  var fmt = function (ms) {
    if (!ms || ms < 0) return '--:--'
    var sec = Math.floor(ms / 1000)
    var hh = Math.min(Math.floor(sec / 3600), 99)
    return pad(hh) + ':' + pad(Math.floor((sec % 3600) / 60))
  }
  // How often Auto is allowed to fetch is the host's decision, not the widget's, so the
  // number is read from the snapshot (autoEveryMs) and only formatted here — the panel
  // must not describe a schedule of its own. A host that has not been restarted yet
  // serves no such field and still runs the older hourly core, so that older label is
  // the fallback: it states the cadence actually in force rather than the new one.
  var everyLabel = function (ms) {
    var total = Math.round((typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms : 3600e3) / 60000)
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
  }
  var remainText = function (at) {
    if (!at) return ''
    var ms = at - Date.now()
    if (ms <= 0) return ''
    var min = Math.floor(ms / 60000)
    return Math.floor(min / 60) + 'h' + pad(min % 60) + 'm'
  }
  var providerLabel = function () { return store.providerName || 'DeepSeek (THU)' }
  // "Nothing reached the site, but the token in hand is still perfectly good."
  // An outage says nothing about the credential, so it must not borrow the wording
  // of a broken one; and it is transient, so it must not outlive the next good run.
  var offlineUsable = function () {
    var s = store
    if (!s.offline) return false
    return s.status === 'ok' || s.status === 'idle' || s.status === 'no-progress'
  }
  // "Working on my request" and "queued behind a run already in flight" are two different
  // facts, and only the second one needs the user to know their click was accepted rather
  // than lost (2026-10-04 real run). Since round 16 a third fact rides along: this click
  // landed on our own request already in flight, so nothing new was sent — the one case
  // where the panel used to say nothing at all.
  var DUP_TAIL = '（这次点击没有重复发起请求）'
  var busyText = function () {
    var head = store.queued
      ? '正在获取 Token…（服务端已有一个运行，本次点击已排队）'
      : '正在获取 Token…'
    return store.dupClick ? head + DUP_TAIL : head
  }
  // One-line current-state summary (title text and the dot's tooltip).
  var statusLine = function () {
    var s = store
    if (s.busy) return busyText()
    if (s.notice) return s.notice
    if (offlineUsable()) return '网络不可达：连不上 madmodel 站点，Token 仍可用'
    if (s.status === 'waiting-login') {
      // The host writes what it actually did into err — normally the "log in and it will be
      // picked up" line, and after a click whose no-window attempt gave up, the story of the
      // window opened for it instead (2026-10-04 round 9, requirement A).
      return s.err || '等待登录：登录窗口已打开，完成登录后会自动获取并写入，无需再点 Get'
    }
    if (s.status === 'processing') {
      // "已拿到凭据" is not true while a browser with no window at all is still working
      // (2026-10-04 round 9, requirement B). The host's own sentence says *which* no-window
      // carrier is running — the native hidden page or the built-in shell — so the panel
      // shows that instead of inventing a third description (2026-10-04 round 10).
      if (s.headless) return s.err || '正在免密续期：没有窗口，最多 1 分钟'
      return '正在处理：已拿到凭据，正在校验并写入…'
    }
    if (s.status === 'needs-login') {
      var why = LOGIN_REASON_TEXT[s.loginReason] || '点击 Get 打开登录窗口'
      // Being stranded on the device page is a specific, actionable fact: logging in again
      // does work, but the part a person needs is why the background could not
      // (2026-10-04 round 9, requirement D).
      if (s.headlessFailReason === 'device-page') why += '（无窗口浏览器停在设备确认页，需要本人在设备上确认）'
      return '需要登录：' + why
    }
    if (s.status === 'error') return '出错了：' + (s.err || '未知错误')
    if (s.status === 'partial') return 'Token 已更新，但模型配置未同步：' + (s.err || '未知错误')
    if (s.status === 'no-progress') {
      return '刷新未生效：' + (s.err || '拿到的是同一张令牌，到期时间未前进')
    }
    if (s.status === 'expired') return 'Token 已过期，点击 Get 重新获取'
    if (s.status === 'refreshing') return '正在自动刷新 Token…'
    if (s.status === 'ok') {
      // An ok token can still carry a note worth reading (unreachable site, expiry
      // not verified, expiry did not move): the note is the honest part of "ok".
      if (s.err) return 'Token 有效：' + s.err
      if (s.syncDetail === 'created') return '已创建 ' + providerLabel() + ' 模型配置并写入 Token'
      if (s.syncDetail === 'synced' || s.syncDetail === 'models-synced' || s.syncDetail === 'apiKeyEnv-set') {
        return '已更新 ' + providerLabel() + ' 模型配置'
      }
      // No write was needed — the site hands back the same session-bound token
      // for hours. That is a healthy run, and it must not read like one.
      return 'Token 有效：' + providerLabel() + ' 配置无需变更'
    }
    return '尚未获取 Token，点击 Get 获取'
  }
  // The visible second line: present only when the user can or must act on it.
  var stateText = function () {
    var s = store
    if (s.busy) return busyText()
    if (s.notice) return s.notice
    if (offlineUsable()) return '网络不可达：连不上 madmodel 站点，Token 仍可用，稍后自动重试'
    if (s.status === 'waiting-login') return s.err || '等待登录：登录窗口已打开，完成登录后会自动获取并写入，无需再点 Get'
    if (s.status === 'processing') {
      if (s.headless) return '正在免密续期：没有窗口，最多 1 分钟，无需操作'
      return '正在处理：已拿到凭据，正在校验并写入…'
    }
    if (s.status === 'partial') return 'Token 已更新，但模型配置未同步：' + (s.err || '原因未知')
    if (s.status === 'error') return '出错了：' + (s.err || '未知错误')
    if (s.status === 'needs-login') {
      var why2 = LOGIN_REASON_TEXT[s.loginReason] || '点击 Get 打开登录窗口'
      if (s.headlessFailReason === 'device-page') why2 += '（无窗口浏览器停在设备确认页，需要本人在设备上确认）'
      return '需要登录：' + why2
    }
    if (s.status === 'expired') return 'Token 已过期，点击 Get 重新获取'
    if (s.status === 'no-progress') {
      var rem = remainText(s.expiresAt)
      // "请重新登录" with nothing to click was the dead end a real run hit on 2026-10-04:
      // the panel asked for a login it gave the user no way to start. When the automatic
      // channel is blocked a click really does open the window, so say that; when a rung
      // merely handed back the same token (nothing is blocked), the login is a note, not
      // the next step.
      var act = s.refreshBlocked ? '点一次 Get 打开登录窗口重新登录' : '请重新登录'
      return '续期未生效：到期时间未前进，' + (rem ? '剩余 ' + rem + '，' : '') + act
    }
    if (s.status === 'ok') {
      // "ok" with a caveat still has to say the caveat on the visible line: an
      // unreachable site or an unverified expiry is exactly what the user needs to
      // know before trusting the token (2026-10-04).
      if (s.err) return s.err
      if (s.nearlyOut) {
        var left = remainText(s.expiresAt)
        if (left) return 'Token 剩余 ' + left + '，将自动尝试续期'
      }
    }
    return ''
  }
  var dotState = function () {
    var s = store
    if (s.busy) return 'busy'
    // A window of ours is open and being watched, or the capture is writing the
    // result: both are "in progress" in the only sense the dot can show.
    if (s.status === 'waiting-login' || s.status === 'processing') return 'busy'
    // Amber already means "could not be verified", which is exactly an unreachable site.
    if (offlineUsable()) return 'stale'
    if (s.status === 'ok') return 'ok'
    if (s.status === 'no-progress' || s.status === 'partial') return 'stale'
    if (s.status === 'needs-login' || s.status === 'expired' || s.status === 'error') return 'bad'
    return 'off'
  }
  var dotLabel = function () {
    var s = store
    if (s.busy) return '正在获取 Token'
    if (s.status === 'waiting-login') return '等待登录'
    if (s.status === 'processing') return '正在校验并写入'
    if (offlineUsable()) return '网络不可达，未能校验 Token'
    if (s.status === 'ok') return s.nearlyOut ? 'Token 有效，即将到期' : 'Token 有效'
    if (s.status === 'no-progress') return '续期未生效'
    if (s.status === 'partial') return '模型配置未同步'
    if (s.status === 'needs-login') return '需要登录'
    if (s.status === 'expired') return 'Token 已过期'
    if (s.status === 'error') return '出错了'
    return '尚未获取 Token'
  }
  // Multi-line hover text for the whole widget.
  var titleText = function () {
    var s = store
    var lines = ['THU Tok Auto' + (s.version ? ' v' + s.version : '')]
    lines.push(statusLine())
    var info = []
    if (s.lastGetAt) info.push('上次获取 ' + fmt(Date.now() - s.lastGetAt) + ' 前')
    if (s.expiresAt) {
      var rem = remainText(s.expiresAt)
      info.push(rem ? ('Token 剩余 ' + rem) : 'Token 已过期')
    }
    if (info.length) lines.push(info.join(' · '))
    if (s.refreshBlocked && s.status !== 'needs-login' && s.status !== 'error') {
      lines.push('自动续期暂不可用：' + (LOGIN_REASON_TEXT[s.loginReason] || '需要重新登录一次'))
    }
    // The last run in facts, hover-only: which rung answered, whether the server vouched
    // for the token, how long it took, and what happened to the login window. Without it
    // "the button did nothing" cannot be told apart from "the ladder is dead" or "the
    // window failed to start" on a real machine (2026-10-04). A click and an Auto tick are
    // named apart, because an hourly tick used to be the only trace left of a click that
    // did nothing visible (report §12 item 2).
    var traceLine = function (label, tr) {
      var parts = ['签发' + (tr.mint === 'ok' ? '成功' : '失败')]
      if (tr.sso !== 'skip') parts.push('SSO' + (tr.sso === 'ok' ? '成功' : '失败'))
      if (tr.reuse) parts.push('复用旧令牌')
      if (tr.via === 'busy') parts.push('服务端正忙')
      if (tr.via === 'waiting-login') parts.push('已有登录窗口在等')
      else if (tr.via === 'capture-sso' || tr.via === 'capture-mint' || tr.via === 'login') parts.push('登录后捕获')
      parts.push(tr.verdict === 'yes' ? '服务端已确认' : tr.verdict === 'no' ? '服务端拒绝' : '未能校验')
      var line = label + ' ' + fmt(Date.now() - tr.at) + ' 前：' + parts.join('、') + '，用时 ' + Math.round((tr.ms || 0) / 1000) + 's'
      if (tr.waitMs > 500) line += '（等前一次 ' + Math.round(tr.waitMs / 1000) + 's）'
      if (tr.opened === 'launched') line += '，登录窗口已打开'
      else if (tr.opened === 'reuse') line += '，复用了已有登录窗口'
      else if (tr.opened === 'already-open') line += '，登录窗口已在等待'
      else if (tr.opened && tr.opened !== 'none') line += '，登录窗口未打开（' + tr.opened + '）'
      return line
    }
    var mt = s.manualTrace
    var tr = s.trace
    var sameRun = !!mt && !!tr && mt.at === tr.at
    if (mt && !sameRun) lines.push(traceLine('上次点击', mt))
    if (tr) lines.push(traceLine(tr.bg ? '上次自动' : '上次点击', tr))
    // The request readings, hover-only and with their age. A later successful poll clears the
    // status line but must not erase the evidence of the failure before it (2026-10-04: the
    // panel said `Failed to fetch` and nothing else, and the one reading that separates a dead
    // API path from a failed request was never kept anywhere the user could read).
    if (diag.lastResponse || diag.lastFailureText) {
      var reqLine = '请求诊断：已点击 Get ' + diag.clicks + ' 次'
      if (diag.lastResponse) {
        reqLine += '，最近响应 ' + diag.lastResponse.method + ' ' + diag.lastResponse.endpoint
          + '（HTTP ' + diag.lastResponse.status + '，' + fmt(Date.now() - diag.lastResponse.at) + ' 前）'
      } else {
        reqLine += '，还没有任何响应到达'
      }
      lines.push(reqLine)
      if (diag.lastFailureText) {
        lines.push('最近失败（' + fmt(Date.now() - (diag.lastFailure ? diag.lastFailure.at : 0)) + ' 前）：'
          + diag.lastFailureText)
      }
    }
    lines.push(s.auto
      ? 'Auto 已开启：计时超过 ' + everyLabel(s.autoEveryMs) + ' 自动获取，点击 Auto 关闭'
      : 'Auto 已关闭：点击开启，计时超过 ' + everyLabel(s.autoEveryMs) + ' 自动获取')
    return lines.join('\n')
  }

  // ---- request readings (2026-10-04) ---------------------------------------
  // `Failed to fetch` is the browser's own TypeError: no response ever arrived. That one
  // sentence cannot tell a wrong URL / wrong origin apart from a blocked, refused or
  // destroyed request, and it was the only thing the panel reported. These helpers only
  // *read* what the browser already knows about the request it has just made — the URL it
  // resolved, the origin the page was on, whether the machine is online, and what Resource
  // Timing recorded. They add no request, no retry, and no state transition; nothing here
  // can hold a token or a cookie.
  var onlineFlag = function () {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') return navigator.onLine
    } catch (e) { /* unreadable here */ }
    return null
  }
  var requestFacts = function (method, endpoint, startedAt) {
    var facts = {
      at: Date.now(), method: method, endpoint: endpoint, raw: API + '/' + endpoint,
      resolved: API + '/' + endpoint, origin: '', base: '', href: '', online: onlineFlag(),
      status: 0, responseStatus: 0, transferSize: 0, elapsedMs: 0, name: '',
    }
    try {
      if (typeof location !== 'undefined') {
        facts.origin = String(location.origin || '')
        facts.href = String(location.href || '')
      }
    } catch (e) { /* unreadable here */ }
    try { facts.base = String(document.baseURI || '') } catch (e) { /* unreadable here */ }
    // A relative URL is resolved against document.baseURI by the browser; if a <base> tag
    // ever pointed elsewhere, the request would leave this origin without the code saying so.
    try { facts.resolved = new URL(facts.raw, document.baseURI).href } catch (e) { /* keep the relative form */ }
    // Resource Timing answers "did a response arrive at all": 0 status with 0 bytes means
    // the request never produced one, while a number means the browser got a response — and
    // therefore that the Host's handler ran.
    try {
      if (typeof performance !== 'undefined' && performance.getEntriesByName) {
        var list = performance.getEntriesByName(facts.resolved)
        var last = list && list.length ? list[list.length - 1] : null
        if (last) {
          facts.responseStatus = Number(last.responseStatus || 0)
          facts.transferSize = Number(last.transferSize || 0)
          facts.elapsedMs = Math.round(Number(last.duration || 0))
        }
      }
    } catch (e) { /* timing unreadable */ }
    if (!facts.elapsedMs && startedAt) facts.elapsedMs = Date.now() - startedAt
    return facts
  }
  // Two verifiable quantities first (which request, and what came back), then the readings
  // that separate the remaining causes.
  var factsText = function (f) {
    if (!f) return ''
    var parts = [f.method + ' ' + f.raw]
    if (f.resolved && f.resolved !== f.raw) parts.push('浏览器解析为 ' + f.resolved)
    parts.push(f.status ? ('响应 HTTP ' + f.status) : '没有收到响应状态')
    if (f.responseStatus && f.responseStatus !== f.status) parts.push('计时记录状态 ' + f.responseStatus)
    if (f.transferSize) parts.push('收到 ' + f.transferSize + ' 字节')
    if (f.elapsedMs) parts.push('用时 ' + f.elapsedMs + 'ms')
    parts.push('页面来源 ' + (f.origin || '未知'))
    if (f.base && f.base !== f.origin + '/') parts.push('baseURI ' + f.base)
    parts.push('在线 ' + (f.online === null ? '未知' : (f.online ? '是' : '否')))
    if (f.name) parts.push('错误类型 ' + f.name)
    return parts.join('；')
  }
  var rememberFailure = function (facts) {
    diag.failures += 1
    diag.lastFailure = facts
    diag.lastFailureText = factsText(facts)
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
    var startedAt = Date.now()
    return fetch(API + '/' + endpoint, init).then(function (r) {
      var got = {
        at: Date.now(), method: method, endpoint: endpoint, status: r.status,
        ms: Date.now() - startedAt,
      }
      // "A response came back" and "the request succeeded" are two different readings: a
      // 401/403 still proves the Host answered, which is exactly what a bare TypeError does
      // not prove.
      diag.lastResponse = got
      if (r.ok) diag.lastOk = got
      return r.json().catch(function () { return null }).then(function (data) {
        if (!r.ok) {
          var error = new Error((data && data.error) || ('请求失败（HTTP ' + r.status + '）'))
          error.status = r.status
          var refused = requestFacts(method, endpoint, startedAt)
          refused.status = r.status
          error.factsText = factsText(refused)
          rememberFailure(refused)
          throw error
        }
        if (!data) throw new Error('服务器返回了无效数据')
        return data
      })
    }, function (error) {
      // fetch itself rejected: the browser reports a TypeError and no response exists. The
      // reading travels on the error so the panel can quote it in the same breath.
      var facts = requestFacts(method, endpoint, startedAt)
      facts.name = String((error && error.name) || '')
      if (error && typeof error === 'object') error.factsText = factsText(facts)
      rememberFailure(facts)
      throw error
    })
  }

  function showRequestError(error) {
    store.busy = false
    store.queued = false
    store.status = 'error'
    // A 404 means this page is talking to a host that does not serve the plugin's API
    // (plugin unloaded, page from an older host, route missing). That used to tear the
    // widget down without a word — the panel simply vanished and nothing said why, which
    // is indistinguishable from a broken build. Facts first: stay, say what happened,
    // keep polling; a refresh is what removes a widget whose plugin is really gone.
    // The reading travels inside the sentence as well: which request failed, against which
    // URL the browser resolved it, from which page origin, and whether any response arrived
    // (2026-10-04). Without it `Failed to fetch` is one sentence for four different causes.
    var reading = (error && error.factsText) || ''
    var suffix = reading ? '（' + reading + '）' : ''
    if (error && error.status === 404) {
      store.err = '插件接口未就绪（HTTP 404）：宿主未加载本插件或页面来自旧版本，仍在每 10 秒重试' + suffix
      if (diag.lastError !== 'api: 404') { diag.lastError = 'api: 404'; console.info('[thu-tok-auto] api 404') }
    } else {
      store.err = 'DSH 通信失败：' + String((error && error.message) || error || '未知错误') + suffix
    }
    render()
  }

  var refresh = function () {
    return jsonRequest('GET', 'status').then(function (s) {
      if (!s) return
      var wasWaiting = store.status === 'waiting-login' || store.status === 'processing'
      store.auto = !!s.auto; store.busy = !!s.busy; store.lastGetAt = s.lastGetAt || 0
      // The Auto interval is the host's number, not the widget's: copy it as given so the
      // hover text cannot describe a schedule this build is not running (report §20).
      store.autoEveryMs = typeof s.autoEveryMs === 'number' && s.autoEveryMs > 0 ? s.autoEveryMs : 0
      store.loggedIn = !!s.loggedIn; store.status = s.status || 'idle'; store.err = s.err || ''
      store.expiresAt = s.expiresAt || 0; store.nearlyOut = !!s.nearlyOut
      store.browserOpen = !!s.browserOpen; store.loginWait = !!s.loginWait
      store.provider = s.provider || ''
      store.providerName = s.providerName || ''
      store.credentialWritten = !!s.credentialWritten
      store.credentialPresent = !!s.credentialPresent
      store.syncDetail = s.syncDetail || ''
      store.loginReason = s.loginReason || ''; store.refreshBlocked = !!s.refreshBlocked
      store.offline = !!s.offline
      store.headless = !!s.headless
      store.headlessFailReason = s.headlessFailReason || ''
      // Which no-window engine was watched, and — when the native one could not be used — the
      // browser's own reason for it. The panel names the carrier it really ran
      // (2026-10-04 round 10).
      store.carrier = s.carrier || ''
      store.carrierNote = s.carrierNote || ''
      store.version = s.version || ''
      store.trace = s.trace || null
      store.manualTrace = s.manualTrace || null
      // The queue marker belongs to one click's run only: once the server reports no run
      // in flight, the next busy text must not still claim a click is waiting in line.
      if (!store.busy) store.queued = false
      // The one transition the whole feature exists to produce, and the only proof
      // the user gets that the login they just did was enough (2026-10-04, A).
      if (wasWaiting && store.status === 'ok') {
        // Which channel finished it is visible in the trace: a renewal that ran in a browser
        // with no window must not claim a login the user never did — whichever no-window
        // carrier it was, the native hidden page or the built-in shell
        // (2026-10-04 round 9 requirement B, round 10).
        var noWindowRun = store.trace && (store.trace.opened === 'headless' || store.trace.opened === 'hidden')
        notice(noWindowRun
          ? '免密续期成功：Token 已自动更新'
          : '登录成功：Token 已自动获取并写入')
      } else if (wasWaiting && store.status === 'no-progress') {
        // The run finished but the token did not move. Saying "成功" here would hide the one
        // fact this state exists to report — and hide it behind a notice, which outranks the
        // state line (2026-10-04 round 9).
        notice('已拿到令牌，但到期时间没有前进（可能仍是同一张）')
      }
      render()
    }).catch(showRequestError)
  }

  var notice = function (text) {
    store.notice = text || ''
    store.noticeAt = Date.now()
  }

  // Only our own request is held back — never the server's answer, and never silently.
  // A click that landed here while `busy` was set was the 2026-10-04 real-run failure:
  // the guard returned, nothing was sent, and the panel kept showing the previous state,
  // so the user could not tell a swallowed click from a dead ladder. Now: our own
  // in-flight request says so in words, and a *server-side* run does not block the click
  // at all — the request goes out and the core queues it behind the run it collided with.
  var getPending = false
  // The guard's sentence, kept in one place so the end of the request can take it back
  // without wiping a notice the answer itself wrote.
  var DUP_NOTICE = '正在获取中：这次点击不会重复发起请求（长时间无响应时可刷新页面）'
  // This request is over, so the trace a swallowed click left goes with it — including the
  // notice, but only when that notice is still the guard's own sentence (2026-10-05 round 16).
  var endOwnRequest = function () {
    getPending = false
    store.dupClick = false
    if (store.notice === DUP_NOTICE) notice('')
  }
  var runGet = function () {
    // A click is a fact in itself (2026-10-04): a panel that can only say `Failed to fetch`
    // cannot be told apart from a click that never reached this handler at all, so the click
    // is counted before anything can fail.
    diag.clicks += 1
    diag.lastClickAt = Date.now()
    if (getPending) {
      // Both lines are written on purpose: the flag is what the busy line shows (the notice
      // alone could never be read while `busy` is set), and the notice is what is left to
      // read if the busy state has already cleared by the time this click is rendered.
      store.dupClick = true
      notice(DUP_NOTICE)
      render()
      return
    }
    getPending = true
    store.queued = !!store.busy
    store.busy = true
    store.notice = ''
    store.noticeAt = 0
    render()
    jsonRequest('POST', 'get-tok').then(function (r) {
      if (r && r.loginRequired) {
        // The core opens the window inside this very run, so this second request is
        // only the fallback for a host that did not manage to (2026-10-04, A); the
        // answer carries the reason a window did not appear, which used to be
        // dropped, so every failure looked like nothing had happened.
        if (r.loginOpened === 'launched' || r.loginOpened === 'reuse' || r.loginOpened === 'already-open') {
          // The host's own sentence wins. Normally it is exactly this line; after a click
          // whose no-window attempt had to give up it is that story instead, and the panel
          // must not paper over it with the usual one (2026-10-04 round 9, requirement A).
          notice(r.err || '登录窗口已打开：完成登录后会自动获取并写入，无需再点 Get')
          return r
        }
        return jsonRequest('POST', 'open-login').then(function (o) {
          if (o && o.launched) notice('登录窗口已打开：完成登录后会自动获取并写入，无需再点 Get')
          else if (o && o.reason) notice(LOGIN_REASON_TEXT[o.reason] || ('未打开登录窗口：' + o.reason))
          return o
        })
      }
      if (r && r.detail === 'busy') notice(r.err || '服务端上一次处理还没结束：请等几秒再点一次 Get')
      else if (r && r.offline) notice('网络不可达：连不上 madmodel 站点，稍后自动重试')
      else if (r && r.err) notice(r.err)
      else if (r && r.via === 'mint') notice('已签发新令牌')
      else if (r && r.via === 'sso') notice('已通过 SSO 续期')
      else if (r && r.via === 'reuse') notice('已复用旧令牌（未刷新）')
      return r
    }).then(function (r) {
      endOwnRequest()
      return refresh().then(function () { return r })
    }).catch(function (error) {
      endOwnRequest()
      store.queued = false
      showRequestError(error)
    })
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
      var slot = node.getAttribute ? String(node.getAttribute('data-slot') || '') : ''
      if (cls.indexOf('footArea') >= 0 || cls.indexOf('footerActions') >= 0 || slot.indexOf('sidebar.foot') === 0) {
        foot = node
        break
      }
      node = node.parentElement
    }
    return foot
  }
  // Re-observe whenever the mount point changes: React swaps the sidebar nodes, and an
  // observer left on a detached container would never fire again.
  function watchWidth() {
    var host = box && box.parentNode ? box.parentNode : null
    if (observedHost === host) return
    if (widthObs) { try { widthObs.disconnect() } catch (e) { /* already gone */ } }
    widthObs = null
    observedHost = host
    // The nodeType guard keeps this a no-op in the minimal test fixture.
    if (!host || typeof ResizeObserver !== 'function' || typeof host.nodeType !== 'number') return
    try {
      widthObs = new ResizeObserver(function () { render() })
      widthObs.observe(host)
    } catch (e) { widthObs = null }
  }
  // One line per distinct failure is what makes a silently missing widget visible in the
  // page console; the repeating ticks must not spam it.
  var mountNotes = {}
  function noteMount(reason) {
    diag.lastMount = 'failed:' + reason
    if (mountNotes[reason]) return
    mountNotes[reason] = true
    if (window.console && console.info) console.info('[thu-tok-auto] 控件未挂载：' + reason)
  }
  function noteError(where, e) {
    diag.lastError = where + ': ' + String((e && e.message) || e)
    if (window.console && console.info) console.info('[thu-tok-auto] ' + diag.lastError)
  }
  // Where the widget goes: the foot area, above every other footer button; else directly
  // above the settings row; else — while the sidebar is mid-render and has no trigger yet —
  // the sidebar foot slot or the sidebar container itself. Parking somewhere visible beats
  // waiting forever for the canonical node (2026-10-04: the widget was simply absent, and
  // nothing on the page said which step had given up).
  function mountTarget() {
    var trigger = findSettingsTrigger()
    // A trigger that is in the document tree but no longer connected is a leftover of a
    // replaced sidebar: parking the widget there would leave it invisible. Only real,
    // attached anchors count — otherwise wait and retry.
    if (trigger && trigger.isConnected === false) trigger = null
    var foot = trigger ? footAreaOf(trigger) : null
    if (foot) return { node: foot, before: foot.firstChild, how: 'foot' }
    if (trigger && trigger.parentElement) return { node: trigger.parentElement, before: trigger, how: 'settings-row' }
    var slot = document.querySelector('[data-slot^="sidebar.foot"]')
    if (slot) return { node: slot, before: slot.firstChild, how: 'foot-slot' }
    var area = document.querySelector('[class*="footArea"],[class*="footerActions"],[class*="SidebarRoot"]')
    if (area) return { node: area, before: area.firstChild, how: 'sidebar-container' }
    return null
  }
  function tryMount() {
    // Already in the canonical slot: done. A widget parked in a fallback keeps trying to
    // reach the canonical one on every tick, so a sidebar that finishes rendering later
    // still gets it in the right place.
    if (box && box.isConnected && diag.lastMount === 'foot') return true
    ensureDom()
    var target = mountTarget()
    if (!target) {
      if (box && box.isConnected) return true
      noteMount('no-anchor')
      return false
    }
    if (box.parentNode !== target.node || target.node.firstChild !== box) {
      try { target.node.insertBefore(box, target.before || null) } catch (e) {
        noteError('insert', e)
        return !!(box && box.isConnected)
      }
    }
    if (!box || !box.isConnected) { noteMount('inserted-but-detached'); return false }
    if (diag.mounts > 0) diag.remounts += 1
    diag.mounts += 1
    diag.lastMount = target.how
    diag.mounted = true
    return true
  }
  function ensureDom() {
    if (box && document.body && box.isConnected) return
    if (box && box.parentNode) box.parentNode.removeChild(box)
    box = document.createElement('div')
    box.className = 'mmtok-box'
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'THU Tok Auto')
    var btns = document.createElement('div')
    btns.className = 'mmtok-btns'
    dotEl = document.createElement('span')
    dotEl.className = 'mmtok-dot mmtok-off'
    dotEl.setAttribute('role', 'img')
    getBtn = document.createElement('button')
    getBtn.type = 'button'
    getBtn.className = 'mmtok-btn'
    getBtn.textContent = 'Get'
    getBtn.addEventListener('click', runGet)
    autoBtn = document.createElement('button')
    autoBtn.type = 'button'
    autoBtn.className = 'mmtok-btn'
    autoBtn.textContent = 'Auto'
    autoBtn.addEventListener('click', function () { setAuto(!store.auto) })
    elapsedEl = document.createElement('span')
    elapsedEl.className = 'mmtok-elapsed'
    elapsedEl.textContent = '--:--'
    btns.appendChild(dotEl)
    btns.appendChild(getBtn)
    btns.appendChild(autoBtn)
    btns.appendChild(elapsedEl)
    // Live region: state changes are announced, but only when there is a state
    // worth announcing (polite, so it waits for a pause in speech).
    stateEl = document.createElement('span')
    stateEl.className = 'mmtok-state mmtok-hidden'
    stateEl.setAttribute('role', 'status')
    stateEl.setAttribute('aria-live', 'polite')
    box.appendChild(btns)
    box.appendChild(stateEl)
  }

  function render() {
    diag.mounted = !!(box && box.isConnected)
    // The 1s tick is also the cheapest place to notice that the widget is no longer in the
    // page (React replaced the sidebar, the rail was swapped): remount instead of idling.
    if (!diag.mounted) {
      tryMount()
      diag.mounted = !!(box && box.isConnected)
      if (!diag.mounted) return
    }
    var s = store
    // Layout follows the container, not the window (see COMPACT_BOX_MAX_W). A zero
    // width means "not laid out yet" (hidden sidebar, first frame), which is not a
    // reason to switch: keep the previous answer until there is a real measurement.
    watchWidth()
    var boxW = box.clientWidth || 0
    if (boxW > 0) {
      var boxCls = 'mmtok-box' + (boxW < COMPACT_BOX_MAX_W ? ' mmtok-compact' : '')
      if (box.className !== boxCls) box.className = boxCls
    }
    if (s.notice && Date.now() - s.noticeAt > NOTICE_MS) { s.notice = ''; s.noticeAt = 0 }
    box.title = titleText()
    var ds = dotState()
    // ok = green, no-progress / partial = amber, needs-login / expired / error =
    // red, idle = grey. A refresh that did not extend the expiry must not look
    // healthy, and a failed one must not look idle.
    dotEl.className = 'mmtok-dot mmtok-' + ds
    dotEl.title = statusLine()
    dotEl.setAttribute('aria-label', '状态：' + dotLabel())
    // A run in flight no longer takes the button away or greys it out. Disabling it is
    // what made a real click do nothing at all on 2026-10-04: `store.busy` was stale-true,
    // the click hit a disabled control, and neither the panel nor state.json showed that
    // anything had been attempted. Busy is said in words instead (see runGet/busyText).
    getBtn.disabled = false
    getBtn.className = 'mmtok-btn'
    getBtn.setAttribute('aria-busy', s.busy ? 'true' : 'false')
    getBtn.textContent = 'Get'
    getBtn.title = statusLine() + '\n点击获取最新 Token 并写入 ' + providerLabel() + ' 模型配置'
    autoBtn.className = 'mmtok-btn' + (s.auto ? ' mmtok-auto-on' : '')
    autoBtn.textContent = s.auto ? 'Auto ✓' : 'Auto'
    autoBtn.setAttribute('aria-pressed', s.auto ? 'true' : 'false')
    autoBtn.title = s.auto
      ? 'Auto 已开启：计时超过 ' + everyLabel(s.autoEveryMs) + ' 自动获取，点击关闭'
      : 'Auto 已关闭：点击开启，计时超过 ' + everyLabel(s.autoEveryMs) + ' 自动获取'
    autoBtn.setAttribute('aria-label', autoBtn.title)
    var el = fmt(s.lastGetAt ? Date.now() - s.lastGetAt : 0)
    elapsedEl.textContent = el
    elapsedEl.title = '距上次获取 ' + el + (s.auto
      ? '，超过 ' + everyLabel(s.autoEveryMs) + ' 自动刷新'
      : '，超过 ' + everyLabel(s.autoEveryMs) + ' 后可点击 Auto 开启自动刷新')
    // The clock counts UP from the last fetch; the remaining life is stated in
    // words (second line / hover), never in the same field. Say which is which.
    elapsedEl.setAttribute('aria-label', '距上次获取 ' + el)
    var text = stateText()
    stateEl.textContent = text
    stateEl.className = 'mmtok-state' + (text ? '' : ' mmtok-hidden')
  }

  // Sidebar-foot widget: buttons left, timer pushed flush right, no divider
  // lines. Auto ON = green button labeled "Auto ✓" (matches the original look).
  // The second row is hidden unless it has something to say, so a healthy widget
  // keeps exactly the old height.
  var css = [
    '.mmtok-box{display:block;padding:6px 10px 6px 11px;width:100%;box-sizing:border-box;pointer-events:auto;}',
    '.mmtok-btns{display:inline-flex;align-items:center;gap:12px;width:100%;max-width:100%;box-sizing:border-box;flex-wrap:wrap;row-gap:4px;}',
    '.mmtok-btn{font-size:14px;line-height:1.6;padding:0 8px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;flex:none;}',
    '.mmtok-btn:hover{border-color:rgba(128,128,128,.85);background:rgba(128,128,128,.18);}',
    '.mmtok-btn:focus-visible{outline:2px solid #5b8def;outline-offset:2px;}',
    '.mmtok-btn.mmtok-auto-on{background:#4caf50;color:#fff;border-color:#4caf50;}',
    '.mmtok-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
    '.mmtok-ok{background:#4caf50;}',
    '.mmtok-busy{background:#ffb300;animation:mmtok-pulse 1s infinite;}',
    '.mmtok-stale{background:#ff9800;}',
    '.mmtok-bad{background:#e53935;}',
    '.mmtok-off{background:#9e9e9e;}',
    '@keyframes mmtok-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
    '@media (prefers-reduced-motion:reduce){.mmtok-busy{animation:none;}}',
    '.mmtok-elapsed{margin-left:auto;font-size:14px;font-variant-numeric:tabular-nums;color:inherit;user-select:none;line-height:1;font-family:ui-monospace,Consolas,monospace;flex:none;padding-right:0;}',
    // #b26a00 on a light sidebar, #ffb74d on a dark one: readable either way.
    // Capped at three lines: an exception can be a whole sentence, and a sentence that
    // grows the footer without bound would push the buttons under it (2026-10-04). The
    // full text stays readable in the widget's hover text.
    '.mmtok-state{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;max-height:4.5em;overflow:hidden;margin-top:1px;font-size:12px;line-height:1.5;color:#b26a00;overflow-wrap:anywhere;}',
    '.mmtok-hidden{display:none;}',
    // Collapsed rail (~54px): one status entry. The dot stays — colour plus aria-label —
    // and the sentence that cannot be laid out in a 34px box is hidden from the eye but
    // NOT from the accessibility tree: the live region must keep announcing, and the
    // singleton's hover text still carries the whole report.
    '.mmtok-compact{padding:6px 0;text-align:center;}',
    '.mmtok-compact .mmtok-btns{justify-content:center;gap:0;}',
    '.mmtok-compact .mmtok-btn,.mmtok-compact .mmtok-elapsed{display:none;}',
    '.mmtok-compact .mmtok-state{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;}',
    '@media (prefers-color-scheme:dark){.mmtok-state{color:#ffb74d;}}',
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
    diag.booted = true
    // Timers first, then the steps: whichever step throws, the widget must still end up in
    // the page and keep retrying. A throw in this function used to leave no timer at all —
    // the panel stayed empty for the life of the page (2026-10-04 real run).
    intervalIds.push(setInterval(function () { render() }, 1000))
    // A login in progress is the one state where a 10-second poll is too slow to be
    // honest: the capture arm finishes on its own, and the user is standing there
    // waiting for the panel to say so. Poll faster while that is what we are showing.
    intervalIds.push(setInterval(function () { refresh() }, 10000))
    intervalIds.push(setInterval(function () {
      if (store.status === 'waiting-login' || store.status === 'processing') refresh()
    }, 2000))
    // Re-mount if the sidebar re-renders (React swaps nodes) or was missing.
    intervalIds.push(setInterval(function () { tryMount() }, 2000))
    try { injectStyle() } catch (e) { noteError('injectStyle', e) }
    try { ensureDom() } catch (e) { noteError('ensureDom', e) }
    try { tryMount() } catch (e) { noteError('tryMount', e) }
    diag.mounted = !!(box && box.isConnected)
    try { refresh() } catch (e) { noteError('refresh', e) }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
