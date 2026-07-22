# StepWise — Interactive Code Execution Visualizer

See the computer think. StepWise traces Python, C, C++ and Java programs step by step and animates every variable, array, pointer, stack frame and heap object as the code runs.

![StepWise](frontend/public/stepwise.svg)

## What it does

- **Left panel** — Monaco editor with a glowing current-line highlight, dimmed already-executed lines, breakpoints and a minimap.
- **Center canvas** — Live visualization chosen by the *shape* of your data: value cards for scalars, box rows with animated pointer chips (`i`, `j`, `lo`, `hi`…) for arrays, node chains with animated SVG arrows for linked lists, auto-laid-out trees, circular graphs with visited/queued coloring, key→value views for dicts/maps, and stacked frame cards for recursion.
- **Right panel** — Call stack, heap memory, console output and live statistics tabs.
- **Bottom bar** — Play/pause, step forward/back, restart, speed control (0.25×–4×), jump-to-step, and a timeline scrubber with call/return markers. Keyboard: `space` play/pause, `←`/`→` step.

Every step is a full snapshot, so you can scrub backwards and animations run correctly in both directions.

## How it works

There are no native toolchains involved. The backend embeds **tracing interpreters** for educational subsets of the four languages:

1. Code is parsed with `web-tree-sitter` (real WASM grammars for python/c/cpp/java).
2. Each language has a normalizer that lowers the parse tree into a common AST, and an evaluator built on a shared runtime core (values, heap with stable object IDs, frames, stdout, mark-and-sweep GC, step/heap/output limits).
3. `POST /api/trace` returns the whole execution as an array of steps: `{ line, event, frames, heap, stdout, note }`.
4. The frontend diffs consecutive steps to drive every animation — value pulses, FLIP moves for array swaps, arrow retargeting, frame push/pop — so new language features animate for free.

## Running it

Requires Node.js 18+.

```bash
# terminal 1 — backend (http://localhost:4000)
cd backend
npm install
npm start

# terminal 2 — frontend (http://localhost:5173, proxies /api to the backend)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, pick a language and an example, then press **Visualize**.

## Backend test suites

```bash
cd backend
npm run smoke                    # language feature smoke tests
npm run check-examples           # traces every frontend example end-to-end
npm run user-code                # realistic student programs (input/map/splat/Scanner/…)
```

Paste your own code in the editor. If it reads input (`input()`, `scanf`, `cin`, `Scanner`), open the **Input (stdin)** panel under the editor and provide the values.

## Supported language subsets

| Language | Highlights |
| --- | --- |
| Python | numbers, strings, lists, dicts, tuples, sets, slicing, functions, recursion, classes, comprehensions basics, `print`/`range`/`len`… |
| C | int/float/double/char, arrays, pointers (`&`, `*`), structs, `malloc`/`free`, `printf`/`scanf` |
| C++ | the C subset + `vector`, `string`, `stack`, `map`, `cout`/`cin`, `new`/`delete`, classes with constructors |
| Java | classes, static/instance methods, arrays, `ArrayList`, `HashMap`, `StringBuilder`, `String`, `System.out.println` |

Parse and runtime errors come back with line numbers and are highlighted in the editor.

## Project layout

```
backend/
  src/engine/     shared runtime core (values, heap, context, GC, parser host)
  src/langs/      per-language normalizers + interpreters
  src/server.js   Express API (/api/trace, /api/health)
  scripts/        smoke + example test suites
frontend/
  src/components/ editor, canvas, right panel, controls
  src/components/viz/  renderers (arrays, lists, trees, graphs, dicts, frames…)
  src/styles/     pure CSS (theme variables, layout, viz animations)
  src/store.jsx   trace + playback state (context + reducer)
```

## Deferred by design

AI explain modes, accounts/database, JS/TS/Go/Rust tracing, GIF/MP4 export, and 100k-element WebGL rendering — the renderer and interpreter layers leave clean seams for all of these.
