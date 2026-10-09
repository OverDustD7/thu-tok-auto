#!/usr/bin/env node
// Stop what this plugin started — and nothing else (2026-10-05 round 14, requirement A).
//
// The plugin writes a small "owned lease" into `state.json` the moment it spawns a browser:
// instance identity (when it is known), debug port, pid, spawn time, the private profile
// directory and the executable. That record is what makes a leftover *ours*; without it a
// browser is a stranger and is never read or closed.
//
// Round 17 added a second record: `portLeftover` — a browser of ours that was asked to close and
// would not confirm it, which is why a run had to route around it (another port, a profile of its
// own). That one is no longer the lease (the lease describes the browser the *current* run drives),
// so it can only be closed by its instance identity. This script tries it too, and says so.
//
// Usage:
//   node lib/stop-owned.js                 # close the browser the lease names, print readings
//   node lib/stop-owned.js --dry-run       # readings only, close nothing
//   node lib/stop-owned.js --home <dir>    # use another state directory (default ~/.dsh/madmodel)
//   node lib/stop-owned.js --json          # machine-readable output
//
// It never kills by image name, never touches a browser the process table cannot tie to the
// lease, and never writes to state.json (the plugin retires the lease itself on its next run).
// Exit code 0 = closed (or nothing to do), 1 = could not confirm, 2 = bad usage.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserCloser, createBrowserStopperSync, syncFallbackAllowed } from './index.js'
import { isIsolatedProfile } from './carrier-profile.js'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : ''
}
const known = ['--dry-run', '--json', '--home', '--help']
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--home') { i += 1; continue }
  if (!known.includes(a)) {
    console.error('unknown option: ' + a + '\nusage: node lib/stop-owned.js [--dry-run] [--json] [--home <dir>]')
    process.exit(2)
  }
}
if (has('--help')) {
  console.log('usage: node lib/stop-owned.js [--dry-run] [--json] [--home <dir>]')
  process.exit(0)
}

const baseDir = valueOf('--home') || process.env.THU_TOK_AUTO_HOME || path.join(os.homedir(), '.dsh', 'madmodel')
const statePath = path.join(baseDir, 'state.json')
const emit = (obj) => {
  if (has('--json')) { console.log(JSON.stringify(obj, null, 2)); return }
  for (const [k, v] of Object.entries(obj)) {
    console.log(k + ': ' + (v && typeof v === 'object' ? JSON.stringify(v) : String(v)))
  }
}

let data = null
try { data = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch (e) { data = null }
const lease = data && data.owned && typeof data.owned === 'object' ? data.owned : null
const leftover = data && data.portLeftover && typeof data.portLeftover === 'object' ? data.portLeftover : null
const leaseArg = lease && lease.port
  ? { port: lease.port, pid: lease.pid || 0, uuid: lease.uuid || '', reason: 'stop-owned', owned: lease }
  : null
const leftoverArg = leftover && leftover.port && leftover.id
  ? { port: leftover.port, pid: leftover.pid || 0, uuid: String(leftover.id), reason: 'stop-leftover', owned: null }
  : null
const leftoverReading = leftoverArg
  ? {
      port: leftoverArg.port,
      identity: String(leftoverArg.uuid).slice(0, 8) + '…',
      pid: leftoverArg.pid || 0,
      why: String(leftover.why || ''),
      at: leftover.at ? new Date(leftover.at).toISOString() : '',
      profile: String(leftover.profile || ''),
      isolatedProfile: isIsolatedProfile(String(leftover.profile || ''), baseDir),
    }
  : null

if (!leaseArg && !leftoverArg) {
  emit({
    state: statePath, leased: false, leftover: null, action: 'none',
    why: '账面记录里没有本插件启动过的浏览器（state.json 没有 owned，或它已经被确证关闭并退休）',
  })
  process.exit(0)
}

const reading = leaseArg
  ? {
      state: statePath,
      leased: true,
      port: leaseArg.port,
      pid: leaseArg.pid,
      profile: String(leaseArg.owned.profile || ''),
      exe: String(leaseArg.owned.exe || ''),
      spawnedAt: leaseArg.owned.spawnedAt ? new Date(leaseArg.owned.spawnedAt).toISOString() : '',
      spawnId: String(leaseArg.owned.spawnId || ''),
      identity: leaseArg.uuid ? String(leaseArg.uuid).slice(0, 8) + '…' : '（还没取到）',
      // Whether this browser lived in a directory the plugin made for one run (2026-10-05 round 17).
      // It is a reading here and a removal below, and the guard is the same one the plugin uses: only
      // `run-*` directly under this state directory is ever a candidate.
      isolatedProfile: isIsolatedProfile(String(leaseArg.owned.profile || ''), baseDir),
    }
  : { state: statePath, leased: false }
// A browser that lived in a one-run profile leaves that directory behind when it goes. A proven
// close is the precondition — while the browser might still be running, the directory is still
// its own — and a shared profile never matches the guard, so the real profile (with the site's
// cookies and stored device fingerprint) is never removed by this script.
const dropIsolatedProfile = (profile, why) => {
  const dir = String(profile || '')
  if (!isIsolatedProfile(dir, baseDir)) return null
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { profile: dir, ok: true, why }
  } catch (e) {
    return { profile: dir, ok: false, why, error: String((e && e.message) || e) }
  }
}
const tryClose = async (arg) => {
  try { return await createBrowserCloser({})(arg) } catch (e) {
    return { closed: false, reason: 'threw', why: String((e && e.message) || e) }
  }
}

if (has('--dry-run')) {
  emit({ ...reading, leftover: leftoverReading, action: 'none', why: '--dry-run：只报读数，什么都没关' })
  process.exit(0)
}

let code = 0
const out = { ...reading, leftover: leftoverReading, action: 'stop' }
if (leaseArg) {
  const graceful = await tryClose(leaseArg)
  out.graceful = graceful
  if (graceful && graceful.closed === true) {
    out.profileRemoved = dropIsolatedProfile(leaseArg.owned.profile, 'stop-owned:graceful')
    out.result = '已确证关闭'
  } else {
    // The graceful path could not prove it. Whether a synchronous retry is even allowed is decided
    // by the verdict, not by convenience (2026-10-05 round 16): `taskkill /PID` checks nothing but
    // the number, so retrying a verdict that said 「这台不是本插件的」(身份对不上 / 证据不足 / 判词本身
    // 就是拒绝) would kill whoever holds that pid now. Only an attempt that *ran out* — budget, still
    // running, or threw — is retried, and then the retry applies the same evidence rule as ever.
    const retryable = syncFallbackAllowed(graceful)
    if (!retryable) {
      out.fallback = null
      out.result = '没能确证关闭，且判词不是「跑不完」而是「这台不是本插件的」：按上面的 reason/why 处理，不做同步重试'
      code = 1
    } else {
      let fallback = null
      try { fallback = createBrowserStopperSync({})({ ...leaseArg, sync: true }) } catch (e) {
        fallback = { closed: false, reason: 'threw', why: String((e && e.message) || e) }
      }
      out.fallback = fallback
      const done = !!(fallback && fallback.closed === true)
      out.profileRemoved = done ? dropIsolatedProfile(leaseArg.owned.profile, 'stop-owned:sync') : null
      out.result = done ? '已确证关闭（进程表判据）' : '没能确证关闭：读数如上，请照 why/reason 处理，别当成已经关掉'
      if (!done) code = 1
    }
  }
}
// The browser that would not confirm its close, which is why a later run had to route around it
// (round 17). It is not this lease any more, so identity is the only evidence left — and with no
// lease there is nothing for the process table to verify, so this one goes down the graceful path
// only: no `taskkill /PID` on a number nothing else corroborates.
if (leftoverArg && !(leaseArg && leaseArg.port === leftoverArg.port && leaseArg.uuid === leftoverArg.uuid)) {
  const tried = await tryClose(leftoverArg)
  out.leftoverResult = tried
  const gone = !!(tried && tried.closed === true)
  out.leftoverProfileRemoved = gone ? dropIsolatedProfile(leftover.profile, 'stop-leftover') : null
  if (gone) {
    if (!leaseArg) out.result = '残留已确证关闭'
    else out.result = String(out.result) + '；另有那条关不掉的残留也已确证关闭'
  } else if (!leaseArg) {
    out.result = '没能确证关闭：读数如上，请照 why/reason 处理，别当成已经关掉'
    code = 1
  } else {
    out.result = String(out.result) + '；但那条关不掉的残留仍没能关闭（见 leftoverResult）'
  }
}
if (out.result === undefined) out.result = '已确证关闭'
emit(out)
process.exit(code)
