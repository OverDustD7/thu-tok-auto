'use strict';
// THU Tok Auto — Host half.
// get-tok ladder: (1) mint via /auth-login/check (fresh 6h JWT; verified to work WITHOUT login on
// campus network, no cookies/credentials at all) → (2) reuse saved token if still accepted →
// (3) SSO replay with saved id.tsinghua cookies → (4) needs-login (client opens Edge/Chrome + CDP capture).
// On success the fresh token is written into the DSH model provider config:
//   credentials.set('MADMODEL_API_KEY', token)  +  ensure llm-pi-ai.providers.*(baseURL=madmodel) exists.
return {
  inject: ['subprocess', 'timer', 'fs', 'settings', 'credentials'],
  apply(ctx) {
    try {
      const SITE = 'https://madmodel.cs.tsinghua.edu.cn';
      const SSO_APP = 'd736f067a6705ab942df52f958a0f23b'; // md5('DEEPSEEK'), verified against id.tsinghua.edu.cn
      const CDP_PORT_START = 9333;
      const CDP_PORT_END = 9343;
      const CRED_REF = 'MADMODEL_API_KEY';
      const PROVIDER_NAME = 'DeepSeek (THU)';
      const PROVIDER_KEY = 'madmodel';
      const PROVIDER_BASE = 'https://madmodel.cs.tsinghua.edu.cn/v1';
      const TOKEN_LIFETIME_MS = 6 * 3600e3; // empirically exp-iat == 6h on check-issued JWTs (site guide says 5h for login-issued)
      const AUTO_REFRESH_MS = 5 * 3600e3 + 50 * 60e3;
      const AUTO_RETRY_MS = 5 * 60e3;
      const MODEL_PROFILE = [
        {
          id: 'DeepSeek-V4-Flash-0731',
          name: 'DeepSeek-V4-Flash (THU)',
          contextWindow: 150000,
          reasoningEfforts: { minimal: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        },
      ];
      // THIS PLUGIN'S CODE RUNS INSIDE A node:vm SANDBOX (dsh-cordis-host-runner createContext),
      // so every `{}` literal written here belongs to the SANDBOX realm. The settings service
      // validates EVERY node of the patch with isPlainObject comparing against the HOST realm's
      // Object.prototype (dsh-settings write→cloneJsonShaped; the top level rejects sandbox
      // literals with "... must be a plain object", nested nodes with "... JSON-compatible data
      // (found a non-plain object at $...)").
      // Escape: derive the host realm's Object.prototype from any host-realm object (the section
      // returned by settings.get()) and build EVERY object/array of the patch with it.
      const protoOf = function (cur) {
        return Object.getPrototypeOf(cur);
      };
      const hostClone = function (proto, v) {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(function (x) { return hostClone(proto, x); });
        const o = Object.create(proto);
        Object.keys(v).forEach(function (k) { try { o[k] = hostClone(proto, v[k]); } catch (e) {} });
        return o;
      };
      const state = {
        token: '', cookies: '', ssoCookies: '',
        lastGetAt: 0, auto: false, busy: false, status: 'idle', err: '',
        browserOpen: false, minted: false, provider: '', credentialWritten: false,
      };
      let nodeExe = null;
      let cwd = null;
      let baseDir = '';
      let envCache = null;
      let loadPromise = null;
      let captureDispose = null;
      let captureBusy = false;
      let captureElapsed = 0;
      let cdpPort = CDP_PORT_START;
      let lastAutoAttemptAt = 0;
      const sub = ctx.get('subprocess');
      const fsSvc = ctx.get('fs');
      const settingsSvc = ctx.get('settings');
      const credSvc = ctx.get('credentials');
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
        const loc = String(location || '');
        if (/^https:\/\//i.test(loc)) return loc;
        if (loc.indexOf('//') === 0) return 'https:' + loc;
        const origin = String(base).match(/^(https:\/\/[^/]+)/i);
        if (!origin) return '';
        if (loc.indexOf('/') === 0) return origin[1] + loc;
        return String(base).replace(/[^/]*$/, '') + loc;
      };
      const ckHeader = function (cookies) {
        return (cookies || []).filter(function (c) { return cookieAppliesTo(c, 'madmodel.cs.tsinghua.edu.cn'); })
          .map(function (c) { return c.name + '=' + c.value; }).join('; ');
      };
      const ssoHeader = function (cookies) {
        return (cookies || []).filter(isSsoCookie).map(function (c) { return c.name + '=' + c.value; }).join('; ');
      };
      async function ensureEnv() {
        if (envCache) return envCache;
        const r = await helper('env', {});
        envCache = r || { home: '', temp: '', cwd: 'C:\\Windows' };
        const home = envCache.home || envCache.temp || '';
        baseDir = home ? home + '\\.dsh\\madmodel' : 'C:\\Windows\\.dsh-madmodel';
        return envCache;
      }
      async function helper(mode, args) {
        if (!sub) throw new Error('subprocess service unavailable');
        if (!nodeExe) {
          const candidates = ['node', 'node.exe', 'C:\\Program Files\\nodejs\\node.exe'];
          for (const c of candidates) {
            try { nodeExe = await sub.resolveExecutable(c); if (nodeExe) break; } catch (e) { nodeExe = null; }
          }
          if (!nodeExe) {
            try { nodeExe = await sub.resolveExecutable('node'); } catch (e) {}
          }
          if (!nodeExe) throw new Error('node executable not found');
        }
        if (!cwd) {
          try {
            if (fsSvc) { const t = await fsSvc.resolve('.'); cwd = fsSvc.processPath(t); }
          } catch (e) {}
          if (!cwd) cwd = 'C:\\Windows';
        }
        const handle = sub.spawn({
          argv: [nodeExe, '-e', buildHelper(), mode],
          cwd: cwd,
          // Arguments can contain API tokens and cookies. Send them over stdin so secrets never
          // appear in the child command line or process listings.
          stdio: { stdin: { data: JSON.stringify(args || {}) }, stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 128 * 1024 } },
          graceMs: 120000,
        });
        const outcome = await handle.done;
        const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '';
        const err = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '';
        if (outcome.exitCode !== 0) throw new Error('helper ' + mode + ' exit ' + outcome.exitCode + ': ' + String(err).slice(0, 300));
        const parsed = jsonParse(out);
        if (!parsed) throw new Error('helper ' + mode + ' returned invalid JSON');
        return parsed;
      }
      async function httpGet(url, headers, follow) {
        const r = await helper('get', { url: url, headers: headers || {}, follow: follow === false ? false : true, timeoutMs: 25000 });
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
          if (settingsSvc) {
            const desc = await settingsSvc.describe();
            if (Array.isArray(desc)) {
              for (const d of desc) {
                if (!d || typeof d !== 'object') continue;
                const name = d.ns || d.namespace || d.key || '';
                if (typeof name === 'string' && name.indexOf('llm-') === 0 && out.indexOf(name) === -1) out.push(name);
              }
            }
          }
        } catch (e) { console.error('[thu-tok-auto] describe', e); }
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
              return { ns: ns, id: id, base: base, apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '' };
            }
          }
        }
        return null;
      }
      function providerPatch(proto, id, value) {
        const patch = Object.create(proto);
        patch.providers = Object.create(proto);
        patch.providers[id] = hostClone(proto, value);
        return patch;
      }
      async function applyToProvider(token) {
        const res = { provider: '', detail: '', credentialWritten: false, err: '' };
        try {
          if (!credSvc) { res.err += 'credentials service unavailable; '; }
          else {
            let current = null;
            try { current = await credSvc.resolve(CRED_REF); } catch (e) {}
            if (current && current.value === token) res.credentialWritten = true;
            else { await credSvc.set(CRED_REF, token); res.credentialWritten = true; }
          }
        } catch (e) { res.err += 'credential:' + String((e && e.message) || e) + '; '; }
        try {
          if (!settingsSvc) { res.err += 'settings service unavailable; '; return res; }
          const found = await findProvider();
          if (found) {
            res.provider = found.ns + '/' + found.id;
            res.detail = 'found';
            if (found.apiKeyEnv !== CRED_REF) {
              const cur = await settingsSvc.get(found.ns);
              if (cur) {
                const proto = protoOf(cur);
                await settingsSvc.update(found.ns, providerPatch(proto, found.id, { apiKeyEnv: CRED_REF }));
                res.detail = 'apiKeyEnv-set';
              }
            }
          } else {
            const ns = 'llm-pi-ai';
            const cur = await settingsSvc.get(ns);
            if (cur) {
              const proto = protoOf(cur);
              await settingsSvc.update(ns, providerPatch(proto, PROVIDER_KEY, {
                displayName: PROVIDER_NAME,
                apiKeyEnv: CRED_REF,
                api: 'openai-completions',
                reasoning: 'medium',
                baseURL: PROVIDER_BASE,
                models: MODEL_PROFILE,
              }));
              res.provider = ns + '/' + PROVIDER_KEY;
              res.detail = 'created';
            } else res.err += 'settings namespace "llm-pi-ai" unavailable; ';
          }
        } catch (e) { res.err += 'settings:' + String((e && e.message) || e) + '; '; }
        return res;
      }
      const statePath = function () { return baseDir + '\\state.json'; };
      const loadedStatus = function () {
        if (!state.token || !state.lastGetAt) return 'idle';
        return Date.now() - state.lastGetAt >= TOKEN_LIFETIME_MS ? 'expired' : 'ok';
      };
      async function saveState() {
        await ensureEnv();
        const mk = await helper('mkdir', { path: baseDir });
        if (!mk || !mk.ok) throw new Error('state directory creation failed: ' + String((mk && mk.error) || 'unknown error'));
        const saved = await helper('state', {
          op: 'save', path: statePath(),
          // The API token belongs in DSH's credential store, never in this state file.
          data: {
            cookies: state.cookies, ssoCookies: state.ssoCookies,
            lastGetAt: state.lastGetAt, auto: state.auto,
          },
        });
        if (!saved || !saved.ok) throw new Error('state save failed: ' + String((saved && saved.error) || 'unknown error'));
      }
      async function loadState() {
        try {
          await ensureEnv();
          const r = await helper('state', { op: 'load', path: statePath() });
          if (r && r.ok && r.data) {
            const d = r.data;
            let stored = null;
            if (credSvc) {
              try { stored = await credSvc.resolve(CRED_REF); } catch (e) {}
            }
            const credentialToken = stored && typeof stored.value === 'string' ? stored.value : '';
            const legacyToken = typeof d.token === 'string' ? d.token : '';
            state.token = credentialToken || legacyToken;
            state.cookies = typeof d.cookies === 'string' ? d.cookies.slice(0, 65536) : '';
            state.ssoCookies = typeof d.ssoCookies === 'string' ? d.ssoCookies.slice(0, 65536) : '';
            const savedAt = typeof d.lastGetAt === 'number' && Number.isFinite(d.lastGetAt) ? d.lastGetAt : 0;
            state.lastGetAt = savedAt > 0 && savedAt <= Date.now() + 5 * 60e3 ? Math.min(savedAt, Date.now()) : 0;
            state.auto = !!d.auto;
            state.credentialWritten = !!credentialToken;
            state.status = loadedStatus();
            // Migrate legacy state files that contained the token in plaintext.
            if (legacyToken && credSvc) {
              try {
                if (!credentialToken) { await credSvc.set(CRED_REF, legacyToken); state.credentialWritten = true; }
                await saveState();
              } catch (e) { console.error('[thu-tok-auto] legacy token migration', e); }
            }
          } else if (r && r.ok) {
            if (credSvc) {
              try {
                const stored = await credSvc.resolve(CRED_REF);
                state.token = stored && typeof stored.value === 'string' ? stored.value : '';
                state.credentialWritten = !!state.token;
              } catch (e) {}
            }
            state.status = loadedStatus();
          }
          if (state.token && settingsSvc) {
            try {
              const found = await findProvider();
              if (found) state.provider = found.ns + '/' + found.id;
            } catch (e) {}
          }
        } catch (e) { console.error('[thu-tok-auto] load', e); }
      }
      function ensureLoaded() {
        if (!loadPromise) loadPromise = loadState();
        return loadPromise;
      }
      function snapshot() {
        // expiresAt is derived from lastGetAt + 6h (local-clock consistent) rather than the JWT exp:
        // the mint service stamps iat/exp on a clock ~9.6min AHEAD of the web layer / this machine
        // (verified: mint response Date header == local clock while iat == local + 9.6min), so
        // exp - Date.now() overstates remaining lifetime by ~10min. Site API guide claims 5h for
        // login-issued tokens; check-issued JWTs decode to exactly 6h (exp - iat), sampled repeatedly.
        // Auto refresh at 5h50m stays safe under either reading.
        return {
          auto: state.auto, busy: state.busy, lastGetAt: state.lastGetAt, status: state.status, err: state.err,
          loggedIn: !!state.token,
          expiresAt: state.lastGetAt ? state.lastGetAt + TOKEN_LIFETIME_MS : 0,
          browserOpen: state.browserOpen, minted: state.minted,
          provider: state.provider, credentialWritten: state.credentialWritten,
        };
      }
      async function runGetTok() {
        await ensureLoaded();
        if (state.busy) return snapshot();
        state.busy = true;
        state.status = 'refreshing';
        state.err = '';
        try {
          const old = state.token;
          let t = '';
          let via = '';
          const d = await mintCheck();
          if (d) { t = d; via = 'mint'; }
          if (!t && state.token) {
            const ok = await authValid(state.token, state.cookies);
            if (ok) { t = state.token; via = 'reuse'; }
          }
          if (!t) {
            const d = await ssoReplay();
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
          if (via !== 'reuse') state.lastGetAt = Date.now();
          state.minted = via === 'mint';
          const pw = await applyToProvider(t);
          state.provider = pw.provider;
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
        const cands = [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
        for (const c of cands) {
          try { return await sub.resolveExecutable(c); } catch (e) {}
        }
        return null;
      }
      async function openLogin() {
        await ensureLoaded();
        if (state.browserOpen) return { launched: false, reason: 'already-open' };
        try {
          await ensureEnv();
          await helper('mkdir', { path: baseDir + '\\profile' });
          let availablePort = 0;
          for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
            const probe = await helper('wscdp', { port: port, timeoutMs: 1200, probeOnly: true });
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
          const handle = sub.spawn({
            argv: [
              browser,
              '--remote-debugging-port=' + cdpPort,
              '--user-data-dir=' + baseDir + '\\profile',
              '--no-first-run',
              '--no-default-browser-check',
              '--no-session-restore',
              SITE + '/',
            ],
            cwd: 'C:\\Windows',
            stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 5000,
          });
          handle.done.catch(function (e) { console.error('[thu-tok-auto] browser process', e); });
          state.browserHandle = handle;
          state.browserOpen = true;
          state.status = 'needs-login';
          startCapture();
          return { launched: true, pid: handle.pid, browser: browser, port: cdpPort };
        } catch (e) {
          state.status = 'error';
          state.err = String((e && e.message) || e);
          return { launched: false, reason: 'error', err: state.err };
        }
      }
      function startCapture() {
        if (captureDispose) return;
        captureElapsed = 0;
        const iv = ctx.interval(async function () {
          captureElapsed += 2500;
          if (captureElapsed > 20 * 60 * 1000) { stopCapture('timeout'); return; }
          if (captureBusy) return;
          captureBusy = true;
          try {
            const r = await helper('wscdp', { port: cdpPort, timeoutMs: 20000 });
            if (r && r.ok) {
              let done = false;
              const cookie = ckHeader(r.cookies);
              const sh = ssoHeader(r.cookies);
              if (cookie) state.cookies = cookie;
              if (sh) state.ssoCookies = sh;
              let token = '';
              let via = '';
              if (r.token && await authValid(r.token, cookie)) { token = r.token; via = 'login'; }
              if (!token) {
                const d = await mintCheck();
                if (d) { token = d; via = 'capture-mint'; }
              }
              if (token) {
                state.token = token;
                state.lastGetAt = Date.now();
                state.minted = via === 'capture-mint';
                const pw = await applyToProvider(token);
                state.provider = pw.provider;
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
          } catch (e) { console.error('[thu-tok-auto] capture', e); }
          finally { captureBusy = false; }
        }, 2500);
        captureDispose = function () { try { iv(); } catch (e) {} captureDispose = null; captureBusy = false; state.browserOpen = false; };
      }
      function stopCapture(reason) {
        const was = state.status;
        if (captureDispose) captureDispose();
        if (reason === 'captured' && state.status !== 'error') state.status = 'ok';
        else if (reason === 'closed' && was !== 'ok') { state.status = 'needs-login'; state.err = '登录窗口已关闭'; }
        else if (reason === 'timeout' && was !== 'ok') { state.status = 'needs-login'; state.err = '登录等待超时'; }
      }
      function buildHelper() {
        return [
          "'use strict';",
          "const mode = process.argv[1];",
          "let arg = {};",
          "try { arg = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}'); } catch (e) {}",
          "const OUT = function (o) { console.log(JSON.stringify(o)); };",
          "const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };",
          "if (mode === 'env') {",
          "  OUT({ home: process.env.USERPROFILE || process.env.HOME || '', temp: process.env.TEMP || process.env.TMP || '', cwd: process.cwd() });",
          "} else if (mode === 'mkdir') {",
          "  try { require('fs').mkdirSync(arg.path, { recursive: true }); OUT({ ok: true }); } catch (e) { OUT({ ok: false, error: String(e && e.message || e) }); }",
          "} else if (mode === 'state') {",
          "  const fs = require('fs');",
          "  try {",
          "    if (arg.op === 'load') {",
          "      if (fs.existsSync(arg.path)) OUT({ ok: true, data: JSON.parse(fs.readFileSync(arg.path, 'utf8')) });",
          "      else OUT({ ok: true, data: null });",
          "    } else if (arg.op === 'save') {",
          "      fs.mkdirSync(require('path').dirname(arg.path), { recursive: true });",
          "      const tmp = arg.path + '.tmp-' + process.pid;",
          "      fs.writeFileSync(tmp, JSON.stringify(arg.data), { encoding: 'utf8', mode: 0o600 });",
          "      fs.renameSync(tmp, arg.path);",
          "      try { fs.chmodSync(arg.path, 0o600); } catch (e) {}",
          "      OUT({ ok: true });",
          "    } else OUT({ ok: false, error: 'bad op' });",
          "  } catch (e) { OUT({ ok: false, error: String(e && e.message || e) }); }",
          "} else if (mode === 'get') {",
          "  (async function () {",
          "    try {",
          "      const init = { redirect: arg.follow === false ? 'manual' : 'follow', signal: AbortSignal.timeout(arg.timeoutMs || 20000) };",
          "      if (arg.headers) init.headers = arg.headers;",
          "      const r = await fetch(arg.url, init);",
          "      const text = await r.text();",
          "      OUT({ status: r.status, ok: r.ok, location: r.headers.get('location') || '', text: text });",
          "    } catch (e) { OUT({ error: String(e && e.message || e) }); }",
          "  })();",
          "} else if (mode === 'wscdp') {",
          "  (async function () {",
          "    try {",
          "      const port = arg.port || 9333;",
          "      const deadline = Date.now() + (arg.timeoutMs || 20000);",
          "      let pages = null;",
          "      while (Date.now() < deadline) {",
          "        try {",
          "          const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) });",
          "          if (r.ok) { pages = await r.json(); break; }",
          "        } catch (e) {}",
          "        await sleep(300);",
          "      }",
          "      if (!pages || !pages.length) { OUT({ ok: false, running: false, reason: 'no-devtools' }); return; }",
          "      let target = null;",
          "      const hostname = function (u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };",
          "      const score = function (u) {",
          "        const h = hostname(u);",
          "        if (h === 'madmodel.cs.tsinghua.edu.cn') return 3;",
          "        if (h === 'id.tsinghua.edu.cn' || h === 'oauth.tsinghua.edu.cn') return 2;",
          "        if (h === 'tsinghua.edu.cn' || h.endsWith('.tsinghua.edu.cn')) return 1;",
          "        return 0;",
          "      };",
          "      let best = 0;",
          "      for (const p of pages) {",
          "        if (p.type === 'page') {",
          "          const s = score(p.url || '');",
          "          if (s > best) { best = s; target = p; }",
          "        }",
          "      }",
          "      if (!target || !target.webSocketDebuggerUrl) { OUT({ ok: false, running: true, reason: 'no-target' }); return; }",
          "      if (arg.probeOnly) { OUT({ ok: true, running: true, url: target.url || '' }); return; }",
          "      let debuggerUrl = null;",
          "      try { debuggerUrl = new URL(target.webSocketDebuggerUrl); } catch (e) {}",
          "      const debuggerHost = debuggerUrl ? debuggerUrl.hostname.toLowerCase() : '';",
          "      if (!debuggerUrl || debuggerUrl.protocol !== 'ws:' ||",
          "          (debuggerHost !== '127.0.0.1' && debuggerHost !== 'localhost' && debuggerHost !== '[::1]') ||",
          "          Number(debuggerUrl.port) !== port) { OUT({ ok: false, running: true, reason: 'unsafe-debugger-url' }); return; }",
          "      const ws = new WebSocket(debuggerUrl.href);",
          "      let nextId = 1;",
          "      const pending = {};",
          "      const send = function (method, params) {",
          "        return new Promise(function (resolve, reject) {",
          "          const id = nextId++;",
          "          pending[id] = { resolve: resolve, reject: reject };",
          "          try { ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); } catch (e) { delete pending[id]; reject(e); return; }",
          "          setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('cdp timeout ' + method)); } }, 8000);",
          "        });",
          "      };",
          "      ws.onmessage = function (ev) {",
          "        try {",
          "          const m = JSON.parse(ev.data);",
          "          if (m.id && pending[m.id]) { pending[m.id].resolve(m); delete pending[m.id]; }",
          "        } catch (e) {}",
          "      };",
          "      await new Promise(function (resolve, reject) {",
          "        ws.onopen = resolve;",
          "        ws.onerror = function () { reject(new Error('ws error')); };",
          "        setTimeout(function () { reject(new Error('ws open timeout')); }, 6000);",
          "      });",
          "      try { await send('Network.enable', {}); } catch (e) {}",
          "      let ck = null;",
          "      try { ck = await send('Network.getAllCookies', {}); } catch (e) {}",
          "      let ev = null;",
          "      try {",
          "        ev = await send('Runtime.evaluate', {",
          "          expression: \"(function(){try{var u=window.localStorage.getItem('user');var t='';if(u){try{t=(JSON.parse(u).token)||''}catch(e){}}return JSON.stringify({token:t,url:location.href})}catch(e){return JSON.stringify({error:String(e)})}})()\",",
          "          returnByValue: true,",
          "        });",
          "      } catch (e) {}",
          "      const cookies = (ck && ck.result && ck.result.cookies) || [];",
          "      const picked = [];",
          "      for (const c of cookies) {",
          "        const d = String(c.domain || '').toLowerCase().replace(/^\\.+/, '');",
          "        if (d === 'tsinghua.edu.cn' || d.endsWith('.tsinghua.edu.cn')) picked.push({ name: c.name, value: c.value, domain: d, secure: !!c.secure, httpOnly: !!c.httpOnly });",
          "      }",
          "      let token = '';",
          "      let url = '';",
          "      try {",
          "        const rv = ev && ev.result && ev.result.result && ev.result.result.value;",
          "        if (rv) { const j = JSON.parse(rv); url = typeof j.url === 'string' ? j.url : ''; if (hostname(url) === 'madmodel.cs.tsinghua.edu.cn' && typeof j.token === 'string') token = j.token; }",
          "      } catch (e) {}",
          "      try { ws.close(); } catch (e) {}",
          "      OUT({ ok: true, token: token, url: url, cookies: picked });",
          "    } catch (e) { OUT({ ok: false, error: String(e && e.message || e) }); }",
          "  })();",
          "}",
        ].join('\n');
      }
      async function autoTick() {
        await ensureLoaded();
        if (!state.auto || state.busy || state.browserOpen) return snapshot();
        const now = Date.now();
        const refreshDue = !state.lastGetAt || now - state.lastGetAt >= AUTO_REFRESH_MS;
        const repairDue = !!state.token && (state.status === 'error' || !state.credentialWritten || !state.provider);
        if (!refreshDue && !repairDue) return snapshot();
        if (now - lastAutoAttemptAt < AUTO_RETRY_MS) return snapshot();
        lastAutoAttemptAt = now;
        return runGetTok();
      }
      harness.handle('mmtok/init', async function () { await ensureLoaded(); return snapshot(); });
      harness.handle('mmtok/state', async function () { await ensureLoaded(); return snapshot(); });
      harness.handle('mmtok/set-auto', async function (args) {
        await ensureLoaded();
        state.auto = !!(args && args.on);
        try { await saveState(); } catch (e) {
          state.status = 'error';
          state.err = 'state:' + String((e && e.message) || e);
          return snapshot();
        }
        if (state.auto && (!state.lastGetAt || Date.now() - state.lastGetAt >= AUTO_REFRESH_MS)) return autoTick();
        return snapshot();
      });
      harness.handle('mmtok/get-tok', async function () { return runGetTok(); });
      harness.handle('mmtok/open-login', async function () { return openLogin(); });
      harness.handle('mmtok/clientlog', async function (args) {
        try { console.error('[thu-tok-auto:client]', (args && args.tag) || '', (args && args.err) || ''); } catch (e) {}
        return { ok: true };
      });
      // Auto-refresh lives in the Host half, so it keeps running even when F5 detaches the dynamic
      // Client UI. The first tick also loads persisted state without waiting for a browser page.
      ensureLoaded().catch(function (e) { console.error('[thu-tok-auto] initial load', e); });
      ctx.interval(function () {
        return autoTick().catch(function (e) { console.error('[thu-tok-auto] auto tick', e); });
      }, 30000);
      return;
    } catch (e) {
      console.error('[thu-tok-auto] apply', e);
      return;
    }
  },
};
