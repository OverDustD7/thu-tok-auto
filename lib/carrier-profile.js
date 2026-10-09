/**
 * Where a carrier browser keeps its profile — one spelling of the answer, shared by
 * `core.js` (which starts the browser and decides which directory to hand it), `index.js`
 * (which reads the process table and normalises paths) and `stop-owned.js` (which cleans up
 * after a proven close). It is a separate module with no imports of its own so that none of
 * those three has to reach into another (2026-10-05 round 17).
 *
 * The two kinds of directory, and why both exist:
 *
 * - **shared** (`<baseDir>\profile`): the historical one. Cookies, caches and the site's own
 *   `localStorage` (where the device fingerprint lives) survive between runs, which is what
 *   made the very first manual login reusable at all.
 * - **isolated** (`<baseDir>\run-<id>`): one run's own directory, used only when the shared
 *   one is not ours to use — a stranger is sitting on our debug ports, or our own previous
 *   browser could not be proven closed. A second Chromium started on a profile another
 *   process already holds does *not* become a second browser: the singleton hands the argv
 *   to the running instance and the debug port we asked for never answers. Measured on this
 *   machine (round 12) and the reason the old code refused to spawn at all in that case.
 *   Isolating is what lets a click make progress without touching what is not ours — and an
 *   isolated directory is this plugin's own to delete once the browser that used it is gone.
 *
 * The name `run-<id>` is not a guess about content: `isIsolatedProfile` only ever says yes
 * for a directory that sits *exactly* one level under `<baseDir>` and starts with `run-`,
 * so the shared `profile` can never be mistaken for one of ours to remove.
 */
export const ISOLATED_PREFIX = 'run-';

/** A Windows path as one comparable value: separators unified, trailing ones dropped, folded. */
export function normalizePath(value) {
  return String(value || '').trim().replace(/^"|"$/g, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function trimTrailingSeparators(value) {
  return String(value || '').replace(/[\\/]+$/, '');
}

/** The long-lived profile: `<baseDir>\profile`. Empty when there is no base directory yet. */
export function sharedProfilePath(baseDir) {
  const base = trimTrailingSeparators(baseDir);
  return base ? base + '\\profile' : '';
}

/** One run's own profile: `<baseDir>\run-<spawnId>`. Empty when either half is missing. */
export function isolatedProfilePath(baseDir, spawnId) {
  const base = trimTrailingSeparators(baseDir);
  const id = String(spawnId || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 40);
  if (!base || !id) return '';
  return base + '\\' + ISOLATED_PREFIX + id;
}

/**
 * Is this directory one this plugin may delete after using it? True only for a directory
 * exactly one level below `baseDir` whose name is `run-` plus something. `<baseDir>\profile`
 * itself, a nested path, `run-` with nothing after it, and anything outside `baseDir` are all
 * false — a wrong `true` here deletes a profile that is not ours to delete.
 */
export function isIsolatedProfile(dir, baseDir) {
  const want = normalizePath(dir);
  const base = normalizePath(baseDir);
  if (!want || !base || want.length <= base.length + 1) return false;
  if (want.slice(0, base.length + 1) !== base + '\\') return false;
  const rest = want.slice(base.length + 1);
  if (!rest || rest.indexOf('\\') !== -1) return false;
  return rest.slice(0, ISOLATED_PREFIX.length) === ISOLATED_PREFIX && rest.length > ISOLATED_PREFIX.length;
}
