'use strict';
// THU Tok Auto — DSH profile bundle (Cordis plugin) entry.
//
// Runs directly in the DSH host process: no node:vm sandbox, no subprocess helpers.
// Node's built-in fetch / WebSocket / fs / child_process provide the environment;
// DSH services provide settings, credentials, timers, the web server and request auth.
//
// Client UI is a plain global script (lib/ui.js) contributed through DSH's
// structured index-injection table, talking to the JSON API below. Because the tag is
// regenerated on every full page load, the buttons survive F5 (unlike the dynamic
// session-plugin form) while Host-side Auto keeps running regardless.
import fs from 'node:fs'
import { dirname } from 'node:path'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { createCore, SSO_LOGIN_URL } from './core.js'
import { normalizePath } from './carrier-profile.js'
import { createSecretStore, createUnsupportedStore } from './secret-store.js'
import {
  SSO_ORIGIN, FACTS_EXPR, classifyPage, scrubFacts, buildFillScript, createAutoLogin,
} from './auto-login.js'

const name = 'thu-tok-auto'
const inject = ['settings', 'credentials', 'timer', 'webServer', 'connection']

// The bundle's own version, straight from the package.json that sits beside lib/. Read once,
// best-effort: a host that cannot read it simply shows no version instead of failing to load
// (the file is part of the published bundle, so in practice this reads the installed one).
let ownVersion = null
function readOwnVersion() {
  if (ownVersion !== null) return ownVersion
  ownVersion = ''
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(raw)
    if (pkg && typeof pkg.version === 'string') ownVersion = pkg.version
  } catch (e) { /* version is display-only */ }
  return ownVersion
}

const jsonParse = function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } }

// A rename over an existing file is atomic, but Windows can refuse it for a moment while a
// filter driver or an indexer still holds the destination that was just replaced. That is a
// flake, not a refusal: retry briefly before believing it (2026-10-04, the run's own record
// was lost this way while the state itself went through).
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT'])
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The two deps that talk to a browser — the native hidden-page carrier and the CDP reader —
// are defined inline below so they sit next to the comments that justify them. They use
// nothing from the dependency set (only fetch/WebSocket and module helpers), which makes them
// drivable on their own; they are handed out through this holder so the real-machine closure
// probe can exercise the shipped code instead of a re-typed copy of it.
// Nothing in the plugin reads this: it is a test seam, like applyWithDeps and createApiHandlers.
const carrierDefaults = { hiddenTarget: null, cdp: null, sessionRestore: null, listBrowserProfiles: null, loginDriver: null }

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

async function readResponseText(response, maxBytes = 1024 * 1024) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new Error('response too large')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    try { await reader.cancel() } catch (e) {}
  }
}

// Requirement D (2026-10-04 round 9): the one page-reading the core may ask for — what the
// no-window browser is actually looking at. It returns a title, an origin+path (no query, no
// hash), which of the two forms is on the page, whether the device page's own fingerprint
// library is loaded, and whether the document has finished loading. It reads; it never types,
// submits, or touches a credential field.
const PAGE_PROBE_EXPR = "(function(){try{var d=document;var q=function(s){try{return !!d.querySelector(s)}catch(e){return false}};"
  + "var hasPwd=q('input[type=password]');var hasFp=q('input[name=fingerPrint]')||q('#fingerGenPrint')||q('input[name=fingerGenPrint]');"
  + "var fp2=(typeof Fingerprint2!=='undefined')||(typeof window.Fingerprint2!=='undefined');"
  + "var form=hasPwd?'login-form':(hasFp?'device-fingerprint':(d.readyState==='complete'?(q('form')?'unknown':'none'):'loading'));"
  + "return JSON.stringify({title:String(d.title||''),path:String(location.origin||'')+String(location.pathname||''),form:form,fp2:fp2,ready:d.readyState==='complete'})"
  + "}catch(e){return JSON.stringify({error:String(e)})}})()"

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
      if (bytes > maxBytes) {
        req.resume()
        return done(httpError(413, '请求体过大。'))
      }
      chunks.push(Buffer.from(chunk))
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { done(null, text ? JSON.parse(text) : {}) } catch (e) { done(httpError(400, 'JSON 格式无效。')) }
    }
    const onError = (e) => done(e)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function json(res, value, code = 200, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  })
  res.end(JSON.stringify(value))
}

/**
 * Whatever answers on this port, and *who* it is — the one fact that has to be settled before
 * any page or cookie is touched. Round 18 (2026-10-05) split this out of the CDP reader: the
 * reader used to ask /json/list first and only then ask who was listening, so a cold browser
 * sitting on about:blank — exactly what the no-window restore arm starts with — was reported
 * as "no target", and a page read could be aimed at a browser whose identity was never
 * checked. One request, one question: this asks /json/version and nothing else.
 *
 * Reasons are named: 'no-devtools' (nothing answers on this port) and 'no-instance-id' (the
 * endpoint answered, but what it hands out is not this port's own browser id). Neither is ever
 * "it is ours" — the id is returned only for a ws:// URL that is this port's
 * /devtools/browser/<uuid>.
 */
const INSTANCE_ID = /^[0-9a-f][0-9a-f-]{7,}$/

/**
 * The shape of a value this file accepts as a browser instance id — the uuid DevTools hands out
 * in /devtools/browser/<uuid>. A read of *our* browser has to state one of these; an empty or
 * malformed value is not an identity and is never read as "no expectation, so go ahead and look
 * at whatever is on the port". Round-18 audit (2026-10-05): that was the one hole left — with
 * `uuid: ''` the reader skipped the identity question and went straight to /json/list.
 */
const isInstanceId = function (value) { return INSTANCE_ID.test(String(value || '').toLowerCase()) }

export async function readInstance(port, timeoutMs) {
  let info = null
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(timeoutMs || 1500) })
    if (!r || !r.ok) return { ok: false, reason: 'no-devtools' }
    info = jsonParse(await readResponseText(r))
  } catch (e) { return { ok: false, reason: 'no-devtools' } }
  let url = null
  try { url = new URL(String((info && info.webSocketDebuggerUrl) || '')) } catch (e) { url = null }
  const host = url ? url.hostname.toLowerCase() : ''
  if (!url || url.protocol !== 'ws:' ||
      (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') ||
      Number(url.port) !== Number(port)) return { ok: false, reason: 'no-instance-id' }
  const m = url.pathname.match(/\/devtools\/browser\/([0-9a-zA-Z-]{8,})/)
  return m ? { ok: true, id: m[1].toLowerCase() } : { ok: false, reason: 'no-instance-id' }
}

/**
 * The instance, retried while the endpoint is still coming up — a browser that was spawned a
 * moment ago answers /json/version a little later than the spawn call returns. Only this is
 * ever retried: a caller that states which instance it expects must never be walked into a
 * page read just because the port took a second to answer.
 */
async function waitForInstance(port, untilMs) {
  let seen = { ok: false, reason: 'no-devtools' }
  for (;;) {
    seen = await readInstance(port)
    if (seen.ok || seen.reason !== 'no-devtools' || Date.now() >= untilMs) return seen
    await new Promise((r) => setTimeout(r, 300))
  }
}

const hostOf = function (url) { try { return new URL(url).hostname.toLowerCase() } catch (e) { return '' } }

/**
 * One line of a browser event, bounded and de-identified before it can leave this file:
 * at most 200 characters, query strings dropped and long opaque runs masked (tickets and
 * tokens live in both). Returns '' for an event that is not an error at all.
 */
function maskProbeLine(text) {
  return String(text == null ? '' : text).replace(/\?[^\s]*/g, '?…').replace(/[A-Za-z0-9_\-]{24,}/g, '…').slice(0, 200)
}
function probeErrorFrom(m) {
  if (!m || !m.method) return ''
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params && m.params.exceptionDetails
    const ex = d && d.exception
    return 'js ' + String((ex && (ex.description || ex.value)) || (d && d.text) || 'exception')
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params && m.params.entry
    if (e && (e.level === 'error' || e.level === 'warning')) return String(e.level) + ' ' + String(e.text || e.url || '')
  }
  return ''
}

/**
 * Read one page over an already-open DevTools connection. Both carriers run this exact
 * code (2026-10-04 round 10): the window that shows up in /json/list as a page, and the
 * native hidden target that lives and dies with the browser-level socket that created it.
 * `send` takes an optional session id, which is what a target attached with flatten:true
 * requires; the page-level connection simply leaves it empty. The caller owns the socket —
 * this reads.
 */
async function readCdpPage(send, sessionId, probe, probeErrors) {
  const sid = sessionId || undefined
  try { await send('Network.enable', {}, sid) } catch (e) {}
  // Runtime.enable is what makes exceptionThrown events arrive at all; Log.enable adds
  // the browser's own error/warning entries. Both are best-effort: not being able to
  // take a page reading must not fail a capture that would otherwise work.
  if (probe) {
    try { await send('Runtime.enable', {}, sid) } catch (e) {}
    try { await send('Log.enable', {}, sid) } catch (e) {}
  }
  let ck = null
  try { ck = await send('Network.getAllCookies', {}, sid) } catch (e) {}
  let ev = null
  try {
    ev = await send('Runtime.evaluate', {
      // location.href is read BEFORE localStorage, and each has its own try: on an opaque-origin
      // page (about:blank) reading localStorage throws a SecurityError, and the round-10 closure
      // probe showed that a shared try loses the URL reading along with the token — the panel and
      // the trace would then report an empty url for a page they did read. The token is still only
      // accepted from the madmodel host below, so this changes diagnostics, not the verdict.
      expression: "(function(){var url='';try{url=String(location.href||'')}catch(e){}var t='';try{var u=window.localStorage.getItem('user');if(u){try{t=(JSON.parse(u).token)||''}catch(e){}}}catch(e){}return JSON.stringify({token:t,url:url})})()",
      returnByValue: true,
    }, sid)
  } catch (e) {}
  const cookies = (ck && ck.result && Array.isArray(ck.result.cookies)) ? ck.result.cookies : []
  const picked = []
  for (const c of cookies) {
    const d = String(c.domain || '').toLowerCase().replace(/^\.+/, '')
    if (!(d === 'tsinghua.edu.cn' || d.endsWith('.tsinghua.edu.cn'))) continue
    // Keep every attribute a Cookie header needs. The SSO chain spans several hosts
    // (id./oauth./auth*.tsinghua.edu.cn), so picking cookies by host at capture time
    // silently drops ones a replay depends on.
    picked.push({
      name: c.name,
      value: c.value,
      domain: d,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expires: typeof c.expires === 'number' ? c.expires : -1,
      session: !!c.session,
    })
  }
  let token = ''
  let url = ''
  try {
    const rv = ev && ev.result && ev.result.result && ev.result.result.value
    if (rv) {
      const j = jsonParse(rv)
      url = typeof j.url === 'string' ? j.url : ''
      if (hostOf(url) === 'madmodel.cs.tsinghua.edu.cn' && typeof j.token === 'string') token = j.token
    }
  } catch (e) {}
  let page = null
  if (probe) {
    try {
      const pe = await send('Runtime.evaluate', { expression: PAGE_PROBE_EXPR, returnByValue: true }, sid)
      const pv = pe && pe.result && pe.result.result && pe.result.result.value
      if (pv) page = jsonParse(pv)
    } catch (e) {}
  }
  return {
    token: token,
    url: url,
    cookies: picked,
    page: probe ? Object.assign({}, page || {}, { errors: probeErrors || [] }) : null,
  }
}

/**
 * Close ONE browser — the temporary window this plugin started — and nothing else.
 *
 * Ownership is the whole problem. A pid is recycled by the OS and a debug port can be
 * re-bound by the next process, so neither proves that whatever answers on `port` is the
 * instance this plugin launched. The browser's own DevTools identity (the UUID inside
 * ws://127.0.0.1:<port>/devtools/browser/<uuid>, handed out once per browser instance) is
 * the one value a recycled port cannot forge, and it must equal the id recorded at spawn
 * time. Missing or different evidence means "not ours": refuse, report it, touch nothing.
 * The id must have been recorded while the window was *known* to be ours — asking the
 * endpoint at close time would happily accept a port somebody else took over. When the
 * endpoint is gone but the process is still alive, the fallback is the owned lease and not a
 * bare pid: the tree must carry our exact --user-data-dir, our executable, and a tie to this
 * lease — the recorded pid with an unchanged start time, or our debug port on its command
 * line (2026-10-05 round 14 A; before that, a quiet endpoint simply refused to act).
 *
 * The RPC reply is not the proof either. Browser.close usually answers and then drops the
 * socket, but a socket that dies mid-request looks identical from here, and the old code
 * called a 3-second timeout a success. The verdict therefore comes from the instance's own
 * state afterwards: the endpoint must stop answering, and a known pid must be gone. An
 * error reply, a timeout or an early close never counts as closed by itself
 * (2026-10-04 audit, defect 2).
 */
/**
 * How far apart our spawn time and a process's own start time may be and still be the same
 * process. Wide enough for clock granularity and the launcher stub handing off to the real
 * browser, narrow enough that a recycled pid (hours later) can never pass.
 */
const SPAWN_TIME_TOLERANCE_MS = 3000

/**
 * One `--flag=value` argument out of a command line, read at argv boundaries (2026-10-05 round
 * 16). Substring matching was a real defect: `--user-data-dir=...\profile` also occurs inside
 * `--user-data-dir=...\profile-backup`, and `--remote-debugging-port=9333` is a prefix of
 * `93330`, so the old test could tie a stranger's browser to our lease — and then kill it. The
 * value is read after the flag, honouring one layer of quotes, and every comparison below is
 * made between normalised values, never between substrings.
 */
export function argvValue(cmd, flag) {
  const text = String(cmd || '')
  const want = String(flag || '')
  if (!text || !want) return ''
  let from = 0
  for (;;) {
    const at = text.indexOf(want, from)
    if (at === -1) return ''
    from = at + want.length
    const before = at === 0 ? '' : text[at - 1]
    if (before && !/[\s"']/.test(before)) continue
    const after = text[at + want.length]
    if (after === '=') {
      let i = at + want.length + 1
      const quote = (text[i] === '"' || text[i] === "'") ? text[i] : ''
      if (quote) i += 1
      let out = ''
      while (i < text.length) {
        const ch = text[i]
        if (quote ? ch === quote : /\s/.test(ch)) break
        out += ch
        i += 1
      }
      return out
    }
    if (after === undefined || /\s/.test(after)) {
      // `--flag <value>` is not how this plugin spells its argv, but a launcher sitting between
      // us and the browser may re-print it that way; only an explicit token counts.
      let i = at + want.length
      while (i < text.length && /\s/.test(text[i])) i += 1
      const quote = text[i] === '"' ? text[i] : ''
      if (quote) i += 1
      let out = ''
      while (i < text.length) {
        const ch = text[i]
        if (quote ? ch === quote : /\s/.test(ch)) break
        out += ch
        i += 1
      }
      if (out) return out
    }
  }
}

/** A Windows path as one comparable value: separators unified, trailing ones dropped, folded. */
export function normalizePathValue(value) {
  return normalizePath(value)
}

/** The debug port on a command line as an exact number (0 = the argument is not there). */
export function portValue(cmd) {
  const raw = argvValue(cmd, '--remote-debugging-port')
  return /^\d{1,5}$/.test(raw) ? Number(raw) : 0
}

/**
 * The process table as a *reading*, not as an array (2026-10-05 round 16). "The listing
 * failed" and "the listing answered and nothing of ours is standing" are different facts, and
 * only the second one may ever be reported as a closed browser: an empty array that came from
 * a crashed PowerShell must not turn into "已关掉". The array form stays accepted for callers
 * that already hold rows (fixtures, probes).
 */
export function readProcessTable(list) {
  if (Array.isArray(list)) return { ok: true, rows: list, error: '' }
  if (list && typeof list === 'object') {
    if (list.ok === false) return { ok: false, rows: [], error: String(list.error || 'list-failed') }
    if (Array.isArray(list.rows)) return { ok: true, rows: list.rows, error: '' }
  }
  return { ok: false, rows: [], error: 'no-table' }
}

/**
 * The two readings a close-by-kill is allowed to stand on, and nothing else (2026-10-05 round
 * 14 A; tightened in round 16). Both the async closer and the synchronous one used at host exit
 * share this decision, so "did we have the right to kill this" cannot differ between the paths.
 *
 * A process counts as ours only when all of these hold:
 *   1. the listing answered at all — a failed listing refuses, it never means "nothing there";
 *   2. the lease carries the profile, the executable, the port, the pid and the spawn time —
 *      a missing field refuses instead of silently dropping the check it belongs to;
 *   3. its command line carries *exactly* this `--user-data-dir` (parsed at argv boundaries, so
 *      `profile-backup` is not `profile`) and its executable is the one we launched;
 *   4. the recorded pid is present and its start time still matches — a missing or moved start
 *      time refuses, and a port tie is not allowed to rescue it (that was the recycled-number
 *      hole); only when no row carries the recorded pid may the exact debug port be the tie.
 * The tree that may then be stopped is the tied root plus its descendants and any row carrying
 * exactly this port — nothing else, and never by image name (2026-10-04 audit defect 2).
 */
export function classifyOwnTree(list, lease) {
  const table = readProcessTable(list)
  const wantProfile = normalizePathValue(lease && lease.profile)
  const wantExe = String((lease && lease.exe) || '').trim().toLowerCase()
  const wantPid = Number((lease && lease.pid) || 0)
  const wantPort = Number((lease && lease.port) || 0)
  const wantAt = Number((lease && lease.spawnedAt) || 0)
  if (!table.ok) return { ok: false, reason: 'process-list-failed', why: table.error, mine: [] }
  if (!wantProfile) return { ok: false, reason: 'no-ownership-evidence', why: 'no-profile', mine: [] }
  if (!wantExe) return { ok: false, reason: 'no-ownership-evidence', why: 'no-exe', mine: [] }
  if (!wantPort) return { ok: false, reason: 'no-ownership-evidence', why: 'no-port', mine: [] }
  if (!wantPid) return { ok: false, reason: 'no-ownership-evidence', why: 'no-pid', mine: [] }
  if (!wantAt) return { ok: false, reason: 'no-ownership-evidence', why: 'no-spawn-time', mine: [] }
  const byProfile = table.rows.filter((p) => normalizePathValue(argvValue(p && p.cmd, '--user-data-dir')) === wantProfile)
  if (!byProfile.length) return { ok: false, reason: 'nothing-to-kill', mine: [] }
  const exeBad = byProfile.filter((p) => String((p && p.exe) || '').trim().toLowerCase() !== wantExe)
  if (exeBad.length) return { ok: false, reason: 'exe-mismatch', mine: [], saw: exeBad.map((p) => Number(p.pid) || 0) }
  const byPid = byProfile.filter((p) => Number(p.pid) === wantPid)
  let root = null
  let tie = ''
  if (byPid.length) {
    const at = Number(byPid[0].startedAt || 0)
    if (!at) return { ok: false, reason: 'spawn-time-unknown', mine: [], saw: [wantPid] }
    if (Math.abs(at - wantAt) > SPAWN_TIME_TOLERANCE_MS) {
      // The pid is ours on paper but the process behind it started at a different moment: the
      // number was recycled, so this is somebody else's browser (refuse, do not kill) — and the
      // fact that it happens to carry our old debug port changes nothing.
      return { ok: false, reason: 'spawn-time-mismatch', mine: [], saw: [wantPid], startedAt: at }
    }
    root = byPid[0]
    tie = 'pid+time'
  } else {
    const byPort = byProfile.filter((p) => portValue(p && p.cmd) === wantPort)
    if (!byPort.length) return { ok: false, reason: 'no-ownership-evidence', mine: [], saw: byProfile.map((p) => Number(p.pid) || 0) }
    root = byPort[0]
    tie = 'port'
  }
  const mine = ownSubtree(byProfile, root, wantPort)
  return {
    ok: true, via: tie, rootPid: Number(root.pid) || 0,
    mine: mine.map((p) => ({ pid: Number(p.pid) || 0, exe: String(p.exe || ''), root: Number(p.pid) === Number(root.pid) })),
  }
}

/**
 * The processes a close may actually stop: the root this lease ties to, the descendants the
 * process table puts under it, and any row carrying this exact debug port (one instance, one
 * port). Another browser that merely shares the profile directory is left alone
 * (2026-10-05 round 16).
 */
function ownSubtree(rows, root, wantPort) {
  const kids = new Map()
  for (const r of rows) {
    const k = Number(r.ppid) || 0
    if (!kids.has(k)) kids.set(k, [])
    kids.get(k).push(r)
  }
  const out = []
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const r = stack.pop()
    const pid = Number(r && r.pid) || 0
    if (!pid || seen.has(pid)) continue
    seen.add(pid)
    out.push(r)
    for (const c of (kids.get(pid) || [])) stack.push(c)
  }
  for (const r of rows) {
    const pid = Number(r && r.pid) || 0
    if (!pid || seen.has(pid)) continue
    if (wantPort && portValue(r && r.cmd) === wantPort) { seen.add(pid); out.push(r) }
  }
  return out
}

// One read of the process table, msedge/chrome only (the two browsers resolveBrowser may
// pick). The profile filter is applied in JS, so the path is never pasted into a shell
// command and quoting cannot go wrong.
const PS_LIST_PROCESSES = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='StartedUtc';e={$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}} | ConvertTo-Json -Compress"

export function parseProcessJson(out) {
  const text = String(out || '').trim()
  if (!text) return []
  let data = null
  try { data = jsonParse(text) } catch (e) { return [] }
  const arr = Array.isArray(data) ? data : [data]
  return arr.filter((p) => p && typeof p === 'object').map((p) => ({
    pid: Number(p.ProcessId) || 0,
    ppid: Number(p.ParentProcessId) || 0,
    exe: String(p.ExecutablePath || ''),
    cmd: String(p.CommandLine || ''),
    startedAt: Date.parse(String(p.StartedUtc || '')) || 0,
  })).filter((p) => p.pid > 0)
}

/**
 * The listing's own answer, read strictly: no output is an empty table (nothing of that image
 * is running), output that does not parse is a *failed* listing rather than an empty one. The
 * difference decides whether a stale lease may be called closed (2026-10-05 round 16).
 */
function tableFromOutput(out) {
  const text = String(out || '').trim()
  if (!text) return { ok: true, rows: [], error: '' }
  const rows = parseProcessJson(text)
  if (!rows.length) return { ok: false, rows: [], error: 'unparsable-table' }
  return { ok: true, rows: rows, error: '' }
}

function listProcessesAsync(timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST_PROCESSES],
        { windowsHide: true, timeout: Number(timeoutMs) || 15000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) { resolve({ ok: false, rows: [], error: String((err && err.message) || err || 'list-failed') }); return }
          resolve(tableFromOutput(stdout))
        })
    } catch (e) { resolve({ ok: false, rows: [], error: String((e && e.message) || e) }) }
  })
}

function listProcessesSync(timeoutMs) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST_PROCESSES],
      { windowsHide: true, timeout: Number(timeoutMs) || 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
    return tableFromOutput(out)
  } catch (e) {
    const out = e && e.stdout ? String(e.stdout) : ''
    if (out) return tableFromOutput(out)
    return { ok: false, rows: [], error: String((e && e.message) || e || 'list-failed') }
  }
}

/**
 * Every profile directory a browser on this machine is holding, read once (2026-10-05 round 17).
 *
 * Why this exists: a Chromium started on a profile another process already holds does not
 * become a second browser — the singleton hands the argv to the running instance and the debug
 * port this plugin asked for never answers. So before spawning on the *shared* profile, the
 * plugin has to know whether that directory is already spoken for; if it is, this run gets its
 * own isolated one instead. What comes back is a reading, in the same sense as the process
 * table: `ok:false` means "nobody knows", which is why the caller falls back to the old
 * behaviour rather than treating it as an empty list.
 */
export function createProfileLister(deps = {}) {
  const list = typeof deps.listProcesses === 'function' ? deps.listProcesses : listProcessesAsync
  return async function listBrowserProfiles() {
    let table = null
    try {
      table = await list()
    } catch (e) {
      return { ok: false, dirs: [], error: String((e && e.message) || e) }
    }
    const read = readProcessTable(table)
    if (!read.ok) return { ok: false, dirs: [], error: read.error }
    const dirs = []
    for (const row of read.rows) {
      // Exact argv token, never a substring: `--user-data-dir=C:\...\profile-backup` is a
      // different directory, and one layer of quotes is honoured (round 16).
      const dir = normalizePath(argvValue(row && row.CommandLine, '--user-data-dir'))
      if (dir && dirs.indexOf(dir) === -1) dirs.push(dir)
    }
    return { ok: true, dirs: dirs, error: '' }
  }
}

function killPidAsync(pid, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: Number(timeoutMs) || 10000 },
        () => resolve(true))
    } catch (e) { resolve(false) }
  })
}

function killPidSync(pid, timeoutMs) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: Number(timeoutMs) || 10000, stdio: 'ignore' })
  } catch (e) { /* already gone counts as killed */ }
  return true
}

/**
 * The synchronous twin, for the one caller that cannot wait: the host calls this plugin's
 * dispose without awaiting it, so an async close would be cut off by the process exiting —
 * and the browser would outlive the host, which is exactly how the 2026-10-05 00:51 leftover
 * was born. Bounded by construction: one process listing, one taskkill per verified pid, one
 * confirming listing — and, since round 16, one *shared* budget for the whole stop, so a tree
 * of ten pids cannot turn the host's exit into "10 × 10 s". A listing that failed refuses
 * instead of counting as an empty table.
 */
export function createBrowserStopperSync(deps = {}) {
  const list = deps.listProcesses || listProcessesSync
  const kill = deps.killProcess || killPidSync
  const budgetMs = Number(deps.budgetMs) || 15000
  const killTimeoutMs = Number(deps.killTimeoutMs) || 10000
  const alive = deps.isProcessAlive || ((pid) => {
    try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
  })
  return function stopSync(arg) {
    const lease = arg && arg.owned && typeof arg.owned === 'object' ? arg.owned : null
    if (!lease) return { closed: false, reason: 'no-ownership-evidence', sync: true }
    const startedAt = Date.now()
    const left = () => budgetMs - (Date.now() - startedAt)
    const first = classifyOwnTree(list(), lease)
    if (!first.ok) {
      // Nothing of ours is standing: the lease was stale, which is a *closed* browser, not a
      // failure — but only say so when the table really answered (a failed listing is not an
      // empty one) and the pid is gone too.
      if (first.reason === 'nothing-to-kill' && !(lease.pid && alive(lease.pid))) {
        return { closed: true, via: 'probe', verified: true, sync: true, killed: [] }
      }
      return { closed: false, reason: first.reason, why: String(first.why || ''), sync: true, saw: first.saw || [] }
    }
    const killed = first.mine.map((p) => p.pid)
    // The budget is re-read for every pid on purpose: a single `per` computed once would allow
    // ten pids to spend ten seconds each, which is the very hole round 16 closes.
    for (const pid of killed) {
      if (left() <= 0) return { closed: false, reason: 'timeout', sync: true, killed: killed }
      kill(pid, Math.max(1000, Math.min(killTimeoutMs, left())))
    }
    const after = classifyOwnTree(list(), lease)
    if (!after.ok) {
      // A confirming listing that *failed* is not a close: an unreadable table must never be
      // read as an empty one (2026-10-05 round 16).
      if (after.reason === 'process-list-failed') {
        return { closed: false, reason: 'process-list-failed', why: String(after.why || ''), sync: true, killed: killed }
      }
      // Nothing tied to this lease is left, so the tree is gone. Rows that still carry our
      // profile but no longer tie to the lease (a process the browser spawned as it died) are
      // not ours to kill; they are named as a reading and the close stands.
      return { closed: true, via: 'kill', verified: true, sync: true, killed: killed, tie: first.via, leftover: (after.saw || []).slice(0, 8) }
    }
    if (after.mine.length) return { closed: false, reason: 'pid-alive-after-close', sync: true, killed: killed }
    return { closed: true, via: 'kill', verified: true, sync: true, killed: killed, tie: first.via }
  }
}

/**
 * Everything that closes a browser this plugin started, and only such a browser. A close is
 * proven three ways: the DevTools endpoint must answer with the instance id recorded at spawn
 * time (port and pid can both be recycled); or, when the endpoint is gone but our process is
 * still alive, the process table must tie the tree to this lease; and a browser that neither
 * answers nor is ours is left strictly alone. A close that cannot be proven is reported as
 * unproven and the caller keeps the evidence (2026-10-04 audit defect 1, 2026-10-05 round 14 A).
 */
export function createBrowserCloser(deps = {}) {
  const fetchFn = deps.fetch || fetch
  const WS = deps.WebSocket || globalThis.WebSocket
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  // A pid that exists but cannot be opened (EPERM) is a live pid, not a gone one.
  const alive = deps.isProcessAlive || ((pid) => {
    try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
  })
  const replyTimeoutMs = deps.replyTimeoutMs || 3000
  const settleTimeoutMs = deps.settleTimeoutMs || 5000
  const probeTimeoutMs = deps.probeTimeoutMs || 1200
  // One close gets one budget for *everything* it does — probing, listing, killing, confirming.
  // Round 16: killing a tree used to spend up to 10 s per pid sequentially, so a fifteen-process
  // browser could hold its caller (and the stop script) for minutes. The pids are now killed in
  // parallel under `killTimeoutMs`, and a close that runs out of budget says `timeout` instead of
  // pretending it finished.
  const budgetMs = Number(deps.budgetMs) || 20000
  const killTimeoutMs = Number(deps.killTimeoutMs) || 6000
  const listTimeoutMs = Number(deps.listTimeoutMs) || 8000
  const listProcesses = deps.listProcesses || listProcessesAsync
  const killProcess = deps.killProcess || killPidAsync
  const listWithin = (left) => listProcesses(Math.max(1000, Math.min(listTimeoutMs, left)))

  // null = nothing answers (or nothing usable); { refused } = answers but not locally.
  const endpoint = async (port) => {
    try {
      const r = await fetchFn('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(probeTimeoutMs) })
      if (!r || !r.ok) return null
      const info = jsonParse(await readResponseText(r))
      const ws = info && info.webSocketDebuggerUrl
      if (!ws) return null
      const u = new URL(ws)
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]'
      if (!local || Number(u.port || 80) !== port) return { refused: 'not-local' }
      const m = String(ws).match(/\/devtools\/browser\/([0-9a-zA-Z-]{8,})/)
      return { ws, id: m ? m[1].toLowerCase() : '' }
    } catch (e) { return null }
  }

  const requestClose = (wsUrl) => new Promise((resolve) => {
    let settled = false
    let sock = null
    const cleanup = () => {
      try { if (sock) { sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; sock.close() } } catch (e) {}
    }
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(t); cleanup(); resolve(r) } }
    let t = null
    try { sock = new WS(wsUrl) } catch (e) { resolve({ answered: false, reason: 'connect-threw' }); return }
    t = setTimeout(() => finish({ answered: false, reason: 'no-reply' }), replyTimeoutMs)
    sock.onopen = () => {
      try { sock.send(JSON.stringify({ id: 1, method: 'Browser.close' })) } catch (e) { finish({ answered: false, reason: 'send-failed' }) }
    }
    // Only the reply to *this* request counts; anything else on the socket is ignored.
    sock.onmessage = (ev) => {
      let m = null
      try { m = jsonParse(typeof ev.data === 'string' ? ev.data : '') } catch (e) {}
      if (!m || m.id !== 1) return
      finish(m.error ? { answered: true, ok: false, reason: 'refused' } : { answered: true, ok: true })
    }
    // A socket closing is not an answer: the browser drops it as it exits, and so does a
    // connection that simply broke. Recorded as such, settled by the state check below.
    sock.onclose = () => finish({ answered: false, reason: 'closed-early' })
    sock.onerror = () => finish({ answered: false, reason: 'socket-error' })
  })

  return async function closeBrowser(arg) {
    const port = Number((arg && arg.port) || 0)
    const pid = Number((arg && arg.pid) || 0)
    const want = String((arg && arg.uuid) || '').toLowerCase()
    const lease = arg && arg.owned && typeof arg.owned === 'object' ? arg.owned : null
    if (!port || port < 1024 || port > 65535) return { closed: false, reason: 'bad-port' }
    const startedAt = Date.now()
    const left = () => budgetMs - (Date.now() - startedAt)
    const ep = await endpoint(port)
    if (!ep) {
      // Nothing answers on the port any more. That alone is not proof while the process we
      // recorded is still alive — so the pid is asked first, and when it is alive the lease
      // decides: a tree carrying our exact profile, our executable and a tie to this lease may
      // be stopped (2026-10-05 round 14 A). Without that evidence the answer stays a reading,
      // exactly as before.
      const pidAlive = !!(pid && alive(pid)) || !!(lease && lease.pid && alive(lease.pid))
      if (!pidAlive) return { closed: true, via: 'probe', answered: false, verified: true }
      const stop = await stopOwnTree(lease, left())
      if (stop.closed) return stop
      const refused = String(stop.reason || '')
      // The state is the reading that matters — nothing answers on the port while the process we
      // recorded is still alive — and the reason nothing may be done about it rides along in
      // `why`. Two exceptions are stronger statements than the state and are reported as
      // themselves: a tree that *was* ours and would not die, and a close that ran out of its
      // budget (2026-10-05 round 14 A / round 16).
      if (refused === 'pid-alive-after-close') return { closed: false, reason: refused, saw: stop.saw || [] }
      if (refused === 'timeout') return { closed: false, reason: 'timeout', why: 'endpoint-silent-pid-alive', saw: stop.saw || [] }
      // An unreadable process table is its own verdict: the port is silent and the recorded pid is
      // alive, but nothing could be proven about ownership, so this must not be softened into a
      // "someone else is on the port" reading (2026-10-05 round 16).
      if (refused === 'process-list-failed') return { closed: false, reason: 'process-list-failed', why: 'endpoint-silent-pid-alive', saw: stop.saw || [] }
      return { closed: false, reason: 'endpoint-silent-pid-alive', why: refused, saw: stop.saw || [] }
    }
    if (ep.refused) return { closed: false, reason: ep.refused }
    if (!want) {
      // The identity is not known yet — the spawn happened milliseconds ago, or the probe that
      // reads it never answered. A port answering is still not proof: a leftover of an earlier
      // run can be holding it. The process table can prove it, though — exact profile, our
      // executable, and a tie to this lease (our pid whose start time still matches, or our exact
      // debug port when no row carries the recorded pid) — and only then is this browser closed.
      // "The spawn just started, the identity is not in hand yet" must still have a bounded exit
      // (round 14 A).
      const proof = lease ? classifyOwnTree(await listWithin(left()), lease) : null
      if (!proof || !proof.ok) {
        // A table that could not be read is named as such — it is not evidence of absence, so it
        // must not read like the ordinary "nothing of ours is in the table" refusal.
        if (proof && proof.reason === 'process-list-failed') {
          return { closed: false, reason: 'process-list-failed', why: 'endpoint-answered-identity-unknown', answered: true }
        }
        return { closed: false, reason: 'no-ownership-evidence', why: proof ? String(proof.why || proof.reason) : 'no-lease', answered: true }
      }
    } else if (!ep.id || ep.id !== want) {
      return { closed: false, reason: 'not-ours', sawInstanceId: !!ep.id }
    }
    const rpc = await requestClose(ep.ws)
    if (rpc.answered && rpc.ok === false) return { closed: false, reason: 'refused-by-browser' }
    const deadline = Math.min(Date.now() + settleTimeoutMs, startedAt + budgetMs)
    let portSilent = false
    while (Date.now() < deadline) {
      await sleep(300)
      const again = await endpoint(port)
      if (again) continue
      portSilent = true
      break
    }
    if (portSilent) {
      // The browser accepted the close and its debug port is gone; the last thing to prove is that
      // the process we recorded is gone too. A graceful Edge shutdown can outlive the settle window
      // by seconds — measured on the real machine 2026-10-05: the port died while the main pid was
      // still exiting, and the close was reported unproven although the tree did disappear a moment
      // later. So the remainder of the close budget is spent on the pid instead of giving up.
      while (left() > 0 && pid && alive(pid)) await sleep(300)
      if (!pid || !alive(pid)) return { closed: true, via: 'cdp', answered: !!rpc.answered, verified: true }
      return { closed: false, reason: 'pid-alive-after-close' }
    }
    if (left() <= 0) return { closed: false, reason: 'timeout', why: 'graceful-close-unconfirmed', answered: !!rpc.answered }
    return { closed: false, reason: 'still-running', answered: !!rpc.answered }
  }

  /**
   * Stop the tree the lease describes, and only after the process table agrees it is ours.
   * Killing is the last resort: it happens when the browser is still running but no longer
   * answers its own debug port, which is the one state a graceful Browser.close cannot reach.
   * One budget covers the whole stop, and the pids die in parallel (2026-10-05 round 16).
   */
  async function stopOwnTree(lease, budgetLeft) {
    if (!lease) return { closed: false, reason: 'no-ownership-evidence' }
    const budget = Number(budgetLeft) > 0 ? Number(budgetLeft) : budgetMs
    const startedAt = Date.now()
    const left = () => budget - (Date.now() - startedAt)
    const first = classifyOwnTree(await listWithin(left()), lease)
    if (!first.ok) {
      // The same rule the synchronous stopper uses, word for word, so the two paths cannot
      // disagree: nothing carrying our profile is a browser that is already gone — a closed
      // one — but only when the table really answered and the pid we recorded is gone too. A live
      // recorded pid with no tree behind it is a recycled number, and that is a reading, not a
      // close.
      if (first.reason === 'nothing-to-kill' && !(lease.pid && alive(lease.pid))) {
        return { closed: true, via: 'probe', verified: true, answered: false, killed: [] }
      }
      return { closed: false, reason: first.reason, why: String(first.why || ''), saw: first.saw || [], killed: [] }
    }
    const killed = first.mine.map((p) => p.pid)
    await Promise.all(first.mine.map((p) => killProcess(p.pid, Math.max(1000, Math.min(killTimeoutMs, left())))))
    if (left() <= 0) return { closed: false, reason: 'timeout', killed: killed }
    const after = classifyOwnTree(await listWithin(left()), lease)
    if (!after.ok) {
      // Same rule as the synchronous twin, word for word: a failed confirming listing refuses,
      // while "nothing tied to the lease is left" is a close with the untied rows named.
      if (after.reason === 'process-list-failed') {
        return { closed: false, reason: 'process-list-failed', why: String(after.why || ''), saw: [], killed: killed }
      }
      return { closed: true, via: 'kill', verified: true, answered: false, killed: killed, tie: first.via, leftover: (after.saw || []).slice(0, 8) }
    }
    if (after.mine.length) return { closed: false, reason: 'pid-alive-after-close', saw: after.mine.map((p) => p.pid), killed: killed }
    return { closed: true, via: 'kill', verified: true, answered: false, killed: killed, tie: first.via }
  }
}

/**
 * May a verdict from the graceful (asynchronous) closer be retried by the synchronous stopper?
 * (2026-10-05 round 16.) Only when the first attempt *ran out* — its budget expired, the
 * confirming read was inconclusive, or it threw. A verdict that says "that browser is not this
 * plugin's" (or that the evidence is missing) is a decision, not an accident: retrying it
 * synchronously with the same lease would be a second, more permissive attempt at killing a
 * browser we just decided we do not own — and `taskkill /PID` does not check instance ids, so it
 * would land on whoever holds that pid now. `stop-owned.js` asks this function instead of
 * deciding by itself.
 */
export function syncFallbackAllowed(verdict) {
  const reason = String((verdict && verdict.reason) || (verdict && verdict.closed === false ? 'unknown' : ''))
  if (!reason) return false
  // `pid-alive-after-close` is a state reading about a browser this attempt already identified —
  // the debug endpoint answered with *our* instance id, and the tree survived the whole close
  // budget. It is not a decision that the browser belongs to someone else, so the synchronous
  // stopper may take it over; that path proves ownership from the process table again before it
  // kills anything, and it never kills by image name (2026-10-05 round 16, measured on a real
  // Edge whose graceful shutdown outlasted the settle window).
  return reason === 'timeout' || reason === 'still-running' || reason === 'threw' || reason === 'pid-alive-after-close'
}

/**
 * Which saved cookies may be handed back to a freshly spawned browser, and to which host
 * (2026-10-05 round 16). The rule is deliberately narrow: a cookie goes back only to the very
 * host it came from — that host or a subdomain of it, never a sibling, and the domain is never
 * rewritten — and only while it is still valid. Session cookies (expiry missing or ≤ 0) are
 * exactly the ones this exists for: the SSO login cookie is a session cookie, which is why a
 * browser started with `--no-session-restore` cannot see the session the HTTP leg still holds.
 * No cookie *value* is ever returned or logged by this function; only names and verdicts.
 */
export function planSessionRestore(jar, targetUrl, nowMs) {
  const out = { ok: false, why: '', host: '', cookies: [], skipped: [] }
  let target = null
  try { target = new URL(String(targetUrl || '')) } catch (e) { out.why = 'bad-url'; return out }
  const host = target.hostname.toLowerCase()
  out.host = host
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) { out.why = 'unsafe-target'; return out }
  const now = Number(nowMs) || Date.now()
  const nameOk = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,120}$/
  for (const raw of (Array.isArray(jar) ? jar : [])) {
    const c = raw && typeof raw === 'object' ? raw : null
    if (!c) continue
    const name = String(c.name || '')
    if (!nameOk.test(name) || typeof c.value !== 'string') { out.skipped.push(name || '(unnamed)'); continue }
    const domain = String(c.domain || '').replace(/^\./, '').toLowerCase()
    if (!domain || !(host === domain || host.endsWith('.' + domain))) { out.skipped.push(name); continue }
    const path = String(c.path || '/')
    if (path[0] !== '/') { out.skipped.push(name); continue }
    let expires = Number(c.expires)
    if (Number.isFinite(expires) && expires > 1e12) expires = Math.floor(expires / 1000) // a jar in ms
    const session = !Number.isFinite(expires) || expires <= 0
    if (!session && expires * 1000 <= now) { out.skipped.push(name); continue }
    const cookie = { name, value: c.value, domain, path, secure: !!c.secure, httpOnly: !!c.httpOnly }
    const same = String(c.sameSite || '')
    if (same === 'Strict' || same === 'Lax' || same === 'None') cookie.sameSite = same
    if (!session) cookie.expires = Math.floor(expires)
    out.cookies.push(cookie)
  }
  out.ok = out.cookies.length > 0
  if (!out.ok) out.why = 'no-cookies'
  return out
}

/**
 * Put the saved SSO session back into the browser this plugin has just started, before that
 * browser is sent to the login entry (2026-10-05 round 16). Why this exists: the renewal path
 * launches the headless shell with `--no-session-restore` and used to point it straight at
 * `SSO_LOGIN_URL`, so the shell arrived with an empty cookie store, the IDP answered its
 * "device fingerprint" form, and the HTTP leg — which still holds a live session — was never
 * consulted. The session cookie lives in `state.cookieJar`; a browser cannot read that jar, so
 * the only way to hand it over is CDP, on a page of *this* instance.
 *
 * Bounded and self-checking at every step, in this order, and every step may refuse:
 *   • the target is the SSO entry and the cookies are the ones that belong to it (see
 *     `planSessionRestore` above) — a cookie for another domain is never sent anywhere;
 *   • the browser answering on the port must be *this* spawn: `/json/version` must name the
 *     instance id recorded at spawn time. A stranger's browser is not talked to at all — and
 *     in particular no cookie is written before this check has passed;
 *   • the page written into must be a `about:blank` page of that instance, reached over a local
 *     WebSocket on the same port;
 *   • then, and only then, `Network.setCookie` per cookie, followed by `Page.navigate` to the
 *     original entry, where the site's own JavaScript runs for real.
 * Nothing is faked: no user agent, no fingerprint, no header rewriting. Only cookies the site
 * itself set, going back to the host that set them.
 */
export function createSessionRestorer(deps = {}) {
  const fetchFn = deps.fetch || fetch
  const WS = deps.WebSocket || globalThis.WebSocket
  const probeTimeoutMs = Number(deps.probeTimeoutMs) || 1500
  const stepTimeoutMs = Number(deps.stepTimeoutMs) || 8000
  const clockNow = deps.now || (() => Date.now())
  const localHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'

  const probe = async (port, path) => {
    try {
      const r = await fetchFn('http://127.0.0.1:' + port + path, { signal: AbortSignal.timeout(probeTimeoutMs) })
      if (!r || !r.ok) return null
      return jsonParse(await readResponseText(r))
    } catch (e) { return null }
  }
  const localWs = (raw, port) => {
    if (typeof raw !== 'string' || !raw) return ''
    let u = null
    try { u = new URL(raw) } catch (e) { return '' }
    if (u.protocol !== 'ws:' || !localHost(u.hostname.toLowerCase()) || Number(u.port || 80) !== port) return ''
    return u.href
  }
  const instanceOf = (raw, port) => {
    const href = localWs(raw, port)
    const m = href ? String(href).match(/\/devtools\/browser\/([0-9a-zA-Z-]{8,})/) : null
    return m ? m[1].toLowerCase() : ''
  }

  return async function sessionRestore(arg) {
    const port = Number((arg && arg.port) || 0)
    const want = String((arg && arg.uuid) || '').toLowerCase()
    const url = String((arg && arg.url) || '')
    const plan = planSessionRestore(arg && arg.jar, url, clockNow())
    const base = { ok: false, reason: '', host: plan.host, sent: 0, failed: [], skipped: plan.skipped, navigated: false }
    if (!(port >= 1024 && port <= 65535)) return Object.assign(base, { reason: 'bad-port' })
    if (!plan.ok) return Object.assign(base, { reason: plan.why, why: plan.why })
    if (!isInstanceId(want)) return Object.assign(base, { reason: 'no-identity' })
    const info = await probe(port, '/json/version')
    if (!info) return Object.assign(base, { reason: 'endpoint-silent' })
    const id = instanceOf(info.webSocketDebuggerUrl, port)
    if (!id) return Object.assign(base, { reason: 'no-instance-id' })
    // The ownership gate: a browser whose instance id is not the one recorded at spawn time is
    // never handed a cookie. This is the same identity the close path stands on.
    if (id !== want) return Object.assign(base, { reason: 'not-ours', instanceMatched: false })
    const pages = await probe(port, '/json/list')
    let target = null
    for (const p of (Array.isArray(pages) ? pages : [])) {
      if (!p || typeof p !== 'object' || p.type !== 'page') continue
      if (!localWs(p.webSocketDebuggerUrl, port)) continue
      if (p.url !== 'about:blank' && p.url !== '') continue
      target = p
      break
    }
    if (!target) return Object.assign(base, { reason: 'no-blank-target', instanceMatched: true })
    const result = Object.assign(base, { instanceMatched: true })
    let sock = null
    let nextId = 1
    const pending = new Map()
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout ' + method)) } }, stepTimeoutMs)
      pending.set(id, { resolve, reject, timer })
      try { sock.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); pending.delete(id); reject(e) }
    })
    try {
      sock = new WS(localWs(target.webSocketDebuggerUrl, port))
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws open timeout')), stepTimeoutMs)
        sock.onopen = () => { clearTimeout(t); resolve() }
        sock.onerror = () => { clearTimeout(t); reject(new Error('ws error')) }
      })
      sock.onmessage = (ev) => {
        let m = null
        try { m = jsonParse(typeof ev.data === 'string' ? ev.data : '') } catch (e) {}
        if (!m || !m.id || !pending.has(m.id)) return
        const p = pending.get(m.id)
        pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error) p.reject(new Error(String((m.error && m.error.message) || 'cdp error')))
        else p.resolve(m.result || {})
      }
      try { await send('Network.enable', {}) } catch (e) { /* best effort: setCookie below says if it mattered */ }
      for (const c of plan.cookies) {
        const params = { name: c.name, value: c.value, url, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly }
        if (c.sameSite) params.sameSite = c.sameSite
        if (c.expires) params.expires = c.expires
        try {
          const r = await send('Network.setCookie', params)
          if (r && r.success === true) result.sent += 1
          else result.failed.push(c.name)
        } catch (e) { result.failed.push(c.name) }
      }
      try { await send('Page.navigate', { url }); result.navigated = true } catch (e) { result.navigated = false }
      result.ok = result.sent > 0 && result.navigated
      if (!result.ok) result.reason = result.sent > 0 ? 'navigate-failed' : 'no-cookie-accepted'
    } catch (e) {
      result.reason = 'ws-failed'
      result.why = String((e && e.message) || e)
    } finally {
      for (const p of pending.values()) { clearTimeout(p.timer); try { p.reject(new Error('closed')) } catch (e) {} }
      pending.clear()
      try { if (sock) { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; sock.close() } } catch (e) {}
    }
    return result
  }
}

/**
 * The four API routes the widget talks to, as plain route entries, so the wire contract
 * can be driven by a test without a host. This matters because 0.3.9 shipped 86 green
 * tests that never sent the request the panel actually sends: on 2026-10-04 the user's
 * click did nothing and no test could have noticed (report §12 item 3). Two things are
 * pinned here: the request shape (`POST` + `application/json` + `{}`) is answered as
 * `200`, and which carrier a run uses is decided by one strictly validated boolean —
 * `{}` or `{"background":false}` is the click the panel sends, `{"background":true}` is an
 * unattended run that a verification script may ask for, and every other body is a 400.
 * The wire must not be able to smuggle a run whose carrier the caller does not control.
 */
/**
 * The account-login driver (2026-11-28): fill the unified-auth password form once, in a
 * browser this plugin started, and report what happened in named words.
 *
 * The gate order is the whole safety argument, so it is written as one sequence:
 *
 *   1. This call must state the instance it expects, and that value must have the shape of a
 *      DevTools instance id. No identity, no page — the reader never gets to look at a port
 *      on the strength of "the caller forgot".
 *   2. `/json/version` must answer with that same id. A different browser on the port is
 *      somebody else's, and this function does not navigate, type into or close it.
 *   3. The page target must be either the exact unified-auth origin or a blank page this
 *      plugin's own carrier just started. A page on any other origin is refused, not
 *      navigated: driving a page we did not bring up is the boundary this exists to hold.
 *   4. The socket must be `ws:` on loopback and on this same port.
 *   5. The page must classify as the login form — exactly one form, exactly one password
 *      field, on the exact origin, top frame, no CAPTCHA/MFA/device step, no rejection text.
 *   6. Only then are the two values inserted, and the form is submitted exactly once.
 *
 * The credential values are passed as arguments to a single context-bound CDP call.
 * They do not appear in the script source or logs.
 */
export function createLoginDriver(deps = {}) {
  const fetchImpl = typeof deps.fetch === 'function' ? deps.fetch : fetch
  const WS = typeof deps.WebSocket === 'function' ? deps.WebSocket : WebSocket
  const instanceOf = typeof deps.readInstance === 'function' ? deps.readInstance : readInstance
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms))

  async function listTargets(port) {
    try {
      const r = await fetchImpl('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) })
      if (!r || !r.ok) return null
      const pages = jsonParse(await readResponseText(r))
      return Array.isArray(pages) ? pages : null
    } catch (e) { return null }
  }

  function pickTarget(pages, loginOrigin) {
    let blank = null
    let onLogin = null
    for (const p of pages) {
      if (!p || typeof p !== 'object' || p.type !== 'page' || !p.webSocketDebuggerUrl) continue
      const url = String(p.url || '')
      let origin = ''
      try { origin = url ? new URL(url).origin.toLowerCase() : '' } catch (e) { origin = '' }
      if (origin === loginOrigin) { if (!onLogin) onLogin = p; continue }
      if (url === '' || /^about:blank/i.test(url)) { if (!blank) blank = p }
    }
    return onLogin || blank
  }

  return async function loginDriver(arg) {
    const port = Number((arg && arg.port) || 0)
    const want = String((arg && arg.uuid) || '').toLowerCase()
    const loginUrl = String((arg && arg.loginUrl) || '')
    const deadline = now() + (Number(arg && arg.timeoutMs) || 30000)
    const username = String((arg && arg.username) || '')
    const password = String((arg && arg.password) || '')
    // The caller's cancellation question (2026-11-28): true once the stored account has been
    // cleared or replaced. Read synchronously right before the secret-bearing call.
    const cancelled = typeof (arg && arg.cancelled) === 'function' ? arg.cancelled : () => false
    const fillScript = buildFillScript(SSO_ORIGIN)
    if (!username || !password) return { ok: false, reason: 'not-configured' }
    // 1. an expectation with a real shape, or nothing happens at all.
    if (!isInstanceId(want)) return { ok: false, reason: 'not-ours' }
    let loginOrigin = ''
    try { loginOrigin = new URL(loginUrl).origin.toLowerCase() } catch (e) { loginOrigin = '' }
    if (loginOrigin !== SSO_ORIGIN) return { ok: false, reason: 'wrong-origin' }
    // 2. the port must answer as this exact instance.
    let seen = null
    try { seen = await instanceOf(port, 2000) } catch (e) { seen = null }
    if (!seen || seen.ok !== true || String(seen.id || '').toLowerCase() !== want) return { ok: false, reason: 'not-ours' }
    // 3. one page: the login page itself, or the blank page our carrier just made.
    let pages = await listTargets(port)
    if (!pages) return { ok: false, reason: 'no-page' }
    let target = pickTarget(pages, loginOrigin)
    if (!target) return { ok: false, reason: 'no-page' }
    // 4. the page socket must be loopback, ws, and this port.
    let debuggerUrl = null
    try { debuggerUrl = new URL(String(target.webSocketDebuggerUrl || '')) } catch (e) { debuggerUrl = null }
    const dbgHost = debuggerUrl ? debuggerUrl.hostname.toLowerCase() : ''
    if (!debuggerUrl || debuggerUrl.protocol !== 'ws:' ||
        (dbgHost !== '127.0.0.1' && dbgHost !== 'localhost' && dbgHost !== '[::1]') ||
        Number(debuggerUrl.port) !== port) return { ok: false, reason: 'no-page' }

    let ws = null
    let nextId = 1
    // Set while the driver is waiting for the main frame's execution context; events are the
    // only way CDP reports the unique id, so it is received here rather than requested.
    let onExecutionContext = null
    const pending = {}
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('cdp timeout ' + method)) } }, 8000)
      pending[id] = { resolve, reject, timer }
      try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) {
        clearTimeout(timer); delete pending[id]; reject(e)
      }
    })
    const evaluate = async (expression) => {
      const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
      const value = reply && reply.result && reply.result.result ? reply.result.result.value : undefined
      return value
    }
    // The same read, but pinned to one execution context: if that context is gone (a
    // navigation replaced it), this answers null instead of reading a different document.
    const evaluateIn = async (expression, uniqueContextId) => {
      try {
        const reply = await send('Runtime.evaluate', { expression, uniqueContextId, returnByValue: true, awaitPromise: false })
        const value = reply && reply.result && reply.result.result ? reply.result.result.value : undefined
        return value === undefined ? null : value
      } catch (e) { return null }
    }
    const factsNow = async () => {
      try { return await evaluate(FACTS_EXPR) } catch (e) { return null }
    }

    try {
      ws = new WS(debuggerUrl.href)
      ws.onmessage = (ev) => {
        try {
          if (typeof ev.data !== 'string' || Buffer.byteLength(ev.data) > 1024 * 1024) return
          const m = jsonParse(ev.data)
          if (m && m.id && pending[m.id]) {
            clearTimeout(pending[m.id].timer)
            pending[m.id].resolve(m)
            delete pending[m.id]
            return
          }
          if (onExecutionContext) { try { onExecutionContext(m) } catch (e) { /* a bad frame is not a context */ } }
        } catch (e) { /* a malformed frame is not a reply */ }
      }
      ws.onerror = () => { for (const id of Object.keys(pending)) { try { pending[id].reject(new Error('ws error')) } catch (e) {} ; delete pending[id] } }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws open timeout')), 6000)
        ws.onopen = () => { clearTimeout(timer); resolve() }
        ws.onclose = () => { clearTimeout(timer); reject(new Error('ws closed')) }
      })
      await send('Runtime.enable')

      // The values must not outlive the user's intent: a clear or a replacement that landed
      // while the socket was being opened ends the attempt here, before any page is read.
      if (cancelled()) return { ok: false, reason: 'cancelled' }

      // 5. what the page is, before anything is typed.
      let facts = await factsNow()
      if (!facts) return { ok: false, reason: 'no-page' }
      let verdict = classifyPage(facts)
      const isBlank = (page) => !!page && page.url === 'about:blank'
      const waitingForForm = (page, result) => isBlank(page) || (
        page && page.origin === loginOrigin && page.topFrame === true &&
        page.readyState === 'loading' && ['no-form', 'ambiguous-form'].includes(result.kind)
      )
      if (isBlank(facts)) {
        try { await send('Page.enable') } catch (e) { /* Page domain is optional for navigate */ }
        const navigation = await send('Page.navigate', { url: loginUrl })
        if (navigation?.error || navigation?.result?.errorText) return { ok: false, reason: 'navigate-failed' }
      }
      const until = Math.min(deadline, now() + 12000)
      while (waitingForForm(facts, verdict) && now() < until) {
        if (cancelled()) return { ok: false, reason: 'cancelled' }
        await sleep(300)
        const next = await factsNow()
        if (!next) continue
        facts = next
        verdict = classifyPage(facts)
      }
      if (isBlank(facts)) return { ok: false, reason: 'navigate-failed' }
      if (verdict.kind !== 'login-form') {
        return { ok: false, reason: verdict.kind, facts: scrubFacts(facts), why: verdict.why }
      }
      // A navigation just happened on our behalf; the account may have been removed during it.
      if (cancelled()) return { ok: false, reason: 'cancelled', facts: scrubFacts(facts) }

      // 6. one operation, one context, one synchronous turn (2026-11-28, second pass).
      //
      // The first version typed with Input.insertText and clicked in separate CDP calls. Four
      // awaits sat between the checks and the last keystroke, and a navigation during any of
      // them would have put the plaintext into a document nobody approved. Now the fill is a
      // single call bound to the *unique id of the execution context this check just ran in*:
      // a navigation replaces that context, the call then fails, and the failure is the answer.
      //
      // The context is captured from the events `Runtime.enable` emits, after the navigation
      // above, so it describes the page the preflight saw and not the blank one before it.
      let uniqueContextId = ''
      try {
        const tree = await send('Page.getFrameTree')
        const mainFrame = tree && tree.result && tree.result.frameTree && tree.result.frameTree.frame
          ? String(tree.result.frameTree.frame.id || '') : ''
        onExecutionContext = (m) => {
          const c = m && m.params && m.params.context
          if (!c || !c.auxData || c.auxData.isDefault !== true) return
          if (mainFrame && String(c.auxData.frameId || '') !== mainFrame) return
          uniqueContextId = String(c.uniqueId || '')
        }
        // Re-emitting the current contexts is the only way to learn the id of the one the
        // page is using now; disable/enable is local, read-only and immediate.
        try { await send('Runtime.disable') } catch (e) { /* not enabled */ }
        await send('Runtime.enable')
        const untilContext = now() + 3000
        while (!uniqueContextId && now() < untilContext) await sleep(50)
      } catch (e) {
        uniqueContextId = ''
      } finally {
        onExecutionContext = null
      }
      if (!uniqueContextId) return { ok: false, reason: 'context-gone', facts: scrubFacts(facts) }

      // The preflight is asked again inside the same context, without the values: a page that
      // has already changed under us must not be handed a password at all.
      const preflight = await evaluateIn(FACTS_EXPR, uniqueContextId)
      if (!preflight) return { ok: false, reason: 'context-gone', facts: null }
      const second = classifyPage(preflight)
      if (second.kind !== 'login-form') {
        return { ok: false, reason: second.kind, facts: scrubFacts(preflight), why: second.why }
      }

      // The values arrive as CDP arguments of one synchronous function. Nothing between this
      // check and the send may await: the whole point is that the answer to "is this still
      // authorised?" is read in the same turn the values leave.
      if (cancelled()) return { ok: false, reason: 'cancelled', facts: scrubFacts(preflight) }
      let filled = null
      try {
        filled = await send('Runtime.callFunctionOn', {
          functionDeclaration: fillScript,
          uniqueContextId: uniqueContextId,
          arguments: [{ value: username }, { value: password }],
          returnByValue: true,
          awaitPromise: false,
        })
      } catch (e) {
        // A refused call is a page that changed under us, or a context that no longer exists.
        return { ok: false, reason: 'context-gone', facts: scrubFacts(preflight) }
      }
      const written = filled && filled.result && filled.result.result ? filled.result.result.value : null
      if (!written || written.ok !== true) {
        const why = written && written.reason ? String(written.reason) : 'context-gone'
        return { ok: false, reason: why, facts: scrubFacts(preflight) }
      }

      // 7. watch, bounded, for a definite outcome. A page that leaves the login origin has
      // been accepted; a page that comes back with rejection text has not; anything still
      // unclear at the deadline is reported as unclear, never as success.
      let submitted = false
      while (now() < deadline) {
        await sleep(400)
        const list = await listTargets(port)
        if (!list) return { ok: false, reason: 'no-page' }
        const still = pickTarget(list, loginOrigin) || null
        if (!still) return { ok: true, reason: 'submitted', submitted: true }
        let origin = ''
        try { origin = new URL(String(still.url || '')).origin.toLowerCase() } catch (e) { origin = '' }
        if (origin !== loginOrigin) return { ok: true, reason: 'submitted', submitted: true }
        const after = await factsNow()
        if (!after) continue
        const late = classifyPage(after)
        if (late.kind === 'credentials-rejected') return { ok: false, reason: 'credentials-rejected', facts: scrubFacts(after) }
        if (late.kind === 'captcha-required' || late.kind === 'mfa-required' || late.kind === 'device-confirm-required') {
          return { ok: false, reason: late.kind, facts: scrubFacts(after) }
        }
        if (late.kind === 'wrong-origin') return { ok: false, reason: 'wrong-origin', facts: scrubFacts(after) }
        submitted = true
      }
      return { ok: false, reason: 'timeout', submitted: submitted, facts: null }
    } catch (e) {
      return { ok: false, reason: 'error' }
    } finally {
      for (const id of Object.keys(pending)) { clearTimeout(pending[id].timer); delete pending[id] }
      try { if (ws) ws.close() } catch (e) { /* already gone */ }
    }
  }
}

/**
 * Whether an address is this machine's own loopback space.
 */
export function isLoopbackAddress(value) {
  const a = String(value || '').trim().toLowerCase()
  if (!a) return false
  if (a === '::1' || a === '::ffff:127.0.0.1') return true
  if (a.indexOf('127.') === 0) return true
  if (a.indexOf('::ffff:127.') === 0) return true
  return false
}

/**
 * The transport and cross-site fence for the routes that carry an account (2026-11-28).
 *
 * Why it exists here and not only in the UI: the panel is not the only thing that can POST to
 * this Host. The routes that accept a password are reachable by anything that can talk to the
 * listening socket, so the two facts that make such a request legitimate have to be enforced
 * on the request itself — the connection arrived over TLS or over loopback, and the browser did
 * not send it from another site. The host's own trust check (authentication plus same-origin at
 * `/api`) runs first and is not replaced by this; this is the plugin's own, narrower rule for
 * the three routes where a wrong caller costs a credential.
 *
 * Answers '' when the request may proceed, or a short reason word. The word travels to the
 * caller as a message, never as the request's contents.
 */
export function secretTransportRefusal(req) {
  const socket = req && req.socket
  const tls = !!(socket && socket.encrypted === true)
  const local = !!(socket && isLoopbackAddress(socket.remoteAddress))
  if (!tls && !local) return 'transport'
  const headers = (req && req.headers) || {}
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site'
  const origin = String(headers.origin || '')
  if (origin) {
    let host = ''
    try { host = new URL(origin).host.toLowerCase() } catch (e) { return 'origin' }
    const expected = String(headers.host || '').toLowerCase()
    if (!expected || host !== expected) return 'origin'
  }
  return ''
}

function createApiHandlers(core, options) {
  const opts = options || {}
  const rejectReq = typeof opts.rejectReq === 'function' ? opts.rejectReq : () => undefined
  const report = typeof opts.onError === 'function'
    ? opts.onError
    : (endpoint, e) => console.error('[thu-tok-auto] API ' + endpoint, e)
  // The account store, when this host has one. Its absence is not an error: the routes then
  // answer `supported:false` and every write is refused by name.
  const store = opts.secretStore && typeof opts.secretStore === 'object' ? opts.secretStore : null
  function handlerFor(method, endpoint, handle, limit, guarded) {
    return async (req, res) => {
      try {
        const rejection = rejectReq(req)
        if (rejection !== undefined) {
          const code = rejection === 401 ? 401 : 403
          return json(res, { ok: false, error: code === 401 ? '请先登录 DSH。' : '请求来源不受信任。' }, code)
        }
        // The three routes that carry an account answer only to a loopback-or-TLS, same-site
        // caller — enforced here, not left to the panel (2026-11-28).
        if (guarded) {
          const why = secretTransportRefusal(req)
          if (why) {
            return json(res, {
              ok: false,
              error: why === 'cross-site' ? '拒绝跨站请求。' : (why === 'origin' ? '请求来源与本站不一致。' : '该接口只接受本机或 HTTPS 连接。'),
            }, 403)
          }
        }
        if (req.method !== method) return json(res, { ok: false, error: '请求方法不支持。' }, 405, { Allow: method })
        if (method === 'POST') {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, { ok: false, error: '仅接受 application/json。' }, 415)
          // A credential save is two short strings. It gets its own, much smaller ceiling so a
          // paste of a whole document is refused by size instead of stored by accident.
          const body = await readBody(req, Number(limit) || 64 * 1024)
          return json(res, await handle(body))
        }
        return json(res, await handle(undefined))
      } catch (e) {
        const status = Number.isInteger(e && e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500
        json(res, { ok: false, error: status === 500 ? '插件内部错误。' : String((e && e.message) || e) }, status)
        // A route that carries an account never hands its thrown value to the log: an arbitrary
        // error object from that path is exactly what must not be copied out (2026-11-28). The
        // endpoint and the status still say a request failed.
        if (status === 500) report(endpoint, guarded ? '[error object withheld: this route carries an account]' : e)
      }
    }
  }
  return [
    { method: 'GET', path: '/thu-tok-auto/api/status', handler: handlerFor('GET', 'status', () => core.state()) },
    {
      method: 'POST',
      path: '/thu-tok-auto/api/get-tok',
      handler: handlerFor('POST', 'get-tok', (body) => {
        // `{}` is the click the panel sends; `{"background":true}` is an unattended run and
        // has to say so in that one boolean. A body that says anything else is refused
        // rather than ignored: answering 200 to a request whose intent was dropped is how a
        // panel ends up promising a window nobody opened (2026-10-04, round 6).
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
        if (!keys || keys.some((k) => k !== 'background')) throw httpError(400, '请求体只接受 background 字段。');
        if (body.background !== undefined && typeof body.background !== 'boolean') {
          throw httpError(400, '字段 background 必须是布尔值。');
        }
        return core.getTok({ background: body.background === true });
      }),
    },
    { method: 'POST', path: '/thu-tok-auto/api/open-login', handler: handlerFor('POST', 'open-login', () => core.openLogin()) },
    {
      method: 'POST',
      path: '/thu-tok-auto/api/set-auto',
      handler: handlerFor('POST', 'set-auto', (body) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.on !== 'boolean') {
          throw httpError(400, '字段 on 必须是布尔值。')
        }
        return core.setAuto(body.on)
      }),
    },
    // The account the login arm may use (2026-11-28). Three answers, one shape: what is
    // stored (never what it is), whether a save took, and whether a clear took. No route ever
    // returns a username, a password, or any part of either.
    {
      method: 'GET',
      path: '/thu-tok-auto/api/credentials',
      handler: handlerFor('GET', 'credentials', async () => {
        if (!store) return { ok: true, supported: false, configured: false, updatedAt: 0, reason: 'unsupported' }
        const st = await store.status()
        return {
          ok: true,
          supported: st.supported === true,
          configured: st.configured === true,
          updatedAt: Number(st.updatedAt) || 0,
          reason: String(st.reason || ''),
        }
      }, undefined, true),
    },
    {
      method: 'POST',
      path: '/thu-tok-auto/api/credentials/save',
      handler: handlerFor('POST', 'credentials-save', async (body) => {
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null
        if (!keys || keys.some((k) => k !== 'username' && k !== 'password')) {
          throw httpError(400, '请求体只接受 username 与 password 字段。')
        }
        if (typeof body.username !== 'string' || typeof body.password !== 'string') {
          throw httpError(400, 'username 与 password 必须是字符串。')
        }
        if (!store) return { ok: false, supported: false, configured: false, reason: 'unsupported' }
        const saved = await store.save({ username: body.username, password: body.password })
        if (!saved || saved.ok !== true) {
          // A refused save is reported by name and never echoes the values back.
          return { ok: false, supported: true, configured: false, reason: String((saved && saved.reason) || 'save-failed') }
        }
        // A new account invalidates every earlier refusal: the lock is bound to the revision,
        // and this is a new one.
        core.credentialsChanged()
        return { ok: true, supported: true, configured: true, updatedAt: Number(saved.updatedAt) || 0 }
      }, 4096, true),
    },
    {
      method: 'POST',
      path: '/thu-tok-auto/api/credentials/clear',
      handler: handlerFor('POST', 'credentials-clear', async () => {
        if (!store) return { ok: true, supported: false, configured: false, reason: 'unsupported' }
        const cleared = await store.clear()
        core.credentialsChanged()
        return {
          ok: !!(cleared && cleared.ok === true),
          supported: true,
          configured: false,
          reason: String((cleared && cleared.reason) || ''),
        }
      }, 1024, true),
    },
  ]
}

/**
 * `apply(ctx)` is the host entry point. This variant exists so the tests can drive the
 * routes that were really registered — the same `core`, the same plumbing — with fake
 * transports instead of a live site (`overrides`: http / cdp / stateIO / findExecutable /
 * spawnBrowser / closeBrowser). Every override is optional and defaults to the real one,
 * so the shipped path and the tested path are the same code.
 */
function applyWithDeps(ctx, overrides) {
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

    const picks = overrides && typeof overrides === 'object' ? overrides : {}
    const pickFn = (name, fallback) => (typeof picks[name] === 'function' ? picks[name] : fallback)

    // Closing the temporary window: see createBrowserCloser below. It refuses to touch
    // anything whose DevTools identity is not the one recorded for the browser this
    // plugin spawned, and it never kills a bare pid (2026-10-04 audit, defects 1 and 2).
    // The synchronous twin exists for one caller only — the host calls dispose without
    // awaiting it, so the cleanup at host exit has to finish inside the call
    // (2026-10-05 round 14 A).
    const closeBrowser = pickFn('closeBrowser', createBrowserCloser({}))
    const closeBrowserSync = pickFn('closeBrowserSync', createBrowserStopperSync({}))

    // The account-login driver, resolved once: the same function the seam exposes and the one
    // the attempt uses, so `overrides.loginDriver` can replace both (2026-11-28).
    const loginDriverFn = pickFn('loginDriver', (carrierDefaults.loginDriver = createLoginDriver({})))

    // The optional account store (2026-11-28). Whether it exists at all is a fact about this
    // machine: a host without DPAPI gets createUnsupportedStore(), whose every write refuses.
    // No path in this file falls back to storing a password in plain text.
    const dataHome = process.env.THU_TOK_AUTO_HOME || process.env.USERPROFILE || process.env.HOME || ''
    const secretStore = picks.secretStore && typeof picks.secretStore === 'object'
      ? picks.secretStore
      : (process.platform === 'win32'
        ? createSecretStore({ baseDir: () => (dataHome ? dataHome + '\\.dsh\\madmodel' : '') })
        : createUnsupportedStore('not-windows'))
    const autoLogin = createAutoLogin({
      store: secretStore,
      driver: loginDriverFn,
      loginUrl: SSO_LOGIN_URL,
    })

    const core = createCore({
      logger: console,
      clock: { now: () => Date.now() },
      // Which build this is, read from the bundle's own package.json: the panel shows it, so
      // "is the new logic actually loaded?" is answered by looking at the widget instead of
      // guessing from the install timestamp (2026-10-04 real run).
      version: readOwnVersion(),
      // THU_TOK_AUTO_HOME lets tests (or users) relocate the state directory.
      env: {
        home: process.env.THU_TOK_AUTO_HOME || process.env.USERPROFILE || process.env.HOME || '',
        temp: process.env.TEMP || process.env.TMP || '',
        localAppData: process.env.LOCALAPPDATA || '',
        cwd: process.cwd(),
      },
      settings: settingsSvc,
      credentials: credSvc,
      timer,
      closeBrowser,
      closeBrowserSync,
      // The account store and the one-shot login attempt it enables (2026-11-28). Core never
      // reads the store itself: it asks `autoLogin.attempt()`, which decrypts for the length
      // of one attempt and drops the pair before returning.
      secretStore,
      autoLogin,
      // Node 内置 fetch：与动态版子进程 helper 相同的语义（redirect manual 保留 Location）。
      // maxBytes is per-request: the generic 1 MiB answer cap is fine for the site's
      // JSON APIs but far too small for its ~2.2 MB front-end bundle, which the
      // model-list reader has to download in full.
      http: pickFn('http', async (url, options) => {
        const init = { redirect: options.follow === false ? 'manual' : 'follow', signal: AbortSignal.timeout(options.timeoutMs || 25000) }
        if (options.headers) init.headers = options.headers
        try {
          const r = await fetch(url, init)
          const text = await readResponseText(r, options.maxBytes || 1024 * 1024)
          return { status: r.status, ok: r.ok, location: r.headers.get('location') || '', text }
        } catch (e) { return { error: String((e && e.message) || e) } }
      }),
      // 原生隐藏页载体（2026-10-04 第十轮，用户要求②）：先起一个正常 Edge（不是 headless
      // shell）：--no-startup-window 让屏幕上没有任何窗口，引擎与 UA 都是普通 Edge（本机实测
      // `Edg/154.0.4258.53`、UA 无 HeadlessChrome 标记）。然后在这条浏览器级 WebSocket 上建
      // 一个 hidden+background 的页面目标，然后用这条浏览器级 WebSocket 持有它。**它不是常驻
      // 的**：页面寿命绑在创建它的这条连接上（本连接一断，页面就没了——第二次真机闭包探针实测
      // `handle.close()` 之后该目标从 /json/list 里消失、出厂读取器报 `hidden-gone`；detach 无
      // 影响）。所以本函数交出的句柄必须活到本次续期结束，由 core 决定何时 close()。
      // 注（2026-10-04 更正）：第十轮曾记"隐藏页不出现在 /json/list 里"——那是我方探针
      // （test/hidden-probe.mjs）先取列表再建目标造成的假读数。真机闭包探针重测：它**会**以
      // `type:'other'` 出现在 /json/list 里、还带自己的 webSocketDebuggerUrl。走浏览器级连接
      // 的理由是**寿命**，不是可见性。
      hiddenTarget: pickFn('hiddenTarget', (carrierDefaults.hiddenTarget = async (arg) => {
        const port = arg.port
        const deadline = Date.now() + (arg.timeoutMs || 12000)
        let version = null
        while (Date.now() < deadline) {
          try {
            const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) })
            if (r.ok) { version = jsonParse(await readResponseText(r)); break }
          } catch (e) {}
          await new Promise((r) => setTimeout(r, 250))
        }
        if (!version || !version.webSocketDebuggerUrl) return { ok: false, reason: 'no-devtools' }
        let debuggerUrl = null
        try { debuggerUrl = new URL(version.webSocketDebuggerUrl) } catch (e) {}
        const dbgHost = debuggerUrl ? debuggerUrl.hostname.toLowerCase() : ''
        if (!debuggerUrl || debuggerUrl.protocol !== 'ws:' ||
            (dbgHost !== '127.0.0.1' && dbgHost !== 'localhost' && dbgHost !== '[::1]') ||
            Number(debuggerUrl.port) !== port) return { ok: false, reason: 'unsafe-debugger-url' }
        const ws = new WebSocket(debuggerUrl.href)
        let nextId = 1
        const pending = {}
        let onEvent = null
        let closed = false
        const rejectPending = (error) => {
          for (const id of Object.keys(pending)) {
            clearTimeout(pending[id].timer)
            pending[id].reject(error)
            delete pending[id]
          }
        }
        const send = (method, params, sessionId) => new Promise((resolve, reject) => {
          const id = nextId++
          const timer = setTimeout(() => {
            if (pending[id]) { delete pending[id]; reject(new Error('cdp timeout ' + method)) }
          }, 8000)
          pending[id] = { resolve, reject, timer }
          try {
            const msg = { id: id, method: method, params: params || {} }
            if (sessionId) msg.sessionId = sessionId
            ws.send(JSON.stringify(msg))
          } catch (e) {
            clearTimeout(timer)
            delete pending[id]
            reject(e)
          }
        })
        ws.onmessage = (ev) => {
          try {
            if (typeof ev.data !== 'string' || Buffer.byteLength(ev.data) > 1024 * 1024) return
            const m = jsonParse(ev.data)
            if (m && m.id && pending[m.id]) {
              clearTimeout(pending[m.id].timer)
              pending[m.id].resolve(m)
              delete pending[m.id]
              return
            }
            if (onEvent) onEvent(m)
          } catch (e) {}
        }
        ws.onclose = () => { closed = true; release() }
        const onSocketError = () => { try { rejectPending(new Error('ws error')) } catch (e) {} }
        ws.onerror = onSocketError
        const close = () => {
          if (closed) return { closed: false, reason: 'already-closed' }
          closed = true
          try { ws.close() } catch (e) {}
          release()
          return { closed: true }
        }
        const release = () => { try { onEvent = null; rejectPending(new Error('the hidden page connection is closed')) } catch (e) {} }
        try {
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('ws open timeout')), 6000)
            // Every event that arrives before the socket is open is still routed to the
            // steady-state handler: a failure while opening must not stop later commands
            // from being rejected when the same socket dies.
            ws.onerror = (ev) => { clearTimeout(t); onSocketError(); reject(new Error('ws error')) }
            ws.onopen = () => { clearTimeout(t); ws.onerror = onSocketError; resolve() }
          })
        } catch (e) {
          try { ws.close() } catch (e2) {}
          return { ok: false, reason: 'no-devtools', error: String((e && e.message) || e) }
        }
        const bi = String(version.webSocketDebuggerUrl || '').match(/\/devtools\/browser\/([0-9a-zA-Z-]{8,})/)
        const browserId = bi ? bi[1].toLowerCase() : ''
        // Wait until the browser actually reports a DevTools *frame* target before asking for a
        // hidden one. Chromium's gate is `RemoteDebuggingTargets(TargetType::kFrame).empty()`
        // (content/browser/devtools/protocol/target_handler.cc ⇒ ServerError -32000 "Hidden
        // target can be created only when remote debugging is enabled"), i.e. it counts frame
        // targets only — a browser whose target list holds nothing but workers/other types is
        // refused just the same. A windowless start on an already-used profile has **zero**
        // targets for the first seconds — measured 2026-10-04 on this machine with the
        // production argv: 0 at 12 ms, first target at ~3.1 s, 10 by ~9.4 s — while the old
        // code asked once at ~300 ms and fell back. So: wait for a frame target, then create,
        // and retry inside the same budget. A refusal that is not that gate is handed over at
        // once, and every exit carries the readings (targetsSeen / frameTargets / attempts).
        let created = null
        let attempts = 0
        let targetsSeen = 0
        let frameTargets = 0
        let triedCreate = false
        for (;;) {
          attempts += 1
          try {
            const listed = await send('Target.getTargets', {})
            const infos = listed && listed.result && listed.result.targetInfos
            if (Array.isArray(infos)) {
              targetsSeen = infos.length
              frameTargets = infos.filter((t) => {
                const ty = String((t && t.type) || '')
                return ty === 'page' || ty === 'iframe' || ty === 'webview'
              }).length
            }
          } catch (e) {}
          if (frameTargets > 0) {
            triedCreate = true
            try {
              created = await send('Target.createTarget', { url: String(arg.url || 'about:blank'), hidden: true, background: true })
            } catch (e) {
              created = { error: { code: 0, message: String((e && e.message) || e) } }
            }
            if (created && created.result && created.result.targetId) break
            const code = Number((created && created.error && created.error.code) || 0)
            const said = String((created && created.error && created.error.message) || '')
            if (code !== -32000 || !/remote debugging is enabled/i.test(said)) break
          }
          if (Date.now() >= deadline) break
          await new Promise((r) => setTimeout(r, 250))
        }
        const targetId = created && created.result && created.result.targetId
        if (!targetId) {
          // The browser's own words, kept verbatim: "Hidden target can be created only in
          // background" and friends are the evidence a refusal is reported with, and the
          // measured codes are printed rather than a sentence this file invented
          // (2026-10-04 round 10, machine probe). browserId travels with a failure too: it is
          // the instance identity the caller needs to close *this* browser with evidence
          // before it dares to start another one in the same profile (round 12).
          const error = (created && created.error)
            ? { code: Number(created.error.code) || 0, message: maskProbeLine(created.error.message) }
            : null
          try { ws.close() } catch (e) {}
          // 「一次都没试过」与「试了被拒」是两件事：前者是这台浏览器一个 DevTools **frame** 目标
          // 都没报出来（frame=0），后者带着浏览器自己的 code/message。分开说，面板才说得出
          // 到底是哪一件（2026-10-04 第十二轮）。
          return { ok: false, reason: triedCreate ? 'create-target' : 'no-targets', error: error, browserId: browserId, targetsSeen: targetsSeen, frameTargets: frameTargets, attempts: attempts }
        }
        return {
          ok: true,
          targetId: String(targetId),
          browserId: browserId,
          targetsSeen: targetsSeen,
          frameTargets: frameTargets,
          attempts: attempts,
          send: send,
          close: close,
          setOnEvent: (fn) => { onEvent = typeof fn === 'function' ? fn : null },
        }
      })),
      // CDP 捕获：仅连本机 127.0.0.1 / localhost / [::1] 且端口匹配的调试端面，
      // 页面按 Tsinghua 域名打分选择，绝不回退到任意页面。
      cdp: pickFn('cdp', (carrierDefaults.cdp = async (arg) => {
        const port = arg.port || 9333
        const deadline = Date.now() + (arg.timeoutMs || 20000)
        // Which instance this read is supposed to be talking to. The core records it when the
        // browser is spawned and states it on every read; nothing below may touch a page until
        // the live endpoint has been asked and answered the same id (2026-10-05 round 18).
        const want = String(arg.uuid || '').toLowerCase()
        const hidden = (arg.hidden && arg.hidden.targetId) ? arg.hidden : null
        // The hidden-page handle carries the identity learned when it was created: that check
        // costs nothing and needs no endpoint, so it goes first.
        const heldId = hidden ? String(hidden.browserId || '').toLowerCase() : ''
        if (hidden && want && heldId && heldId !== want) {
          return { ok: false, running: true, reason: 'not-ours', browserId: heldId }
        }
        // The one identity this read will accept: the id the core recorded when it started the
        // browser, or the one the hidden handle was created with. Without either, a page read
        // would be a read of an unnamed browser — refused right here, before a single request,
        // instead of being aimed at whatever answers on the port (round-18 audit, 2026-10-05).
        // `probeOnly` is the one caller allowed to ask with no expectation: its whole job is to
        // learn the id, and it never reaches a page.
        const expected = isInstanceId(want) ? want : (isInstanceId(heldId) ? heldId : '')
        if (!arg.probeOnly && !expected) {
          return { ok: false, running: true, reason: 'no-ownership-evidence', browserId: '' }
        }
        // Identity before pages: this is the whole point of the round-18 split.
        const seen = await waitForInstance(port, expected ? deadline : Math.min(deadline, Date.now() + 1500))
        const browserId = seen.ok ? seen.id : ''
        const cannotIdentify = { ok: false, running: seen.reason !== 'no-devtools', reason: seen.reason, browserId: '' }
        // Every unanswered identity question refuses the read, including for a caller that stated
        // no expectation: a /json/list that happens to answer is not an identity.
        if (!seen.ok) return cannotIdentify
        if (expected && seen.id !== expected) return { ok: false, running: true, reason: 'not-ours', browserId: seen.id }
        // 隐藏页载体：从创建它的那条浏览器级连接上按 targetId 附身，之后的每条命令都带
        // sessionId（flatten:true）。之所以必须用这条连接，是因为页面寿命绑在它身上（见
        // hiddenTarget 的注释），不是因为它看不见（它会出现在 /json/list 里）。读到的页面
        // 事实与窗口载体一致，由同一段 readCdpPage 完成——两条载体不许有两套读法。
        // 探测只回答"端口上是谁"：不问页面，不问 Cookie（页面与实例是两件事，没窗口的
        // 那台冷启动时只有一个 about:blank，从前它因此被读成"没有目标"）。
        if (arg.probeOnly) return { ok: true, running: true, url: '', browserId: hidden ? (heldId || browserId) : browserId }
        if (hidden) {
          const probe = !!arg.probePage
          const probeErrors = []
          const pushError = (text) => { if (probeErrors.length < 3) probeErrors.push(maskProbeLine(text)) }
          if (probe && typeof hidden.setOnEvent === 'function') {
            hidden.setOnEvent((m) => { const line = probeErrorFrom(m); if (line) pushError(line) })
          }
          let attached = null
          try { attached = await hidden.send('Target.attachToTarget', { targetId: hidden.targetId, flatten: true }) } catch (e) {}
          const sessionId = attached && attached.result && attached.result.sessionId
          if (!sessionId) {
            const why = (attached && attached.error && attached.error.message) ? maskProbeLine(attached.error.message) : ''
            return { ok: false, running: true, reason: 'hidden-gone', error: why }
          }
          const read = await readCdpPage(hidden.send, sessionId, probe, probeErrors)
          return {
            ok: true,
            token: read.token,
            url: read.url,
            cookies: read.cookies,
            browserId: heldId || browserId,
            page: read.page,
            hidden: true,
          }
        }
        let pages = null
        let answered = false
        while (Date.now() < deadline) {
          try {
            const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) })
            if (r && r.ok) {
              answered = true
              pages = jsonParse(await readResponseText(r))
              break
            }
          } catch (e) {}
          await new Promise((r) => setTimeout(r, 300))
        }
        if (!answered) return { ok: false, running: false, reason: 'no-devtools' }
        if (!Array.isArray(pages) || !pages.length) return { ok: false, running: true, reason: 'no-target' }
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
        let blankPage = null
        let firstPage = null
        // Only a page this plugin could ever read something from counts: about:blank (where the
        // no-window arm starts, before the session restore navigates it) or a real http(s) page.
        // A browser-internal target — `edge://sync-confirmation-dialog/` on a fresh profile,
        // `chrome://…`, an extension background page — is not a page we can capture a token from,
        // and reading one would report a browser-internal URL as if it were the site (measured on
        // a real cold Edge in round 18's probe, 2026-10-05).
        const readable = (u) => {
          const text = String(u || '')
          return text === '' || /^about:blank/i.test(text) || /^https?:/i.test(text)
        }
        const isBlank = (u) => /^about:blank/i.test(String(u || ''))
        for (const p of pages) {
          if (!p || typeof p !== 'object' || p.type !== 'page' || !p.webSocketDebuggerUrl) continue
          if (!readable(p.url)) continue
          // The blank page is the one the session restore is about to navigate: it is the best
          // fallback when nothing scores, better than whichever page happens to be first.
          if (!blankPage && isBlank(p.url)) blankPage = p
          if (!firstPage) firstPage = p
          const s = score(p.url || '')
          if (s > best) { best = s; target = p }
        }
        // Cold start (2026-10-05 round 18): the no-window arm starts on about:blank and is
        // navigated to the login entry by the session restore, so the only page target can
        // still be about:blank when the first capture poll arrives. It scored 0 and used to be
        // thrown away as "no target" — the arm then reported a browser that was there all
        // along. The instance identity has been verified above, so one page target is enough.
        if (!target) target = blankPage || firstPage
        if (!target) return { ok: false, running: true, reason: 'no-target' }
        let debuggerUrl = null
        try { debuggerUrl = new URL(target.webSocketDebuggerUrl) } catch (e) {}
        const debuggerHost = debuggerUrl ? debuggerUrl.hostname.toLowerCase() : ''
        if (!debuggerUrl || debuggerUrl.protocol !== 'ws:' ||
            (debuggerHost !== '127.0.0.1' && debuggerHost !== 'localhost' && debuggerHost !== '[::1]') ||
            Number(debuggerUrl.port) !== port) return { ok: false, running: true, reason: 'unsafe-debugger-url' }
        const ws = new WebSocket(debuggerUrl.href)
        let nextId = 1
        const pending = {}
        // Requirement D (2026-10-04 round 9): when the caller asks (`probePage`), this poll
        // also reports what the page actually is. Everything is bounded here, before it can
        // leave the function: at most three messages, 200 characters each, query strings
        // dropped and long opaque runs masked (tickets and tokens live in both).
        const probe = !!arg.probePage
        const probeErrors = []
        const pushError = (text) => { if (probeErrors.length < 3) probeErrors.push(maskProbeLine(text)) }
        let openTimer = null
        const rejectPending = (error) => {
          for (const id of Object.keys(pending)) {
            clearTimeout(pending[id].timer)
            pending[id].reject(error)
            delete pending[id]
          }
        }
        const send = (method, params, sessionId) => new Promise((resolve, reject) => {
          const id = nextId++
          const timer = setTimeout(() => {
            if (pending[id]) { delete pending[id]; reject(new Error('cdp timeout ' + method)) }
          }, 8000)
          pending[id] = { resolve, reject, timer }
          try {
            const msg = { id: id, method: method, params: params || {} }
            if (sessionId) msg.sessionId = sessionId
            ws.send(JSON.stringify(msg))
          } catch (e) {
            clearTimeout(timer)
            delete pending[id]
            reject(e)
          }
        })
        ws.onmessage = (ev) => {
          try {
            if (typeof ev.data !== 'string' || Buffer.byteLength(ev.data) > 1024 * 1024) return
            const m = jsonParse(ev.data)
            if (m && m.id && pending[m.id]) {
              clearTimeout(pending[m.id].timer)
              pending[m.id].resolve(m)
              delete pending[m.id]
              return
            }
            // Events (no id) used to be dropped. Two of them answer "why did this page never
            // finish", so a requested page reading keeps them — as codes and messages only,
            // never as payloads (2026-10-04 round 9, requirement D).
            if (!probe || !m || !m.method) return
            const line = probeErrorFrom(m)
            if (line) pushError(line)
          } catch (e) {}
        }
        try {
          await new Promise((resolve, reject) => {
            ws.onopen = () => {
              clearTimeout(openTimer)
              resolve()
            }
            ws.onerror = () => reject(new Error('ws error'))
            openTimer = setTimeout(() => reject(new Error('ws open timeout')), 6000)
          })
          ws.onerror = () => rejectPending(new Error('ws error'))
          ws.onclose = () => rejectPending(new Error('ws closed'))
          // 页面读取本身与隐藏页载体共用同一段代码（readCdpPage）：两条载体不许有两套读法，
          // 否则「同一个页面」在两种载体下会给出不同事实（2026-10-04 第十轮）。
          const read = await readCdpPage(send, '', probe, probeErrors)
          return { ok: true, token: read.token, url: read.url, cookies: read.cookies, browserId: browserId, page: read.page }
        } finally {
          clearTimeout(openTimer)
          rejectPending(new Error('cdp connection closed'))
          try { ws.close() } catch (e) {}
        }
      })),
      // SSO 会话恢复：把 state.cookieJar 里仍属于登录入口域名的 Cookie，用 CDP 写回**本次启动**的
      // 那台浏览器（先核 /json/version 的实例身份），再从 about:blank 导航到登录入口，让站点自己的
      // JavaScript 去算设备指纹。HTTP 腿能用的 session cookie，浏览器腿从此也能用（2026-10-05 第十六轮）。
      sessionRestore: pickFn('sessionRestore', (carrierDefaults.sessionRestore = createSessionRestorer({}))),
      // 账号登录驱动（2026-11-28）：SSO 会话真的没了、梯子已经拿到「登录表单」这一步时，如果用户
      // 在自己的设置里存了账号，就在**本次启动的无窗口浏览器**里把那张表填一次、提交一次。它只在
      // 身份、来源、页面形状都核过之后才动手，且不接受任何验证码/二次验证/设备确认的替代路径。
      loginDriver: loginDriverFn,
      // 进程表里每个浏览器正在使用的 profile 目录：共享目录已被别的进程占着时，本次运行改用
      // 自己的独立 profile（Chromium 的单例会把新 argv 交给已在跑的那台，我们要的调试端口永远
      // 不会应答）。读不到就是"不知道"，调用方退回旧行为，不把失败当成"目录空着"（2026-10-05 第十七轮）。
      listBrowserProfiles: pickFn('listBrowserProfiles', (carrierDefaults.listBrowserProfiles = createProfileLister({}))),
      // 状态文件：%USERPROFILE%\.dsh\madmodel\state.json，原子写（tmp + rename + chmod 0600），
      // 与 0.2.x 动态版同一路径，正式版无缝接管已有数据。
      stateIO: (picks.stateIO && typeof picks.stateIO === 'object') ? picks.stateIO : {
        async mkdir(path) { try { fs.mkdirSync(path, { recursive: true }); return { ok: true } } catch (e) { return { ok: false, error: String((e && e.message) || e) } } },
        // One directory, as a reading: names plus the age that decides whether a leftover from a
        // crashed run is old enough to remove. `ok:false` means the caller must not conclude
        // "there is nothing there" (2026-10-05 round 17).
        async list(path) {
          try {
            const entries = fs.readdirSync(path, { withFileTypes: true }).map((entry) => {
              let mtimeMs = 0
              try { mtimeMs = fs.statSync(path + '\\' + entry.name).mtimeMs } catch (ignore) {}
              return { name: String(entry.name), dir: !!entry.isDirectory(), mtimeMs: mtimeMs }
            })
            return { ok: true, entries: entries }
          } catch (e) { return { ok: false, entries: [], error: String((e && e.message) || e) } }
        },
        // Only ever pointed at an isolated carrier profile — a directory this plugin created for
        // one run and is done with. Recursive on purpose: a Chromium profile is a tree.
        async rm(path) {
          try { fs.rmSync(path, { recursive: true, force: true }); return { ok: true } } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        },
        rmSync(path) {
          try { fs.rmSync(path, { recursive: true, force: true }); return { ok: true } } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        },
        async load(path) {
          try {
            if (fs.existsSync(path)) return { ok: true, data: jsonParse(fs.readFileSync(path, 'utf8')) }
            return { ok: true, data: null }
          } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
        },
        async save(path, data) {
          let tmp = ''
          const text = JSON.stringify(data)
          try {
            fs.mkdirSync(dirname(path), { recursive: true })
            tmp = path + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2)
            fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
            let renamed = false
            let swapError = ''
            for (let attempt = 1; attempt <= 3 && !renamed; attempt++) {
              try {
                fs.renameSync(tmp, path)
                renamed = true
              } catch (e) {
                // Codes the OS hands out for a moment — something scanning the file, or
                // another write that has just replaced it — are worth waiting out. Anything
                // else will not get better by trying again, so it is reported as it is.
                if (!TRANSIENT_FS_CODES.has(String((e && e.code) || ''))) throw e
                swapError = String((e && e.message) || e)
                if (attempt < 3) await sleepMs(60)
              }
            }
            if (!renamed) {
              // Three swaps were refused, so the atomic path is not available right now.
              // The data still has to land: losing the record is exactly what left the panel
              // describing an older run on 2026-10-04, so the destination is written
              // directly and the caller is told the swap did not happen. (Throwing here made
              // this whole branch unreachable — the fallback only ran on a code the loop
              // never reached. Found by the test that refuses every rename.)
              // Atomicity is the one thing given up: a crash midway through this write leaves
              // a half-written file, which is precisely what the swap above prevents. That is
              // why it is the last resort after three refusals, not the first choice.
              fs.writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
              try { fs.unlinkSync(tmp) } catch (ignore) {}
            }
            try { fs.chmodSync(path, 0o600) } catch (e) {}
            return renamed ? { ok: true } : { ok: true, degraded: swapError }
          } catch (e) {
            if (tmp) { try { fs.unlinkSync(tmp) } catch (ignore) {} }
            return { ok: false, error: String((e && e.message) || e) }
          }
        },
      },
      findExecutable: pickFn('findExecutable', async (candidate) => {
        try { return fs.existsSync(candidate) ? candidate : null } catch (e) { return null }
      }),
      spawnBrowser: pickFn('spawnBrowser', (exe, argv) => new Promise((resolve, reject) => {
        const child = spawn(exe, argv, {
          cwd: process.env.SystemRoot || 'C:\\Windows',
          detached: true,
          stdio: 'ignore',
        })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve({ pid: child.pid })
        })
      })),
    })
    disposers.push(() => core.dispose())

    const rejectReq = (req) => {
      try { return connection.requestRejection(req) } catch (e) {
        console.error('[thu-tok-auto] request trust check', e)
        return 403
      }
    }
    // The route table itself lives in createApiHandlers so a test can drive exactly the
    // handlers the host registers. Only the three keys the webServer contract knows are
    // handed over — the entry's `method` is this module's own bookkeeping.
    for (const entry of createApiHandlers(core, { rejectReq, secretStore })) {
      const { path, handler } = entry
      disposers.push(webServer.register({ kind: 'exact', path, handler }))
    }

    const uiUrl = new URL('./ui.js', import.meta.url)
    if (fs.existsSync(uiUrl)) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/thu-tok-auto/ui.js',
        handler: (req, res) => {
          const rejection = rejectReq(req)
          if (rejection !== undefined) {
            const code = rejection === 401 ? 401 : 403
            return json(res, { ok: false, error: code === 401 ? '请先登录 DSH。' : '请求来源不受信任。' }, code)
          }
          if (req.method !== 'GET') return json(res, { ok: false, error: '请求方法不支持。' }, 405, { Allow: 'GET' })
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Referrer-Policy': 'no-referrer',
          })
          res.end(fs.readFileSync(uiUrl, 'utf8'))
        },
      }))
      disposers.push(ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'script-src', placement: 'body', src: '/thu-tok-auto/ui.js' })
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

// Host entry point: the DSH loader calls apply(ctx) with one argument, so the test seam
// must not live in this signature (see applyWithDeps above).
function apply(ctx) {
  return applyWithDeps(ctx, null)
}

export { name, inject, apply, applyWithDeps, createApiHandlers, carrierDefaults }
