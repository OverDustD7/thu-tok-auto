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
if (!ui.includes('mmtok-auto-on')) throw new Error('ui.js missing auto-on (green "Auto ✓") style')
if (!ui.includes('/thu-tok-auto/api')) throw new Error('ui.js missing API base')
if (!ui.includes('findSettingsTrigger')) throw new Error('ui.js missing settings-trigger lookup')
if (!ui.includes('footAreaOf')) throw new Error('ui.js missing foot-area lookup')
if (!ui.includes('insertBefore(box, foot.firstChild)')) throw new Error('ui.js must mount above existing footer buttons')
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

console.log('Bundle form checks: OK')
