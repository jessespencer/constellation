"""Reassign conversations to the curated high-level taxonomy and rewrite the
clusters in an existing map.json. Reuses cached embeddings + UMAP coords — no
re-embedding, no UMAP, no network beyond the (already cached) model.

    python categorize.py            # apply taxonomy.CATEGORIES to map.json
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np

from edges import load_cache, neighbor_counts
from labeling import ctfidf_terms
from make_map import PALETTE, representative_text
from normalize import load_all
from taxonomy import assign_categories


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default="../viewer/public/map.json")
    ap.add_argument("--input", default="..")
    args = ap.parse_args()

    map_path = os.path.abspath(args.map)
    with open(map_path) as f:
        m = json.load(f)

    emb, ids = load_cache()
    print(f"Assigning {len(ids)} conversations to {0} categories…".replace("0", "high-level"))
    labels_by_idx, names = assign_categories(emb)
    label_of = {ids[i]: int(labels_by_idx[i]) for i in range(len(ids))}

    # align labels + representative text to map.json node order
    text_by_id = {r["id"]: representative_text(r) for r in load_all(os.path.abspath(args.input))}
    nodes = m["nodes"]
    node_labels = np.array([label_of.get(nd["id"], len(names) - 1) for nd in nodes])
    texts = [text_by_id.get(nd["id"], nd["title"]) for nd in nodes]

    terms_by_cat = ctfidf_terms(texts, node_labels, top_n=8)

    # rebuild clusters that actually have members
    present = sorted(set(node_labels.tolist()))
    clusters = []
    for order, cat in enumerate(present):
        mask = node_labels == cat
        xs = np.array([nodes[i]["x"] for i in range(len(nodes)) if mask[i]])
        ys = np.array([nodes[i]["y"] for i in range(len(nodes)) if mask[i]])
        clusters.append(
            {
                "id": int(cat),
                "label": names[cat],
                "terms": terms_by_cat.get(cat, []),
                "color": PALETTE[order % len(PALETTE)],
                "count": int(mask.sum()),
                "cx": round(float(xs.mean()), 3),
                "cy": round(float(ys.mean()), 3),
            }
        )

    # per-node density (neighbourhood crowdedness) for size-by-density in the viewer
    dens = neighbor_counts(emb)
    dens_by_id = {ids[i]: int(dens[i]) for i in range(len(ids))}

    for i, nd in enumerate(nodes):
        nd["cluster"] = int(node_labels[i])
        nd["density"] = dens_by_id.get(nd["id"], 0)

    # recompute bridge flags (every node now has a real category; no -1)
    cat_of = {nd["id"]: nd["cluster"] for nd in nodes}
    n_bridge = 0
    for e in m.get("edges", []):
        e["bridge"] = cat_of.get(e["source"]) != cat_of.get(e["target"])
        n_bridge += e["bridge"]

    m["meta"]["n_clusters"] = len(clusters)
    m["clusters"] = clusters
    with open(map_path, "w") as f:
        json.dump(m, f, ensure_ascii=False)

    print(f"\n{len(clusters)} categories, {n_bridge} bridge edges:")
    for c in sorted(clusters, key=lambda c: -c["count"]):
        print(f"  {c['count']:>4}  {c['label']}")


if __name__ == "__main__":
    main()
