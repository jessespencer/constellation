// Greedy collision avoidance for cluster labels. Bigger clusters claim their
// spot first; smaller ones get nudged (vertically, then diagonally) until they
// no longer overlap an already-placed label. A label that had to move keeps its
// original anchor so a short leader line can be drawn back to the cluster.

export interface LabelItem {
  id: number;
  text: string;
  x: number; // desired screen x (cluster anchor)
  y: number; // desired screen y
  size: number; // font px
  priority: number; // higher = placed first (kept put)
}

export interface PlacedLabel {
  id: number;
  text: string;
  x: number;
  y: number;
  size: number;
  anchorX: number;
  anchorY: number;
  moved: boolean;
}

interface Box {
  x: number;
  y: number;
  hw: number;
  hh: number;
}

// Measure real rendered width in the label font (IBM Plex Mono 500) so collision
// boxes are accurate. Falls back to a per-char estimate when canvas isn't ready.
let _measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, size: number): number {
  if (typeof document !== "undefined") {
    if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
    if (_measureCtx) {
      _measureCtx.font = `500 ${size}px "IBM Plex Mono",ui-monospace,monospace`;
      const w = _measureCtx.measureText(text).width;
      if (w > 0) return w;
    }
  }
  return text.length * size * 0.62; // mono ≈ 0.6em advance per char
}

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) < a.hw + b.hw + 6 &&
    Math.abs(a.y - b.y) < a.hh + b.hh + 4
  );
}

export function layoutLabels(items: LabelItem[]): PlacedLabel[] {
  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  const placed: PlacedLabel[] = [];
  const boxes: Box[] = [];

  for (const it of sorted) {
    const hw = textWidth(it.text, it.size) / 2 + 6;
    const hh = (it.size * 1.2) / 2 + 2;

    // candidate offsets, in order of preference: stay, then spread out
    const step = hh * 2 + 6;
    const candidates: [number, number][] = [[0, 0]];
    for (let r = 1; r <= 8; r++) {
      candidates.push([0, -r * step], [0, r * step]);
      candidates.push([-r * (hw + 8), 0], [r * (hw + 8), 0]);
    }

    let best: [number, number] | null = null;
    for (const [dx, dy] of candidates) {
      const box: Box = { x: it.x + dx, y: it.y + dy, hw, hh };
      if (!boxes.some((b) => overlaps(box, b))) {
        best = [dx, dy];
        break;
      }
    }
    // No free slot anywhere — drop this (lower-priority / smaller) label entirely
    // rather than let it overlap. Bigger clusters are placed first, so they win.
    if (!best) continue;

    const fx = it.x + best[0];
    const fy = it.y + best[1];
    boxes.push({ x: fx, y: fy, hw, hh });
    placed.push({
      id: it.id,
      text: it.text,
      x: fx,
      y: fy,
      size: it.size,
      anchorX: it.x,
      anchorY: it.y,
      moved: best[0] !== 0 || best[1] !== 0,
    });
  }

  return placed;
}
