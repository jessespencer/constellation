import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { polygonHull } from "d3-polygon";
import type {
  MapData,
  NodeDatum,
  ColorMode,
  Layout,
  ResolvedEdge,
} from "./types";
import { SOURCE_COLORS } from "./types";
import { worldToScreen, type Dims } from "./projection";

const BG = "#f4f1ea"; // warm paper tone
const DOT_R = 2.6;
const INK = "#39332e";
const BRIDGE_INK = "#b0673f"; // warm accent for cross-cluster links
const REGION_PAD = 5; // world units to expand cluster hulls

export interface MapCanvasHandle {
  redraw: () => void;
}

interface Props {
  data: MapData;
  dims: Dims;
  layout: Layout;
  settling: boolean;
  mapPos: Float32Array;
  constPosRef: React.MutableRefObject<Float32Array>;
  nodeScale: Float32Array; // per-node size multiplier (size-by metric)
  edges: ResolvedEdge[];
  adjacency: number[][];
  clusterColor: Map<number, string>;
  colorMode: ColorMode;
  query: string;
  bridgesOnly: boolean;
  showRegions: boolean;
  regionsVersion: number;
  selectedId: string | null;
  selectedIndex: number; // -1 when nothing selected
  onTransform: (t: ZoomTransform) => void;
  onHover: (node: NodeDatum | null, screen: [number, number]) => void;
  onSelect: (node: NodeDatum) => void;
  onBackground: () => void; // click on empty space -> release lock
}

function colorFor(
  n: NodeDatum,
  colorMode: ColorMode,
  clusterColor: Map<number, string>
): string {
  return colorMode === "source"
    ? SOURCE_COLORS[n.source]
    : clusterColor.get(n.cluster) ?? "#c8c2b6";
}

const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const hoverRef = useRef<number>(-1);
  const rafRef = useRef<number>(0);
  const downPos = useRef<[number, number]>([0, 0]); // to tell clicks from pans
  // cached per-cluster convex hulls in WORLD space (recomputed only when the
  // layout/positions actually change, not on every hover redraw)
  const hullCache = useRef<{ key: string; hulls: Map<number, [number, number][]> }>({
    key: "",
    hulls: new Map(),
  });

  // latest props for the imperative redraw + d3 handlers (avoids stale closures)
  const p = useRef(props);
  p.current = props;

  function positions(): Float32Array {
    const { layout, constPosRef, mapPos } = p.current;
    return layout === "constellation" ? constPosRef.current : mapPos;
  }

  function computeHulls() {
    const { data, layout, regionsVersion } = p.current;
    const key = `${layout}:${regionsVersion}`;
    if (hullCache.current.key === key) return hullCache.current.hulls;
    const pos = positions();
    const byCluster = new Map<number, [number, number][]>();
    for (let i = 0; i < data.nodes.length; i++) {
      const c = data.nodes[i].cluster;
      if (c === -1) continue;
      (byCluster.get(c) ?? byCluster.set(c, []).get(c)!).push([
        pos[2 * i],
        pos[2 * i + 1],
      ]);
    }
    const hulls = new Map<number, [number, number][]>();
    for (const [c, pts] of byCluster) {
      if (pts.length < 3) continue;
      const hull = polygonHull(pts);
      if (!hull) continue;
      // centroid of hull, then push each vertex outward for a soft padded blob
      let hx = 0,
        hy = 0;
      for (const [x, y] of hull) {
        hx += x;
        hy += y;
      }
      hx /= hull.length;
      hy /= hull.length;
      const expanded = hull.map(([x, y]) => {
        const dx = x - hx,
          dy = y - hy;
        const len = Math.hypot(dx, dy) || 1;
        return [x + (dx / len) * REGION_PAD, y + (dy / len) * REGION_PAD] as [
          number,
          number
        ];
      });
      hulls.set(c, expanded);
    }
    hullCache.current = { key, hulls };
    return hulls;
  }

  function curve(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) {
    // slight perpendicular bow for an organic, hand-drawn feel
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const off = Math.min(len * 0.12, 26);
    const cx = mx - (dy / len) * off;
    const cy = my + (dx / len) * off;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const {
      data,
      dims,
      layout,
      nodeScale,
      edges,
      adjacency,
      colorMode,
      clusterColor,
      query,
      bridgesOnly,
      showRegions,
      settling,
      selectedId,
      selectedIndex,
    } = p.current;
    const ctx = canvas.getContext("2d")!;
    const t = transformRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pos = positions();
    const n = data.nodes.length;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, dims.width, dims.height);

    // project every node once
    const sx = new Float32Array(n);
    const sy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [a, b] = worldToScreen(pos[2 * i], pos[2 * i + 1], dims, t);
      sx[i] = a;
      sy[i] = b;
    }

    // --- regions (under everything) ---
    if (showRegions && !settling) {
      const hulls = computeHulls();
      ctx.globalCompositeOperation = "multiply";
      ctx.lineJoin = "round";
      for (const [c, worldPts] of hulls) {
        if (worldPts.length < 3) continue;
        const pts = worldPts.map(
          ([wx, wy]) => worldToScreen(wx, wy, dims, t) as [number, number]
        );
        ctx.beginPath();
        // smoothed closed path through hull vertices (quadratic via midpoints)
        const m = pts.length;
        const mid0 = [(pts[m - 1][0] + pts[0][0]) / 2, (pts[m - 1][1] + pts[0][1]) / 2];
        ctx.moveTo(mid0[0], mid0[1]);
        for (let k = 0; k < m; k++) {
          const cur = pts[k];
          const nxt = pts[(k + 1) % m];
          ctx.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2);
        }
        ctx.closePath();
        const col = clusterColor.get(c) ?? "#c8c2b6";
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.14;
        ctx.lineWidth = 1;
        ctx.strokeStyle = col;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- edges ---
    // In Constellation, a clicked node LOCKS the focus so its subgraph persists
    // for exploration; otherwise hover drives a transient preview.
    const locked = layout === "constellation" && selectedIndex >= 0 ? selectedIndex : -1;
    const hi = locked >= 0 ? locked : hoverRef.current;
    let neighbors: Set<number> | null = null;
    if (hi >= 0) {
      neighbors = new Set([hi]);
      for (const ei of adjacency[hi]) {
        const e = edges[ei];
        neighbors.add(e.si === hi ? e.ti : e.si);
      }
    }
    const focused = hi >= 0 || bridgesOnly;

    // faint background pass (multiply → overlapping edges pool like ink)
    ctx.globalCompositeOperation = "multiply";
    const strong: number[] = [];
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const isStrong = hi >= 0 ? e.si === hi || e.ti === hi : bridgesOnly && e.bridge;
      if (isStrong) {
        strong.push(ei);
        continue;
      }
      const a = focused ? 0.02 : 0.045 + e.w * 0.1;
      ctx.globalAlpha = a;
      ctx.lineWidth = 0.4 + e.w * 0.6;
      ctx.strokeStyle = INK;
      curve(ctx, sx[e.si], sy[e.si], sx[e.ti], sy[e.ti]);
    }

    // highlighted pass on top (source-over for crisp emphasis)
    ctx.globalCompositeOperation = "source-over";
    for (const ei of strong) {
      const e = edges[ei];
      const bridgeStyle = bridgesOnly && e.bridge && hi < 0;
      ctx.globalAlpha = (bridgeStyle ? 0.45 : 0.5) + e.w * 0.4;
      ctx.lineWidth = 0.8 + e.w * (bridgeStyle ? 1.3 : 1.5);
      ctx.strokeStyle = bridgeStyle ? BRIDGE_INK : INK;
      curve(ctx, sx[e.si], sy[e.si], sx[e.ti], sy[e.ti]);
    }
    ctx.globalAlpha = 1;

    // --- nodes ---
    const q = query.trim().toLowerCase();
    const zoomR = Math.sqrt(t.k);
    const hoverIdx = hoverRef.current;
    // when locked, background nodes are inert — dim them harder
    const dimTo = locked >= 0 ? 0.05 : 0.12;
    for (let i = 0; i < n; i++) {
      const node = data.nodes[i];
      const match = !q || node.title.toLowerCase().includes(q);
      let a = 0.85;
      if (q && !match) a = 0.07;
      if (neighbors && !neighbors.has(i)) a = Math.min(a, dimTo);
      const isSel = node.id === selectedId;
      const isHover = i === hoverIdx;
      const r = DOT_R * (nodeScale[i] || 1) * zoomR;
      const rr = isSel ? r + 2.5 : isHover ? r + 2 : r;
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], rr, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(node, colorMode, clusterColor);
      ctx.globalAlpha = a;
      ctx.fill();
      if (isSel || isHover) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = isSel ? 1.5 : 1.1;
        ctx.strokeStyle = isSel ? "#2b2b2b" : "#5a534a";
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // coalesce redraws to one per animation frame
  function scheduleDraw() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }

  useImperativeHandle(ref, () => ({ redraw: scheduleDraw }), []);

  // size + retina
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = props.dims.width * dpr;
    canvas.height = props.dims.height * dpr;
    canvas.style.width = `${props.dims.width}px`;
    canvas.style.height = `${props.dims.height}px`;
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.dims]);

  // redraw when any visual input changes
  useEffect(() => {
    scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.data,
    props.layout,
    props.colorMode,
    props.nodeScale,
    props.query,
    props.selectedId,
    props.selectedIndex,
    props.bridgesOnly,
    props.showRegions,
    props.regionsVersion,
    props.dims,
  ]);

  // d3 zoom + hover/click — set up once per data/dims
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sel = select(canvas);
    const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.4, 40])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        p.current.onTransform(event.transform);
        scheduleDraw();
      });
    sel.call(zoomBehavior);
    sel.call(zoomBehavior.transform, transformRef.current);

    // when locked, only the focused node + its neighbors are interactive
    function focusCandidates(): number[] | null {
      if (!isLocked()) return null;
      const li = p.current.selectedIndex;
      const set = [li];
      for (const ei of p.current.adjacency[li]) {
        const e = p.current.edges[ei];
        set.push(e.si === li ? e.ti : e.si);
      }
      return set;
    }
    function nearest(mx: number, my: number): number {
      const t = transformRef.current;
      const pos = positions();
      const hitR = (DOT_R * Math.sqrt(t.k) + 4) ** 2;
      let best = -1;
      let bestD = hitR;
      const consider = (i: number) => {
        const [sx, sy] = worldToScreen(pos[2 * i], pos[2 * i + 1], p.current.dims, t);
        const d = (sx - mx) ** 2 + (sy - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      };
      const cand = focusCandidates();
      if (cand) cand.forEach(consider);
      else for (let i = 0; i < p.current.data.nodes.length; i++) consider(i);
      return best;
    }

    // true when a clicked node is locking the isolated subgraph in place
    const isLocked = () =>
      p.current.layout === "constellation" && p.current.selectedIndex >= 0;

    function onMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const idx = nearest(mx, my);
      if (idx !== hoverRef.current) {
        hoverRef.current = idx;
        scheduleDraw(); // redraw for the hover cue (focus-restricted when locked)
      }
      p.current.onHover(idx >= 0 ? p.current.data.nodes[idx] : null, [mx, my]);
      canvas!.style.cursor = idx >= 0 ? "pointer" : "grab";
    }
    function onDown(e: MouseEvent) {
      downPos.current = [e.clientX, e.clientY];
    }
    function onClick(e: MouseEvent) {
      // ignore clicks that were really pans/drags
      const moved = Math.hypot(e.clientX - downPos.current[0], e.clientY - downPos.current[1]);
      if (moved > 5) return;
      const rect = canvas!.getBoundingClientRect();
      const idx = nearest(e.clientX - rect.left, e.clientY - rect.top);
      if (idx >= 0) p.current.onSelect(p.current.data.nodes[idx]);
      else p.current.onBackground(); // empty space releases the lock
    }
    function onLeave() {
      if (hoverRef.current !== -1) {
        hoverRef.current = -1;
        scheduleDraw();
      }
      p.current.onHover(null, [0, 0]);
    }

    canvas.addEventListener("mousedown", onDown, true); // capture: beat d3-zoom
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("mousedown", onDown, true);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mouseleave", onLeave);
      sel.on(".zoom", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data, props.dims]);

  return <canvas ref={canvasRef} style={{ display: "block" }} />;
});

export default MapCanvas;
