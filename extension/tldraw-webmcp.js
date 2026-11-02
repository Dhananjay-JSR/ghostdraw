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
  const enumOf = (editor, type, prop) => [...(editor.getShapeUtil(type).constructor.props[prop]?.values ?? [])]


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

  // Copies only the style keys the target shape type actually has, so one style object fits every type.
  const STYLE_KEYS = ['color', 'labelColor', 'fill', 'dash', 'size', 'font', 'align', 'verticalAlign', 'textAlign']
  const stylePatch = (editor, type, style = {}) => {
    const defaults = editor.getShapeUtil(type).getDefaultProps()
    const props = {}
    for (const k of STYLE_KEYS) if (style[k] !== undefined && k in defaults) props[k] = style[k]
    return props
  }

  // Drives tldraw's own tools with synthetic pointer events, exactly like a human pen/mouse.
  const gesture = (editor, tool, points, isPen) => {
    if (!Array.isArray(points) || points.length < 1) throw new Error('points must be a non-empty array')
    const base = {
      type: 'pointer', target: 'canvas', pointerId: 1, button: 0, isPen,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    }
    const at = (p, i) => {
      if (!Array.isArray(p) || p.length < 2) throw new Error(`points[${i}] must be [x, y] or [x, y, pressure]`)
      const s = editor.pageToScreen({ x: num(p[0], `points[${i}][0]`), y: num(p[1], `points[${i}][1]`) })
      return { x: s.x, y: s.y, z: typeof p[2] === 'number' ? Math.min(1, Math.max(0, p[2])) : 0.5 }
    }
    const prevTool = editor.getCurrentToolId()
    editor.setCurrentTool(tool)
    try {
      editor.dispatch({ ...base, name: 'pointer_down', point: at(points[0], 0) })
      points.slice(1).forEach((p, i) => editor.dispatch({ ...base, name: 'pointer_move', point: at(p, i + 1) }))
      editor.dispatch({ ...base, name: 'pointer_up', point: at(points.at(-1), points.length - 1) })
    } finally {
      editor.setCurrentTool(prevTool)
    }
  }

  const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 }
  const defineTools = (editor) => {
    const styleSchema = {
      color: { type: 'string', enum: enumOf(editor, 'geo', 'color') },
      fill: { type: 'string', enum: enumOf(editor, 'geo', 'fill') },
      dash: { type: 'string', enum: enumOf(editor, 'geo', 'dash') },
      size: { type: 'string', enum: enumOf(editor, 'geo', 'size'), description: 'Stroke / font size' },
      font: { type: 'string', enum: enumOf(editor, 'geo', 'font') },
    }
    const strokeTools = ['draw', 'highlight', 'eraser', 'laser'].filter((t) => editor.root.children?.[t])

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
      {
        name: 'tldraw_draw_strokes',
        description:
          'Draw freehand with tldraw\'s real pen tools, like a human dragging a mouse or stylus. Each stroke is a list of page-coordinate points [x, y] or [x, y, pressure 0..1] (pressure enables stylus mode). tool: "draw" (pen), "highlight" (highlighter), "eraser" (erases shapes the path crosses), "laser" (temporary pointer). Use many closely spaced points for smooth curves. Returns ids of created shapes.',
        inputSchema: {
          type: 'object',
          properties: {
            strokes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  points: { type: 'array', items: point, minItems: 1 },
                  tool: { type: 'string', enum: strokeTools, default: 'draw' },
                  closed: { type: 'boolean', description: 'Close the path back to its first point (lets fill apply)' },
                  ...styleSchema,
                },
                required: ['points'],
              },
            },
          },
          required: ['strokes'],
        },
        execute: (input) => {
          const e = getEditor()
          const { strokes } = parse(input)
          if (!Array.isArray(strokes) || !strokes.length) throw new Error('strokes must be a non-empty array')
          e.markHistoryStoppingPoint('webmcp:draw_strokes')
          const created = []
          strokes.forEach((s, i) => {
            const tool = s.tool ?? 'draw'
            if (!strokeTools.includes(tool)) throw new Error(`strokes[${i}].tool must be one of ${strokeTools.join(', ')}`)
            const pts = s.closed && s.points?.length > 2 ? [...s.points, s.points[0]] : s.points
            const before = new Set(e.getCurrentPageShapeIds())
            gesture(e, tool, pts, s.points.some((p) => typeof p[2] === 'number'))
            const fresh = [...e.getCurrentPageShapeIds()].filter((id) => !before.has(id))
            for (const id of fresh) {
              const shape = e.getShape(id)
              const props = stylePatch(e, shape.type, s)
              if (Object.keys(props).length) e.updateShape({ id, type: shape.type, props })
            }
            created.push(...fresh)
          })
          return ok({ created, shapes: created.map((id) => summarize(e, e.getShape(id))) })
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
