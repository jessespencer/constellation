"""Regenerate cluster names/terms in an existing map.json — no re-embedding,
no UMAP. Uses the cluster assignments already in map.json plus freshly derived
representative text. Run after editing labeling.py, or once a local Ollama is up.

    python relabel.py                 # offline fallback names (or Ollama if running)
    python relabel.py --no-ollama     # force deterministic fallback names
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np

from labeling import ctfidf_terms, label_clusters
from make_map import representative_text
from normalize import load_all


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default="../viewer/public/map.json")
    ap.add_argument("--input", default="..")
    ap.add_argument("--no-ollama", action="store_true")
    args = ap.parse_args()

    map_path = os.path.abspath(args.map)
    with open(map_path) as f:
        m = json.load(f)

    text_by_id = {r["id"]: representative_text(r) for r in load_all(os.path.abspath(args.input))}
    nodes = m["nodes"]
    texts = [text_by_id.get(nd["id"], nd["title"]) for nd in nodes]
    labels = np.array([nd["cluster"] for nd in nodes])

    terms_by_cluster = ctfidf_terms(texts, labels, top_n=10)
    titles_by_cluster: dict[int, list[str]] = {}
    for nd in nodes:
        titles_by_cluster.setdefault(nd["cluster"], []).append(nd["title"])
    names = label_clusters(terms_by_cluster, titles_by_cluster, use_ollama=not args.no_ollama)

    for c in m["clusters"]:
        cid = c["id"]
        c["label"] = names.get(cid, c["label"])
        c["terms"] = terms_by_cluster.get(cid, c.get("terms", []))

    with open(map_path, "w") as f:
        json.dump(m, f, ensure_ascii=False)

    print("Updated cluster names:")
    for c in sorted(m["clusters"], key=lambda c: -c["count"]):
        print(f"  [{c['id']:>2}] {c['count']:>4}  {c['label']}")


if __name__ == "__main__":
    main()
