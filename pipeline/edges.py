"""k-nearest-neighbor edges over the cached conversation embeddings.

Cosine similarity (embeddings are L2-normalized at encode time, so cosine = dot).
Each node links to its top-k neighbors above a similarity floor; edges are
deduped to undirected. An edge is a `bridge` when its endpoints sit in different
theme clusters — unclustered (-1) counts as a non-cluster, so any edge touching
it is a bridge.

Reused across phases: reads embeddings.npy + ids.json from the cache, so no
re-embedding and no network access.
"""
from __future__ import annotations

import json
import os

import numpy as np

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
DEFAULT_K = 6
DEFAULT_MIN_SIM = 0.45


def _normalize(emb: np.ndarray) -> np.ndarray:
    emb = emb.astype(np.float32)
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return emb / norms


def compute_edges(
    embeddings: np.ndarray,
    ids: list[str],
    cluster_of: dict[str, int],
    k: int = DEFAULT_K,
    min_sim: float = DEFAULT_MIN_SIM,
) -> list[dict]:
    emb = _normalize(embeddings)
    n = len(ids)
    if n < 2:
        return []
    k_eff = min(k, n - 1)

    sims = emb @ emb.T
    np.fill_diagonal(sims, -1.0)  # exclude self
    # indices of the top-k neighbors per row (unordered within the top-k slice)
    top = np.argpartition(-sims, kth=k_eff - 1, axis=1)[:, :k_eff]

    best: dict[tuple[int, int], float] = {}
    for i in range(n):
        for j in top[i]:
            j = int(j)
            w = float(sims[i, j])
            if w < min_sim:
                continue
            key = (i, j) if i < j else (j, i)
            # symmetric weights; keep once
            if key not in best:
                best[key] = w

    edges = []
    for (a, b), w in best.items():
        ca = cluster_of.get(ids[a], -1)
        cb = cluster_of.get(ids[b], -1)
        bridge = not (ca == cb and ca != -1)
        edges.append(
            {
                "source": ids[a],
                "target": ids[b],
                "weight": round(w, 4),
                "bridge": bridge,
            }
        )
    # heaviest first — nicer for incremental drawing / debugging
    edges.sort(key=lambda e: -e["weight"])
    return edges


def neighbor_counts(embeddings: np.ndarray, min_sim: float = 0.4) -> np.ndarray:
    """Per-conversation 'density': how many other conversations sit within
    `min_sim` cosine. High = a crowded neighborhood (a topic explored a lot)."""
    emb = _normalize(embeddings)
    sims = emb @ emb.T
    np.fill_diagonal(sims, 0.0)
    return (sims >= min_sim).sum(axis=1).astype(int)


def load_cache() -> tuple[np.ndarray, list[str]]:
    emb = np.load(os.path.join(CACHE_DIR, "embeddings.npy"))
    with open(os.path.join(CACHE_DIR, "ids.json")) as f:
        ids = json.load(f)
    return emb, ids


def append_to_map(
    map_path: str, k: int = DEFAULT_K, min_sim: float = DEFAULT_MIN_SIM
) -> list[dict]:
    """Standalone path: recompute edges from cache + existing map.json and
    rewrite map.json in place. Lets you retune k / min_sim without re-embedding.
    """
    emb, ids = load_cache()
    with open(map_path) as f:
        m = json.load(f)
    cluster_of = {node["id"]: node["cluster"] for node in m["nodes"]}
    edges = compute_edges(emb, ids, cluster_of, k=k, min_sim=min_sim)
    m["edges"] = edges
    with open(map_path, "w") as f:
        json.dump(m, f, ensure_ascii=False)
    return edges


def summarize(edges: list[dict]) -> None:
    n_bridge = sum(e["bridge"] for e in edges)
    print(f"  {len(edges)} edges ({n_bridge} bridges, {len(edges) - n_bridge} intra-cluster)")
    samples = [e for e in edges if e["bridge"]][:3]
    for e in samples:
        print(f"    bridge w={e['weight']}: {e['source']}  <->  {e['target']}")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Recompute edges from cache into map.json")
    ap.add_argument("--map", default="../viewer/public/map.json")
    ap.add_argument("--k", type=int, default=DEFAULT_K)
    ap.add_argument("--min-sim", type=float, default=DEFAULT_MIN_SIM)
    args = ap.parse_args()
    edges = append_to_map(os.path.abspath(args.map), k=args.k, min_sim=args.min_sim)
    summarize(edges)
    print(f"  -> wrote edges into {args.map}")
