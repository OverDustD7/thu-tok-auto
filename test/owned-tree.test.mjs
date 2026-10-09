// The one decision that authorises killing a process, and the two closers that use it
// (2026-10-05 round 14, requirement A).
//
// The rule under test is deliberately narrow: a browser is stoppable only when the process
// table shows the exact private `--user-data-dir` this plugin passed, the executable we
// launched, and a tie to *this* lease — our debug port, or the pid we recorded whose start
// time still matches. The image name is never a criterion (`msedge.exe` names the user's own
// windows too), and a pid whose start time moved on is a recycled number, not our browser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyOwnTree, parseProcessJson, createBrowserStopperSync, createBrowserCloser, syncFallbackAllowed } from '../lib/index.js'

const PROFILE = 'C:\\Users\\test\\.dsh\\madmodel\\profile'
const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const AT = 1791108083039

const lease = (over = {}) => ({
  spawnId: 'spawn-1', uuid: 'uuid-1', port: 9333, pid: 4321, spawnedAt: AT, profile: PROFILE, exe: EXE, ...over,
})

// One row of the process table as `parseProcessJson` produces it.
const row = (over = {}) => ({
  pid: 4321, ppid: 1000, exe: EXE, cmd: '"' + EXE + '" --remote-debugging-port=9333 --user-data-dir="' + PROFILE + '"', startedAt: AT, ...over,
})

// The user's own browser: same image, a completely different profile.
const stranger = row({ pid: 9001, cmd: '"' + EXE + '" --user-data-dir="C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\User Data"' })

// A child of our browser, as the process table reports it: it carries the profile (Chromium hands
// it to every child) but not the debug port, so it is ours only through its parent (round 16).
const child = (over = {}) => row({
  pid: 4322, ppid: 4321, cmd: '"' + EXE + '" --user-data-dir="' + PROFILE + '" --type=renderer', startedAt: AT + 400, ...over,
})

test('parsing the process table keeps the five readings the decision needs', () => {
  const out = JSON.stringify([
    { ProcessId: 4321, ParentProcessId: 1000, ExecutablePath: EXE, CommandLine: '"' + EXE + '" --x', StartedUtc: '2026-10-05T02:41:23.039Z' },
  ])
  const rows = parseProcessJson(out)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 4321)
  assert.equal(rows[0].ppid, 1000)
  assert.equal(rows[0].exe, EXE)
  assert.equal(rows[0].cmd, '"' + EXE + '" --x')
  assert.equal(rows[0].startedAt, Date.parse('2026-10-05T02:41:23.039Z'))
})

test('a single-object table is read as one row, and unreadable input as none', () => {
  assert.equal(parseProcessJson(JSON.stringify({ ProcessId: 7, CommandLine: 'x' })).length, 1)
  assert.deepEqual(parseProcessJson('not json'), [])
  assert.deepEqual(parseProcessJson(''), [])
  assert.deepEqual(parseProcessJson('[]'), [])
  // A row without a pid cannot be acted on, so it is dropped rather than guessed at.
  assert.deepEqual(parseProcessJson(JSON.stringify([{ CommandLine: 'x' }])), [])
})

test('the kill decision refuses without a profile, whoever is on the port', () => {
  const r = classifyOwnTree([stranger], lease({ profile: '' }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-ownership-evidence', '没有专属 profile 就没有判据，pid 和端口都不算')
})

test('nothing carrying our profile is a browser that is already gone', () => {
  const r = classifyOwnTree([stranger], lease())
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'nothing-to-kill')
  assert.deepEqual(r.mine, [], '用户自己的浏览器不许进这次判定的名单')
})

test('a different executable behind our profile directory is refused, with the pids it saw', () => {
  const r = classifyOwnTree([row({ exe: 'C:\\other\\chrome.exe' })], lease())
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'exe-mismatch')
  assert.deepEqual(r.saw, [4321])
})

test('our debug port on the command line is the tie, and the whole tree is named', () => {
  // The recorded pid is not in the table (that number belongs to somebody else now), so the only
  // thing left that can tie this tree to the lease is the debug port only we chose.
  const root = row({ pid: 6100, cmd: '"' + EXE + '" --remote-debugging-port=9333 --user-data-dir="' + PROFILE + '"' })
  const kid = child({ pid: 6101, ppid: 6100 })
  const r = classifyOwnTree([kid, root], lease({ pid: 9999 }))
  assert.equal(r.ok, true)
  assert.equal(r.via, 'port', '端口是我们自己挑的，只有我们这台会在命令行上带着它')
  assert.equal(r.rootPid, 6100)
  assert.deepEqual(r.mine.map((p) => p.pid).sort(), [6100, 6101], '主进程和挂在它下面的子进程一起算（子进程也带 profile）')
})

test('a process carrying our profile but not hanging under the tied root is not ours to kill', () => {
  // Round 16 narrowed the kill list on purpose: a row that merely shares the profile directory —
  // another instance, or a stray spawned outside this tree — is left alone.
  const orphan = child({ pid: 7002, ppid: 1 })
  const r = classifyOwnTree([row(), orphan], lease())
  assert.equal(r.ok, true)
  assert.deepEqual(r.mine.map((p) => p.pid), [4321], '同 profile 但不是这棵树的后代、命令行也没有我们的端口')
})

test('without the port on any command line, the pid plus its start time still ties the tree to this lease', () => {
  const rows = [row({ pid: 5001, cmd: '"' + EXE + '" --user-data-dir="' + PROFILE + '"' })]
  const r = classifyOwnTree(rows, lease({ pid: 5001, spawnedAt: AT + 1200 }))
  assert.equal(r.ok, true)
  assert.equal(r.via, 'pid+time')
  assert.deepEqual(r.mine.map((p) => p.pid), [5001])
})

test('a pid that was recycled is refused: the start time gives it away', () => {
  const rows = [row({ pid: 4321, cmd: '"' + EXE + '" --user-data-dir="' + PROFILE + '"' })]
  const r = classifyOwnTree(rows, lease({ spawnedAt: AT + 6 * 3600e3 }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'spawn-time-mismatch')
  assert.deepEqual(r.saw, [4321], '号码是我们的，进程不是')
})

test('a recorded pid whose start time the table does not carry is refused, not assumed', () => {
  // Round 16: "the process did not report a start time" used to fall back to the pid alone. It no
  // longer does — without a start time a recycled number cannot be told apart from our own
  // process, and the port matching is not allowed to make up for it.
  const rows = [row({ startedAt: 0, cmd: '"' + EXE + '" --user-data-dir="' + PROFILE + '"' })]
  const r = classifyOwnTree(rows, lease())
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'spawn-time-unknown')
  assert.deepEqual(r.saw, [4321])
})

test('a lease missing one of the five fields refuses instead of dropping that check', () => {
  for (const [why, over] of [['no-profile', { profile: '' }], ['no-exe', { exe: '' }], ['no-port', { port: 0 }], ['no-pid', { pid: 0 }], ['no-spawn-time', { spawnedAt: 0 }]]) {
    const r = classifyOwnTree([row()], lease(over))
    assert.equal(r.ok, false, why)
    assert.equal(r.reason, 'no-ownership-evidence', why)
    assert.equal(r.why, why, '缺哪个字段就说哪个，不许悄悄少判一条')
  }
})

test('argv boundaries decide the profile: a sibling directory is not ours', () => {
  const near = row({ pid: 8001, cmd: '"' + EXE + '" --remote-debugging-port=9333 --user-data-dir="' + PROFILE + '-backup"' })
  const r = classifyOwnTree([near], lease({ pid: 9999 }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'nothing-to-kill', 'profile-backup 不是 profile（旧实现在这里会认成自己）')
  assert.deepEqual(r.mine, [])
})

test('argv boundaries decide the port: 93330 is not 9333', () => {
  const near = row({ pid: 8002, cmd: '"' + EXE + '" --remote-debugging-port=93330 --user-data-dir="' + PROFILE + '"' })
  const r = classifyOwnTree([near], lease({ pid: 9999 }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-ownership-evidence', '端口前缀不许当端口（旧实现在这里会认成自己）')
  assert.deepEqual(r.saw, [8002])
})

test('a quoted profile with a space still matches, and its neighbour still does not', () => {
  const spaced = 'C:\\Users\\test\\.dsh\\mad model\\profile'
  const good = row({ pid: 8100, cmd: '"' + EXE + '" --remote-debugging-port=9444 --user-data-dir="' + spaced + '"' })
  const byPort = classifyOwnTree([good], lease({ profile: spaced, port: 9444, pid: 9999 }))
  assert.equal(byPort.ok, true, '引号里的空格路径要能读全')
  assert.equal(byPort.via, 'port')
  const near = row({ pid: 8101, cmd: '"' + EXE + '" --remote-debugging-port=9444 --user-data-dir="' + spaced + '-2"' })
  assert.equal(classifyOwnTree([near], lease({ profile: spaced, port: 9444, pid: 9999 })).reason, 'nothing-to-kill')
})

test('an old lease with our profile but a pid that is no longer there is refused', () => {
  const rows = [row({ pid: 8200, cmd: '"' + EXE + '" --user-data-dir="' + PROFILE + '"' })] // our profile, no port
  const r = classifyOwnTree(rows, lease())
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-ownership-evidence')
  assert.deepEqual(r.saw, [8200])
})

test('a listing that failed is never read as an empty table', () => {
  const failed = classifyOwnTree({ ok: false, error: 'no-table' }, lease())
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'process-list-failed')
  assert.equal(failed.why, 'no-table')
  const killed = []
  const stop = createBrowserStopperSync({
    listProcesses: () => ({ ok: false, error: 'powershell blew up' }),
    killProcess: (pid) => killed.push(pid),
    isProcessAlive: () => true,
  })
  const r = stop({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease() })
  assert.equal(r.closed, false, '读不到进程表就不许说「已经关了」')
  assert.equal(r.reason, 'process-list-failed')
  assert.equal(r.why, 'powershell blew up')
  assert.deepEqual(killed, [], '一条都没杀')
})

test('the synchronous stopper kills only what the decision named, and re-reads to prove it', () => {
  const killed = []
  let table = [row(), stranger]
  const stop = createBrowserStopperSync({
    listProcesses: () => table,
    killProcess: (pid) => { killed.push(pid); table = table.filter((p) => p.pid !== pid) },
    isProcessAlive: () => false,
  })
  const r = stop({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease() })
  assert.deepEqual(killed, [4321], '用户自己的那台（9001）不在名单里')
  assert.equal(r.closed, true)
  assert.equal(r.via, 'kill')
  assert.equal(r.sync, true)
  assert.equal(r.tie, 'pid+time', '号码与启动时刻都对得上时先认号码；端口是次一等的判据')
})

test('a kill that only partly took is a close with the leftovers named, not a failure', () => {
  const killed = []
  let table = [row(), child()]
  const stop = createBrowserStopperSync({
    listProcesses: () => table,
    killProcess: (pid) => { killed.push(pid); if (pid === 4321) table = table.filter((p) => p.pid !== pid) },
    isProcessAlive: () => false,
  })
  const r = stop({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease() })
  assert.deepEqual(killed.sort(), [4321, 4322], '两行都试过了')
  assert.equal(r.closed, true, 'root 死了，剩下的行不再与本 lease 相连 ⇒ 关闭成立')
  assert.deepEqual(r.leftover, [4322], '剩下的 pid 是读数，不是拿它当失败')
})

test('a recycled pid is refused even when the port is ours, and nothing is killed', () => {
  const killed = []
  const stop = createBrowserStopperSync({
    listProcesses: () => [row(), stranger], // 4321 carries our port and our profile
    killProcess: (pid) => killed.push(pid),
    isProcessAlive: () => false,
  })
  const r = stop({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease({ spawnedAt: AT + 6 * 3600e3 }) })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'spawn-time-mismatch', '号码、端口、profile 全一样也不够：进程不是那一刻起来的')
  assert.deepEqual(killed, [])
})

test('the synchronous stopper refuses a stranger, a recycled pid and a tree with no profile', () => {
  const killed = []
  const mk = (table) => createBrowserStopperSync({
    listProcesses: () => table, killProcess: (pid) => killed.push(pid), isProcessAlive: () => false,
  })
  const strangerOnly = mk([stranger])({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease() })
  assert.equal(strangerOnly.closed, true, '表里没有我们的 profile ⇒ 它已经没了')
  assert.equal(strangerOnly.via, 'probe')
  assert.deepEqual(killed, [], '什么也没杀')
  const recycled = mk([row()])({ port: 0, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease({ spawnedAt: AT + 6 * 3600e3 }) })
  assert.equal(recycled.closed, false)
  assert.equal(recycled.reason, 'spawn-time-mismatch')
  assert.deepEqual(killed, [])
  const noProof = createBrowserStopperSync({ listProcesses: () => [row()], killProcess: () => {}, isProcessAlive: () => false })
  const bare = noProof({ port: 9333, pid: 4321, reason: 'dispose' })
  assert.equal(bare.closed, false)
  assert.equal(bare.reason, 'no-ownership-evidence', '没有 lease 就没有判据')
})

test('the synchronous stopper reports a tree it could not kill instead of calling it closed', () => {
  const stop = createBrowserStopperSync({
    listProcesses: () => [row()], killProcess: () => {}, isProcessAlive: () => true, // the kill does not take
  })
  const r = stop({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease() })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'pid-alive-after-close')
  assert.deepEqual(r.killed, [4321])
})

test('a live recorded pid with no tree behind it is a reading, not a close', () => {
  const stop = createBrowserStopperSync({ listProcesses: () => [], killProcess: () => {}, isProcessAlive: () => true })
  const r = stop({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'dispose', owned: lease() })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'nothing-to-kill', '号码还活着却没有我们的树：这是个读数，不能报成功')
})

test('a silent endpoint with our own live process goes to the process table, not to a guess', async () => {
  const killed = []
  let table = [row(), child(), stranger]
  const closer = createBrowserCloser({
    fetch: async () => { throw new Error('ECONNREFUSED') }, // the browser no longer answers its port
    isProcessAlive: (pid) => pid === 4321,
    listProcesses: async () => table,
    killProcess: async (pid) => { killed.push(pid); table = table.filter((p) => p.pid !== pid) },
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'startup', owned: lease() })
  assert.deepEqual(killed.sort(), [4321, 4322], '我们自己那棵树')
  assert.equal(r.closed, true)
  assert.equal(r.via, 'kill')
  assert.equal(r.verified, true)
  assert.equal(killed.indexOf(9001), -1, '用户自己的浏览器一次都不许出现在这里')
})

test('a silent endpoint where our tree is gone is a browser that is already closed', async () => {
  const closer = createBrowserCloser({
    fetch: async () => { throw new Error('ECONNREFUSED') },
    isProcessAlive: () => false,
    listProcesses: async () => [stranger],
    killProcess: async () => { throw new Error('nothing may be killed here') },
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'startup', owned: lease() })
  assert.equal(r.closed, true)
  assert.equal(r.via, 'probe', '端口静默且记录的 pid 也没了 ⇒ 已经关了')
})

test('a silent endpoint with our profile nowhere in the table is refused, and nothing is killed', async () => {
  let kills = 0
  const closer = createBrowserCloser({
    fetch: async () => { throw new Error('ECONNREFUSED') },
    isProcessAlive: (pid) => pid === 4321, // the recorded pid answers, but no row carries our profile
    listProcesses: async () => [stranger],
    killProcess: async () => { kills += 1 },
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'startup', owned: lease() })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'endpoint-silent-pid-alive', '状态才是判词')
  assert.equal(r.why, 'nothing-to-kill', '原因随行：表里没有我们的树')
  assert.equal(kills, 0)
})

// The browser that was spawned a moment ago is the case with no identity in hand yet: the probe
// that reads the instance id may not have answered. The port agreeing is not proof on its own, so
// the process table has to carry the proof before anything is closed (round 14 A).
const BROWSER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
class FakeWs {
  constructor(url) { this.url = url; this.onopen = this.onmessage = this.onclose = this.onerror = null; setTimeout(() => { if (this.onopen) this.onopen() }, 0) }
  send(payload) { FakeWs.sent.push(payload); setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: 1, result: {} }) }) }, 0) }
  close() {}
}
FakeWs.sent = []

// Answers /json/version exactly `times` times, then goes silent — the browser exiting.
// A real Response object, because the closer reads the body as a stream.
const endpointFor = (times) => {
  let left = times
  return async () => {
    if (left-- <= 0) throw new Error('ECONNREFUSED')
    return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/' + BROWSER_ID }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
}

test('a spawn whose identity is not in hand yet is still closed, once the process table proves the tree', async () => {
  FakeWs.sent = []
  const closer = createBrowserCloser({
    fetch: endpointFor(1),
    WebSocket: FakeWs,
    sleep: async () => {},
    isProcessAlive: () => false,
    listProcesses: async () => [row()],
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: '', reason: 'error', owned: lease() })
  assert.equal(r.closed, true)
  assert.equal(r.via, 'cdp', '证据够了才走优雅关闭，不是杀进程')
  assert.equal(JSON.parse(FakeWs.sent[0]).method, 'Browser.close')
})

test('the same port with no identity and no tree of ours behind it is refused, not adopted', async () => {
  FakeWs.sent = []
  const closer = createBrowserCloser({
    fetch: endpointFor(9),
    WebSocket: FakeWs,
    sleep: async () => {},
    isProcessAlive: () => false,
    listProcesses: async () => [stranger],
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: '', reason: 'error', owned: lease() })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'no-ownership-evidence')
  assert.equal(r.why, 'nothing-to-kill')
  assert.deepEqual(FakeWs.sent, [], '一台都不是我们的，连一条关闭指令都不许发')
})

test('a silent endpoint with an unreadable process table refuses instead of guessing', async () => {
  let kills = 0
  const closer = createBrowserCloser({
    fetch: async () => { throw new Error('ECONNREFUSED') },
    isProcessAlive: () => true, // the recorded pid answers
    listProcesses: async () => ({ ok: false, error: 'no-table' }),
    killProcess: async () => { kills += 1 },
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: 'uuid-1', reason: 'startup', owned: lease() })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'process-list-failed', '读不到表就是读不到表，不许当成「我们的树已经没了」')
  assert.equal(r.why, 'endpoint-silent-pid-alive')
  assert.equal(kills, 0)
})

// The identity check is the strongest evidence there is, so a mismatch is a *decision*: the port
// answers with another instance id, and neither the async closer nor the synchronous retry may
// then go ahead and kill by pid (round 16, requirement 2).
test('an instance id that is not the one we spawned is refused, and the sync retry is forbidden', async () => {
  FakeWs.sent = []
  const other = '11111111-2222-3333-4444-555555555555'
  const closer = createBrowserCloser({
    fetch: async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/' + other }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
    WebSocket: FakeWs,
    sleep: async () => {},
    isProcessAlive: () => false,
    listProcesses: async () => [row()], // even with a full table that says "ours"
  })
  const r = await closer({ port: 9333, pid: 4321, uuid: BROWSER_ID, reason: 'dispose', owned: lease() })
  assert.equal(r.closed, false)
  assert.equal(r.reason, 'not-ours')
  assert.equal(r.sawInstanceId, true)
  assert.deepEqual(FakeWs.sent, [], '身份对不上：一条关闭指令都不许发')
  assert.equal(syncFallbackAllowed(r), false, '判词是「不是我们的」，同步重试会用 taskkill /PID 杀到别人身上')
})

test('the synchronous retry is allowed only for an attempt that ran out', () => {
  // "Ran out" and "carried on": a budget that expired, a browser that ignored the close, a throw —
  // and a tree this attempt already identified (our instance id answered) that outlived the whole
  // budget. None of these says the browser belongs to someone else, and the synchronous stopper
  // proves ownership from the process table again before it kills anything.
  for (const reason of ['timeout', 'still-running', 'threw', 'pid-alive-after-close']) {
    assert.equal(syncFallbackAllowed({ closed: false, reason }), true, reason)
  }
  // Decisions, on the other hand, are never retried: retrying `not-ours` (or a missing-evidence
  // verdict) with `taskkill /PID` would land on whoever holds that pid now.
  for (const reason of ['not-ours', 'no-ownership-evidence', 'exe-mismatch', 'spawn-time-mismatch', 'spawn-time-unknown', 'process-list-failed', 'nothing-to-kill', 'bad-port', 'endpoint-silent-pid-alive', 'refused-by-browser']) {
    assert.equal(syncFallbackAllowed({ closed: false, reason }), false, reason)
  }
  assert.equal(syncFallbackAllowed({ closed: true, via: 'probe' }), false, '已经确证关闭 ⇒ 没有要重试的东西')
  assert.equal(syncFallbackAllowed(null), false)
})
