# Testing GhostDraw

GhostDraw is checked two ways: a deterministic suite with no LLM, and real AI agents graded by a vision model.

## Two test layers

- **`node eval/run-eval.mjs`** is deterministic and has no LLM. It drives every tool through WebMCP and checks the editor state directly.
  It also records the GhostDraw cursor every frame and fails on any jump, and checks that off-screen work brings the camera along smoothly.
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

## Engineering findings

1. **Feasible today.** `window.editor` exists on tldraw.com, `document.modelContext` is native in Chrome 154 with WebMCP enabled, and a MAIN-world content script can register tools for a site it doesn't own.
2. **Bad agent input can crash the user's board.** tldraw treats a store validation failure (e.g. `color: "not-a-color"`) as fatal: the editor stops handling input until reload. Every prop is therefore checked with tldraw's own validators *before* any store write. The eval asserts the editor never crashes.
3. **Stylus quirk:** tldraw turns off stylus mode if the first point's pressure is exactly `0`, so pressure is floored at 0.01.
4. **Injected text is inert:** labels go into tldraw's rich-text model and are never parsed as HTML (an `onerror` payload test passes).
