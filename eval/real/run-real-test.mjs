// Real-agent eval: text-only tester agents drive the extension's WebMCP tools on live tldraw.com; a vision
// judge checks a clean export of each result against a criteria list; structural checks read the editor state.
//
// Usage: OPENROUTER_API_KEY=... node eval/real/run-real-test.mjs [--tasks smiley,flowchart] [--testers dummy,haiku] [--require haiku,luna] [--skill system|tool|none]
// Default testers are the cheap set (dummy, medium, haiku, luna) gated on haiku + luna; add `sota` for Opus.
// Env overrides: TESTER_DUMMY, TESTER_MEDIUM, TESTER_HAIKU, TESTER_LUNA, TESTER_SOTA, JUDGE_MODEL, MAX_TURNS
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tasks as allTasks, rt } from './tasks.mjs'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.join(root, 'eval/real/out')
mkdirSync(outDir, { recursive: true })

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) throw new Error('OPENROUTER_API_KEY is required')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 20)
const TESTERS = {
  dummy: process.env.TESTER_DUMMY ?? 'meta-llama/llama-3.1-8b-instruct',
  medium: process.env.TESTER_MEDIUM ?? 'deepseek/deepseek-v4-flash',
  haiku: process.env.TESTER_HAIKU ?? 'anthropic/claude-haiku-5.5',
  luna: process.env.TESTER_LUNA ?? 'openai/gpt-5.6-luna',
  sota: process.env.TESTER_SOTA ?? 'anthropic/claude-opus-5.5',
}
// OpenRouter provider routing per tier. DeepInfra's fp8 deepseek-v4-flash drops tool arguments (asked to
// color shapes green it sends {text: "", x: 0, y: 0} and no color; Fireworks/Azure/Parasail get it right 9/9),
// so the medium tier is pinned to providers verified on 2026-11-02.
const PROVIDERS = {
  medium: { order: ['Fireworks', 'Parasail', 'Azure'], allow_fallbacks: false },
}
// Extra request options per tier: the dummy model's providers reject parallel tool calls outright.
const TIER_OPTIONS = { dummy: { parallel_tool_calls: false } }
// Cheap frontier models are the gate; Opus is opt-in because it costs ~20-40x more per run.
const DEFAULT_TESTERS = ['dummy', 'medium', 'haiku', 'luna']
const GATE = ['haiku', 'luna', 'sota']
const JUDGE = process.env.JUDGE_MODEL ?? 'google/gemini-3.8-flash'
const testers = (arg('--testers')?.split(',') ?? DEFAULT_TESTERS).map((k) => {
  if (!TESTERS[k]) throw new Error(`unknown tester ${k}; use ${Object.keys(TESTERS)}`)
  return { tier: k, model: TESTERS[k], provider: PROVIDERS[k], options: TIER_OPTIONS[k] }
})
const tasks = arg('--tasks') ? allTasks.filter((t) => arg('--tasks').split(',').includes(t.id)) : allTasks
// tool (default, what real agents get): only the in-extension tldraw_guide; system: SKILL.md in the system prompt; none: neither.
const skillMode = arg('--skill') ?? 'tool'
if (!['system', 'tool', 'none'].includes(skillMode)) throw new Error('--skill must be system, tool or none')
const useSkill = skillMode === 'system'
const skill = readFileSync(path.join(root, 'skills/ghostdraw/SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '')

// ---------- browser ----------
const browser = (session) => {
  const env = { ...process.env, AGENT_BROWSER_SESSION: session }
  const ab = async (...args) => {
    const { stdout } = await run('agent-browser', ['--json', ...args], { env, maxBuffer: 64 << 20, timeout: 180_000 })
    const res = JSON.parse(stdout)
    if (!res.success) throw new Error(`agent-browser ${args[0]}: ${stdout.slice(0, 300)}`)
    return res.data
  }
  const evalJs = async (js) => JSON.parse((await ab('eval', `(async () => JSON.stringify(await (async () => { const e = window.editor; ${js} })()))()`)).result)
  return { ab, evalJs }
}

// ---------- OpenRouter ----------
const chat = async (body) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'GhostDraw real test' },
      body: JSON.stringify({ ...body, usage: { include: true } }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json.choices?.length) return json
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
  }
}

// Testers are text-only: images in tool results are replaced, and long results truncated.
const forTester = (output) => {
  let text = typeof output === 'string' ? output : JSON.stringify(output)
  text = text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, '[image data omitted: you cannot view images]')
  return text.length > 6000 ? `${text.slice(0, 6000)}… [truncated ${text.length - 6000} chars]` : text
}

const SYSTEM = `You control a live tldraw whiteboard in the user's browser through tools. You cannot see the board or any image: rely on tool results (tldraw_get_canvas) to know what is there. Complete the user's request, check your work, then reply with a one-sentence summary.${useSkill ? `\n\nGuide for these tools:\n\n${skill}` : ''}`

const runAgent = async ({ ab }, { model, provider, options }, prompt, toolDefs) => {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }]
  const log = { toolCalls: [], turns: 0, toolErrors: 0, badArgs: 0, cost: 0, tokens: 0, final: '', stop: 'max_turns' }
  for (; log.turns < MAX_TURNS; log.turns++) {
    const res = await chat({ model, ...(provider && { provider }), ...options, messages, tools: toolDefs, tool_choice: 'auto', max_tokens: 4096 })
    log.cost += res.usage?.cost ?? 0
    log.tokens += res.usage?.total_tokens ?? 0
    const msg = res.choices[0].message
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length && { tool_calls: msg.tool_calls }) })
    if (!msg.tool_calls?.length) {
      log.final = msg.content ?? ''
      log.stop = 'done'
      break
    }
    for (const call of msg.tool_calls) {
      let args, output
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        log.badArgs++
        output = { error: `arguments were not valid JSON: ${call.function.arguments?.slice(0, 200)}` }
      }
      if (args) {
        try {
          output = (await ab('webmcp', 'invoke', call.function.name, '--params', JSON.stringify(args), '--timeout', '120000')).output
        } catch (err) {
          output = { error: String(err.message).slice(0, 300) }
        }
      }
      const text = forTester(output)
      const isError = /^\s*\{\s*"error"/.test(text)
      if (isError) log.toolErrors++
      log.toolCalls.push({ name: call.function.name, args: args ?? call.function.arguments?.slice(0, 1000), error: isError ? text.slice(0, 300) : undefined, output: text.slice(0, 400), said: msg.content?.slice(0, 300) || undefined })
      messages.push({ role: 'tool', tool_call_id: call.id, content: text })
    }
  }
  return log
}

// ---------- facts + judge ----------
const collectFacts = async ({ evalJs }, toolCalls, downloadsDir, before) => {
  const state = await evalJs(`
    const text = (s) => s.props.richText?.content?.map((p) => p.content?.map((n) => n.text ?? '').join('') ?? '').join('\\n')
    return {
      crashed: !!e.getCrashingError(),
      shapes: e.getCurrentPageShapes().map((s) => ({ id: s.id, type: s.type, text: [text(s), s.props.name].filter(Boolean).join(' ') || undefined, color: s.props.color, geo: s.props.geo, bounds: e.getShapePageBounds(s.id) })),
      arrows: e.getCurrentPageShapes().filter((s) => s.type === 'arrow').map((a) => { const to = e.getBindingsFromShape(a.id, 'arrow').map((b) => b.toId); return { id: a.id, to, bound: to.length } }),
    }`)
  // A download triggered by the agent lands asynchronously; give it a moment before checking.
  if (toolCalls.some((c) => c.name === 'tldraw_export' && (c.args?.deliver ?? 'download') === 'download')) {
    for (let i = 0; i < 12 && !readdirSync(downloadsDir).some((f) => !before.has(f) && !f.endsWith('.crdownload')); i++) await new Promise((r) => setTimeout(r, 250))
  }
  return { ...state, toolCalls, downloads: readdirSync(downloadsDir).filter((f) => !before.has(f) && !f.endsWith('.crdownload')) }
}

// The judge marks each criterion met or not, instead of a holistic score (holistic scores anchored at 7 or 3).
// It sees a clean export of the drawing, so tldraw's UI panels can't hide or pollute it.
const judge = async (task, dataUrl) => {
  const list = task.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
  const res = await chat({
    model: JUDGE,
    max_tokens: 800,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `You check an AI agent's drawing on a whiteboard, strictly and literally.\nThe agent was asked: "${task.prompt}"\nFor each criterion, decide if the image clearly satisfies it. If unsure, it is not met.\n${list}\nReply with only JSON: {"met": [true/false for each criterion, in order], "reason": "<one sentence naming what is missing or wrong, or 'all met'>"}` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  })
  const raw = res.choices[0].message.content ?? ''
  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0])
    const met = task.criteria.map((_, i) => parsed.met?.[i] === true)
    return { met, score: Math.round((10 * met.filter(Boolean).length) / met.length), reason: String(parsed.reason ?? ''), cost: res.usage?.cost ?? 0 }
  } catch {
    return { met: task.criteria.map(() => false), score: NaN, reason: `unparseable judge reply: ${raw.slice(0, 120)}`, cost: res.usage?.cost ?? 0 }
  }
}

// Waits for the board to settle (drawing may outlive the agent's last call), then reads when the first change
// appeared, the longest stretch with no change at all, and when the last change landed, in seconds.
const boardTiming = async ({ evalJs }, pageT0) => {
  let last = -1
  for (let quiet = 0, i = 0; quiet < 4 && i < 180; i++) {
    const n = await evalJs('return window.__gdEvents.length')
    quiet = n === last ? quiet + 1 : 0
    last = n
    await new Promise((r) => setTimeout(r, 500))
  }
  const ev = await evalJs('window.__gdStop?.(); return window.__gdEvents')
  if (!ev.length) return { first: null, freeze: null, done: null }
  const s = (ms) => +(ms / 1000).toFixed(1)
  let freeze = ev[0] - pageT0
  for (let i = 1; i < ev.length; i++) freeze = Math.max(freeze, ev[i] - ev[i - 1])
  return { first: s(ev[0] - pageT0), freeze: s(freeze), done: s(ev.at(-1) - pageT0) }
}

// ---------- run ----------
const runTester = async ({ tier, model, provider, options }) => {
  const session = `real-test-${tier}`
  const b = browser(session)
  const downloadsDir = mkdtempSync(path.join(tmpdir(), `tldraw-real-${tier}-`))
  await run('agent-browser', ['close'], { env: { ...process.env, AGENT_BROWSER_SESSION: session } }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  await b.ab('--extension', path.join(root, 'extension'), '--download-path', downloadsDir, 'open', 'https://www.tldraw.com/')
  await b.ab('wait', '3000')
  const toolDefs = (await b.ab('webmcp', 'list')).tools.filter((t) => skillMode !== 'none' || t.name !== 'tldraw_guide').map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
  }))
  const rows = []
  for (const task of tasks) {
    const before = new Set(readdirSync(downloadsDir))
    await b.evalJs(`
      const rt = ${rt.toString()}
      e.deleteShapes([...e.getCurrentPageShapeIds()]); e.setCamera({ x: 0, y: 0, z: 1 }); e.setCurrentTool('select')
      ;(${(task.setup ?? (() => {})).toString()})(e)
      return true`)
    const t0 = Date.now()
    // Responsiveness: tldraw's own change feed, so it counts what the user sees, not what the agent says.
    const pageT0 = await b.evalJs(`window.__gdEvents = []; window.__gdStop?.(); window.__gdStop = e.store.listen(() => window.__gdEvents.push(performance.now()), { source: 'all', scope: 'document' }); return performance.now()`)
    let log
    try {
      log = await runAgent(b, { model, provider, options }, task.prompt, toolDefs)
    } catch (err) {
      log = { toolCalls: [], turns: 0, toolErrors: 0, badArgs: 0, cost: 0, tokens: 0, final: '', stop: `error: ${err.message.slice(0, 200)}` }
    }
    const seconds = Math.round((Date.now() - t0) / 1000)
    const timing = await boardTiming(b, pageT0)
    const facts = await collectFacts(b, log.toolCalls, downloadsDir, before)
    await b.evalJs('e.selectNone(); if (e.getCurrentPageShapeIds().size) e.zoomToFit({ animation: { duration: 0 } }); return true')
    await b.ab('wait', '400')
    const shot = path.join(outDir, `${task.id}--${tier}.png`)
    await b.ab('screenshot', shot)
    const checks = task.checks.map(([name, fn]) => { let ok = false; try { ok = !!fn(facts) } catch {} return { name, ok } })
    if (facts.crashed) checks.push({ name: 'editor not crashed', ok: false })
    const image = await b.evalJs(`
      const ids = [...e.getCurrentPageShapeIds()]
      if (!ids.length) return null
      const { blob } = await e.toImage(ids, { format: 'png', background: true, padding: 32, scale: 1 })
      return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob) })`)
    const grade = image
      ? await judge(task, image)
      : { met: task.criteria.map(() => false), score: 0, reason: 'board is empty', cost: 0 }
    if (image) writeFileSync(shot.replace(/\.png$/, '.export.png'), Buffer.from(image.split(',')[1], 'base64'))
    const pass = checks.every((c) => c.ok) && grade.met.filter(Boolean).length / grade.met.length >= 0.75
    const row = { task: task.id, tier, model, timing, pass, score: grade.score, met: grade.met, reason: grade.reason, checks, seconds, ...log, cost: log.cost + grade.cost, shot: path.basename(shot) }
    rows.push(row)
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${tier.padEnd(6)} ${task.id.padEnd(14)} score ${grade.score}  calls ${log.toolCalls.length} errors ${log.toolErrors}  ${seconds}s  first ${timing.first}s freeze ${timing.freeze}s done ${timing.done}s  $${row.cost.toFixed(4)}  ${checks.filter((c) => !c.ok).map((c) => '✗ ' + c.name).join(', ')}`)
  }
  await run('agent-browser', ['close'], { env: { ...process.env, AGENT_BROWSER_SESSION: session } }).catch(() => {})
  return rows
}

const rows = (await Promise.all(testers.map(runTester))).flat()
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ judge: JUDGE, skillMode, testers, rows }, null, 2))

const md = [
  `## Real-agent test (skill: ${skillMode})`,
  '',
  `Judge: \`${JUDGE}\`. Testers are text-only; a run passes when every structural check holds and the vision judge marks ≥ 75% of the task criteria met (score = criteria met, out of 10).`,
  '',
  `| Task | ${testers.map((t) => `${t.tier}<br>\`${t.model}\``).join(' | ')} |`,
  `|---|${testers.map(() => '---').join('|')}|`,
  ...tasks.map((task) => `| ${task.id} | ${testers.map((t) => {
    const r = rows.find((x) => x.task === task.id && x.tier === t.tier)
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name)
    return `${r.pass ? '✅' : '❌'} ${Number.isNaN(r.score) ? '?' : r.score}/10 · ${r.toolCalls.length} calls${r.toolErrors ? ` · ${r.toolErrors} err` : ''}${failed.length ? `<br>✗ ${failed.join('; ')}` : ''}`
  }).join(' | ')} |`),
  `| **pass rate** | ${testers.map((t) => { const rs = rows.filter((r) => r.tier === t.tier); return `**${rs.filter((r) => r.pass).length}/${rs.length}** · $${rs.reduce((s, r) => s + r.cost, 0).toFixed(3)}` }).join(' | ')} |`,
  '',
  '### Responsiveness (seconds: first change on the board · longest freeze · drawing finished)',
  '',
  `| Task | ${testers.map((t) => t.tier).join(' | ')} |`,
  `|---|${testers.map(() => '---').join('|')}|`,
  ...tasks.map((task) => `| ${task.id} | ${testers.map((t) => { const x = rows.find((r) => r.task === task.id && r.tier === t.tier)?.timing ?? {}; return `${x.first ?? '–'} · ${x.freeze ?? '–'} · ${x.done ?? '–'}` }).join(' | ')} |`),
  '',
  '<details><summary>Judge notes</summary>',
  '',
  ...rows.map((r) => `- **${r.task} / ${r.tier}**: ${r.reason} (${r.seconds}s, stop: ${r.stop})`),
  '',
  '</details>',
].join('\n')
writeFileSync(path.join(outDir, 'report.md'), md)
console.log(`\n${md}`)
// Only frontier tiers gate the exit code; weaker tiers are measured, not gated. --require overrides.
const required = arg('--require')?.split(',') ?? GATE
process.exitCode = rows.filter((r) => required.includes(r.tier)).every((r) => r.pass) ? 0 : 1
