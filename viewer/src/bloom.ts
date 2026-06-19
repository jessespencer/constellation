// Radial "seed-head" layout: clusters fan out as tufts around a center, sized
// by how many conversations they hold. Each cluster gets an angular wedge
// (wider for bigger themes), a hub node near the middle, and members splayed
// outward — narrow at the hub, fanning wide at the tips. All deterministic, so
// re-entering the view reproduces the same bloom.
import type { MapData } from "./types";

const R_IN = 18;
const R_OUT_BASE = 40;
const R_OUT_PER = 2.8; // world units of reach per sqrt(member)
const R_OUT_CAP = 90;
const GAP_FRAC = 0.14; // share of the circle left as gaps between tufts
const DOT_R = 2.6;

export interface Bloom {
  targets: Float32Array; // [x0,y0,x1,y1,...] final radial position per node
  seeds: Float32Array; // near-center start positions (for the bloom-open anim)
  nodeRadius: Float32Array; // base dot radius per node (hubs are larger)
  labelPos: Map<number, [number, number]>; // cluster id -> world label anchor
  labelSize: Map<number, number>; // cluster id -> font px (scaled by size)
  hubIndex: Map<number, number>; // cluster id -> node index of its hub
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeBloom(data: MapData, degree: number[]): Bloom {
  const nodes = data.nodes;
  const n = nodes.length;
  const targets = new Float32Array(n * 2);
  const seeds = new Float32Array(n * 2);
  const nodeRadius = new Float32Array(n).fill(DOT_R);
  const labelPos = new Map<number, [number, number]>();
  const labelSize = new Map<number, number>();
  const hubIndex = new Map<number, number>();

  // group node indices by cluster
  const byCluster = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = nodes[i].cluster;
    (byCluster.get(c) ?? byCluster.set(c, []).get(c)!).push(i);
  }

  const real = data.clusters.filter((c) => c.id !== -1);
  // order tufts around the ring by each cluster's UMAP direction, so the
  // bloom preserves the map's relative arrangement
  real.sort((a, b) => Math.atan2(a.cy, a.cx) - Math.atan2(b.cy, b.cx));

  const totalW = real.reduce((s, c) => s + Math.sqrt(c.count), 0) || 1;
  const available = Math.PI * 2 * (1 - GAP_FRAC);
  const gap = (Math.PI * 2 * GAP_FRAC) / Math.max(real.length, 1);

  let cursor = -Math.PI / 2; // start at the top
  for (const c of real) {
    const members = byCluster.get(c.id) ?? [];
    const width = available * (Math.sqrt(c.count) / totalW);
    const center = cursor + width / 2;
    cursor += width + gap;

    const rOut = Math.min(R_OUT_BASE + Math.sqrt(c.count) * R_OUT_PER, R_OUT_CAP);

    // hub = most-connected member (falls back to first)
    let hub = members[0] ?? -1;
    let bestDeg = -1;
    for (const i of members) {
      if (degree[i] > bestDeg) {
        bestDeg = degree[i];
        hub = i;
      }
    }
    hubIndex.set(c.id, hub);

    for (const i of members) {
      let radius: number;
      let ang: number;
      if (i === hub) {
        radius = R_IN;
        ang = center;
        nodeRadius[i] = 3 + Math.sqrt(c.count) * 0.45; // hub stands out
      } else {
        const rnd = mulberry32((i + 1) * 0x9e3779b1);
        const tRad = Math.pow(rnd(), 0.62); // bias members outward
        radius = R_IN + 6 + tRad * (rOut - R_IN - 6);
        // fan: narrow near the hub, widening toward the tips
        const fan = (rnd() - 0.5) * width * 0.92 * (radius / rOut);
        ang = center + fan;
      }
      targets[2 * i] = radius * Math.cos(ang);
      targets[2 * i + 1] = radius * Math.sin(ang);
    }

    labelPos.set(c.id, [(rOut + 9) * Math.cos(center), (rOut + 9) * Math.sin(center)]);
    labelSize.set(c.id, Math.max(12, Math.min(30, 10 + Math.sqrt(c.count) * 0.9)));
  }

  // unclustered: faint tangle near the center
  for (const i of byCluster.get(-1) ?? []) {
    const rnd = mulberry32((i + 7) * 0x85ebca77);
    const radius = rnd() * 14;
    const ang = rnd() * Math.PI * 2;
    targets[2 * i] = radius * Math.cos(ang);
    targets[2 * i + 1] = radius * Math.sin(ang);
  }

  // seeds: start most of the way out toward each target (with a little jitter),
  // so the bloom opens from a near-final layout and just settles the rest in
  const START_FRAC = 0.6; // 0 = collapsed at center, 1 = already at the target
  for (let i = 0; i < n; i++) {
    const rnd = mulberry32((i + 3) * 0xc2b2ae35);
    seeds[2 * i] = targets[2 * i] * START_FRAC + (rnd() - 0.5) * 8;
    seeds[2 * i + 1] = targets[2 * i + 1] * START_FRAC + (rnd() - 0.5) * 8;
  }

  return { targets, seeds, nodeRadius, labelPos, labelSize, hubIndex };
}
