import fs from 'node:fs'
import vm from 'node:vm'

for (const file of ['lib/host.js', 'lib/client.js']) {
  const source = fs.readFileSync(file, 'utf8')
  new vm.Script(`(function () {\n${source}\n})()`, { filename: file })
}

console.log('DSH dynamic Host/Client syntax: OK')
