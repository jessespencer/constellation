"""Cluster labeling: class-based TF-IDF (BERTopic-style) top terms, with an
optional local-Ollama pass to turn terms into a human-readable name.

Fully offline-safe: if Ollama isn't running, we fall back to the top-terms
string. No conversation text ever leaves the machine either way.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

import numpy as np
from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "llama3.2"

# Conversational filler that c-TF-IDF otherwise mistakes for distinctive terms.
_FILLER = {
    "like", "just", "want", "wanted", "need", "needs", "make", "makes", "making",
    "made", "get", "gets", "getting", "use", "using", "used", "know", "good",
    "really", "thing", "things", "way", "ways", "lot", "kind", "sort", "maybe",
    "actually", "pretty", "help", "please", "tell", "give", "also", "able",
    "look", "looking", "let", "yeah", "okay", "sure", "think", "feel", "going",
    "based", "create", "creating", "new", "best", "better", "different",
}
_STOPWORDS = list(ENGLISH_STOP_WORDS | _FILLER)


def ctfidf_terms(
    docs: list[str], labels: np.ndarray, top_n: int = 10
) -> dict[int, list[str]]:
    """Top terms per cluster via class-based TF-IDF.

    Each cluster is treated as a single concatenated document; c-TF-IDF scores
    terms by frequency-in-cluster against frequency-across-all-clusters.
    """
    cluster_ids = sorted(set(labels.tolist()))
    joined = {cid: [] for cid in cluster_ids}
    for doc, lab in zip(docs, labels):
        joined[lab].append(doc)
    classes = [cid for cid in cluster_ids]
    class_docs = [" ".join(joined[cid]) for cid in classes]

    vec = CountVectorizer(
        stop_words=_STOPWORDS,
        ngram_range=(1, 2),
        min_df=2,
        max_features=20000,
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z]+\b",
    )
    counts = vec.fit_transform(class_docs)  # (n_classes, n_terms)
    vocab = np.array(vec.get_feature_names_out())

    tf = counts.toarray().astype(float)
    tf_sum = tf.sum(axis=1, keepdims=True)
    tf_sum[tf_sum == 0] = 1.0
    tf_norm = tf / tf_sum                                   # term freq within class
    df = (tf > 0).sum(axis=0)                               # classes containing term
    idf = np.log(1.0 + (len(classes) / np.maximum(df, 1)))  # rarer-across-classes -> higher
    ctfidf = tf_norm * idf

    out: dict[int, list[str]] = {}
    for i, cid in enumerate(classes):
        order = np.argsort(ctfidf[i])[::-1]
        terms = [vocab[j] for j in order[: top_n * 2]]
        # drop near-duplicate substrings (keep first/strongest)
        kept: list[str] = []
        for t in terms:
            if any(t in k or k in t for k in kept):
                continue
            kept.append(t)
            if len(kept) >= top_n:
                break
        out[cid] = kept
    return out


def _ollama_available() -> bool:
    try:
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=1.0)
        return True
    except (urllib.error.URLError, OSError):
        return False


def _fallback_name(terms: list[str]) -> str:
    """Clean 'A & B' Title-Case name from the two most distinct top terms."""
    picks: list[str] = []
    for t in terms:
        if any(t[:4] == p[:4] for p in picks):  # skip near-duplicate stems
            continue
        picks.append(t)
        if len(picks) == 2:
            break
    return " & ".join(p.title() for p in picks) if picks else "Misc"


def _ollama_name(terms: list[str], titles: list[str]) -> str | None:
    prompt = (
        "Name the theme of this cluster of conversations as a broad category, "
        "like 'Design & Creative', 'Finance & Legal', or 'Travel & Vehicles'. "
        "Reply with ONLY a 2-4 word Title Case label (an 'X & Y' form is great). "
        "No quotes, no explanation.\n\n"
        f"Top terms: {', '.join(terms)}\n"
        f"Example titles:\n- " + "\n- ".join(titles[:5]) + "\n\nLabel:"
    )
    body = json.dumps(
        {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": 16},
        }
    ).encode()
    try:
        req = urllib.request.Request(
            OLLAMA_URL, data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30.0) as resp:
            data = json.loads(resp.read())
        name = (data.get("response") or "").strip().strip('"').splitlines()[0]
        return name[:48] or None
    except (urllib.error.URLError, OSError, json.JSONDecodeError, KeyError):
        return None


def label_clusters(
    terms_by_cluster: dict[int, list[str]],
    titles_by_cluster: dict[int, list[str]],
    use_ollama: bool = True,
) -> dict[int, str]:
    """Return {cluster_id: label}. Cluster -1 is always 'Unclustered'."""
    ollama = use_ollama and _ollama_available()
    if use_ollama and not ollama:
        print("  (ollama not detected — using top-terms labels)")
    elif ollama:
        print(f"  (ollama detected — naming clusters with {OLLAMA_MODEL})")

    labels: dict[int, str] = {}
    for cid, terms in terms_by_cluster.items():
        if cid == -1:
            labels[cid] = "Unclustered"
            continue
        name = None
        if ollama:
            name = _ollama_name(terms, titles_by_cluster.get(cid, []))
        labels[cid] = name or _fallback_name(terms)
    return labels
