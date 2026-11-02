// Head-to-head on live tldraw.com: the same model and tasks, driven either through GhostDraw's WebMCP tools
// ("webmcp", text only) or as a generic browser agent ("browser": screenshots it can see, accessibility
// snapshot, click, mouse drag, keyboard; the toolkit browser-use / agent-browser give an agent).
// Both are graded identically on outcomes only: editor state checks + the same vision judge.
// Report: docs/vs-browser-agent.md.
// Usage: OPENROUTER_API_KEY=... node eval/vs-browser/compare.mjs [--models haiku,luna,deepseek] [--arms webmcp,browser] [--tasks a,b] [--out results.json]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const { tasks: allTasks, rt } = await import(`${REPO}/eval/real/tasks.mjs`)
const run = promisify(execFile)
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'out')
mkdirSync(OUT, { recursive: true })
const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) throw new Error('OPENROUTER_API_KEY is required')
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const MAX_TURNS = 30
const MODELS = { haiku: 'anthropic/claude-haiku-5.5', luna: 'openai/gpt-5.6-luna', deepseek: 'deepseek/deepseek-v4-flash' }
// deepseek-v4-flash has no image input: a pure text model. Pinned to providers that keep tool arguments intact (see run-real-test.mjs).
const TEXT_ONLY = new Set(['deepseek'])
const PROVIDERS = { deepseek: { order: ['Fireworks', 'Parasail', 'Azure'], allow_fallbacks: false } }
const JUDGE = 'google/gemini-3.8-flash'
const models = (arg('--models') ?? 'haiku,luna,deepseek').split(',')
const arms = (arg('--arms') ?? 'webmcp,browser').split(',')
const tasks = arg('--tasks') ? allTasks.filter((t) => arg('--tasks').split(',').includes(t.id)) : allTasks

// Outcome checks only (no "which tool was called"), so both arms are graded on what ends up on the board.
const txt = (f) => f.shapes.map((s) => (s.text ?? '').toLowerCase())
const has = (f, w) => txt(f).some((t) => t.includes(w))
// Any shade counts (tldraw has green and light-green, blue and light-blue): graded on what the user asked for.
const hue = (s, c) => s.color === c || s.color === `light-${c}`
const idOf = (f, label) => f.shapes.find((s) => s.text === label)?.id
const pngAlpha = (file) => { const b = readFileSync(file); return b.toString('ascii', 1, 4) === 'PNG' && [4, 6].includes(b[25]) }
const CHECKS = {
  smiley: [['3+ parts drawn', (f) => f.shapes.length >= 3]],
  'smooth-wave': [['a blue shape', (f) => f.shapes.some((s) => hue(s, 'blue'))], ['a green shape', (f) => f.shapes.some((s) => hue(s, 'green'))]],
  flowchart: [['all 4 labels', (f) => ['open app', 'enter credentials', 'verify', 'dashboard'].every((w) => has(f, w))], ['3+ arrows bound at both ends', (f) => f.arrows.filter((a) => a.bound === 2).length >= 3]],
  'pen-house': [['a red shape', (f) => f.shapes.some((s) => s.color === 'red')]],
  'retro-board': [['3 titles', (f) => ['went well', 'to improve', 'action items'].every((w) => has(f, w))], ['3+ sticky notes', (f) => f.shapes.filter((s) => s.type === 'note').length >= 3]],
  'edit-existing': [
    ['tops aligned', (f) => { const [a, b] = ['A', 'B'].map((t) => f.shapes.find((s) => s.text === t)); return a && b && Math.abs(a.bounds.y - b.bounds.y) < 2 }],
    ['both green', (f) => ['A', 'B'].every((t) => { const s = f.shapes.find((x) => x.text === t); return s && hue(s, 'green') })],
    ['arrow bound to A and B', (f) => f.arrows.some((a) => a.to.includes(idOf(f, 'A')) && a.to.includes(idOf(f, 'B')))],
  ],
  'export-png': [['transparent PNG downloaded', (f) => f.downloads.some((d) => d.endsWith('.png') && pngAlpha(path.join(f.dir, d)))], ['star untouched', (f) => f.shapes.some((s) => s.geo === 'star')]],
}

const chat = async (body) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'GhostDraw vs browser agent' },
      body: JSON.stringify({ ...body, usage: { include: true } }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json.choices?.length) return json
    if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
  }
}

const browser = (session, extraEnv = {}) => {
  const env = { ...process.env, AGENT_BROWSER_SESSION: session, ...extraEnv }
  const ab = async (...args) => {
    const { stdout } = await run('agent-browser', ['--json', ...args], { env, maxBuffer: 64 << 20, timeout: 180_000 })
    const res = JSON.parse(stdout)
    if (!res.success) throw new Error(`agent-browser ${args[0]}: ${stdout.slice(0, 300)}`)
    return res.data
  }
  const evalJs = async (js) => JSON.parse((await ab('eval', `(async () => JSON.stringify(await (async () => { const e = window.editor; ${js} })()))()`)).result)
  return { ab, evalJs }
}

// ---------- the generic browser agent's toolkit ----------
const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })
const pt = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }
const BROWSER_TOOLS = [
  fn('screenshot', 'Capture the visible page (1280x720 CSS px). The image is shown to you; its pixels are the coordinates every mouse tool uses.'),
  fn('snapshot', 'Accessibility tree of interactive elements with refs like @e12 (menus, buttons, inputs).'),
  fn('click', 'Click an element by ref from snapshot, e.g. "@e12".', { ref: { type: 'string' } }, ['ref']),
  fn('click_at', 'Click at page coordinates.', { x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean', description: 'double-click (e.g. to edit text in a shape)' } }, ['x', 'y']),
  fn('drag', 'Press the left mouse button at the first point, move through every point in order, release at the last. Use it to draw with the pencil, draw a shape or arrow, move or select things.', { points: { type: 'array', items: pt, minItems: 2 } }, ['points']),
  fn('type_text', 'Type text with the keyboard into whatever has focus.', { text: { type: 'string' } }, ['text']),
  fn('press', 'Press a key or chord, e.g. "Escape", "Enter", "r", "Control+a".', { key: { type: 'string' } }, ['key']),
]
const runBrowserTool = async ({ ab }, name, a, shotFile) => {
  const at = async ([x, y]) => ab('mouse', 'move', String(Math.round(x)), String(Math.round(y)))
  switch (name) {
    case 'screenshot': await ab('screenshot', shotFile); return { image: `data:image/jpeg;base64,${readFileSync(shotFile).toString('base64')}` }
    case 'snapshot': { const s = (await ab('snapshot', '-i')).snapshot ?? ''; return s.length > 6000 ? s.slice(0, 6000) + '… [truncated]' : s }
    case 'click': await ab('click', a.ref); return 'ok'
    case 'click_at': for (let i = 0; i < (a.double ? 2 : 1); i++) { await at([a.x, a.y]); await ab('mouse', 'down'); await ab('mouse', 'up') } return 'ok'
    case 'drag': { const p = a.points; await at(p[0]); await ab('mouse', 'down'); for (const q of p.slice(1)) await ab('mouse', 'move', String(Math.round(q[0])), String(Math.round(q[1])), '--steps', '4'); await ab('mouse', 'up'); return 'ok' }
    case 'type_text': await ab('keyboard', 'type', a.text); return 'ok'
    case 'press': await ab('press', a.key); return 'ok'
    default: throw new Error(`unknown tool ${name}`)
  }
}

const SYSTEM = {
  webmcp: "You control a live tldraw whiteboard in the user's browser through tools. You cannot see the board or any image: rely on tool results (tldraw_get_canvas) to know what is there. Complete the user's request, check your work, then reply with a one-sentence summary.",
  browser: "You control the user's Chrome browser, which shows tldraw.com (a whiteboard) in a 1280x720 viewport. Use screenshot to see the page and the mouse and keyboard tools to work in tldraw's own UI (toolbar, style panel, menus, keyboard shortcuts). Complete the user's request, check your work, then reply with a one-sentence summary.",
}

const runAgent = async (b, arm, modelKey, prompt, tools, shotFile) => {
  const model = MODELS[modelKey]
  const messages = [{ role: 'system', content: SYSTEM[arm] }, { role: 'user', content: prompt }]
  const log = { calls: 0, errors: 0, turns: 0, cost: 0, tokens: 0, screenshots: 0, stop: 'max_turns', final: '' }
  for (; log.turns < MAX_TURNS; log.turns++) {
    const res = await chat({ model, ...(PROVIDERS[modelKey] && { provider: PROVIDERS[modelKey] }), messages, tools, tool_choice: 'auto', max_tokens: 4096 })
    log.cost += res.usage?.cost ?? 0
    log.tokens += res.usage?.total_tokens ?? 0
    const msg = res.choices[0].message
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length && { tool_calls: msg.tool_calls }) })
    if (!msg.tool_calls?.length) { log.stop = 'done'; log.final = msg.content ?? ''; break }
    const images = []
    for (const call of msg.tool_calls) {
      log.calls++
      let out
      try {
        const a = JSON.parse(call.function.arguments || '{}')
        out = arm === 'webmcp'
          ? (await b.ab('webmcp', 'invoke', call.function.name, '--params', JSON.stringify(a), '--timeout', '120000')).output
          : await runBrowserTool(b, call.function.name, a, shotFile)
      } catch (err) { out = { error: String(err.message).slice(0, 300) } }
      if (out?.image && TEXT_ONLY.has(modelKey)) out = 'screenshot taken, but you cannot view images'
      if (out?.image) { images.push(out.image); log.screenshots++; out = 'screenshot attached below' }
      let text = typeof out === 'string' ? out : JSON.stringify(out)
      text = text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, '[image data omitted]')
      if (/^\s*\{\s*"error"/.test(text)) log.errors++
      messages.push({ role: 'tool', tool_call_id: call.id, content: text.length > 6000 ? text.slice(0, 6000) + '… [truncated]' : text })
    }
    if (images.length) {
      // Like browser-use, only the latest screenshot stays in context; older ones become a placeholder.
      for (const m of messages) if (Array.isArray(m.content)) m.content = '[older screenshot removed]'
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Current screenshot:' }, { type: 'image_url', image_url: { url: images.at(-1) } }] })
    }
  }
  return log
}

const judge = async (task, dataUrl) => {
  const list = task.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
  const res = await chat({ model: JUDGE, max_tokens: 800, temperature: 0, messages: [{ role: 'user', content: [
    { type: 'text', text: `You check an AI agent's drawing on a whiteboard, strictly and literally.\nThe agent was asked: "${task.prompt}"\nFor each criterion, decide if the image clearly satisfies it. If unsure, it is not met.\n${list}\nReply with only JSON: {"met": [true/false for each criterion, in order], "reason": "<one sentence naming what is missing or wrong, or 'all met'>"}` },
    { type: 'image_url', image_url: { url: dataUrl } },
  ] }] })
  try {
    const p = JSON.parse((res.choices[0].message.content ?? '').match(/\{[\s\S]*\}/)?.[0])
    return { met: task.criteria.map((_, i) => p.met?.[i] === true), reason: String(p.reason ?? ''), cost: res.usage?.cost ?? 0 }
  } catch { return { met: task.criteria.map(() => false), reason: 'unparseable judge reply', cost: res.usage?.cost ?? 0 } }
}

const runCell = async (modelKey, arm) => {
  const session = `cmp-${arm}-${modelKey}`
  const b = browser(session, { AGENT_BROWSER_SCREENSHOT_FORMAT: 'jpeg', AGENT_BROWSER_SCREENSHOT_QUALITY: '70' })
  const dir = mkdtempSync(path.join(tmpdir(), `cmp-${arm}-${modelKey}-`))
  await run('agent-browser', ['close'], { env: { ...process.env, AGENT_BROWSER_SESSION: session } }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  // The extension is loaded in both arms (it exposes window.editor for grading); only the webmcp arm gets its tools.
  await b.ab('--extension', path.join(REPO, 'extension'), '--download-path', dir, 'open', 'https://www.tldraw.com/')
  await b.ab('set', 'viewport', '1280', '720', '1')
  await b.ab('wait', '3000')
  const tools = arm === 'webmcp'
    ? (await b.ab('webmcp', 'list')).tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } } }))
    : BROWSER_TOOLS
  const rows = []
  for (const task of tasks) {
    const before = new Set(readdirSync(dir))
    await b.evalJs(`const rt = ${rt.toString()}
      e.deleteShapes([...e.getCurrentPageShapeIds()]); e.setCamera({ x: 0, y: 0, z: 1 }); e.setCurrentTool('select')
      ;(${(task.setup ?? (() => {})).toString()})(e); e.selectNone(); return true`)
    const t0 = Date.now()
    let log
    try { log = await runAgent(b, arm, modelKey, task.prompt, tools, path.join(dir, 'shot.jpg')) }
    catch (err) { log = { calls: 0, errors: 0, turns: 0, cost: 0, tokens: 0, screenshots: 0, stop: `error: ${err.message.slice(0, 160)}` } }
    const seconds = Math.round((Date.now() - t0) / 1000)
    await new Promise((r) => setTimeout(r, 1500)) // downloads land asynchronously
    const state = await b.evalJs(`
      const text = (s) => s.props.richText?.content?.map((p) => p.content?.map((n) => n.text ?? '').join('') ?? '').join('\\n')
      return { crashed: !!e.getCrashingError(),
        shapes: e.getCurrentPageShapes().map((s) => ({ id: s.id, type: s.type, text: [text(s), s.props.name].filter(Boolean).join(' ') || undefined, color: s.props.color, geo: s.props.geo, bounds: e.getShapePageBounds(s.id) })),
        arrows: e.getCurrentPageShapes().filter((s) => s.type === 'arrow').map((a) => { const to = e.getBindingsFromShape(a.id, 'arrow').map((b) => b.toId); return { to, bound: to.length } }) }`)
    const facts = { ...state, dir, downloads: readdirSync(dir).filter((f) => !before.has(f) && /\.(png|svg|jpe?g|webp)$/.test(f) && f !== 'shot.jpg') }
    const checks = CHECKS[task.id].map(([name, f]) => { let ok = false; try { ok = !!f(facts) } catch {} return { name, ok } })
    if (facts.crashed) checks.push({ name: 'editor not crashed', ok: false })
    const image = await b.evalJs(`const ids = [...e.getCurrentPageShapeIds()]; if (!ids.length) return null
      const { blob } = await e.toImage(ids, { format: 'png', background: true, padding: 32, scale: 1 })
      return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob) })`)
    const grade = image ? await judge(task, image) : { met: task.criteria.map(() => false), reason: 'board is empty', cost: 0 }
    if (image) writeFileSync(path.join(OUT, `${task.id}--${arm}--${modelKey}.png`), Buffer.from(image.split(',')[1], 'base64'))
    const met = grade.met.filter(Boolean).length / grade.met.length
    const row = { task: task.id, arm, model: modelKey, pass: checks.every((c) => c.ok) && met >= 0.75, met: +met.toFixed(2), reason: grade.reason, checks, seconds, ...log, cost: log.cost + grade.cost }
    rows.push(row)
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${arm.padEnd(7)} ${modelKey.padEnd(5)} ${task.id.padEnd(13)} met ${row.met} calls ${log.calls} turns ${log.turns} ${seconds}s $${row.cost.toFixed(4)} ${log.stop} ${checks.filter((c) => !c.ok).map((c) => '✗ ' + c.name).join(', ')}`)
  }
  await run('agent-browser', ['close'], { env: { ...process.env, AGENT_BROWSER_SESSION: session } }).catch(() => {})
  return rows
}

const rows = (await Promise.all(models.flatMap((m) => arms.map((a) => runCell(m, a))))).flat()
writeFileSync(path.join(OUT, arg('--out') ?? 'results.json'), JSON.stringify(rows, null, 2))
