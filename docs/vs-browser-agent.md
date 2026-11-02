# GhostDraw vs a browser agent on tldraw.com

Rerun: `OPENROUTER_API_KEY=... node eval/vs-browser/compare.mjs` (about $0.25; drawings and results land in `eval/vs-browser/out/`).

Same model, same 7 tasks, same live tldraw.com, graded identically. Run 2026-11-02.

- **GhostDraw route**: the agent gets GhostDraw's WebMCP tools and reads the board as text. No images at all.
- **Browser route**: the agent gets the toolkit browser-use / agent-browser give an agent: `screenshot` (shown
  to the model), accessibility `snapshot`, `click`, `click_at`, `drag` along a path, `type_text`, `press`.
  It works in tldraw's own UI. Only the latest screenshot stays in context, as browser-use does.
- **Grading (both routes)**: outcome checks on the final editor state (labels, colours, arrows really attached,
  a transparent PNG really downloaded) plus a vision judge (`google/gemini-3.8-flash`) on a clean export.
  Pass = every check holds and the judge marks ≥ 75% of the task's criteria met. No credit for which tool was used.
- Limit 30 turns per task.

## Results

| Model | Route | Passed | Tool calls | Time | Cost | Screenshots |
|---|---|---|---|---|---|---|
| Claude Haiku 5.5 (vision) | **GhostDraw** | **7/7** | 22 | 67 s | $0.038 | 0 |
| | Browser | 5/7 | 176 | 182 s | $0.051 | 45 |
| GPT-5.6 Luna (vision) | **GhostDraw** | **7/7** | 26 | 116 s | $0.023 | 0 |
| | Browser | 3/7 | 198 | 537 s | $0.053 | 35 |
| DeepSeek v4 Flash (text only) | **GhostDraw** | **7/7** | 33 | 164 s | $0.030 | 0 |
| | Browser | 3/7 | 167 | 343 s | $0.039 | 0 (cannot see) |
| **All** | **GhostDraw** | **21/21** | **81** | **347 s** | **$0.091** | **0** |
| | Browser | 11/21 | 541 | 1062 s | $0.143 | 80 |

GhostDraw: every task passed for every model, with 6.7× fewer tool calls, 3.1× less time and 1.6× less cost.

## Where the browser agent failed

| Task | Fails | What went wrong |
|---|---|---|
| flowchart | 3/3 models | Arrows drawn near the boxes but never attached; one run lost 3 of 4 labels |
| edit-existing | Luna, DeepSeek | Boxes not aligned; arrow not attached to A and B |
| smooth-wave | Luna, DeepSeek | No usable green circle (Luna drew a dot and reported "a green circle") |
| pen-house | Luna | Abstract shapes, not a house (hit the 30-turn limit) |
| smiley | Haiku | One eye outside the face |
| retro-board | DeepSeek | One column and one note (hit the 30-turn limit) |

Exports were the browser route's best task (3/3): tldraw's Export menu is ordinary DOM it can read.

## Notable

- **A text-only model is a first-class GhostDraw user** (7/7) and a crippled browser agent (3/7): it can't see
  the canvas, so it drags blind from the accessibility snapshot. It still drew a passable smiley and house that way.
- **Browser agents claim success they didn't reach**: final messages said "connected", "green circle" when the
  board showed neither. GhostDraw's tools return what was created, so the agent checks facts, not pixels.
- **Precise structure is the browser route's weak spot**: attached arrows, alignment and exact labels. Freehand
  sketches and menus are where it does best.

## Caveats

- One run per model × task (21 per route). Directional, not a statistically tight benchmark.
- The browser toolkit is a faithful equivalent of browser-use / agent-browser, not the browser-use library itself.
- Browser-route time includes one agent-browser process per mouse event, which slows it somewhat; tool-call counts
  and pass rates are unaffected.
- One judge reply was unparseable and was re-judged from the saved image (it still failed).
