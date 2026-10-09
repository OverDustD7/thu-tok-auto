import fs from 'node:fs'
import vm from 'node:vm'

// Bundle-form build checks: entry syntax, patch declaration, packaging sanity.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

// ESM entries: importing executes the top level, which is side-effect free
// (index.js only defines constants/functions; core.js defines factory + constants).
for (const file of ['lib/index.js', 'lib/core.js']) {
  try {
    await import(`../${file}?` + Date.now())
  } catch (e) {
    throw new Error(`${file}: ${e.message}`)
  }
}

// lib/ui.js runs in the browser; compile it as a plain script without executing.
try {
  new vm.Script(fs.readFileSync('lib/ui.js', 'utf8'), { filename: 'lib/ui.js' })
} catch (e) {
  throw new Error(`lib/ui.js: ${e.message}`)
}

const patch = fs.readFileSync('cordis.patch.yml', 'utf8')
if (!patch.includes("name: 'thu-tok-auto'")) throw new Error('cordis.patch.yml missing plugin row')
if (!patch.includes('- insert:')) throw new Error('cordis.patch.yml missing insert layer')

if (pkg.name !== 'thu-tok-auto') throw new Error('package.json name mismatch')
if (pkg.main !== 'lib/index.js') throw new Error('package.json main must be lib/index.js')
if (!pkg.dsh || !pkg.dsh.bundle || pkg.dsh.bundle.patch !== './cordis.patch.yml') {
  throw new Error('package.json must declare dsh.bundle.patch = ./cordis.patch.yml')
}
if (!pkg.files || !pkg.files.includes('cordis.patch.yml')) throw new Error('cordis.patch.yml must ship in files')

const ui = fs.readFileSync('lib/ui.js', 'utf8')
if (!ui.includes('mmtok-auto-on')) throw new Error('ui.js missing auto-on (green "Auto on") style')
if (!ui.includes('/thu-tok-auto/api')) throw new Error('ui.js missing API base')
if (!ui.includes('findSettingsTrigger')) throw new Error('ui.js missing settings-trigger lookup')
if (!ui.includes('footAreaOf')) throw new Error('ui.js missing foot-area lookup')
if (!ui.includes('insertBefore(box, target.before || null)')) throw new Error('ui.js must insert the widget at the anchor it chose')
if (!ui.includes('button[aria-label="Settings"]')) throw new Error('ui.js must support an English settings trigger')
if (!ui.includes('if (!r.ok) {') || !ui.includes('error.status = r.status')) throw new Error('ui.js must surface API failures')
if (!ui.includes('window.__mmtokUiCleanup = cleanup')) throw new Error('ui.js must expose hot-unload cleanup')
if (ui.includes('position:fixed')) throw new Error('ui.js must not pin the widget to a fixed screen position')
if (ui.includes('mmtok-sep')) throw new Error('ui.js must not draw divider lines')
if (ui.includes('.mmtok-box{display:block;padding:6px 10px 6px 8px;border-bottom')) throw new Error('ui.js must not draw a bottom border on the box')

const entry = fs.readFileSync('lib/index.js', 'utf8')
if (!entry.includes("ctx.on('webserver/index-inject'")) throw new Error('index.js must use structured DSH index injection')
if (entry.includes('webServer.tapIndex(')) throw new Error('index.js must not use the served-page-only tapIndex escape hatch')
if (!entry.includes('disposers.push(() => core.dispose())')) throw new Error('index.js must dispose the core lifecycle')

// Model list must follow the site, not a frozen id that the site has retired.
const core = fs.readFileSync('lib/core.js', 'utf8')
if (core.includes('DeepSeek-V4-Flash-0731')) throw new Error('core.js must not keep the model id the site retired')
if (!core.includes('export function extractModelList')) throw new Error('core.js must parse the model list out of the site bundle')
if (!core.includes('EXCLUDED_MODEL_IDS')) throw new Error('core.js must keep the excluded-model list')
if (!core.includes('RENEWAL_HINT')) throw new Error('core.js must explain a blocked renewal path')
if (!core.includes('buildCookieHeader')) throw new Error('core.js must keep the per-URL cookie rule')
// 2026-10-04 policy: no rung of the ladder may depend on a browser still being open
// (that was the "minimize the window and leave it running" trick the user rejected), and
// the only window that may ever be closed is the one this process opened itself.
if (!core.includes('closeOwnWindow')) throw new Error('core.js must close the window it opened, and only that one')
if (!core.includes('LOGIN_WAIT_HINT')) throw new Error('core.js must tell the user the open window is being watched')
if (!core.includes('state.loginWait')) throw new Error('core.js must track a login it is waiting for')
if (core.includes('renewFromBrowser')) throw new Error('core.js must not renew from a browser that happens to be running')
if (core.includes('LOGIN_PROMPT_MIN_INTERVAL_MS')) throw new Error('core.js must not rate-limit a background login prompt it no longer sends')
if (!entry.includes('Browser.close')) throw new Error('index.js must close our own browser through its debug port')
// 2026-10-04 audit: a pid can be recycled and an image name proves nothing about ownership,
// so the plugin asks the instance itself for its DevTools identity and never kills a process.
// 2026-10-05 round 14 A narrows that rule instead of dropping it: when the port no longer
// answers and the process we recorded is still alive, the browser may be stopped —but only
// after the process table proves the tree is ours (exact private profile, our executable, and
// a tie to this lease: our debug port, or our pid whose start time still matches). Killing by
// image name stays forbidden; every kill carries a pid that this decision named.
if (entry.includes("Stop-Process -Name") || entry.includes('/IM ')) throw new Error('index.js must never kill by image name')
if (!entry.includes('classifyOwnTree')) throw new Error('index.js must decide ownership from the process table before stopping anything')
if (!entry.includes('no-ownership-evidence')) throw new Error('index.js must refuse to stop a tree it cannot prove is ours')
if (!entry.includes('exe-mismatch')) throw new Error('index.js must refuse a tree running a different executable')
if (!entry.includes('spawn-time-mismatch')) throw new Error('index.js must treat a moved start time as a recycled pid')
if (!entry.includes("'/PID'")) throw new Error('index.js must kill by pid, never by image name')
if (entry.includes('createBrowserCloser')) { /* keep the ownership check */ }
if (!entry.includes('createBrowserCloser')) throw new Error('index.js must verify ownership before closing anything')
if (core.includes('ckHeader(') || core.includes('ssoHeader(')) throw new Error('core.js must not filter cookies by host at capture time')
if (!ui.includes('LOGIN_REASON_TEXT')) throw new Error('ui.js must surface why a login window did not open')

// 2026-10-04 real run: a click that landed on a run already in flight was answered with an
// unchanged snapshot —no notice, no window, no record. A manual run must wait for the run
// it collided with (or say it is busy), and every run must leave a trace behind, because
// "the button did nothing" is exactly what could not be told apart from "the ladder is dead"
// on a real machine. The panel must also be able to name the build it is running.
if (!core.includes('MANUAL_WAIT_MS')) throw new Error('core.js must let a manual click wait for a run in flight')
if (!core.includes('writeTrace')) throw new Error('core.js must record what each run did')
if (!core.includes('lastTrace')) throw new Error('core.js must persist the last run so it survives a reload')
if (!entry.includes('readOwnVersion')) throw new Error('index.js must report which build the host actually loaded')
if (!ui.includes('点一次 Get 打开登录窗口重新登录')) throw new Error('ui.js must turn a blocked renewal into an action the user can take')
if (!ui.includes('上次点击') || !ui.includes('上次自动')) {
  throw new Error('ui.js must name a click and an Auto tick apart in the last-run facts')
}

// 2026-10-04 afternoon, real run: the click at 13:21 opened a window, the login at 13:28
// captured a token and pushed the expiry to 19:28 —and left no record at all, because the
// capture arm keeps running after runGetTok() has written its own trace. The panel went on
// showing the earlier, failed reuse as "上次点击", which is the opposite of what happened.
// A successful capture is a run too, and it has to be recorded on every way out of the arm.
if (!core.includes('captureFacts')) {
  throw new Error('core.js must let the capture arm write its own run record')
}
if (!/function stopCapture[\s\S]{0,8000}const facts = captureFacts/.test(core)) {
  throw new Error('the capture record must be written from stopCapture, so every exit records it')
}
// The probe that spent the saved session right after a login is gone (2026-10-04 audit):
// it minted a token nobody stored, and a side effect the plugin cannot vouch for is not
// worth a sentence the next real attempt already tells the truth about.
if (core.includes('SSO_FUTURE_NOTE')) {
  throw new Error('core.js must not spend the saved session just to report on the future')
}
if (/const spent = await ssoReplay\(\)/.test(core)) {
  throw new Error('no rung may be spent outside the ladder')
}

// 2026-10-04 rounds 5-6: the only browser an unattended tick may use is one of the plugin's
// own making, headless, short-lived, and asked for by a run that is actually renewing. Five
// things must stay true or the whole background policy silently inverts:
//  - headless never becomes a visible window (no `--headless` flag left out),
//  - the unattended arm can never adopt a window that is already running,
//  - a run that comes back with the same token is never called a renewal,
//  - whether to try at all is the *run's* decision, never the token clock's —gating it on
//    `RENEWAL_MARGIN_MS` is what made Auto's own hourly schedule a no-op until the last hour,
//    by which time the measured IDP session (recognised at T+45 min, dead at T+70 min after a
//    real login) is already gone (2026-10-04 audit, round 6),
//  - and a click takes that same road, with the visible window still behind it.
if (!core.includes("'--headless=new'")) {
  throw new Error('core.js must open the unattended window headless')
}
if (!core.includes('HEADLESS_TIMEOUT_MS') || !core.includes('HEADLESS_RETRY_MS')) {
  throw new Error('core.js must bound the unattended browser and space out its retries')
}
if (/function startHeadlessRenewal[\s\S]{0,900}RENEWAL_MARGIN_MS/.test(core)) {
  throw new Error('the headless arm must not gate on the token clock: a due run is the caller\'s call')
}
if (!/function startHeadlessRenewal[\s\S]{0,1600}state\.browserOpen \|\| state\.loginWait/.test(core)) {
  throw new Error('an unattended run must never take over a window that is already open')
}
if (!core.includes('HEADLESS_STALLED') || !core.includes('MANUAL_LOGIN_HINT')) {
  throw new Error('core.js must say "same token" and "a person is needed" in their own words')
}
if (!/lastSsoStep === 'fingerprint-form'[\s\S]{0,600}out\.loginOpened = attempt\.carrier === 'hidden' \? 'hidden' : 'headless'/.test(core)) {
  throw new Error('a click must take the same headless road a due run takes, with the window still behind it')
}
// The no-window carrier the real machine actually has (2026-10-04 round 10): a *normal*
// Edge with no UI on screen, holding one page the browser itself marks hidden. The three
// pieces below are what makes that real rather than a renamed headless shell —and the
// fallback to the shell stays, with its own argv, for a host that cannot offer it.
if (!core.includes("'--no-startup-window'")) {
  throw new Error('core.js must be able to run a normal Edge with no UI on screen')
}
if (!entry.includes('Target.createTarget') || !entry.includes('hidden: true, background: true')) {
  throw new Error('index.js must ask the browser for a hidden page (hidden pages are legal only in background)')
}
if (!entry.includes('Target.attachToTarget') || !entry.includes('flatten: true')) {
  throw new Error('index.js must reach the hidden page through a flattened session: /json/list does not list it')
}
if (!/function forgetOwnWindow[\s\S]{0,400}releaseHiddenCarrier\(\)/.test(core)) {
  throw new Error('giving up the window must give up the hidden page with it: the socket is its lifetime')
}
if (!core.includes('CARRIER_FALLBACK_NOTE') || !core.includes("closeOwnWindow('carrier-fallback')")) {
  throw new Error('a carrier that cannot be used must be closed and named, not assumed')
}
if (!ui.includes("'needs-manual-login'")) {
  throw new Error('ui.js must be able to show why an unattended renewal asked for a person')
}
// The wire (2026-10-04 round 6): the panel sends `{}`, an unattended run has to say
// `{"background":true}` in that one boolean, and no other body may reach the core.
if (!entry.includes('core.getTok({ background: body.background === true })')) {
  throw new Error('index.js must turn the validated flag into the only carrier a run can have')
}
if (!entry.includes("keys.some((k) => k !== 'background')")) {
  throw new Error('index.js must refuse an undeclared field instead of silently ignoring it')
}

// 2026-10-04 real run, second half: on that day a click appeared to do nothing. The
// on-disk evidence could not be reconciled with a click that reached the plugin, and the
// UI at the time dropped a click whenever `store.busy` was true. Later real-machine
// evidence showed the sidebar was covered by a fullscreen file preview while those clicks
// were "placed", so that attribution stays a hypothesis (report §14), not a finding.
// These guards remain regardless of who was right: a busy *server* may not swallow a
// click, and the button may never be disabled —it is the only door.
if (ui.includes('if (store.busy) return')) throw new Error('ui.js must not drop a click because a run is in flight')
if (/getBtn\.disabled\s*=\s*!!/.test(ui)) throw new Error('ui.js must never disable the Get button')
if (!ui.includes('getPending')) throw new Error('ui.js must de-duplicate its own request, and only its own')

// 2026-10-04 (collapsed rail): the host sidebar is ~54px collapsed and 260—80px
// expanded. At 54px the foot area gives this widget ~34px, so the row wrapped one
// control per line and the state sentence one character per line, stretching the footer
// over the buttons beneath it. The layout must follow the container the widget was
// inserted into, and it must never consult the browser viewport: a narrow window with an
// expanded sidebar still gets the full row.
if (!ui.includes('COMPACT_BOX_MAX_W')) throw new Error('ui.js must decide the collapsed layout from a named container width')
if (!ui.includes('mmtok-compact')) throw new Error('ui.js must collapse to a single status entry in a narrow container')
if (!ui.includes('.mmtok-compact .mmtok-btn,.mmtok-compact .mmtok-elapsed{display:none;}')) {
  throw new Error('ui.js must hide the row controls when the container is a collapsed rail')
}
if (!/mmtok-compact \.mmtok-state\{[^}]*clip-path/.test(ui)) {
  throw new Error('ui.js must keep the collapsed status sentence announced, not just deleted')
}
if (!ui.includes('ResizeObserver')) throw new Error('ui.js must notice a sidebar collapse without waiting for a render tick')
if (/innerWidth|outerWidth|screen\.width/.test(ui)) throw new Error('ui.js must follow its container, never the browser viewport')
if (!/mmtok-state\{[^}]*max-height/.test(ui)) {
  throw new Error('ui.js must cap the state line so a long report cannot grow the footer without bound')
}

// 2026-10-04 (new tab, widget absent): a page that had loaded lib/ui.js —script tag in
// document.scripts —showed no widget at all, in the collapsed rail and expanded, with
// nothing in the console to say why. Four silent paths were removed: a guard flag that
// outlived its widget, a 404 that deleted the panel without a word, a mount that gave up
// when the canonical anchor was missing, and a boot whose steps could throw before any
// timer existed. The widget must also be able to say why it is not on the page.
if (!ui.includes('__mmtokUiDiag')) throw new Error('ui.js must leave a readable reason on the page when the widget is absent')
if (!ui.includes('previousAlive')) throw new Error('ui.js must not let a leftover loaded-flag outlive its widget')
if (!ui.includes('diag.takeovers')) throw new Error('ui.js must take a page over again when the widget is really gone')
if (!ui.includes('mountTarget')) throw new Error('ui.js must choose its mount point from a list of anchors')
if (!ui.includes('[data-slot^="sidebar.foot"]')) throw new Error('ui.js must fall back to the sidebar foot slot')
if (!ui.includes('[class*="footerActions"]')) throw new Error('ui.js must fall back to the sidebar container')
if (!ui.includes('控件未挂载')) throw new Error('ui.js must say why it could not mount, once, in the console')
if (!ui.includes('插件接口未就绪')) throw new Error('ui.js must report a missing plugin API instead of deleting the widget')
if (/status === 404\)\s*\{\s*cleanup\(\)/.test(ui)) throw new Error('ui.js must not tear the widget down silently on a 404')
const bootAt = ui.indexOf('function boot()')
const injectAt = ui.indexOf('try { injectStyle() }', bootAt)
const lastTimerAt = bootAt < 0 || injectAt < 0 ? -1 : ui.lastIndexOf('intervalIds.push(setInterval', injectAt)
if (bootAt < 0 || injectAt < 0 || !(lastTimerAt > bootAt && lastTimerAt < injectAt)) {
  throw new Error('boot() must create its timers before running the steps that can throw')
}
// The click has to be on record apart from the scheduled tick, or the evidence of a click that
// did nothing is overwritten minutes later (report §12 item 2).
if (!core.includes('lastManualTrace')) throw new Error('core.js must keep the last click apart from the last automatic run')// The route the panel posts to must be drivable by a test as the thing that runs: 0.3.9 had
// 86 green tests and none of them ever sent this request (report §12 item 3).
if (!entry.includes('createApiHandlers')) throw new Error('index.js must expose the route table it registers')
if (!entry.includes('applyWithDeps')) throw new Error('index.js must expose an injectable apply for the production route')
if (!/handlerFor\('POST', 'get-tok', \(body\) => \{/.test(entry)) {
  throw new Error('the get-tok route must read the body itself, through the validated flag')
}

// --- the settings contract, verified against the running Host (2026-10-03) ----
// dsh-settings exposes describe()/update() (and mutate/replace); a get(ns) has
// never existed, and calling it made every run report "settings unavailable".
for (const [name, text] of [['lib/index.js', entry], ['lib/core.js', core], ['lib/ui.js', ui]]) {
  if (/settings[A-Za-z]*\s*\.\s*get\s*\(/.test(text)) {
    throw new Error(`${name} must not call the non-existent settings.get()`)
  }
}
if (!core.includes('describe()')) throw new Error('core.js must read settings through describe()')
if (!entry.includes('options.maxBytes')) throw new Error('index.js must honour a per-request answer cap')

// The site's own bundle is ~2.2 MB: the generic 1 MiB cap truncated it, the model
// list never arrived, and the route kept a stale list that failed with 模型不存—
if (!/httpGet\([^)]*8 \* 1024 \* 1024/.test(core)) throw new Error('core.js must allow a bundle-sized answer cap')

// An outage must not be told as a broken credential; a reuse is not a failed renewal.
if (!core.includes('transportOKs === 0')) throw new Error('core.js must tell "nothing reached the site" apart from a refusal')
if (!core.includes("via !== 'reuse'")) throw new Error('core.js must not judge a reuse as a failed renewal')
if (!ui.includes('网络不可达')) throw new Error('ui.js must say the network is down, not that the token is broken')

// The Auto cadence is one number, and every surface that names it must come from that
// number: the constant decides the schedule, the snapshot carries it, the widget only
// formats it, and the README describes the same value. Measured 2026-10-04: the IDP
// session a replay needs was still recognised ~45 min after a real login and already
// gone at 70 min, so an hourly plan spends most of its attempts on a dead session
// (report §20). A hardcoded label is what let the panel keep saying 01:00 after the
// schedule changed.
if (!core.includes('export const AUTO_REFRESH_MS = 20 * 60e3')) {
  throw new Error('AUTO_REFRESH_MS must be the measured 20-minute window, not an hour')
}
if (!core.includes('autoEveryMs: AUTO_REFRESH_MS')) {
  throw new Error('core.js must publish the Auto interval in the snapshot the panel reads')
}
if (!ui.includes('var everyLabel = function (ms)')) throw new Error('ui.js must format the Auto interval it is given')
if (!ui.includes('everyLabel(s.autoEveryMs)')) throw new Error('ui.js must read the Auto interval from the snapshot')
if (ui.includes('计时超过 01:00')) throw new Error('ui.js must not hardcode the Auto interval in its hover text')
const readme = fs.readFileSync('README.md', 'utf8')
if (!readme.includes('20 分钟')) throw new Error('README must state the Auto interval the code actually uses')
if (readme.includes('每满 **1 小时**')) throw new Error('README still promises the old hourly Auto interval')

// The two carrier implementations a real machine can be driven through must be reachable from
// outside the module (2026-10-04 round 10). They used to be anonymous arrows inside the deps
// literal, so the only way to "verify" them on a real Edge was to copy them into a probe —and a
// copy proves nothing about what ships. The seam is assigned, never read, by the plugin itself:
// a host that injects its own http/cdp still gets its own function (pickFn decides first).
if (!entry.includes('const carrierDefaults = { hiddenTarget: null, cdp: null, sessionRestore: null, listBrowserProfiles: null }')) {
  throw new Error('index.js must keep every shipped carrier implementation reachable as a test seam')
}
if (!entry.includes('carrierDefaults.hiddenTarget = async')) {
  throw new Error('the shipped hidden-page carrier must be reachable from outside apply()')
}
if (!entry.includes('carrierDefaults.cdp = async')) {
  throw new Error('the shipped cdp reader must be reachable from outside apply()')
}
// The third seam is the shipped session restorer (2026-10-05 round 16, requirement 1): the
// stored session has to be inside the browser before its first request to the site, and that
// work has to ship as real code a probe can drive — not as a copy living in a test.
if (!entry.includes('carrierDefaults.sessionRestore = createSessionRestorer({})')) {
  throw new Error('the shipped session restorer must be reachable from outside apply()')
}
if (!entry.includes('Network.setCookie') || !entry.includes('Page.navigate')) {
  throw new Error('the shipped session restorer must hand the cookies over CDP and then navigate')
}
if (!entry.includes("about:blank")) {
  throw new Error('the carrier must start on about:blank instead of the SSO entry it has no session for yet')
}
if (!core.includes("deps.sessionRestore ? 'about:blank' : SSO_LOGIN_URL")) {
  throw new Error('core.js must only skip the SSO entry when a restore seam is present')
}
if (!core.includes('instanceMatched: false') && !entry.includes("reason: 'not-ours', instanceMatched: false")) {
  throw new Error('a browser whose instance id is not ours must never be handed a cookie')
}
// The reason has to exist on both sides: the trace names it, the panel translates it. A name
// only one side knows is how a panel ends up saying "点击 Get 打开登录窗口" about a failure that
// was measured in detail (2026-10-05 round 16).
if (!core.includes("'session-restore-failed'")) throw new Error('core.js must name a failed hand-off')
if (!ui.includes("'session-restore-failed'")) throw new Error('ui.js must have words for a failed hand-off')
// Ownership decisions are read out of argv at argument boundaries: a profile-backup directory
// or port 93330 must never be mistaken for ours (2026-10-05 round 16, requirement 2).
for (const fn of ['argvValue(', 'normalizePathValue(', 'portValue(', 'syncFallbackAllowed(']) {
  if (!entry.includes(fn)) throw new Error('index.js must decide ownership through ' + fn + '…)')
}
if (entry.includes('indexOf(PROFILE') || entry.includes("indexOf(profile")) {
  throw new Error('ownership must not be decided by a substring search over the command line')
}
// The duplicate-click trace must be visible and must be taken back when the request ends.
if (!ui.includes('dupClick')) throw new Error('ui.js must show a swallowed second click')
if (!ui.includes('endOwnRequest')) throw new Error('ui.js must clear the duplicate-click trace with the request')
// One way into the host API, and it is the official one (2026-10-05 round 16, requirement 3).
const hostApi = fs.readFileSync('test/host-api.mjs', 'utf8')
if (/mintCookie|createHmac|readSecret|credentials\.ya?ml/i.test(hostApi)) {
  throw new Error('host-api.mjs must not be able to read a secret or mint a session cookie')
}
if (!hostApi.includes("flags.get('auth') || 'log'")) {
  throw new Error('host-api.mjs must default to the launch authorisation URL in the log')
}
if (!/export \{[^}]*carrierDefaults[^}]*\}/.test(entry)) {
  throw new Error('index.js must export the carrier seam the closure probe drives')
}
// The page reading must survive an opaque-origin page: on about:blank, reading localStorage
// throws, and a shared try/catch loses the URL along with it (seen in the 2026-10-04 closure
// probe as an empty `url` for a page that was read —the panel and the trace then lie).
if (!/var url='';try\{url=String\(location\.href/.test(entry)) {
  throw new Error('index.js must read location.href before touching localStorage, each in its own try')
}

// --- 2026-10-05 (round 13): the four things that made Auto fail on a real machine ---
// (a) The capture arm must not ask anybody for a token behind the run's back. It used to call
//     ssoReplay() —which spends a ticket at the exchange endpoint and mints a token —plus
//     mintCheck() on *every* poll, right next to a click that had just done the same thing.
//     A side effect nobody asked for is not made safe by "it does not write state" (audit of
//     2026-10-05). The ladder is the only place a rung may be spent; the arm records facts.
const ssoCallSites = core.split('await ssoReplay(').length - 1
if (ssoCallSites !== 1) {
  throw new Error(`core.js must spend the saved session in the ladder only (found ${ssoCallSites} ssoReplay call sites)`)
}
const mintCallSites = core.split('await mintCheck(').length - 1
if (mintCallSites !== 1) {
  throw new Error(`core.js must ask the mint rung from the ladder only (found ${mintCallSites} mintCheck call sites)`)
}
if (!/if \(merged > 0\) \{\s*try \{ await saveState\(\)/.test(core)) {
  throw new Error('the capture arm must persist the session it just read instead of holding it in memory until some other run happens to save')
}
// (a) The no-window shell starts on about:blank whenever the restore seam is present, so the
//     stored session is inside the browser *before* its first request to the site; a build with
//     no such seam keeps the old address rather than parking on a blank page forever
//     (2026-10-05 round 16, requirement 1).
if (!/const home = deps\.sessionRestore \? 'about:blank' : SSO_LOGIN_URL;[\s\S]{0,120}--headless=new/.test(core)) {
  throw new Error('the no-window shell must start on about:blank when a restore seam exists, and only then keep the SSO entry')
}
if (!/\bawait restoreOwnSession\(cdpPort\)/.test(core)) {
  throw new Error('the carrier must actually be handed the stored session before capture waits on it')
}
if (!core.includes("boundedClose('restore-failed')")) {
  throw new Error('a browser that could not be handed the session must be closed by that same run')
}
// (b) A browser started with --no-startup-window owns no frame target, so Chromium answers
//     Target.createTarget{hidden:true} with -32000 for as long as it lives: the native hidden
//     page cannot be the no-window carrier at all (measured 2026-10-05: 0 frame targets over
//     20 s of polling, on the production argv). The seam stays reachable for probes and
//     fixtures, but no run may take that road.
if (!core.includes('const canHidden = false')) {
  throw new Error('no run may choose the native hidden carrier: a browser without a startup window never has a frame target')
}
if (!/errors\.push\(port \+ ': ' \+ String\(\(e && e\.message\) \|\| e\)\);\s*continue;/.test(core)) {
  throw new Error('a debug port whose probe threw is not a free port: it must be recorded and skipped, not handed to a new browser (round 17 moved this into pickCarrierPort)')
}
// (c) Our own browser left over from an earlier run is closed and *proven* gone before another
//     one is spent on the same profile —never adopted, and never killed by image name.
if (!core.includes("closeOwnWindow('leftover-own')")) {
  throw new Error('a leftover browser of our own must be closed before anything else uses its profile')
}
if (core.includes("reason: 'reuse', port") || core.includes("reason: 'reuse',") || core.includes("loginReason = 'reuse'")) {
  throw new Error('an existing window may never be adopted as this run\'s carrier')
}
// (d) The DevTools identity of the browser we started has to survive a host restart, or the
//     next run can prove nothing about the browser still holding the profile (measured: a
//     process restart dropped it, and the leftover could then never be closed again).
if (!core.includes('browserUuid: String(state.browserUuid')) {
  throw new Error('the persisted state must carry the DevTools identity of our own browser')
}
if (!/payload\.browserUuid, payload\.browserPort, payload\.browserPid, payload\.browserMine/.test(core)) {
  throw new Error('that identity must be part of the "did anything change" stamp, or it is never written')
}
if (!core.includes('state.browserMine = true')) {
  throw new Error('the identity —not the unpersisted mine flag —is what proves a leftover is ours to close')
}
// (e) A run that could not even start a carrier says so in its own record: `opened:'none'`
//     beside an unmoved expiry is the exact shape that made a failed background run look like
//     a successful reuse (2026-10-05 audit).
if (!core.includes('CARRIER_FAIL_REASONS')) {
  throw new Error('core.js must name a carrier failure in the run record instead of leaving it as "nothing happened"')
}
if (!/else if \(CARRIER_FAIL_REASONS\[String\(started\.reason\)\]\) out\.loginOpened/.test(core)) {
  throw new Error('the unattended arm must record which carrier it could not start')
}
// (f) A gate that stops the no-window renewal before a carrier is even tried must say so too:
//     `no-evidence` (the ladder never showed the device page) and `backoff` (last failure is
//     still being waited out) used to return silently, so a tick that did nothing looked exactly
//     like a tick that had nothing to do (2026-10-05).
for (const gate of ["'no-evidence'", "'backoff'", "'busy'"]) {
  if (!core.includes(gate)) {
    throw new Error(`the ${gate} gate must exist: a run that could not start a carrier has to be readable`)
  }
}
const noGoCallSites = core.split('headlessNoGo(').length - 1
if (noGoCallSites !== 2) {
  throw new Error(`both silent gates must record themselves through headlessNoGo (found ${noGoCallSites} calls: no-evidence and backoff)`)
}
if (!/if \(!state\.err\) state\.err = String\(text\)/.test(core)) {
  throw new Error('a gate must not push its own sentence over a better one the ladder already wrote')
}

// (g) 第十七轮（2026-10-05）：别的浏览器占着调试端口，是"换一条端口"的理由，不是"让用户先去
//     手动关一台浏览器"的理由。四件事必须同时成立：端口选择是一次有界的单趟扫描、自有实例按
//     身份认领、陌生实例一个字节都不读也不关、本次载体能拿到一份只属于它的临时 profile。
for (const needle of ['pickCarrierPort', 'carrierPortNote', 'isolatedProfilePath', 'pruneIsolatedProfiles', 'cleanupCarrierProfile']) {
  if (!core.includes(needle)) throw new Error(`core.js missing ${needle} (round 17 port fallback)`)
}
if (!core.includes("reason: 'no-debug-port'") || !core.includes('probes: probes')) {
  throw new Error('the port scan must be one bounded pass and report how many ports it probed')
}
if (!/state\.err = '调试端口 ' \+ CDP_PORT_START \+ '-' \+ CDP_PORT_END \+ ' 均被占用' \+ whose \+ broken;/.test(core)) {
  throw new Error('the bounded-exhaustion reading must name the whole range and say which part was a stranger and which probe broke')
}
if (!/portLeftover/.test(core)) {
  throw new Error('a leftover we could not close must keep its identity on disk, or it can never be closed')
}
// 那句话可以留在注释里（它是这一轮的历史），但绝不许再出现在任何字符串里：用户看得见的每一个字
// 都不许是"先去关一台别人的浏览器"。
for (const [name, text] of [['core.js', core], ['ui.js', ui]]) {
  for (const line of text.split('\n')) {
    if (line.indexOf('先手动关掉') === -1) continue
    if (line.trim().indexOf('//') !== 0) {
      throw new Error(`${name} must not carry the dead end "close that browser manually first" in anything the user can read`)
    }
  }
}
if (!core.includes('releaseEntryGateNow')) {
  throw new Error('the entry gate must be released (busy is what serialises the rest), or two clicks start two carriers')
}
if (!entry.includes('listBrowserProfiles')) {
  throw new Error('index.js must expose the process-table reader used to find profile holders')
}
if (!entry.includes('createProfileLister')) {
  throw new Error('index.js must build the profile lister (normalizePath + argv boundary) rather than substring matching')
}
for (const file of ['lib/carrier-profile.js']) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes('run-')) throw new Error(`${file} must build one-run profile names with the run- prefix`)
  if (!text.includes('isIsolatedProfile')) throw new Error(`${file} must be able to tell a one-run profile from the shared one`)
}
if (!fs.readFileSync('test/host-api.mjs', 'utf8').includes("flags.get('auth') || 'log'")) {
  throw new Error('host-api.mjs must default to the launch-log token (no cookie minting)')
}

// (h) 第十八轮（2026-10-05）：生产上那两处让自然 Auto 死在握手之前的东西。
//     ① 宿主给的 timer 只有 interval 与 timeout，**没有 sleep**：等身份必须经过 slept()，
//        而 slept() 首先得用宿主真有的那个方法（真机读数就是 `deps.timer.sleep is not a
//        function`）；
//     ② 读的那一步必须先认身份、再谈页面 —— 冷启动那台停在 about:blank 上等会话交进来，
//        「挑不到站点目标」从来不是「端口上没有浏览器」。
const sleepCalls = core.split('deps.timer.sleep(').length - 1
if (sleepCalls !== 1) {
  throw new Error(`core.js may reach for deps.timer.sleep only inside slept() itself (found ${sleepCalls} call sites)`)
}
if (!core.includes("typeof deps.timer.timeout === 'function'")) {
  throw new Error('slept() must wait with the timer the host really offers (interval/timeout, no sleep)')
}
if (!core.includes('await slept(gap)')) {
  throw new Error('learning the identity of a browser we just started must wait through slept(), not the raw host timer')
}
if (!core.includes('uuid: state.browserUuid,')) {
  throw new Error('every read must state which instance it is supposed to be talking to')
}
for (const needle of ['export async function readInstance(', 'async function waitForInstance(', "reason: 'no-instance-id'"]) {
  if (!entry.includes(needle)) throw new Error(`index.js missing ${needle}（round 18：先认身份，再读页面）`)
}
if (entry.includes('async function browserIdentity(')) {
  throw new Error('the reader must ask /json/version through readInstance, which can tell "nothing is there" from "it cannot name itself"')
}
// 三拍都在**读的那一个函数里**量：`/json/list` 还有另一处（会话交接在认过身份之后找 about:blank
// 那一页），拿全文件的位置比会指错地方。
const readerStart = entry.indexOf('carrierDefaults.cdp = async')
const probeReturn = entry.indexOf('if (arg.probeOnly) return', readerStart)
const notOurs = entry.indexOf("reason: 'not-ours', browserId: seen.id", readerStart)
const listFetch = entry.indexOf("'/json/list'", readerStart)
if (probeReturn === -1 || notOurs === -1 || listFetch === -1) {
  throw new Error('index.js must keep the three beats of the reader: name the port, state the expectation, then ask for pages')
}
if (!(probeReturn < listFetch) || !(notOurs < listFetch)) {
  throw new Error('identity must be proven before the page list is asked for (a cold browser only has about:blank)')
}
// 第十八轮审计（2026-10-05）：这道闸不许有例外。没说自己是谁的页面读要**具名**拒绝，而且是在发
// 出任何请求之前（此前 `uuid: ''` 会直接落到 /json/list）；身份没答上来的读同样拒读 —— 一个答得
// 出来的页面清单不是身份。`probeOnly` 是唯一允许不抱预期去问的调用者，而它从不读页面。
const expectedLine = entry.indexOf('const expected = isInstanceId(want) ? want : (isInstanceId(heldId) ? heldId : \'\')', readerStart)
const gateLine = entry.indexOf("if (!arg.probeOnly && !expected) {", readerStart)
const ownershipRefusal = entry.indexOf("reason: 'no-ownership-evidence', browserId: ''", readerStart)
const waitLine = entry.indexOf('const seen = await waitForInstance(', readerStart)
if (expectedLine === -1 || gateLine === -1 || ownershipRefusal === -1) {
  throw new Error('a page read must name the one identity it accepts, and refuse by name when it has none')
}
if (!(expectedLine < gateLine && gateLine < ownershipRefusal && ownershipRefusal < waitLine)) {
  throw new Error('the refusal must come before the endpoint is asked, let alone the page list')
}
if (!(ownershipRefusal < listFetch)) {
  throw new Error('a read with no identity of its own may never reach /json/list')
}
if (!entry.includes('if (!seen.ok) return cannotIdentify')) {
  throw new Error('an unanswered identity question must refuse the read, with or without a stated expectation')
}
if (!entry.includes('if (expected && seen.id !== expected)')) {
  throw new Error('the live instance id must equal the expectation before any page is touched')
}
if (!entry.includes('const isInstanceId = function (value)')) {
  throw new Error('one shape rule decides what counts as a browser instance identity')
}
if (!entry.includes('if (!isInstanceId(want)) return Object.assign(base, { reason: \'no-identity\' })')) {
  throw new Error('the session restore and the reader must agree on what an identity is')
}
if (!entry.includes('if (!target) target = blankPage || firstPage')) {
  throw new Error('a page target that scored 0 (about:blank on a cold start) must still be readable once the identity is known')
}
// 真机上量到的那一条：新 profile 的 Edge 自己开 `edge://sync-confirmation-dialog/` 且排在最前面。
// 浏览器内部页不是页面，读它等于把浏览器的界面当成站点。
if (!entry.includes('const readable = (u) => {')) {
  throw new Error('only a page this plugin could read (about:blank or http/https) may be chosen as the target')
}
if (!entry.includes('if (!readable(p.url)) continue')) {
  throw new Error('the page list must skip browser-internal targets (edge://, chrome://, extension pages)')
}
if (!entry.includes('if (!blankPage && isBlank(p.url)) blankPage = p')) {
  throw new Error('the blank page the session restore is about to navigate must win over whichever page is first')
}
const suiteText = fs.readFileSync('test/plugin.test.mjs', 'utf8')
if (suiteText.includes('sleep: options.sleep')) {
  throw new Error('the runtime fixture must not invent a sleep on the host timer service: that is exactly what hid the real crash')
}
if (!suiteText.includes('timeout(fn, ms) {')) {
  throw new Error('the runtime fixture must offer the one-shot timeout the host timer really has')
}
// 假 timer 是这次真机崩溃的藏身处：宿主只给 interval / timeout，谁在假 timer 里塞一个 sleep，
// 谁就又把「deps.timer.sleep is not a function」盖回去了（不管在哪个测试文件里）。
for (const name of fs.readdirSync('test')) {
  if (!name.endsWith('.mjs')) continue
  const lines = fs.readFileSync('test/' + name, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("name === 'timer'") === -1) continue
    if (/sleep/.test(lines[i])) {
      throw new Error(`test/${name}:${i + 1} hands the fake host timer a sleep() the real host does not have`)
    }
  }
}

console.log('Bundle form checks: OK')
