'use strict';
// THU Tok Auto — core business logic, dependency-injected so it stays unit-testable
// outside a running DSH host. Environment access (fs, fetch, WebSocket, processes)
// is completely abstracted away; lib/index.js wires the real implementations and
// the DSH profile services (settings, credentials, timer, webServer, connection).
//
// get-tok ladder: (1) mint via /auth-login/check (fresh 6h JWT; verified to work WITHOUT login on
// campus network, no cookies/credentials at all) → (2) reuse saved token if still accepted →
// (3) SSO replay with saved id.tsinghua cookies → (4) needs-login (client opens Edge/Chrome + CDP capture).
// On success the fresh token is written into the DSH model provider config:
//   credentials.set('MADMODEL_API_KEY', token)  +  ensure llm-pi-ai.providers.*(baseURL=madmodel) exists.

export const SITE = 'https://madmodel.cs.tsinghua.edu.cn';
const SSO_APP = 'd736f067a6705ab942df52f958a0f23b'; // md5('DEEPSEEK'), verified against id.tsinghua.edu.cn
export const CDP_PORT_START = 9333;
export const CDP_PORT_END = 9343;
export const CRED_REF = 'MADMODEL_API_KEY';
export const PROVIDER_NAME = 'DeepSeek (THU)';
export const PROVIDER_KEY = 'madmodel';
export const PROVIDER_BASE = 'https://madmodel.cs.tsinghua.edu.cn/v1';
export const TOKEN_LIFETIME_MS = 6 * 3600e3; // empirically exp-iat == 6h on check-issued JWTs (site guide says 5h for login-issued)
export const AUTO_REFRESH_MS = 5 * 3600e3 + 50 * 60e3;
export const AUTO_RETRY_MS = 5 * 60e3;
export const CAPTURE_INTERVAL_MS = 2500;
export const CAPTURE_TIMEOUT_MS = 20 * 60e3;
const MODEL_PROFILE = [
  {
    id: 'DeepSeek-V4-Flash-0731',
    name: 'DeepSeek-V4-Flash (THU)',
    contextWindow: 150000,
    reasoningEfforts: { minimal: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
];

export function createCore(deps) {
  const logger = deps.logger || console;
  const settingsSvc = deps.settings;
  const credSvc = deps.credentials;
  const state = {
    token: '', cookies: '', ssoCookies: '',
    lastGetAt: 0, auto: false, busy: false, status: 'idle', err: '',
    browserOpen: false, minted: false, provider: '', providerName: '', credentialWritten: false,
  };
  let baseDir = '';
  let initialized = false;
  let initPromise = null;
  let captureDispose = null;
  let captureBusy = false;
  let captureElapsed = 0;
  let cdpPort = CDP_PORT_START;
  let lastAutoAttemptAt = 0;
  let disposed = false;

  const jsonParse = function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } };
  const cookieDomain = function (value) { return String(value || '').toLowerCase().replace(/^\.+/, ''); };
  const cookieAppliesTo = function (cookie, host) {
    const d = cookieDomain(cookie && cookie.domain);
    return !!d && (host === d || host.endsWith('.' + d));
  };
  const isSsoCookie = function (cookie) {
    return cookieAppliesTo(cookie, 'id.tsinghua.edu.cn') || cookieAppliesTo(cookie, 'oauth.tsinghua.edu.cn');
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
  const ckHeader = function (cookies) {
    return (cookies || []).filter(function (c) { return cookieAppliesTo(c, 'madmodel.cs.tsinghua.edu.cn'); })
      .map(function (c) { return c.name + '=' + c.value; }).join('; ');
  };
  const ssoHeader = function (cookies) {
    return (cookies || []).filter(isSsoCookie).map(function (c) { return c.name + '=' + c.value; }).join('; ');
  };

  function ensureBaseDir() {
    const env = deps.env || {};
    const home = env.home || env.temp || '';
    baseDir = home ? home + '\\.dsh\\madmodel' : 'C:\\Windows\\.dsh-madmodel';
  }

  async function httpGet(url, headers, follow) {
    const r = await deps.http(url, { headers: headers || {}, follow: follow === false ? false : true, timeoutMs: 25000 });
    if (!r || r.error) return null;
    return r;
  }
  const okData = function (r) {
    if (!r || r.status !== 200 || !r.text) return null;
    const j = jsonParse(r.text);
    if (!j || j.success !== true || typeof j.data !== 'string' || !j.data) return null;
    return j.data;
  };
  async function authValid(token, cookie) {
    const h = { Authorization: 'Bearer ' + token };
    if (cookie) h.Cookie = cookie;
    const r = await httpGet(SITE + '/model-api/auth-login', h, false);
    if (!r || r.status !== 200 || !r.text) return false;
    const j = jsonParse(r.text);
    return !!(j && j.success === true);
  }
  async function mintCheck() {
    return okData(await httpGet(SITE + '/model-api/auth-login/check', {}, false));
  }
  async function ssoReplay() {
    if (!state.ssoCookies) return null;
    let cur = 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/' + SSO_APP + '/0?/authLogin';
    let ticket = '';
    for (let hops = 0; hops < 10; hops++) {
      if (!isSsoUrl(cur) && !isMadModelUrl(cur)) return null;
      const r = await httpGet(cur, isSsoUrl(cur) ? { Cookie: state.ssoCookies } : {}, false);
      if (!r) return null;
      if (r.status >= 300 && r.status < 400 && r.location) {
        cur = resolveLocation(cur, r.location);
        continue;
      }
      const m = String(cur).match(/[?&]ticket=([^&#]+)/);
      if (m) ticket = decodeURIComponent(m[1]);
      break;
    }
    if (!ticket) return null;
    return okData(await httpGet(SITE + '/model-api/auth-login/check?ticket=' + encodeURIComponent(ticket), {}, false));
  }
  async function listProviderNamespaces() {
    const out = [];
    try {
      if (settingsSvc && typeof settingsSvc.describe === 'function') {
        const desc = await settingsSvc.describe();
        if (Array.isArray(desc)) {
          for (const d of desc) {
            if (!d || typeof d !== 'object') continue;
            const name = d.ns || d.namespace || d.key || '';
            if (typeof name === 'string' && name.indexOf('llm-') === 0 && out.indexOf(name) === -1) out.push(name);
          }
        }
      }
    } catch (e) { logger.error('[thu-tok-auto] describe', e); }
    if (!out.length) out.push('llm-pi-ai', 'llm-deepseek');
    return out;
  }
  async function findProvider() {
    const nss = await listProviderNamespaces();
    for (const ns of nss) {
      let cur = null;
      try { cur = await settingsSvc.get(ns); } catch (e) { continue; }
      if (!cur || typeof cur !== 'object') continue;
      const providers = (cur.providers && typeof cur.providers === 'object') ? cur.providers : {};
      for (const id in providers) {
        const p = providers[id];
        if (!p || typeof p !== 'object') continue;
        const base = p.baseURL || '';
        if (typeof base === 'string' && isMadModelUrl(base)) {
          return {
            ns: ns,
            id: id,
            base: base,
            apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '',
            displayName: typeof p.displayName === 'string' ? p.displayName : '',
          };
        }
      }
    }
    return null;
  }
  function providerPatch(id, value) {
    // Runs directly in the DSH host process (no node:vm sandbox in the bundle form),
    // so plain objects are already Host-realm objects that dsh-settings accepts.
    const patch = { providers: {} };
    patch.providers[id] = value;
    return patch;
  }
  async function applyToProvider(token) {
    const res = { provider: '', providerName: '', detail: '', credentialWritten: false, err: '' };
    try {
      if (!credSvc || typeof credSvc.set !== 'function') { res.err += 'credentials service unavailable; '; }
      else {
        let current = null;
        try { current = await credSvc.resolve(CRED_REF); } catch (e) {}
        if (current && current.value === token) res.credentialWritten = true;
        else { await credSvc.set(CRED_REF, token); res.credentialWritten = true; }
      }
    } catch (e) { res.err += 'credential:' + String((e && e.message) || e) + '; '; }
    try {
      if (!settingsSvc || typeof settingsSvc.get !== 'function') { res.err += 'settings service unavailable; '; return res; }
      const found = await findProvider();
      if (found) {
        res.provider = found.ns + '/' + found.id;
        res.providerName = found.displayName || PROVIDER_NAME;
        res.detail = 'found';
        if (found.apiKeyEnv !== CRED_REF) {
          const cur = await settingsSvc.get(found.ns);
          if (cur) {
            await settingsSvc.update(found.ns, providerPatch(found.id, { apiKeyEnv: CRED_REF }));
            res.detail = 'apiKeyEnv-set';
          }
        }
      } else {
        const ns = 'llm-pi-ai';
        const cur = await settingsSvc.get(ns);
        if (cur) {
          if (cur.providers && Object.hasOwn(cur.providers, PROVIDER_KEY)) {
            throw new Error('Provider "madmodel" 已被其他配置占用；请重命名该配置后重试。');
          }
          await settingsSvc.update(ns, providerPatch(PROVIDER_KEY, {
            displayName: PROVIDER_NAME,
            apiKeyEnv: CRED_REF,
            api: 'openai-completions',
            reasoning: 'medium',
            baseURL: PROVIDER_BASE,
            models: MODEL_PROFILE,
          }));
          res.provider = ns + '/' + PROVIDER_KEY;
          res.providerName = PROVIDER_NAME;
          res.detail = 'created';
        } else res.err += 'settings namespace "llm-pi-ai" unavailable; ';
      }
    } catch (e) { res.err += 'settings:' + String((e && e.message) || e) + '; '; }
    return res;
  }
  const statePath = function () { return baseDir + '\\state.json'; };
  const loadedStatus = function () {
    if (!state.token || !state.lastGetAt) return 'idle';
    return deps.clock.now() - state.lastGetAt >= TOKEN_LIFETIME_MS ? 'expired' : 'ok';
  };
  async function saveState() {
    ensureBaseDir();
    const saved = await deps.stateIO.save(statePath(), {
      // The API token belongs in DSH's credential store, never in this state file.
      cookies: state.cookies, ssoCookies: state.ssoCookies,
      lastGetAt: state.lastGetAt, auto: state.auto,
    });
    if (!saved || !saved.ok) throw new Error('state save failed: ' + String((saved && saved.error) || 'unknown error'));
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
          state.credentialWritten = !!credentialToken;
          state.status = loadedStatus();
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
            } catch (e) {}
          }
          state.status = loadedStatus();
        }
        if (state.token && settingsSvc && typeof settingsSvc.get === 'function') {
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
    // expiresAt is derived from lastGetAt + 6h (local-clock consistent) rather than the JWT exp:
    // the mint service stamps iat/exp on a clock ~9.6min AHEAD of the web layer / this machine
    // (verified: mint response Date header == local clock while iat == local + 9.6min), so
    // exp - Date.now() overstates remaining lifetime by ~10min. Site API guide claims 5h for
    // login-issued tokens; check-issued JWTs decode to exactly 6h (exp - iat), sampled repeatedly.
    // Auto refresh at 5h50m only provides a buffer for the assumed 6h lifetime.
    return {
      auto: state.auto, busy: state.busy, lastGetAt: state.lastGetAt, status: state.status, err: state.err,
      loggedIn: !!state.token,
      expiresAt: state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0,
      browserOpen: state.browserOpen, minted: state.minted,
      provider: state.provider, providerName: state.providerName, credentialWritten: state.credentialWritten,
    };
  }
  async function runGetTok() {
    await ensureLoaded();
    if (disposed) return snapshot();
    if (state.busy) return snapshot();
    state.busy = true;
    state.status = 'refreshing';
    state.err = '';
    try {
      const old = state.token;
      let t = '';
      let via = '';
      const d = await mintCheck();
      if (disposed) { state.busy = false; return snapshot(); }
      if (d) { t = d; via = 'mint'; }
      if (!t && state.token) {
        const ok = await authValid(state.token, state.cookies);
        if (disposed) { state.busy = false; return snapshot(); }
        if (ok) { t = state.token; via = 'reuse'; }
      }
      if (!t) {
        const d = await ssoReplay();
        if (disposed) { state.busy = false; return snapshot(); }
        if (d) { t = d; via = 'sso'; }
      }
      if (!t) {
        state.status = 'needs-login';
        state.busy = false;
        const out = snapshot();
        out.loginRequired = true;
        return out;
      }
      state.token = t;
      // Re-validating an old token does not mint a new lifetime. Preserve the original local
      // issuance baseline so Auto cannot accidentally run an aging token for another 5h50m.
      if (via !== 'reuse') state.lastGetAt = deps.clock.now();
      state.minted = via === 'mint';
      const pw = await applyToProvider(t);
      state.provider = pw.provider;
      state.providerName = pw.providerName;
      state.credentialWritten = pw.credentialWritten;
      state.err = pw.err || '';
      state.status = !pw.err && pw.credentialWritten && pw.provider ? 'ok' : 'error';
      try { await saveState(); } catch (e) {
        state.err += 'state:' + String((e && e.message) || e) + '; ';
        if (state.status === 'ok') state.status = 'error';
      }
      state.busy = false;
      const out = snapshot();
      out.fresh = t !== old;
      out.via = via;
      out.loginRequired = false;
      out.detail = pw.detail;
      out.err = state.err;
      return out;
    } catch (e) {
      state.status = 'error';
      state.err = String((e && e.message) || e);
      state.busy = false;
      const out = snapshot();
      out.err = state.err;
      out.loginRequired = false;
      return out;
    } finally {
      state.busy = false;
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
  async function openLogin() {
    await ensureLoaded();
    if (disposed) return { launched: false, reason: 'disposed' };
    if (state.browserOpen) return { launched: false, reason: 'already-open' };
    try {
      ensureBaseDir();
      const made = await deps.stateIO.mkdir(baseDir + '\\profile');
      if (!made || !made.ok) throw new Error('无法创建登录浏览器目录：' + String((made && made.error) || 'unknown error'));
      let availablePort = 0;
      for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
        const probe = await deps.cdp({ port: port, timeoutMs: 1200, probeOnly: true });
        if (disposed) return { launched: false, reason: 'disposed' };
        if (probe && probe.ok) {
          cdpPort = port;
          state.browserOpen = true;
          startCapture();
          return { launched: false, reason: 'reuse', port: port };
        }
        if (!probe || !probe.running) { availablePort = port; break; }
      }
      if (!availablePort) {
        state.status = 'error';
        state.err = '调试端口 9333-9343 均被占用';
        return { launched: false, reason: 'no-debug-port' };
      }
      cdpPort = availablePort;
      const browser = await resolveBrowser();
      if (!browser) {
        state.status = 'error';
        state.err = '未找到 Edge/Chrome';
        return { launched: false, reason: 'no-browser' };
      }
      const launched = await deps.spawnBrowser(browser, [
        '--remote-debugging-port=' + cdpPort,
        '--user-data-dir=' + baseDir + '\\profile',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-session-restore',
        SITE + '/',
      ]);
      if (disposed) return { launched: false, reason: 'disposed' };
      state.browserOpen = true;
      state.status = 'needs-login';
      startCapture();
      return { launched: true, pid: launched && launched.pid, browser: browser, port: cdpPort };
    } catch (e) {
      state.status = 'error';
      state.err = String((e && e.message) || e);
      return { launched: false, reason: 'error', err: state.err };
    }
  }
  function startCapture() {
    if (disposed || captureDispose) return;
    captureElapsed = 0;
    const iv = deps.timer.interval(async function () {
      if (disposed) return;
      captureElapsed += CAPTURE_INTERVAL_MS;
      if (captureElapsed > CAPTURE_TIMEOUT_MS) { stopCapture('timeout'); return; }
      if (captureBusy) return;
      captureBusy = true;
      try {
        const r = await deps.cdp({ port: cdpPort, timeoutMs: 20000 });
        if (disposed) return;
        if (r && r.ok) {
          let done = false;
          const cookie = ckHeader(r.cookies);
          const sh = ssoHeader(r.cookies);
          if (cookie) state.cookies = cookie;
          if (sh) state.ssoCookies = sh;
          let token = '';
          let via = '';
          if (r.token) {
            const valid = await authValid(r.token, cookie);
            if (disposed) return;
            if (valid) { token = r.token; via = 'login'; }
          }
          if (!token) {
            const d = await mintCheck();
            if (disposed) return;
            if (d) { token = d; via = 'capture-mint'; }
          }
          if (token) {
            state.token = token;
            state.lastGetAt = deps.clock.now();
            state.minted = via === 'capture-mint';
            const pw = await applyToProvider(token);
            state.provider = pw.provider;
            state.providerName = pw.providerName;
            state.credentialWritten = pw.credentialWritten;
            state.err = pw.err || '';
            state.status = !pw.err && pw.credentialWritten && pw.provider ? 'ok' : 'error';
            done = true;
          }
          if (done) {
            try { await saveState(); } catch (e) {
              state.err += 'state:' + String((e && e.message) || e) + '; ';
              state.status = 'error';
            }
            stopCapture('captured');
          }
        } else if (r && r.running === false && captureElapsed >= 10000) {
          stopCapture('closed');
        } else if (r && r.error && String(r.error).toLowerCase().indexOf('refused') !== -1) {
          stopCapture('closed');
        }
      } catch (e) { logger.error('[thu-tok-auto] capture', e); }
      finally { captureBusy = false; }
    }, CAPTURE_INTERVAL_MS);
    captureDispose = function () {
      try { iv(); } catch (e) {}
      captureDispose = null;
      captureBusy = false;
      state.browserOpen = false;
    };
  }
  function stopCapture(reason) {
    const was = state.status;
    if (captureDispose) captureDispose();
    if (reason === 'captured' && state.status !== 'error') state.status = 'ok';
    else if (reason === 'closed' && was !== 'ok') { state.status = 'needs-login'; state.err = '登录窗口已关闭'; }
    else if (reason === 'timeout' && was !== 'ok') { state.status = 'needs-login'; state.err = '登录等待超时'; }
  }
  async function autoTick() {
    await ensureLoaded();
    if (disposed) return snapshot();
    if (!state.auto || state.busy || state.browserOpen) return snapshot();
    const now = deps.clock.now();
    const refreshDue = !state.lastGetAt || now - state.lastGetAt >= AUTO_REFRESH_MS;
    const repairDue = !!state.token && (state.status === 'error' || !state.credentialWritten || !state.provider);
    if (!refreshDue && !repairDue) return snapshot();
    if (now - lastAutoAttemptAt < AUTO_RETRY_MS) return snapshot();
    lastAutoAttemptAt = now;
    return runGetTok();
  }
  const api = {
    init: async function () { await ensureLoaded(); return snapshot(); },
    state: async function () { await ensureLoaded(); return snapshot(); },
    setAuto: async function (on) {
      await ensureLoaded();
      if (disposed) return snapshot();
      state.auto = !!on;
      try { await saveState(); } catch (e) {
        state.status = 'error';
        state.err = 'state:' + String((e && e.message) || e);
        return snapshot();
      }
      if (state.auto && (!state.lastGetAt || deps.clock.now() - state.lastGetAt >= AUTO_REFRESH_MS)) return autoTick();
      return snapshot();
    },
    getTok: async function () { return runGetTok(); },
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
    },
  };
  return api;
}
