// Real-agent eval tasks. Each task is a prompt a user might give, an optional board setup, and structural
// checks over the final editor state that must hold regardless of what the vision judge thinks.
// `facts` (built in run-real-test.mjs) = { shapes, arrows, crashed, toolCalls, downloads }.

const texts = (f) => f.shapes.map((s) => (s.text ?? '').toLowerCase())
const has = (f, word) => texts(f).some((t) => t.includes(word))
const ofType = (f, type) => f.shapes.filter((s) => s.type === type)
const called = (f, name, pred = () => true) => f.toolCalls.some((c) => c.name === name && pred(c.args ?? {}))

export const tasks = [
  {
    id: 'smiley',
    prompt: 'Draw a smiley face: a round face, two eyes and a smiling mouth.',
    criteria: ["a round face outline", "two eyes inside the upper half of the face", "a curved smiling mouth below the eyes"],
    checks: [
      ['at least 3 drawn parts', (f) => f.shapes.length >= 3],
      ['drew with smooth pen mode', (f) => called(f, 'tldraw_pen')],
      ['no instant strokes', (f) => !called(f, 'tldraw_draw_strokes', (a) => (a.strokes ?? []).some?.((s) => !['eraser', 'laser'].includes(s.tool)))],
    ],
  },
  {
    id: 'smooth-wave',
    prompt: 'Draw a smooth blue wavy line across the board, and a green circle above it.',
    criteria: ["a blue wavy line spanning a good width", "the wave is smooth, not jagged or polygonal", "a green circle above the wave", "the circle looks round"],
    checks: [
      ['drew with smooth pen mode', (f) => called(f, 'tldraw_pen')],
      ['blue stroke exists', (f) => f.shapes.some((s) => s.type === 'draw' && s.color === 'blue')],
      ['green circle exists', (f) => f.shapes.some((s) => s.color === 'green')],
    ],
  },
  {
    id: 'flowchart',
    prompt:
      'Create a flowchart for a login process with 4 steps in order: "Open app", "Enter credentials", "Verify", "Dashboard". Connect each step to the next with an arrow.',
    criteria: ["four boxes labelled \"Open app\", \"Enter credentials\", \"Verify\", \"Dashboard\"", "arrows connect them in that order (3 arrows)", "labels are legible and fit inside their boxes", "nothing overlaps"],
    checks: [
      ['all 4 labels present', (f) => ['open app', 'enter credentials', 'verify', 'dashboard'].every((w) => has(f, w))],
      ['3+ arrows attached at both ends', (f) => f.arrows.filter((a) => a.bound === 2).length >= 3],
    ],
  },
  {
    id: 'pen-house',
    prompt: 'Sketch a simple house with a red roof and a door.',
    criteria: ["walls of a house", "a red roof on top of the walls", "a door at the bottom of the walls", "reads as a house at a glance"],
    checks: [
      ['used tldraw_pen', (f) => called(f, 'tldraw_pen')],
      ['a red stroke exists', (f) => f.shapes.some((s) => s.type === 'draw' && s.color === 'red')],
    ],
  },
  {
    id: 'retro-board',
    prompt:
      'Make a retro board with three columns titled "Went well", "To improve" and "Action items". Put one sticky note with an example under each title.',
    criteria: ["three titles \"Went well\", \"To improve\", \"Action items\" side by side", "one sticky note under each title", "notes contain example text", "nothing overlaps"],
    checks: [
      ['3 titles present', (f) => ['went well', 'to improve', 'action items'].every((w) => has(f, w))],
      ['3+ sticky notes', (f) => ofType(f, 'note').length >= 3],
    ],
  },
  {
    id: 'edit-existing',
    setup: (e) => {
      e.createShapes([
        { id: 'shape:seedA', type: 'geo', x: 120, y: 140, props: { w: 160, h: 80, geo: 'rectangle', richText: rt('A') } },
        { id: 'shape:seedB', type: 'geo', x: 520, y: 260, props: { w: 160, h: 80, geo: 'rectangle', richText: rt('B') } },
      ])
    },
    prompt: 'There are two boxes labelled A and B on the board. Align them along their top edges, make both green, and connect A to B with an arrow.',
    criteria: ["boxes A and B share the same top edge", "both boxes are green", "an arrow goes from A to B"],
    checks: [
      ['tops aligned', (f) => { const [a, b] = ['A', 'B'].map((t) => f.shapes.find((s) => s.text === t)); return a && b && Math.abs(a.bounds.y - b.bounds.y) < 2 }],
      ['both green', (f) => ['A', 'B'].every((t) => f.shapes.find((s) => s.text === t)?.color === 'green')],
      ['arrow bound to A and B', (f) => f.arrows.some((a) => a.to.includes('shape:seedA') && a.to.includes('shape:seedB'))],
    ],
  },
  {
    id: 'big-scene',
    // Opt-in: a drawing big enough that how the agent splits it shows in the timing.
    optIn: true,
    prompt: 'Draw a detailed city skyline at night: at least six buildings of different heights with lit windows, a crescent moon, a few stars, and a road in front with two cars.',
    criteria: ['at least six buildings of clearly different heights', 'lit windows on the buildings', 'a crescent moon', 'a few stars in the sky', 'a road in front of the buildings', 'two cars on the road'],
    checks: [
      ['15+ drawn parts', (f) => f.shapes.length >= 15],
      ['drew with smooth pen mode', (f) => called(f, 'tldraw_pen')],
    ],
  },
  {
    id: 'export-png',
    setup: (e) => {
      e.createShapes([
        { id: 'shape:seedStar', type: 'geo', x: 200, y: 150, props: { w: 160, h: 160, geo: 'star', color: 'orange', fill: 'solid' } },
      ])
    },
    prompt: 'Export what is on the board as a PNG with a transparent background so I can download it.',
    criteria: ["an orange star is shown, unchanged"],
    checks: [
      ['exported transparent png', (f) => called(f, 'tldraw_export', (a) => (a.format ?? 'png') === 'png' && a.transparent === true)],
      ['file downloaded', (f) => f.downloads.some((d) => d.endsWith('.png'))],
      ['star untouched', (f) => f.shapes.some((s) => s.geo === 'star')],
    ],
  },
]

// setup() runs serialized inside the page; the harness defines `rt` there from this source.
export function rt(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}
