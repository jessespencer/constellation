# CLAUDE.md

Project-specific guidance for working in this repo. General TypeScript/React and
git-convention preferences live in the global `~/CLAUDE.md`; this file covers
what's specific to Constellation.

## What this is

A local semantic map of Claude + ChatGPT conversations. Two halves:

- **`pipeline/`** (Python) — normalizes chat exports, embeds them locally, clusters
  and projects to 2D/3D, and emits `viewer/public/map.json` plus one
  `viewer/public/conversations/<id>.json` per conversation.
- **`viewer/`** (Vite + React + TypeScript) — renders the map on a `<canvas>`
  (2D, `d3-zoom`) and via Three.js (3D), reading the generated JSON.

Everything runs locally. The pipeline's only network access is HuggingFace
downloading the embedding model once (then cached). Chat text never leaves the
machine — never add telemetry or external calls that send conversation content.

## Commands

**Pipeline** (run from `pipeline/`, uses a `make`-managed `.venv`):

| Command | What it does |
| --- | --- |
| `make demo` | Synthesize ~70 sample conversations and build a map (no real data needed) |
| `make map` | Full build from real exports in repo root → `map.json` + transcripts |
| `make map-offline` | Same, but skip Ollama labeling (top-terms only) |
| `make categories` | Re-apply the curated taxonomy without re-embedding |
| `make sample` | Generate synthetic exports only |
| `make clean` | Remove the venv and caches |

- Override the interpreter: `make map PYTHON=/path/to/python3.12`.
- Point at exports elsewhere: `make map INPUT=/path/to/exports`.
- Retune edges without re-embedding: `.venv/bin/python edges.py --k 8 --min-sim 0.5`.

**Viewer** (run from `viewer/`):

| Command | What it does |
| --- | --- |
| `npm install` | Install deps |
| `npm run dev` | Vite dev server (open the printed localhost URL) |
| `npm run build` | `tsc -b && vite build` — typechecks, then bundles |
| `npm run preview` | Serve the production build |

The viewer needs a `map.json`; run a pipeline target first.

## Conventions

**Viewer (TS/React):**
- React components and imperative-handle modules use **default exports**
  (`export default function App()`, `export default ThreeView`). Pure helper
  modules (`bloom.ts`, `heat.ts`, `labelLayout.ts`, `projection.ts`, `ui.tsx`)
  use **named exports**. Follow whichever pattern the neighboring file uses.
- Functional components with hooks. `camelCase` values/functions,
  `PascalCase` components/types. `const` over `let`.
- Heavy rendering is hand-written canvas / Three.js, not a component-per-dot —
  performance-sensitive paths live in `MapCanvas.tsx`, `ThreeView.tsx`,
  `bloom*.ts`, and the force relaxation in `forceWorker.ts`. Keep per-frame work
  cheap; the 3D bundle is lazy-loaded on demand.
- All styling is in `styles.css` (plain CSS with custom properties / `--vars`);
  no CSS-in-JS or utility framework.
- No test suite currently exists. If adding tests, use React Testing Library and
  describe expected behavior in the test name.

**Pipeline (Python):**
- Python 3.9–3.12 (`numba`/`umap`/`hdbscan` have no 3.13+ wheels). `from
  __future__ import annotations` at the top of modules.
- Embeddings are cached in `pipeline/cache/` (`embeddings.npy` + `ids.json`) and
  reused — avoid forcing a re-embed; prefer targets that reuse the cache
  (`make categories`, `edges.py`) when changing only clustering/labels/edges.
- The curated category list lives in `pipeline/taxonomy.py`; edit there and
  re-apply with `make categories`.

## Data contract

The pipeline → viewer boundary is `viewer/public/map.json`:

```jsonc
{
  "meta":     { "generated_at", "model", "n", "sources": { "claude", "chatgpt" }, "n_clusters" },
  "clusters": [ { "id", "label", "terms": [...], "color", "count", "cx", "cy" } ],
  "nodes":    [ { "id", "source", "title", "created_at", "msg_count", "cluster", "x", "y" } ],
  "edges":    [ { "source": id, "target": id, "weight": cosine_sim, "bridge": bool } ]
}
```

Changing this shape means touching both sides — `make_map.py` (emit) and the
viewer's `types.ts` / consumers.

## Git

Conventional Commits with scopes seen in history: `feat(viewer):`, `fix(viewer):`,
`docs:`, `chore:`. Imperative mood, subject under 72 chars.

## Don't commit

`Claude/` and `Chat GPT/` (real exports), `sample/`, `pipeline/.venv/`,
`pipeline/cache/`, and the generated `viewer/public/map.json` +
`viewer/public/conversations/` are all git-ignored. Keep chat data and generated
outputs out of commits.
