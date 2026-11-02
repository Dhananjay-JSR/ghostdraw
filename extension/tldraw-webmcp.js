// Exposes the tldraw editor on an open tldraw.com tab as WebMCP tools.
// Runs in the page's MAIN world (extension content script or agent-browser --init-script).
(() => {
  if (window.__tldrawWebMCP) return
  window.__tldrawWebMCP = true

  const mc = document.modelContext || navigator.modelContext
  if (!mc?.registerTool) {
    // shortcut: no polyfill bundled, upgrade by bundling @mcp-b/webmcp-polyfill if non-WebMCP browsers matter
    console.warn('[tldraw-webmcp] WebMCP (document.modelContext) not available in this browser')
    return
  }

  // window.editor is undocumented on tldraw.com; resolve lazily because it is replaced when switching files.
  const getEditor = () => {
    const e = window.editor
    if (!e?.createShapes) throw new Error('tldraw editor not found on this page')
    return e
  }

  const ok = (data) => JSON.stringify(data)
  const parse = (input) => (typeof input === 'string' ? JSON.parse(input || '{}') : input || {})
  const num = (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`)
    return v
  }


  const plainText = (rt) =>
    rt?.content?.map((p) => p.content?.map((n) => n.text ?? '').join('') ?? '').join('\n') ?? undefined

  const summarize = (editor, s) => {
    const b = editor.getShapePageBounds(s.id)
    const out = { id: s.id, type: s.type, x: Math.round(s.x), y: Math.round(s.y), rotation: s.rotation }
    if (b) out.bounds = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }
    for (const k of ['geo', 'color', 'fill', 'dash', 'size', 'name']) if (s.props[k] !== undefined) out[k] = s.props[k]
    const t = plainText(s.props.richText)
    if (t) out.text = t
    if (s.parentId && !s.parentId.startsWith('page:')) out.parentId = s.parentId
    return out
  }

  const defineTools = () => {
    return [
      {
        name: 'tldraw_get_canvas',
        description:
          'Read the current tldraw page: visible viewport (page coordinates), current tool, selection and a summary of every shape (id, type, bounds, style, text). Call this first to know where to draw.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: () => {
          const e = getEditor()
          const vp = e.getViewportPageBounds()
          return ok({
            page: { id: e.getCurrentPageId(), name: e.getCurrentPage().name },
            viewport: { x: Math.round(vp.x), y: Math.round(vp.y), w: Math.round(vp.w), h: Math.round(vp.h) },
            camera: e.getCamera(),
            currentTool: e.getCurrentToolId(),
            selectedIds: e.getSelectedShapeIds(),
            shapes: e.getCurrentPageShapesSorted().map((s) => summarize(e, s)),
          })
        },
      },
    ]
  }

  // Wrap so tool errors come back as readable results instead of opaque rejections.
  const safe = (fn) => async (input, ctx) => {
    try {
      return await fn(input, ctx)
    } catch (err) {
      return JSON.stringify({ error: String(err?.message ?? err) })
    }
  }

  const register = () => {
    const editor = getEditor()
    for (const tool of defineTools(editor)) {
      mc.registerTool({ ...tool, execute: safe(tool.execute) })
    }
    console.info('[tldraw-webmcp] registered tldraw WebMCP tools')
  }

  const wait = setInterval(() => {
    if (!window.editor?.createShapes) return
    clearInterval(wait)
    try {
      register()
    } catch (err) {
      console.error('[tldraw-webmcp] registration failed', err)
    }
  }, 250)
})()
