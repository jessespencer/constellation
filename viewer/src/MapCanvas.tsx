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
  Source,
} from "./types";
import { SOURCE_COLORS, themeColor } from "./types";
import { heatColor, heatBucket } from "./heat";
import { worldToScreen, baseScale, type Dims } from "./projection";

const DOT_R = 1.5; // crisp star core radius (world-ish base, scaled by zoom)
const GLOW_MULT = 3.0; // glow sprite diameter relative to core radius (minimal)
const MAX_GLOW = 15; // px cap so cores stay crisp points, never a bloom blob
const REGION_PAD = 5; // world units to expand cluster hulls

const EDGE_RGB = "130,205,235"; // cool cyan ambient hairline, kept faint
const ACCENT_RGB = "95,220,255"; // active: hover / selection highlight
const BRIDGE_RGB = "154,140,255"; // cool violet cross-theme link — distinct by hue, not glare

// zoom floor — low enough that a zoomed-well-out framing (e.g. the loose
// constellation default) isn't clamped, and users can pull back to take in the
// whole structure.
const MIN_SCALE = 0.1;

export interface MapCanvasHandle {
  redraw: () => void;
  fit: (zoomFactor?: number, posOverride?: Float32Array) => void;
}

interface Props {
  data: MapData;
  dims: Dims;
  layout: Layout;
  settling: boolean;
  mapPosRef: React.MutableRefObject<Float32Array>;
  constPosRef: React.MutableRefObject<Float32Array>;
  nodeScale: Float32Array; // per-node size multiplier (size-by metric)
  heat: Float32Array; // per-node density intensity 0..1 (heat color mode)
  edges: ResolvedEdge[];
  adjacency: number[][];
  clusterColor: Map<number, string>;
  colorMode: ColorMode;
  query: string;
  showEdges: boolean;
  bridgesOnly: boolean;
  showRegions: boolean;
  showOrphans: boolean;
  hiddenSources: Set<Source>;
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
    : clusterColor.get(n.cluster) ?? themeColor(n.cluster);
}

const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomRef = useRef<ReturnType<typeof zoom<HTMLCanvasElement, unknown>> | null>(null);
  const hoverRef = useRef<number>(-1);
  const rafRef = useRef<number>(0);
  const downPos = useRef<[number, number]>([0, 0]); // to tell clicks from pans
  const bgRef = useRef<{ key: string; grad: CanvasGradient } | null>(null);
  // pre-rendered soft glow sprites, one per color (avoids per-node shadowBlur)
  const glowCache = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // cached per-cluster convex hulls in WORLD space (recomputed only when the
  // layout/positions actually change, not on every hover redraw)
  const hullCache = useRef<{ key: string; hulls: Map<number, [number, number][]> }>({
    key: "",
    hulls: new Map(),
  });
  // latest props for the imperative redraw + d3 handlers (avoids stale closures)
  const p = useRef(props);
  p.current = props;

  // Both 2D layouts draw from a live position buffer so each can bloom in on
  // entry: constPosRef for the constellation, mapPosRef for the map (which sits
  // at the static semantic positions except during its bloom).
  function positions(): Float32Array {
    const { layout, constPosRef, mapPosRef } = p.current;
    return layout === "constellation" ? constPosRef.current : mapPosRef.current;
  }

  // one soft radial glow sprite per color, lazily built and cached
  function glowSprite(color: string): HTMLCanvasElement {
    const cached = glowCache.current.get(color);
    if (cached) return cached;
    const S = 96;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, hexA(color, 0.8));
    grad.addColorStop(0.3, hexA(color, 0.2));
    grad.addColorStop(0.6, hexA(color, 0.04));
    grad.addColorStop(1, hexA(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    glowCache.current.set(color, c);
    return c;
  }

  function background(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const key = `${w}x${h}`;
    if (!bgRef.current || bgRef.current.key !== key) {
      // radial-gradient(130% 105% at 50% 28%, ...) approximated in canvas
      const cx = w * 0.5;
      const cy = h * 0.08;
      const r = Math.hypot(w, h) * 0.85;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, "#0b0d18");
      grad.addColorStop(0.5, "#070811");
      grad.addColorStop(0.8, "#040509");
      grad.addColorStop(1, "#020206");
      bgRef.current = { key, grad };
    }
    ctx.fillStyle = bgRef.current.grad;
    ctx.fillRect(0, 0, w, h);
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
    // slight perpendicular bow for an organic feel
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const off = Math.min(len * 0.1, 22);
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
      heat,
      edges,
      adjacency,
      colorMode,
      clusterColor,
      query,
      showEdges,
      bridgesOnly,
      showRegions,
      showOrphans,
      hiddenSources,
      settling,
      selectedIndex,
    } = p.current;
    const ctx = canvas.getContext("2d")!;
    const t = transformRef.current;
    const dpr = window.devicePixelRatio || 1;
    const pos = positions();
    const n = data.nodes.length;

    ctx.save();
    ctx.scale(dpr, dpr);
    background(ctx, dims.width, dims.height);

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
      ctx.lineJoin = "round";
      for (const [c, worldPts] of hulls) {
        if (worldPts.length < 3) continue;
        const pts = worldPts.map(
          ([wx, wy]) => worldToScreen(wx, wy, dims, t) as [number, number]
        );
        ctx.beginPath();
        const m = pts.length;
        const mid0 = [(pts[m - 1][0] + pts[0][0]) / 2, (pts[m - 1][1] + pts[0][1]) / 2];
        ctx.moveTo(mid0[0], mid0[1]);
        for (let k = 0; k < m; k++) {
          const cur = pts[k];
          const nxt = pts[(k + 1) % m];
          ctx.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2);
        }
        ctx.closePath();
        const col = clusterColor.get(c) ?? themeColor(c);
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.2;
        ctx.lineWidth = 1;
        ctx.strokeStyle = col;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- edges ---
    // In Constellation, a clicked node LOCKS the focus so its subgraph persists.
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

    // Constellation edges are drawn straight + uniform to match the 3D view's
    // lines (the map keeps its organic quadratic bow).
    const straightEdges = layout === "constellation";
    const drawEdge = (x1: number, y1: number, x2: number, y2: number) => {
      if (straightEdges) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else {
        curve(ctx, x1, y1, x2, y2);
      }
    };

    ctx.globalCompositeOperation = "source-over";
    const strong: number[] = [];
    if (showEdges || focused) {
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        // an edge touching a hidden source is never drawn (nor added to `strong`)
        if (
          hiddenSources.has(data.nodes[e.si].source) ||
          hiddenSources.has(data.nodes[e.ti].source)
        )
          continue;
        const isStrong = hi >= 0 ? e.si === hi || e.ti === hi : bridgesOnly && e.bridge;
        if (isStrong) {
          strong.push(ei);
          continue;
        }
        if (!showEdges) continue; // ambient field hidden (bridges route to the violet pass below)
        const a = hi >= 0 ? 0.04 : straightEdges ? 0.16 : 0.16 + e.w * 0.08; // dim only on hover, not for Bridges
        ctx.globalAlpha = a;
        ctx.lineWidth = straightEdges ? 0.8 : 0.6 + e.w * 0.5;
        ctx.strokeStyle = `rgb(${EDGE_RGB})`;
        drawEdge(sx[e.si], sy[e.si], sx[e.ti], sy[e.ti]);
      }
    }

    // Highlighted pass on top. Two distinct roles share this `strong` set:
    //  • hover/selection — should POP in bright accent cyan;
    //  • the standing Bridges layer — reads as a *different kind* of link, so it
    //    gets its own warm amber hue at low opacity rather than luminance glare.
    const hoverFocus = hi >= 0;
    for (const ei of strong) {
      const e = edges[ei];
      if (hoverFocus) {
        ctx.globalAlpha = 0.5 + e.w * 0.35;
        ctx.lineWidth = 0.9 + e.w * 1.4;
        ctx.strokeStyle = `rgba(${ACCENT_RGB},0.85)`;
      } else {
        // standing Bridges: dim violet, thin — distinct by hue, matches 3D
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgb(${BRIDGE_RGB})`;
      }
      drawEdge(sx[e.si], sy[e.si], sx[e.ti], sy[e.ti]);
    }
    ctx.globalAlpha = 1;

    // --- node glow (additive sprites — dense clusters bloom, orphans stay faint) ---
    // Density-heat mode is the default: intensity drives BOTH color (cool→warm)
    // and glow size/brightness, so dense cores read as hot-spots on near-black.
    const isHeat = colorMode === "density";
    const q = query.trim().toLowerCase();
    const zoomR = Math.sqrt(t.k);
    const dimTo = locked >= 0 ? 0.04 : 0.1;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i++) {
      const node = data.nodes[i];
      if (!showOrphans && adjacency[i].length === 0) continue;
      if (hiddenSources.has(node.source)) continue;
      const match = !q || node.title.toLowerCase().includes(q);
      const ti = isHeat ? heat[i] || 0 : 0;
      let a = isHeat ? 0.16 + ti * 0.55 : 0.58;
      if (q && !match) a = 0.04;
      if (neighbors && !neighbors.has(i)) a = Math.min(a, dimTo);
      const r = Math.max(0.6, DOT_R * (nodeScale[i] || 1) * zoomR);
      const glowScale = isHeat ? Math.min(1.5, 0.4 + ti * 1.0) : 1;
      const gr = Math.min(MAX_GLOW, r * GLOW_MULT * glowScale);
      ctx.globalAlpha = a;
      const col = isHeat ? heatColor(heatBucket(ti)) : colorFor(node, colorMode, clusterColor);
      ctx.drawImage(glowSprite(col), sx[i] - gr, sy[i] - gr, gr * 2, gr * 2);
    }

    // --- crisp star cores on top ---
    ctx.globalCompositeOperation = "source-over";
    const hoverIdx = hoverRef.current;
    for (let i = 0; i < n; i++) {
      const node = data.nodes[i];
      if (!showOrphans && adjacency[i].length === 0) continue;
      if (hiddenSources.has(node.source)) continue;
      const match = !q || node.title.toLowerCase().includes(q);
      const ti = isHeat ? heat[i] || 0 : 0;
      let a = isHeat ? 0.6 + ti * 0.4 : 0.95;
      if (q && !match) a = 0.08;
      if (neighbors && !neighbors.has(i)) a = Math.min(a, dimTo + 0.04);
      const isHover = i === hoverIdx;
      const r = Math.max(0.6, DOT_R * (nodeScale[i] || 1) * zoomR) * (isHover ? 1.5 : 1);
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2);
      ctx.fillStyle = isHeat ? heatColor(ti) : colorFor(node, colorMode, clusterColor);
      ctx.globalAlpha = a;
      ctx.fill();
      // faint white center only on the hottest cores — keep it minimal
      const showCore = isHeat ? ti > 0.7 && r > 1.0 : r > 1.4;
      if (showCore) {
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], r * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.globalAlpha = a * 0.55;
        ctx.fill();
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

  // Reset pan/zoom so every (visible) node is framed in the viewport.
  // zoomFactor > 1 tightens past the exact fit (the default layout entry uses
  // DEFAULT_ZOOM; the Fit button passes 1 for an exact frame). posOverride lets
  // a caller frame a position set other than what's drawn — e.g. the
  // constellation's settled extent before the bloom has animated there.
  function fit(zoomFactor = 1, posOverride?: Float32Array) {
    const canvas = canvasRef.current;
    const zoomBehavior = zoomRef.current;
    if (!canvas || !zoomBehavior) return;
    const { data, dims, showOrphans, hiddenSources, adjacency } = p.current;
    if (!dims.width || !dims.height) return;
    const pos = posOverride ?? positions();
    const s = baseScale(dims);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < data.nodes.length; i++) {
      if (!showOrphans && adjacency[i].length === 0) continue;
      if (hiddenSources.has(data.nodes[i].source)) continue;
      const bx = dims.width / 2 + pos[2 * i] * s;
      const by = dims.height / 2 - pos[2 * i + 1] * s;
      if (bx < minX) minX = bx;
      if (by < minY) minY = by;
      if (bx > maxX) maxX = bx;
      if (by > maxY) maxY = by;
    }
    if (!isFinite(minX)) return;
    const pad = 0.12; // leave a margin around the framed structure
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const kFit = Math.min(40, dims.width * (1 - pad) / bw, dims.height * (1 - pad) / bh);
    const k = Math.max(MIN_SCALE, Math.min(40, kFit * zoomFactor));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const t = zoomIdentity
      .translate(dims.width / 2 - k * cx, dims.height / 2 - k * cy)
      .scale(k);
    // route through the zoom behavior so transformRef/onTransform stay in sync
    select(canvas).call(zoomBehavior.transform, t);
  }

  useImperativeHandle(ref, () => ({ redraw: scheduleDraw, fit }), []);

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
    props.heat,
    props.query,
    props.selectedId,
    props.selectedIndex,
    props.showEdges,
    props.bridgesOnly,
    props.showRegions,
    props.showOrphans,
    props.hiddenSources,
    props.regionsVersion,
    props.dims,
  ]);

  // d3 zoom + hover/click — set up once per data/dims
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sel = select(canvas);
    const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([MIN_SCALE, 40])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        p.current.onTransform(event.transform);
        scheduleDraw();
      });
    zoomRef.current = zoomBehavior;
    sel.call(zoomBehavior);
    sel.call(zoomBehavior.transform, transformRef.current);

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
      const hitR = (DOT_R * Math.sqrt(t.k) + 5) ** 2;
      let best = -1;
      let bestD = hitR;
      const consider = (i: number) => {
        if (!p.current.showOrphans && p.current.adjacency[i].length === 0) return;
        if (p.current.hiddenSources.has(p.current.data.nodes[i].source)) return;
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

    const isLocked = () =>
      p.current.layout === "constellation" && p.current.selectedIndex >= 0;

    function onMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const idx = nearest(mx, my);
      if (idx !== hoverRef.current) {
        hoverRef.current = idx;
        scheduleDraw();
      }
      p.current.onHover(idx >= 0 ? p.current.data.nodes[idx] : null, [mx, my]);
      canvas!.style.cursor = idx >= 0 ? "pointer" : "grab";
    }
    function onDown(e: MouseEvent) {
      downPos.current = [e.clientX, e.clientY];
    }
    function onClick(e: MouseEvent) {
      const moved = Math.hypot(e.clientX - downPos.current[0], e.clientY - downPos.current[1]);
      if (moved > 5) return;
      const rect = canvas!.getBoundingClientRect();
      const idx = nearest(e.clientX - rect.left, e.clientY - rect.top);
      if (idx >= 0) p.current.onSelect(p.current.data.nodes[idx]);
      else p.current.onBackground();
    }
    function onLeave() {
      if (hoverRef.current !== -1) {
        hoverRef.current = -1;
        scheduleDraw();
      }
      p.current.onHover(null, [0, 0]);
    }

    canvas.addEventListener("mousedown", onDown, true);
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

// hex color -> rgba string at the given alpha (handles #rgb and #rrggbb)
function hexA(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default MapCanvas;
