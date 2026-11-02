# tldraw WebMCP

A Chrome extension that turns an **already-open tldraw.com tab** into a WebMCP server, so an AI agent can draw with the pen, highlighter and eraser and create, edit, arrange and export shapes.

Verified 2026-11-02 against tldraw.com in Chrome 154: `node eval/run-eval.mjs` passes **15/15**. Output: `eval/final-scene.png`.

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
| `tldraw_draw_strokes` | Freehand strokes: `draw` (pen), `highlight`, `eraser`, `laser`. Points `[x,y]` or `[x,y,pressure]` (stylus). Color, size, dash, fill, closed. |
| `tldraw_create_shapes` | `geo` (20 kinds: rectangle, ellipse, star, …, with labels), `text`, `note`, `frame`, `line` (straight/cubic), `arrow` (bound to shapes, so it follows when they move). |
| `tldraw_update_shapes` | Move, resize, rotate, recolor, relabel. |
| `tldraw_delete_shapes` | By ids, `"all"` or `"selected"`. |
| `tldraw_arrange` | select, group, ungroup, align, distribute, bring_to_front, send_to_back. |
| `tldraw_view` | zoom_to_fit, zoom_to_shapes, set_camera, reset_zoom. |
| `tldraw_history` | undo / redo (each tool call is one undo step). |
| `tldraw_export_svg` | SVG of the drawing, so the agent can check its own work. |

Style enums are read from the live editor at registration time, so the schemas match the running tldraw version.

## Run it

**With agent-browser (it already turns on WebMCP):**
```bash
agent-browser --extension ./extension open https://www.tldraw.com/
agent-browser webmcp list
agent-browser webmcp invoke tldraw_draw_strokes --params '{"strokes":[{"points":[[100,100],[200,150],[300,100]],"color":"red"}]}'
```

**From Claude Code (or any MCP client):** agent-browser's MCP server relays WebMCP tools (`agent_browser_webmcp_list/invoke`):
```bash
claude mcp add agent-browser -- agent-browser mcp --tools all
```
Then ask Claude to open tldraw.com with the extension (it needs the `--extension` flag, or set `AGENT_BROWSER_EXTENSIONS`) and draw.

**In your own Chrome:** WebMCP is experimental. Start Chrome with
`--enable-features=WebMCPTesting,DevToolsWebMCPSupport` (the flags agent-browser uses), then go to
`chrome://extensions` → Developer mode → Load unpacked → `extension/`. You also need an agent that consumes WebMCP in that
browser, such as Chrome's built-in agent or the MCP-B extension.

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
