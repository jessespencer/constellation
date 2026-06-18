"""Discover and normalize Claude + ChatGPT exports into one unified list.

Both exports drift from their documented schemas, so we classify each
`conversations*.json` by *content* (does an item have `chat_messages` vs a
`mapping` tree?) rather than trusting filenames.

Normalized record:
    {
      "id":         "claude-<uuid>" | "chatgpt-<id>",
      "source":     "claude" | "chatgpt",
      "title":      str,
      "created_at": ISO-8601 UTC string,
      "messages":   [ { "role": "user"|"assistant", "text": str }, ... ],
      "msg_count":  int,
    }
"""
from __future__ import annotations

import glob
import json
import os
import re
from datetime import datetime, timezone

# ChatGPT embeds search/citation tokens as private-use-area runs, e.g.
# U+E200 "citeturn0search0" U+E201, plus stray inline U+E20x delimiters. Strip
# the whole citation span, then any leftover PUA chars (keeping real text).
_CITE_SPAN = re.compile("\ue200[^\ue201]*\ue201")
_PUA = re.compile("[\ue000-\uf8ff]")


def _strip_pua(text: str) -> str:
    text = _CITE_SPAN.sub("", text)
    text = _PUA.sub("", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #
def find_export_files(root: str) -> list[str]:
    """Recursively find every conversations*.json under `root`."""
    hits: list[str] = []
    for dirpath, _dirs, files in os.walk(root):
        # don't descend into the viewer's output or node_modules
        if "node_modules" in dirpath or os.sep + "viewer" in dirpath:
            continue
        for name in files:
            if name.startswith("conversations") and name.endswith(".json"):
                hits.append(os.path.join(dirpath, name))
    return sorted(hits)


def _classify(sample: dict) -> str | None:
    if "chat_messages" in sample:
        return "claude"
    if "mapping" in sample:
        return "chatgpt"
    return None


# --------------------------------------------------------------------------- #
# Time helpers
# --------------------------------------------------------------------------- #
def _iso_from_epoch(ts: float | int | None) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_from_string(s: str | None) -> str:
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return s


# --------------------------------------------------------------------------- #
# Claude
# --------------------------------------------------------------------------- #
def _claude_message_text(m: dict) -> str:
    text = (m.get("text") or "").strip()
    if text:
        return text
    # fall back to text-type content blocks (skip thinking/tool_use/tool_result)
    parts = [
        (b.get("text") or "")
        for b in (m.get("content") or [])
        if b.get("type") == "text"
    ]
    return "\n".join(p for p in parts if p).strip()


def parse_claude(conversations: list[dict]) -> list[dict]:
    out = []
    for c in conversations:
        messages = []
        for m in c.get("chat_messages", []):
            role = {"human": "user", "assistant": "assistant"}.get(m.get("sender"))
            if role is None:
                continue
            txt = _strip_pua(_claude_message_text(m))
            if txt:
                messages.append({"role": role, "text": txt})
        if not messages:
            continue
        out.append(
            {
                "id": f"claude-{c.get('uuid')}",
                "source": "claude",
                "title": (c.get("name") or "").strip() or "Untitled",
                "created_at": _iso_from_string(c.get("created_at")),
                "messages": messages,
                "msg_count": len(messages),
            }
        )
    return out


# --------------------------------------------------------------------------- #
# ChatGPT
# --------------------------------------------------------------------------- #
def _chatgpt_node_text(msg: dict) -> str:
    content = msg.get("content") or {}
    if content.get("content_type") not in ("text", "multimodal_text"):
        return ""
    parts = content.get("parts") or []
    # only string parts; skip image asset pointers / dict parts
    return "\n".join(p for p in parts if isinstance(p, str) and p.strip()).strip()


def _linearize(conv: dict) -> list[dict]:
    """Recover message order by walking parent pointers from current_node."""
    mapping = conv.get("mapping", {})
    node_id = conv.get("current_node")
    chain: list[dict] = []
    seen: set[str] = set()
    while node_id and node_id not in seen:
        seen.add(node_id)
        node = mapping.get(node_id)
        if not node:
            break
        msg = node.get("message")
        if msg:
            role = (msg.get("author") or {}).get("role")
            if role in ("user", "assistant"):
                txt = _strip_pua(_chatgpt_node_text(msg))
                if txt:
                    chain.append({"role": role, "text": txt})
        node_id = node.get("parent")
    chain.reverse()
    return chain


def parse_chatgpt(conversations: list[dict]) -> list[dict]:
    out = []
    for c in conversations:
        messages = _linearize(c)
        if not messages:
            continue
        cid = c.get("conversation_id") or c.get("id")
        out.append(
            {
                "id": f"chatgpt-{cid}",
                "source": "chatgpt",
                "title": (c.get("title") or "").strip() or "Untitled",
                "created_at": _iso_from_epoch(c.get("create_time")),
                "messages": messages,
                "msg_count": len(messages),
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Entry
# --------------------------------------------------------------------------- #
def load_all(root: str) -> list[dict]:
    files = find_export_files(root)
    if not files:
        raise SystemExit(f"No conversations*.json found under {root!r}")

    records: list[dict] = []
    seen_ids: set[str] = set()
    for path in files:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, list) or not data:
            continue
        kind = _classify(data[0])
        if kind == "claude":
            parsed = parse_claude(data)
        elif kind == "chatgpt":
            parsed = parse_chatgpt(data)
        else:
            print(f"  ? skipping unrecognized {path}")
            continue
        # dedupe (split files / re-exports)
        fresh = [r for r in parsed if r["id"] not in seen_ids]
        seen_ids.update(r["id"] for r in fresh)
        records.extend(fresh)
        print(f"  + {len(fresh):4d} {kind:8s} from {os.path.relpath(path, root)}")

    records.sort(key=lambda r: r["created_at"])
    return records


if __name__ == "__main__":
    import sys

    root = sys.argv[1] if len(sys.argv) > 1 else "."
    recs = load_all(root)
    n_claude = sum(r["source"] == "claude" for r in recs)
    n_chatgpt = sum(r["source"] == "chatgpt" for r in recs)
    print(f"\nTotal: {len(recs)}  (claude={n_claude}, chatgpt={n_chatgpt})")
