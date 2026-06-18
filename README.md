# Conversation Atlas — local semantic map of my AI chats

Places every Claude and ChatGPT conversation as a dot on a 2D semantic map:
**proximity = topical similarity**, dots **colored by discovered theme**. Hover
for details, click for the full transcript, search to highlight, toggle between
coloring by theme vs. by source (Claude vs. ChatGPT).

A **Constellation** view arranges the themes as a radial "seed-head": each
cluster fans out as a tuft around a central hub, sized by how many conversations
it holds, with always-on theme labels. Similarity links are drawn as faint
curved ink between conversations, so you can trace how topics connect — including
**bridges** between different theme-worlds.

Everything runs **locally**. The only network access is HuggingFace downloading
the embedding model weights once (then cached). **Your conversation text never
leaves the machine** — no chat content is sent anywhere.

## Views & interaction

- **Map / Constellation / 3D** views:
  - **Map** — the fixed UMAP projection (proximity = similarity).
  - **Constellation** — the radial bloom: clusters become tufts (wider + larger
    hub + bigger label for bigger themes), arranged around the ring in UMAP
    order. Blooms open from the center over ~2s via a web-worker force
    relaxation, then freezes so pan/zoom stays cheap.
  - **3D** — a rotating "dandelion": each theme is a tuft radiating in its own
    direction on a sphere, with floating labels, orbit controls (drag / scroll),
    and auto-rotation. Lazy-loaded (the Three.js bundle only loads on demand).
- **Edges** — k-nearest-neighbor similarity links, drawn as faint curved ink
  that pools where connections are dense.
- **Size** control — dot size encodes a metric: **Density** (how crowded a
  conversation's neighborhood is — topics you circle back to), **Links** (kNN
  degree), **Length** (message count), or **Uniform**. Applies in all views.
- **Hover a dot** — isolates it: its links and neighbors light up, the rest dims.
- **Bridges** toggle — shows only cross-cluster links (warm), surfacing where
  separate topics connect.
- **Regions** toggle — soft tinted hulls around each theme cluster.
- Plus the originals: pan/zoom, search, Theme/Source coloring, click → transcript.

## Run it end to end

```bash
# 1. Build the map (normalize exports -> local embeddings -> clusters -> map.json)
cd pipeline && make map

# 2. View it
cd ../viewer && npm install && npm run dev   # open the printed localhost URL
```

That's the whole thing. `make map` writes `viewer/public/map.json` plus one
`viewer/public/conversations/<id>.json` per conversation (lazy-loaded on click).

### Pointing at your exports

`make map` scans the repo root for any `conversations*.json` and auto-detects
whether each is a Claude export (flat `chat_messages`) or a ChatGPT export
(`mapping` node-tree, possibly split across `conversations-000.json …`). To use
a different location:

```bash
cd pipeline && make map INPUT=/path/to/exports
```

### Offline labeling

Cluster names come from class-based TF-IDF (BERTopic-style top terms). If a
local [Ollama](https://ollama.com) server is running, the pipeline asks a small
local model (`llama3.2`) to turn those terms into a short human-readable name —
still fully local. Without Ollama it falls back to the top-terms string. Force
the offline path with `make map-offline`.

## How it works

**Pipeline** (`/pipeline`, Python):
1. **Normalize** both exports into one schema — Claude via `chat_messages`,
   ChatGPT by walking the `mapping` tree from `current_node` up the `parent`
   chain and reversing.
2. **Representative text** per conversation = title + concatenated *user* turns
   (intent-bearing), truncated to ~512 tokens.
3. **Embed** locally with `sentence-transformers` / `all-mpnet-base-v2`.
   Embeddings are cached to `pipeline/cache/` (`embeddings.npy` + `ids.json`)
   and reused on later runs — no re-embedding, no network.
4. **Cluster**: UMAP → 8D, then HDBSCAN (used for the 2D map coordinates'
   neighborhood structure).
5. **Project** embeddings → 2D with UMAP for the map coordinates.
6. **Categorize** (`taxonomy.py` / `categorize.py`): HDBSCAN tends to produce
   incoherent blobs, so each conversation is assigned to a **curated high-level
   category** (Design & Branding, Music & Audio, Faith & Spirituality, …) by
   cosine similarity to category prototypes in the same embedding space — fully
   local and deterministic. Edit the category list in `pipeline/taxonomy.py` and
   re-apply without re-embedding: `cd pipeline && make categories`.
7. **Edges** (`edges.py`): k-NN over the embeddings by cosine similarity
   (default `k=6`, similarity floor `0.45`), deduped undirected, each flagged
   `bridge` when its endpoints sit in different clusters.
8. **Emit** `viewer/public/map.json` and per-conversation transcripts.

Retune edges without re-embedding (reuses the cache, rewrites `map.json`):

```bash
cd pipeline && .venv/bin/python edges.py --k 8 --min-sim 0.5
```

**Viewer** (`/viewer`, Vite + React + TypeScript): renders the dots on a
`<canvas>` with `d3-zoom` for smooth pan/zoom over thousands of points.

### `map.json` shape

```jsonc
{
  "meta":     { "generated_at", "model", "n", "sources": { "claude", "chatgpt" }, "n_clusters" },
  "clusters": [ { "id", "label", "terms": [...], "color", "count", "cx", "cy" } ],
  "nodes":    [ { "id", "source", "title", "created_at", "msg_count", "cluster", "x", "y" } ],
  "edges":    [ { "source": id, "target": id, "weight": cosine_sim, "bridge": bool } ]
}
```

## Requirements

- **Python 3.9–3.12** (the `make` target auto-selects a compatible interpreter;
  `numba`/`umap`/`hdbscan` have no 3.13+ wheels yet). Override with
  `make map PYTHON=/path/to/python3.12`.
- **Node 18+** for the viewer.
- ~2 GB disk for the model + Python deps (torch).
