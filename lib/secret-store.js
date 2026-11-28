'use strict';
// Optional credential store for the account-login arm (2026-11-28).
//
// What it is: the user's Tsinghua unified-identity account and password, encrypted with
// Windows DPAPI at CurrentUser scope, in one file of its own. It exists for exactly one
// consumer — the automatic login the renewal ladder may need when the SSO session is gone
// (see lib/auto-login.js) — and for nothing else.
//
// The rules this module is built to keep, in the order the code enforces them:
//   - No plaintext ever touches the disk, a log, an error string, argv or the environment.
//     The only place a secret exists is a short-lived PowerShell process's stdin/stdout and
//     this process's heap for the length of one attempt.
//   - DPAPI is the only cipher. If it is not available, the feature is *off*: there is no
//     "well, write it in plain text then" branch anywhere in this file, and a caller that
//     asks for one gets `supported:false` and a refusal.
//   - The file lives apart from state.json and is restricted to this Windows account.
//     If the restriction cannot be applied, the file is deleted and the feature refuses:
//     an encrypted blob that every account on the box can read is not a secret store.
//   - Writing is atomic (temp file + rename) and the temp file carries the same
//     restriction, so a refused write leaves no readable intermediate behind.
//
// What it deliberately does not do: no key derivation of its own, no custom cipher, no
// environment-variable handoff, no command-line arguments carrying a secret, no cache of a
// decrypted value between calls, and no read path that skips the ACL check.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** The file this module owns, relative to the plugin's data directory. */
export const CREDENTIAL_FILE = 'credentials.dpapi.json';
export const STORE_VERSION = 1;
export const STORE_ALG = 'dpapi-currentuser';

// Bounds on what may be stored. They are not business rules: they keep an accidental paste
// of a whole document out of the store, and they keep a save request honest about size.
export const MAX_USERNAME_LEN = 128;
export const MAX_PASSWORD_LEN = 256;

// The script that talks to DPAPI. It is a constant: nothing about a secret ever reaches
// argv, so this text is the same for every call and safe to read in the source.
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }',
  "$mode = $env:THU_TOK_CRED_MODE",
  "$in = [Console]::In.ReadToEnd()",
  'try {',
  '  if ($mode -eq "protect") {',
  '    $bytes = [Text.Encoding]::UTF8.GetBytes($in)',
  "    $blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
  '    [Console]::Out.Write([Convert]::ToBase64String($blob))',
  '  } elseif ($mode -eq "unprotect") {',
  '    $blob = [Convert]::FromBase64String($in.Trim())',
  "    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')",
  '    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
  '  } else {',
  '    [Console]::Error.Write("bad-mode"); exit 2',
  '  }',
  '} catch {',
  '  # The message names the API, never the payload.',
  '  [Console]::Error.Write("dpapi:" + $_.Exception.GetType().Name); exit 3',
  '}',
].join('\n');

/**
 * A DPAPI adapter that runs one short-lived PowerShell per call and carries the payload on
 * stdin. `stdio` is the reason it is `spawn` and not `execFile`: a secret must never be an
 * argument, and stdin is the one channel that leaves no argv, no environment entry and no
 * file behind.
 *
 * `probe()` is deliberately a real round-trip of a fixed non-secret string rather than a
 * version check: a Windows build where `ProtectedData` loads but refuses to protect is
 * indistinguishable from a missing one at the call site, and this is the call it would fail.
 */
export function createDpapiAdapter(deps = {}) {
  const run = typeof deps.run === 'function' ? deps.run : runPowerShell;
  const timeoutMs = Number(deps.timeoutMs) || 15000;
  let probed = null;

  async function call(mode, payload) {
    const out = await run({ script: PS_SCRIPT, mode, stdin: payload, timeoutMs });
    if (!out || out.ok !== true) return { ok: false, reason: String((out && out.reason) || 'dpapi-failed') };
    return { ok: true, text: String(out.stdout || '') };
  }

  return {
    async probe() {
      if (probed) return probed;
      const sample = 'thu-tok-auto-probe';
      const enc = await call('protect', sample);
      if (!enc.ok) { probed = { ok: false, reason: enc.reason }; return probed; }
      const dec = await call('unprotect', enc.text);
      if (!dec.ok) { probed = { ok: false, reason: dec.reason }; return probed; }
      probed = dec.text === sample ? { ok: true } : { ok: false, reason: 'dpapi-roundtrip-mismatch' };
      return probed;
    },
    protect(plaintext) { return call('protect', String(plaintext)); },
    unprotect(blob) { return call('unprotect', String(blob)); },
  };
}

function runPowerShell(arg) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String(arg.script)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { THU_TOK_CRED_MODE: String(arg.mode) }),
      });
    } catch (e) {
      resolve({ ok: false, reason: 'spawn:' + String((e && e.message) || e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
      finish({ ok: false, reason: 'timeout' });
    }, Number(arg.timeoutMs) || 15000);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (chunk) => { if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8 * 1024) stderr += String(chunk); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: 'spawn:' + String((e && e.message) || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, reason: 'exit-' + code + ':' + stderr.trim().slice(0, 120) });
    });
    try {
      child.stdin.on('error', () => { /* the child may exit before reading; its exit code says why */ });
      child.stdin.end(String(arg.stdin === undefined ? '' : arg.stdin), 'utf8');
    } catch (e) {
      finish({ ok: false, reason: 'stdin:' + String((e && e.message) || e) });
    }
  });
}

/** A revision label for "these exact stored bytes". It is a digest of the *ciphertext*. */
function revisionOf(text) {
  let a = 0x811c9dc5 >>> 0;
  let b = 0x01000193 >>> 0;
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * The store.
 *
 * `deps.baseDir()` answers the plugin's data directory (the same one state.json lives in,
 * so the file follows the existing home override). `deps.acl` is the one seam that makes
 * this a *protected* store; the default uses icacls to drop inherited access and grant the
 * current account full control. A store whose ACL could not be applied reports
 * `supported:false` and refuses to save — the encrypted blob is deleted rather than kept.
 *
 * Every method is fail-closed and answers a named reason. Nothing here throws a secret into
 * an error string: the only strings that can leave are reason words.
 */
export function createSecretStore(deps = {}) {
  const baseDir = typeof deps.baseDir === 'function' ? deps.baseDir : () => '';
  const dpapi = deps.dpapi || createDpapiAdapter();
  const acl = deps.acl || createAclHardener();
  const clock = deps.clock || { now: () => Date.now() };
  const io = deps.fs || {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, text) => fs.writeFileSync(p, text, { encoding: 'utf8', mode: 0o600 }),
    rename: (a, b) => fs.renameSync(a, b),
    remove: (p) => fs.rmSync(p, { force: true }),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    exists: (p) => fs.existsSync(p),
  };

  let cachedStatus = null;

  function filePath() {
    const base = String(baseDir() || '');
    if (!base) return '';
    return path.join(base, CREDENTIAL_FILE);
  }

  function readRecord() {
    const p = filePath();
    if (!p) return { ok: false, reason: 'no-base-dir' };
    if (!io.exists(p)) return { ok: true, record: null };
    let text = '';
    try { text = String(io.readFile(p) || ''); } catch (e) { return { ok: false, reason: 'read-failed' }; }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { return { ok: false, reason: 'corrupt' }; }
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'corrupt' };
    if (Number(parsed.v) !== STORE_VERSION || String(parsed.alg || '') !== STORE_ALG) return { ok: false, reason: 'unsupported-format' };
    if (typeof parsed.payload !== 'string' || !parsed.payload) return { ok: false, reason: 'corrupt' };
    return {
      ok: true,
      record: {
        payload: parsed.payload,
        updatedAt: Number(parsed.updatedAt) || 0,
        revision: String(parsed.revision || ''),
      },
    };
  }

  /** Status only. Answers whether the feature can run and whether something is stored. */
  async function status() {
    if (cachedStatus !== null) return cachedStatus;
    const probe = await dpapi.probe();
    if (!probe || probe.ok !== true) {
      cachedStatus = { supported: false, configured: false, updatedAt: 0, revision: '', reason: String((probe && probe.reason) || 'dpapi-unavailable') };
      return cachedStatus;
    }
    const read = readRecord();
    if (!read.ok) {
      cachedStatus = { supported: true, configured: false, updatedAt: 0, revision: '', reason: read.reason };
      return cachedStatus;
    }
    cachedStatus = {
      supported: true,
      configured: !!read.record,
      updatedAt: read.record ? read.record.updatedAt : 0,
      revision: read.record ? read.record.revision : '',
      reason: '',
    };
    return cachedStatus;
  }

  /** Drop the cached status so the next `status()` re-reads the disk (used after a write). */
  function invalidate() { cachedStatus = null; }

  /**
   * Save (or replace) the account. Both halves are encrypted before anything is written, so
   * a failure at the ACL step can delete a file that never held plaintext.
   */
  async function save(input) {
    const username = String((input && input.username) || '');
    const password = String((input && input.password) || '');
    if (!username.trim()) return { ok: false, reason: 'empty-username' };
    if (!password) return { ok: false, reason: 'empty-password' };
    if (username.length > MAX_USERNAME_LEN) return { ok: false, reason: 'username-too-long' };
    if (password.length > MAX_PASSWORD_LEN) return { ok: false, reason: 'password-too-long' };
    const p = filePath();
    if (!p) return { ok: false, reason: 'no-base-dir' };
    const probe = await dpapi.probe();
    if (!probe || probe.ok !== true) return { ok: false, reason: 'unsupported' };
    const sealed = await dpapi.protect(JSON.stringify({ u: username, p: password }));
    if (!sealed || sealed.ok !== true) return { ok: false, reason: 'encrypt-failed' };
    const record = {
      v: STORE_VERSION,
      alg: STORE_ALG,
      payload: sealed.text,
      updatedAt: clock.now(),
      revision: revisionOf(sealed.text),
    };
    const text = JSON.stringify(record);
    const tmp = p + '.' + String(process.pid) + '.tmp';
    try { io.mkdir(path.dirname(p)); } catch (e) { /* exists */ }
    try {
      io.writeFile(tmp, text);
    } catch (e) {
      try { io.remove(tmp); } catch (e2) { /* nothing to clean */ }
      return { ok: false, reason: 'write-failed' };
    }
    // The temp file is restricted *before* it becomes the store, so there is no window in
    // which a readable copy exists under the final name.
    const tmpAcl = await acl.harden(tmp);
    if (!tmpAcl || tmpAcl.ok !== true) {
      try { io.remove(tmp); } catch (e) { /* best effort */ }
      return { ok: false, reason: 'acl-failed' };
    }
    try {
      io.rename(tmp, p);
    } catch (e) {
      try { io.remove(tmp); } catch (e2) { /* best effort */ }
      return { ok: false, reason: 'write-failed' };
    }
    invalidate();
    return { ok: true, configured: true, updatedAt: record.updatedAt, revision: record.revision };
  }

  /** Remove the stored account. A missing file is a success: the postcondition is the point. */
  async function clear() {
    const p = filePath();
    if (!p) return { ok: false, reason: 'no-base-dir' };
    if (io.exists(p)) {
      try { io.remove(p); } catch (e) { return { ok: false, reason: 'remove-failed' }; }
    }
    invalidate();
    return { ok: true, configured: false };
  }

  /**
   * Decrypt the account for one attempt. The caller may hold this for the length of that
   * attempt and must drop it afterwards; nothing here caches it.
   */
  async function load() {
    const probe = await dpapi.probe();
    if (!probe || probe.ok !== true) return { ok: false, reason: 'unsupported' };
    const read = readRecord();
    if (!read.ok) return { ok: false, reason: read.reason };
    if (!read.record) return { ok: false, reason: 'not-configured' };
    const opened = await dpapi.unprotect(read.record.payload);
    if (!opened || opened.ok !== true) return { ok: false, reason: 'decrypt-failed' };
    let parsed = null;
    try { parsed = JSON.parse(String(opened.text || '')); } catch (e) { return { ok: false, reason: 'corrupt' }; }
    if (!parsed || typeof parsed.u !== 'string' || typeof parsed.p !== 'string') return { ok: false, reason: 'corrupt' };
    return { ok: true, username: parsed.u, password: parsed.p, updatedAt: read.record.updatedAt, revision: read.record.revision };
  }

  return { status, save, clear, load, filePath, invalidate };
}

/**
 * Restrict one file to the current Windows account.
 *
 * `/inheritance:r` drops every inherited grant; the single explicit grant names the account
 * that is running this process. It is the same shape DSH's own secret files use. When the
 * command cannot run (not Windows, no icacls, a refusal), the answer is `ok:false` and the
 * caller deletes what it just wrote.
 */
export function createAclHardener(deps = {}) {
  const run = typeof deps.run === 'function' ? deps.run : runIcacls;
  return {
    async harden(file) {
      if (!file) return { ok: false, reason: 'no-file' };
      const user = process.env.USERNAME || process.env.USER || '';
      if (!user) return { ok: false, reason: 'no-account' };
      const out = await run(['/inheritance:r', '/grant:r', user + ':F', file]);
      return out && out.ok === true ? { ok: true } : { ok: false, reason: String((out && out.reason) || 'icacls-failed') };
    },
  };
}

function runIcacls(args) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn('icacls', [String(args[3])].concat(args.slice(0, 3)), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, reason: 'spawn:' + String((e && e.message) || e) });
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish({ ok: false, reason: 'timeout' }); }, 10000);
    if (timer.unref) timer.unref();
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += String(chunk); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: 'spawn:' + String((e && e.message) || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, reason: 'exit-' + code + ':' + stderr.trim().slice(0, 120) });
    });
  });
}

/**
 * A store backed by nothing: it is what a caller gets when the host platform cannot offer
 * DPAPI. Every write refuses, `status()` says `supported:false`, and `load()` says the same,
 * so the login arm simply never runs. This type exists so "should the feature be on?" has
 * exactly one honest answer instead of a nullable branch at every call site.
 */
export function createUnsupportedStore(reason) {
  const why = String(reason || 'unsupported');
  const answer = async () => ({ ok: false, reason: why });
  return {
    status: async () => ({ supported: false, configured: false, updatedAt: 0, revision: '', reason: why }),
    save: answer,
    clear: answer,
    load: answer,
    filePath: () => '',
    invalidate: () => undefined,
  };
}
