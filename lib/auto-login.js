'use strict';
// The optional account-login arm (2026-11-28).
//
// Why this file exists: when the stored SSO session is really gone, the SSO chain answers a
// password form (`lastSsoStep === 'login-form'`), and until now the ladder had exactly one
// answer to that — ask a person to click Get. If the user has stored an account in the
// plugin's own settings, the plugin may finish that one step itself: in a windowless browser
// it started, on the real Tsinghua unified-auth form, once.
//
// The shape is deliberately three separate pieces, because they fail in different ways and
// only the first is testable without a browser:
//
//   1. `classifyPage(facts)` — a pure decision over page facts the driver read. It is where
//      "is this really the unified-auth password form?" is answered, and it refuses every
//      shape it does not recognise rather than guessing.
//   2. `createLoginDriver(deps)` — the CDP side: identity first, origin second, form third,
//      one fill, one submit, then a bounded watch.
//   3. `createAutoLogin({store, driver})` — the policy seam the core calls: ask the store,
//      hand one decrypted pair to one driver call, report a named result.
//
// What it will never do, on purpose: type into a page it has not proved is the exact
// unified-auth form on the exact HTTPS origin; retry a submit; solve or skip a CAPTCHA, a
// second factor, a risk check or a device confirmation; or keep a password anywhere after
// the attempt returns.

/** The one host this arm may ever act on. Compared as an origin, not as a prefix. */
export const SSO_ORIGIN = 'https://id.tsinghua.edu.cn';
export const SSO_HOST = 'id.tsinghua.edu.cn';

// Every way this arm can end. The core maps these onto panel sentences; nothing else is
// allowed to invent a reason word, so a reading in the trace always means the same thing.
export const AUTO_LOGIN_REASONS = {
  'not-configured': '设置里没有保存账号',
  unsupported: '这台机器上用不了凭据存储',
  'blocked-until-update': '上次被判为账号密码错误，等更新凭据后再试',
  'attempt-limit': '连续几次都没拿到确定结果，暂停自动登录',
  'not-ours': '端口上不是本次启动的浏览器',
  'wrong-origin': '页面不在统一认证域名上',
  'not-top-frame': '登录表单不在顶层页面',
  'ambiguous-form': '页面上不是唯一一张表单',
  'no-form': '页面上没有账号密码表单',
  'captcha-required': '登录页要求验证码',
  'mfa-required': '登录页要求二次验证',
  'device-confirm-required': '登录页要求设备确认',
  'credentials-rejected': '账号或密码被拒绝',
  'no-page': '没有找到可读的页面',
  'navigate-failed': '没能打开统一认证登录页',
  'wrong-method': '登录表单不是 POST，插件没有填任何内容',
  'context-gone': '页面在填写前发生了变化（导航或换文档）',
  cancelled: '账号在尝试过程中被清除或替换',
  timeout: '提交后没等到确定结果',
  error: '驱动页面时出错',
  submitted: '已提交',
};

/**
 * Rejection wording the IDP itself prints back on the form. Matched against page text only.
 * The sources below are strings, not RegExp objects, because the same rules also have to run
 * *inside* the page (see `buildFillScript`): one rule, two places, no drift.
 */
const REJECTION_SRC = '用户名或密码不正确|用户名或密码错误|密码错误|账号或密码错误|账户或密码错误|用户不存在|账号不存在|用户名不存在|invalid\\s+(?:user\\s*name|username|password)|incorrect\\s+(?:user\\s*name|username|password)';
/** Markers of a step this arm must never try to pass. */
const CAPTCHA_SRC = 'captcha|kaptcha|验证码|滑动验证|滑块验证|拖动滑块|人机验证|geetest|recaptcha|hcaptcha';
const MFA_SRC = '动态码|短信验证|二次验证|两步验证|双因素|\\botp\\b|\\bmfa\\b|authenticator|手机令牌';
const DEVICE_SRC = '设备确认|设备验证|设备信任|新设备|信任此设备|device\\s*(?:confirm|verify|trust)';
const REJECTION_TEXT = new RegExp(REJECTION_SRC, 'i');
const CAPTCHA_MARKERS = new RegExp(CAPTCHA_SRC, 'i');
const MFA_MARKERS = new RegExp(MFA_SRC, 'i');
const DEVICE_MARKERS = new RegExp(DEVICE_SRC, 'i');

/** The selectors the arm is willing to fill. One list, used by the facts read and the fill. */
export const USER_SELECTOR = 'input[name=username],input[name=user],input[name=account],input[name=userName],input[id=username],input[id=userName]';
export const SUBMIT_SELECTOR = 'button[type=submit],input[type=submit],button[name=submit]';

/**
 * The facts the driver reads out of the page. The expression is read-only, holds no secret,
 * and returns only what `classifyPage` needs. Field *values* are never read or returned.
 */
// Recognize the official password tab without treating the locale, real-name or
// passkey forms alongside it as password forms.
const THU_FORM_LINES = [
  '  var official = String(location.pathname || "").indexOf("/do/off/ui/auth/login/form/") === 0',
  '    ? document.querySelector("form#theform") : null;',
  '  var row = official && document.querySelector("#c_code");',
  '  var needsCode = !!(row && row.getClientRects().length && getComputedStyle(row).visibility !== "hidden");',
];

export const FACTS_EXPR = [
  '(function () {',
  '  function one(sel) { try { return document.querySelector(sel) ? sel : "" } catch (e) { return "" } }',
  '  var pw = []; try { pw = Array.prototype.slice.call(document.querySelectorAll("input[type=password]")) } catch (e) {}',
  ...THU_FORM_LINES,
  '  var forms = []; try { forms = official ? [official] : Array.prototype.slice.call(document.querySelectorAll("form")) } catch (e) {}',
  '  var text = ""; try { text = String((document.body && document.body.innerText) || "").slice(0, 4000) } catch (e) {}',
  '  var action = "";',
  '  try { if (forms.length === 1 && forms[0].getAttribute("action")) action = new URL(forms[0].getAttribute("action"), document.baseURI).origin } catch (e) {}',
  '  var user = one("input[name=username]") || one("input[name=user]") || one("input[name=account]") || one("input[name=userName]") || one("input[id=username]") || one("input[id=userName]");',
  '  return {',
  '    url: String(location.href || ""),',
  '    origin: String(location.origin || ""),',
  '    readyState: String(document.readyState || ""),',
  '    topFrame: (function () { try { return window.top === window } catch (e) { return false } })(),',
  '    forms: forms.length,',
  '    passwordFields: pw.length,',
  '    usernameField: official && official.querySelector("input#i_user[name=i_user]") ? "input#i_user" : user,',
  '    passwordField: pw.length === 1 ? "input[type=password]" : "",',
  '    submit: one("button[type=submit]") || one("input[type=submit]") || one("button[name=submit]"),',
  '    actionOrigin: action,',
  '    text: text,',
  '    needsCode: needsCode',
  '  };',
  '})()',
].join('\n');

/**
 * The one operation that may see a password (2026-11-28, second pass).
 *
 * The first version checked the page, then called `Input.insertText` twice and clicked — four
 * separate CDP calls with awaits between them. A navigation in any of those gaps would have
 * delivered the plaintext into whatever document was there next. This function exists so that
 * every check and the fill happen in **one synchronous turn of one verified agent**: no await,
 * no event, no chance for the page to change hands in between.
 *
 * It re-verifies everything the preflight said, because the point of the second check is that
 * the first one is not trusted across a boundary:
 *   - the exact HTTPS origin, and this being the top frame;
 *   - no CAPTCHA / MFA / device-confirmation / rejection step on the page;
 *   - exactly one form, exactly one password field, and a username field — all three owned by
 *     that same form;
 *   - the resolved submit target: the action (or the submitter's own override) must resolve to
 *     this origin, and the method must be POST. GET or a cross-origin target is refused before
 *     anything is written.
 * Only then are the two values assigned (through the native setter, with input/change events,
 * so the site's own handlers see them) and the form submitted once.
 *
 * The values arrive as CDP `arguments`, never as part of an expression string, so they are not
 * in any source the host logs and not in any string this module builds.
 */
export function buildFillScript(origin) {
  const ORIGIN = JSON.stringify(String(origin || ''));
  return [
    'function (userValue, passValue) {',
    '  try {',
    '    var ORIGIN = ' + ORIGIN + ';',
    '    if (window.top !== window) return { ok: false, reason: "not-top-frame" };',
    '    if (String(location.origin) !== ORIGIN) return { ok: false, reason: "wrong-origin" };',
    '    var text = "";',
    '    try { text = String((document.body && document.body.innerText) || "").slice(0, 4000); } catch (e) { text = ""; }',
    '    if (new RegExp("' + MFA_SRC + '", "i").test(text)) return { ok: false, reason: "mfa-required" };',
    '    if (new RegExp("' + CAPTCHA_SRC + '", "i").test(text)) return { ok: false, reason: "captcha-required" };',
    '    if (new RegExp("' + DEVICE_SRC + '", "i").test(text)) return { ok: false, reason: "device-confirm-required" };',
    '    if (new RegExp("' + REJECTION_SRC + '", "i").test(text)) return { ok: false, reason: "credentials-rejected" };',
    ...THU_FORM_LINES,
    '    if (needsCode) return { ok: false, reason: "captcha-required" };',
    '    var forms = official ? [official] : document.querySelectorAll("form");',
    '    if (forms.length !== 1) return { ok: false, reason: "ambiguous-form" };',
    '    var form = forms[0];',
    '    var pw = document.querySelectorAll("input[type=password]");',
    '    if (pw.length !== 1) return { ok: false, reason: "no-form" };',
    '    var userEl = official ? form.querySelector("input#i_user[name=i_user]") : form.querySelector(' + JSON.stringify(USER_SELECTOR) + ');',
    '    if (!userEl) return { ok: false, reason: "no-form" };',
    '    if (userEl.form !== form || pw[0].form !== form) return { ok: false, reason: "no-form" };',
    '    var officialButton = official && form.querySelector("a[type=button][onclick]");',
    '    if (official && (pw[0].id !== "i_pass" || !form.querySelector("input#sm2pass[type=hidden][name=i_pass]") ||',
    '      !officialButton || officialButton.getAttribute("onclick").trim() !== "doLogin(); return false;" || typeof window.doLogin !== "function"))',
    '      return { ok: false, reason: "no-form" };',
    '    var submitter = official ? null : form.querySelector(' + JSON.stringify(SUBMIT_SELECTOR) + ');',
    '    if (submitter && submitter.form !== form) return { ok: false, reason: "no-form" };',
    '    var rawAction = (submitter ? submitter.getAttribute("formaction") : null) ?? form.getAttribute("action") ?? "";',
    '    var rawMethod = (submitter ? submitter.getAttribute("formmethod") : null) ?? form.getAttribute("method") ?? "get";',
    '    var target = null;',
    '    try { target = new URL(String(rawAction || location.href), document.baseURI); } catch (e) { return { ok: false, reason: "wrong-origin" }; }',
    '    if (target.origin !== ORIGIN || (official && target.pathname !== "/do/off/ui/auth/login/check")) return { ok: false, reason: "wrong-origin" };',
    '    if (String(rawMethod).toUpperCase() !== "POST") return { ok: false, reason: "wrong-method" };',
    '    function put(el, value) {',
    '      var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");',
    '      if (desc && desc.set) desc.set.call(el, value); else el.value = value;',
    '      el.dispatchEvent(new Event("input", { bubbles: true }));',
    '      el.dispatchEvent(new Event("change", { bubbles: true }));',
    '    }',
    '    put(userEl, String(userValue));',
    '    put(pw[0], String(passValue));',
    '    if (officialButton) { officialButton.click(); }',
    '    else if (submitter) { try { submitter.click(); } catch (e) { form.requestSubmit(submitter); } }',
    '    else { form.requestSubmit(); }',
    '    return { ok: true, submitted: true };',
    '  } catch (e) {',
    '    return { ok: false, reason: "error" };',
    '  }',
    '}',
  ].join('\n');
}

/**
 * Decide what the page is. Pure, so every refusal below is a fixture, not a browser run.
 *
 * The order is the order of the questions a person would ask: are we even on the right host,
 * is this the top frame, is there a step this arm must not attempt, did the server just say
 * the account is wrong, and only then — is this exactly one password form.
 */
export function classifyPage(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const origin = String(f.origin || '').toLowerCase();
  const text = String(f.text || '');
  if (!f.topFrame) return { kind: 'not-top-frame', why: 'window.top !== window' };
  if (origin !== SSO_ORIGIN) return { kind: 'wrong-origin', why: 'origin=' + (origin || '(empty)') };
  if (MFA_MARKERS.test(text)) return { kind: 'mfa-required', why: 'mfa marker' };
  if (f.needsCode === true || CAPTCHA_MARKERS.test(text)) return { kind: 'captcha-required', why: 'captcha marker' };
  if (DEVICE_MARKERS.test(text)) return { kind: 'device-confirm-required', why: 'device marker' };
  if (REJECTION_TEXT.test(text)) return { kind: 'credentials-rejected', why: 'rejection text' };
  if (Number(f.forms) !== 1) return { kind: 'ambiguous-form', why: 'forms=' + String(f.forms) };
  if (Number(f.passwordFields) !== 1) return { kind: 'no-form', why: 'password fields=' + String(f.passwordFields) };
  if (!f.usernameField) return { kind: 'no-form', why: 'no username field' };
  if (!f.passwordField) return { kind: 'no-form', why: 'no password field' };
  const actionOrigin = String(f.actionOrigin || '').toLowerCase();
  if (actionOrigin && actionOrigin !== SSO_ORIGIN) return { kind: 'wrong-origin', why: 'form action=' + actionOrigin };
  return { kind: 'login-form', why: '' };
}

/** The page facts a refusal can safely be quoted from: names and counts, never text values. */
export function scrubFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  return {
    origin: String(f.origin || ''),
    forms: Number(f.forms) || 0,
    passwordFields: Number(f.passwordFields) || 0,
    hasUserField: !!f.usernameField,
    topFrame: f.topFrame === true,
  };
}

/**
 * Navigate to a URL that has already been proved to be the unified-auth login page. Kept as
 * a tiny helper rather than inlined so the only navigation this arm performs has one spelling.
 */
export function navigateExpr(url) {
  const u = JSON.stringify(String(url || ''));
  return '(function(){try{location.assign(' + u + ');return true}catch(e){return false}})()';
}

/**
 * The core-facing seam. One call = at most one attempt, and the decrypted pair lives no
 * longer than that call. The caller (core) owns the policy about *when* to call this — the
 * store answers only whether an account exists and can be decrypted.
 */
export function createAutoLogin(deps = {}) {
  const store = deps.store || null;
  const driver = typeof deps.driver === 'function' ? deps.driver : null;
  const loginUrl = String(deps.loginUrl || '');

  async function attempt(arg) {
    if (!store) return { attempted: false, reason: 'not-configured' };
    if (!driver) return { attempted: false, reason: 'unsupported' };
    const st = await store.status();
    if (!st || st.supported !== true) return { attempted: false, reason: 'unsupported', detail: String((st && st.reason) || '') };
    if (!st.configured) return { attempted: false, reason: 'not-configured' };
    const opened = await store.load();
    if (!opened || opened.ok !== true) return { attempted: false, reason: String((opened && opened.reason) || 'error') };
    let result = null;
    try {
      result = await driver({
        port: Number(arg && arg.port) || 0,
        uuid: String((arg && arg.uuid) || ''),
        loginUrl,
        username: opened.username,
        password: opened.password,
        timeoutMs: Number(arg && arg.timeoutMs) || 30000,
        // The caller's one question: is this attempt still authorised? It is asked again by the
        // driver immediately before the secret-bearing call, with no await in between, so a
        // clear or a replacement that lands during the handshake or the navigation stops the
        // values instead of letting them be typed into a page after the user removed them.
        cancelled: typeof (arg && arg.cancelled) === 'function' ? arg.cancelled : () => false,
      });
    } catch (e) {
      return { attempted: true, ok: false, reason: 'error', revision: String(opened.revision || '') };
    } finally {
      // Drop the only copies this process holds, whatever the driver did.
      opened.username = '';
      opened.password = '';
    }
    const reason = String((result && result.reason) || '');
    return {
      attempted: true,
      ok: !!(result && result.ok === true),
      reason: reason || (result && result.ok === true ? 'submitted' : 'error'),
      submitted: !!(result && result.submitted === true),
      // Which stored account this verdict is about. The caller binds a refusal to it, so the
      // record on disk says what the account looked like when it was refused.
      revision: String(opened.revision || ''),
    };
  }

  return { attempt };
}
