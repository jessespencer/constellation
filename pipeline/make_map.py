"""End-to-end local pipeline: exports -> map.json + per-conversation transcripts.

    normalize -> representative text -> local embeddings (all-mpnet-base-v2)
    -> UMAP(8D) + HDBSCAN clusters -> UMAP(2D) coords -> c-TF-IDF labels
    -> write viewer/public/map.json and viewer/public/conversations/{id}.json

Everything runs locally. The only network access is HuggingFace downloading
the model weights once (cached afterwards); conversation text never leaves
the machine.
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone

import numpy as np

from edges import CACHE_DIR, DEFAULT_K, DEFAULT_MIN_SIM, compute_edges, summarize
from labeling import ctfidf_terms, label_clusters
from normalize import load_all

MODEL_NAME = "all-mpnet-base-v2"
MAX_TOKENS = 512

# Muted, low-saturation categorical palette (paper-tone friendly).
PALETTE = [
    "#7d8b9c", "#a9846c", "#8a9a7b", "#9c7d8b", "#6c8a96", "#b0a07a",
    "#88789c", "#7a9c8f", "#9c8878", "#6f8296", "#a08a96", "#849c70",
    "#967d6c", "#7c8c9c", "#9a8c6f", "#7e9c95", "#8c7a8c", "#6c967d",
    "#a89078", "#79869c",
]
NOISE_COLOR = "#c8c2b6"  # muted warm gray for unclustered


def representative_text(rec: dict) -> str:
    """title + concatenated user turns (intent-bearing), model truncates to 512."""
    user_turns = [m["text"] for m in rec["messages"] if m["role"] == "user"]
    body = "\n".join(user_turns) if user_turns else " ".join(
        m["text"] for m in rec["messages"]
    )
    return f"{rec['title']}\n{body}".strip()


def _load_cached_embeddings(ids: list[str]) -> np.ndarray | None:
    """Return cached embeddings only if they match the current id set+order."""
    emb_path = os.path.join(CACHE_DIR, "embeddings.npy")
    ids_path = os.path.join(CACHE_DIR, "ids.json")
    if not (os.path.exists(emb_path) and os.path.exists(ids_path)):
        return None
    with open(ids_path) as f:
        cached_ids = json.load(f)
    if cached_ids != ids:
        return None
    emb = np.load(emb_path)
    return emb if emb.shape[0] == len(ids) else None


def _save_cached_embeddings(embeddings: np.ndarray, ids: list[str]) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    np.save(os.path.join(CACHE_DIR, "embeddings.npy"), embeddings)
    with open(os.path.join(CACHE_DIR, "ids.json"), "w") as f:
        json.dump(ids, f)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="..", help="root folder containing the exports")
    ap.add_argument("--out", default="../viewer/public", help="viewer public dir")
    ap.add_argument("--no-ollama", action="store_true", help="skip Ollama naming")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--k", type=int, default=DEFAULT_K, help="kNN edges per node")
    ap.add_argument("--min-sim", type=float, default=DEFAULT_MIN_SIM,
                    help="cosine floor for edges")
    ap.add_argument("--reembed", action="store_true",
                    help="ignore the embedding cache and re-embed")
    args = ap.parse_args()

    print("1/7  Normalizing exports…")
    records = load_all(os.path.abspath(args.input))
    n = len(records)
    if n == 0:
        raise SystemExit("No conversations parsed.")
    ids = [r["id"] for r in records]
    texts = [representative_text(r) for r in records]

    embeddings = _load_cached_embeddings(ids) if not args.reembed else None
    if embeddings is not None:
        print(f"2/7  Reusing cached embeddings for {n} conversations ({MODEL_NAME})")
    else:
        # heavy imports only when we actually need to embed
        from sentence_transformers import SentenceTransformer

        print(f"2/7  Embedding {n} conversations with {MODEL_NAME}…")
        model = SentenceTransformer(MODEL_NAME)
        model.max_seq_length = MAX_TOKENS
        embeddings = model.encode(
            texts, batch_size=64, show_progress_bar=True, normalize_embeddings=True
        )
        _save_cached_embeddings(embeddings, ids)

    import umap
    import hdbscan

    print("3/7  Reducing to 8D (UMAP) + clustering (HDBSCAN)…")
    reducer8 = umap.UMAP(
        n_components=8, n_neighbors=15, min_dist=0.0,
        metric="cosine", random_state=args.seed,
    )
    emb8 = reducer8.fit_transform(embeddings)
    min_cluster = max(5, int(round(n ** 0.5 / 2)))
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster, min_samples=1,
        metric="euclidean", cluster_selection_method="eom",
    )
    labels = clusterer.fit_predict(emb8)
    n_clusters = len(set(labels.tolist()) - {-1})
    n_noise = int((labels == -1).sum())
    print(f"     {n_clusters} clusters, {n_noise} unclustered")

    print("4/7  Projecting to 2D (UMAP) for map coordinates…")
    reducer2 = umap.UMAP(
        n_components=2, n_neighbors=15, min_dist=0.1,
        metric="cosine", random_state=args.seed,
    )
    coords = reducer2.fit_transform(embeddings)
    # normalize coords to a stable [-100, 100] box (decoupled from raw UMAP scale)
    coords = coords - coords.mean(axis=0)
    span = np.abs(coords).max() or 1.0
    coords = coords / span * 100.0

    print("5/7  Labeling clusters (c-TF-IDF" + ("" if args.no_ollama else " + Ollama") + ")…")
    terms_by_cluster = ctfidf_terms(texts, labels, top_n=10)
    titles_by_cluster: dict[int, list[str]] = {}
    for rec, lab in zip(records, labels):
        titles_by_cluster.setdefault(int(lab), []).append(rec["title"])
    cluster_labels = label_clusters(
        terms_by_cluster, titles_by_cluster, use_ollama=not args.no_ollama
    )

    # assign colors: stable order by cluster id, noise -> gray
    real_ids = sorted(cid for cid in set(labels.tolist()) if cid != -1)
    color_of = {cid: PALETTE[i % len(PALETTE)] for i, cid in enumerate(real_ids)}
    color_of[-1] = NOISE_COLOR

    cluster_of = {rec["id"]: int(lab) for rec, lab in zip(records, labels)}

    print(f"6/7  Computing kNN edges (k={args.k}, min_sim={args.min_sim})…")
    edges = compute_edges(embeddings, ids, cluster_of, k=args.k, min_sim=args.min_sim)
    summarize(edges)

    print("7/7  Writing outputs…")
    out_dir = os.path.abspath(args.out)
    conv_dir = os.path.join(out_dir, "conversations")
    os.makedirs(conv_dir, exist_ok=True)

    # cluster summaries with centroids
    clusters = []
    for cid in real_ids + [-1]:
        mask = labels == cid
        if not mask.any():
            continue
        cx, cy = coords[mask].mean(axis=0)
        clusters.append(
            {
                "id": int(cid),
                "label": cluster_labels[cid],
                "terms": terms_by_cluster.get(cid, []),
                "color": color_of[cid],
                "count": int(mask.sum()),
                "cx": round(float(cx), 3),
                "cy": round(float(cy), 3),
            }
        )

    nodes = []
    for rec, lab, (x, y) in zip(records, labels, coords):
        nodes.append(
            {
                "id": rec["id"],
                "source": rec["source"],
                "title": rec["title"],
                "created_at": rec["created_at"],
                "msg_count": rec["msg_count"],
                "cluster": int(lab),
                "x": round(float(x), 3),
                "y": round(float(y), 3),
            }
        )
        # per-conversation transcript (lazy-loaded by viewer on click)
        with open(os.path.join(conv_dir, f"{rec['id']}.json"), "w") as f:
            json.dump(
                {
                    "id": rec["id"],
                    "source": rec["source"],
                    "title": rec["title"],
                    "created_at": rec["created_at"],
                    "messages": rec["messages"],
                },
                f,
                ensure_ascii=False,
            )

    map_obj = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "model": MODEL_NAME,
            "n": n,
            "sources": {
                s: sum(r["source"] == s for r in records)
                for s in sorted({r["source"] for r in records})
            },
            "n_clusters": n_clusters,
        },
        "clusters": clusters,
        "nodes": nodes,
        # Phase 2: kNN similarity edges. Stable node ids, so nothing above changed.
        "edges": edges,
    }
    with open(os.path.join(out_dir, "map.json"), "w") as f:
        json.dump(map_obj, f, ensure_ascii=False)

    print(f"\nDone. {n} nodes, {n_clusters} clusters, {len(edges)} edges -> {out_dir}/map.json")


if __name__ == "__main__":
    main()
