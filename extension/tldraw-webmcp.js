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

  // Must run before any store write: tldraw treats a store validation failure as fatal and crashes the whole editor.
  const validateProps = (editor, type, props) => {
    const validators = editor.getShapeUtil(type).constructor.props
    for (const [k, v] of Object.entries(props)) {
      if (!validators[k]) throw new Error(`${type} has no prop "${k}"`)
      try {
        validators[k].validate(v)
      } catch (err) {
        throw new Error(`${type}.${k}: ${err.message}`)
      }
    }
    return props
  }

  const richText = (text = '') => ({
    type: 'doc',
    content: String(text)
      .split('\n')
      .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  })
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
      // tldraw drops stylus mode when the first pressure is exactly 0, so pen pressure is floored at 0.01.
      return { x: s.x, y: s.y, z: typeof p[2] === 'number' ? Math.min(1, Math.max(0.01, p[2])) : 0.5 }
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

  // Pen mode: centripetal Catmull-Rom (alpha 0.5, no cusps or self-loops) through the control points,
  // sampled every ~2px of arc length. Points are [x, y, pressure]; pressure is interpolated too.
  const smoothPath = (pts, closed, smooth) => {
    const P = pts.map((p) => [p[0], p[1], typeof p[2] === 'number' ? p[2] : 0.5])
    if (closed) P.push(P[0])
    const n = P.length
    const at = (i) => {
      if (closed) return P[((i % (n - 1)) + (n - 1)) % (n - 1)]
      if (i < 0) return P[0].map((v, k) => 2 * v - P[1][k]) // reflect so the end segments keep their direction
      if (i >= n) return P[n - 1].map((v, k) => 2 * v - P[n - 2][k])
      return P[i]
    }
    const knot = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5, 1e-4)
    const lerp = (a, b, ta, tb, u) => a.map((v, k) => ((tb - u) * v + (u - ta) * b[k]) / (tb - ta))
    const out = [P[0]]
    for (let i = 0; i < n - 1; i++) {
      const [p0, p1, p2, p3] = [at(i - 1), P[i], P[i + 1], at(i + 2)]
      const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2))
      const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3)
      for (let s = 1; s <= steps; s++) {
        if (!smooth) {
          out.push(lerp(p1, p2, 0, 1, s / steps))
          continue
        }
        const u = t1 + (t2 - t1) * (s / steps)
        const a1 = lerp(p0, p1, 0, t1, u), a2 = lerp(p1, p2, t1, t2, u), a3 = lerp(p2, p3, t2, t3, u)
        out.push(lerp(lerp(a1, a2, 0, t2, u), lerp(a2, a3, t1, t3, u), t1, t2, u))
      }
    }
    return out
  }

  // rAF never fires in a background tab; the timer keeps drawing going there (progress is time-based, so it just batches more).
  const nextFrame = () => new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 100) })

  // Plays samples through tldraw's tool at `speed` px/s of page distance, one batch per animation frame.
  const animatedGesture = async (editor, tool, samples, { isPen, speed, signal }) => {
    const base = {
      type: 'pointer', target: 'canvas', pointerId: 1, button: 0, isPen,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    }
    const screen = (p) => {
      const s = editor.pageToScreen({ x: p[0], y: p[1] })
      return { x: s.x, y: s.y, z: isPen ? Math.min(1, Math.max(0.01, p[2])) : 0.5 }
    }
    const dist = [0]
    for (let i = 1; i < samples.length; i++)
      dist.push(dist[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]))
    editor.setCurrentTool(tool)
    editor.dispatch({ ...base, name: 'pointer_down', point: screen(samples[0]) })
    let i = 1
    try {
      const t0 = performance.now()
      while (i < samples.length && !signal?.aborted) {
        await nextFrame()
        const reach = ((performance.now() - t0) / 1000) * speed
        for (; i < samples.length && dist[i] <= reach; i++) editor.dispatch({ ...base, name: 'pointer_move', point: screen(samples[i]) })
      }
    } finally {
      editor.dispatch({ ...base, name: 'pointer_up', point: screen(samples[i - 1]) })
    }
  }

  // One pen session at a time: interleaved pointer streams would merge into a single scribble.
  let penQueue = Promise.resolve()
  const serially = (fn) => {
    const run = penQueue.then(fn, fn)
    penQueue = run.catch(() => {})
    return run
  }

  const resolveIds = (editor, ids) => {
    if (ids === 'all') return [...editor.getCurrentPageShapeIds()]
    if (ids === 'selected') return editor.getSelectedShapeIds()
    if (!Array.isArray(ids)) throw new Error('ids must be an array of shape ids, "all" or "selected"')
    const missing = ids.filter((id) => !editor.getShape(id))
    if (missing.length) throw new Error(`unknown shape ids: ${missing.join(', ')}`)
    return ids
  }

  const pointOf = (editor, ref, name) => {
    if (ref?.shapeId) {
      const b = editor.getShapePageBounds(ref.shapeId)
      if (!b) throw new Error(`${name}.shapeId not found: ${ref.shapeId}`)
      return { x: b.center.x, y: b.center.y, shapeId: ref.shapeId }
    }
    return { x: num(ref?.x, `${name}.x`), y: num(ref?.y, `${name}.y`) }
  }

  // Each builder returns the shape record(s) to create plus optional post-create bindings.
  const builders = {
    geo: (editor, s, id) => ({
      shape: {
        id, type: 'geo', x: num(s.x, 'x'), y: num(s.y, 'y'), rotation: s.rotation ?? 0,
        props: {
          geo: s.geo ?? 'rectangle', w: num(s.w ?? 100, 'w'), h: num(s.h ?? 100, 'h'),
          ...(s.text !== undefined && { richText: richText(s.text) }),
          ...stylePatch(editor, 'geo', s),
        },
      },
    }),
    text: (editor, s, id) => ({
      shape: { id, type: 'text', x: num(s.x, 'x'), y: num(s.y, 'y'), props: { richText: richText(s.text), ...stylePatch(editor, 'text', s) } },
    }),
    note: (editor, s, id) => ({
      shape: { id, type: 'note', x: num(s.x, 'x'), y: num(s.y, 'y'), props: { richText: richText(s.text), ...stylePatch(editor, 'note', s) } },
    }),
    frame: (editor, s, id) => ({
      shape: { id, type: 'frame', x: num(s.x, 'x'), y: num(s.y, 'y'), props: { w: num(s.w ?? 320, 'w'), h: num(s.h ?? 180, 'h'), name: s.name ?? '', ...stylePatch(editor, 'frame', s) } },
    }),
    line: (editor, s, id) => {
      const pts = s.points
      // shortcut: single-char base62 fractional indices cap a line at 61 points; use draw_strokes for longer paths
      if (!Array.isArray(pts) || pts.length < 2 || pts.length > 61) throw new Error('line.points must have 2..61 [x, y] points')
      const [x0, y0] = [num(pts[0][0], 'points[0][0]'), num(pts[0][1], 'points[0][1]')]
      const digits = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
      const points = {}
      pts.forEach((p, i) => {
        const key = 'a' + digits[i]
        points[key] = { id: key, index: key, x: num(p[0], `points[${i}][0]`) - x0, y: num(p[1], `points[${i}][1]`) - y0 }
      })
      return { shape: { id, type: 'line', x: x0, y: y0, props: { points, spline: s.spline ?? 'line', ...stylePatch(editor, 'line', s) } } }
    },
    arrow: (editor, s, id) => {
      const a = pointOf(editor, s.from, 'from')
      const b = pointOf(editor, s.to, 'to')
      const bindings = []
      for (const [terminal, p] of [['start', a], ['end', b]]) {
        if (p.shapeId) bindings.push({ type: 'arrow', fromId: id, toId: p.shapeId, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } })
      }
      return {
        shape: {
          id, type: 'arrow', x: a.x, y: a.y,
          props: {
            start: { x: 0, y: 0 }, end: { x: b.x - a.x, y: b.y - a.y },
            ...(s.bend !== undefined && { bend: num(s.bend, 'bend') }),
            ...(s.kind && { kind: s.kind }),
            ...(s.arrowheadStart && { arrowheadStart: s.arrowheadStart }),
            ...(s.arrowheadEnd && { arrowheadEnd: s.arrowheadEnd }),
            ...(s.text !== undefined && { richText: richText(s.text) }),
            ...stylePatch(editor, 'arrow', s),
          },
        },
        bindings,
      }
    },
  }

  const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 }
  const ref = {
    type: 'object',
    description: 'Either a page point {x, y} or {shapeId} to attach to that shape',
    properties: { x: { type: 'number' }, y: { type: 'number' }, shapeId: { type: 'string' } },
  }

  const defineTools = (editor) => {
    const geoProps = editor.getShapeUtil('geo').constructor.props
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
          strokes.forEach((s, i) => {
            const tool = s.tool ?? 'draw'
            if (!strokeTools.includes(tool)) throw new Error(`strokes[${i}].tool must be one of ${strokeTools.join(', ')}`)
            if (tool === 'draw' || tool === 'highlight') validateProps(e, tool, stylePatch(e, tool, s))
          })
          e.markHistoryStoppingPoint('webmcp:draw_strokes')
          const created = []
          strokes.forEach((s) => {
            const tool = s.tool ?? 'draw'
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
      {
        name: 'tldraw_pen',
        description:
          'Pen mode: draw like a person. Give a few control points per stroke; they are joined with a smooth curve and drawn in real time. Slower than tldraw_draw_strokes but looks hand-drawn. Points are page coordinates [x, y] or [x, y, pressure 0..1]. 4-12 points per stroke is usually enough for a smooth curve.',
        inputSchema: {
          type: 'object',
          properties: {
            strokes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  points: { type: 'array', items: point, minItems: 2 },
                  tool: { type: 'string', enum: ['draw', 'highlight'], default: 'draw' },
                  closed: { type: 'boolean', description: 'Join the end back to the start smoothly (lets fill apply)' },
                  smooth: { type: 'boolean', description: 'Override the call-level smooth for this stroke (false keeps sharp corners)' },
                  ...styleSchema,
                },
                required: ['points'],
              },
            },
            speed: { type: 'number', minimum: 100, maximum: 5000, default: 900, description: 'Pen speed in page px per second' },
            smooth: { type: 'boolean', default: true, description: 'false joins points with straight segments (still animated)' },
          },
          required: ['strokes'],
        },
        execute: (input, ctx) =>
          serially(async () => {
            const e = getEditor()
            const { strokes, speed = 900, smooth = true } = parse(input)
            const signal = ctx?.signal
            if (!Array.isArray(strokes) || !strokes.length) throw new Error('strokes must be a non-empty array')
            if (!(num(speed, 'speed') >= 100 && speed <= 5000)) throw new Error('speed must be between 100 and 5000')
            const plans = strokes.map((s, i) => {
              const tool = s.tool ?? 'draw'
              if (tool !== 'draw' && tool !== 'highlight') throw new Error(`strokes[${i}].tool must be draw or highlight`)
              if (!Array.isArray(s.points) || s.points.length < 2) throw new Error(`strokes[${i}].points needs at least 2 points`)
              s.points.forEach((p, j) => {
                if (!Array.isArray(p) || p.length < 2) throw new Error(`strokes[${i}].points[${j}] must be [x, y] or [x, y, pressure]`)
                num(p[0], `strokes[${i}].points[${j}][0]`)
                num(p[1], `strokes[${i}].points[${j}][1]`)
              })
              validateProps(e, tool, stylePatch(e, tool, s))
              const isPen = s.points.some((p) => typeof p[2] === 'number')
              return { s, tool, isPen, samples: smoothPath(s.points, !!s.closed && s.points.length > 2, s.smooth ?? smooth) }
            })

            // Style the pen before drawing so the stroke appears in its final color, then restore the user's choice.
            const styleProps = e.getShapeUtil('draw').constructor.props
            const keys = ['color', 'fill', 'dash', 'size'].filter((k) => styleProps[k]?.id)
            const saved = Object.fromEntries(keys.map((k) => [k, e.getStyleForNextShape(styleProps[k])]))
            const setStyles = (vals) => e.run(() => keys.forEach((k) => vals[k] !== undefined && e.setStyleForNextShapes(styleProps[k], vals[k])), { history: 'ignore' })
            const prevTool = e.getCurrentToolId()

            e.markHistoryStoppingPoint('webmcp:pen')
            const created = []
            try {
              for (const { s, tool, isPen, samples } of plans) {
                if (signal?.aborted) break
                setStyles({ ...saved, ...Object.fromEntries(keys.map((k) => [k, s[k]])) })
                const before = new Set(e.getCurrentPageShapeIds())
                await animatedGesture(e, tool, samples, { isPen, speed, signal })
                created.push(...[...e.getCurrentPageShapeIds()].filter((id) => !before.has(id)))
              }
            } finally {
              setStyles(saved)
              e.setCurrentTool(prevTool)
            }
            if (signal?.aborted) throw new Error(`aborted after ${created.length} stroke(s)`)
            return ok({ created, shapes: created.map((id) => summarize(e, e.getShape(id))) })
          }),
      },
      {
        name: 'tldraw_create_shapes',
        description:
          'Create structured shapes in page coordinates. type "geo" (rectangle, ellipse, star, ... with optional text label), "text", "note" (sticky note), "frame", "line" (polyline through points), "arrow" (from/to page points or shape ids; binding to shapes keeps arrows attached when shapes move). Returns created ids.',
        inputSchema: {
          type: 'object',
          properties: {
            shapes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: Object.keys(builders) },
                  x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                  rotation: { type: 'number', description: 'Radians (geo only)' },
                  geo: { type: 'string', enum: [...(geoProps.geo?.values ?? [])] },
                  text: { type: 'string', description: 'Label / text content; \\n for new lines' },
                  name: { type: 'string', description: 'Frame title' },
                  points: { type: 'array', items: point, description: 'line: page points' },
                  spline: { type: 'string', enum: ['line', 'cubic'] },
                  from: ref, to: ref,
                  bend: { type: 'number', description: 'arrow curvature in px' },
                  kind: { type: 'string', enum: enumOf(editor, 'arrow', 'kind') },
                  arrowheadStart: { type: 'string', enum: enumOf(editor, 'arrow', 'arrowheadStart') },
                  arrowheadEnd: { type: 'string', enum: enumOf(editor, 'arrow', 'arrowheadEnd') },
                  ...styleSchema,
                },
                required: ['type'],
              },
            },
          },
          required: ['shapes'],
        },
        execute: (input) => {
          const e = getEditor()
          const { shapes } = parse(input)
          if (!Array.isArray(shapes) || !shapes.length) throw new Error('shapes must be a non-empty array')
          const built = shapes.map((s, i) => {
            const build = builders[s?.type]
            if (!build) throw new Error(`shapes[${i}].type must be one of ${Object.keys(builders).join(', ')}`)
            const b = build(e, s, `shape:webmcp_${crypto.randomUUID()}`)
            validateProps(e, b.shape.type, b.shape.props)
            return b
          })
          e.markHistoryStoppingPoint('webmcp:create_shapes')
          e.run(() => {
            e.createShapes(built.map((b) => b.shape))
            const bindings = built.flatMap((b) => b.bindings ?? [])
            if (bindings.length) e.createBindings(bindings)
          })
          return ok({ created: built.map((b) => summarize(e, e.getShape(b.shape.id))) })
        },
      },
      {
        name: 'tldraw_update_shapes',
        description:
          'Move, resize, rotate, restyle or relabel existing shapes by id. Only the fields you pass change.',
        inputSchema: {
          type: 'object',
          properties: {
            updates: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                  rotation: { type: 'number', description: 'Radians' },
                  text: { type: 'string' },
                  geo: { type: 'string', enum: [...(geoProps.geo?.values ?? [])] },
                  name: { type: 'string' },
                  ...styleSchema,
                },
                required: ['id'],
              },
            },
          },
          required: ['updates'],
        },
        execute: (input) => {
          const e = getEditor()
          const { updates } = parse(input)
          if (!Array.isArray(updates) || !updates.length) throw new Error('updates must be a non-empty array')
          const patches = updates.map((u, i) => {
            const shape = e.getShape(u?.id)
            if (!shape) throw new Error(`updates[${i}].id not found: ${u?.id}`)
            const props = stylePatch(e, shape.type, u)
            for (const k of ['w', 'h']) if (u[k] !== undefined && k in shape.props) props[k] = num(u[k], k)
            if (u.geo !== undefined && shape.type === 'geo') props.geo = u.geo
            if (u.name !== undefined && shape.type === 'frame') props.name = u.name
            if (u.text !== undefined && 'richText' in shape.props) props.richText = richText(u.text)
            validateProps(e, shape.type, props)
            return {
              id: shape.id, type: shape.type, props,
              ...(u.x !== undefined && { x: num(u.x, 'x') }),
              ...(u.y !== undefined && { y: num(u.y, 'y') }),
              ...(u.rotation !== undefined && { rotation: num(u.rotation, 'rotation') }),
            }
          })
          e.markHistoryStoppingPoint('webmcp:update_shapes')
          e.updateShapes(patches)
          return ok({ updated: patches.map((p) => summarize(e, e.getShape(p.id))) })
        },
      },
      {
        name: 'tldraw_delete_shapes',
        description: 'Delete shapes by id, or "all" shapes on the current page, or the "selected" ones. Undoable with tldraw_history.',
        inputSchema: {
          type: 'object',
          properties: { ids: { description: 'Array of shape ids, or "all" / "selected"', oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all', 'selected'] }] } },
          required: ['ids'],
        },
        annotations: { destructiveHint: true },
        execute: (input) => {
          const e = getEditor()
          const ids = resolveIds(e, parse(input).ids)
          e.markHistoryStoppingPoint('webmcp:delete_shapes')
          e.deleteShapes(ids)
          return ok({ deleted: ids.length })
        },
      },
      {
        name: 'tldraw_arrange',
        description:
          'Organize shapes: select, group, ungroup, align (left|center-horizontal|right|top|center-vertical|bottom), distribute (horizontal|vertical), bring_to_front, send_to_back.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['select', 'group', 'ungroup', 'align', 'distribute', 'bring_to_front', 'send_to_back'] },
            ids: { description: 'Array of shape ids, or "all" / "selected"', oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all', 'selected'] }] },
            operation: { type: 'string', description: 'For align/distribute', enum: ['left', 'center-horizontal', 'right', 'top', 'center-vertical', 'bottom', 'horizontal', 'vertical'] },
          },
          required: ['action', 'ids'],
        },
        execute: (input) => {
          const e = getEditor()
          const { action, operation } = parse(input)
          const ids = resolveIds(e, parse(input).ids)
          const ops = { align: ['left', 'center-horizontal', 'right', 'top', 'center-vertical', 'bottom'], distribute: ['horizontal', 'vertical'] }[action]
          if (ops && !ops.includes(operation)) throw new Error(`${action} operation must be one of ${ops.join(', ')}`)
          e.markHistoryStoppingPoint('webmcp:arrange')
          const run = {
            select: () => e.select(...ids),
            group: () => e.groupShapes(ids),
            ungroup: () => e.ungroupShapes(ids),
            align: () => e.alignShapes(ids, operation),
            distribute: () => e.distributeShapes(ids, operation),
            bring_to_front: () => e.bringToFront(ids),
            send_to_back: () => e.sendToBack(ids),
          }[action]
          if (!run) throw new Error(`unknown action: ${action}`)
          run()
          return ok({ action, ids, selectedIds: e.getSelectedShapeIds() })
        },
      },
      {
        name: 'tldraw_view',
        description: 'Move the camera: "zoom_to_fit" (all shapes), "zoom_to_shapes" (ids), "set_camera" ({x, y, z}), "reset_zoom".',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['zoom_to_fit', 'zoom_to_shapes', 'set_camera', 'reset_zoom'] },
            ids: { type: 'array', items: { type: 'string' } },
            x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
          },
          required: ['action'],
        },
        annotations: { readOnlyHint: true },
        execute: (input) => {
          const e = getEditor()
          const a = parse(input)
          if (a.action === 'zoom_to_fit') e.zoomToFit()
          else if (a.action === 'reset_zoom') e.resetZoom()
          else if (a.action === 'set_camera') {
            if (!(num(a.z ?? 1, 'z') > 0)) throw new Error('z must be > 0')
            e.setCamera({ x: num(a.x, 'x'), y: num(a.y, 'y'), z: a.z ?? 1 })
          }
          else if (a.action === 'zoom_to_shapes') {
            const ids = resolveIds(e, a.ids)
            const b = e.getShapesPageBounds(ids)
            if (b) e.zoomToBounds(b, { inset: 64 })
          } else throw new Error(`unknown action: ${a.action}`)
          return ok({ camera: e.getCamera(), viewport: e.getViewportPageBounds() })
        },
      },
      {
        name: 'tldraw_history',
        description: 'Undo or redo the last change(s). Each WebMCP tool call is one undo step.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['undo', 'redo'] }, steps: { type: 'integer', minimum: 1, maximum: 50, default: 1 } },
          required: ['action'],
        },
        execute: (input) => {
          const e = getEditor()
          const { action, steps = 1 } = parse(input)
          if (action !== 'undo' && action !== 'redo') throw new Error('action must be undo or redo')
          for (let i = 0; i < Math.min(50, Math.max(1, steps)); i++) e[action]()
          return ok({ action, shapeCount: e.getCurrentPageShapeIds().size })
        },
      },
      {
        name: 'tldraw_export_svg',
        description: 'Export shapes (default: all on page) as an SVG string so you can inspect what is drawn.',
        inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const e = getEditor()
          const { ids } = parse(input)
          const res = await e.getSvgString(ids ? resolveIds(e, ids) : [...e.getCurrentPageShapeIds()])
          return res?.svg ?? 'empty page'
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
