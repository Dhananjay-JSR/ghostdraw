# tldraw WebMCP

A Chrome extension that turns an **already-open tldraw.com tab** into a WebMCP server, so an AI agent can draw with the pen, highlighter and eraser and create, edit, arrange and export shapes.

Verified 2026-11-02 against tldraw.com in Chrome 154: `node eval/run-eval.mjs` passes **23/23**. Output: `eval/final-scene.png`.

## How it works

```
tldraw.com tab
 └─ extension content script (world: MAIN — not blocked by tldraw.com's CSP)
     ├─ finds window.editor (undocumented tldraw.com global, resolved per call)
     └─ document.modelContext.registerTool(...)  ← native WebMCP
          ├─ pen / highlighter / eraser / laser → synthetic pointer events through editor.dispatch,
          │   so tldraw's own tools build the stroke (smoothing, pressure, stylus mode)
          └─ shapes / arrows / edits → editor.createShapes / updateShapes / createBindings
```

Strokes are drawn by *driving tldraw's own tools*, not by writing stroke records, because tldraw stores
draw strokes in a compressed base64 path format that changes between versions.

## Tools

| Tool | What it does |
|---|---|
| `tldraw_get_canvas` | Viewport (page coords), camera, tool, selection, every shape summarized. Read-only. |
| `tldraw_draw_strokes` | Instant strokes with no cursor: `eraser`, `laser`, or `draw`/`highlight` when the user asks for speed. Points `[x,y]` or `[x,y,pressure]`. |
| `tldraw_pen` | **Pen mode.** A few control points per stroke become a smooth curve (centripetal Catmull-Rom), drawn in real time while a labelled agent cursor glides between strokes and follows the pen. `speed`, `smooth` (call-wide or per stroke), `label` (default "Agent"). |
| `tldraw_create_shapes` | `geo` (20 kinds: rectangle, ellipse, star, …, with labels), `text`, `note`, `frame`, `line` (straight/cubic), `arrow` (bound to shapes, so it follows when they move). The Agent cursor draws each one like a person: boxes dragged corner to corner, arrows pulled, lines traced, labels typed (`animate: false` for big batches). |
| `tldraw_update_shapes` | Move, resize, rotate, recolor, relabel. The cursor grabs and drags moved shapes and pulls resize corners. Accepts exact labels as ids. |
| `tldraw_delete_shapes` | By ids, `"all"` or `"selected"`. Marked consequential (`consequentialHint`) so agents can confirm first. |
| `tldraw_arrange` | select, group, ungroup, align, distribute, bring_to_front, send_to_back. |
| `tldraw_view` | zoom_to_fit, zoom_to_shapes, set_camera, reset_zoom. |
| `tldraw_history` | undo / redo. One step per create/update/delete/arrange call, one per stroke for drawing tools. The stack is shared with the user. |
| `tldraw_export` | Same as tldraw's Export menu: PNG, SVG, JPEG or WebP, transparent background, padding, scale, dark mode, whole page or selected ids. Downloads the file in the user's browser, or returns it to the agent (SVG text or data URL) so it can inspect its work. |

Style enums are read from the live editor at registration time, so the schemas match the running tldraw version.
Every description states its coordinate system, return shape and failure behaviour, and the harder tools include an
example input, so smaller models can call them without trial and error.

### Agent skill

[`skills/tldraw-webmcp/SKILL.md`](skills/tldraw-webmcp/SKILL.md) teaches an agent the workflow (look → plan →
draw → check → show), which tool to pick, sizing rules and recipes (flowcharts, circles, sticky boards). Drop the
folder into `.claude/skills/` (or your agent's skill or prompt directory). It is also attached to every release.

### Pen mode

![Pen mode: the agent cursor drawing on tldraw](eval/pen-mode.png)

`tldraw_pen` sends pointer events through tldraw's own draw tool on animation frames at a steady speed, so
tldraw's velocity-based pressure and smoothing behave the same as for a hand-drawn stroke. The cursor is an overlay
drawn on top of the page (`pointer-events: none`), not the system mouse, so it never blocks the user.
Calls run one at a time, and your own style picker and tool are restored afterwards. Drawing continues in a
background tab, just batched more coarsely.

## Releases

Each release on the [Releases page](../../releases) has a `tldraw-webmcp-vX.Y.Z.zip`. Unzip it and use
**Load unpacked** in `chrome://extensions`.

CI (`.github/workflows/release.yml`) publishes a release whenever `extension/manifest.json` reaches `main`
with a version that hasn't been released yet. To ship: bump `"version"` and push.

## Use it in your own Chrome

No automation tools needed: your normal Chrome, your normal tldraw.com tab, and any agent that speaks MCP.

**1. Turn on WebMCP.** Open `chrome://flags/#enable-webmcp-testing`, set **WebMCP for testing** to **Enabled**, and relaunch Chrome.

![chrome://flags with "WebMCP for testing"](docs/setup/1-flag.png)

**2. Load the extension.** Download `tldraw-webmcp-vX.Y.Z.zip` from [Releases](../../releases) and unzip it.
Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and pick the unzipped folder.

![chrome://extensions with tldraw WebMCP loaded](docs/setup/2-extension.png)

**3. Open https://www.tldraw.com/.** The tools register as soon as the board loads. To check, open DevTools: the console shows `[tldraw-webmcp] registered tldraw WebMCP tools`.

**4. Let your agent reach the tab.** Agents outside the browser connect through Google's
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp). It attaches to the Chrome you already
have open (Chrome 144+) and exposes the page's WebMCP tools as `list_webmcp_tools` and `execute_webmcp_tool`.
Open `chrome://inspect/#remote-debugging`, tick **Allow remote debugging for this browser instance**, and accept
the prompt the first time an agent connects.

![chrome://inspect remote debugging](docs/setup/3-remote-debugging.png)

Remote debugging gives the connected agent control of this browser profile, so enable it only for agents you trust.

**5. Ask for a drawing.** For example: "On my tldraw tab, draw a login flowchart" or "sketch a house".
The agent cursor draws it in front of you: boxes dragged out, arrows pulled, labels typed, and freehand drawing with the pen.

![The Agent cursor drawing a flowchart on tldraw](docs/setup/4-agent-drawing.png)

### Plug it into an agent

Every agent uses the same MCP server; only the config syntax differs.
`--autoConnect` attaches to your running Chrome, and `--categoryExperimentalWebmcp` turns on the WebMCP tools (they are off by default).

**Claude Code**
```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest --autoConnect --categoryExperimentalWebmcp
```

**Codex**
```bash
codex mcp add chrome-devtools -- npx chrome-devtools-mcp@latest --autoConnect --categoryExperimentalWebmcp
```
or in `~/.codex/config.toml`:
```toml
[mcp_servers.chrome-devtools]
command = "npx"
args = ["chrome-devtools-mcp@latest", "--autoConnect", "--categoryExperimentalWebmcp"]
```

**DeepSeek, or any other harness**
- **Harness speaks MCP** (most agent frameworks do): add the same server with its usual `mcpServers` JSON:
  ```json
  { "mcpServers": { "chrome-devtools": { "command": "npx", "args": ["chrome-devtools-mcp@latest", "--autoConnect", "--categoryExperimentalWebmcp"] } } }
  ```
- **Your own tool-calling loop on the raw API:** connect an MCP client to that server. Then run three steps:
  1. Call `list_webmcp_tools` to get the tldraw tools and their JSON schemas, and offer them to the model as functions.
  2. Run each call the model makes with `execute_webmcp_tool` (`pageId`, `toolName`, and `input` as a JSON string).
  3. Return the result text to the model.

  `eval/real/run-real-test.mjs` (`runAgent`) is a working reference for that loop with DeepSeek, Haiku and GPT models.
  Use a provider that passes tool arguments through intact: on OpenRouter, DeepSeek v4 Flash via DeepInfra (fp8) drops arguments (see Testing).

Tell the agent to call `tldraw_guide` first, or install [`skills/tldraw-webmcp`](skills/tldraw-webmcp/SKILL.md) as a skill.
Smaller models draw noticeably better with the guide.

> Status: each step above follows Chrome's and chrome-devtools-mcp's documentation, and the flag, the extension and remote-debugging pages are real screenshots.
> The full chain from a desktop agent through chrome-devtools-mcp has not been run end to end yet.
> The tools themselves are verified in Chrome 154 by both test layers below.

### Automation and CI

For scripted runs and CI, [agent-browser](https://github.com/vercel-labs/agent-browser) launches Chrome with WebMCP already enabled:
```bash
agent-browser --extension ./extension open https://www.tldraw.com/
agent-browser webmcp invoke tldraw_pen --params '{"strokes":[{"points":[[100,300],[200,200],[300,300]],"color":"red"}]}'
```
Both test layers use this path.

## Testing

Two layers:

- **`node eval/run-eval.mjs`** is deterministic and has no LLM. It drives every tool through WebMCP and checks the editor state directly.
  It also records the Agent cursor every frame and fails on any jump, and checks that off-screen work brings the camera along smoothly.
- **`node eval/real/run-real-test.mjs`** runs real agents. Text-only testers get a user prompt and the WebMCP tools, and never see an image:
  dummy `meta-llama/llama-3.1-8b-instruct`, medium `deepseek/deepseek-v4-flash`, and the cheap frontier tiers haiku `anthropic/claude-haiku-5.5` and luna `openai/gpt-5.6-luna`.
  Opus (`sota`, `anthropic/claude-opus-5.5`) is opt-in because it costs about 20-40x more per run.
  A vision judge (`google/gemini-3.8-flash`) marks a per-task checklist against a clean export of the board, and structural checks read the editor state.
  The tasks are in `eval/real/tasks.mjs`; models can be overridden with `TESTER_DUMMY`, `TESTER_MEDIUM`, `TESTER_HAIKU`, `TESTER_LUNA`, `TESTER_SOTA` and `JUDGE_MODEL`.
  ```bash
  OPENROUTER_API_KEY=... node eval/real/run-real-test.mjs --testers haiku,luna --tasks flowchart,smiley
  ```
  In CI, comment **`/run-real-test`** on an issue or PR (optionally `testers=haiku,sota tasks=smiley`) to get the scorecard back as a comment.
  The run fails only when a frontier tier (haiku, luna, or sota if included) misses a task; dummy and medium are measured, not gated.
  It needs the `OPENROUTER_API_KEY` repository secret.

Latest full run (2026-11-02, guide-tool mode, about $0.10 for 28 agent runs):

| | dummy (Llama 3.1 8B) | medium (DeepSeek v4 Flash) | haiku (Claude Haiku 5.5) | luna (GPT-5.6 Luna) |
|---|---|---|---|---|
| pass rate | 1/7 | **7/7** | **7/7** | **7/7** |
| tokens per task | 10k | 40k | 31k | 23k |

What the real agents taught the tools (each became a fix):
- Small models send arrays as JSON strings, guess ids from labels and send arrows without `from`/`to`.
  The tools now accept these and their errors list the real ids on the page.
- Agents built "a house" or "a smiley" from rectangles and ellipses. The descriptions and the guide now say that pictures are drawn with the pen.
- **Provider quality matters as much as the model.** DeepSeek v4 Flash served by DeepInfra (fp8) dropped tool arguments.
  Asked to make boxes green, it sent `text: ""`, `x: 0, y: 0` and no color, then looped create-delete for 20 turns (about 230k tokens per task).
  Fireworks, Azure and Parasail got the same request right 9/9, so the medium tier is pinned to them.

## Findings

1. **Feasible today.** `window.editor` exists on tldraw.com, `document.modelContext` is native in Chrome 154 with the flags above, and a MAIN-world content script can register tools for a site it doesn't own.
2. **Bad agent input can crash the user's board.** tldraw treats a store validation failure (e.g. `color: "not-a-color"`) as fatal: the editor stops handling input until reload. Every prop is therefore checked with tldraw's own validators *before* any store write. The eval asserts the editor never crashes.
3. **Stylus quirk:** tldraw turns off stylus mode if the first point's pressure is exactly `0`, so pressure is floored at 0.01.
4. **Injected text is inert:** labels go into tldraw's rich-text model and are never parsed as HTML (an `onerror` payload test passes).

## Limits / risks

- `window.editor` is **undocumented**. If tldraw removes it, the extension stops registering tools; it logs a console warning and does nothing else. Fallback idea, not built: walk React internals from `.tl-container`.
- WebMCP is at Intent-to-Experiment. The API already moved from `navigator.modelContext` to `document.modelContext`, and both are checked. No polyfill is bundled for browsers without WebMCP.
- Shapes created over a frame are not reparented into it.
- `line` is capped at 61 points; use `draw_strokes` for longer paths.
- The eval drives the tools directly. It has not yet been run with a separate LLM agent choosing the calls.
