import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { zoomIdentity, type ZoomTransform } from "d3-zoom";
import MapCanvas, { type MapCanvasHandle } from "./MapCanvas";
import Drawer from "./Drawer";
import LayersPanel from "./LayersPanel";
import ReadoutCard from "./ReadoutCard";
import { Icon } from "./ui";
import { layoutLabels, type LabelItem } from "./labelLayout";

// code-split: the Three.js bundle only loads when the 3D view is opened
const ThreeView = lazy(() => import("./ThreeView"));
import type { ThreeViewHandle } from "./ThreeView";
import { computeBloom } from "./bloom";
import type {
  MapData,
  NodeDatum,
  ColorMode,
  Layout,
  SizeMode,
  ResolvedEdge,
} from "./types";
import { themeColor } from "./types";
import { worldToScreen, type Dims } from "./projection";

const CARD_W = 232;
const CARD_H = 152;
const LABEL_PX = 12; // uniform category-heading size across all layout tabs

// plain-language descriptions for every control, grouped for the info panel
const INFO_SECTIONS: { heading: string; items: { name: string; body: string }[] }[] = [
  {
    heading: "View",
    items: [
      {
        name: "3D",
        body: "The semantic space in three dimensions — orbit and fly through your conversations, with related topics floating close together.",
      },
      {
        name: "Map",
        body: "The true semantic map. Every conversation is placed by meaning, so similar topics sit near each other and themes spread across the plane.",
      },
      {
        name: "Constellation",
        body: "A force-directed bloom. Conversations are pulled together by their links until connected topics settle into bright, distinct clusters.",
      },
    ],
  },
  {
    heading: "Color",
    items: [
      {
        name: "Theme",
        body: "Color by theme. Each cluster gets its own hue, so conversations about the same topic share a color.",
      },
      {
        name: "Heat",
        body: "Color by activity. Hot, bright points are densely connected hubs you returned to often; cool points sit on their own.",
      },
      {
        name: "Source",
        body: "Color by origin — Claude in blue, ChatGPT in amber — to see how each tool fills the map.",
      },
    ],
  },
  {
    heading: "Layers",
    items: [
      { name: "Edges", body: "Draw the links between related conversations." },
      {
        name: "Bridges",
        body: "Show only cross-theme links — the conversations that connect otherwise separate topics.",
      },
      { name: "Regions", body: "Trace a soft hull around each theme cluster." },
      { name: "Labels", body: "Float each theme's name over its cluster." },
      { name: "Orphans", body: "Include unconnected conversations that sit on their own." },
    ],
  },
  {
    heading: "Node size",
    items: [
      { name: "Uniform", body: "Every conversation is drawn at the same size." },
      { name: "Density", body: "Bigger points are more densely connected hubs." },
    ],
  },
];

export default function App() {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<Dims>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [colorMode, setColorMode] = useState<ColorMode>("cluster");
  const [sizeMode, setSizeMode] = useState<SizeMode>("density");
  const [layout, setLayout] = useState<Layout>("3d");
  const [showEdges, setShowEdges] = useState(true);
  const [bridgesOnly, setBridgesOnly] = useState(false);
  const [showRegions, setShowRegions] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [settling, setSettling] = useState(false);
  const [regionsVersion, setRegionsVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<{ node: NodeDatum; pos: [number, number] } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selected, setSelected] = useState<NodeDatum | null>(null);
  const [fontsReady, setFontsReady] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLDivElement>(null);
  const canvasApi = useRef<MapCanvasHandle>(null);
  const threeApi = useRef<ThreeViewHandle>(null);
  const workerRef = useRef<Worker | null>(null);
  const constPosRef = useRef<Float32Array>(new Float32Array(0));
  const [topbarH, setTopbarH] = useState(0);

  // frame every node in the current view (resets pan/zoom in 2D, camera in 3D)
  function fitToScreen() {
    if (layout === "3d") threeApi.current?.fit();
    else canvasApi.current?.fit();
  }

  useEffect(() => {
    fetch("/map.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((m: MapData) => {
        const es = m.edges ?? [];
        const bridges = es.filter((e) => e.bridge);
        console.log(
          `[atlas] ${m.nodes.length} nodes · ${es.length} edges · ${bridges.length} bridges`
        );
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

  // night-sky palette: override the map.json earthy hues with cool, luminous
  // tints keyed by cluster id (perceptually separated, calm on navy)
  const clusterColor = useMemo(() => {
    const m = new Map<number, string>();
    data?.clusters.forEach((c) => m.set(c.id, themeColor(c.id)));
    return m;
  }, [data]);

  const clusterLabel = useMemo(() => {
    const m = new Map<number, string>();
    data?.clusters.forEach((c) => m.set(c.id, c.label));
    return m;
  }, [data]);

  const degree = useMemo(() => adjacency.map((a) => a.length), [adjacency]);

  const bloom = useMemo(
    () => (data ? computeBloom(data, degree) : null),
    [data, degree]
  );

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

  // per-node density intensity 0→1 for the heat ramp. Blends edge degree and the
  // precomputed local density, percentile-normalized (p93) and sqrt-eased so the
  // ramp spreads instead of bunching at the low end.
  const heat = useMemo<Float32Array>(() => {
    if (!data) return new Float32Array(0);
    const n = data.nodes.length;
    const metric = new Float32Array(n);
    let maxDeg = 1;
    let maxDen = 1;
    for (let i = 0; i < n; i++) {
      maxDeg = Math.max(maxDeg, degree[i]);
      maxDen = Math.max(maxDen, data.nodes[i].density ?? 0);
    }
    for (let i = 0; i < n; i++) {
      // combine graph degree and embedding-local density, each 0..1
      metric[i] = 0.6 * (degree[i] / maxDeg) + 0.4 * ((data.nodes[i].density ?? 0) / maxDen);
    }
    const sorted = Array.from(metric).sort((a, b) => a - b);
    const p93 = sorted[Math.floor(n * 0.93)] || 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.sqrt(Math.min(1, metric[i] / p93));
    }
    return out;
  }, [data, degree]);

  useEffect(() => {
    constPosRef.current = mapPos.slice();
  }, [mapPos]);

  // Michroma loads via font-display:swap — re-run label layout once it's ready
  // so collision boxes use the real (wide) metrics, not the fallback font's.
  useEffect(() => {
    let alive = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) fonts.ready.then(() => alive && setFontsReady(true));
    else setFontsReady(true);
    return () => {
      alive = false;
    };
  }, []);

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
        setRegionsVersion((v) => v + 1);
      }
    };
    workerRef.current = w;
    return () => w.terminate();
  }, [data]);

  useEffect(() => {
    if (!data || !bloom || layout !== "constellation" || !workerRef.current) return;
    constPosRef.current = bloom.seeds.slice();
    canvasApi.current?.redraw();
    const nodes = data.nodes.map((_, i) => ({
      x: bloom.seeds[2 * i],
      y: bloom.seeds[2 * i + 1],
      cx: bloom.targets[2 * i],
      cy: bloom.targets[2 * i + 1],
    }));
    setSettling(true);
    workerRef.current.postMessage({ nodes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, data]);

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

  // measure the topbar so the drawer can sit below it (keeping the header live)
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTopbarH(el.offsetHeight));
    ro.observe(el);
    setTopbarH(el.offsetHeight);
    return () => ro.disconnect();
  }, [data]);

  const labelClusters = useMemo(
    () => (data ? data.clusters.filter((c) => c.id !== -1) : []),
    [data]
  );

  // Map-mode label anchors: push each label OUT from the cluster centroid to its
  // hull edge (radially away from the map center), so labels sit at the rim
  // instead of buried in the dense core where they'd occlude their own nodes.
  const mapLabelAnchors = useMemo(() => {
    const m = new Map<number, [number, number]>();
    if (!data) return m;
    const sums = new Map<number, { x: number; y: number; n: number }>();
    let gx = 0,
      gy = 0,
      gn = 0;
    for (let i = 0; i < data.nodes.length; i++) {
      const c = data.nodes[i].cluster;
      if (c === -1) continue;
      const s = sums.get(c) ?? sums.set(c, { x: 0, y: 0, n: 0 }).get(c)!;
      s.x += mapPos[2 * i];
      s.y += mapPos[2 * i + 1];
      s.n++;
      gx += mapPos[2 * i];
      gy += mapPos[2 * i + 1];
      gn++;
    }
    gx /= gn || 1;
    gy /= gn || 1;
    for (const [c, s] of sums) {
      const cx = s.x / s.n;
      const cy = s.y / s.n;
      // p80 distance from centroid ≈ hull edge (ignores far outliers)
      const dists: number[] = [];
      for (let i = 0; i < data.nodes.length; i++) {
        if (data.nodes[i].cluster !== c) continue;
        dists.push(Math.hypot(mapPos[2 * i] - cx, mapPos[2 * i + 1] - cy));
      }
      dists.sort((a, b) => a - b);
      const rad = dists[Math.floor(dists.length * 0.8)] ?? 4;
      let dx = cx - gx;
      let dy = cy - gy;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) {
        dx = 0;
        dy = 1; // centered cluster → place above
      } else {
        dx /= len;
        dy /= len;
      }
      m.set(c, [cx + dx * (rad + 4), cy + dy * (rad + 4)]);
    }
    return m;
  }, [data, mapPos]);

  const matchCount = useMemo(() => {
    if (!data || !query.trim()) return null;
    const q = query.trim().toLowerCase();
    return data.nodes.filter((n) => n.title.toLowerCase().includes(q)).length;
  }, [data, query]);

  // --- cluster labels with collision avoidance (crisp DOM overlay) -------- //
  const placedLabels = useMemo(() => {
    if (!data || !showLabels || layout === "3d") return [];
    const items: LabelItem[] = [];
    for (const c of labelClusters) {
      let wx: number, wy: number;
      if (layout === "constellation") {
        if (!bloom) continue;
        const anchor = bloom.labelPos.get(c.id);
        if (!anchor) continue;
        [wx, wy] = anchor;
      } else {
        const anchor = mapLabelAnchors.get(c.id);
        if (!anchor) continue;
        [wx, wy] = anchor; // hull edge, not centroid
        // map: only show clusters once zoomed in past a size-scaled threshold
        const threshold = 0.7 + 6 / Math.sqrt(c.count);
        if (transform.k < threshold) continue;
      }
      const [sx, sy] = worldToScreen(wx, wy, dims, transform);
      if (sx < -120 || sy < -60 || sx > dims.width + 120 || sy > dims.height + 60)
        continue;
      // uniform size — every category heading reads the same across tabs
      items.push({ id: c.id, text: c.label, x: sx, y: sy, size: LABEL_PX, priority: c.count });
    }
    return layoutLabels(items);
  }, [data, showLabels, layout, labelClusters, bloom, mapLabelAnchors, dims, transform, fontsReady]);

  // --- selected node screen position (2D layouts) for ring + leader ------- //
  const selIndex = selected ? idIndex.get(selected.id) ?? -1 : -1;
  const selScreen = useMemo<[number, number] | null>(() => {
    if (selIndex < 0 || layout === "3d" || !dims.width) return null;
    const pos = layout === "constellation" ? constPosRef.current : mapPos;
    if (pos.length < (selIndex + 1) * 2) return null;
    return worldToScreen(pos[2 * selIndex], pos[2 * selIndex + 1], dims, transform);
    // constPosRef read intentionally; regionsVersion bump re-runs after settle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIndex, layout, mapPos, dims, transform, regionsVersion]);

  const selRingR = useMemo(() => {
    if (selIndex < 0) return 0;
    const r = 1.5 * (nodeScale[selIndex] || 1) * Math.sqrt(transform.k);
    return Math.max(8, r + 6);
  }, [selIndex, nodeScale, transform]);

  // anchor a readout card near a screen point, clamped into the viewport
  function cardPlacement(ax: number, ay: number) {
    let left = ax + 20;
    let side: "left" | "right" = "left";
    if (left + CARD_W > dims.width - 12) {
      left = ax - 20 - CARD_W;
      side = "right";
    }
    left = Math.max(12, Math.min(left, dims.width - CARD_W - 12));
    let top = ay - CARD_H / 2;
    top = Math.max(12, Math.min(top, dims.height - CARD_H - 12));
    return { left, top, side };
  }

  if (error) return <div className="splash"><p>{error}</p></div>;
  if (!data) return <div className="splash"><p className="muted">Loading map…</p></div>;

  const selPlace = selScreen ? cardPlacement(selScreen[0], selScreen[1]) : null;
  const leaderAttach =
    selScreen && selPlace
      ? ([
          selPlace.side === "left" ? selPlace.left : selPlace.left + CARD_W,
          Math.max(selPlace.top + 16, Math.min(selScreen[1], selPlace.top + CARD_H - 16)),
        ] as [number, number])
      : null;

  return (
    <div
      className={`app${selected ? " drawer-open" : ""}${infoOpen ? " info-open" : ""}`}
      style={{ "--topbar-h": `${topbarH}px` } as React.CSSProperties}
    >
      <div className="topbar" ref={topbarRef}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <span className="wordmark">constellation</span>
            <span className="brand-sub">
              {data.meta.n.toLocaleString()} conversations · {data.meta.n_clusters} themes ·{" "}
              {(data.edges?.length ?? 0).toLocaleString()} links
            </span>
          </div>
        </div>
        <div className="controls">
          <div className="search-pill glass">
            <Icon name="search" size={15} />
            <input
              className="search"
              placeholder="Search titles…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matchCount !== null && <span className="match-count">{matchCount} lit</span>}
          </div>

          <div className="toggle glass">
            <button
              className={layout === "3d" ? "on" : ""}
              onClick={() => setLayout("3d")}
            >
              3D
            </button>
            <button
              className={layout === "map" ? "on" : ""}
              onClick={() => setLayout("map")}
            >
              Map
            </button>
            <button
              className={layout === "constellation" ? "on" : ""}
              onClick={() => setLayout("constellation")}
            >
              Constellation
            </button>
          </div>

          <button
            className={`info-btn glass${infoOpen ? " on" : ""}`}
            onClick={() => setInfoOpen((v) => !v)}
            title="What do these controls do?"
            aria-label="Control guide"
            aria-expanded={infoOpen}
          >
            {infoOpen ? <Icon name="close" size={16} /> : <Icon name="info" size={16} />}
          </button>
        </div>
      </div>

      <div className="stage" ref={stageRef}>
        {dims.width > 0 && layout === "3d" && (
          <Suspense fallback={<div className="settling-note">loading 3D…</div>}>
            <ThreeView
              ref={threeApi}
              data={data}
              dims={dims}
              degree={degree}
              edges={edges}
              clusterColor={clusterColor}
              colorMode={colorMode}
              nodeScale={nodeScale}
              heat={heat}
              query={query}
              showEdges={showEdges}
              bridgesOnly={bridgesOnly}
              showLabels={showLabels}
              showOrphans={showOrphans}
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
            heat={heat}
            edges={edges}
            adjacency={adjacency}
            clusterColor={clusterColor}
            colorMode={colorMode}
            query={query}
            showEdges={showEdges}
            bridgesOnly={bridgesOnly}
            showRegions={showRegions}
            showOrphans={showOrphans}
            regionsVersion={regionsVersion}
            selectedId={selected?.id ?? null}
            selectedIndex={selIndex}
            onTransform={setTransform}
            onHover={(node, pos) => setHover(node ? { node, pos } : null)}
            onSelect={setSelected}
            onBackground={() => setSelected(null)}
          />
        )}

        {/* selection chrome + label leaders — crisp SVG above the canvas */}
        <svg className="overlay-svg">
          {placedLabels
            .filter((l) => l.moved)
            .map((l) => (
              <line
                key={`ld-${l.id}`}
                x1={l.anchorX}
                y1={l.anchorY}
                x2={l.x}
                y2={l.y}
                stroke="rgba(122,150,205,0.32)"
                strokeWidth={1}
              />
            ))}
          {selScreen && leaderAttach && (
            <line
              x1={selScreen[0]}
              y1={selScreen[1]}
              x2={leaderAttach[0]}
              y2={leaderAttach[1]}
              stroke="var(--accent-line)"
              strokeWidth={1.2}
              style={{ filter: "drop-shadow(0 0 3px rgba(95,220,255,0.6))" }}
            />
          )}
          {selScreen && (
            <>
              <circle
                cx={selScreen[0]}
                cy={selScreen[1]}
                r={selRingR}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={1.6}
                style={{ filter: "drop-shadow(0 0 4px rgba(95,220,255,0.8))" }}
              />
              <circle
                cx={selScreen[0]}
                cy={selScreen[1]}
                r={selRingR + 5}
                fill="none"
                stroke="rgba(95,220,255,0.25)"
                strokeWidth={1}
              />
            </>
          )}
        </svg>

        {/* cluster labels — crisp DOM overlay, never overlapping */}
        {placedLabels.map((l) => (
          <div
            key={l.id}
            className="cluster-label"
            style={{
              left: l.x,
              top: l.y,
              fontSize: l.size,
            }}
          >
            {l.text}
          </div>
        ))}

        {settling && <div className="settling-note">blooming…</div>}

        {/* selected readout card — anchored, with leader + ring */}
        {selected && selPlace && (
          <ReadoutCard
            node={selected}
            themeColor={themeColor(selected.cluster)}
            themeLabel={clusterLabel.get(selected.cluster) ?? "Unclustered"}
            neighbors={selIndex >= 0 ? degree[selIndex] : 0}
            style={{ left: selPlace.left, top: selPlace.top }}
          />
        )}

        {/* hover readout card — follows the cursor */}
        {hover && hover.node.id !== selected?.id && (
          <ReadoutCard
            node={hover.node}
            themeColor={themeColor(hover.node.cluster)}
            themeLabel={clusterLabel.get(hover.node.cluster) ?? "Unclustered"}
            neighbors={degree[idIndex.get(hover.node.id) ?? -1] ?? 0}
            style={(() => {
              const pl = cardPlacement(hover.pos[0], hover.pos[1]);
              return { left: pl.left, top: pl.top };
            })()}
          />
        )}

        <button className="fit-btn glass" onClick={fitToScreen} title="Fit to screen">
          <Icon name="fit" size={16} />
          <span>Fit</span>
        </button>

        <LayersPanel
          showEdges={showEdges}
          setShowEdges={setShowEdges}
          bridgesOnly={bridgesOnly}
          setBridgesOnly={setBridgesOnly}
          showRegions={showRegions}
          setShowRegions={setShowRegions}
          showLabels={showLabels}
          setShowLabels={setShowLabels}
          showOrphans={showOrphans}
          setShowOrphans={setShowOrphans}
          colorMode={colorMode}
          setColorMode={setColorMode}
          sizeMode={sizeMode}
          setSizeMode={setSizeMode}
        />

        <a
          className="credit"
          href="https://jessedestroys.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          built by jessedestroys.com
        </a>
      </div>

      <Drawer node={selected} onClose={() => setSelected(null)} />

      {infoOpen && (
        <div className="info-scrim" onClick={() => setInfoOpen(false)}>
          <div className="info-panel glass" onClick={(e) => e.stopPropagation()}>
            <div className="info-panel-head">Guide</div>
            <div className="info-grid">
              {INFO_SECTIONS.map((section) => (
                <div key={section.heading} className="info-section">
                  <div className="info-section-head">{section.heading}</div>
                  {section.items.map((item) => (
                    <div key={item.name} className="info-item">
                      <span className="info-item-name">{item.name}</span>
                      <span className="info-item-body">{item.body}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
