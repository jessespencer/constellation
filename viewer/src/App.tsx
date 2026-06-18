import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { zoomIdentity, type ZoomTransform } from "d3-zoom";
import MapCanvas, { type MapCanvasHandle } from "./MapCanvas";
import Drawer from "./Drawer";

// code-split: the Three.js bundle only loads when the 3D view is opened
const ThreeView = lazy(() => import("./ThreeView"));
import { computeBloom } from "./bloom";
import type {
  MapData,
  NodeDatum,
  ColorMode,
  Layout,
  SizeMode,
  ResolvedEdge,
} from "./types";
import { worldToScreen, type Dims } from "./projection";

export default function App() {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<Dims>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [colorMode, setColorMode] = useState<ColorMode>("cluster");
  const [sizeMode, setSizeMode] = useState<SizeMode>("density");
  const [layout, setLayout] = useState<Layout>("3d");
  const [bridgesOnly, setBridgesOnly] = useState(false);
  const [showRegions, setShowRegions] = useState(false);
  const [settling, setSettling] = useState(false);
  const [regionsVersion, setRegionsVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<{ node: NodeDatum; pos: [number, number] } | null>(null);
  const [selected, setSelected] = useState<NodeDatum | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasApi = useRef<MapCanvasHandle>(null);
  const workerRef = useRef<Worker | null>(null);
  const constPosRef = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    fetch("/map.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((m: MapData) => {
        const es = m.edges ?? [];
        const bridges = es.filter((e) => e.bridge);
        console.log(
          `[atlas] ${m.nodes.length} nodes · ${es.length} edges · ${bridges.length} bridges`
        );
        console.log("[atlas] sample bridge edges:", bridges.slice(0, 3));
        setData(m);
      })
      .catch(() => setError("Could not load map.json — run `make map` in /pipeline first."));
  }, []);

  // --- derived, built once per data load ---------------------------------- //
  const idIndex = useMemo(() => {
    const m = new Map<string, number>();
    data?.nodes.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [data]);

  const mapPos = useMemo(() => {
    if (!data) return new Float32Array(0);
    const arr = new Float32Array(data.nodes.length * 2);
    data.nodes.forEach((n, i) => {
      arr[2 * i] = n.x;
      arr[2 * i + 1] = n.y;
    });
    return arr;
  }, [data]);

  const edges = useMemo<ResolvedEdge[]>(() => {
    if (!data?.edges) return [];
    const out: ResolvedEdge[] = [];
    for (const e of data.edges) {
      const si = idIndex.get(e.source);
      const ti = idIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;
      out.push({ si, ti, w: e.weight, bridge: e.bridge });
    }
    return out;
  }, [data, idIndex]);

  const adjacency = useMemo<number[][]>(() => {
    if (!data) return [];
    const adj: number[][] = data.nodes.map(() => []);
    edges.forEach((e, ei) => {
      adj[e.si].push(ei);
      adj[e.ti].push(ei);
    });
    return adj;
  }, [data, edges]);

  const clusterColor = useMemo(() => {
    const m = new Map<number, string>();
    data?.clusters.forEach((c) => m.set(c.id, c.color));
    return m;
  }, [data]);

  const degree = useMemo(() => adjacency.map((a) => a.length), [adjacency]);

  // radial seed-head layout (deterministic; recomputed only when data changes)
  const bloom = useMemo(
    () => (data ? computeBloom(data, degree) : null),
    [data, degree]
  );

  // per-node size multiplier from the chosen metric (p95-normalized, sqrt-eased)
  const nodeScale = useMemo<Float32Array>(() => {
    if (!data) return new Float32Array(0);
    const n = data.nodes.length;
    const out = new Float32Array(n).fill(1);
    if (sizeMode === "uniform") return out;
    const metric = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      metric[i] =
        sizeMode === "length"
          ? data.nodes[i].msg_count
          : sizeMode === "links"
          ? degree[i]
          : data.nodes[i].density ?? 0;
    }
    const sorted = Array.from(metric).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(n * 0.95)] || 1;
    for (let i = 0; i < n; i++) {
      out[i] = 0.55 + 1.9 * Math.sqrt(Math.min(1, metric[i] / p95));
    }
    return out;
  }, [data, degree, sizeMode]);

  // seed constellation positions when data arrives
  useEffect(() => {
    constPosRef.current = mapPos.slice();
  }, [mapPos]);

  // --- force-layout worker ------------------------------------------------ //
  useEffect(() => {
    if (!data) return;
    const w = new Worker(new URL("./forceWorker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (ev: MessageEvent) => {
      const { type, positions } = ev.data as {
        type: string;
        positions: Float32Array;
      };
      constPosRef.current = positions;
      canvasApi.current?.redraw();
      if (type === "end") {
        setSettling(false);
        setRegionsVersion((v) => v + 1); // hulls valid now that it's frozen
      }
    };
    workerRef.current = w;
    return () => w.terminate();
  }, [data]);

  // bloom open each time the user (re-)enters Constellation mode
  useEffect(() => {
    if (!data || !bloom || layout !== "constellation" || !workerRef.current) return;
    constPosRef.current = bloom.seeds.slice(); // start collapsed near center
    canvasApi.current?.redraw();
    const nodes = data.nodes.map((_, i) => ({
      x: bloom.seeds[2 * i],
      y: bloom.seeds[2 * i + 1],
      cx: bloom.targets[2 * i], // radial target
      cy: bloom.targets[2 * i + 1],
    }));
    setSettling(true);
    workerRef.current.postMessage({ nodes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, data]);

  // track stage size — keyed on data so the observer attaches once the stage exists
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setDims({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setDims({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [data]);

  const labelClusters = useMemo(
    () => (data ? data.clusters.filter((c) => c.id !== -1) : []),
    [data]
  );

  const matchCount = useMemo(() => {
    if (!data || !query.trim()) return null;
    const q = query.trim().toLowerCase();
    return data.nodes.filter((n) => n.title.toLowerCase().includes(q)).length;
  }, [data, query]);

  if (error) return <div className="splash"><p>{error}</p></div>;
  if (!data) return <div className="splash"><p className="muted">Loading map…</p></div>;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Constellation
          <span className="brand-sub">
            {data.meta.n.toLocaleString()} conversations · {data.meta.n_clusters} themes ·{" "}
            {(data.edges?.length ?? 0).toLocaleString()} links
          </span>
        </div>
        <div className="controls">
          <input
            className="search"
            placeholder="Search titles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {matchCount !== null && <span className="match-count">{matchCount} lit</span>}

          <div className="toggle">
            <button className={layout === "map" ? "on" : ""} onClick={() => setLayout("map")}>
              Map
            </button>
            <button
              className={layout === "constellation" ? "on" : ""}
              onClick={() => setLayout("constellation")}
            >
              Constellation
            </button>
            <button className={layout === "3d" ? "on" : ""} onClick={() => setLayout("3d")}>
              3D
            </button>
          </div>

          <div className="toggle">
            <button className={colorMode === "cluster" ? "on" : ""} onClick={() => setColorMode("cluster")}>
              Theme
            </button>
            <button className={colorMode === "source" ? "on" : ""} onClick={() => setColorMode("source")}>
              Source
            </button>
          </div>

          <select
            className="size-select"
            value={sizeMode}
            onChange={(e) => setSizeMode(e.target.value as SizeMode)}
            title="What dot size represents"
          >
            <option value="uniform">Size · Uniform</option>
            <option value="density">Size · Density</option>
            <option value="links">Size · Links</option>
            <option value="length">Size · Length</option>
          </select>

          <button
            className={`pill ${bridgesOnly ? "on" : ""}`}
            onClick={() => setBridgesOnly((v) => !v)}
            title="Show only cross-cluster links"
          >
            Bridges
          </button>
          <button
            className={`pill ${showRegions ? "on" : ""}`}
            onClick={() => setShowRegions((v) => !v)}
            title="Soft hulls around clusters"
          >
            Regions
          </button>
        </div>
      </div>

      <div className="stage" ref={stageRef}>
        {dims.width > 0 && layout === "3d" && (
          <Suspense fallback={<div className="settling-note">loading 3D…</div>}>
            <ThreeView
              data={data}
              dims={dims}
              degree={degree}
              edges={edges}
              clusterColor={clusterColor}
              colorMode={colorMode}
              nodeScale={nodeScale}
              query={query}
              bridgesOnly={bridgesOnly}
              onHover={(node, pos) => setHover(node ? { node, pos } : null)}
              onSelect={setSelected}
            />
          </Suspense>
        )}
        {dims.width > 0 && layout !== "3d" && (
          <MapCanvas
            ref={canvasApi}
            data={data}
            dims={dims}
            layout={layout}
            settling={settling}
            mapPos={mapPos}
            constPosRef={constPosRef}
            nodeScale={nodeScale}
            edges={edges}
            adjacency={adjacency}
            clusterColor={clusterColor}
            colorMode={colorMode}
            query={query}
            bridgesOnly={bridgesOnly}
            showRegions={showRegions}
            regionsVersion={regionsVersion}
            selectedId={selected?.id ?? null}
            selectedIndex={selected ? idIndex.get(selected.id) ?? -1 : -1}
            onTransform={setTransform}
            onHover={(node, pos) => setHover(node ? { node, pos } : null)}
            onSelect={setSelected}
            onBackground={() => setSelected(null)}
          />
        )}

        {settling && <div className="settling-note">blooming…</div>}

        {/* Map: cluster labels fade in with zoom. Constellation: big always-on
            theme labels at each tuft's perimeter, sized by cluster. */}
        {layout === "map" &&
          colorMode === "cluster" &&
          labelClusters.map((c) => {
            const [sx, sy] = worldToScreen(c.cx, c.cy, dims, transform);
            if (sx < -80 || sy < -40 || sx > dims.width + 80 || sy > dims.height + 40) return null;
            const threshold = 0.7 + 6 / Math.sqrt(c.count);
            const opacity = Math.max(0, Math.min(0.85, (transform.k - threshold) * 0.9 + 0.18));
            if (opacity <= 0.02) return null;
            return (
              <div
                key={c.id}
                className="cluster-label"
                style={{ left: sx, top: sy, opacity, color: c.color }}
              >
                {c.label}
              </div>
            );
          })}

        {layout === "constellation" &&
          bloom &&
          labelClusters.map((c) => {
            const anchor = bloom.labelPos.get(c.id);
            if (!anchor) return null;
            const [sx, sy] = worldToScreen(anchor[0], anchor[1], dims, transform);
            if (sx < -120 || sy < -40 || sx > dims.width + 120 || sy > dims.height + 40)
              return null;
            return (
              <div
                key={c.id}
                className="bloom-label"
                style={{ left: sx, top: sy, fontSize: bloom.labelSize.get(c.id) }}
              >
                {c.label}
              </div>
            );
          })}

        {hover && (
          <div
            className="tooltip"
            style={{
              left: Math.min(hover.pos[0] + 14, dims.width - 240),
              top: hover.pos[1] + 14,
            }}
          >
            <div className="tt-title">{hover.node.title}</div>
            <div className="tt-meta">
              {hover.node.source === "claude" ? "Claude" : "ChatGPT"}
              {hover.node.created_at ? ` · ${hover.node.created_at.slice(0, 10)}` : ""}
            </div>
          </div>
        )}
      </div>

      <Drawer node={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
