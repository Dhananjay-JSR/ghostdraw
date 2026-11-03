// Validates the extension before it is packaged; shared by the release and pull-request workflows.
// Usage: node scripts/check-extension.mjs   (prints the manifest version)
import { execFileSync } from 'node:child_process'
import { readFileSync, accessSync } from 'node:fs'

execFileSync(process.execPath, ['--check', 'extension/ghostdraw.js'], { stdio: 'inherit' })
execFileSync(process.execPath, ['scripts/build-guide.mjs', '--check'], { stdio: 'inherit' })
const m = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))
if (m.manifest_version !== 3) throw new Error('manifest_version must be 3')
if (!/^\d+(\.\d+){0,3}$/.test(m.version)) throw new Error(`invalid Chrome version: ${m.version}`)
for (const cs of m.content_scripts) for (const f of cs.js) accessSync(`extension/${f}`)
console.log(m.version)
