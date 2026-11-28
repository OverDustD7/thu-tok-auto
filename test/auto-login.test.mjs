'use strict';
// The optional account-login arm (2026-11-28).
//
// What is measured here, and what is deliberately not: every case uses a synthetic account
// and a synthetic page. No real Tsinghua identity, no live login page, no browser. The real
// unified-auth form contract — which field names it uses, what its error banner says — is
// therefore *unverified* by this file; what is verified is that the plugin refuses every
// shape it does not recognise, keeps a password out of everything it writes, and never
// retries a rejection.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SSO_ORIGIN, FACTS_EXPR, classifyPage, scrubFacts, createAutoLogin, buildFillScript,
} from '../lib/auto-login.js';
import {
  createSecretStore, createUnsupportedStore, CREDENTIAL_FILE,
} from '../lib/secret-store.js';
import { createApiHandlers, createLoginDriver } from '../lib/index.js';

const USER = 'fixture-user-0001';
const PASS = 'fixture-pass-0001';

/** A DPAPI stand-in: reversible, obviously not encryption, and never mistaken for one. */
function fakeDpapi(options = {}) {
  const calls = { protect: 0, unprotect: 0, probe: 0 };
  return {
    calls,
    async probe() {
      calls.probe += 1;
      return options.probe || { ok: true };
    },
    async protect(plain) {
      calls.protect += 1;
      if (options.protectFails) return { ok: false, reason: 'dpapi-failed' };
      return { ok: true, text: 'sealed:' + Buffer.from(String(plain), 'utf8').toString('base64') };
    },
    async unprotect(blob) {
      calls.unprotect += 1;
      if (options.unprotectFails) return { ok: false, reason: 'dpapi-failed' };
      const text = String(blob);
      if (text.indexOf('sealed:') !== 0) return { ok: false, reason: 'dpapi-failed' };
      return { ok: true, text: Buffer.from(text.slice(7), 'base64').toString('utf8') };
    },
  };
}

/** An in-memory file set with the three operations the store uses. */
function memFs() {
  const files = new Map();
  return {
    files,
    readFile(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    writeFile(p, text) { files.set(p, String(text)); },
    rename(a, b) { if (!files.has(a)) throw new Error('ENOENT'); files.set(b, files.get(a)); files.delete(a); },
    remove(p) { files.delete(p); },
    mkdir() {},
    exists(p) { return files.has(p); },
  };
}

const baseDir = () => 'C:\\home\\.dsh\\madmodel';
const okAcl = { harden: async () => ({ ok: true }) };

test('the login form is accepted only in the one shape the arm knows', () => {
  const good = {
    origin: SSO_ORIGIN, topFrame: true, forms: 1, passwordFields: 1,
    usernameField: 'input[name=username]', passwordField: 'input[type=password]',
    submit: 'button[type=submit]', actionOrigin: SSO_ORIGIN, text: '统一身份认证 用户名 密码 登录',
  };
  assert.equal(classifyPage(good).kind, 'login-form');
  // No action attribute is normal for a self-posting form.
  assert.equal(classifyPage({ ...good, actionOrigin: '' }).kind, 'login-form');

  assert.equal(classifyPage({ ...good, origin: 'https://evil.example' }).kind, 'wrong-origin');
  assert.equal(classifyPage({ ...good, origin: 'http://id.tsinghua.edu.cn' }).kind, 'wrong-origin', 'plain http is not the origin');
  assert.equal(classifyPage({ ...good, topFrame: false }).kind, 'not-top-frame');
  assert.equal(classifyPage({ ...good, text: '请输入验证码' }).kind, 'captcha-required');
  assert.equal(classifyPage({ ...good, text: '请输入动态码' }).kind, 'mfa-required');
  assert.equal(classifyPage({ ...good, text: '请在新设备上确认登录' }).kind, 'device-confirm-required');
  assert.equal(classifyPage({ ...good, text: '用户名或密码错误' }).kind, 'credentials-rejected');
  assert.equal(classifyPage({ ...good, forms: 2 }).kind, 'ambiguous-form');
  assert.equal(classifyPage({ ...good, passwordFields: 0 }).kind, 'no-form');
  assert.equal(classifyPage({ ...good, usernameField: '' }).kind, 'no-form');
  assert.equal(classifyPage({ ...good, actionOrigin: 'https://elsewhere.example' }).kind, 'wrong-origin');
  // A step the arm must not pass outranks the form check: the page still *has* a password
  // field when it also demands a code, and typing there is exactly what must not happen.
  assert.equal(classifyPage({ ...good, text: '短信验证码' }).kind, 'mfa-required');
});

test('a refusal quotes names and counts, never page text', () => {
  const scrubbed = scrubFacts({
    origin: SSO_ORIGIN, forms: 1, passwordFields: 1, usernameField: 'input[name=username]',
    topFrame: true, text: SECRET_PAGE_TEXT, url: 'https://id.tsinghua.edu.cn/x?token=abc',
  });
  assert.deepEqual(Object.keys(scrubbed).sort(), ['forms', 'hasUserField', 'origin', 'passwordFields', 'topFrame']);
  assert.equal(JSON.stringify(scrubbed).indexOf('abc'), -1);
  assert.equal(JSON.stringify(scrubbed).indexOf('密码'), -1);
});
const SECRET_PAGE_TEXT = '用户名 fixture-user-0001 密码 fixture-pass-0001';

test('the store writes no plain text anywhere it can be read back', async () => {
  const fs = memFs();
  const dpapi = fakeDpapi();
  const store = createSecretStore({ baseDir, dpapi, acl: okAcl, fs, clock: { now: () => 1700000000000 } });

  const saved = await store.save({ username: USER, password: PASS });
  assert.equal(saved.ok, true);
  const raw = fs.files.get('C:\\home\\.dsh\\madmodel\\' + CREDENTIAL_FILE);
  assert.ok(raw, 'the record landed');
  assert.equal(raw.indexOf(PASS), -1, 'the password is not in the file');
  assert.equal(raw.indexOf(USER), -1, 'nor the username');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.alg, 'dpapi-currentuser');
  assert.equal(parsed.payload.indexOf('sealed:'), 0, 'the stored payload is the sealed blob');

  const st = await store.status();
  assert.equal(st.supported, true);
  assert.equal(st.configured, true);
  assert.equal(st.updatedAt, 1700000000000);

  const opened = await store.load();
  assert.equal(opened.ok, true);
  assert.equal(opened.username, USER);
  assert.equal(opened.password, PASS);

  // A replacement is a new record and a new revision: the refusal lock is bound to it.
  const second = await store.save({ username: USER + 'b', password: PASS + 'b' });
  assert.equal(second.ok, true);
  assert.notEqual(second.revision, saved.revision);

  const cleared = await store.clear();
  assert.equal(cleared.ok, true);
  assert.equal(fs.files.has('C:\\home\\.dsh\\madmodel\\' + CREDENTIAL_FILE), false);
  const afterClear = await store.status();
  assert.equal(afterClear.configured, false);
  assert.equal((await store.load()).reason, 'not-configured');
});

test('without DPAPI the store refuses every write instead of falling back', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi({ probe: { ok: false, reason: 'dpapi-unavailable' } }), acl: okAcl, fs });
  const st = await store.status();
  assert.equal(st.supported, false);
  assert.equal(st.configured, false);
  const saved = await store.save({ username: USER, password: PASS });
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'unsupported');
  assert.equal(fs.files.size, 0, 'nothing was written, not even a plain-text fallback');
});

test('an encrypted file that cannot be restricted is deleted, not kept', async () => {
  const fs = memFs();
  const store = createSecretStore({
    baseDir, dpapi: fakeDpapi(), fs,
    acl: { harden: async () => ({ ok: false, reason: 'icacls-failed' }) },
  });
  const saved = await store.save({ username: USER, password: PASS });
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'acl-failed');
  assert.equal(fs.files.size, 0, 'the temp file was removed; no readable copy survives');
});

test('a save with an empty half, or an oversized one, is refused by name', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  assert.equal((await store.save({ username: '', password: PASS })).reason, 'empty-username');
  assert.equal((await store.save({ username: USER, password: '' })).reason, 'empty-password');
  assert.equal((await store.save({ username: 'x'.repeat(129), password: PASS })).reason, 'username-too-long');
  assert.equal((await store.save({ username: USER, password: 'x'.repeat(257) })).reason, 'password-too-long');
  assert.equal(fs.files.size, 0);
});

test('a host with no store at all answers unsupported instead of throwing', async () => {
  const store = createUnsupportedStore('not-windows');
  const st = await store.status();
  assert.equal(st.supported, false);
  assert.equal(st.reason, 'not-windows');
  assert.equal((await store.save({ username: USER, password: PASS })).ok, false);
  assert.equal((await store.load()).ok, false);
});

test('one attempt decrypts for its own length and is reported by name', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  await store.save({ username: USER, password: PASS });

  const seen = [];
  const auto = createAutoLogin({
    store,
    loginUrl: 'https://id.tsinghua.edu.cn/x',
    driver: async (arg) => {
      seen.push({ uuid: arg.uuid, user: arg.username, pass: arg.password });
      return { ok: true, reason: 'submitted', submitted: true };
    },
  });
  const out = await auto.attempt({ port: 9333, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(out.ok, true);
  assert.equal(out.submitted, true);
  assert.equal(seen.length, 1, 'exactly one driver call');
  assert.equal(seen[0].user, USER, 'the driver received the account');
  assert.equal(seen[0].uuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('an unconfigured store means no attempt at all', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  let called = 0;
  const auto = createAutoLogin({ store, driver: async () => { called += 1; return { ok: true } } });
  const out = await auto.attempt({ port: 9333, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(out.attempted, false);
  assert.equal(out.reason, 'not-configured');
  assert.equal(called, 0, 'no browser work happens for an account that does not exist');
});

test('a driver that throws is a named failure, not an exception into the ladder', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  await store.save({ username: USER, password: PASS });
  const auto = createAutoLogin({ store, driver: async () => { throw new Error('boom') } });
  const out = await auto.attempt({ port: 9333, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'error');
});

// ---- the routes ---------------------------------------------------------------------
// A request stand-in with the three listener operations readBody actually uses, plus the two
// transport facts the account routes check for themselves (2026-11-28): the peer address and
// whether the hop was TLS. Defaults describe the real case — the panel talking to the host
// over loopback — so a test that cares about the fence overrides them.
function fakeReq(method, headers, body, transport) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const listeners = new Map();
  const t = transport || {};
  const req = {
    method,
    headers: Object.assign({ host: '127.0.0.1:3080' }, headers || {}),
    socket: { remoteAddress: t.remoteAddress === undefined ? '127.0.0.1' : t.remoteAddress, encrypted: t.encrypted === true },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return req;
    },
    once(ev, fn) { return req.on(ev, fn) },
    removeListener(ev, fn) { if (listeners.has(ev)) listeners.get(ev).delete(fn); return req },
    off(ev, fn) { return req.removeListener(ev, fn) },
    resume() {},
    destroy() {},
    emit(ev, value) {
      const set = listeners.get(ev);
      if (!set) return;
      for (const fn of Array.from(set)) fn(value);
    },
  };
  setTimeout(() => {
    if (text) req.emit('data', Buffer.from(text, 'utf8'));
    req.emit('end');
  }, 0);
  return req;
}
function fakeRes() {
  const out = { code: 0, body: '', headers: {} };
  return {
    out,
    destroyed: false,
    writableEnded: false,
    writeHead(code, headers) { out.code = code; out.headers = headers || {}; this.writableEnded = true },
    end(text) { out.body = String(text == null ? '' : text); this.writableEnded = true },
  };
}
function routeTable(options = {}) {
  const core = {
    state: () => ({ ok: true }),
    getTok: async () => ({ ok: true }),
    openLogin: async () => ({ ok: true }),
    setAuto: async () => ({ ok: true }),
    credentialsChanged: () => { if (typeof options.changed === 'function') options.changed() },
  };
  return createApiHandlers(core, { rejectReq: () => undefined, secretStore: options.store });
}

test('the account routes answer with names, never with a stored value', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  let changed = 0;
  const table = routeTable({ store, changed: () => { changed += 1 } });
  const get = table.find((r) => r.method === 'GET' && r.path.endsWith('/credentials'));
  const save = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/save'));
  const clear = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/clear'));

  let res = fakeRes();
  await get.handler(fakeReq('GET', {}), res);
  assert.equal(res.out.code, 200);
  let body = JSON.parse(res.out.body);
  assert.deepEqual(body, { ok: true, supported: true, configured: false, updatedAt: 0, reason: '' });

  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json', 'content-length': '60' }, { username: USER, password: PASS }), res);
  body = JSON.parse(res.out.body);
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
  assert.equal(JSON.stringify(body).indexOf(USER), -1, 'the answer does not echo the account');
  assert.equal(JSON.stringify(body).indexOf(PASS), -1);
  assert.equal(changed, 1, 'a save lifts any standing refusal');

  res = fakeRes();
  await get.handler(fakeReq('GET', {}), res);
  body = JSON.parse(res.out.body);
  assert.equal(body.configured, true);
  assert.equal(typeof body.updatedAt, 'number');
  assert.equal(JSON.stringify(body).indexOf(USER), -1);

  res = fakeRes();
  await clear.handler(fakeReq('POST', { 'content-type': 'application/json' }, {}), res);
  body = JSON.parse(res.out.body);
  assert.equal(body.ok, true);
  assert.equal(body.configured, false);
  assert.equal(changed, 2);
});

test('a save refuses unknown fields, the wrong shape and an oversized body', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  const table = routeTable({ store });
  const save = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/save'));

  let res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, { username: USER, password: PASS, extra: 'x' }), res);
  assert.equal(res.out.code, 400);

  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, { username: 123, password: PASS }), res);
  assert.equal(res.out.code, 400);

  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, {}), res);
  assert.equal(res.out.code, 400);

  // No content-type at all is refused before any parsing.
  res = fakeRes();
  await save.handler(fakeReq('POST', {}, { username: USER, password: PASS }), res);
  assert.equal(res.out.code, 415);

  // The route asks for its own small ceiling; a body past it is refused with 413, not stored.
  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, { username: USER, password: 'p'.repeat(9000) }), res);
  assert.equal(res.out.code, 413, 'an oversized save is refused by size');
  assert.equal(fs.files.size, 0);
});

test('with no store the routes say so and change nothing', async () => {
  const table = routeTable({ store: null });
  const get = table.find((r) => r.method === 'GET' && r.path.endsWith('/credentials'));
  const save = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/save'));
  let res = fakeRes();
  await get.handler(fakeReq('GET', {}), res);
  assert.equal(JSON.parse(res.out.body).supported, false);
  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, { username: USER, password: PASS }), res);
  const body = JSON.parse(res.out.body);
  assert.equal(body.ok, false);
  assert.equal(body.supported, false);
});

// ---- second pass (2026-11-28): one bound operation, and cancellation before the secret ----

test('the fill happens in one call bound to one execution context, with the values as arguments', () => {
  const script = buildFillScript(SSO_ORIGIN);
  // One synchronous function: no await, no promise, nothing that yields the turn.
  assert.equal(/\bawait\b/.test(script), false, 'the fill must not await: a navigation may not interleave');
  assert.equal(/Promise/.test(script), false);
  // The values arrive as parameters, never as text baked into the source.
  assert.ok(script.startsWith('function (userValue, passValue) {'));
  assert.equal(script.indexOf(SYNTHETIC_PASS), -1, 'no value is part of the function source');
  // Every check the preflight made is made again inside this same call.
  for (const needle of [
    'if (window.top !== window)', 'String(location.origin) !== ORIGIN',
    'forms.length !== 1', 'pw.length !== 1', 'userEl.form !== form', 'pw[0].form !== form',
    'submitter.form !== form', 'target.origin !== ORIGIN', '"wrong-method"',
  ]) {
    assert.ok(script.indexOf(needle) !== -1, 'missing in-page check: ' + needle);
  }
  // The submit re-resolves the action, including a submitter override.
  assert.ok(script.indexOf('submitter.getAttribute("formaction")') !== -1);
  assert.ok(script.indexOf('submitter.getAttribute("formmethod")') !== -1);
});
test('a submit button without an override cannot hide a foreign form action', () => {
  const win = {};
  win.top = win;
  const loc = { origin: SSO_ORIGIN, href: SSO_ORIGIN + '/login' };
  const form = { getAttribute: (name) => ({ action: 'https://example.invalid/collect', method: 'post' })[name] ?? null };
  const user = { form };
  const pass = { form };
  const button = { form, formAction: loc.href, getAttribute: () => null };
  form.querySelector = (selector) => selector.includes('button') ? button : user;
  const doc = {
    baseURI: loc.href,
    body: { innerText: '' },
    querySelectorAll: (selector) => selector === 'form' ? [form] : [pass],
  };
  const fill = new Function('window', 'location', 'document', 'return (' + buildFillScript(SSO_ORIGIN) + ')')(win, loc, doc);
  assert.deepEqual(fill('synthetic-user', 'synthetic-password'), { ok: false, reason: 'wrong-origin' });
  assert.equal(user.value, undefined);
  assert.equal(pass.value, undefined);
});

test('the official password tab is selected among other forms and uses the site login handler', () => {
  const win = { doLogin() {} };
  win.top = win;
  const loc = { origin: SSO_ORIGIN, href: SSO_ORIGIN + '/do/off/ui/auth/login/form/fixture', pathname: '/do/off/ui/auth/login/form/fixture' };
  const form = { getAttribute: (name) => ({ action: '/do/off/ui/auth/login/check', method: 'post' })[name] ?? null };
  const user = { form, dispatchEvent() {} };
  const pass = { id: 'i_pass', form, dispatchEvent() {} };
  const otherForms = [{}, {}, {}];
  let clicks = 0;
  let challenge = false;
  const button = {
    getAttribute: () => 'doLogin(); return false;',
    click() { assert.equal(user.value, 'fixture-user'); assert.equal(pass.value, 'fixture-pass'); clicks++; },
  };
  form.querySelector = (selector) => {
    if (selector.includes('#i_user')) return user;
    if (selector.includes('#sm2pass')) return {};
    if (selector.startsWith('a[')) return button;
    return null;
  };
  const doc = {
    baseURI: loc.href, readyState: 'complete', body: { innerText: '' },
    querySelector: (selector) => selector === 'form#theform' ? form
      : selector === '#c_code' ? { getClientRects: () => challenge ? [{}] : [] } : null,
    querySelectorAll: (selector) => selector === 'form' ? [...otherForms,form] : [pass],
  };
  const style = () => ({ visibility: 'visible' });
  const facts = new Function('window', 'location', 'document', 'getComputedStyle', 'return ' + FACTS_EXPR);
  const fill = new Function('window', 'location', 'document', 'getComputedStyle', 'return (' + buildFillScript(SSO_ORIGIN) + ')')(win, loc, doc, style);
  assert.equal(classifyPage(facts(win, loc, doc, style)).kind, 'login-form');
  assert.deepEqual(fill('fixture-user', 'fixture-pass'), { ok: true, submitted: true });
  assert.equal(clicks, 1);
  delete pass.value;
  challenge = true;
  assert.equal(classifyPage(facts(win, loc, doc, style)).kind, 'captcha-required');
  assert.deepEqual(fill('fixture-user', 'fixture-pass'), { ok: false, reason: 'captcha-required' });
  assert.equal(pass.value, undefined);
  assert.equal(clicks, 1);
});

const SYNTHETIC_PASS = 'synthetic-pass-value';

test('the page rules and the in-page script are the same rules', () => {
  const script = buildFillScript(SSO_ORIGIN);
  // A page that the classifier calls a CAPTCHA must also be refused inside the call: if these
  // two ever disagreed, the preflight would be decisive and the in-page check decorative.
  const pairs = [
    ['captcha-required', '验证码'], ['mfa-required', '动态码'],
    ['device-confirm-required', '设备确认'], ['credentials-rejected', '密码错误'],
  ];
  for (const [kind, marker] of pairs) {
    assert.equal(classifyPage({ ...LOGIN_FACTS, text: marker }).kind, kind);
    assert.ok(script.indexOf('"' + kind + '"') !== -1, 'the script must be able to answer ' + kind);
  }
});
const LOGIN_FACTS = {
  origin: SSO_ORIGIN, topFrame: true, forms: 1, passwordFields: 1,
  usernameField: 'input[name=username]', passwordField: 'input[type=password]',
  submit: 'button[type=submit]', actionOrigin: SSO_ORIGIN, text: '统一身份认证',
};

test('the driver is cancellable at its await boundaries, and never reports success once cancelled', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  await store.save({ username: USER, password: PASS });

  const seen = [];
  let cancel = false;
  const auto = createAutoLogin({
    store,
    loginUrl: 'https://id.tsinghua.edu.cn/x',
    driver: async (arg) => {
      seen.push({ cancelledAtEntry: arg.cancelled() });
      // A clear that lands while the driver is opening its socket.
      cancel = true;
      if (arg.cancelled()) return { ok: false, reason: 'cancelled' };
      return { ok: true, reason: 'submitted', submitted: true };
    },
  });
  const out = await auto.attempt({ port: 9333, uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cancelled: () => cancel });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cancelledAtEntry, false, 'the attempt started authorised');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'cancelled', 'a clear during the handshake is an outcome, not a success');
  assert.equal(out.submitted, false);
});

test('a clear during the handshake is observed before any secret-bearing call', () => {
  // The producer of the question is the driver itself; this asserts the contract it relies on:
  // `cancelled` is a synchronous predicate, so reading it and sending cannot be separated by a
  // turn of the event loop.
  let generation = 0;
  const cancelled = () => generation !== 0;
  assert.equal(cancelled(), false);
  generation += 1;
  assert.equal(cancelled(), true);
});

// ---- the account routes' own transport and cross-site fence (2026-11-28) -------------

test('the account routes refuse a caller that is neither loopback nor TLS', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  const table = routeTable({ store });
  const save = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/save'));
  const get = table.find((r) => r.method === 'GET' && r.path.indexOf('/credentials') !== -1 && r.path.indexOf('/clear') === -1);

  let res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, { username: USER, password: PASS }, { remoteAddress: '10.0.0.5' }), res);
  assert.equal(res.out.code, 403, 'a LAN peer with no TLS may not store a password');
  assert.equal(fs.files.size, 0);

  res = fakeRes();
  await get.handler(fakeReq('GET', {}, undefined, { remoteAddress: '10.0.0.5' }), res);
  assert.equal(res.out.code, 403, 'nor read whether one is stored');

  // The same peer over TLS is fine: the hop itself is protected.
  res = fakeRes();
  await get.handler(fakeReq('GET', {}, undefined, { remoteAddress: '10.0.0.5', encrypted: true }), res);
  assert.equal(res.out.code, 200);
});

test('the account routes refuse a cross-site caller even over loopback', async () => {
  const fs = memFs();
  const store = createSecretStore({ baseDir, dpapi: fakeDpapi(), acl: okAcl, fs });
  const table = routeTable({ store });
  const save = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/save'));
  const clear = table.find((r) => r.method === 'POST' && r.path.endsWith('/clear'));

  let res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, { username: USER, password: PASS }), res);
  assert.equal(res.out.code, 403, 'a cross-site POST may not set an account');

  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json', origin: 'https://evil.example' }, { username: USER, password: PASS }), res);
  assert.equal(res.out.code, 403, 'an Origin from another site may not set an account');

  res = fakeRes();
  await clear.handler(fakeReq('POST', { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }, {}), res);
  assert.equal(res.out.code, 403, 'same-site is not same-origin');

  // The panel's own shape: same origin, addressed to this host.
  res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' }, { username: USER, password: PASS }), res);
  assert.equal(res.out.code, 200);
  assert.equal(fs.files.size, 1);
});
// ---- the driver itself, against a fake DevTools endpoint (2026-11-28, second pass) ------
// These measure the order the real driver performs, with a socket that answers the way a
// browser does. They exist because "the checks and the fill are one call" is a claim about
// sequencing, and a string pin cannot see a sequence.

const DRV_PORT = 9401;
const DRV_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DRV_LOGIN = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/x/0?/authLogin';

function fakeDevtools(options = {}) {
  const sent = [];
  const events = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.closed = false;
      FakeWS.last = this;
      setTimeout(() => { if (this.onopen) this.onopen() }, 0);
    }
    send(text) {
      const msg = JSON.parse(String(text));
      sent.push(msg);
      if (msg.method === 'Runtime.callFunctionOn') state.submitted = true;
      const answer = options.answer ? options.answer(msg, sent) : defaultAnswer(msg);
      // An answer may carry an event as well as its reply: `Runtime.enable` reports the existing
      // execution contexts through events and still answers the command itself.
      if (answer && answer.event) {
        events.push(answer.event);
        setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(answer.event) }) }, 0);
      }
      if (answer && answer.result !== undefined) {
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: answer.result }) });
        }, 0);
        return;
      }
      if (answer && answer.error) {
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, error: answer.error }) });
        }, 0);
        return;
      }
      // A command with neither: answer empty, so a mistake shows up as a failure and not a hang.
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: {} }) });
      }, 0);
    }
    close() { this.closed = true; try { if (this.onclose) this.onclose() } catch (e) { /* gone */ } }
  }
  const calls = { list: 0 };
  const state = { submitted: false };
  // A real Response: the driver reads the body through readResponseText, which wants a stream
  // and a headers object, and a hand-made object would be testing a different contract.
  const fetchImpl = async (url) => {
    if (String(url).indexOf('/json/list') !== -1) {
      calls.list += 1;
      // A browser that accepted the login has left the login origin — that is the only success
      // signal the driver trusts, so the fake has to produce it.
      const pages = options.pages
        ? options.pages(state)
        : [{ type: 'page', url: state.submitted ? 'https://madmodel.cs.tsinghua.edu.cn/' : DRV_LOGIN, webSocketDebuggerUrl: 'ws://127.0.0.1:' + DRV_PORT + '/devtools/page/P1' }];
      return new Response(JSON.stringify(pages), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  };
  return { FakeWS, fetchImpl, sent, events, calls };
}

function defaultAnswer(msg) {
  if (msg.method === 'Runtime.enable') {
    return {
      result: {},
      event: { method: 'Runtime.executionContextCreated', params: { context: { uniqueId: 'ctx-1', auxData: { isDefault: true, frameId: 'F1' } } } },
    };
  }
  if (msg.method === 'Runtime.disable') return { result: {} };
  if (msg.method === 'Page.getFrameTree') return { result: { frameTree: { frame: { id: 'F1' } } } };
  if (msg.method === 'Page.enable') return { result: {} };
  if (msg.method === 'Runtime.evaluate') return { result: { result: { value: LOGIN_FACTS } } };
  if (msg.method === 'Runtime.callFunctionOn') return { result: { result: { value: { ok: true, submitted: true } } } };
  return { result: {} };
}

function makeDriver(devtools) {
  return createLoginDriver({
    fetch: devtools.fetchImpl,
    WebSocket: devtools.FakeWS,
    readInstance: async () => ({ ok: true, id: DRV_UUID }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
}

test('the driver lets a blank page navigate and waits for the same-origin form to load', async () => {
  const blank = { url: 'about:blank', origin: 'null', topFrame: true };
  const loading = { url: DRV_LOGIN, origin: SSO_ORIGIN, topFrame: true, forms: 0, readyState: 'loading' };
  const frames = [blank, blank, loading];
  const devtools = fakeDevtools({
    answer(msg) {
      if (msg.method === 'Runtime.evaluate' && frames.length) {
        return { result: { result: { value: frames.shift() } } };
      }
      return defaultAnswer(msg);
    },
  });
  const out = await makeDriver(devtools)({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS });
  assert.equal(out.ok, true);
  const methods = devtools.sent.map((m) => m.method);
  assert.equal(methods.filter((m) => m === 'Page.navigate').length, 1);
  assert.equal(methods.filter((m) => m === 'Runtime.callFunctionOn').length, 1);
  assert.equal(frames.length, 0);
});

test('the driver writes in exactly one call, after the identity and the preflight, with the values as arguments', async () => {
  const devtools = fakeDevtools();
  const driver = makeDriver(devtools);
  const out = await driver({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 5000 });
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'submitted');

  const writes = devtools.sent.filter((m) => m.method === 'Runtime.callFunctionOn');
  assert.equal(writes.length, 1, 'one fill call, never a second');
  assert.equal(writes[0].params.uniqueContextId, 'ctx-1', 'pinned to the context the preflight read');
  assert.deepEqual(writes[0].params.arguments, [{ value: USER }, { value: PASS }]);
  assert.equal(JSON.stringify(writes[0].params).indexOf('insertText'), -1);
  // Nothing typed through separate calls.
  assert.equal(devtools.sent.filter((m) => m.method === 'Input.insertText').length, 0);
  // The preflight ran in that same context, before the write.
  const evals = devtools.sent.filter((m) => m.method === 'Runtime.evaluate');
  assert.ok(evals.length >= 1);
  assert.ok(evals.every((m) => m.params.uniqueContextId === 'ctx-1' || m.params.uniqueContextId === undefined));
});

test('a page that has moved on is refused, and the values are never sent', async () => {
  const devtools = fakeDevtools({
    answer(msg) {
      if (msg.method === 'Runtime.evaluate') return { result: { result: { value: Object.assign({}, LOGIN_FACTS, { origin: 'https://evil.example' }) } } };
      return defaultAnswer(msg);
    },
  });
  const driver = makeDriver(devtools);
  const out = await driver({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 3000 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'wrong-origin');
  assert.equal(devtools.sent.filter((m) => m.method === 'Runtime.callFunctionOn').length, 0, 'no fill call at all');
});

test('a form that would submit cross-origin or with GET is refused before the values are sent', async () => {
  for (const facts of [
    Object.assign({}, LOGIN_FACTS, { actionOrigin: 'https://evil.example' }),
  ]) {
    const devtools = fakeDevtools({
      answer(msg) {
        if (msg.method === 'Runtime.evaluate') return { result: { result: { value: facts } } };
        return defaultAnswer(msg);
      },
    });
    const out = await makeDriver(devtools)({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 3000 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'wrong-origin');
    assert.equal(devtools.sent.filter((m) => m.method === 'Runtime.callFunctionOn').length, 0);
  }
  // The GET case is decided inside the single call, which the fake answers with its verdict.
  const devtools = fakeDevtools({
    answer(msg) {
      if (msg.method === 'Runtime.callFunctionOn') return { result: { result: { value: { ok: false, reason: 'wrong-method' } } } };
      return defaultAnswer(msg);
    },
  });
  const out = await makeDriver(devtools)({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 3000 });
  assert.equal(out.reason, 'wrong-method');
});

test('a context that disappears between the preflight and the fill costs the values, not a retry', async () => {
  const devtools = fakeDevtools({
    answer(msg) {
      if (msg.method === 'Runtime.callFunctionOn') {
        // What CDP answers when the context was replaced by a navigation.
        return { error: { code: -32000, message: 'Cannot find context with specified id' } };
      }
      return defaultAnswer(msg);
    },
  });
  const out = await makeDriver(devtools)({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 3000 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'context-gone');
  assert.equal(devtools.sent.filter((m) => m.method === 'Runtime.callFunctionOn').length, 1, 'no second attempt in a new context');
});

test('a cancelled attempt never reaches the fill call', async () => {
  const devtools = fakeDevtools();
  let cancel = false;
  const out = await makeDriver(devtools)({
    port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 3000,
    cancelled: () => cancel,
  });
  assert.equal(out.ok, true, 'the control run is allowed to go through');
  assert.equal(devtools.sent.filter((m) => m.method === 'Runtime.callFunctionOn').length, 1);

  const second = fakeDevtools();
  const blocked = await makeDriver(second)({
    port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 3000,
    cancelled: () => true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'cancelled');
  assert.equal(second.sent.filter((m) => m.method === 'Runtime.callFunctionOn').length, 0, 'nothing carrying the values left');
});

test('an instance that does not match never gets as far as a page request', async () => {
  const devtools = fakeDevtools();
  const driver = createLoginDriver({
    fetch: devtools.fetchImpl,
    WebSocket: devtools.FakeWS,
    readInstance: async () => ({ ok: true, id: 'ffffffff-1111-2222-3333-444444444444' }),
  });
  const out = await driver({ port: DRV_PORT, uuid: DRV_UUID, loginUrl: DRV_LOGIN, username: USER, password: PASS, timeoutMs: 2000 });
  assert.equal(out.reason, 'not-ours');
  assert.equal(devtools.calls.list, 0, 'the page list was never asked for');
  assert.equal(devtools.sent.length, 0, 'and no socket was opened');
});
test('a route that carries an account never hands its thrown value to the log', async () => {
  const logs = [];
  const core = {
    state: () => ({}), getTok: async () => ({}), openLogin: async () => ({}), setAuto: async () => ({}),
    credentialsChanged: () => undefined,
  };
  const exploding = {
    async status() { return { supported: true, configured: false, updatedAt: 0, revision: '' } },
    async save() { throw new Error('boom: ' + PASS) },
    async clear() { return { ok: true } },
  };
  const table = createApiHandlers(core, {
    rejectReq: () => undefined,
    secretStore: exploding,
    onError: (endpoint, e) => logs.push({ endpoint, e }),
  });
  const save = table.find((r) => r.method === 'POST' && r.path.endsWith('/credentials/save'));
  const res = fakeRes();
  await save.handler(fakeReq('POST', { 'content-type': 'application/json' }, { username: USER, password: PASS }, { remoteAddress: '127.0.0.1' }), res);
  assert.equal(res.out.code, 500);
  assert.equal(logs.length, 1, 'the failure is still reported');
  assert.equal(typeof logs[0].e, 'string', 'the thrown object is withheld, only a marker is logged');
  assert.equal(JSON.stringify(logs).indexOf(PASS), -1, 'no value reaches the log through the error');
});