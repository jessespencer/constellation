import { useEffect, useState } from "react";
import type { Transcript, NodeDatum } from "./types";
import { SOURCE_COLORS } from "./types";

interface Props {
  node: NodeDatum | null;
  onClose: () => void;
}

const cache = new Map<string, Transcript>();

export default function Drawer({ node, onClose }: Props) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!node) return;
    const id = node.id;
    if (cache.has(id)) {
      setTranscript(cache.get(id)!);
      return;
    }
    setLoading(true);
    setTranscript(null);
    fetch(`${import.meta.env.BASE_URL}conversations/${encodeURIComponent(id)}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((t: Transcript) => {
        cache.set(id, t);
        setTranscript(t);
      })
      .catch(() => setTranscript(null))
      .finally(() => setLoading(false));
  }, [node]);

  if (!node) return null;

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <div className="drawer-meta">
          <span
            className="chip"
            style={{ color: SOURCE_COLORS[node.source] }}
          >
            {node.source === "claude" ? "Claude" : "ChatGPT"}
          </span>
          <span className="drawer-date">
            {node.created_at ? node.created_at.slice(0, 10) : ""}
            {" · "}
            {node.msg_count} msgs
          </span>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <h2 className="drawer-title">{node.title}</h2>

      <div className="transcript">
        {loading && <p className="muted">Loading…</p>}
        {!loading && !transcript && <p className="muted">Transcript unavailable.</p>}
        {transcript?.messages.map((m, i) => (
          <div key={i} className={`turn turn-${m.role}`}>
            <div className="turn-role">{m.role === "user" ? "You" : "Assistant"}</div>
            <div className="turn-text">{m.text}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
