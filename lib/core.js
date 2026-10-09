'use strict';
// THU Tok Auto — core business logic, dependency-injected so it stays unit-testable
// outside a running DSH host. Environment access (fs, fetch, WebSocket, processes)
// is completely abstracted away; lib/index.js wires the real implementations and
// the DSH profile services (settings, credentials, timer, webServer, connection).
//
// get-tok ladder, in order: (1) mint via /auth-login/check — the site shut anonymous issuance
// down (2026-09-29: no credentials now returns 10001 "ticket已过期或无效", so this rung normally
// misses) → (2) SSO replay with the persisted cookie jar (the only automatic renewal left, and
// the one the panel must be honest about) → (3) reuse the token in hand while the server has
// not refused it → (4) when no automatic rung could produce a token, a **manual** click opens
// the temporary login window itself and then finishes capture → validate → write → sync without
// a second click; the capture also exchanges the freshly captured SSO session for a ticket, so
// a finished login completes even before the page writes its own localStorage token.
// (2026-10-04, requirements A/B: no rung may depend on a browser that is merely still running —
// reading "some live browser" is gone — and a background tick never opens a window at all; it
// only records that a login will be needed. The two rejected extremes were: popping a window on
// every tick, and never popping one until the token was already dead.)
// On success the fresh token is written into the DSH model provider config:
//   credentials.set('MADMODEL_API_KEY', token)  +  sync llm-pi-ai.providers.*(apiKeyEnv/madmodel URL).
//
// DSH settings contract (verified against dsh-settings 2026-10-03, and the reason this plugin
// reported "settings service unavailable" for its whole life): SettingsForms exposes
// describe() → [{ ns, value, revision, … }] and update(ns, patch) — there is NO get(ns).
// update() deep-merges plain objects and replaces arrays wholesale, so writing
// { providers: { <id>: {…} } } leaves every other provider in that namespace intact, and
// providers is declared `.volatile()` by llm-pi-ai, so the write lands in the profile patch
// file and hot-reloads without a restart.

export const SITE = 'https://madmodel.cs.tsinghua.edu.cn';
// Where a carrier browser keeps its profile, and which of those directories this plugin may
// delete again. Its own module because the stop script and the process-table reader need the
// same spelling of the judgement (2026-10-05 round 17).
import { ISOLATED_PREFIX, isIsolatedProfile, isolatedProfilePath, normalizePath, sharedProfilePath } from './carrier-profile.js';
const SSO_APP = 'd736f067a6705ab942df52f958a0f23b'; // md5('DEEPSEEK'), verified against id.tsinghua.edu.cn
// The window the user is asked to log in through. Opening the site's own home
// page instead meant landing on an SPA with no login affordance in sight, which
// reads as "not a login page" (reported 2026-09-29). The SSO form carries the
// `?/authLogin` callback, so a successful login lands back on madmodel and the
// capture reads the fresh session from there.
export const SSO_LOGIN_URL = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/' + SSO_APP + '/0?/authLogin';
export const CDP_PORT_START = 9333;
export const CDP_PORT_END = 9343;
// A leftover isolated profile is only removed once it is this old, and only when no browser on
// the machine still holds it. Anything younger may still belong to a browser that a run is in
// the middle of starting (2026-10-05 round 17).
export const ISOLATED_STALE_MS = 24 * 3600e3;

/**
 * Which debug port this run may use, and what is standing on the others (2026-10-05 round 17).
 *
 * The decision the old inline loop could not make: a browser that is *not* ours is a reason to
 * move on, not a reason to fail. It used to return `port-not-ours` and tell the user to close
 * a browser this plugin has no business touching — a dead end that the user met on the real
 * machine the moment an older version's leftover held 9333.
 *
 * The rule is one pass over the range, every port probed exactly once (the bound is the range
 * itself — there is no retry loop and no unbounded scan):
 *   - a port whose DevTools answers with one of *our* instance ids ⇒ `claim`: the caller may
 *     try to close that browser and, if that is proven, use the port;
 *   - a port that answers with anything else ⇒ a stranger: recorded, never read, never closed,
 *     and the scan goes on;
 *   - a port that does not answer ⇒ `port`: the first one this run may start a browser on
 *     (nothing is probed after it — a click must not spend twelve seconds proving that ports
 *     above the free one are busy).
 * `errors` keeps the text of probes that threw, because "the probe failed" and "a browser is
 * there" are different readings and the visible line has to be able to say which happened.
 */
export async function pickCarrierPort(opts) {
  const start = Number(opts && opts.start) || 0;
  const end = Number(opts && opts.end) || 0;
  const probe = opts && opts.probe;
  const ours = (opts && opts.ours) || [];
  const skip = (opts && opts.skip) || [];
  const strangers = [];
  const errors = [];
  if (typeof probe !== 'function') return { ok: false, reason: 'no-probe', port: 0, claim: null, strangers: strangers, errors: errors, probes: 0 };
  let probes = 0;
  for (let port = start; port <= end; port++) {
    if (skip.indexOf(port) !== -1) continue;
    probes += 1;
    let seen = null;
    try {
      seen = await probe(port);
    } catch (e) {
      errors.push(port + ': ' + String((e && e.message) || e));
      continue;
    }
    if (seen && seen.ok) {
      const id = String(seen.browserId || '').toLowerCase();
      if (id && ours.indexOf(id) !== -1) {
        return { ok: true, port: 0, claim: { port: port, id: id }, strangers: strangers, errors: errors, probes: probes };
      }
      strangers.push({ port: port, id: id });
      continue;
    }
    if (!seen || !seen.running) {
      // Nothing is listening: this is the port. Everything above it stays unprobed.
      return { ok: true, port: port, claim: null, strangers: strangers, errors: errors, probes: probes };
    }
    // It answered, but as something this plugin cannot identify (`no-target`, or an id we never
    // issued). Occupied is occupied — the next run may not put a browser next to a stranger.
    strangers.push({ port: port, id: '' });
  }
  return { ok: false, reason: 'no-debug-port', port: 0, claim: null, strangers: strangers, errors: errors, probes: probes };
}

/**
 * One sentence describing what this run had to route around, for the panel, state.json and the
 * trace (2026-10-05 round 17). It is a reading, never an instruction: the whole point of the round
 * is that another browser on the debug ports is something to work around, not something to ask the
 * user to go and close. Returns '' when nothing was in the way.
 */
export function carrierPortNote(info) {
  const seen = (info && info.strangers) || [];
  const first = seen[0] || null;
  const claimPort = info && info.claim ? info.claim.port : 0;
  const claimId = (info && info.claim && info.claim.id) || '';
  if (info && info.claimWhy) {
    return '本插件上次留下的浏览器（端口 ' + claimPort + '，身份 ' + (claimId || '读不出') + '）没能确证关闭（' + info.claimWhy + '）：本次改用端口 ' + info.used + ' 与独立临时 profile，没有读它；之后仍可用停止脚本再关它';
  }
  if (first) {
    const whose = first.id ? '身份 ' + first.id : '身份读不出';
    const more = seen.length > 1 ? '（共 ' + seen.length + ' 个端口）' : '';
    return '调试端口 ' + first.port + ' 上有别的浏览器（' + whose + '）' + more + '：本次改用端口 ' + info.used + ' 与独立临时 profile，没有读也没有动它';
  }
  if (info && info.isolateWhy === 'shared-profile-held') {
    return '共享 profile 已被另一台浏览器占着：本次改用端口 ' + info.used + ' 与独立临时 profile（不影响那一台）';
  }
  if (info && info.claim && info.used === claimPort) {
    return '端口 ' + claimPort + ' 上本插件上次留下的自有浏览器已确证关闭，本次沿用它';
  }
  return '';
}

export const CRED_REF = 'MADMODEL_API_KEY';
export const PROVIDER_NAME = 'DeepSeek (THU)';
export const PROVIDER_KEY = 'madmodel';
export const PROVIDER_BASE = 'https://madmodel.cs.tsinghua.edu.cn/v1';
export const TOKEN_LIFETIME_MS = 6 * 3600e3; // empirically exp-iat == 6h on check-issued JWTs (site guide says 5h for login-issued)
// Auto re-issues on a flat interval instead of aiming at the token's assumed
// expiry. The 6h lifetime is a decoded JWT property rather than a promise, and the
// mint service stamps its clock ~10min ahead of this machine, so any "renew N
// minutes before expiry" scheme sits on estimates. Re-issuing costs nothing, which
// makes a plain interval the sturdier choice.
// The interval itself is set by a *measured* limit, not by the JWT: the IDP session
// the replay needs does not live as long as the token does. Measured 2026-10-04 on
// this machine: right after a real capture the SSO entry still answered the 917 B
// device page, and 70.2 min later the same entry answered the login form — i.e. the
// saved session was still recognised somewhere under ~45 min and already gone at 70.
// An hourly plan therefore spends most of its attempts on a session that may be dead.
// 20 minutes sits inside that window with margin, so a run that is due can still use
// the session while the site still accepts it. Two limits stay untouched by this
// number: the token's own 6h life (RENEWAL_MARGIN_MS guards its tail) and the honest
// ending — if the session really is gone, no cadence helps and the panel asks for a
// person instead of pretending.
export const AUTO_REFRESH_MS = 20 * 60e3;
export const AUTO_RETRY_MS = 5 * 60e3;
export const CAPTURE_INTERVAL_MS = 2500;
export const CAPTURE_TIMEOUT_MS = 20 * 60e3;
// A background renewal may use a browser of this plugin's own making, but only a
// short-lived headless one, and only when the SSO chain has just proved that the device
// page (not a dead session) is what a cookie-only walk cannot pass. That page runs its
// own JavaScript, so it either finishes by itself inside this bound or the attempt is
// called off: no visible window may appear for an unattended tick (2026-10-04, round 5).
export const HEADLESS_TIMEOUT_MS = 60e3;
// How long a caller waits for a close before giving up on it. Every step inside the closer has
// its own smaller ceiling (probe 1.2 s, RPC reply 3 s, settle 5 s, one process-table read), so
// this is the outer belt that keeps a hung close from holding a run — or a shutdown — open.
// Giving up is not the same as "closed": the verdict is `timeout`, the lease stays on disk,
// and the panel says the window could not be confirmed closed (2026-10-05 round 14 A).
export const CLOSE_BUDGET_MS = 15e3;
// One headless attempt per half hour after any failure. A device page that would not
// accept the stored profile does not start accepting it five minutes later, and Auto's
// five-minute floor exists for the token, not for stacking browsers.
export const HEADLESS_RETRY_MS = 30 * 60e3;
// The usable context is the smaller of two measured caps (both re-measured 2026-10-01):
//   - the deployment itself: 1,048,576 prompt tokens passed and the next step up was
//     refused ("服务器繁忙"), i.e. the model runs max-model-len = 1 MiB tokens;
//   - the gateway in front of it: 8,388,608 request bytes pass, 8,388,609 get 413
//     (nginx `client_max_body_size 8m`), which is ~1.34M tokens of English text — so
//     the model, not the gateway, is the binding constraint now.
// 1,000,000 leaves ~48k tokens of headroom for the system prompt and tool definitions
// that ride along on every request. (The previous 150,000 came from the 1 MiB body cap
// the gateway had until 2026-10, when anything larger was refused outright.)
const CONTEXT_WINDOW = 1000000;
// Models whose image input is confirmed by an actual request, which can differ
// from what the site's own model list claims (it marks DeepSeek-V4.1-Flash as
// text-only, yet it read a test image and named its colour correctly).
const IMAGE_CONFIRMED = ['DeepSeek-V4.1-Flash'];
// Shown when neither mint nor SSO can produce a new token — e.g. the site closed
// the anonymous mint endpoint and the saved SSO session expired, so the user has
// to log in once more (see runGetTok).
const RENEWAL_HINT = '免登录签发与 SSO 续期均不可用，请重新登录';
// Same situation, but the token in hand still works: worth a note, never a modal.
const RENEWAL_NOTE = '免登录签发已关闭、SSO 会话已过期：当前令牌仍可用，到期后需重新登录一次';
// The real blocker measured on 2026-10-04 with a freshly captured session: the IDP does
// recognise the session (it no longer answers the login form), but it answers the entry
// with a self-submitting double-auth form whose hidden fields are a browser-computed
// device fingerprint (fingerprintjs2) plus material the site keeps in localStorage. A
// cookie-only walk can never fill that in, so "SSO 会话已过期" would be a false story —
// and "renewal failed" hides that a real browser finishes it without a password.
const FINGERPRINT_HINT = 'SSO 会话已识别，但续期需要浏览器完成设备指纹校验（后台拿不到票）：点一次 Get 打开登录窗口即可';
const RENEWAL_FP_NOTE = '免登录签发已关闭、SSO 续期需要浏览器做设备指纹校验：当前令牌仍可用，到期后点一次 Get 打开登录窗口即可';
// The renewal ran, but handed back the very same token: a session-bound token keeps
// its original expiry until a real login issues a new one, so nothing was extended.
const RENEWAL_STALLED = '拿到的是同一张令牌：到期时间未前进，到期后需要重新登录';
// The background browser did pass the device page, but the token that came back still
// carries the old expiry: nothing was extended, so nothing may look renewed.
const HEADLESS_STALLED = '后台浏览器已走完设备校验，但拿到的仍是同一张令牌（到期时间未前进）';
// Every rung failed because nothing could reach the site at all. That is a network
// fault, not a dead session, and reporting it as "续期通道不可用" sent the user
// looking for a login problem they did not have.
const OFFLINE_HINT = '网络不可达：连不上 madmodel 站点，稍后自动重试';
// The server answered and refused this very token (HTTP 200 with success !== true, or
// 401/403). Distinct from the offline case above and from "could not ask" below: three
// answers, three meanings (2026-10-04 review, risk 1 — collapsing them is how an
// outage came to be reported as "服务端不接受该令牌").
const REFUSED_HINT = '服务端不接受该令牌（auth-login 校验未通过），需要重新登录';
// Nothing reached the site, or the answer was not the JSON this endpoint returns: the
// token is unverified, which is not the same as rejected.
const UNVERIFIED_HINT = '本次未能向服务端校验该令牌（答复异常），判定未知';
// The window is open and being watched; the rest of the chain runs on its own.
const LOGIN_WAIT_HINT = '登录窗口已打开：完成登录后会自动获取并写入，无需再点 Get';
// The SSO answer was a real password form: the session is gone, and a background browser
// can never finish that. Saying "续期失败" would hide the one action that helps.
const MANUAL_LOGIN_HINT = 'SSO 会话已失效（服务端给出登录表单），后台不能代替登录：点一次 Get 打开登录窗口';
// A background renewal is running in a browser of this plugin's own making, with no
// window on screen; it is bounded by HEADLESS_TIMEOUT_MS and closed on every exit.
const HEADLESS_HINT = '正在用本插件自己的后台浏览器免密续期（无窗口，最多 1 分钟）…';
// 无窗口载体（2026-10-04 第十轮）：正常 Edge 起一个屏幕上没有窗口的进程，再用原生 hidden 页面
// （随创建它的那条浏览器级连接生灭）跑设备指纹页。本机实测：UA 无 HeadlessChrome 标记、三个
// 采样点可见窗口均为 0、隐藏页 0×0 视口且拿不到 WebGL（report §23）。回退载体是旧的
// --headless=new 壳：两条路都没有窗口，但引擎身份不同，所以面板与 trace 必须说清跑的是哪一条。
const HIDDEN_HINT = '正在用本插件自己的无窗口浏览器免密续期（正常 Edge 引擎，屏幕上没有窗口，最多 1 分钟）…';
const CARRIER_FALLBACK_NOTE = '原生隐藏页载体不可用，本轮改用内置无头载体（同样没有窗口）';
const CARRIER_GONE_NOTE = '无窗口载体的隐藏页连接已断开，本轮免密续期中止';
// 回退只有在**上一台确实被关掉**之后才允许发生（2026-10-04 第十二轮真机）：同一个
// --user-data-dir 上再 spawn 一台，会被仍活着的旧实例接管——探针实测 launcher 自己
// exitCode 0 退出、端口继续答旧实例的 uuid，第二个载体根本没诞生，随后 browserId 变化被读成
// 'gone'。所以拿不出 owned 证据时宁可不起来，也不假装配好了。
const CARRIER_STUCK_NOTE = '上一台自有浏览器没能确认关闭，不在同一个 profile 上再起一台';
const CARRIER_TAKEOVER_NOTE = '新实例的身份与旧实例相同——端口仍被旧实例占着，本轮不再读它的页面';
// 句子里的主语必须与真正跑着的载体一致（2026-10-04 第十轮）：点击跑在无窗口载体上不能叫
// 「后台」，后台跑在隐藏页上也不能叫「登录窗口」。既有可见窗口的三句话一字不改——面板与测试
// 都按它们读。`reason` 是 stopCapture 的结束原因。
const carrierEndSentence = function (reason, bg, carrier) {
  if (carrier !== 'hidden' && carrier !== 'headless') {
    return reason === 'timeout' ? '登录等待超时（未检测到登录）'
      : reason === 'error' ? '登录窗口处理失败'
        : '登录窗口已关闭（未检测到登录）';
  }
  const who = (bg ? '后台' : '点击后的') + (carrier === 'hidden' ? '无窗口续期' : '免密续期');
  const noWindow = (!bg && carrier === 'headless') ? '（没有窗口）' : '';
  if (reason === 'timeout') return who + '未在 1 分钟内完成' + noWindow;
  if (reason === 'error') return who + '处理失败' + noWindow;
  if (reason === 'carrier-gone') return carrier === 'hidden' ? CARRIER_GONE_NOTE : who + '处理失败' + noWindow;
  return carrier === 'hidden' ? '无窗口载体的隐藏页已消失' : who + '窗口已关闭' + noWindow;
};
// The click was answered, the ladder was dead, and the one door left would not open.
// Silence here is what made a real 2026-10-04 click look like "nothing happened": the
// reason existed, but only inside the JSON answer, while the panel kept repeating
// "请重新登录" with nothing to click.
const LOGIN_FAIL_TEXT = {
  'no-browser': '机器上没有找到 Edge/Chrome',
  'no-debug-port': '调试端口 9333-9343 都被别的浏览器占着（本插件不读也不动它们），等其中一个退出后重试',
  'spawn-failed': '浏览器进程启动失败',
  'carrier-blocked': '无窗口载体没起来，而上一台自有浏览器没能确认关闭——同一个 profile 上不能再起一台',
  'port-not-ours': '调试端口上答的是别的浏览器（不是本插件启动的那一台），本插件没有读它',
  'session-restore-failed': '无窗口载体没拿到已保存的会话（Cookie 没被接受，或白页没能打开）',
  error: '启动登录窗口时出错',
};
// 到 2026-10-05 第十七轮为止，**没有一个原因是"再点一次也不会变"**：端口上有别人的浏览器时，插件
// 会记下读数、换一条空闲端口、用本次自己的隔离 profile 继续；上一台自有浏览器关不掉时也一样
// （旧的 `port-not-ours` 死路就是在这里消失的：那条路让用户在"先手动关掉那台浏览器再点 Get"前面
// 站着，而 9334 明明空着）。这张表留着，是因为将来真出现"重试解决不了"的原因时，它必须只是
// 一句读数上的差别，而不是把用户推进死路。
const LOGIN_FAIL_NO_RETRY = {};
// 载体类失败（不是会话类失败）：这些原因进面板时按它本来的名字记，绝不写成
// 「需要手动登录」。会话是不是真的需要人工登录，只能由 lastSsoStep === 'login-form' 说
// （2026-10-05：真机面板对着一台关不掉的自有浏览器说"需要手动登录"，而同一时刻的逐跳
// 测量证明 IDP 仍认得保存的会话）。
// 后三条不是"载体失败"，是**连载体都没试**的三道闸门（no-evidence / busy / backoff）。
// 它们的名字同样必须进 trace 的 opened 字段：真机 2026-10-05 凌晨的 Auto 停了两个多小时，
// 盘上只有 opened:'none' 配一个没动的 exp —— 退避、占用、还是梯子没给依据，读不出来，
// 于是"Auto 为什么不动"变成只能猜的问题（KNOWN_ISSUES §10.55）。
const CARRIER_FAIL_REASONS = {
  'carrier-blocked': true, 'port-not-ours': true, 'no-debug-port': true, 'no-browser': true, error: true,
  'no-evidence': true, busy: true, backoff: true,
  // 载体起来了、却没能把已保存的会话交进去（2026-10-05 第十六轮）：这仍是载体类失败，不是
  // 会话过期。名字要留在 trace 的 opened 上，否则后台那一轮又变成 opened:'none' 配一个没动的
  // exp —— 正是第十二轮读不出「Auto 为什么不动」的形状。
  'session-restore-failed': true,
};
// detail（可选）用来把读数带进面板：'port-not-ours' 必须说出是 9333-9343 里的哪一个端口、
// 那台的身份读出来了没有。只说「端口上有浏览器」而藏起端口号，用户没法照着处理
// （2026-10-04 第十二轮夹具：断言 /9333/ 时暴露）。openLogin 自己写下整句时用那一句。
const loginFailHint = function (reason, detail) {
  const r = String(reason || 'unknown');
  let text = LOGIN_FAIL_TEXT[r] || ('原因 ' + r);
  if (detail) text = String(detail) + '：' + text;
  if (LOGIN_FAIL_NO_RETRY[r]) return '登录窗口未能打开：' + text + '（重试不会变，先按提示里的读数处理）';
  return '登录窗口未能打开：' + text + '，可再点一次 Get 重试';
};
// A click that lands while a run is already in flight waits for it and then does its own
// work, in the same click. The real 2026-10-04 run showed why: an Auto tick and a click
// can land in the same second, and the old code answered the click with an unchanged
// snapshot — no window, no notice, no trace, indistinguishable from a broken button.
// Bounded, so a wedged run can never hang the request: a background tick never waits.
export const MANUAL_WAIT_MS = 20e3;
const MANUAL_POLL_MS = 200;
// A close that could not be proven did not happen as far as the panel is concerned: the
// window may still be on screen, so the user is told to close it (2026-10-04 audit,
// defects 1 and 2 — a refused close is never reported as a success).
const CLOSE_UNCONFIRMED_NOTE = '临时窗口未能确认关闭，请手动关闭该窗口';
// The store already held a working token and the candidate could not be vouched for, so
// nothing was written (2026-10-04 audit, item 4).
const KEPT_STORED_NOTE = '已保留原凭据，未写入未经校验的新令牌';
// A capture that finished but whose record never reached the disk: the panel would keep
// showing the run before it, so the visible line says which record is missing (2026-10-04
// real-machine audit — the write lost a rename race with the capture's own save).
const TRACE_NOT_STORED_NOTE = '本次记录未能写入磁盘（「上次点击」可能仍显示更早的一次）';
// A state file that could not be written at all: the token and its expiry live only in
// memory, so the next host restart rolls the panel back to whatever the disk still holds.
// "凭据已写入" is a claim about the credential store; this note is about the state file, and
// saying it out loud is what keeps the two from being read as the same success
// (2026-10-04 round 9, requirement G).
const STATE_NOT_STORED_NOTE = '状态文件未能写入（令牌与到期时间只在内存里，宿主重启后会回退）';
// The click's own no-window attempt could not finish on its own, so the very same request
// opened the visible window for it. Without this the panel would show a login window and a
// "续期未完成" failure at once — or, worse, leave the click unspent with no door at all
// (2026-10-04 round 9, requirement A).
const ESCALATED_HINT = '免密续期没能在后台完成，已为你打开登录窗口：请登录一次，无需再点 Get';
// The same ending, said about the carrier that really ran. A click is not 「后台」, and the
// native hidden page is not the built-in headless shell: naming the engine is the difference
// between a panel that describes the run and one that reuses a sentence (2026-10-04 round 10).
const ESCALATED_HIDDEN_HINT = '免密续期没能在无窗口模式下完成，已为你打开登录窗口：请登录一次，无需再点 Get';
// The no-window browser really did stop on the device-confirmation page: that step needs the
// person's own device, so the panel says which step it was instead of only "1 分钟没完成".
// It says 「无窗口浏览器」 rather than 「后台浏览器」 because a click's own no-window attempt can
// land here too (2026-10-04 round 9 requirement D, round 10).
const DEVICE_PAGE_NOTE = '该无窗口浏览器停在设备确认页：这一步需要本人在设备上确认，后台不能代替';
// When the token is this close to dying and no automatic path can replace it, the
// automatic ladder retries on a fixed floor (AUTO_RETRY_MS) instead of the exponential
// backoff, so a bad streak cannot walk the next attempt far past the cliff. That floor is
// a mitigation, not a guarantee: with less than five minutes of life left, a retry can
// still land after the token has already died — and then the panel says expired /
// needs-login instead of pretending a renewal happened (2026-10-04 audit, item 6).
// Opening a window is reserved for an explicit click (2026-10-04, requirement B): a
// background tick records the need and stays quiet.
export const RENEWAL_MARGIN_MS = 1 * 3600e3;
// Models the site offers but this plugin deliberately does not register. Kept
// out of both the fallback profile and the live sync, so the site's own list
// can never put one back.
const EXCLUDED_MODEL_IDS = [
  'DeepSeek-V4-Flash-Vision-Exp', // V4.1-Flash already covers image input
  'DeepSeek-R1-W8A8',
];
// Fallback profile, used when the site's model list cannot be read. The live
// list is fetched from the site itself (see fetchSiteModels); this copy only
// has to keep the plugin useful while that fetch is failing.
const MODEL_PROFILE = [
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek-V4.1-Flash (THU)',
    contextWindow: CONTEXT_WINDOW,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  },
  {
    id: 'qwen3.8-27b',
    name: 'qwen3.8-27b (THU)',
    contextWindow: CONTEXT_WINDOW,
    input: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' },
  },
];
const MODEL_CACHE_MS = 6 * 3600e3;
// Every pi-ai thinking level a site-declared effort may name (see the site's
// own effortOptions; "off" is not sent, so it never appears there).
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function sliceBracket(js, start) {
  if (start < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = start; i < js.length; i++) {
    const c = js[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return js.slice(start + 1, i); }
  }
  return null;
}

function splitTopLevelObjects(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += body[++i] || ''; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{') { depth++; cur += c; continue; }
    if (c === '}') { depth--; cur += c; if (depth === 0) { out.push(cur); cur = ''; } continue; }
    if (depth > 0) cur += c;
  }
  return out;
}

function fieldString(entry, key) {
  const m = entry.match(new RegExp(key + ':"([^"]*)"'));
  return m ? m[1] : '';
}

/**
 * Read the model list out of the site's own front-end bundle.
 *
 * The site exposes no model-list API (`/v1/models` falls through to the SPA),
 * so the list the page itself uses — `modelList:[{label,value,supportImage,
 * thinkingParam,effortOptions}, …]` inside the hashed JS bundle — is the only
 * source. Parsing stays tolerant of field order and minified variable names,
 * and returns null on anything unexpected so the caller falls back to
 * MODEL_PROFILE instead of writing a half-read list.
 */
export function extractModelList(js) {
  if (typeof js !== 'string' || !js) return null;
  const at = js.indexOf('modelList:[');
  if (at < 0) return null;
  const body = sliceBracket(js, js.indexOf('[', at));
  if (!body) return null;
  const models = [];
  for (const entry of splitTopLevelObjects(body)) {
    const id = fieldString(entry, 'value');
    if (!id) continue;
    const effortField = entry.match(/effortOptions:\[([^\]]*)\]/);
    const efforts = effortField
      ? effortField[1].split(',').map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean)
      : [];
    models.push({
      id: id,
      label: fieldString(entry, 'label') || id,
      supportImage: /supportImage:!0|supportImage:true/.test(entry),
      efforts: efforts,
    });
  }
  return models.length ? models : null;
}

/** Turn the site's own list into the provider `models` shape llm-pi-ai stores. */
export function toProviderModels(siteModels) {
  if (!Array.isArray(siteModels) || !siteModels.length) return null;
  const kept = siteModels.filter(function (m) {
    return m && m.id && EXCLUDED_MODEL_IDS.indexOf(m.id) === -1;
  });
  if (!kept.length) return null;
  return kept.map(function (m) {
    const efforts = {};
    for (const e of m.efforts || []) if (THINKING_LEVELS.indexOf(e) !== -1) efforts[e] = e;
    const model = {
      id: m.id,
      name: (m.label || m.id) + ' (THU)',
      contextWindow: CONTEXT_WINDOW,
      input: (m.supportImage || IMAGE_CONFIRMED.indexOf(m.id) !== -1) ? ['text', 'image'] : ['text'],
    };
    if (Object.keys(efforts).length) model.reasoningEfforts = efforts;
    return model;
  });
}

/** Compare only the fields this plugin owns, so a live list rewrites rarely. */
function modelsEqual(a, b) {
  const norm = function (list) {
    return JSON.stringify((Array.isArray(list) ? list : []).map(function (m) {
      return {
        id: (m && m.id) || '',
        name: (m && m.name) || '',
        contextWindow: (m && m.contextWindow) || 0,
        input: (m && m.input) || [],
        reasoningEfforts: (m && m.reasoningEfforts) || {},
      };
    }));
  };
  return norm(a) === norm(b);
}

/**
 * Build a Cookie header for one URL out of a cookie jar: match by domain, path
 * and secure flag, drop expired entries, and send longer paths first (the order
 * browsers use). A pure function so these rules can be tested directly.
 */
export function buildCookieHeader(jar, target, now) {
  let u = null;
  try { u = new URL(String(target || '')); } catch (e) { return ''; }
  const host = u.hostname.toLowerCase();
  const at = typeof now === 'number' ? now : Date.now();
  return (Array.isArray(jar) ? jar : []).filter(function (c) {
    if (!c || !c.name) return false;
    const d = String(c.domain || '').toLowerCase().replace(/^\.+/, '');
    if (!d || !(host === d || host.endsWith('.' + d))) return false;
    const p = c.path || '/';
    const pathOK = u.pathname === p || (u.pathname.indexOf(p) === 0 && (p.charAt(p.length - 1) === '/' || u.pathname.charAt(p.length) === '/'));
    if (!pathOK) return false;
    if (c.secure && u.protocol !== 'https:') return false;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires * 1000 <= at) return false;
    return true;
  }).sort(function (a, b) {
    return String(b.path || '/').length - String(a.path || '/').length;
  }).map(function (c) { return c.name + '=' + c.value; }).join('; ');
}

/**
 * A token's own expiry in epoch milliseconds, decoded locally. The panel used to
 * estimate it as "last fetch + 6h", which overstates the remaining life whenever an
 * older token is read back from a live browser (measured 2026-10-01: token issued
 * 14:06, read back 16:30, panel claimed 2.4h more than it had). Returns 0 when the
 * token cannot be decoded, so callers can fall back to the old estimate.
 */
export function jwtExpiry(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return 0;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp * 1000 : 0;
  } catch (e) { return 0; }
}

export function createCore(deps) {
  const logger = deps.logger || console;
  const settingsSvc = deps.settings;
  const credSvc = deps.credentials;
  const state = {
    token: '', cookies: '', ssoCookies: '',
    lastGetAt: 0, auto: false, busy: false, status: 'idle', err: '',
    browserOpen: false, minted: false, provider: '', providerName: '', credentialWritten: false,
    // Memory-only facts about the temporary window this plugin opened (never
    // persisted): loginWait = a window of ours is open and being watched;
    // browserPort/Pid/Mine describe that one instance. browserMine is false when the
    // window was found already running — it cannot be proven to be ours, so it is
    // used but never closed (2026-10-04, requirement C).
    loginWait: false, browserPort: 0, browserPid: 0, browserMine: false,
    // The DevTools instance id of that one browser, learned from its own debug endpoint
    // at spawn time. Closing requires it: both a port and a pid can be recycled, and a
    // close aimed at whoever holds the port now would shut a window that is not ours.
    // No id ⇒ no close (2026-10-04 audit, defect 1).
    browserUuid: '',
    // The owned lease (2026-10-05 round 14, requirement A): everything a *later* process —
    // the reloaded host, the next run, the stop script — needs to close the browser this
    // plugin spawned even when its DevTools endpoint is gone. The four fields above are the
    // claim this process holds while it is watching a window; the lease is the evidence that
    // outlives the claim, so a close that could not be confirmed does not erase it. Shape:
    // { spawnId, uuid, port, pid, spawnedAt, profile, exe } — spawnId names the one spawn
    // call this lease came from, spawnedAt is when *we* started it, profile is the exact
    // --user-data-dir we passed (nobody else uses that directory) and exe is the binary we
    // launched. Nothing here is a secret: they are process and endpoint identifiers.
    owned: null,
    // Which carrier a run is on, stated even when there is none: 'window' | 'hidden' |
    // 'headless' | '' (nothing is running). Initialised here so a path that never got as far
    // as starting a carrier still *answers* `carrier: ""` instead of dropping the key from
    // the JSON snapshot — an absent field reads as "this build does not know about carriers"
    // (2026-10-04 round 12, found by the port-not-ours fixture).
    headless: false, carrier: '', carrierNote: '',
    // credentialPresent = the credential store holds this exact token (whether or
    // not this run wrote it); credentialWritten = this run actually wrote it. The
    // two differ for hours at a time, because a session-bound token comes back
    // unchanged, and health has to follow the former (a "no write needed" run is
    // not a broken run — treating it as one is what kept Auto repairing forever).
    credentialPresent: false, syncDetail: '',
    // Outcome of the last run, plus why automatic renewal is unusable. The latter
    // is persisted (see saveState) so a restart cannot turn a broken renewal path
    // back into a healthy-looking "ok", and so the sidebar can explain it.
    lastVia: '', loginReason: '', refreshBlocked: false, cookieJar: [],
    // Local facts about the token in hand: its own expiry, and whether the server
    // accepted it the last time we asked. validatedFp binds that verdict to the exact
    // token it was about — a verdict is never inherited by a different token
    // (2026-10-04 audit, item 4).
    tokenExpAt: 0, serverValid: null, lastValidatedAt: 0, validatedFp: '',
    // True when the last renewal handed back a token whose expiry did not move:
    // a session-bound token comes back identical, so "fetched" is not "renewed".
    renewalNoProgress: false,
    // The credential in the store was written without a server confirmation (答复异常),
    // so "判定未知" survives a restart instead of being rounded up to ok; and the last
    // run kept the stored credential rather than writing an unverifiable candidate.
    unverified: false, storedUnchanged: false,
    // A compact, non-sensitive record of the last run: which rung answered, what the
    // server said, whether the expiry moved, how long it took, whether the click had to
    // wait behind another run, and what became of the login window. It is persisted so a
    // real-machine run can be diagnosed after the fact without guessing, and it must
    // never hold a token, a cookie or anything that identifies the user.
    lastTrace: null,
    // The last run a *click* started, kept apart from `lastTrace` because a scheduled Auto
    // tick overwrites the latter: on 2026-10-04 the only trace on disk was the 03:57 tick,
    // so a click that did nothing could not be told from a click that never happened. The
    // two are separate objects — writing one must never mutate the other.
    lastManualTrace: null,
    // What the last no-window renewal did with the saved session, as a reading rather than a
    // claim (2026-10-05 round 16): whether the cookies of the login entry were handed back to
    // this spawn's browser, how many were accepted, and — when it did not work — the one word
    // that says where it stopped. Names only; never a cookie value.
    lastRestore: null,
    // Which port this run actually used, what was standing on the ones it did not, and whether
    // the browser it started got the shared profile or one of its own (2026-10-05 round 17).
    // Persisted because the *reason* a click opened a fresh browser is exactly what a later
    // reading needs: "another browser was on our port" is not something the panel may leave the
    // user to guess, and it is the fact that used to end in "close that browser yourself".
    portNote: '', carrierProfile: '', portStrangers: 0, carrierPort: 0, portLeftover: null,
  };
  let baseDir = '';
  let initialized = false;
  let initPromise = null;
  let captureDispose = null;
  let captureBusy = false;
  // Wall-clock, not a tick counter: the timeout and the close grace must measure the
  // time a user actually spent on the login page, even if the event loop was busy and
  // some polls were missed (2026-10-04).
  let captureStartedAt = 0;
  // The token in hand when the window opened, plus whatever was known about it: a
  // capture may only complete on a *different* token that the server vouches for, and it
  // may never replace a credential that still works with an unverified candidate
  // (2026-10-04 audit, items 4 and 5).
  let captureBaseline = '';
  let captureVerdict = null;
  let captureSawSame = false;
  // The click's own record, filled in as the capture learns facts and written once when
  // the capture ends. The ladder writes its trace inside runGetTok, but the capture arm
  // keeps running on its own interval long after that call has returned — so without this
  // a *successful* login left no trace at all, and 「上次点击」 kept showing the reuse line
  // from before the click while the credential had in fact just been renewed from the
  // window (2026-10-04 real-machine audit, P1).
  let captureFacts = null;
  // Whether the window being watched right now is a headless one of this plugin's own
  // making, and how long that capture is allowed to live: a background renewal gets a
  // minute, a person gets the full window (2026-10-04, round 5).
  let captureHeadless = false;
  let captureTimeoutMs = CAPTURE_TIMEOUT_MS;
  // Whether the carrier behind that capture was an unattended run or a click. The capture
  // finishes on its own interval long after the request that started it returned, so this
  // is the only way its record can name the carrier honestly instead of filing every
  // capture as a click (2026-10-04 real-machine audit).
  let captureBg = false;
  // Which carrier is being watched: 'hidden' (native hidden page on a normal Edge with no
  // startup window), 'headless' (the --headless=new fallback shell) or 'window' (a visible
  // window, whether a person's or a reused one). The capture arm outlives the request that
  // started it, so both its record and its closing sentence read this instead of re-deriving
  // the carrier from a flag that has since changed (2026-10-04 round 10).
  let captureCarrier = 'window';
  // A host that cannot offer the native hidden carrier is told once, not on every run: the
  // sentence is about the install, not about the attempt (2026-10-04 round 10).
  let carrierDepLogged = false;
  // The live handle of the native hidden page. Deliberately not a `state` field: a socket is
  // not a fact for the state file, whose whitelist stays free of browser bookkeeping. Its
  // lifetime *is* the page's lifetime (measured 2026-10-04 round 10: the page survives a
  // detach but dies with the connection that created it), so it is released by exactly the
  // paths that give up the window.
  let hiddenHandle = null;
  // The object a run is about to answer with. The `finally` settles it once more after the
  // run's own trace reaches the state, so the answer describes the run that just happened
  // instead of the one before it (2026-10-04 real-machine audit).
  let returnedOut = null;
  // Kept in memory on purpose: a restart is a fresh start, and the state file's explicit
  // whitelist stays free of browser bookkeeping. One failure buys half an hour of quiet.
  // Requirement A (2026-10-04 round 9): a click's no-window attempt may escalate to the one
// visible window once — and only once — inside the same request; a background run never
// escalates, because an unattended machine must not put a window on screen. The last page a
// no-window browser really reached is kept so the panel and the report can name it.
let captureEscalated = false;
let captureProbe = null;
let captureProbeLogged = false;
// "The state file could not be written" as a runtime fact, not only a string in `err`: the
// caller has to be able to tell a renewal whose record is on disk from one that is not
// (2026-10-04 round 9, requirement G).
let stateDiskFailed = false;
let headlessBackoffUntil = 0;
  let headlessFailReason = '';
  let cdpPort = CDP_PORT_START;
  let lastAutoAttemptAt = 0;
  // Consecutive unhealthy Auto runs, used only to space the retries out.
  let consecutiveFailures = 0;
  let disposed = false;
  // What the startup reap did with a browser an earlier process left behind, and nothing when
  // there was nothing to reap. A reading, not a fact about a window that exists now
  // (2026-10-05 round 14 A).
  let lastReap = null;
  // What became of the isolated profile this run's browser was given, and what the startup
  // prune did with the ones earlier runs left behind. Two readings, both about directories this
  // plugin created itself and is allowed to remove (2026-10-05 round 17).
  let lastCleanup = null;
  let lastPrune = null;
  // The gate that makes "two clicks, two browsers" impossible. `runGetTok` takes it before it
  // looks at anything else and releases it the moment the run owns `state.busy`; a second caller
  // that arrives while it is held waits here instead of reading the same stale `busy` and
  // spawning a browser of its own (2026-10-05 round 17: two clicks inside the same window both
  // passed the `state.busy` check, because the flag is only set after `ensureLoaded`).
  let entryGate = null;
  let releaseEntryGate = null;
  let entryWaiters = 0;
  // How many callers waited at the gate (a reading, not a control): a real-machine run that shows
  // two clicks arriving inside the same window is exactly what this round fixed, and the count is
  // how a later report can tell "the guard held" from "no one ever raced".
  let gateWaits = 0;
  function releaseEntryGateNow() {
    const go = releaseEntryGate;
    entryGate = null;
    releaseEntryGate = null;
    if (go) go();
  }
  function gateReading() {
    return { held: !!entryGate, waiters: entryWaiters, waits: gateWaits };
  }
  /**
   * The one spelling of "put the port reading first" (2026-10-05 round 17). Every visible line
   * that describes a carrier this run started goes through it, so "why did a second browser
   * appear on another profile" is answered on the panel instead of only in state.json. No
   * reading ⇒ the hint comes back untouched.
   */
  function withPortNote(hint) {
    const note = String(state.portNote || '');
    if (!note) return hint;
    if (!hint) return note;
    return note + '；' + hint;
  }

  const jsonParse = function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } };
  const cookieDomain = function (value) { return String(value || '').toLowerCase().replace(/^\.+/, ''); };
  // Cookies are kept whole and picked per request URL (domain + path + secure +
  // not expired), instead of being filtered by host at capture time. The SSO
  // chain spans id./oauth./auth*.tsinghua.edu.cn, and dropping the hosts this
  // plugin did not recognise is what made a captured session unreplayable.
  // A jar with no madmodel.cs.tsinghua.edu.cn entry is expected, not a fault: that
  // site authenticates with the JWT kept in localStorage, so its cookie header is
  // legitimately empty (verified 2026-10-01).
  const cookieHeaderFor = function (target) {
    return buildCookieHeader(state.cookieJar, target, deps.clock.now());
  };
  /** Merge freshly read cookies into the jar, newest value per name+domain+path. */
  const mergeCookies = function (cookies) {
    if (!Array.isArray(cookies) || !cookies.length) return 0;
    if (!Array.isArray(state.cookieJar)) state.cookieJar = [];
    let merged = 0;
    for (const c of cookies) {
      if (!c || !c.name || typeof c.value !== 'string') continue;
      const d = cookieDomain(c.domain);
      if (!d) continue;
      const entry = {
        name: c.name, value: c.value, domain: d, path: c.path || '/',
        secure: !!c.secure, expires: typeof c.expires === 'number' ? c.expires : -1,
        // httpOnly / sameSite are kept too (2026-10-05 round 16): without them a cookie that
        // goes back into a browser would come back as a script-readable, lenient one, which is
        // a weaker cookie than the site handed us. They are read from CDP in readCdpPage.
        httpOnly: !!c.httpOnly,
      };
      const same = String(c.sameSite || '');
      if (same === 'Strict' || same === 'Lax' || same === 'None') entry.sameSite = same;
      const key = d + '|' + entry.path + '|' + entry.name;
      const i = state.cookieJar.findIndex(function (x) { return cookieDomain(x.domain) + '|' + (x.path || '/') + '|' + x.name === key; });
      if (i === -1) state.cookieJar.push(entry); else state.cookieJar[i] = entry;
      merged++;
    }
    return merged;
  };
  const isMadModelUrl = function (value) {
    const m = String(value || '').match(/^https:\/\/([^\/:?#]+)(?::\d+)?(?:[\/?#]|$)/i);
    return !!(m && m[1].toLowerCase() === 'madmodel.cs.tsinghua.edu.cn');
  };
  const isSsoUrl = function (value) {
    const m = String(value || '').match(/^https:\/\/([^\/:?#]+)(?::\d+)?(?:[\/?#]|$)/i);
    if (!m) return false;
    const h = m[1].toLowerCase();
    return h === 'id.tsinghua.edu.cn' || h === 'oauth.tsinghua.edu.cn';
  };
  const resolveLocation = function (base, location) {
    try {
      const resolved = new URL(String(location || ''), String(base || ''));
      return resolved.protocol === 'https:' ? resolved.href : '';
    } catch (e) { return ''; }
  };

  function ensureBaseDir() {
    const env = deps.env || {};
    const home = env.home || env.temp || '';
    baseDir = home ? home + '\\.dsh\\madmodel' : 'C:\\Windows\\.dsh-madmodel';
  }

  // Transport accounting: "no rung produced a token" has two very different causes
  // (the site refused us, or nothing could reach the site at all) and only the
  // request layer knows which one happened. Reset per run, read at the end of the
  // ladder. maxBytes matters for the model-list fetch: the site's own bundle is
  // ~2.2 MB and the old 1 MiB cap made that read fail silently every time.
  let transportFails = 0;
  let transportOKs = 0;
  // "The last run could not reach the site at all." Transient by design: the next
  // tick re-decides, so a network blip never becomes a stored fact about the token.
  let offlineFlag = false;
  async function httpGet(url, headers, follow, maxBytes) {
    const r = await deps.http(url, {
      headers: headers || {},
      follow: follow === false ? false : true,
      timeoutMs: 25000,
      maxBytes: maxBytes,
    });
    if (!r || r.error) { transportFails++; return null; }
    transportOKs++;
    return r;
  }
  const okData = function (r) {
    if (!r || r.status !== 200 || !r.text) return null;
    const j = jsonParse(r.text);
    if (!j || j.success !== true || typeof j.data !== 'string' || !j.data) return null;
    return j.data;
  };
  /**
   * The site's verdict on one token, in three states instead of a boolean:
   *   true  — the server answered and accepted it;
   *   false — the server answered and refused it (HTTP 200 with success !== true,
   *           or an outright 401/403);
   *   null  — we could not ask: nothing reached the site, the reply was not 200, or
   *           it was not the JSON this endpoint returns.
   * The old two-state version reported an unreachable site as "服务端不接受该令牌",
   * which is a claim about the credential that nothing had established (2026-10-04
   * review, risk 1). Callers must keep `serverValid` untouched on null.
   */
  async function authVerdict(token, cookie) {
    const h = { Authorization: 'Bearer ' + token };
    const c = cookie || cookieHeaderFor(SITE + '/model-api/auth-login');
    if (c) h.Cookie = c;
    const r = await httpGet(SITE + '/model-api/auth-login', h, false);
    if (!r) return null;
    if (r.status === 401 || r.status === 403) return false;
    if (r.status !== 200 || !r.text) return null;
    const j = jsonParse(r.text);
    if (!j) return null;
    return j.success === true;
  }
  /**
   * A short, stable fingerprint of a token. It answers exactly one question — "is this
   * the same token the verdict was about?" — and is never logged, exposed or persisted.
   * Two independent 32-bit FNV-1a rounds are mixed into 16 hex characters, so a collision
   * would need two live tokens to agree in 64 bits; the worst case of one is only that a
   * stale verdict is trusted for one token. Written by hand on purpose: core.js has no
   * imports at all, and this must not be the thing that adds one (2026-10-04 audit, item 4).
   */
  const tokenFp = function (token) {
    const s = String(token || '');
    if (!s) return '';
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  };
  /**
   * Record what the server said about a token. Only a definite answer (true/false) is
   * recorded, and it is bound to the token it was given for: a later token starts out
   * unknown rather than inheriting a stale "valid" (2026-10-04 audit, item 4). A definite
   * answer also settles `unverified`, whichever way it went.
   */
  function recordVerdict(verdict, token) {
    if (verdict === true || verdict === false) {
      state.serverValid = verdict;
      state.lastValidatedAt = deps.clock.now();
      state.validatedFp = tokenFp(token);
      state.unverified = false;
    }
  }
  /**
   * The recorded verdict — but only while it still describes the token in hand. After a
   * restart, or after a different token arrives, the answer is "unknown", not "valid".
   */
  function trustedVerdict() {
    if (!state.token || state.validatedFp !== tokenFp(state.token)) return null;
    return state.serverValid === true ? true : state.serverValid === false ? false : null;
  }
  async function mintCheck() {
    return okData(await httpGet(SITE + '/model-api/auth-login/check', {}, false));
  }
  async function ssoReplay() {
    if (!cookieHeaderFor(SSO_LOGIN_URL)) return null;
    let cur = SSO_LOGIN_URL;
    let ticket = '';
    for (let hops = 0; hops < 10; hops++) {
      if (!isSsoUrl(cur) && !isMadModelUrl(cur)) return null;
      // Carry whatever applies to each hop: the chain crosses hosts, and the
      // madmodel leg needs its own cookies too (sending none there was another
      // reason a captured session failed to replay).
      const hdrs = {};
      const ch = cookieHeaderFor(cur);
      if (ch) hdrs.Cookie = ch;
      const r = await httpGet(cur, hdrs, false);
      if (!r) return null;
      if (r.status >= 300 && r.status < 400 && r.location) {
        cur = resolveLocation(cur, r.location);
        continue;
      }
      // Not a redirect, and no ticket in the URL to read: on 2026-10-04 the live IDP
      // answered exactly this — a self-submitting double-auth form whose hidden fields are
      // a browser-computed device fingerprint plus material the site keeps in
      // localStorage. Record the step so the panel can say "the session is recognised, a
      // browser has to finish it" instead of "renewal failed" (or "the session expired").
      if (r.status === 200 && typeof r.text === 'string') {
        if (r.text.indexOf('checkSingle') !== -1 && r.text.indexOf('fingerGenPrint') !== -1) {
          lastSsoStep = 'fingerprint-form';
        } else if (/<form/i.test(r.text) && /type=["']password["']/i.test(r.text)) {
          // The IDP really is asking for a password: the session is gone, and this is the
          // one page a background browser can never get past (2026-10-04, round 5).
          lastSsoStep = 'login-form';
        }
      }
      const m = String(cur).match(/[?&]ticket=([^&#]+)/);
      if (m) ticket = decodeURIComponent(m[1]);
      break;
    }
    if (!ticket) return null;
    return okData(await httpGet(SITE + '/model-api/auth-login/check?ticket=' + encodeURIComponent(ticket), {}, false));
  }
  // Which SSO step answered last when it was not a ticket ('' = nothing notable). The
  // panel's reason has to name the real blocker: the IDP's double-auth form is not an
  // expired session (2026-10-04 evidence, see FINGERPRINT_HINT).
  let lastSsoStep = '';
  /** Why the automatic renewal cannot continue, in one word the panel can print. */
  const renewalReason = function (offline) {
    if (offline) return 'offline';
    return lastSsoStep === 'fingerprint-form' ? 'fingerprint-required' : 'renewal-unavailable';
  };
  // ---- DSH settings access -------------------------------------------------
  // SettingsForms (dsh-settings) has no get(ns): reading goes through describe(),
  // which answers one descriptor per *active* namespace with the projected live
  // value, and writing goes through update(ns, patch), which deep-merges objects.
  // Every read below is defensive: a namespace whose plugin is disabled or whose
  // entry is not mounted simply is not in the list.
  const settingsReadable = function () {
    return !!(settingsSvc && typeof settingsSvc.describe === 'function');
  };
  const settingsWritable = function () {
    return settingsReadable() && typeof settingsSvc.update === 'function';
  };
  const settingsRows = function () {
    if (!settingsReadable()) return null;
    try {
      const rows = settingsSvc.describe();
      return Array.isArray(rows) ? rows : null;
    } catch (e) { logger.error('[thu-tok-auto] settings.describe', e); return null; }
  };
  const settingsValue = function (ns) {
    const rows = settingsRows();
    if (!rows) return null;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const name = row.ns || row.namespace || row.key || '';
      if (name !== ns) continue;
      return (row.value && typeof row.value === 'object') ? row.value : {};
    }
    return null;
  };
  /**
   * The provider this plugin manages, found by the marker it owns rather than by
   * the site's hostname: the live profile routes madmodel through a local shim
   * (baseURL http://127.0.0.1:8788/v1), so matching on the site URL alone missed
   * the real provider and would have created a second, duplicate one.
   */
  async function findProvider() {
    const rows = settingsRows() || [];
    const byEnv = [];
    const byUrl = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const ns = row.ns || row.namespace || row.key || '';
      if (typeof ns !== 'string' || !ns) continue;
      const value = (row.value && typeof row.value === 'object') ? row.value : null;
      const providers = value && value.providers && typeof value.providers === 'object' ? value.providers : null;
      if (!providers) continue;
      for (const id in providers) {
        const p = providers[id];
        if (!p || typeof p !== 'object') continue;
        const hit = {
          ns: ns,
          id: id,
          base: typeof p.baseURL === 'string' ? p.baseURL : '',
          apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '',
          displayName: typeof p.displayName === 'string' ? p.displayName : '',
          models: p.models,
        };
        if (hit.apiKeyEnv === CRED_REF) byEnv.push(hit);
        else if (isMadModelUrl(hit.base)) byUrl.push(hit);
      }
    }
    for (const hit of byEnv) if (isMadModelUrl(hit.base)) return hit;
    if (byEnv.length) return byEnv[0];
    return byUrl.length ? byUrl[0] : null;
  }
  // The site's live model list is the source of truth; MODEL_PROFILE is only
  // what we fall back to when it cannot be read. Cached, because reading it
  // means downloading the site's multi-megabyte front-end bundle.
  let modelCache = { at: 0, models: null };
  async function fetchSiteModels() {
    if (modelCache.models && deps.clock.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
    try {
      // The bundle is ~2.2 MB, so it needs its own read limit: the generic 1 MiB
      // cap refused it before a byte was parsed, which is why the live model sync
      // silently fell back to MODEL_PROFILE for every release up to 0.3.6.
      const page = await httpGet(SITE + '/', {}, true, 2 * 1024 * 1024);
      if (page && page.status === 200 && page.text) {
        const ref = String(page.text).match(/["']([^"']*assets\/js\/[^"']+\.js)["']/);
        if (ref) {
          const path = ref[1];
          const url = /^https?:/i.test(path) ? path : SITE + (path.charAt(0) === '/' ? '' : '/') + path;
          const bundle = await httpGet(url, {}, true, 8 * 1024 * 1024);
          if (bundle && bundle.status === 200 && bundle.text) {
            const models = toProviderModels(extractModelList(bundle.text));
            if (models && models.length) {
              modelCache = { at: deps.clock.now(), models: models };
              return models;
            }
          }
        }
      }
    } catch (e) { logger.error('[thu-tok-auto] site models', e); }
    return modelCache.models;
  }
  async function resolveModels() {
    const live = await fetchSiteModels();
    return (live && live.length) ? live : MODEL_PROFILE;
  }
  function providerPatch(id, value) {
    // Runs directly in the DSH host process (no node:vm sandbox in the bundle form),
    // so plain objects are already Host-realm objects that dsh-settings accepts.
    const patch = { providers: {} };
    patch.providers[id] = value;
    return patch;
  }
  async function applyToProvider(token) {
    const res = { provider: '', providerName: '', detail: '', credentialWritten: false, credentialPresent: false, err: '' };
    try {
      if (!credSvc || typeof credSvc.set !== 'function' || typeof credSvc.resolve !== 'function') {
        res.err += '凭据服务不可用；';
      } else {
        let current = null;
        try { current = await credSvc.resolve(CRED_REF); } catch (e) {}
        if (current && current.value === token) {
          // Already stored — a session-bound token is handed back unchanged for
          // hours, so "needs no write" is the normal case, not a failure. What was
          // wrong before was reporting that as a write that happened.
          res.credentialPresent = true;
        } else {
          await credSvc.set(CRED_REF, token);
          res.credentialWritten = true;
          res.credentialPresent = true;
        }
      }
    } catch (e) { res.err += '凭据写入失败：' + String((e && e.message) || e) + '；'; }
    try {
      if (!settingsWritable()) {
        res.err += 'DSH settings 服务不可用（需要 describe/update）；';
        return res;
      }
      const found = await findProvider();
      const models = await resolveModels();
      if (found) {
        res.provider = found.ns + '/' + found.id;
        res.providerName = found.displayName || PROVIDER_NAME;
        res.detail = 'found';
        const patch = {};
        if (found.apiKeyEnv !== CRED_REF) patch.apiKeyEnv = CRED_REF;
        // The site renames and retires models over time. Without this an existing
        // provider keeps yesterday's list, and every request fails with
        // "模型不存在" until someone edits the profile by hand.
        if (!modelsEqual(found.models, models)) patch.models = models;
        if (Object.keys(patch).length) {
          try {
            await settingsSvc.update(found.ns, providerPatch(found.id, patch));
            res.detail = patch.models ? (patch.apiKeyEnv ? 'synced' : 'models-synced') : 'apiKeyEnv-set';
          } catch (e) { res.err += '模型配置同步失败：' + String((e && e.message) || e) + '；'; }
        }
      } else {
        const ns = 'llm-pi-ai';
        const cur = settingsValue(ns);
        if (cur === null) {
          res.err += 'settings 命名空间 "' + ns + '" 不可用（插件未启用？）；';
        } else {
          if (cur.providers && Object.hasOwn(cur.providers, PROVIDER_KEY)) {
            throw new Error('Provider "madmodel" 已被其他配置占用；请重命名该配置后重试。');
          }
          await settingsSvc.update(ns, providerPatch(PROVIDER_KEY, {
            displayName: PROVIDER_NAME,
            apiKeyEnv: CRED_REF,
            api: 'openai-completions',
            reasoning: 'medium',
            baseURL: PROVIDER_BASE,
            models: models,
          }));
          res.provider = ns + '/' + PROVIDER_KEY;
          res.providerName = PROVIDER_NAME;
          res.detail = 'created';
        }
      }
    } catch (e) { res.err += '模型配置写入失败：' + String((e && e.message) || e) + '；'; }
    return res;
  }
  const statePath = function () { return baseDir + '\\state.json'; };
  const loadedStatus = function () {
    // A remembered "needs login" only decides the status when there is nothing
    // usable to fall back on. While a token still works the widget stays green and
    // the blocked renewal path is reported in the hover text only — a permanent
    // warning for a working setup was a false alarm.
    if (!state.token) return state.refreshBlocked ? 'needs-login' : 'idle';
    // The server's own verdict outranks the local clock: a token the site has
    // already refused must not keep showing as "ok" until its nominal expiry. Only a
    // verdict about *this* token counts (2026-10-04 audit, item 4).
    if (trustedVerdict() === false) return 'expired';
    const exp = state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0);
    if (!exp) return 'idle';
    if (deps.clock.now() >= exp) return 'expired';
    // A token that was written while the server's answer was unreadable is "半完成",
    // and a restart must not round that up to ok (2026-10-04 audit, item 4).
    if (state.unverified) return 'partial';
    // A valid token that could not be renewed is not "ok" either: say so while
    // there is still time to log in (2026-10-01, when every Auto run "succeeded"
    // against an expiry that never moved).
    if (state.renewalNoProgress) return 'no-progress';
    return 'ok';
  };
  // A state write that fails must never be reported as one that happened (2026-10-04).
  const SAVE_ATTEMPTS = 3;
  const SAVE_RETRY_MS = 60;
  let lastSavedStamp = '';
  /**
   * The owned lease, reduced to the keys that may reach the disk (2026-10-05 round 14 A).
   * Every value is an identifier — spawn id, DevTools instance id, port, pid, spawn time,
   * the dedicated profile directory, the executable — and nothing else can be smuggled in.
   * A lease without a port or without the profile directory is not a lease: without either
   * one the close path could not tell our browser from a stranger's, so it is dropped here
   * rather than kept as half-evidence.
   */
  function leaseForDisk() {
    const o = state.owned;
    if (!o || typeof o !== 'object') return null;
    const port = Number(o.port) || 0;
    const profile = String(o.profile || '');
    if (!port || !profile) return null;
    return {
      spawnId: String(o.spawnId || '').slice(0, 80),
      uuid: String(o.uuid || '').toLowerCase().slice(0, 80),
      port: port,
      pid: Number(o.pid) || 0,
      spawnedAt: Number(o.spawnedAt) || 0,
      profile: profile.slice(0, 400),
      exe: String(o.exe || '').slice(0, 400),
    };
  }
  /** One lease per spawn call: it names which browser this evidence is about. */
  function newSpawnId() {
    return 'spawn-' + deps.clock.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  /**
   * The lease reduced to a reading for the panel and for tests: which debug port is still on
   * record as a browser this plugin started, whether its instance id has been learned yet, and
   * which spawn it belongs to. It deliberately leaves the pid, the profile path and the full
   * instance id on disk, where a close needs them and nothing reads them out loud.
   */
  function ownedReading() {
    const lease = leaseForDisk();
    if (!lease) return null;
    return { port: lease.port, hasUuid: !!lease.uuid, spawnedAt: lease.spawnedAt, spawnId: lease.spawnId };
  }
  /** Record what the reaper did, in the same three words the snapshot prints. */
  function noteReap(reason, closed, lease) {
    lastReap = {
      reason: String(reason || ''),
      port: Number((lease && lease.port) || 0),
      closed: !!(closed && closed.closed === true),
      via: String((closed && closed.via) || ''),
      why: String((closed && closed.reason) || ''),
    };
    return lastReap;
  }
  /**
   * Take the lease for a browser this process has just started. Called immediately after
   * spawnBrowser resolves, before anything else looks at the browser: if this process dies
   * one line later, the lease on disk is the only thing that can still close it.
   */
  function openLease(browser, port, pid, profile) {
    state.owned = {
      spawnId: newSpawnId(),
      uuid: String(state.browserUuid || '').toLowerCase(),
      port: Number(port) || 0,
      pid: Number(pid) || 0,
      spawnedAt: deps.clock.now(),
      // The directory this run actually handed the browser: the shared one, or this run's own
      // `run-<id>` when the shared one was not ours to use (2026-10-05 round 17). It is part of
      // the lease because the process-table fallback ties a tree to *this* directory, and because
      // only an isolated one may be deleted afterwards.
      profile: String(profile || sharedProfilePath(baseDir)),
      exe: String(browser || ''),
    };
    return state.owned;
  }
  /** Learn the instance id — the one piece of evidence a recycled port cannot forge. */
  function leaseLearned(uuid) {
    const id = String(uuid || '').toLowerCase();
    if (id && state.owned) state.owned.uuid = id;
  }
  /**
   * Drop the lease. Only two things may do this: a close that was confirmed, and evidence
   * that the browser is already gone. A close that could *not* be confirmed keeps it — that
   * is the whole point of the lease (2026-10-05 round 14 A).
   */
  function clearLease() { state.owned = null; }
  function hasLease() { return !!leaseForDisk(); }
  /**
   * Remove the profile directory a browser of this run was given, once that browser is proven
   * gone (2026-10-05 round 17). Two refusals are built in, and both matter more than the
   * cleanup itself: only a directory `isIsolatedProfile` recognises is ever touched — so the
   * shared `profile` with its cookies and the site's stored device fingerprint can never be
   * deleted by this path — and nothing is removed while a close is unproven, because a browser
   * that may still be running is still using it.
   */
  async function cleanupCarrierProfile(profile, why) {
    const dir = String(profile || '');
    if (!isIsolatedProfile(dir, baseDir)) { lastCleanup = null; return null; }
    let res = null;
    try {
      if (!deps.stateIO || typeof deps.stateIO.rm !== 'function') res = { ok: false, error: 'no-rm-seam' };
      else res = await deps.stateIO.rm(dir);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    lastCleanup = { profile: dir, ok: !!(res && res.ok), why: String(why || ''), error: (res && res.ok) ? '' : String((res && res.error) || '') };
    if (lastCleanup.ok) logger.log('[thu-tok-auto] removed this run\'s own carrier profile (' + lastCleanup.why + ')');
    else logger.error('[thu-tok-auto] could not remove this run\'s own carrier profile: ' + JSON.stringify(lastCleanup));
    return lastCleanup;
  }
  /** The same, for the one caller that cannot await: `ctx.effect` dispose is not awaited. */
  function cleanupCarrierProfileSync(profile, why) {
    const dir = String(profile || '');
    if (!isIsolatedProfile(dir, baseDir)) { lastCleanup = null; return null; }
    let res = null;
    try {
      if (!deps.stateIO || typeof deps.stateIO.rmSync !== 'function') res = { ok: false, error: 'no-rm-sync-seam' };
      else res = deps.stateIO.rmSync(dir);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    lastCleanup = { profile: dir, ok: !!(res && res.ok), why: String(why || ''), error: (res && res.ok) ? '' : String((res && res.error) || ''), sync: true };
    return lastCleanup;
  }
  /**
   * Remove isolated profiles that a crashed or killed run left behind, at host start
   * (2026-10-05 round 17). Three guards, each answering a way this could go wrong: the lease on
   * disk is never touched (that browser may still be alive, and its directory is its own), a
   * directory any browser on the machine still holds is never touched (a process table that
   * cannot be read means *nothing* is removed — "unreadable" is not "unused"), and a directory
   * younger than ISOLATED_STALE_MS is left alone (a run that is starting right now has not
   * written its lease yet). What it did is a reading, printed in the snapshot like the reap.
   */
  async function pruneIsolatedProfiles() {
    lastPrune = { at: deps.clock.now(), ok: false, removed: [], kept: [], reason: '' };
    if (!baseDir) { lastPrune.reason = 'no-base-dir'; return lastPrune; }
    if (!deps.stateIO || typeof deps.stateIO.list !== 'function') { lastPrune.reason = 'no-list-seam'; return lastPrune; }
    let listed = null;
    try { listed = await deps.stateIO.list(baseDir); } catch (e) { listed = { ok: false, error: String((e && e.message) || e) }; }
    if (!listed || listed.ok !== true) { lastPrune.reason = 'list-failed'; return lastPrune; }
    const candidates = (listed.entries || []).filter((entry) => entry && entry.dir && isIsolatedProfile(baseDir + '\\' + entry.name, baseDir));
    if (!candidates.length) { lastPrune.ok = true; lastPrune.reason = 'nothing-to-prune'; return lastPrune; }
    // One reading of the process table decides whether any of them is still held. A failed read
    // removes nothing: the cost of a wrong delete is a browser losing its profile mid-flight.
    let held = null;
    try {
      if (typeof deps.listBrowserProfiles === 'function') held = await deps.listBrowserProfiles();
    } catch (e) { held = { ok: false, error: String((e && e.message) || e) }; }
    if (!held || held.ok !== true) { lastPrune.reason = 'profile-holders-unknown'; return lastPrune; }
    const heldDirs = held.dirs || [];
    const lease = leaseForDisk();
    const leaseProfile = lease ? normalizePath(lease.profile) : '';
    const now = deps.clock.now();
    const removed = [];
    const kept = [];
    for (const entry of candidates) {
      const dir = baseDir + '\\' + entry.name;
      const key = normalizePath(dir);
      if (leaseProfile && key === leaseProfile) { kept.push(entry.name); continue; }
      if (heldDirs.indexOf(key) !== -1) { kept.push(entry.name); continue; }
      const age = Number(entry.mtimeMs) > 0 ? now - Number(entry.mtimeMs) : 0;
      if (!age || age < ISOLATED_STALE_MS) { kept.push(entry.name); continue; }
      let res = null;
      try { res = await deps.stateIO.rm(dir); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      if (res && res.ok) removed.push(entry.name); else kept.push(entry.name);
    }
    lastPrune.ok = true;
    lastPrune.removed = removed.slice(0, 8);
    lastPrune.kept = kept.slice(0, 8);
    lastPrune.reason = removed.length ? 'removed-stale' : 'all-in-use-or-fresh';
    if (removed.length) logger.log('[thu-tok-auto] pruned ' + removed.length + ' stale isolated carrier profile(s)');
    return lastPrune;
  }
  /**
  /**
   * Put the evidence back after a close that did not succeed, so the next run (or the next
   * host process, or the stop script) can try again with the same readings instead of
   * asking the user to go find the process. The claim stays off: no window of ours is being
   * watched, and this process must not pretend it is.
   */
  function restoreEvidence(lease, uuid, port, pid) {
    if (lease && typeof lease === 'object') state.owned = lease;
    state.browserUuid = String(uuid || (lease && lease.uuid) || '');
    state.browserPort = Number(port || (lease && lease.port) || 0);
    state.browserPid = Number(pid || (lease && lease.pid) || 0);
    state.browserMine = false;
  }
  async function saveState() {
    ensureBaseDir();
    const payload = {
      // The API token belongs in DSH's credential store, never in this state file.
      cookies: state.cookies, ssoCookies: state.ssoCookies,
      lastGetAt: state.lastGetAt, auto: state.auto,
      refreshBlocked: !!state.refreshBlocked, loginReason: state.loginReason,
      cookieJar: Array.isArray(state.cookieJar) ? state.cookieJar : [],
      tokenExpAt: state.tokenExpAt || 0,
      serverValid: state.serverValid === null ? null : !!state.serverValid,
      lastValidatedAt: state.lastValidatedAt || 0,
      renewalNoProgress: !!state.renewalNoProgress,
      unverified: !!state.unverified,
      // The last run, so the next session can still answer "which rung answered, and did
      // the click reach the window". Its `at` changes on every run, which is what makes
      // the stamp below write the file once per run instead of never.
      lastTrace: state.lastTrace || null,
      // The last run a click started, kept separately because an Auto tick overwrites
      // `lastTrace` and the click's record is exactly what a real-machine report needs
      // (2026-10-04: the only trace on disk was the hourly tick).
      lastManualTrace: state.lastManualTrace || null,
      // The last page a no-window browser really reached. It is the only evidence that can
      // tell "the device page needs a person" from "the session is gone" after the fact, and
      // it holds no title text, token, cookie or identifier that was not already scrubbed
      // (2026-10-04 round 9, requirement D).
      lastProbe: state.lastProbe || null,
      // 我们自己那台浏览器的身份也要落盘（2026-10-05）。它是关闭路径唯一认的证据，而进程一
      // 重启，内存里的 uuid 就没了：上一轮留下的自有浏览器于是被读成「端口上有别人的浏览器」，
      // 只能请用户自己去关。真机 PID 7560 就是这样从 00:51 活了一整夜，Auto 再也起不来。
      // uuid 是 CDP 的实例标识、不是秘密，而且只有在那一台还活着时才可能对上。
      browserUuid: String(state.browserUuid || ''),
      browserPort: Number(state.browserPort || 0),
      browserPid: Number(state.browserPid || 0),
      browserMine: !!state.browserMine,
      // The lease (2026-10-05 round 14 A). It outlives the claim above on purpose: a close
      // that could not be confirmed keeps it, which is what lets the next start — or the
      // stop script — finish the job with evidence instead of asking the user to hunt a
      // process by name.
      owned: leaseForDisk(),
      // What the last no-window renewal did with the saved session (2026-10-05 round 16). Names
      // and counts only — it is written to disk like the rest of the run's record, so it may
      // never carry a cookie value.
      lastRestore: state.lastRestore || null,
      // Which port the last run took, what was in the way, and whether it had to use a profile of
      // its own (2026-10-05 round 17). These survive a host restart on purpose: the report of a
      // port conflict has to be readable afterwards, and `portNote` is the one sentence that says
      // "another browser was there and the plugin routed around it".
      carrierPort: Number(state.carrierPort || 0),
      carrierProfile: String(state.carrierProfile || ''),
      portStrangers: Number(state.portStrangers || 0),
      portNote: String(state.portNote || ''),
      // The browser that was in the way and would not confirm its close (2026-10-05 round 17):
      // port + instance id + the reason it gave. It is *evidence*, not a claim — it is what lets a
      // later run recognise that browser again (nobody may adopt or kill a browser without proof of
      // identity) and what the stop script reads to try closing it a second time. Cleared by a close
      // that was proven.
      portLeftover: state.portLeftover || null,
    };
    // Auto ticks can run every few minutes without anything in here changing;
    // rewriting the file each time is pure churn.
    const stamp = JSON.stringify([payload.cookies, payload.ssoCookies, payload.cookieJar, payload.lastGetAt, payload.auto, payload.refreshBlocked, payload.loginReason, payload.tokenExpAt, payload.serverValid, payload.lastValidatedAt, payload.renewalNoProgress, payload.unverified, payload.lastTrace, payload.lastManualTrace, payload.lastProbe, payload.browserUuid, payload.browserPort, payload.browserPid, payload.browserMine, payload.owned, payload.lastRestore, payload.carrierPort, payload.carrierProfile, payload.portStrangers, payload.portNote, payload.portLeftover]);
    if (stamp === lastSavedStamp) return;
    // The write is a tmp file plus a rename over the destination, and on Windows that
    // rename can lose a race with whoever is holding the destination for a moment. It
    // really happened on 2026-10-04 18:01:23: the capture's own write went through, the
    // run's record right behind it came back `EPERM: operation not permitted, rename …`,
    // and the panel kept describing the previous run while the token had in fact been
    // renewed. Two quick retries turn that flake into a write; a genuine refusal still
    // throws, so the caller can say so instead of pretending the record is on disk.
    let saved = null;
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      saved = await deps.stateIO.save(statePath(), payload);
      if (saved && saved.ok) {
        // The data landed, but not the way it was meant to: the tmp-file swap was refused
        // often enough that the destination had to be overwritten in place. Nothing is
        // wrong with the record — it is on disk — so this is a note for whoever reads the
        // host log, not an error for the panel (2026-10-04, the EPERM on the rename).
        if (saved.degraded) logger.log('[thu-tok-auto] the atomic swap was refused, so the state file was written directly: ' + String(saved.degraded));
        break;
      }
      if (attempt < SAVE_ATTEMPTS) await slept(SAVE_RETRY_MS);
    }
    if (!saved || !saved.ok) throw new Error('state save failed: ' + String((saved && saved.error) || 'unknown error'));
    lastSavedStamp = stamp;
    // The file on disk is now this run's: whatever an earlier failed write said about the
    // record is no longer true (2026-10-04 round 9, requirement G).
    stateDiskFailed = false;
  }
  async function loadState() {
    try {
      ensureBaseDir();
      const r = await deps.stateIO.load(statePath());
      if (r && r.ok) {
        const d = r.data;
        if (d && typeof d === 'object') {
          let stored = null;
          if (credSvc && typeof credSvc.resolve === 'function') {
            try { stored = await credSvc.resolve(CRED_REF); } catch (e) {}
          }
          const credentialToken = stored && typeof stored.value === 'string' ? stored.value : '';
          const legacyToken = typeof d.token === 'string' ? d.token : '';
          state.token = credentialToken || legacyToken;
          state.cookies = typeof d.cookies === 'string' ? d.cookies.slice(0, 65536) : '';
          state.ssoCookies = typeof d.ssoCookies === 'string' ? d.ssoCookies.slice(0, 65536) : '';
          const savedAt = typeof d.lastGetAt === 'number' && Number.isFinite(d.lastGetAt) ? d.lastGetAt : 0;
          state.lastGetAt = savedAt > 0 && savedAt <= deps.clock.now() + 5 * 60e3 ? Math.min(savedAt, deps.clock.now()) : 0;
          state.auto = !!d.auto;
          state.refreshBlocked = !!d.refreshBlocked;
          state.loginReason = typeof d.loginReason === 'string' ? d.loginReason.slice(0, 200) : '';
          state.cookieJar = Array.isArray(d.cookieJar)
            ? d.cookieJar.filter(function (c) { return c && c.name && typeof c.value === 'string'; }).slice(0, 200)
            : [];
          state.tokenExpAt = jwtExpiry(state.token) || (typeof d.tokenExpAt === 'number' && Number.isFinite(d.tokenExpAt) ? d.tokenExpAt : 0);
          // A persisted "the site refused it" is still a fact after a restart; a persisted
          // "valid" is not, because nothing has re-asked during this session — and left
          // alone it would be inherited by whatever token arrives next. Unknown is the
          // honest starting point (2026-10-04 audit, item 4).
          state.serverValid = d.serverValid === false ? false : null;
          state.validatedFp = d.serverValid === false ? tokenFp(state.token) : '';
          state.lastValidatedAt = typeof d.lastValidatedAt === 'number' && Number.isFinite(d.lastValidatedAt) ? d.lastValidatedAt : 0;
          state.renewalNoProgress = !!d.renewalNoProgress;
          state.unverified = !!d.unverified;
          // 自有浏览器的身份（2026-10-05）：和别的字段一样只认已知键、只认字符串与数字，
          // 手改过的 state 文件塞不进别的东西。它只是"本插件上次起的那台是谁"的备忘，
          // 端口上那台不在了就对不上任何东西。
          state.browserUuid = typeof d.browserUuid === 'string' ? d.browserUuid.slice(0, 80) : '';
          state.browserPort = Number.isInteger(d.browserPort) && d.browserPort > 0 && d.browserPort < 65536 ? d.browserPort : 0;
          state.browserPid = Number.isInteger(d.browserPid) && d.browserPid > 0 ? d.browserPid : 0;
          state.browserMine = !!d.browserMine;
          // The lease (2026-10-05 round 14 A). Read back defensively like everything else:
          // known keys only, port inside the real range, the rest strings and numbers. A
          // hand-edited file cannot point the close path at somebody else's profile.
          const lo = d.owned && typeof d.owned === 'object' && !Array.isArray(d.owned) ? d.owned : null;
          const loPort = lo && Number.isInteger(lo.port) && lo.port > 0 && lo.port < 65536 ? lo.port : 0;
          const loProfile = lo && typeof lo.profile === 'string' ? lo.profile.slice(0, 400) : '';
          state.owned = lo && loPort && loProfile ? {
            spawnId: typeof lo.spawnId === 'string' ? lo.spawnId.slice(0, 80) : '',
            uuid: typeof lo.uuid === 'string' ? lo.uuid.toLowerCase().slice(0, 80) : '',
            port: loPort,
            pid: Number.isInteger(lo.pid) && lo.pid > 0 ? lo.pid : 0,
            spawnedAt: Number.isFinite(lo.spawnedAt) && lo.spawnedAt > 0 ? lo.spawnedAt : 0,
            profile: loProfile,
            exe: typeof lo.exe === 'string' ? lo.exe.slice(0, 400) : '',
          } : null;
          // Read back defensively: only the known keys, only strings and numbers, so a
          // hand-edited or older state file cannot inject anything into the panel.
          state.lastTrace = d.lastTrace && typeof d.lastTrace === 'object'
            ? buildTrace(d.lastTrace, Number(d.lastTrace.at) || 0)
            : null;
          // An older file only has `lastTrace`: if that run was a click, it is also the
          // last click there is evidence for (0.3.9 → 0.3.10 migration).
          state.lastManualTrace = d.lastManualTrace && typeof d.lastManualTrace === 'object'
            ? buildTrace(d.lastManualTrace, Number(d.lastManualTrace.at) || 0)
            : (state.lastTrace && !state.lastTrace.bg ? buildTrace(state.lastTrace, state.lastTrace.at) : null);
          // Read back through the same whitelist that wrote it: a hand-edited or older file
          // cannot smuggle anything into the panel through this field either.
          state.lastProbe = pageFacts(d.lastProbe, Number(d.lastProbe && d.lastProbe.at) || 0);
          // Same whitelist treatment for the session-restore reading (2026-10-05 round 16):
          // known keys only, cookie *names* only, so a hand-edited file cannot put a secret —
          // or anything else — into the panel through it.
          state.lastRestore = restoreFacts(d.lastRestore, Number(d.lastRestore && d.lastRestore.at) || 0);
          // The port-conflict readings and the leftover's evidence (2026-10-05 round 17). Same
          // whitelist treatment: a port inside the real range, an identity that looks like one, and
          // a reason as text — a hand-edited file cannot hand the close path a stranger's identity.
          const pl = d.portLeftover && typeof d.portLeftover === 'object' && !Array.isArray(d.portLeftover) ? d.portLeftover : null;
          const plPort = pl && Number.isInteger(pl.port) && pl.port > 0 && pl.port < 65536 ? pl.port : 0;
          const plId = pl && typeof pl.id === 'string' ? pl.id.toLowerCase().slice(0, 80) : '';
          state.portLeftover = pl && plPort && plId ? {
            port: plPort,
            id: plId,
            pid: Number.isInteger(pl.pid) && pl.pid > 0 ? pl.pid : 0,
            why: typeof pl.why === 'string' ? pl.why.slice(0, 120) : '',
            at: Number.isFinite(pl.at) && pl.at > 0 ? pl.at : 0,
            profile: typeof pl.profile === 'string' ? pl.profile.slice(0, 400) : '',
          } : null;
          state.carrierPort = Number.isInteger(d.carrierPort) && d.carrierPort > 0 && d.carrierPort < 65536 ? d.carrierPort : 0;
          state.carrierProfile = d.carrierProfile === 'isolated' ? 'isolated' : (d.carrierProfile === 'shared' ? 'shared' : '');
          state.portStrangers = Number.isInteger(d.portStrangers) && d.portStrangers > 0 ? d.portStrangers : 0;
          state.portNote = typeof d.portNote === 'string' ? d.portNote.slice(0, 600) : '';
          state.credentialWritten = !!credentialToken;
          state.credentialPresent = !!credentialToken;
          state.status = loadedStatus();
          if (state.unverified && state.token) state.err = UNVERIFIED_HINT;
          // Migrate legacy state files that contained the token in plaintext.
          if (legacyToken && credSvc && typeof credSvc.set === 'function') {
            try {
              if (!credentialToken) { await credSvc.set(CRED_REF, legacyToken); state.credentialWritten = true; }
              await saveState();
            } catch (e) { logger.error('[thu-tok-auto] legacy token migration', e); }
          }
        } else {
          if (credSvc && typeof credSvc.resolve === 'function') {
            try {
              const stored = await credSvc.resolve(CRED_REF);
              state.token = stored && typeof stored.value === 'string' ? stored.value : '';
              state.credentialWritten = !!state.token;
              state.credentialPresent = !!state.token;
              state.tokenExpAt = jwtExpiry(state.token);
            } catch (e) {}
          }
          state.status = loadedStatus();
        }
        // Label the provider row on load when there is something to label. Reads
        // settings only; never writes during startup.
        if (state.token && settingsReadable()) {
          try {
            const found = await findProvider();
            if (found) {
              state.provider = found.ns + '/' + found.id;
              state.providerName = found.displayName || PROVIDER_NAME;
            }
          } catch (e) {}
        }
      }
    } catch (e) { logger.error('[thu-tok-auto] load', e); }
  }
  function ensureLoaded() {
    if (!initialized) {
      initialized = true;
      initPromise = loadState();
    }
    return initPromise;
  }
  function snapshot() {
    // expiresAt is the token's own exp whenever it decodes (jwtExpiry); the assumed
    // 6h lifetime is only a fallback for an undecodable token. Decoding is
    // deliberately preferred: the mint service stamps iat/exp on a clock ~10min
    // ahead of this machine (verified: mint response Date header == local clock
    // while iat == local + 9.6min), so "last fetch + 6h" ran ahead of the real
    // expiry — and further ahead each time an older token was read back from a
    // live browser (2026-10-01: 2.4h of invented life on the panel).
    const expAt = state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0);
    return {
      auto: state.auto, busy: state.busy, lastGetAt: state.lastGetAt, status: state.status, err: state.err,
      // The panel prints the Auto interval in its hover text, so it must not spell that
      // number out itself: one constant decides the schedule (AUTO_REFRESH_MS) and this
      // field carries it to the widget, which only formats it. A host that has not been
      // restarted yet serves the older snapshot, and the widget falls back to the label
      // that matches that older core rather than claiming the new cadence.
      autoEveryMs: AUTO_REFRESH_MS,
      loggedIn: !!state.token,
      expiresAt: expAt,
      // The widget shows one number (time since the last fetch) and one word (how
      // much life is left). nearlyOut decides when that second fact must stop
      // being hover-only.
      nearlyOut: !!expAt && (expAt - deps.clock.now()) <= RENEWAL_MARGIN_MS,
      serverValid: trustedVerdict(), lastValidatedAt: state.lastValidatedAt,
      renewalNoProgress: state.renewalNoProgress,
      // "written but never confirmed" and "kept the stored credential" are facts the
      // panel and the tests report as-is (2026-10-04 audit, item 4).
      unverified: state.unverified, storedUnchanged: state.storedUnchanged,
      browserOpen: state.browserOpen, minted: state.minted,
      // loginWait means a window this plugin opened is open and being watched right
      // now: the widget's "waiting for login" and Auto's "do not start beside it" both
      // read this one fact rather than guessing from browserOpen.
      loginWait: state.loginWait, browserMine: state.browserMine,
      // A background renewal keeps its browser to itself: the panel can say whether the
      // window being watched is one of ours with nothing on screen, and why the last
      // background attempt was called off (2026-10-04, round 5).
      headless: !!state.headless, headlessFailReason: headlessFailReason,
      // Which no-window engine is being watched ('hidden' = this plugin's own normal Edge with
      // no UI on screen, 'headless' = the built-in shell, '' = nothing open) and, when the
      // native carrier could not be used, the real reason the fallback happened — the panel
      // must not claim a carrier it is not actually running (2026-10-04 round 10).
      carrier: state.carrier, carrierNote: state.carrierNote,
      provider: state.provider, providerName: state.providerName,
      credentialWritten: state.credentialWritten, credentialPresent: state.credentialPresent,
      syncDetail: state.syncDetail,
      via: state.lastVia, loginReason: state.loginReason, refreshBlocked: state.refreshBlocked,
      // Nothing reached the site on the last run, so nothing was re-verified.
      offline: offlineFlag,
      // Which build the host actually loaded (read from package.json by lib/index.js) and
      // what the last run did, as facts: without these a real-machine report cannot tell
      // "the click was swallowed" from "the ladder is dead" from "the window failed"
      // (2026-10-04 real run). Neither field holds a token, a cookie or an identifier.
      // `manualTrace` is the last *click*: a scheduled Auto tick overwrites `trace`, so
      // without this the click that did nothing visible leaves no readable record.
      version: String(deps.version || ''),
      trace: state.lastTrace,
      manualTrace: state.lastManualTrace,
      // What the last no-window browser really saw, and whether the last state write reached
      // the disk at all: two facts a real-machine report must be able to cite rather than
      // infer from a sentence in `err` (2026-10-04 round 9, requirements D and G).
      lastProbe: state.lastProbe || null,
      stateDiskFailed: stateDiskFailed,
      // What happened to the browser an earlier process left behind, and what is still recorded
      // as ours right now: two readings, no identifiers beyond the debug port they already know.
      // Without the first, "the leftover was dealt with at startup" and "it was never looked at"
      // would read the same in a report (2026-10-05 round 14 A).
      reap: lastReap,
      owned: ownedReading(),
      // Whether the saved session was handed back to this run's browser before it was sent to
      // the login entry, and what the restorer said when it was not (2026-10-05 round 16). A
      // reading — outcome word, host, counts, cookie names — never a cookie value.
      restore: state.lastRestore || null,
      // Which port this run ended up on, how many foreign debug browsers were in the way, and
      // whether the carrier got a profile of its own (2026-10-05 round 17). Three facts that
      // answer "where did that browser live, and did the plugin touch anyone else's?" without a
      // log dive. The sentence is the one the panel shows; the structured fields are for probes.
      portNote: state.portNote, carrierPort: state.carrierPort, carrierProfile: state.carrierProfile, portStrangers: state.portStrangers,
      leftover: state.portLeftover || null,
      // What this process removed after a proven close, and what the startup prune found: both are
      // readings about *this plugin's own* directories, never about anyone else's files.
      cleanup: lastCleanup,
      prune: lastPrune,
      gate: gateReading(),
    };
  }
  /**
   * The last run, reduced to checkable facts: which rung answered, the server's verdict
   * on the token, the expiry before and after, the wall-clock cost, how long a click had
   * to wait behind another run, and what became of the login window. Written on every run
   * and persisted, because a real-machine run has to be diagnosable afterwards instead of
   * reconstructed from guesses. It holds no token, no cookie and no identifier.
   */
  function buildTrace(fields, at) {
    const f = fields || {};
    return {
      at: Number.isFinite(at) ? at : deps.clock.now(),
      bg: f.bg ? 1 : 0,
      mint: String(f.mint || 'skip'),
      sso: String(f.sso || 'skip'),
      reuse: f.reuse ? 1 : 0,
      verdict: String(f.verdict || 'unknown'),
      via: String(f.via || 'none'),
      expBefore: Number(f.expBefore) || 0,
      expAfter: Number(f.expAfter) || 0,
      ms: Math.max(0, Number(f.ms) || 0),
      waitMs: Math.max(0, Number(f.waitMs) || 0),
      opened: String(f.opened || 'none'),
      // Which carrier ran the capture this record describes: 'window', 'hidden' or 'headless'.
      // The panel can then tell a hidden-page renewal from a built-in-shell one instead of
      // reading both as 「免密续期」 (2026-10-04 round 10).
      carrier: String(f.carrier || ''),
      // Which port the run took and what was in the way, in one compact token (round 17):
      // `used=9334 strangers=1 profile=isolated`. Empty when the request never got that far —
      // an empty string here is itself a reading ("this run never picked a port").
      ports: tracePorts(),
    };
  }
  function tracePorts() {
    if (!state.carrierProfile && !state.portStrangers && !state.portNote) return '';
    return 'used=' + String(state.carrierPort || 0) + ' strangers=' + String(state.portStrangers || 0) + ' profile=' + String(state.carrierProfile || 'shared');
  }
  function writeTrace(fields) {
    const f = fields || {};
    // Two separate objects, never the same one twice: the panel prints both when an Auto
    // tick has already overwritten `lastTrace`, and a shared object would make the click's
    // record mutate into the tick's (report §12 item 2).
    state.lastTrace = buildTrace(f);
    if (!f.bg) state.lastManualTrace = buildTrace(f);
    return state.lastTrace;
  }
  // A trace that never reached the disk is not a trace the next session can show: the panel
  // would print an earlier run as if it were this one (2026-10-04 18:01:23, report §21.3).
  // Silence is what makes that lie possible, so the visible line says it out loud.
  // `what` names the record that was lost, so the host log keeps saying which one it was.
  function markTraceNotStored(what, why) {
    logger.log('[thu-tok-auto] could not persist the ' + what + ': ' + why);
    if (String(state.err || '').indexOf(TRACE_NOT_STORED_NOTE) === -1) {
      state.err = state.err ? state.err + '；' + TRACE_NOT_STORED_NOTE : TRACE_NOT_STORED_NOTE;
    }
  }
  // The state file (not the credential store) could not be written. The token may be in the
  // store and working, but nothing about it survives a restart — and a run that claims both
  // must not report the two as one success (2026-10-04 round 9, requirement G).
  function noteStateNotStored(what, why) {
    logger.log('[thu-tok-auto] could not persist the ' + what + ': ' + why);
    stateDiskFailed = true;
    if (String(state.err || '').indexOf(STATE_NOT_STORED_NOTE) === -1) {
      state.err = state.err ? state.err + '；' + STATE_NOT_STORED_NOTE : STATE_NOT_STORED_NOTE;
    }
  }
  // The one bounded, de-identified reading of the page a no-window browser really reached.
  // It exists because "the SSO is gone" and "the device page needs a person" and "the page
  // never even loaded" are three different failures that the panel was reporting with one
  // sentence (2026-10-04 round 9, requirement D). Long runs of alphanumerics — tokens,
  // session ids, fingerprints — are masked before anything is logged or stored.
  function scrubText(s, max) {
    return String(s == null ? '' : s)
      .replace(/[A-Za-z0-9_\-]{20,}/g, '…')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }
  function pageFacts(p, at) {
    if (!p || typeof p !== 'object') return null;
    const form = ['login-form', 'device-fingerprint', 'loading', 'none', 'unknown'].indexOf(String(p.form)) >= 0
      ? String(p.form) : 'unknown';
    const errors = Array.isArray(p.errors)
      ? p.errors.slice(0, 3).map(function (e) { return scrubText(e, 160); }).filter(Boolean)
      : [];
    return {
      at: Number.isFinite(at) && at > 0 ? at : deps.clock.now(),
      title: scrubText(p.title, 80),
      path: scrubText(p.path, 120),
      form: form,
      fp2: !!p.fp2,
      ready: !!p.ready,
      errors: errors,
    };
  }
  // The session-restore reading read back from disk, through the same kind of whitelist as the
  // page facts above: known keys, bounded numbers, and cookie *names* only — the jar's values
  // never leave the process, so nothing here may become a way to write one into a state file
  // (2026-10-05 round 16).
  function restoreFacts(r, at) {
    if (!r || typeof r !== 'object') return null;
    const names = function (v) {
      return Array.isArray(v)
        ? v.slice(0, 8).map(function (n) { return scrubText(n, 60); }).filter(Boolean)
        : [];
    };
    return {
      at: Number.isFinite(at) && at > 0 ? at : deps.clock.now(),
      ok: !!r.ok,
      reason: scrubText(r.reason, 40),
      host: scrubText(r.host, 80),
      sent: Math.max(0, Number(r.sent) || 0),
      failed: names(r.failed),
      skipped: names(r.skipped),
      navigated: !!r.navigated,
    };
  }
  // Keep the reading, and put exactly one line about it in the host log per capture: an
  // audit of "why did the no-window browser not finish" needs the page it stood on, and the
  // line is bounded so a page title can never become a dump (2026-10-04 round 9,
  // requirement D).
  function noteCapturePage(page) {
    const facts = pageFacts(page);
    if (!facts) return;
    captureProbe = facts;
    state.lastProbe = facts;
    if (!captureProbeLogged) {
      captureProbeLogged = true;
      logger.log('[thu-tok-auto] headless page: ' + JSON.stringify(facts));
    }
  }
  // Everything that waits goes through here, and it waits with what the host actually hands out.
  // The DSH timer service has interval/timeout and **no sleep at all**: calling `sleep` on it
  // threw "deps.timer.sleep is not a function" on the real machine and took the whole no-window
  // run down with it — the capture arm never got as far as a page, and the panel blamed the site
  // (2026-10-05 round 18). A test may still inject a sleep (it is the cheapest way to drive a
  // fake clock), but the shipped path must work without one.
  const slept = function (ms) {
    if (deps.timer && typeof deps.timer.sleep === 'function') return deps.timer.sleep(ms);
    if (deps.timer && typeof deps.timer.timeout === 'function') return new Promise(function (resolve) { deps.timer.timeout(resolve, ms); });
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };
  /**
   * Wait for the run already in flight, then let this click have its own turn. Bounded by
   * both the clock and an iteration cap (a test clock does not move by itself, and a wedged
   * run must not hang the request).
   */
  async function waitForIdleRun() {
    const t0 = deps.clock.now();
    // Bounded by the wall clock and by an iteration cap: a test clock that does not move
    // would otherwise never reach the deadline, and a wedged run must not hang the request.
    for (let i = 0; i < 400 && state.busy && !disposed; i++) {
      if (deps.clock.now() - t0 >= MANUAL_WAIT_MS) break;
      await slept(MANUAL_POLL_MS);
    }
    return Math.max(0, deps.clock.now() - t0);
  }
  /**
   * Hand the user the one door left, inside the very run they started: open (or
   * reuse) the temporary login window and start watching it. Only a manual click
   * reaches this; a background tick records the need and stays quiet, because an
   * unattended machine must never stack windows (2026-10-04, requirement B).
   */
  async function offerLogin(out, background) {
    out.loginRequired = !background;
    if (background) {
      // An unattended tick may not put a window on screen — and it may not read a browser
      // it did not open. It may still use one of its own making when the SSO chain has
      // just proved that the *device* page, not a dead session, is what the cookie-only
      // walk cannot pass: a short-lived headless window runs that page's own JavaScript
      // and is closed again on every exit (2026-10-04, round 5, requirement B).
      out.loginOpened = 'none';
      const started = await startHeadlessRenewal(lastSsoStep, background);
      // Which no-window carrier it got is reported as what it is (2026-10-04 round 10).
      if (started.launched) out.loginOpened = started.carrier === 'hidden' ? 'hidden' : 'headless';
      // A carrier that could not even be started is not "nothing happened": naming it in the
      // record is what separates "this run never tried" from "this profile still has our own
      // browser on it"（2026-10-05：`opened:'none'` 配一个没动的 exp，正是第十二轮那次后台
      // 运行看着像"成功复用"的形状）。名字取**这一次尝试实际返回的 reason**，不是
      // state.loginReason：offline / fingerprint-required 这类会话侧读数比闸门名更有信息量，
      // 闸门名不该把它们盖掉。
      else if (CARRIER_FAIL_REASONS[String(started.reason)]) out.loginOpened = String(started.reason);
      // When the background route is out of options, the panel has to ask for the one
      // thing that would work — a click — instead of reporting a failure with no door.
      if (state.loginReason === 'needs-manual-login') out.loginRequired = true;
      out.status = state.status;
      out.err = state.err;
      return out;
    }
    // The click gets the same production ladder an unattended run gets, including one
    // bounded headless attempt when the *device* page — not a missing session — is what the
    // cookie-only walk cannot pass: when this profile still holds the enrolled material,
    // that finishes the renewal with no window at all. If it cannot start (a real login
    // form, a window already open, or the failure backoff), the click still gets the door it
    // has always had: the visible window, in this same request (2026-10-04, round 6).
    if (lastSsoStep === 'fingerprint-form') {
      const attempt = await startHeadlessRenewal(lastSsoStep);
      if (attempt.launched) {
        out.loginOpened = attempt.carrier === 'hidden' ? 'hidden' : 'headless';
        out.loginRequired = false;
        out.status = state.status;
        out.err = state.err;
        return out;
      }
    }
    const opened = await openLogin({ background: background });
    out.loginOpened = opened.launched ? 'launched' : String(opened.reason || 'error');
    if (opened.launched || opened.reason === 'reuse' || opened.reason === 'already-open') {
      state.status = 'waiting-login';
      // 端口那一句读数放在最前面（第十七轮）："这台登录窗口为什么又开了一个"（首选端口上有别人、
      // 所以换了端口与独立 profile）是用户看得见的现象，它必须出现在面板上，而不是只躺在 state.json。
      state.err = withPortNote(LOGIN_WAIT_HINT);
    } else if (String(opened.reason || '') !== 'disposed') {
      // The click reached the end of the ladder and the window would not open: say which
      // part failed, on the visible line, or the panel is back to promising a login the
      // user cannot start (2026-10-04 real run). Health is left alone — a window that did
      // not open says nothing about the token.
      // openLogin 已经写下了带真实读数的整句（端口号、实例身份、浏览器的 code 与目标数）：
      // 那种句子比一句归类值钱，不许被它覆盖掉，也不再往后叠一句同义的话
      // （2026-10-04 第十二轮：夹具断言 /9333/ 时暴露了归类句把端口号吃掉这件事）。
      const hint = loginFailHint(opened.reason, opened.detail);
      state.err = opened.note ? String(opened.note) : hint;
    }
    out.status = state.status;
    out.err = state.err;
    return out;
  }
  /**
   * The one background browser this plugin may use: a short-lived headless Edge/Chrome of
   * its own making, asked for by an unattended tick or by a click that would otherwise open
   * a visible window. It is opened only when the SSO chain has just shown that the device
   * page — not a missing session — is what the pure-HTTP replay cannot pass, it is closed on
   * every exit, and a failure is remembered so the next attempt is half an hour away instead
   * of every five minutes. A password form is never guessed at: a headless browser cannot
   * type one, so the panel is simply told that a person is needed (2026-10-04, rounds 5-6).
   */
  // 一道没放行的闸门必须留下"是哪道门 + 当时的读数"。这两条以前什么都不写，真机上 Auto 停摆
  // 两小时而盘上只有 opened:'none'（2026-10-05，KNOWN_ISSUES §10.55）。名字走 trace 的 opened
  // 字段（验收读它）；loginReason 与已经写好的一句话都不动 —— "需要重新登录"比"退避期还没过"
  // 对用户更有用，而闸门名只是一个读数。
  const headlessNoGo = function (reason, text) {
    headlessFailReason = String(reason);
    if (!state.err) state.err = String(text);
  };
  async function startHeadlessRenewal(step, background) {
    if (disposed) return { launched: false, reason: 'disposed' };
    if (step === 'login-form') {
      state.loginReason = 'needs-manual-login';
      state.err = MANUAL_LOGIN_HINT;
      headlessFailReason = 'login-form';
      return { launched: false, reason: 'login-form' };
    }
    if (step !== 'fingerprint-form') {
      headlessNoGo('no-evidence', '梯子没有给出「设备指纹页」的读数（lastSsoStep=' + (step ? String(step) : '空') +
        '），无窗口续期没有依据可走');
      return { launched: false, reason: 'no-evidence', note: state.err };
    }
    // Whether a browser is *wanted* is the caller's decision, not this function's: both
    // carriers that reach here — an Auto run its own schedule has brought due, and an
    // explicit click — are already asking for a renewal, and a token that still has hours
    // left is exactly the case where the stored IDP session is worth spending. 0.3.12
    // gated this on the JWT's remaining life, which turned Auto's own schedule into a no-op
    // until the last hour; the measured session lifetime is shorter than that (recognised
    // at T+45 min, gone at T+70 min after a real login, 2026-10-04 round 6), so by the
    // final hour there is usually nothing left to replay. The frequency control lives in
    // autoTick's floor and in the failure backoff below, not in the token's clock.
    const now = deps.clock.now();
    // The caller *is* this run, so it steals no turn from anybody — but it may not open a
    // second window beside one that is already open and being watched.
    if (state.browserOpen || state.loginWait) return { launched: false, reason: 'busy' };
    if (headlessBackoffUntil && now < headlessBackoffUntil) {
      headlessNoGo('backoff', '上一次无窗口续期失败（' + (headlessFailReason || '原因未记') + '），退避到 ' +
        new Date(headlessBackoffUntil).toISOString() + '，这一轮不再试');
      return { launched: false, reason: 'backoff', note: state.err };
    }
    const opened = await openLogin({ headless: true, background: !!background });
    if (opened.launched) { headlessFailReason = ''; return opened; }
    if (opened.reason !== 'disposed') {
      headlessFailReason = String(opened.reason || 'error');
      headlessBackoffUntil = deps.clock.now() + HEADLESS_RETRY_MS;
      // 载体没能起来 ≠ 会话需要人工登录。以前这里一律写 needs-manual-login + MANUAL_LOGIN_HINT，
      // 把 openLogin 给出的真实读数（端口号、实例身份、浏览器的 code 与目标数）盖掉：2026-10-05
      // 真机上面板就是这样对着一台关不掉的自有浏览器说"需要手动登录"，而同一时刻的逐跳测量
      // （test/sso-hop-trace.mjs）证明 IDP 还认得保存的会话 —— 会话是活的，是载体起不来。
      // 现在只把载体类失败按它本来的名字记下来，具体读数优先，通用提示只在真的没有读数时用。
      if (opened.note) {
        state.loginReason = String(opened.reason);
        state.err = String(opened.note);
      } else if (CARRIER_FAIL_REASONS[String(opened.reason)]) {
        state.loginReason = String(opened.reason);
        state.err = loginFailHint(opened.reason, opened.detail);
      } else {
        state.loginReason = 'needs-manual-login';
        state.err = MANUAL_LOGIN_HINT;
      }
    }
    return opened;
  }
  // What a run hands back has to describe the state it leaves behind, not the one it found.
  // A click used to be answered with an object snapshotted *before* the login window opened,
  // so an open, watched window came back as `browserOpen:false, loginWait:false,
  // browserMine:false` and the answer carried the previous run's trace — on 2026-10-04 18:01
  // that made a successful capture read as "the window opened and vanished, nothing renewed".
  // Everything the snapshot owns is re-read at the last moment; what this run computed itself
  // (via, detail, loginOpened, loginRequired, expiryAdvanced, fresh, offline) is kept.
  const LIVE_OUT_FIELDS = [
    'auto', 'autoEveryMs', 'busy', 'lastGetAt', 'status', 'err', 'loggedIn', 'expiresAt',
    'nearlyOut', 'serverValid', 'lastValidatedAt', 'renewalNoProgress', 'unverified',
    'storedUnchanged', 'browserOpen', 'minted', 'loginWait', 'browserMine', 'headless',
    'headlessFailReason', 'carrier', 'carrierNote', 'provider', 'providerName', 'credentialWritten',
    'credentialPresent', 'syncDetail', 'loginReason', 'refreshBlocked', 'version',
    'trace', 'manualTrace', 'lastProbe', 'stateDiskFailed', 'portNote',
  ];
  const settleOut = function (out) {
    if (!out || typeof out !== 'object') return out;
    returnedOut = out;
    const live = snapshot();
    for (const key of LIVE_OUT_FIELDS) out[key] = live[key];
    return out;
  };
  async function runGetTok(opts) {
    // 并发闸门（2026-10-05 第十七轮）。两次点击可以在"还没人把 busy 立起来"的那个窗口里同时
    // 通过下面的检查，于是各自 spawn 一台浏览器：真机上就是两台抢同一个端口与 profile。
    // 闸门只覆盖**从入口到 state.busy = true** 这一段，越短越好；后来者在这里等，醒来后看到的
    // state 已经是前一次运行留下的（busy 或 loginWait），于是走既有分支 —— 点击照旧有界等待后
    // 自己跑，后台 tick 照旧直接返回。放行在 finally 里，任何出口（包括早退与异常）都不会把闸门
    // 永久锁上。
    while (entryGate) {
      gateWaits += 1;
      await entryGate;
      if (disposed) return snapshot();
    }
    entryGate = new Promise(function (resolve) { releaseEntryGate = resolve; });
    entryWaiters += 1;
    try {
      return await runGetTokInner(opts);
    } finally {
      entryWaiters -= 1;
      releaseEntryGateNow();
    }
  }
  async function runGetTokInner(opts) {
    // `background` marks an Auto tick. A click on Get is the user asking for a
    // refresh, so when no automatic path can produce one, this run opens the login
    // window itself and the capture arm finishes the chain — one click, no second
    // Get (2026-10-04, requirement A). A background tick never opens a window and
    // never reads a browser this plugin did not open (requirement B).
    const background = !!(opts && opts.background);
    // Only this run's answer object may be re-settled by the `finally` below.
    returnedOut = null;
    await ensureLoaded();
    if (disposed) return snapshot();
    // A click that lands while another run is in flight is not answered with a shrug: it
    // waits (bounded), then does its own work inside the same click. A background tick
    // never queues — the next tick comes anyway.
    let waitMs = 0;
    if (state.busy) {
      if (background) return snapshot();
      waitMs = await waitForIdleRun();
      if (disposed) return snapshot();
      if (state.busy) {
        writeTrace({ bg: false, via: 'busy', opened: 'none', waitMs: waitMs });
        try { await saveState(); } catch (e) {}
        const w = snapshot();
        w.detail = 'busy';
        w.loginRequired = false;
        w.loginOpened = 'none';
        w.err = '上一次处理还没结束，请等几秒再点一次 Get';
        return w;
      }
    }
    if (state.loginWait) {
      // A window of ours is already open and being watched: a second click (or a
      // tick) must not start a parallel run beside it. What is being watched decides what
      // may be said about it — a background browser has nothing on screen, so answering a
      // click with 「登录窗口已打开」 would promise a door the user cannot see
      // (2026-10-04 round 9, requirement B).
      const headlessWait = !!state.headless;
      // Which no-window carrier is being watched is named, not assumed: 'hidden' is the native
      // hidden page, 'headless' the built-in shell, and a click is answered with the same word
      // the trace and the ending sentence use (2026-10-04 round 10).
      const carrierWait = headlessWait ? (state.carrier === 'hidden' ? 'hidden' : 'headless') : 'already-open';
      writeTrace({ bg: background, via: 'waiting-login', opened: carrierWait, waitMs: waitMs });
      try { await saveState(); } catch (e) {}
      const w = snapshot();
      w.loginRequired = !headlessWait;
      w.loginOpened = carrierWait;
      w.detail = headlessWait ? 'processing-headless' : 'waiting-login';
      if (headlessWait) w.err = state.carrier === 'hidden' ? HIDDEN_HINT : HEADLESS_HINT;
      return w;
    }
    state.busy = true;
    // 闸门到此为止（第十七轮）：busy 已经立起来，后来者从这一刻起走既有的 busy / loginWait 分支。
    // 放行越早，闸门覆盖的窗口越小 —— 它要挡的只是"两个调用同时读到 busy=false"。外层 finally 里
    // 还有一次放行（早退、异常都靠它），两次是幂等的。
    releaseEntryGateNow();
    state.status = 'refreshing';
    state.err = '';
    transportFails = 0;
    transportOKs = 0;
    offlineFlag = false;
    // Facts for the trace, filled in as the ladder runs and written once in `finally`.
    const traceStart = deps.clock.now();
    let mintRung = 'fail';
    let ssoRung = 'skip';
    let viaName = '';
    let openedName = 'none';
    let expBeforeAt = 0;
    try {
      const old = state.token;
      expBeforeAt = state.tokenExpAt || jwtExpiry(old) || 0;
      let t = '';
      let via = '';
      let reusable = '';
      let tokenVerdict = null;
      const d = await mintCheck();
      if (disposed) { state.busy = false; return snapshot(); }
      if (d) { t = d; via = 'mint'; mintRung = 'ok'; }
      if (!t && state.token) {
        tokenVerdict = await authVerdict(state.token);
        if (disposed) { state.busy = false; return snapshot(); }
        // A token the server refused is not reusable; a token we merely could not
        // ask about (null) still is — an outage must never cost the user a login.
        // The verdict is bound to this exact token, so a later candidate cannot
        // inherit it (2026-10-04 audit, item 4).
        if (tokenVerdict === false) recordVerdict(false, state.token);
        else reusable = state.token;
      }
      if (!t) {
        // SSO replay with the persisted jar: the only automatic renewal left since
        // the site closed anonymous issuance, and the one the panel must be honest
        // about when the session behind it has expired. No browser is consulted
        // here — a merely running window is not a renewal path (requirement B).
        // Reset the step first: it has to label *this* attempt, and a stale label
        // would misattribute an unrelated failure to the double-auth form.
        lastSsoStep = '';
        const sso = await ssoReplay();
        if (disposed) { state.busy = false; return snapshot(); }
        ssoRung = sso ? 'ok' : 'fail';
        if (sso) { t = sso; via = 'sso'; }
      }
      // No automatic rung produced a fresh token.
      const renewalBroken = !t;
      if (!t && reusable) { t = reusable; via = 'reuse'; }
      // "Nothing got through at all" is a network fact, and it decides what may be
      // claimed afterwards: an unreachable site says nothing about the token. The bar is
      // "no answer, ever" — two answered requests mean the site is up, however slow one
      // round trip was, so a slow read can never turn itself into an outage verdict.
      // A higher bar (two unanswered requests) was written and then rejected: the one run
      // that can produce a single unanswered request is a fresh install with no token and no
      // saved session — where "nothing got through" is exactly the truth, and softening it
      // would hide a real outage behind "needs login" (2026-10-04 round 9).
      const offline = transportFails > 0 && transportOKs === 0;
      offlineFlag = offline;
      if (!t) {
        // Nothing usable at all. Why matters: an unreachable site is not a dead
        // session, and offering a login window while the network is down wastes
        // the user's time (transportOKs === 0 means nothing got through at all).
        state.refreshBlocked = !offline;
        state.loginReason = renewalReason(offline);
        state.status = offline ? 'error' : 'needs-login';
        state.err = offline ? OFFLINE_HINT
          : tokenVerdict === false ? REFUSED_HINT
            : (lastSsoStep === 'fingerprint-form' ? FINGERPRINT_HINT : RENEWAL_HINT);
        state.busy = false;
        try { await saveState(); } catch (e) {}
        const out = snapshot();
        out.via = 'none';
        viaName = 'none';
        out.fresh = false;
        out.offline = offline;
        out.loginOpened = 'none';
        out.loginRequired = !offline;
        if (!offline) await offerLogin(out, background);
        openedName = String(out.loginOpened || 'none');
        return settleOut(out);
      }
      // Ask the server about the candidate *before* it is allowed to replace anything:
      // only a token the site vouched for may overwrite a credential that still works.
      // An unreadable answer is not a yes — writing on "unknown" is how the store could
      // end up holding an unverified token while the panel reported a renewal
      // (2026-10-04 audit, item 4). A candidate identical to the token in hand reuses
      // the verdict already obtained above instead of asking twice.
      let verdict = null;
      if (t) {
        verdict = t === old && tokenVerdict !== null ? tokenVerdict : await authVerdict(t);
        if (disposed) { state.busy = false; return snapshot(); }
      }
      const oldExp = jwtExpiry(old);
      const oldUsable = !!old && old !== t && (tokenVerdict === true || oldExp > deps.clock.now());
      if (t && verdict !== true && oldUsable) {
        // The store keeps the credential that works and the candidate is reported for
        // what it is: refused (error) or unverifiable (partial). Nothing is written, no
        // provider is touched, and lastGetAt does not move — to the credential store this
        // run did not happen at all.
        state.storedUnchanged = true;
        state.lastVia = via;
        state.status = verdict === false ? 'error' : 'partial';
        state.err = (verdict === false ? REFUSED_HINT : UNVERIFIED_HINT) + '；' + KEPT_STORED_NOTE;
        if (verdict === false) {
          // The automatic path is provably refused, but the credential in hand still
          // works: record the block for the next attempt instead of throwing a login
          // window at a user whose setup is not broken (2026-10-04 audit, item 4).
          // Set before the save so the fact survives a restart, like every other block.
          state.refreshBlocked = true;
          state.loginReason = 'renewal-unavailable';
        }
        state.busy = false;
        try { await saveState(); } catch (e) {}
        const out = snapshot();
        out.fresh = false;
        out.via = via;
        viaName = via;
        out.detail = 'kept-stored';
        out.err = state.err;
        out.expiryAdvanced = false;
        out.loginRequired = false;
        out.loginOpened = 'none';
        return settleOut(out);
      }
      state.token = t;
      state.storedUnchanged = false;
      // Re-validating an old token does not mint a new lifetime. Preserve the original local
      // issuance baseline so Auto cannot run an aging token for another full interval.
      if (via !== 'reuse') state.lastGetAt = deps.clock.now();
      // "We fetched something" is not "we renewed". A session-bound token comes back
      // identical while the session lives, so compare expiries before claiming success
      // (2026-10-01: Auto reported success hourly while exp never moved, and the token
      // died at its original expiry). An undecodable token leaves the check unknown.
      // Only a source that actually handed a token over can be judged for "the
      // expiry did not move". A reuse is the absence of a renewal, not a failed
      // one: comparing the token we already had against itself would print
      // "续期未生效" on every tick for a token with hours of life left, and the
      // widget would sit amber forever — the same permanent false alarm the 0.3.1
      // sticky warning was. Reuse keeps the renewal note (refreshBlocked) instead.
      const renewAttempt = via !== 'reuse';
      const previousExp = state.tokenExpAt || 0;
      state.tokenExpAt = jwtExpiry(t);
      // expiryAdvanced 只表示一件事：本轮这张令牌的 exp **严格大于**本轮的 baseline。
      // 2026-10-04 第十二轮真机：reuse 那条路曾把它无条件写成 true，于是
      // fresh=false / via=reuse / expBefore==expAfter 的响应上也挂着"到期时间前进了"，
      // 而这个字段是给别人当判据用的。读不出 exp 时也不声称前进（不知道 ≠ 前进）。
      const expiryComparable = previousExp > 0 && state.tokenExpAt > 0;
      const expiryAdvanced = expiryComparable && state.tokenExpAt > previousExp;
      // 面板的绿/黄判的是"这轮有没有失败"：reuse 是"这轮没有续期"，不是"续期失败"，
      // 所以它不能靠 expiryAdvanced 表达（那个字段现在只说严格前进）。
      const renewalOk = renewAttempt ? (expiryAdvanced || !expiryComparable) : true;
      // A reuse is the absence of a renewal, so it must not touch this fact: clearing
      // it here would let a tick that renewed nothing erase a genuine "the expiry did
      // not move" finding from an earlier attempt (2026-10-04 review, risk 2).
      if (renewAttempt && expiryComparable) state.renewalNoProgress = !expiryAdvanced;
      state.minted = via === 'mint';
      state.lastVia = via;
      // mint / SSO / the capture arm hand over a token nobody has served yet: the server
      // was already asked above, so this only records it — bound to this token, and only
      // when the answer was definite (2026-10-04 review, risk 1 + audit item 4).
      recordVerdict(verdict, t);
      // "Written while the answer was unreadable" is a fact that has to survive a
      // restart, or the next load rounds it up to ok. A *trusted* yes from earlier in
      // this session still counts as verified.
      state.unverified = verdict === null && !(trustedVerdict() === true);
      // A token the site has refused is not "no progress on renewal": it is dead, and
      // saying "the expiry did not move" about it would be the milder of two wrong
      // stories.
      if (verdict === false) state.renewalNoProgress = false;
      // renewalBroken only annotates here: the token works, so the widget stays
      // green and the note lives in the hover text instead of a permanent warning.
      state.refreshBlocked = renewalBroken;
      state.loginReason = renewalBroken ? renewalReason(false) : '';
      const pw = await applyToProvider(t);
      state.provider = pw.provider;
      state.providerName = pw.providerName;
      state.syncDetail = pw.detail;
      state.credentialWritten = pw.credentialWritten;
      state.credentialPresent = pw.credentialPresent;
      state.err = pw.err || (renewalBroken
        ? (lastSsoStep === 'fingerprint-form' ? RENEWAL_FP_NOTE : RENEWAL_NOTE)
        : '');
      if (!pw.err) {
        if (verdict === false) state.err = REFUSED_HINT;
        else if (offline) state.err = OFFLINE_HINT;
        else if (verdict === null) state.err = UNVERIFIED_HINT;
        else if (renewAttempt && expiryComparable && !expiryAdvanced) state.err = RENEWAL_STALLED;
      } else if (offline) {
        state.err = OFFLINE_HINT + '；' + pw.err;
      }
      // Health follows facts, not one boolean: the server accepted the token (or we
      // could not ask), the credential store holds it, and the model config could be
      // written. A working token whose config could not be synced is "partial" —
      // anything reading MADMODEL_API_KEY still works, so calling that an outright
      // error is its own kind of lie (it is what the panel did for every release
      // before 0.3.7).
      if (verdict === false) state.status = 'error';
      else if (!pw.credentialPresent) state.status = 'error';
      else if (pw.err) state.status = 'partial';
      // A renewal nobody could verify is not a success we can vouch for: the token
      // changed and it is stored, but the server never said yes. That is "partial"
      // rather than "ok" — and rather than "error", because there is no evidence the
      // token is bad (2026-10-04: network failure is not a rejection).
      else if (verdict === null && renewAttempt) state.status = 'partial';
      else state.status = renewalOk ? 'ok' : 'no-progress';
      try { await saveState(); } catch (e) {
        // The token may be in the credential store and working, but nothing about this run
        // survives a restart. That is a state-file failure and it is said as one, instead of
        // being appended as a bare `state:` prefix that reads like a detail
        // (2026-10-04 round 9, requirement G).
        noteStateNotStored('run state', String((e && e.message) || e));
        if (state.status === 'ok') state.status = 'error';
      }
      state.busy = false;
      const out = snapshot();
      out.fresh = t !== old;
      out.via = via;
      viaName = via;
      out.loginRequired = false;
      out.detail = pw.detail;
      out.err = state.err;
      out.expiryAdvanced = expiryAdvanced;
      // A click that could not renew hands the user the one door still open — the
      // login window, opened right here inside the run they started. A background
      // tick only records the fact: an unattended machine must never stack windows
      // (2026-10-04 policy, requirement B). The token in hand stays usable either
      // way, so the widget does not turn into a warning while the user decides.
      if (renewalBroken) {
        const expAt = state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0);
        out.nearlyOut = !!expAt && (expAt - deps.clock.now()) <= RENEWAL_MARGIN_MS;
        out.detail = 'renewal-unavailable';
        if (!out.err) {
          state.err = out.nearlyOut ? RENEWAL_NOTE + '（令牌即将到期，点 Get 可打开登录窗口登录一次）' : RENEWAL_NOTE;
          out.err = state.err;
        }
        if (offline) {
          // A login window cannot fix an unreachable site: opening one would send the
          // user to log in for a problem logging in does not solve.
          out.loginRequired = false;
          out.loginOpened = 'none';
        } else {
          await offerLogin(out, background);
        }
      }
      openedName = String(out.loginOpened || 'none');
      return settleOut(out);
    } catch (e) {
      state.status = 'error';
      state.err = String((e && e.message) || e);
      state.busy = false;
      const out = snapshot();
      out.err = state.err;
      out.loginRequired = false;
      return settleOut(out);
    } finally {
      state.busy = false;
      // One trace per run, written after every path has settled: this is the record a
      // real-machine report can cite (rung, verdict, expiry delta, elapsed, window).
      writeTrace({
        bg: background, mint: mintRung, sso: ssoRung, reuse: viaName === 'reuse',
        verdict: trustedVerdict() === true ? 'yes' : trustedVerdict() === false ? 'no' : 'unknown',
        via: viaName || state.lastVia, expBefore: expBeforeAt, expAfter: state.tokenExpAt,
        ms: deps.clock.now() - traceStart, waitMs: waitMs, opened: openedName,
      });
      try { await saveState(); } catch (e) {
        // The run happened; its record did not reach the disk. Saying so is the whole
        // difference between "上次点击" showing this click and showing an older one.
        markTraceNotStored('run record', String((e && e.message) || e));
      }
      // The record this run just wrote belongs in the answer the caller gets, not only in the
      // file: an answer still carrying the previous run's trace is how 「上次点击」 ends up
      // describing a run the user did not just make (2026-10-04 real-machine audit).
      if (returnedOut) settleOut(returnedOut);
    }
  }
  async function resolveBrowser() {
    const local = String((deps.env && deps.env.localAppData) || '').replace(/[\\\/]+$/, '');
    const cands = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      local ? local + '\\Microsoft\\Edge\\Application\\msedge.exe' : '',
      local ? local + '\\Google\\Chrome\\Application\\chrome.exe' : '',
    ];
    for (const c of cands) {
      if (!c) continue;
      try { if (await deps.findExecutable(c)) return c; } catch (e) {}
    }
    return null;
  }
  /**
   * Ask the host for a native hidden page on the browser that was just started. This is the
   * carrier a click and a background run use when nothing may be on screen: a normal Edge
   * (not the headless shell) started with --no-startup-window, plus a page created through
   * CDP's `hidden + background` target. Machine-measured 2026-10-04 round 10: that page is
   * off screen, carries a normal Edge UA, and lives exactly as long as the connection that
   * created it (the closure probe watched it leave /json/list the moment that socket closed —
   * an earlier note claiming it never appears in /json/list was our own probe's ordering bug).
   *
   * A host that cannot offer one (an older build, or a browser that refuses the target) is
   * not an error to hide: the answer carries the browser's own reason and error code, so the
   * caller can say "the native carrier was unavailable, this run used the built-in headless
   * shell" instead of quietly becoming that older shell.
   */
  async function askHiddenTarget() {
    if (typeof deps.hiddenTarget !== 'function') return { ok: false, why: '载体未提供（host 不支持）' };
    try {
      // 15 s：真机读数是无窗口浏览器在「已用过的 profile」上约 3.1 s 才有第一个 DevTools 目标、
      // 约 9.4 s 才到 10 个（2026-10-04 第十二轮），12 s 太贴边。宿主侧也会等目标出现再建。
      const r = await deps.hiddenTarget({ port: cdpPort, url: SSO_LOGIN_URL, timeoutMs: 15000 });
      if (r && r.ok && r.targetId) return { ok: true, handle: r };
      const code = (r && r.error && r.error.code) ? ' code=' + String(r.error.code) : '';
      const msg = (r && r.error && r.error.message) ? ' ' + String(r.error.message) : '';
      // 读数（目标数、尝试次数）与实例身份一起交出去：面板说的必须是读到的东西，而回退要关的
      // 正是这台浏览器（2026-10-04 第十二轮——失败时曾经连身份都没有，于是关不掉也起不来）。
      const seen = (r && typeof r.targetsSeen === 'number') ? ' targets=' + String(r.targetsSeen) : '';
      const tried = (r && typeof r.attempts === 'number') ? ' attempts=' + String(r.attempts) : '';
      return { ok: false, why: String((r && r.reason) || 'unknown') + code + msg + seen + tried, browserId: String((r && r.browserId) || '') };
    } catch (e) {
      return { ok: false, why: 'error ' + String((e && e.message) || e) };
    }
  }
  /**
   * 这台浏览器的实例身份（/json/version 报出的 browser uuid）。刚 spawn 出来的端口可能还没应答，
   * 所以有界重试；它交出的字符串是 close 路径唯一认的证据。真机第十二轮那次回退之所以报
   * no-ownership-evidence、然后在同一个 profile 上被旧实例接管，就是因为走到 close 时
   * state.browserUuid 还是空的。
   */
  async function readOwnIdentity(port, tries, gapMs) {
    const n = Math.max(1, Number(tries) || 3);
    const gap = Math.max(0, Number(gapMs) || 250);
    for (let i = 0; i < n; i++) {
      try {
        const probe = await deps.cdp({ port: port, timeoutMs: 1500, probeOnly: true });
        if (probe && probe.ok && probe.browserId) return String(probe.browserId);
      } catch (e) {}
      if (i < n - 1 && gap) await slept(gap);
    }
    return '';
  }
  /**
   * Give up the hidden page. Its lifetime is the browser-level connection that created it
   * (measured: it survives a detach and dies with the socket), so giving up the page means
   * closing that socket — and this runs on every path that gives up the window, so no later
   * run can talk to a page that is already gone.
   */
  function releaseHiddenCarrier() {
    const h = hiddenHandle;
    hiddenHandle = null;
    if (!h || typeof h.close !== 'function') return { closed: false, reason: 'none' };
    try { return h.close(); } catch (e) { return { closed: false, reason: 'error' }; }
  }
  async function openLogin(opts) {
    const headless = !!(opts && opts.headless);
    // The carrier travels with the window: the capture that watches it finishes after this
    // request is over, and its record must still be able to say whether a click or an
    // unattended run asked for it (2026-10-04 real-machine audit).
    const background = !!(opts && opts.background);
    await ensureLoaded();
    if (disposed) { state.loginReason = 'disposed'; return { launched: false, reason: 'disposed' }; }
    if (state.browserOpen || state.loginWait) { state.loginReason = 'already-open'; return { launched: false, reason: 'already-open' }; }
    // Declared outside the try on purpose: the catch has to know whether a browser was
    // already spawned when the throw happened, or the cleanup would skip the one case it
    // exists for (2026-10-05 round 14 A).
    let spawnedThisRun = false;
    try {
      ensureBaseDir();
      const made = await deps.stateIO.mkdir(baseDir + '\\profile');
      if (!made || !made.ok) throw new Error('无法创建登录浏览器目录：' + String((made && made.error) || 'unknown error'));
      // 端口扫描：**升序一趟，遇到第一个空闲端口就停**（2026-10-05 第十七轮，旧实现见报告 §29）。
      // 三条规则：
      //   · 端口上答的是我们自己起过的实例（身份只可能来自内存里的认领或盘上的 lease，两处都是
      //     本插件亲手从 /json/version 读回来的）⇒ 认领它：先用证据关掉、确证端口安静，再用它；
      //   · 端口上答的是别人 ⇒ 记一句读数（哪个端口、身份读出来了没有）继续往下看，**不读它的
      //     页面、不关它、也不因此失败** —— 这正是 2026-10-05 那次"先手动关掉那台浏览器再点
      //     Get"的死路，而 9334 明明空着；
      //   · 什么都不在听 ⇒ 就是它。
      // 一个自己抛异常的端口不算"空着"：不知道那上面有什么，就不把浏览器往上放；也不该让整次
      // openLogin 变成一句 `reason:'error'`（2026-10-05 真机那次点击就是这样把全部读数丢光的）。
      state.portNote = '';
      state.carrierProfile = '';
      state.portStrangers = 0;
      state.carrierPort = 0;
      const probeErrors = [];
      const leaseNow = leaseForDisk();
      // 哪几台算"我们的"：只能是本插件自己记录过的身份（内存里的认领 + 盘上的 lease + 上一次
      // 关不掉、但身份已经证实过的那台残留）。身份是唯一的证据 —— 端口、profile、pid 都不是。
      const ours = [];
      for (const known of [
        String(state.browserUuid || ''),
        String((leaseNow && leaseNow.uuid) || ''),
        String((state.portLeftover && state.portLeftover.id) || ''),
      ]) {
        const id = known.toLowerCase();
        if (id && ours.indexOf(id) === -1) ours.push(id);
      }
      const probe = function (port) { return deps.cdp({ port: port, timeoutMs: 1200, probeOnly: true }); };
      const pick = await pickCarrierPort({ start: CDP_PORT_START, end: CDP_PORT_END, ours: ours, probe: probe });
      if (disposed) return { launched: false, reason: 'disposed' };
      const strangers = (pick.strangers || []).slice();
      for (const line of (pick.errors || [])) probeErrors.push(line);
      let usedPort = 0;
      let claimWhy = '';
      if (pick.claim) {
        const port = pick.claim.port;
        // 身份对得上，是"这一台是我们起的"最硬的证据：uuid 只可能来自我们自己起过、并且自己
        // 读过 /json/version 的那台浏览器。进程重启之后 browserMine 会是 false，而端口上那台
        // 确实还在 —— 这时再拿 browserMine 当门闩，就等于永远关不掉上一轮留下的那一台
        // （2026-10-05 真机：宿主 00:50 重启，00:51 起的自有 Edge 活了一整夜，之后每一次 Auto
        // 都起不来）。所以先用身份把认领写回去，再让 closeOwnWindow 用它自己的四道门去关它。
        state.browserMine = true;
        state.browserPort = port;
        // 身份是从端点读来的，就该写回 state：认领之后紧接着的那次关闭是靠身份过闸的
        // （2026-10-05 第十七轮：残留的身份存在 portLeftover 里、内存里的 browserUuid 是空的，
        // 不写回就等于"拿着证据却空着手去关门"，closer 只能退到进程表判据）。
        state.browserUuid = String(pick.claim.id || state.browserUuid || '');
        // Give the close the pid the lease remembers: with the debug endpoint answering but the
        // graceful close failing, that pid is what the process-table fallback verifies before it
        // stops anything (round 14 A). 只有"描述同一台、同一条端口"的那份 lease 里的 pid 才算数：
        // state.browserPid 可能是上一轮留下的旧值，而 pid 会被复用 —— 身份对得上、pid 对不上时，
        // 宁可只按身份关，也不把一个没证据的 pid 交出去。
        state.browserPid = leaseNow && leaseNow.port === port && leaseNow.pid ? Number(leaseNow.pid) : 0;
        const closedLeftover = await closeOwnWindow('leftover-own');
        if (closedLeftover && closedLeftover.closed === true) {
          usedPort = port;
          // 确证关掉了：那条"关不掉的残留"的证据到此为止（下一轮不必再认它）。
          state.portLeftover = null;
        } else {
          // 关不掉就不再停在原地（第十七轮的修正）：不再返回 carrier-blocked 让用户去手动关，
          // 而是换一条端口、用本次自己的独立 profile 继续 —— 那一台原样留着，lease 不动，
          // 之后还能用同一个证据再关它一次（停止脚本也行）。
          claimWhy = String((closedLeftover && closedLeftover.reason) || 'unconfirmed');
          logger.error('[thu-tok-auto] our own leftover browser on port ' + port + ' could not be confirmed closed (' + claimWhy + '): leaving it alone and using another port with a private profile');
          state.browserMine = false;
          state.browserPort = port;
          state.browserPid = 0;
          // 身份留着：下一次运行（和停止脚本）还能用同一个证据再关它一次。
          state.browserUuid = pick.claim.id || state.browserUuid;
          // 而且留在一个专门的字段里。browserUuid 会被下面本次新起的载体覆盖（它记的是"我正在
          // 驱动哪一台"），若只靠它，这台关不掉的残留下一轮就变成了"端口上不认识的浏览器"，
          // 再也关不掉（旧代码就是这样把它变成永久住户的）。
          state.portLeftover = {
            port: port,
            id: String(pick.claim.id || state.browserUuid || '').toLowerCase(),
            pid: Number(leaseNow && leaseNow.port === port && leaseNow.pid ? leaseNow.pid : 0) || 0,
            why: claimWhy,
            at: deps.clock.now(),
            // Its profile, when the lease that described it is about the same browser: the stop
            // script uses it to drop a one-run directory after the close is proven. Never a claim —
            // a directory on its own has never identified anything in this plugin.
            profile: leaseNow && leaseNow.port === port ? String(leaseNow.profile || '') : '',
          };
          const second = await pickCarrierPort({ start: CDP_PORT_START, end: CDP_PORT_END, ours: ours, skip: [port], probe: probe });
          if (disposed) return { launched: false, reason: 'disposed' };
          for (const line of (second.errors || [])) probeErrors.push(line);
          for (const other of (second.strangers || [])) strangers.push(other);
          // 第二个端口上又是我们自己的实例（同一个身份不可能在两处答，真出现就绝不能往上放）
          // ⇒ 当作没有可用端口。
          usedPort = second.claim ? 0 : (second.port || 0);
        }
      } else {
        usedPort = pick.port || 0;
      }
      if (!usedPort) {
        state.status = 'error';
        state.browserOpen = false;
        state.loginWait = false;
        state.browserMine = false;
        state.browserPort = 0;
        state.browserPid = 0;
        state.portStrangers = strangers.length;
        const whose = strangers.length
          ? '；有 ' + strangers.length + ' 个端口上答的是别的浏览器（身份 ' + (strangers[0].id || '读不出') + '），本插件没有读也没有动它们'
          : '';
        const broken = probeErrors.length ? '；其中 ' + probeErrors.length + ' 个端口探测时报错，第一个是 ' + probeErrors[0] : '';
        state.err = '调试端口 ' + CDP_PORT_START + '-' + CDP_PORT_END + ' 均被占用' + whose + broken;
        state.loginReason = 'no-debug-port';
        return { launched: false, reason: 'no-debug-port', port: 0, note: state.err };
      }
      // 这一次要不要离开共享 profile？（第十七轮）三种情况必须离开，否则新浏览器根本起不来：
      // 端口上有别人（那台很可能正持着共享 profile）、我们自己的残留没能确证关闭、或者进程表
      // 直接说共享 profile 已经被某个浏览器进程持有 —— Chromium 的单例会把新 argv 交给已在跑
      // 的那台，我们要的端口永远不会应答。隔离目录在 baseDir 下、名字以 `run-` 开头，只属于
      // 本次 spawn，确证关闭之后会被删掉（共享 profile 永不删）。
      // 进程表读不到时保持旧行为：不该因为一次读失败就把 UX 永久降级成"每次都用新 profile"。
      let carrierProfile = 'shared';
      let isolateWhy = '';
      if (strangers.length) isolateWhy = 'strangers';
      else if (claimWhy) isolateWhy = 'leftover-not-closed';
      else if (!pick.claim) {
        let held = null;
        try {
          if (typeof deps.listBrowserProfiles === 'function') held = await deps.listBrowserProfiles();
        } catch (e) {
          held = { ok: false, error: String((e && e.message) || e) };
        }
        if (held && held.ok === true && (held.dirs || []).indexOf(normalizePath(sharedProfilePath(baseDir))) !== -1) isolateWhy = 'shared-profile-held';
      }
      const carrierSpawnId = newSpawnId();
      const profileDir = isolateWhy ? isolatedProfilePath(baseDir, carrierSpawnId) : sharedProfilePath(baseDir);
      if (isolateWhy) carrierProfile = 'isolated';
      cdpPort = usedPort;
      const browser = await resolveBrowser();
      if (!browser) {
        state.status = 'error';
        state.err = '未找到 Edge/Chrome';
        state.loginReason = 'no-browser';
        return { launched: false, reason: 'no-browser' };
      }
      // 隔离 profile 是本次 spawn 自己的目录：起之前先把它建出来（共享 profile 那个在上面
      // 已经建过/存在了，这里只建 run-* 这一种）。建不出来就当这次失败说清楚，不硬起。
      if (carrierProfile === 'isolated') {
        const madePrivate = await deps.stateIO.mkdir(profileDir);
        if (!madePrivate || !madePrivate.ok) throw new Error('无法创建本次运行的临时浏览器目录：' + String((madePrivate && madePrivate.error) || 'unknown error'));
      }
      // Which carrier this is (2026-10-04 round 10, revised 2026-10-05 round 13). Only the
      // "nobody may see a window" paths reach this function with `headless` set, and they get
      // the built-in shell. The native hidden page — a normal Edge started with
      // --no-startup-window whose device page is created as a CDP `hidden+background` target —
      // is NOT a candidate any more, and not because of a host capability question: Chromium
      // only allows Target.createTarget{hidden:true} once the browser already owns a frame
      // target, and a browser started without a startup window never has one. Measured on the
      // live instance: /json/list answered 0 targets; the production-argv probe saw frame=0
      // across 20 s. The price of trying anyway was real — a throwaway browser plus a
      // "could not prove it closed" round, which is how the leftover browser of round 12 was
      // born. The hidden implementation and its seam stay (probes and fixtures drive them
      // directly), but production does not take that road: requirement B wants an honest
      // no-window path that works, not a hope.
      const canHidden = false;
      let carrier = headless ? 'headless' : 'window';
      if (headless && !carrierDepLogged) {
        carrierDepLogged = true;
        logger.log('[thu-tok-auto] no-window renewal uses the built-in headless shell only: a browser started without a startup window owns no frame target, so the native hidden page cannot be created at all');
      }
      const commonArgv = [
        '--remote-debugging-port=' + cdpPort,
        '--user-data-dir=' + profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-session-restore',
      ];
      // The visible window is the only carrier that gets a URL on the command line: both
      // no-window carriers have their page created over CDP instead. Which no-window shape it
      // is matters, though — the native carrier starts a normal browser with no UI at all,
      // the fallback asks for the built-in shell (2026-10-04 round 10).
      const argvFor = function (which) {
        if (which === 'window') return commonArgv.concat([SSO_LOGIN_URL]);
        if (which === 'hidden') return commonArgv.concat(['--no-startup-window']);
        // 无窗口载体从一张白页起步，再由 CDP **送**到登录入口 —— 而且是先把已保存的会话写回去、
        // 再导航（2026-10-05 第十六轮）。直接把入口写在命令行上，正是无头壳永远"没有会话"的原因：
        // 能读懂 cookieJar 的只有插件自己，没有这一步就没人把它交给浏览器。
        // 没有 sessionRestore 这条腿时保持旧行为（命令行直达入口），否则会停在一张白页上。
        const home = deps.sessionRestore ? 'about:blank' : SSO_LOGIN_URL;
        return commonArgv.concat(['--headless=new', '--disable-gpu', '--window-size=1280,900', home]);
      };
      let argv = argvFor(carrier);
      let launched = await deps.spawnBrowser(browser, argv);
      // Record what this process started before anything else can look at it: the
      // cleanup path keys off exactly these three facts, and an uninstall landing in
      // the middle of the spawn must still be able to find the window (requirement C).
      state.browserMine = true;
      state.browserPort = cdpPort;
      state.browserPid = Number((launched && launched.pid) || 0);
      state.browserUuid = '';
      state.carrierNote = '';
      // 这一轮的读数写进 state（第十七轮）：哪条端口拿到了、路上有几台别人的浏览器、用的是共享
      // profile 还是本次自己的隔离 profile。它会进 state.json、snapshot 和 trace —— 出了事
      // 只有一个地方能回答"刚才那台起在哪个 profile 上"。
      state.portStrangers = strangers.length;
      state.carrierPort = cdpPort;
      state.carrierProfile = carrierProfile;
      state.portNote = carrierPortNote({ used: cdpPort, strangers: strangers, claim: pick.claim, claimWhy: claimWhy, isolateWhy: isolateWhy });
      // …and put the lease on disk in the same breath (2026-10-05 round 14 A). Between the
      // spawn and the identity read there is a window where this process knows the pid, the
      // port and the profile directory but not the browser's instance id — if it died right
      // there, an in-memory-only record would leave a browser nobody could ever claim again
      // (that is how the 2026-10-05 00:51 leftover was born). An awaited write is worth the
      // millisecond here: it is the only copy that survives this process.
      openLease(browser, cdpPort, launched.pid, profileDir);
      spawnedThisRun = true;
      await persistLease('spawn');
      let handle = null;
      // Why this run is not on the native carrier, if it is not. It is held here rather than
      // written straight to state because closing the first browser is what clears
      // state.carrierNote: the note has to be written after the fallback is up, or the
      // browser's own words are lost on the way and the panel is left claiming a carrier it
      // never got (2026-10-04 round 10, found by the fixture for this path).
      let fallbackNote = '';
      // 一个不起载体、但把话说清楚的出口：没有窗口在跑，所以 carrier 留空，读数全在 err 里。
      // 身份**不再**在这里清掉（2026-10-05）：它是"端口上那台是我们的"唯一证据，清掉以后那
      // 一台就永远认不回来，只能请用户自己去找进程（真机 PID 7560 活了一整夜就是这样）。
      // 拒绝采用陌生浏览器靠的是身份不一致（端口扫描里比出来的），不再靠"这里清空"。
      const blocked = function (note, reason) {
        state.browserOpen = false;
        state.loginWait = false;
        state.headless = headless;
        state.carrier = '';
        state.carrierNote = note;
        state.status = loadedStatus();
        state.loginReason = reason;
        // 一句读数（端口/身份/浏览器的 code）+ 一句该怎么办。这里不再叠一句归类的话
        // （「登录窗口未能打开」），同一件事说两遍会把真正有用的读数淹掉。
        // 第十七轮：连"上一台关不掉"也不再是不可重试的 —— 重试会先再关它一次，关不掉就换端口
        // 与独立 profile 继续，所以这里只补一句「重试会怎么做」，不再让用户去手动关浏览器。
        const act = reason === 'carrier-blocked' ? '；重试会先再试一次关闭它，关不掉就换一条端口与本次自己的隔离 profile 继续' : '';
        state.err = withPortNote(note + act);
        return { launched: false, reason: reason, carrier: '', port: cdpPort, note: state.err };
      };
      // 先学这台浏览器的身份，再谈隐藏页：它是 close 路径唯一认的证据。真机第十二轮那次
      // no-ownership-evidence 就是因为走到回退时 state.browserUuid 还是空的（端口刚 spawn
      // 出来还没应答，而旧代码只在非 hidden 分支里取它）。
      const bornWith = await readOwnIdentity(cdpPort);
      if (bornWith) { state.browserUuid = bornWith; leaseLearned(bornWith); await persistLease('identity'); }
      if (carrier === 'hidden') {
        const asked = await askHiddenTarget();
        if (asked.ok) {
          handle = asked.handle;
          // The hidden page's browser carries the same instance identity the close path
          // demands; it came from the same /json/version endpoint, so it is asked for once.
          state.browserUuid = String(asked.handle.browserId || '') || state.browserUuid;
          leaseLearned(asked.handle.browserId);
          await persistLease('identity');
        } else {
          // Not "there is no browser": this carrier is unavailable, and the browser's own
          // words are the reason. The failure carries the instance identity the host read from
          // the same endpoint, so this browser can be closed **with evidence** — and only if
          // that close is confirmed may another one be started in the same profile.
          if (asked.browserId) { state.browserUuid = String(asked.browserId); leaseLearned(asked.browserId); await persistLease('identity'); }
          fallbackNote = CARRIER_FALLBACK_NOTE + '（' + asked.why + '）';
          logger.log('[thu-tok-auto] the native hidden carrier is unavailable: ' + asked.why + '; falling back to the built-in headless shell');
          const closedFirst = await closeOwnWindow('carrier-fallback');
          if (!closedFirst || closedFirst.closed !== true) {
            // 实测的接管：端口 + profile 被旧实例占着时，第二台 launcher 自己 exitCode 0 退出、
            // 端口继续答旧 uuid ⇒ 第二个载体根本没诞生，随后 browserId 变化被读成 'gone'，现象
            // 与原因完全脱节。所以没有确证关掉就不在同一个 profile 上再 spawn 一台。
            const why = String((closedFirst && closedFirst.reason) || 'unconfirmed');
            logger.error('[thu-tok-auto] the native carrier failed and the browser it started could not be confirmed closed: ' + why);
            const whom = String(bornWith || (asked && asked.browserId) || '读不出');
            return blocked(fallbackNote + '；' + CARRIER_STUCK_NOTE + '（' + why + '，身份 ' + whom + '）', 'carrier-blocked');
          }
          if (disposed) return { launched: false, reason: 'disposed' };
          carrier = 'headless';
          launched = await deps.spawnBrowser(browser, argvFor('headless'));
          state.browserMine = true;
          state.browserPort = cdpPort;
          state.browserPid = Number((launched && launched.pid) || 0);
          state.browserUuid = '';
          // The second spawn gets its own lease for the same reason the first one did: it is a
          // browser this process started, and the identity read below can still fail. It stays in
          // the same profile directory the first one was given — a native carrier that failed to
          // create its page wrote nothing worth keeping, and a second directory would only be one
          // more thing to clean up (round 17).
          openLease(browser, cdpPort, launched.pid, profileDir);
          await persistLease('fallback-spawn');
          // Now that the close behind us can no longer clear it, the reason this run fell back
          // is put where the panel and the snapshot read it.
          state.carrierNote = fallbackNote;
          const secondId = await readOwnIdentity(cdpPort);
          if (secondId) { state.browserUuid = secondId; leaseLearned(secondId); await persistLease('identity'); }
          if (secondId && bornWith && secondId === bornWith) {
            // 同一个身份 ⇒ 端口仍被刚才那台占着（或它又回来了）：不读陌生实例的页面，也不
            // 假装这个载体起来了。留下的证据就是这两个相同的 uuid —— 它连同读数一起进
            // err / carrierNote，因为这是「为什么不再往下走」的唯一凭据。
            logger.error('[thu-tok-auto] the fallback spawn did not produce a new instance (same uuid ' + secondId + ')');
            return blocked(fallbackNote + '；' + CARRIER_TAKEOVER_NOTE + '（身份 ' + secondId + '）', 'carrier-blocked');
          }
        }
      }
      if (carrier !== 'hidden' && !state.browserUuid) {
        // Learn the browser's own instance id from its debug endpoint — the one piece of
        // evidence that outlives a recycled port or pid, and the thing the close path
        // demands. It is asked for once, right here: asking at close time would let
        // whatever holds the port by then identify itself as ours (2026-10-04 audit,
        // defect 1). readOwnIdentity already tried above; this is the single-shot backstop
        // for the carriers whose browser answers a little later.
        try {
          const probe = await deps.cdp({ port: cdpPort, timeoutMs: 1500, probeOnly: true });
          if (probe && probe.ok && probe.browserId) { state.browserUuid = String(probe.browserId); leaseLearned(probe.browserId); await persistLease('identity'); }
        } catch (e) {}
      }
      // 把已保存的会话交回这台浏览器（2026-10-05 第十六轮）。只在无窗口载体上做，而且必须等身份
      // 学到手之后：sessionRestore 第一步就是拿 /json/version 的实例身份和本次 lease 对齐，对不上
      // 就连一个 cookie 都不发。失败是一个**有名字**的出口：白页上的浏览器不会自己走到入口，
      // 与其让捕获等到超时、把"没恢复成功"说成"登录超时"，不如在这里说清楚并且只关自己这一台。
      if (carrier === 'headless' && deps.sessionRestore) {
        const restored = await restoreOwnSession(cdpPort);
        if (!restored.ok) {
          const why = String(restored.reason || 'unknown');
          const closed = await boundedClose('restore-failed');
          const said = (closed && closed.closed === true)
            ? '；本次启动的浏览器已确证关闭'
            : '；本次启动的浏览器未能确证关闭（' + String((closed && closed.reason) || 'unconfirmed') + '），可用停止脚本再关一次';
          state.browserOpen = false;
          state.loginWait = false;
          state.headless = headless;
          state.carrier = '';
          state.carrierNote = '';
          state.status = loadedStatus();
          state.loginReason = 'session-restore-failed';
          state.err = '无窗口续期没能把已保存的会话交给浏览器（' + why + '，已交 ' + String(Number(restored.sent) || 0) + ' 条）' + said;
          logger.error('[thu-tok-auto] sso session restore refused: ' + JSON.stringify({
            reason: why, host: String(restored.host || ''), sent: Number(restored.sent) || 0,
            failed: Array.isArray(restored.failed) ? restored.failed.slice(0, 8) : [],
          }));
          return { launched: false, reason: 'session-restore-failed', detail: why, carrier: '', port: cdpPort, note: state.err };
        }
      }
      // Only the hidden carrier owns a socket; the other two must not leave a stale one behind.
      if (handle) { releaseHiddenCarrier(); hiddenHandle = handle; }
      if (disposed) {
        await boundedClose('dispose');
        return { launched: false, reason: 'disposed' };
      }
      state.browserOpen = true;
      state.loginWait = true;
      state.headless = headless;
      state.carrier = carrier;
      state.status = headless ? 'processing' : 'waiting-login';
      state.err = withPortNote(headless ? (carrier === 'hidden' ? HIDDEN_HINT : HEADLESS_HINT) : LOGIN_WAIT_HINT);
      if (state.carrierNote) state.err = state.err + '；' + state.carrierNote;
      state.loginReason = '';
      startCapture({ headless: headless, background: background, carrier: carrier });
      return { launched: true, pid: state.browserPid, browser: browser, port: cdpPort, carrier: carrier };
    } catch (e) {
      state.status = 'error';
      state.loginReason = 'error';
      // A throw must not leave a browser of ours standing (2026-10-05 round 14 A). Everything
      // above can fail *after* a window was started — the identity read, the hidden carrier,
      // the fallback spawn — and the old code answered `error` without touching it, so the
      // browser outlived the run and the next run met its own leftover on the port.
      let cleanup = '';
      let closedNow = null;
      if (spawnedThisRun) {
        closedNow = await boundedClose('error');
        cleanup = closedNow && closedNow.closed === true
          ? '；已关闭本次启动的浏览器（' + String(closedNow.via || 'cdp') + '）'
          : '；本次启动的浏览器未能确认关闭（' + String((closedNow && closedNow.reason) || 'unconfirmed') + '），证据已留下，可用停止脚本再关一次';
      }
      state.err = String((e && e.message) || e) + cleanup;
      // A confirmed close retires the lease in memory; the disk has to learn that too, or the
      // next process would go looking for a browser that is already gone (2026-10-05 round 14 A).
      if (closedNow && closedNow.closed === true) await persistLease('error-cleanup');
      // `note` is what the click keeps: without it the caller replaces this whole line with a
      // category sentence and both the real error and what became of the browser disappear
      // (2026-10-05 round 14 A — the same clobbering the port reading once suffered).
      return { launched: false, reason: 'error', err: state.err, note: state.err };
    }
  }
  function startCapture(opts) {
    if (disposed || captureDispose) return;
    // A headless renewal gets a minute, not twenty: nobody is watching that window, and
    // the device page either finishes on its own or it never will (2026-10-04, round 5).
    captureHeadless = !!(opts && opts.headless);
    captureBg = !!(opts && opts.background);
    // Which carrier is being watched, for the record and for every sentence about it. The
    // hidden carrier and the headless fallback are both "no window", but they are not the
    // same thing, and the trace has to be able to tell them apart afterwards (2026-10-04
    // round 10).
    captureCarrier = String((opts && opts.carrier) || (captureHeadless ? 'headless' : 'window'));
    captureTimeoutMs = captureHeadless ? HEADLESS_TIMEOUT_MS : CAPTURE_TIMEOUT_MS;
    captureStartedAt = deps.clock.now();
    captureBaseline = state.token;
    captureVerdict = trustedVerdict();
    captureSawSame = false;
    // A fresh escalation budget and a fresh page reading for this capture: the visible
    // capture an escalation opens must never be able to escalate again, and yesterday's page
    // must not be quoted as today's evidence (2026-10-04 round 9, requirement A).
    captureEscalated = false;
    captureProbe = null;
    captureProbeLogged = false;
    // A fresh record for this capture. `opened` says whether the window being watched is
    // this plugin's own; the rungs are filled in as they answer (2026-10-04 audit, P1).
    captureFacts = {
      via: 'none', mint: 'skip', sso: 'skip', reuse: 0, verdict: 'unknown',
      expBefore: state.tokenExpAt || 0, expAfter: 0,
      opened: captureHeadless ? (captureCarrier === 'hidden' ? 'hidden' : 'headless') : (state.browserMine ? 'launched' : 'reuse'),
      carrier: captureCarrier,
    };
    const iv = deps.timer.interval(async function () {
      if (disposed) return;
      const captureElapsed = deps.clock.now() - captureStartedAt;
      if (captureElapsed > captureTimeoutMs) { await stopCapture('timeout'); return; }
      if (captureBusy) return;
      captureBusy = true;
      try {
        // The hidden carrier is read through the socket that created the page, because the
        // page's life is bound to that socket: losing it means the page is gone, not that the
        // browser is slow (2026-10-04 round 10 machine fact, re-measured by the closure probe:
        // the moment the socket closes the target leaves /json/list and the read answers
        // `hidden-gone`).
        const r = await deps.cdp({
          port: cdpPort, timeoutMs: 20000, probePage: captureHeadless,
          // Which instance this poll is supposed to be reading. Stated before the read, so the
          // reader checks the live /json/version answer *before* it opens a page or asks for
          // cookies — an unverified read is how a takeover gets read as if it were ours
          // (2026-10-05 round 18). The check below stays as the second line of defence.
          uuid: state.browserUuid,
          hidden: captureCarrier === 'hidden' ? hiddenHandle : null,
        });
        if (disposed) return;
        if (r && r.ok) {
          // What this page really is, once per capture, bounded and de-identified: without it
          // a 60 s timeout cannot say whether the browser stood on the login form, on the
          // device-confirmation page, or on nothing at all (2026-10-04 round 9, requirement D).
          if (r.page) noteCapturePage(r.page);
          // The debug port can be taken over by a different browser instance between two
          // polls. Compare the DevTools instance id we recorded at spawn time with the
          // one answering now: if they differ, this is somebody else's window, so we walk
          // away without touching anything (2026-10-04 audit, defect 1).
          if (r.browserId && state.browserMine && state.browserUuid && r.browserId !== state.browserUuid) {
            logger.error('[thu-tok-auto] the debug port now answers as a different browser; not closing it');
            await stopCapture('gone');
            return;
          }
          // 2026-10-05 round-18 audit: a read now always carries a verified identity, so this
          // line can only be reached through the hidden page handle, whose own id the reader
          // checked. It is not a way to learn who a browser is by reading it.
          if (r.browserId && state.browserMine && !state.browserUuid) state.browserUuid = r.browserId;
          let done = '';
          // Keep every cookie the browser holds; the header for each request is
          // built per URL from this jar (see cookieHeaderFor).
          const merged = mergeCookies(r.cookies);
          const cookie = cookieHeaderFor(SITE + '/model-api/auth-login');
          const sh = cookieHeaderFor(SSO_LOGIN_URL);
          if (cookie) state.cookies = cookie;
          if (sh) state.ssoCookies = sh;
          // 读到的新 cookie 也要落盘：会话是"下一次运行"的材料，而这一轮的点击早就存过盘了。
          // 只留在内存里的话，宿主一重启，刚从窗口里拿到的会话就没了（2026-10-05 发现：这一
          // 轮捕获臂只在真正写成功/主动放弃时才存盘，而"还没等到 token"的那几轮什么都没存）。
          // saveState 自带"没变就不写"的判据（cookieJar 在 stamp 里），所以每个轮询都调它
          // 并不会反复写盘。
          if (merged > 0) {
            try { await saveState(); } catch (e) { noteStateNotStored('capture cookies', String((e && e.message) || e)); }
          }
          let token = '';
          let via = '';
          if (r.token) {
            const valid = await authVerdict(r.token, cookie);
            if (disposed) return;
            if (valid === true) { token = r.token; via = 'login'; }
          }
          if (!token) {
            // 这里以前会自己再问一遍 SSO（ssoReplay），每次轮询一次；它命中票据时会在兑换点
            // 签发新令牌 —— 一次成功的人工登录旁边挂着一次没人要求的换票。`mintCheck` 同样
            // 每秒问一次签发接口（2026-10-05 审计：成功路径上的额外探测，副作用无法排除）。
            // 捕获臂现在只做它该做的事：读页面。事实从已经量过的地方来 —— 梯子刚把
            // lastSsoStep 写在手上，捕获只记录它，不再自己探。
            if (captureFacts) {
              captureFacts = Object.assign(captureFacts, {
                via: 'none',
                mint: 'not-tried',
                sso: lastSsoStep ? ('ladder:' + lastSsoStep) : 'ladder:none',
              });
            }
          }
          if (token) {
            // One ask, before anything is written: the candidate has to be vouched for
            // by the server before it may replace a credential that still works, and the
            // window may not be closed on a login that has not produced anything new
            // (2026-10-04 audit, items 4 and 5).
            const verdict = await authVerdict(token, cookie);
            if (disposed) return;
            const beforeExp = jwtExpiry(captureBaseline);
            const baselineUsable = !!captureBaseline && captureBaseline !== token
              && (captureVerdict === true || beforeExp > deps.clock.now());
            const fresh = !captureBaseline || token !== captureBaseline;
            if (verdict !== true && baselineUsable) {
              // The store keeps the credential that works and the candidate is reported
              // for what it is. Watching on would only hold a window open for a login
              // that cannot be turned into a verified renewal.
              state.storedUnchanged = true;
              state.status = verdict === false ? 'error' : 'partial';
              state.err = (verdict === false ? REFUSED_HINT : UNVERIFIED_HINT) + '；' + KEPT_STORED_NOTE;
              // The click's record still has to name the rung that brought the candidate
              // in, even though nothing was written with it (2026-10-04 audit, P1).
              captureFacts = Object.assign(captureFacts || {}, {
                via,
                mint: via === 'capture-mint' ? 'ok' : 'skip',
                sso: via === 'capture-sso' ? 'ok' : 'fail',
                verdict: verdict === true ? 'yes' : (verdict === false ? 'no' : 'unknown'),
                expBefore: state.tokenExpAt || 0,
                expAfter: 0,
              });
              done = 'kept';
            } else if (!fresh) {
              // Same token as when the window opened: the user has not finished logging
              // in, or the page has not written the new token yet. Keep watching; the
              // window stays exactly where it is (2026-10-04 audit, item 5).
              if (verdict === true) captureVerdict = true;
              if (!captureSawSame) {
                captureSawSame = true;
                logger.log('[thu-tok-auto] the window still holds the same token; waiting for the login to finish');
              } else if (captureHeadless) {
                // Nobody is going to log in to a window with nothing on screen: a second
                // sighting of the same token after the device page has had its turn means
                // this route cannot move the expiry. Say exactly that, keep the credential
                // that works, and close the browser (2026-10-04, round 5).
                state.renewalNoProgress = true;
                state.status = 'no-progress';
                state.err = HEADLESS_STALLED;
                captureFacts = Object.assign(captureFacts || {}, {
                  via: 'none',
                  verdict: verdict === true ? 'yes' : (verdict === false ? 'no' : 'unknown'),
                  expBefore: state.tokenExpAt || 0,
                  expAfter: 0,
                });
                done = 'kept';
              }
            } else {
              // The window has done its job: say so before the write chain, which may
              // take a while, so the panel shows "处理中" instead of still "等待登录".
              state.status = 'processing';
              // Same "did the expiry actually move?" rule as the ladder.
              const previousExp = state.tokenExpAt || 0;
              state.token = token;
              state.lastGetAt = deps.clock.now();
              state.tokenExpAt = jwtExpiry(token);
              // Same "did the expiry actually move?" rule as the ladder — and the same
              // correction (2026-10-04 round 12): this field means strictly greater than
              // this round's baseline, and "cannot be compared" is not "advanced".
              const expiryComparable = previousExp > 0 && state.tokenExpAt > 0;
              const expiryAdvanced = expiryComparable && state.tokenExpAt > previousExp;
              if (verdict === false) state.renewalNoProgress = false;
              else if (expiryComparable) state.renewalNoProgress = !expiryAdvanced;
              state.minted = via === 'capture-mint';
              // Same three-state rule as the ladder: only a definite answer is recorded,
              // and it is bound to this token.
              recordVerdict(verdict, token);
              state.unverified = verdict === null && !(trustedVerdict() === true);
              state.storedUnchanged = false;
              const pw = await applyToProvider(token);
              state.provider = pw.provider;
              state.providerName = pw.providerName;
              state.syncDetail = pw.detail;
              state.credentialWritten = pw.credentialWritten;
              state.credentialPresent = pw.credentialPresent;
              state.err = pw.err || (verdict === false ? REFUSED_HINT : (verdict === null ? UNVERIFIED_HINT : ''));
              // Same three-fact health rule as the ladder (server verdict, credential
              // present, config written) so both arms agree on what "ok" means.
              if (verdict === false || !pw.credentialPresent) state.status = 'error';
              else if (pw.err) state.status = 'partial';
              // The capture arm always produced a new token (that is what "captured"
              // means), so an unverifiable one is "partial" here without needing the
              // renewAttempt qualifier the reuse-capable ladder needs.
              else if (verdict === null) state.status = 'partial';
              // 读不出 exp（任一侧）时不能拿"没前进"当结论：这不是 no-progress 的证据。
              else if (expiryComparable && !expiryAdvanced) state.status = 'no-progress';
              else state.status = 'ok';
              if (state.status === 'no-progress' && !state.err) {
                state.err = captureHeadless ? HEADLESS_STALLED : RENEWAL_STALLED;
                // A background browser sent to renew that comes back with the token the
                // plugin already had has renewed nothing: the panel says exactly that
                // instead of reading the write as a refresh (2026-10-04, round 5).
                if (captureHeadless) state.renewalNoProgress = true;
              }
              captureFacts = Object.assign(captureFacts || {}, {
                via,
                // Which rung produced the token, and what the other rungs did. The order is
                // login → SSO → mint, so a token from the mint means the session was already
                // offered to the SSO and refused; a token straight from the window means the
                // SSO was never asked (and this run therefore proves nothing about it). No
                // rung is spent here just to ask: an extra round trip that mints a token
                // nobody stores is a side effect this plugin cannot vouch for.
                mint: via === 'capture-mint' ? 'ok' : 'skip',
                sso: via === 'capture-sso' ? 'ok' : (via === 'capture-mint' ? 'fail' : 'skip'),
                reuse: 0,
                verdict: verdict === true ? 'yes' : (verdict === false ? 'no' : 'unknown'),
                expBefore: previousExp,
                expAfter: state.tokenExpAt || 0,
              });
              done = 'captured';
            }
          }
          if (done === 'captured') {
            // Clear the remembered block before persisting. Saving first and
            // clearing afterwards is what left "needs login" stuck in the state
            // file even though the capture had just succeeded.
            state.refreshBlocked = false;
            state.loginReason = '';
            try { await saveState(); } catch (e) {
              noteStateNotStored('capture state', String((e && e.message) || e));
              state.status = 'error';
            }
            // Only now — captured, validated, written, persisted — may the window this
            // plugin opened be closed (2026-10-04, requirement C).
            await stopCapture('captured');
          } else if (done === 'kept') {
            // Nothing was written, but "the store was deliberately left alone" is a fact
            // worth persisting, and the window is no longer useful either way.
            try { await saveState(); } catch (e) { noteStateNotStored('capture state', String((e && e.message) || e)); }
            await stopCapture('kept');
          }
        } else if (r && r.reason === 'hidden-gone') {
          // The hidden page died with the socket that created it. The browser process is a
          // separate question — it may well still be running with nothing on screen — so this
          // is its own ending: it names the carrier, and it goes through the close path
          // (which reconnects by port and proves ownership) rather than forgetting the
          // process (2026-10-04 round 10).
          await stopCapture('carrier-gone');
        } else if (r && captureElapsed >= 10000 && (r.running === false || r.reason === 'no-target')) {
          // Two different kinds of "the window is gone", and only one of them may be
          // closed. A dead port means the browser process is already gone — killing that
          // pid would be killing whoever recycled it. A live port with no page left
          // means the window is still ours and useless, so it goes through the close
          // path (2026-10-04 review, root cause A-④; requirement C).
          await stopCapture(r.running === false ? 'gone' : 'closed');
        } else if (r && r.error && String(r.error).toLowerCase().indexOf('refused') !== -1) {
          await stopCapture('gone');
        }
      } catch (e) { logger.error('[thu-tok-auto] capture', e); }
      finally { captureBusy = false; }
    }, CAPTURE_INTERVAL_MS);
    captureDispose = function () {
      try { iv(); } catch (e) {}
      captureDispose = null;
      captureBusy = false;
      captureBaseline = '';
      captureVerdict = null;
      captureSawSame = false;
      // captureBg is deliberately not cleared here: the trace of this very capture is
      // written just below, and it has to name the carrier that really asked for it. The
      // next startCapture always overwrites it.
      state.browserOpen = false;
      state.loginWait = false;
      // browserPort/Pid/Mine are deliberately left standing: closeOwnWindow reads them
      // immediately after this, and clearing them here would leak the very window that
      // must be closed.
    };
  }
  /**
   * Give up the claim on a window without touching any process. This is the only
   * correct cleanup when the evidence says the browser is already gone.
   *
   * The claim and the evidence are deliberately not the same thing: the claim is what this
   * process is watching right now, the lease (state.owned) is what an earlier process wrote to
   * disk. A claim is given up eagerly — a window being closed must not look open — while the
   * lease is only retired by a *confirmed* close. That is why nothing here touches
   * state.owned: a close that fails must leave a trail the next run can follow
   * (2026-10-05 round 14 A).
   */
  function forgetOwnWindow() {
    const seen = { port: state.browserPort, pid: state.browserPid, mine: state.browserMine };
    // The hidden page is part of the window: its socket is the page's lifetime, so giving up
    // the claim means giving up the connection too, or a later run would be reading a page
    // that no longer exists (2026-10-04 round 10).
    const carrier = releaseHiddenCarrier();
    state.browserOpen = false;
    state.loginWait = false;
    state.browserMine = false;
    state.browserPort = 0;
    state.browserPid = 0;
    // The instance id goes with the port: keeping it would let a later close be aimed at
    // a browser that is not the one it was learned from (2026-10-04 audit, defect 1).
    state.browserUuid = '';
    // The headless flag describes the window that was being watched; with the window gone
    // it must not linger on the next snapshot (2026-10-04, round 5). Same for the carrier
    // and its note: both describe that window (2026-10-04 round 10).
    state.headless = false;
    state.carrier = '';
    state.carrierNote = '';
    return { closed: false, reason: 'already-gone', port: seen.port, pid: seen.pid, hidden: carrier.closed };
  }
  /**
   * Note a close that could not be proven. The window may still be on screen, so the
   * panel says so instead of reporting a success — the two failure modes this replaces
   * were a timeout and a socket close both being counted as "closed", and a pid being
   * killed on the strength of its image name (2026-10-04 audit, defects 1 and 2).
   */
  function noteCloseUnconfirmed(r) {
    const why = (r && r.reason) || 'unconfirmed';
    const line = CLOSE_UNCONFIRMED_NOTE + '（' + why + '）';
    if (state.err.indexOf(CLOSE_UNCONFIRMED_NOTE) === -1) {
      state.err = state.err ? state.err + '；' + line : line;
    }
    return line;
  }
  /**
   * Close the temporary window this plugin opened — and only that one (2026-10-04,
   * requirement C, extended 2026-10-05 round 14 A).
   *
   * Where the evidence comes from: the live claim first (browserMine + port + the instance id
   * read from the browser's own /json/version at spawn time), and the owned lease second. The
   * lease is what makes a leftover closable at all: a failed close in an earlier process used
   * to wipe the port, the pid and the id out of the state file, after which the browser on
   * that port could never be recognised again — which is exactly how the 00:51 leftover
   * survived a whole night. Now a close that cannot be confirmed *keeps* the lease.
   *
   * What may be closed is decided one level down (createBrowserCloser): the endpoint must
   * answer with the recorded instance id, or, when it is gone while our process is alive, the
   * process table must tie the tree to this lease — exact profile directory, our executable,
   * and the recorded pid with an unchanged start time or our debug port on its command line.
   * Nothing else is ever touched.
   */
  async function closeOwnWindow(reason) {
    const lease = leaseForDisk();
    const claim = { port: state.browserPort, pid: state.browserPid, mine: state.browserMine, uuid: state.browserUuid };
    // The claim describes the window *this* process is watching; the lease may describe one an
    // earlier process left behind. Either can stand behind a close, and the union is what the
    // closer gets — it does its own identity check, so passing more evidence cannot make it
    // close a stranger.
    const port = claim.port || (lease && lease.port) || 0;
    const pid = claim.pid || (lease && lease.pid) || 0;
    const uuid = claim.uuid || (lease && lease.uuid) || '';
    const mine = !!(claim.mine || lease);
    const asked = { port: port, pid: pid, uuid: uuid, reason: reason, owned: lease };
    // The claim is given up *before* the close — a window being closed must not look open to
    // the next tick — but the evidence is not: forgetOwnWindow deliberately leaves the lease
    // alone, and restoreEvidence puts back whatever a failed close still needs.
    forgetOwnWindow();
    if (!mine || !port) return { closed: false, reason: 'not-ours' };
    if (typeof deps.closeBrowser !== 'function') {
      restoreEvidence(lease, uuid, port, pid);
      noteCloseUnconfirmed({ reason: 'unsupported' });
      return { closed: false, reason: 'unsupported' };
    }
    try {
      const r = await deps.closeBrowser(asked);
      if (!r || r.closed !== true) {
        // The evidence goes back on purpose: this browser is still out there, and the next
        // run — or the stop script, or the host after a reload — must be able to find it
        // again. Clearing it here is what turned the 00:51 leftover into a permanent one.
        restoreEvidence(lease, uuid, port, pid);
        const line = noteCloseUnconfirmed(r);
        logger.error('[thu-tok-auto] the temporary window was not confirmed closed: ' + line);
        return r || { closed: false, reason: 'unconfirmed' };
      }
      // Only a confirmed close retires the lease.
      clearLease();
      logger.log('[thu-tok-auto] browser closed (' + reason + '): ' + JSON.stringify(r));
      // A confirmed close is also the moment this run's own profile directory may go (round 17);
      // a shared profile never matches, so the cookies and the stored device fingerprint of the
      // real profile are never touched by this path.
      await cleanupCarrierProfile(lease && lease.profile, reason);
      return r;
    } catch (e) {
      logger.error('[thu-tok-auto] close browser', e);
      restoreEvidence(lease, uuid, port, pid);
      noteCloseUnconfirmed({ reason: 'error' });
      return { closed: false, reason: 'error' };
    }
  }
  /**
   * A close with a ceiling, so one hung closer cannot hold the caller — a run, a shutdown —
   * open forever. It is bounded by construction: the closer answers within its own timeouts
   * (probe 1.2 s, reply 3 s, settle 5 s) and this is the outer belt.
   */
  async function boundedClose(reason, ms) {
    const limit = Number(ms) || Number(deps.closeBudgetMs) || CLOSE_BUDGET_MS;
    let timer = null;
    try {
      return await Promise.race([
        closeOwnWindow(reason),
        new Promise(function (resolve) {
          timer = setTimeout(function () {
            noteCloseUnconfirmed({ reason: 'timeout' });
            restoreEvidence(leaseForDisk());
            resolve({ closed: false, reason: 'timeout' });
          }, limit);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /**
   * Write the lease to disk right now, and say so out loud if it did not land. The lease is
   * the only record of a browser this process started that survives the process, so a failed
   * write is a fact the panel has to carry (STATE_NOT_STORED_NOTE) rather than a silent one:
   * without it, "the window is gone" and "the window can never be found again" look the same.
   */
  async function persistLease(why) {
    try {
      await saveState();
      return true;
    } catch (e) {
      noteStateNotStored('owned lease (' + why + ')', String((e && e.message) || e));
      return false;
    }
  }
  /**
   * The host-exit path (2026-10-05 round 14 A). dispose is called by the host *without*
   * awaiting it, so an async close would be cut off when the process exits — and the browser
   * would outlive the host. This one is synchronous end to end: there is no await in it, so
   * when dispose returns, the verdict is already final. It demands exactly the same evidence
   * as the async path (the instance id, or the process table tied to the lease) and it keeps
   * the lease when it cannot prove the close, so the next process can still finish the job.
   */
  function closeOwnWindowSync(reason) {
    const lease = leaseForDisk();
    const claim = { port: state.browserPort, pid: state.browserPid, mine: state.browserMine, uuid: state.browserUuid };
    const port = claim.port || (lease && lease.port) || 0;
    const pid = claim.pid || (lease && lease.pid) || 0;
    const uuid = claim.uuid || (lease && lease.uuid) || '';
    forgetOwnWindow();
    if ((!claim.mine && !lease) || !port) return { closed: false, reason: 'not-ours' };
    if (typeof deps.closeBrowserSync !== 'function') {
      restoreEvidence(lease, uuid, port, pid);
      noteCloseUnconfirmed({ reason: 'unsupported-sync' });
      return { closed: false, reason: 'unsupported-sync' };
    }
    try {
      const r = deps.closeBrowserSync({ port: port, pid: pid, uuid: uuid, reason: reason, owned: lease, sync: true });
      if (!r || r.closed !== true) {
        restoreEvidence(lease, uuid, port, pid);
        noteCloseUnconfirmed(r);
        return r || { closed: false, reason: 'unconfirmed' };
      }
      clearLease();
      // The synchronous twin of the cleanup above, and for the same reason: dispose cannot await
      // anything, so the directory removal is done with the sync seam in the same breath as the
      // close that proved the browser gone.
      cleanupCarrierProfileSync(lease && lease.profile, reason);
      return r;
    } catch (e) {
      logger.error('[thu-tok-auto] close browser (sync)', e);
      restoreEvidence(lease, uuid, port, pid);
      noteCloseUnconfirmed({ reason: 'error' });
      return { closed: false, reason: 'error' };
    }
  }
  /**
   * Take charge of what an earlier process of this plugin left behind (2026-10-05 round 14 A).
   * A host reload — or a host that was killed — can leave a browser holding this plugin's
   * profile and debug port; the lease on disk is the only record of it that survives. What this
   * may close is not decided here but one level down, by exactly the same evidence every other
   * close demands: the browser's own DevTools instance id, or the process table tying the tree
   * to this lease. A stranger sitting on the port is never read and never closed — its reading
   * is put on the visible line so the next click explains itself instead of failing silently.
   */
  async function boundedReap(reason) {
    const lease = leaseForDisk();
    if (!lease || !lease.port) { lastReap = null; return { closed: false, reason: 'nothing-to-reap' }; }
    const closed = await boundedClose(reason);
    noteReap(reason, closed, lease);
    if (closed && closed.closed === true) {
      // The leftover is gone and the lease with it; the line it had put up no longer applies.
      // Only that one line: "the session is dead, log in by hand" is a reading about the
      // session, and reaping a browser says nothing about it (2026-10-05 round 14 A review).
      if (state.loginReason === 'port-not-ours') state.loginReason = '';
      // If the browser that just went was the one recorded as an unclosable leftover, that evidence
      // has served its purpose and goes with it (round 17). Compared by identity: a port alone never
      // decides which browser a record is about.
      if (state.portLeftover && lease.uuid && String(state.portLeftover.id) === String(lease.uuid)) state.portLeftover = null;
      // …and if that leftover was living in a profile directory this plugin made for one run,
      // the directory goes with it (round 17). A proven close is the precondition: while the
      // browser might still be running, that directory is still its own.
      await cleanupCarrierProfile(lease.profile, 'reap:' + String(reason));
      await persistLease('reap:' + String(reason));
      return closed;
    }
    const why = String((closed && closed.reason) || 'unconfirmed');
    if (why === 'not-ours') {
      // A reading, not a blocker (round 17). Someone else is answering on the port this plugin
      // used last time, so the browser this lease describes is not there any more — but the
      // lease stays on disk and nothing of theirs is read or closed. The next Get routes around
      // it: it probes on, takes a free port and runs in a profile of its own. The old version
      // made this a wall the user had to clear by hand, which is exactly the dead end the
      // 2026-10-05 report describes.
      state.portNote = '端口 ' + lease.port + ' 上答的是别的浏览器（不是本插件上次启动的那一台，实例身份对不上）：本插件没有读它，也没有动它';
      await persistLease('reap-not-ours');
      return closed;
    }
    // A close that could not be proven leaves the lease standing on purpose, so the next run —
    // or the stop script — can try again. The reading is already on the visible line.
    return closed;
  }
  /**
   * Hand the saved SSO session back to the browser this run started, and then send that browser
   * to the login entry (2026-10-05 round 16). This is the step that was missing: the HTTP leg
   * could still walk the SSO chain with `state.cookieJar`, while the browser leg — the only leg
   * that can run the site's device-fingerprint JavaScript — started with an empty cookie store
   * because the browser is launched with `--no-session-restore`. Nothing but this plugin can
   * read that jar, so nothing but this plugin can hand it over.
   *
   * What may be handed over, and to whom, is decided in `planSessionRestore` / the restorer
   * (`lib/index.js`), which refuses to send a cookie anywhere but its own host and refuses to
   * speak to a browser whose instance id is not this spawn's. What is recorded here is a
   * reading — outcome word, host, counts, names of the cookies that were refused — never a
   * value: this object goes into `state.json` and into the panel's snapshot.
   */
  async function restoreOwnSession(port) {
    let reading = { ok: false, reason: 'unknown', host: '', sent: 0, failed: [], skipped: [], navigated: false };
    try {
      const lease = leaseForDisk();
      const uuid = String(state.browserUuid || (lease && lease.uuid) || '');
      const answer = await deps.sessionRestore({
        port: port, uuid: uuid, url: SSO_LOGIN_URL, jar: state.cookieJar,
      });
      reading = {
        ok: !!(answer && answer.ok),
        reason: String((answer && answer.reason) || (answer && answer.ok ? '' : 'no-answer')),
        host: String((answer && answer.host) || ''),
        sent: Number((answer && answer.sent) || 0),
        failed: Array.isArray(answer && answer.failed) ? answer.failed.slice(0, 8) : [],
        skipped: Array.isArray(answer && answer.skipped) ? answer.skipped.slice(0, 8) : [],
        navigated: !!(answer && answer.navigated),
      };
    } catch (e) {
      reading = { ok: false, reason: 'threw', host: '', sent: 0, failed: [], skipped: [], navigated: false };
    }
    state.lastRestore = {
      at: deps.clock.now(), ok: reading.ok, reason: reading.reason, host: reading.host,
      sent: reading.sent, failed: reading.failed, skipped: reading.skipped, navigated: reading.navigated,
    };
    logger.log('[thu-tok-auto] sso session restore: ' + JSON.stringify(state.lastRestore));
    return reading;
  }
  async function stopCapture(reason) {
    const hadToken = !!state.token;
    if (captureDispose) captureDispose();
    if (reason === 'captured') {
      // A successful capture proves the login path works again, so drop the block.
      // The status itself is left alone: the capture arm has just set it from the
      // same three facts as the ladder, and forcing 'ok' here is exactly what used
      // to erase a freshly detected no-progress (a same-token capture looked green).
      state.refreshBlocked = false;
      state.loginReason = '';
      // The route that just worked is the one to keep using: clear the quiet period a
      // previous background failure had bought (2026-10-04, round 5).
      headlessBackoffUntil = 0;
      headlessFailReason = '';
    } else if (reason === 'kept') {
      // The run deliberately wrote nothing, so it may not clear a remembered block: the
      // state it leaves behind is the one the ladder set (2026-10-04 audit, item 4).
    } else {
      // The run ended without a capture, so the panel must stop claiming it is still
      // waiting for a login. Whatever token is already in hand is unaffected by a
      // window that closed or timed out — the attempt failed, the credential did not
      // (2026-10-04 review, root cause A-③).
      state.status = hadToken ? loadedStatus() : 'needs-login';
      const seenForm = captureProbe && captureProbe.form;
      // The no-window carrier is named as the no-window carrier whichever run asked for it: a
      // click whose no-window attempt timed out did not put a window on screen either, so
      // telling that user 「登录窗口已关闭」 describes a window that never existed
      // (2026-10-04 round 9, requirement A). Which *kind* of no-window carrier it was is said
      // too — a native hidden page and the built-in headless shell are different engines
      // (2026-10-04 round 10).
      const why = carrierEndSentence(reason, captureBg, captureCarrier);
      state.err = state.status === 'needs-login' ? why : why + '：现有令牌不受影响';
      if (captureHeadless) {
        // Which page the no-window browser really reached decides what the next attempt says:
        // the device page needs this person's device, a login form needs their password, and
        // a page that never loaded needs neither. Every ending keeps its own name, so the
        // record distinguishes a minute that passed from a form that was never going to fill
        // itself in from a carrier whose page died under it (2026-10-04 round 9 requirement D,
        // round 10).
        const failKind = seenForm === 'device-fingerprint' ? 'device-page'
          : seenForm === 'login-form' ? 'login-form'
            : (reason === 'carrier-gone' ? 'carrier-gone' : reason);
        // A background attempt that failed says nothing about whether a person could do
        // it, so the panel asks for the one thing that would work — a click — and the next
        // automatic attempt is half an hour away instead of every five minutes.
        headlessFailReason = failKind;
        headlessBackoffUntil = deps.clock.now() + HEADLESS_RETRY_MS;
        state.loginReason = 'needs-manual-login';
        if (seenForm === 'device-fingerprint') {
          // Name the step that needs a person instead of only the minute that passed. A
          // manual click is answered with the visible window just below; a background run
          // keeps this as the reason it is asking for one (2026-10-04 round 9, requirement D).
          state.err = (state.err ? state.err + '；' : '') + DEVICE_PAGE_NOTE;
        }
      } else {
        state.loginReason = (state.status === 'ok' || state.status === 'no-progress') ? '' : 'renewal-unavailable';
      }
    }
    // Every way a capture can end is the outcome of the click that opened the window, so
    // record it once, here — after the branch above has settled the flags the record has
    // to agree with, and before the window is closed. Until this existed, a *successful*
    // login left 「上次点击」 on whatever the ladder had logged before the window opened:
    // the panel said "复用旧令牌、到期时间未前进" while the credential had just been renewed
    // from that very window (2026-10-04 real-machine audit, P1). Persisted right away — an
    // outcome that only lives in memory is gone at the next restart.
    const facts = captureFacts;
    captureFacts = null;
    if (facts) {
      writeTrace(Object.assign({}, facts, {
        // The carrier that really started this capture: an unattended renewal must not be
        // filed as a click, and a click must not be filed as a background run (2026-10-04).
        bg: captureBg,
        ms: Math.max(0, deps.clock.now() - captureStartedAt),
      }));
      try {
        await saveState();
      } catch (e) {
        // The capture happened; the record of it did not reach the disk. Going quiet here
        // leaves the panel describing an earlier run as if it were this one — which is
        // exactly what happened on 2026-10-04 18:01:23, when this write lost a race with
        // the capture's own save (EPERM on the rename). Say it on the visible line.
        markTraceNotStored('capture trace', String((e && e.message) || e));
      }
    }
    // Requirement A (2026-10-04 round 9): a click whose no-window attempt could not finish
    // does not lose its click. The browser that attempt started is closed first — it is this
    // plugin's own and nobody else's — and then, inside the same request, the one visible
    // window is opened and watched. Only a *failed* exit escalates: 'captured' and 'kept' are
    // endings the run chose, and putting a window on top of a renewal that worked (or on one
    // that deliberately wrote nothing) is the very thing a click must not do. A background run
    // never escalates — an unattended machine must not put a window on screen — and one
    // capture may escalate at most once.
    const failedExit = reason === 'timeout' || reason === 'gone' || reason === 'carrier-gone' || reason === 'error';
    const escalate = failedExit && captureHeadless && !captureBg && !captureEscalated && !disposed;
    if (escalate) captureEscalated = true;
    let closed;
    if (reason === 'gone') {
      // The debug port stopped answering. That is evidence the browser exited — but not proof
      // that the *process* is gone, and a silent port with our browser still in the process
      // table is precisely the state that leaves a leftover behind. So the same closer is asked
      // to settle it, and it settles it without ever closing a window that is not answering:
      // with the endpoint silent its verdict is a probe reading, and only a tree the process
      // table ties to this lease (exact profile, our executable, our port or our pid with its
      // recorded start time) may actually be stopped (2026-10-05 round 14 A).
      forgetOwnWindow();
      closed = await boundedClose('gone');
    } else {
      // 'carrier-gone' lands here on purpose: the hidden page died, but the browser that
      // hosted it is this plugin's own and may still be running with nothing on screen. The
      // close path reconnects by port and demands the instance id before it closes anything.
      closed = await closeOwnWindow(reason);
    }
    if (escalate) await escalateToVisible(reason, captureCarrier);
    return closed;
  }
  /**
   * The click's no-window attempt could not finish on its own, so the click gets the door it
   * has always had — in this same request, with no second Get. The headless browser has just
   * been closed by stopCapture, so this opens the one visible window and watches it. If even
   * that will not open, the reason is said out loud rather than implying a window exists
   * (2026-10-04 round 9, requirement A).
   */
  async function escalateToVisible(reason, carrier) {
    // What the failed attempt said on the visible line is the only record of why a person is
    // needed at all, and openLogin() below writes over that line on both of its exits — so it
    // is read first, before anything can erase it (2026-10-04 round 9, requirement D).
    const said = String(state.err || '');
    const opened = await openLogin({ background: false });
    if (opened && opened.launched) {
      state.status = 'waiting-login';
      // A device page is the one failure a visible window is *for*, so that sentence is kept
      // ahead of the new one; the rest of what the failed attempt said (a minute passed, the
      // token is untouched) is replaced by what is true now (2026-10-04 round 9, req. D).
      const kept = said.indexOf(DEVICE_PAGE_NOTE) !== -1 ? DEVICE_PAGE_NOTE + '；' : '';
      // Which carrier just failed is named, because 「后台」 would be a lie about a click and
      // the two no-window carriers are different engines (2026-10-04 round 10).
      state.err = kept + (carrier === 'hidden' ? ESCALATED_HIDDEN_HINT : ESCALATED_HINT);
      // The click is being answered with a person's window now, so the remembered "a person
      // is needed" reason has been acted upon and is no longer a standing state.
      state.loginReason = '';
      logger.log('[thu-tok-auto] the click could not finish without a person (' + String(reason)
        + ', carrier=' + String(carrier || 'unknown') + '); opened the visible login window for it');
      return { escalated: true };
    }
    const why = String((opened && opened.reason) || 'error');
    if (why !== 'disposed') {
      // openLogin already wrote its own reason code and sentence; append instead of replacing,
      // so both failed attempts stay on the visible line — together with what the background
      // attempt said first, because a click that ends with neither a window nor a reason looks
      // exactly like a broken button (2026-10-04 round 9, requirement A).
      state.err = (said ? said + '；' : '') + loginFailHint(why);
    }
    logger.error('[thu-tok-auto] the click could not be finished by a person either: ' + why);
    return { escalated: false, reason: why };
  }
  // Failure backoff: 5 → 10 → 20 → 30 minutes. A refresh that fails (site down,
  // session gone, network out) used to be retried every five minutes for as long
  // as the failure lasted, and nothing about the answer changed in between. This
  // only spaces the attempts out; the five-minute emergency floor in autoTick is a
  // separate rule (2026-10-04 audit, item 6).
  const autoRetryDelay = function () {
    return Math.min(AUTO_RETRY_MS * Math.pow(2, Math.min(consecutiveFailures, 3)), 30 * 60e3);
  };
  async function autoTick() {
    await ensureLoaded();
    if (disposed) return snapshot();
    // A window of ours that is open and being watched *is* a run in progress, so a
    // tick must not start beside it — but a merely open browser is not a reason to
    // skip: Auto may not depend on one being there at all (2026-10-04, requirement B).
    if (!state.auto || state.busy || state.loginWait) return snapshot();
    const now = deps.clock.now();
    const refreshDue = !state.lastGetAt || now - state.lastGetAt >= AUTO_REFRESH_MS;
    // credentialPresent, not credentialWritten: a run that needed no write is a
    // healthy run, and counting it as "needs repair" is what made Auto re-run the
    // whole ladder every five minutes while a session-bound token stayed put.
    const repairDue = !!state.token &&
      (state.status === 'error' || state.status === 'partial' || !state.credentialPresent || !state.provider);
    if (!refreshDue && !repairDue) return snapshot();
    // The floor drops back to the base interval while the token is nearly out, so a bad
    // streak spends its last hour retrying every five minutes instead of every thirty.
    // This narrows the window in which an attempt lands after the token has died; it
    // cannot close it — with less than AUTO_RETRY_MS of life left, the next retry may
    // still be too late, and then the panel reports expired / needs-login rather than a
    // renewal (2026-10-04 audit, item 6).
    const expAt = state.tokenExpAt || (state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0);
    const urgent = expAt > now && (expAt - now) <= RENEWAL_MARGIN_MS;
    const floor = urgent ? AUTO_RETRY_MS : autoRetryDelay();
    if (now - lastAutoAttemptAt < floor) return snapshot();
    lastAutoAttemptAt = now;
    const out = await runGetTok({ background: true });
    const healthy = out && (out.status === 'ok' || out.status === 'no-progress');
    consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
    return out;
  }
  const api = {
    init: async function () {
      await ensureLoaded();
      // Before anything else can be read, the browser an earlier process left behind is dealt
      // with: adopted only with its own identity, closed only with the lease's evidence, and
      // reported honestly when neither holds (2026-10-05 round 14 A).
      await boundedReap('startup');
      // …and then the directories a *crashed* run left behind (2026-10-05 round 17): a process
      // that died between spawning its browser and closing it leaves a whole Chromium profile in
      // baseDir. Bounded by construction — it looks once, skips the lease on disk, skips anything
      // a browser still holds, and only removes what has been stale for a day. The reading goes
      // into the snapshot so "there were three of them" is a fact, not a guess.
      await pruneIsolatedProfiles();
      return snapshot();
    },
    state: async function () { await ensureLoaded(); return snapshot(); },
    setAuto: async function (on) {
      await ensureLoaded();
      if (disposed) return snapshot();
      state.auto = !!on;
      try { await saveState(); } catch (e) {
        // The switch did not reach the disk: the difference between "Auto is on" and "Auto is
        // on until the host restarts" is exactly this sentence (2026-10-04 round 9, req. G).
        state.status = 'error';
        state.err = '';
        noteStateNotStored('auto switch', String((e && e.message) || e));
        return snapshot();
      }
      if (state.auto && (!state.lastGetAt || deps.clock.now() - state.lastGetAt >= AUTO_REFRESH_MS)) return autoTick();
      return snapshot();
    },
    getTok: async function (opts) {
      const out = await runGetTok(opts);
      // A manual success clears the backoff, so the next Auto run is prompt again.
      if (out && (out.status === 'ok' || out.status === 'no-progress')) consecutiveFailures = 0;
      // The run's own record is written in runGetTok's finally, i.e. after the snapshot it
      // returned was built — so the answer handed to the UI is stamped here, with the
      // trace of the run the caller just triggered (2026-10-04 real run).
      if (out && typeof out === 'object') out.trace = state.lastTrace;
      return out;
    },
    openLogin: async function () { return openLogin(); },
    autoTick: autoTick,
    internal: {
      state: state,
      ensureBaseDir: ensureBaseDir,
      saveState: saveState,
      loadState: loadState,
    },
    dispose: function () {
      disposed = true;
      state.busy = false;
      if (captureDispose) captureDispose();
      // The host calls this without awaiting it (lib/index.js: the effect's cleanup runs as
      // plain code), so anything asynchronous here would be cut off by the process exiting —
      // and the browser would outlive the host, which is exactly how the 2026-10-05 00:51
      // leftover was born. The synchronous, evidence-verified stopper does the whole job
      // inside this call: one process read, one kill per verified pid, one confirming read.
      const closed = closeOwnWindowSync('dispose');
      try { logger.log('[thu-tok-auto] dispose: ' + JSON.stringify(closed)); } catch (e) { /* logging must not throw */ }
      return closed;
    },
  };
  return api;
}
