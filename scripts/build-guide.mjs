// Embeds skills/tldraw-webmcp/SKILL.md into the extension as extension/guide.js, so every agent can read the
// guide through the tldraw_guide tool, not only agents that have the skill installed.
// Usage: node scripts/build-guide.mjs          (write)
//        node scripts/build-guide.mjs --check  (exit 1 if guide.js is out of date; used in CI)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(path.join(root, 'skills/tldraw-webmcp/SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n+/, '')

// One entry per "## " section, keyed by its first word ("Workflow" -> "workflow"); the intro before them is "intro".
const sections = {}
const parts = skill.split(/^## /m)
sections.intro = parts[0].trim()
for (const part of parts.slice(1)) {
  const [heading] = part.split('\n', 1)
  sections[heading.trim().split(/\s+/)[0].toLowerCase()] = `## ${part.trim()}`
}

const out = path.join(root, 'extension/guide.js')
const js = `// Generated from skills/tldraw-webmcp/SKILL.md by scripts/build-guide.mjs. Do not edit by hand.
window.__tldrawWebMCPGuide = ${JSON.stringify(sections, null, 2)}
`
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== js) {
    console.error('extension/guide.js is out of date; run: node scripts/build-guide.mjs')
    process.exit(1)
  }
  console.log('guide.js is up to date')
} else {
  writeFileSync(out, js)
  console.log(`wrote extension/guide.js: ${Object.keys(sections).join(', ')}`)
}
