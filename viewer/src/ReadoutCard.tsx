import type { CSSProperties } from "react";
import type { NodeDatum } from "./types";
import { SOURCE_COLORS } from "./types";

interface Props {
  node: NodeDatum;
  themeColor: string;
  themeLabel: string;
  neighbors: number;
  style: CSSProperties;
}

export default function ReadoutCard({
  node,
  themeColor,
  themeLabel,
  neighbors,
  style,
}: Props) {
  const sourceColor = SOURCE_COLORS[node.source];
  return (
    <div className="readout glass" style={style}>
      <div className="readout-title">{node.title || "Untitled"}</div>
      <div className="chips">
        <span className="chip" style={{ color: sourceColor }}>
          {node.source === "claude" ? "Claude" : "ChatGPT"}
        </span>
        <span className="chip chip-theme" style={{ color: themeColor }}>
          {themeLabel}
        </span>
      </div>
      <dl className="readout-rows">
        <dt>Date</dt>
        <dd>{node.created_at ? node.created_at.slice(0, 10) : "—"}</dd>
        <dt>Messages</dt>
        <dd>{node.msg_count}</dd>
        <dt>Neighbors</dt>
        <dd>{neighbors}</dd>
      </dl>
    </div>
  );
}
