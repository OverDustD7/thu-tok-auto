// Dev-only capture harness: drives the machine's own Chrome over the DevTools
// protocol against the isolated preview (test/preview/server.mjs) and records
//
//   * numbers  -> measure.jsonl   (geometry, state text, colours, overflow)
//   * pictures -> shot-*.png      (for a human to look at; not evidence by itself)
//
// It uses no pipes (the DSH sandbox forbids piped stdio), talks only to
// 127.0.0.1, and never touches real credentials.
//
//   node test/preview/server.mjs 8799      # in another shell
//   node test/preview/capture.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9223)
const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:8799/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const scenarios = ['ok', 'no-progress', 'partial', 'needs-login', 'offline', 'expired', 'busy', 'idle', 'long']
const configs = []
for (const scenario of scenarios) {
  for (const scheme of ['light', 'dark']) configs.push({ scenario, scheme, width: 260 })
}
for (const scenario of ['ok', 'no-progress', 'needs-login', 'offline']) {
  for (const scheme of ['light', 'dark']) configs.push({ scenario, scheme, width: 200 })
}
// The host sidebar's two real widths (2026-10-04): 54px is the collapsed rail, which
// must collapse to a single status entry instead of wrapping one control and one
// character per line; 280px is the expanded panel, which must keep the full row.
for (const scenario of ['ok', 'needs-login', 'busy', 'offline', 'long']) {
  for (const scheme of ['light', 'dark']) configs.push({ scenario, scheme, width: 54 })
}
for (const scenario of ['ok', 'needs-login', 'long']) {
  for (const scheme of ['light', 'dark']) configs.push({ scenario, scheme, width: 280 })
}
const shots = new Set(['ok/light/260', 'ok/dark/260', 'needs-login/light/260', 'offline/dark/260',
  'no-progress/light/200', 'partial/dark/200', 'needs-login/light/54', 'long/light/260'])
// Dev convenience for a quick mount/layout check: PREVIEW_ONLY=ok/light/260,long/light/260.
if (process.env.PREVIEW_ONLY) {
  const want = new Set(process.env.PREVIEW_ONLY.split(','))
  for (let i = configs.length - 1; i >= 0; i--) {
    if (!want.has(configs[i].scenario + '/' + configs[i].scheme + '/' + configs[i].width)) configs.splice(i, 1)
  }
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(process.env.TEMP || '/tmp', 'mmtok-preview-cdp'),
  '--window-size=1000,700', 'about:blank',
], { detached: true, stdio: 'ignore' })
chrome.unref()

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version')
      if (r.ok) return true
    } catch (e) { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('Chrome did not open a DevTools endpoint on port ' + PORT)
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 0
    const pending = new Map()
    const waiters = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const slot = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) slot.reject(new Error(msg.method + ' ' + JSON.stringify(msg.error)))
        else slot.resolve(msg.result)
        return
      }
      if (!msg.method) return
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method) {
          const w = waiters.splice(i, 1)[0]
          clearTimeout(w.timer)
          w.resolve(msg)
        }
      }
    })
    ws.addEventListener('error', () => reject(new Error('DevTools websocket error')))
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const id = ++nextId
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params: params || {} }))
        })
      },
      waitEvent(method, timeoutMs = 20000) {
        return new Promise((res, rej) => {
          const w = { method, resolve: res }
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w)
            if (i >= 0) waiters.splice(i, 1)
            rej(new Error('timeout waiting for ' + method))
          }, timeoutMs)
          waiters.push(w)
        })
      },
      close() { ws.close() },
    }))
  })
}

const lines = []
const summary = []
let cdp = null

try {
  await endpoint()
  const target = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json()
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  for (const cfg of configs) {
    const url = BASE + '?scenario=' + cfg.scenario + '&scheme=' + cfg.scheme + '&width=' + cfg.width
    const loaded = cdp.waitEvent('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await loaded
    await sleep(1600) // let ui.js finish its first status round-trip
    const out = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(measure())', returnByValue: true, awaitPromise: false,
    })
    const json = out.result.value
    if (!json) {
      const probe = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ measure: typeof measure, cleanup: typeof window.__mmtokUiCleanup, box: !!document.querySelector(".mmtok-box"), error: window.__mmtokPreviewError || null })',
        returnByValue: true,
      })
      throw new Error('measure() returned nothing for ' + url + ' :: ' + JSON.stringify(out) + ' :: ' + probe.result.value)
    }
    lines.push(json)
    const m = JSON.parse(json)
    // Mount facts straight off the page (2026-10-04: a real tab showed no widget at all
    // while the script tag was present, so the harness now reports what the widget itself
    // says about where it went and how often it had to re-mount).
    const diag = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__mmtokUiDiag || null)', returnByValue: true,
    })
    const d = diag.result.value ? JSON.parse(diag.result.value) : null
    const boxes = await cdp.send('Runtime.evaluate', {
      expression: 'String(document.querySelectorAll(".mmtok-box").length)', returnByValue: true,
    })
    summary.push([m.scenario, m.scheme, m.width,
      /mmtok-compact/.test(m.boxClass || '') ? 'compact' : 'full',
      m.dotClass, m.stateText || '(quiet)', 'getDisabled=' + m.getDisabled,
      'boxH=' + (m.box ? m.box.h : '?'), 'stateH=' + (m.state ? m.state.h : '?'),
      'spills=' + (m.overflow && m.overflow.spills), m.stateColour,
      'mount=' + (d ? d.lastMount : '(no diag)') + '/boxes=' + boxes.result.value +
        '/mounts=' + (d ? d.mounts : '?') + '/booted=' + (d ? d.booted : '?')].join(' | '))
    const key = cfg.scenario + '/' + cfg.scheme + '/' + cfg.width
    if (shots.has(key)) {
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(here, 'shot-' + cfg.scenario + '-' + cfg.scheme + '-' + cfg.width + '.png'),
        Buffer.from(png.data, 'base64'))
    }
  }
  fs.writeFileSync(path.join(here, 'measure.jsonl'), lines.join('\n') + '\n', 'utf8')
  const ok = JSON.parse(lines.find((l) => l.includes('"scenario": "ok"') && l.includes('"scheme": "light"') && l.includes('"width": 260')) || lines[0])
  console.log('captured ' + lines.length + ' runs')
  console.log('scenario | scheme | width | layout | dot | visible state | getDisabled | boxH | stateH | overflow | stateColour')
  summary.forEach((s) => console.log('  ' + s))
  console.log('geometry ok/light/260: ' + JSON.stringify({
    sidebar: ok.sidebar, footArea: ok.footArea, box: ok.box, dot: ok.dot, get: ok.get, auto: ok.auto,
    elapsed: ok.elapsed, footIcon: ok.footIcon, footLabel: ok.footLabel, state: ok.state, fontSize: ok.fontSize,
    boxPad: ok.boxPad, dotColour: ok.dotColour, overflow: ok.overflow, flattenedDarkRules: ok.flattenedDarkRules,
  }))

  // ---- interaction phase: what a click, a keyboard user and a double-injected
  // ---- script each actually produce. Numbers again, not impressions.
  const snap = async (label) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(measure())', returnByValue: true,
    })
    const m = JSON.parse(r.result.value)
    console.log('  ' + label + ' :: get=' + (m.getDisabled ? 'disabled' : 'enabled') +
      ' ariaBusy=' + m.getAriaBusy + ' auto=' + JSON.stringify(m.autoText) + ' pressed=' + m.autoPressed +
      ' dot=' + m.dotClass + ' clock=' + JSON.stringify(m.elapsedText) +
      ' state=' + JSON.stringify(m.stateText) + ' stateH=' + m.state.h + ' boxH=' + m.box.h)
    return m
  }
  const loaded2 = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: BASE + '?scenario=ok&scheme=light&width=260' })
  await loaded2
  await sleep(1600)
  console.log('interaction phase (scenario ok):')
  await snap('before click')
  await cdp.send('Runtime.evaluate', { expression: 'document.querySelectorAll(".mmtok-btns button")[0].click()' })
  await sleep(60)
  await snap('just after click')
  await sleep(500)
  await snap('after the round-trip')
  await sleep(16000)
  await snap('16s later (notice expires)')
  const clickAuto = 'document.querySelectorAll(".mmtok-btns button")[1].click()'
  await cdp.send('Runtime.evaluate', { expression: clickAuto })
  await sleep(600)
  await snap('after clicking Auto (was on)')
  await cdp.send('Runtime.evaluate', { expression: clickAuto })
  await sleep(600)
  await snap('after clicking Auto again (was off)')
  // Keyboard focus: press Tab until the widget's Get button is focused, then read
  // the computed outline (a focus ring that only exists on paper is not a ring).
  for (let i = 0; i < 20; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    const who = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ tag: document.activeElement.tagName, text: document.activeElement.textContent, cls: document.activeElement.className })',
      returnByValue: true,
    })
    const info = JSON.parse(who.result.value)
    if (info.cls && info.cls.indexOf('mmtok-btn') >= 0) {
      const style = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ outline: getComputedStyle(document.activeElement).outlineWidth, colour: getComputedStyle(document.activeElement).outlineColor, text: document.activeElement.textContent })',
        returnByValue: true,
      })
      console.log('  keyboard focus after ' + (i + 1) + ' Tab: ' + style.result.value)
      break
    }
    if (i === 19) console.log('  keyboard focus: never reached the widget')
  }
  // Duplicate injection: the guard must leave exactly one widget behind.
  await cdp.send('Runtime.evaluate', {
    expression: 'var s=document.createElement("script"); s.src="/thu-tok-auto/ui.js"; document.body.appendChild(s);',
  })
  await sleep(1200)
  const dup = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ boxes: document.querySelectorAll(".mmtok-box").length, styles: document.querySelectorAll("#mmtok-style").length, loaded: !!window.__mmtokUiLoaded, cleanup: typeof window.__mmtokUiCleanup })',
    returnByValue: true,
  })
  console.log('  after injecting ui.js a second time: ' + dup.result.value)
} finally {
  if (cdp) cdp.close()
  spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
}
