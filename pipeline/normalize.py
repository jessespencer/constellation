"""Discover and normalize Claude + ChatGPT exports into one unified list.

Both exports drift from their documented schemas, so we classify each
`conversations*.json` by *content* (does an item have `chat_messages` vs a
`mapping` tree?) rather than trusting filenames.

Optionally we also fold in local **Claude Code** session transcripts — the
per-session `.jsonl` files under `~/.claude/projects/` — as a third source.
That sweep is opt-in (env var `CONSTELLATION_CLAUDE_CODE=1`, set by
`make map-code`) because those files live outside the repo and are personal.

Normalized record:
    {
      "id":         "claude-<uuid>" | "chatgpt-<id>" | "claude-code-<session>",
      "source":     "claude" | "chatgpt" | "claude-code",
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


# Claude Code injects scaffolding into the user turn: slash/local-command
# wrappers, the harness's appended system reminders, background task
# notifications, and image placeholders. None of it is something the human
# typed, so we strip these blocks and keep only the real prose around them.
_CC_TAGS = (
    "command-name", "command-message", "command-args", "command-contents",
    "local-command-caveat", "local-command-stdout", "local-command-stderr",
    "system-reminder", "task-notification", "bash-input", "bash-stdout",
    "bash-stderr",
)
_CC_BLOCK = re.compile(r"<(" + "|".join(_CC_TAGS) + r")>[\s\S]*?</\1>")
_CC_ORPHAN = re.compile(r"</?(?:" + "|".join(_CC_TAGS) + r")>")
_CC_IMAGE = re.compile(r"\[Image:[^\]]*\]")


def _strip_cc_scaffold(text: str) -> str:
    text = _CC_BLOCK.sub("", text)
    text = _CC_ORPHAN.sub("", text)  # unpaired leftovers
    text = _CC_IMAGE.sub("", text)
    return text.strip()


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
# Claude Code (local session transcripts)
# --------------------------------------------------------------------------- #
# Claude Code stores one JSONL file per session at
# ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Each line is a typed
# event; the bulk are tool I/O and bookkeeping, so we keep only the human's
# typed prompts (user events whose `message.content` is a plain string) and the
# assistant's prose (text blocks, skipping thinking/tool_use). Subagent
# transcripts live in a `subagents/` subfolder and are excluded.
CLAUDE_CODE_DEFAULT_ROOT = "~/.claude/projects"


def find_claude_code_sessions(root: str) -> list[str]:
    """Every top-level session `.jsonl` under `root` (skips subagent sidechains)."""
    root = os.path.expanduser(root)
    hits: list[str] = []
    for dirpath, _dirs, files in os.walk(root):
        if os.sep + "subagents" in dirpath:
            continue
        for name in files:
            if name.endswith(".jsonl"):
                hits.append(os.path.join(dirpath, name))
    return sorted(hits)


def parse_claude_code(path: str) -> dict | None:
    """One session `.jsonl` -> one normalized record, or None if it has no
    human-typed prompt (pure tool/automation sessions are dropped)."""
    title = ""
    created_at = ""
    messages: list[dict] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("isSidechain"):  # inlined subagent turn — not the user's
                continue
            etype = e.get("type")
            if etype == "ai-title":
                t = (e.get("aiTitle") or "").strip()
                if t:
                    title = t  # last non-empty title wins (it updates over time)
            elif etype == "user":
                content = (e.get("message") or {}).get("content")
                if not isinstance(content, str):  # array content == tool_result
                    continue
                txt = _strip_pua(_strip_cc_scaffold(content))
                if txt:
                    if not created_at:
                        created_at = _iso_from_string(e.get("timestamp"))
                    messages.append({"role": "user", "text": txt})
            elif etype == "assistant":
                blocks = (e.get("message") or {}).get("content") or []
                txt = "\n".join(
                    (b.get("text") or "")
                    for b in blocks
                    if isinstance(b, dict) and b.get("type") == "text"
                ).strip()
                if txt:
                    if not created_at:
                        created_at = _iso_from_string(e.get("timestamp"))
                    messages.append({"role": "assistant", "text": _strip_pua(txt)})

    if not any(m["role"] == "user" for m in messages):
        return None
    session_id = os.path.splitext(os.path.basename(path))[0]
    return {
        "id": f"claude-code-{session_id}",
        "source": "claude-code",
        "title": title or (messages[0]["text"].splitlines()[0][:60] or "Untitled session"),
        "created_at": created_at,
        "messages": messages,
        "msg_count": len(messages),
    }


def load_claude_code(root: str) -> list[dict]:
    out: list[dict] = []
    for path in find_claude_code_sessions(root):
        rec = parse_claude_code(path)
        if rec:
            out.append(rec)
    return out


# --------------------------------------------------------------------------- #
# Entry
# --------------------------------------------------------------------------- #
def load_all(
    root: str,
    include_claude_code: bool | None = None,
    claude_code_root: str | None = None,
) -> list[dict]:
    """Normalize every export under `root`. When `include_claude_code` is true
    (defaults to the `CONSTELLATION_CLAUDE_CODE` env var), also fold in local
    Claude Code sessions from `claude_code_root` (default `~/.claude/projects`,
    overridable via the `CLAUDE_CODE_ROOT` env var)."""
    if include_claude_code is None:
        include_claude_code = os.environ.get("CONSTELLATION_CLAUDE_CODE") == "1"

    files = find_export_files(root)
    if not files and not include_claude_code:
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

    if include_claude_code:
        cc_root = claude_code_root or os.environ.get(
            "CLAUDE_CODE_ROOT", CLAUDE_CODE_DEFAULT_ROOT
        )
        cc = [r for r in load_claude_code(cc_root) if r["id"] not in seen_ids]
        seen_ids.update(r["id"] for r in cc)
        records.extend(cc)
        print(f"  + {len(cc):4d} claude-code from {os.path.expanduser(cc_root)}")

    records.sort(key=lambda r: r["created_at"])
    return records


if __name__ == "__main__":
    import sys

    root = sys.argv[1] if len(sys.argv) > 1 else "."
    recs = load_all(root)
    by_source = {s: sum(r["source"] == s for r in recs) for s in {r["source"] for r in recs}}
    summary = ", ".join(f"{s}={n}" for s, n in sorted(by_source.items()))
    print(f"\nTotal: {len(recs)}  ({summary})")
