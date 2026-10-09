/**
 * Authenticated loopback client for this machine's running `dsh web` Host (dev-only,
 * never shipped, not part of `npm test`).
 *
 * Why it exists: the plugin's own API sits behind the Host's browser-session fence
 * (`dsh-client-connection/lib/index.js:586-589` -> 403 for an untrusted Origin/Host,
 * 401 without a valid session cookie), so an anonymous probe can only ever see
 * `{"ok":false,"error":"请先登录 DSH。"}`. Every real question about the plugin's state
 * ("is a capture already waiting?" / "did that click reach the ladder?") needs an
 * authenticated request.
 *
 * One way in, and it is the official one (2026-10-05 round 16):
 *
 *   `--auth=log` (the only mode): read the launch URL `dsh web` printed to its stdout
 *      (`dsh-web-app/lib/index.js:203`; the token is also what `/` accepts,
 *      `dsh-client-connection/lib/index.js:388-411`), exchange it once for the real
 *      session cookie the Host would hand the browser, and use that cookie. The token
 *      never leaves this machine and is never printed.
 *   An earlier version could instead mint that cookie by hand from the Host's stored
 *   signing secret. That path is deliberately removed: a test tool that is allowed to read
 *   credentials and forge a session makes every later "the Host accepted it" reading
 *   worthless, and the user's rule is that this project never does either.
 *
 * Hard limits, on purpose:
 *   - the launch token and the cookie are never printed, never written to a
 *     file, never sent anywhere but 127.0.0.1; the process exits when the work is done;
 *   - read-only unless the command says otherwise: `status` only GETs; `get-tok` POSTs the
 *     plugin's own registered entry once and is never retried automatically;
 *   - token/cookie-shaped fields in the answer are redacted before printing;
 *   - state.json is only ever READ. A refresh writes its own result through the live Host
 *     (same instance, same files), which is the whole point of `bg-refresh`: the old token,
 *     the new token and the provider all change together inside the real process;
 *   - it does not read the credential store, and does not touch the browser or CDP.
 *
 *   node test/host-api.mjs status
 *   node test/host-api.mjs raw GET /thu-tok-auto/api/status
 *   node test/host-api.mjs get-tok          # manual Get, once (opens the plugin's window)
 *   node test/host-api.mjs bg-refresh       # one unattended run, then watch state.json
 *
 * bg-refresh is the activation check for 0.3.13: it asks for the unattended carrier
 * (`POST /thu-tok-auto/api/get-tok` with `{"background":true}`), waits on `fs.watch`
 * (event-driven, no polling) until the live Host has written the run's result, then reports
 * a sanitized JSON verdict: did `tokenExpAt` strictly advance, which state did the Host
 * end in, and did the plugin's own window open and close. Exit 0 settled / 4 timeout /
 * 6 no state file / 3 transport / 2 usage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const BASE = process.env.DSH_HOST_URL || 'http://127.0.0.1:3080'
const STATE_FILE = process.env.THU_TOK_AUTO_STATE || path.join(HOME, '.dsh', 'madmodel', 'state.json')
const authority = new URL(BASE).host

const line = (s) => process.stdout.write(s + '\n')

/**
 * The launch token is printed once, to stdout, and is never written anywhere by the Host
 * (`dsh-web-app/lib/index.js:203` prints `dsh web: <url>?token=<t>`). Find it in the
 * launcher's own log file: the known one first, then any `dsh-*.stdout.log` in TEMP,
 * newest first, reading only the tail of each.
 */
function tokenFromLog(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  else if (process.env.DSH_LAUNCH_LOG) candidates.push(process.env.DSH_LAUNCH_LOG)
  const temp = process.env.TEMP || process.env.TMP || ''
  if (temp) {
    try {
      const named = fs.readdirSync(temp).filter((f) => /^dsh-.*\.stdout\.log$/i.test(f))
        .map((f) => path.join(temp, f))
        .map((p) => ({ p, at: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 20)
        .map((x) => x.p)
      for (const p of named) if (!candidates.includes(p)) candidates.push(p)
    } catch (e) { /* TEMP unreadable: fall through to the explicit path only */ }
  }
  for (const file of candidates) {
    let text = ''
    try {
      const size = fs.statSync(file).size
      const start = Math.max(0, size - 64 * 1024)
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      text = buf.toString('utf8')
    } catch (e) { continue }
    const hits = [...text.matchAll(/dsh web:\s*(\S+)/g)]
    for (let i = hits.length - 1; i >= 0; i--) {
      let token = ''
      try { token = new URL(hits[i][1]).searchParams.get('token') || '' } catch (e) { token = '' }
      if (/^[A-Za-z0-9_-]{16,}$/.test(token)) return { token, file }
    }
  }
  return null
}

/** Exchange the launch token for the Host's real session cookie (`GET /?token=` -> 303). */
async function sessionFromLog(found) {
  const r = await fetch(BASE + '/?token=' + encodeURIComponent(found.token), {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  })
  const raw = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie')].filter(Boolean)
  const pair = raw.map((c) => String(c).split(';')[0]).find((c) => /^dsh-auth-[^=]*=/.test(c))
  if (!pair) return { ok: false, status: r.status }
  const name = pair.slice(0, pair.indexOf('='))
  return { ok: true, status: r.status, name, header: pair, via: 'log', file: found.file }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function jarDigest(jar) {
  const rows = (Array.isArray(jar) ? jar : [])
    .map((c) => [String(c && c.name || ''), String(c && c.value || '')])
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]))
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12)
}

function stateFacts(s) {
  if (!s) return { present: false }
  const trace = s.lastTrace || {}
  const manual = s.lastManualTrace || {}
  return {
    present: true,
    tokenExpAt: s.tokenExpAt || 0,
    lastGetAt: s.lastGetAt || 0,
    renewalNoProgress: !!s.renewalNoProgress,
    refreshBlocked: !!s.refreshBlocked,
    loginReason: s.loginReason || '',
    serverValid: s.serverValid,
    auto: !!s.auto,
    jar: { count: Array.isArray(s.cookieJar) ? s.cookieJar.length : 0, digest: jarDigest(s.cookieJar) },
    sso: { count: Array.isArray(s.ssoCookies) ? s.ssoCookies.length : 0, digest: jarDigest(s.ssoCookies) },
    lastTrace: { at: trace.at || 0, bg: trace.bg, via: trace.via || '', opened: trace.opened || '', expBefore: trace.expBefore || 0, expAfter: trace.expAfter || 0 },
    lastManualTrace: { at: manual.at || 0, bg: manual.bg, via: manual.via || '', opened: manual.opened || '' },
  }
}

/** Print the answer as facts, with anything secret-shaped replaced. */
function sanitize(value) {
  const SECRET_KEY = /token|secret|cookie|jar|authorization|apikey|api_key/i
  const walk = (v, key) => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
    if (typeof v === 'string') {
      if (SECRET_KEY.test(key || '')) return '<redacted:' + v.length + 'ch>'
      return v.length > 200 ? v.slice(0, 200) + '…<' + v.length + 'ch>' : v
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k)
      return out
    }
    return String(v)
  }
  return walk(value, '')
}

function closedLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.includes('[thu-tok-auto] browser closed')).length
  } catch (e) { return -1 }
}

const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) { positional.push(a); continue }
  const eq = a.indexOf('=')
  if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1))
  else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(a.slice(2), argv[++i])
  else flags.set(a.slice(2), 'true')
}
const command = positional[0] || 'status'
// How this tool authenticates (2026-10-05 round 16): the *only* way is the real launch
// authorisation URL the Host printed when this instance started — `GET /?token=…` and the
// session cookie it answers with. The earlier fallback that read the Host's own
// browser-session secret and minted a signed cookie by hand is gone on purpose: this tool must
// never read credentials or forge a session, and a tool that is allowed to do so makes every
// later "the Host accepted it" reading worthless.
const authMode = String(flags.get('auth') || 'log').toLowerCase()
if (authMode !== 'log') {
  line('usage: --auth only accepts "log" (the launch authorisation URL). Forging a session cookie is not supported.')
  process.exit(2)
}
const timeoutMs = Number(flags.get('timeout-ms') || 120000)

let session = null
{
  const found = tokenFromLog(flags.get('from-log') || flags.get('host-log'))
  if (found) {
    session = await sessionFromLog(found)
    if (session.ok) {
      line('host=' + BASE + ' authority=' + authority + ' state=' + STATE_FILE)
      line('session: exchanged the launch token from ' + found.file
        + ' (HTTP ' + session.status + ', name len=' + session.name.length
        + ', value len=' + session.header.length + '; token and cookie never printed)')
    } else {
      line('session: the launch token from ' + found.file + ' was refused (HTTP ' + session.status + ')')
      session = null
    }
  } else {
    line('session: no launch token found (pass --from-log <file> or set DSH_LAUNCH_LOG)')
  }
}
if (!session) process.exit(2)

async function call(method, target, body) {
  const init = {
    method,
    redirect: 'manual',
    headers: { Cookie: session.header },
    signal: AbortSignal.timeout(120000),
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = body
  }
  line('request: ' + method + ' ' + target + (body === undefined ? '' : ' body=' + body))
  const started = Date.now()
  let response
  try {
    response = await fetch(BASE + target, init)
  } catch (e) {
    line('transport error: ' + String((e && e.name) || e) + ': ' + String((e && e.message) || ''))
    process.exit(3)
  }
  const text = await response.text().catch(() => '')
  line('answer: HTTP ' + response.status + ' ' + (response.headers.get('content-type') || '')
    + ' bytes=' + text.length + ' ms=' + (Date.now() - started))
  let parsed = null
  try { parsed = JSON.parse(text) } catch (e) { /* not JSON */ }
  if (parsed === null) {
    line('body(first 200 chars, redacted): ' + text.slice(0, 200).replace(/[A-Za-z0-9_-]{24,}/g, (m) => '<redacted:' + m.length + '>'))
  } else {
    line('body:')
    line(JSON.stringify(sanitize(parsed), null, 2))
  }
  return { status: response.status, parsed }
}

/** Wait for the live Host to write the run's own result, using fs.watch only. */
function watchState(file, before, timeout) {
  return new Promise((resolve) => {
    let settled = null
    let quiet = null
    const finish = (event) => {
      try { watcher.close() } catch (e) { /* already closed */ }
      clearTimeout(timer)
      clearTimeout(quiet)
      resolve(event)
    }
    let watcher
    try {
      watcher = fs.watch(path.dirname(file), (kind, name) => {
        if (name && String(name) !== path.basename(file)) return
        const now = stateFacts(readState(file))
        if (!now.present) return
        if (now.lastGetAt > before.lastGetAt || now.tokenExpAt !== before.tokenExpAt) settled = now
        if (!settled) return
        clearTimeout(quiet)
        quiet = setTimeout(() => finish({ event: 'settled', after: settled }), 1500)
      })
    } catch (e) {
      return finish({ event: 'no-state', error: String(e && e.message || e) })
    }
    const timer = setTimeout(() => finish(settled
      ? { event: 'settled', after: settled }
      : { event: 'timeout', after: stateFacts(readState(file)) }), timeout)
  })
}

if (command === 'status') {
  await call('GET', '/thu-tok-auto/api/status')
} else if (command === 'get-tok') {
  await call('POST', '/thu-tok-auto/api/get-tok', '{}')
} else if (command === 'open-login') {
  await call('POST', '/thu-tok-auto/api/open-login', '{}')
} else if (command === 'set-auto') {
  await call('POST', '/thu-tok-auto/api/set-auto', JSON.stringify({ on: positional[1] === 'on' }))
} else if (command === 'raw') {
  await call(String(positional[1] || 'GET').toUpperCase(), String(positional[2] || '/thu-tok-auto/api/status'), positional[3])
} else if (command === 'bg-refresh') {
  // One unattended run through the real production entry, then evidence from the same
  // process that ran it. Nothing here writes state.json: the Host does, atomically, with
  // the old token, the new token and the provider in one commit.
  const before = stateFacts(readState(STATE_FILE))
  if (!before.present) {
    line('state file not found or unreadable: ' + STATE_FILE)
    process.exit(6)
  }
  const logFile = flags.get('host-log') || process.env.DSH_HOST_LOG || ''
  const closedBefore = logFile ? closedLines(logFile) : -1
  line('before: tokenExpAt=' + before.tokenExpAt + ' lastGetAt=' + before.lastGetAt
    + ' jar=' + before.jar.count + '/' + before.jar.digest + ' loginReason=' + (before.loginReason || '-'))
  const answer = await call('POST', '/thu-tok-auto/api/get-tok', JSON.stringify({ background: true }))
  const outcome = await watchState(STATE_FILE, before, timeoutMs)
  const after = outcome.after || stateFacts(readState(STATE_FILE))
  const live = await call('GET', '/thu-tok-auto/api/status')
  const closedAfter = logFile ? closedLines(logFile) : -1
  const verdict = {
    event: outcome.event,
    expAdvanced: !!(after && after.tokenExpAt > before.tokenExpAt),
    tokenExpAt: { before: before.tokenExpAt, after: after ? after.tokenExpAt : 0 },
    lastGetAt: { before: before.lastGetAt, after: after ? after.lastGetAt : 0 },
    jarChanged: !!(after && after.jar.digest !== before.jar.digest),
    ssoChanged: !!(after && after.sso.digest !== before.sso.digest),
    renewalNoProgress: after ? after.renewalNoProgress : null,
    trace: after ? after.lastTrace : null,
    accepted: sanitize(answer.parsed || { http: answer.status }),
    live: sanitize(live.parsed || { http: live.status }),
    ownedWindowClosed: logFile ? { before: closedBefore, after: closedAfter, newLines: closedAfter - closedBefore } : 'no host log given',
    stateFile: STATE_FILE,
    hostLog: logFile || null,
  }
  line('verdict: ' + JSON.stringify(verdict, null, 2))
  process.exit(outcome.event === 'settled' ? 0 : 4)
} else {
  line('usage: node test/host-api.mjs status | get-tok | open-login | set-auto on|off | raw <METHOD> <PATH> [jsonBody] | bg-refresh')
  line('  --auth=log (the only mode)   --from-log <file>   --state <file>   --timeout-ms <n>   --host-log <file>')
  process.exit(2)
}
