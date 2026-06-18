// 3D radial "dandelion": each theme gets a direction on a sphere (Fibonacci
// distribution), with a hub near the center and members splayed into a cone
// tuft along that direction — narrow at the hub, fanning toward the tips.
// Deterministic, so the structure is stable across re-entries.
import type { MapData } from "./types";

const R_IN = 24;
const R_OUT_BASE = 46;
const R_OUT_PER = 3.2;
const R_OUT_CAP = 96;
const DOT_R = 2.8;

export interface Bloom3D {
  pos: Float32Array; // [x0,y0,z0, x1,y1,z1, ...]
  nodeRadius: Float32Array; // per-node base point size (hubs larger)
  labelPos: Map<number, [number, number, number]>; // cluster id -> 3D anchor
  labelSize: Map<number, number>;
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

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function computeBloom3D(data: MapData, degree: number[]): Bloom3D {
  const nodes = data.nodes;
  const n = nodes.length;
  const pos = new Float32Array(n * 3);
  const nodeRadius = new Float32Array(n).fill(DOT_R);
  const labelPos = new Map<number, V3>();
  const labelSize = new Map<number, number>();

  const byCluster = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = nodes[i].cluster;
    (byCluster.get(c) ?? byCluster.set(c, []).get(c)!).push(i);
  }

  // order clusters by size so big themes get well-separated directions
  const real = data.clusters.filter((c) => c.id !== -1).slice().sort((a, b) => b.count - a.count);
  const K = real.length;
  const golden = Math.PI * (3 - Math.sqrt(5));

  real.forEach((c, ci) => {
    // Fibonacci sphere direction for this cluster
    const y = K > 1 ? 1 - (ci / (K - 1)) * 2 : 0;
    const rxy = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = ci * golden;
    const dir: V3 = norm([Math.cos(theta) * rxy, y, Math.sin(theta) * rxy]);

    // orthonormal basis (dir, u, v) for the cone
    const ref: V3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(dir, ref));
    const v = cross(dir, u);

    const rOut = Math.min(R_OUT_BASE + Math.sqrt(c.count) * R_OUT_PER, R_OUT_CAP);
    const cone = 0.34; // max half-angle (radians) of the tuft — tighter spikes

    const members = byCluster.get(c.id) ?? [];
    let hub = members[0] ?? -1;
    let best = -1;
    for (const i of members) if (degree[i] > best) ((best = degree[i]), (hub = i));

    for (const i of members) {
      let p: V3;
      if (i === hub) {
        p = [dir[0] * R_IN, dir[1] * R_IN, dir[2] * R_IN];
        nodeRadius[i] = 2.6 + Math.sqrt(c.count) * 0.4;
      } else {
        const rnd = mulberry32((i + 1) * 0x9e3779b1);
        const tRad = Math.pow(rnd(), 0.5); // push members outward along the spike
        const radius = R_IN + 8 + tRad * (rOut - R_IN - 8);
        const half = cone * (radius / rOut); // fan wider toward the tips
        const off = half * Math.sqrt(rnd());
        const az = rnd() * Math.PI * 2;
        const ca = Math.cos(off);
        const sa = Math.sin(off);
        const d: V3 = [
          dir[0] * ca + (u[0] * Math.cos(az) + v[0] * Math.sin(az)) * sa,
          dir[1] * ca + (u[1] * Math.cos(az) + v[1] * Math.sin(az)) * sa,
          dir[2] * ca + (u[2] * Math.cos(az) + v[2] * Math.sin(az)) * sa,
        ];
        p = [d[0] * radius, d[1] * radius, d[2] * radius];
      }
      pos[3 * i] = p[0];
      pos[3 * i + 1] = p[1];
      pos[3 * i + 2] = p[2];
    }

    const lr = rOut + 8;
    labelPos.set(c.id, [dir[0] * lr, dir[1] * lr, dir[2] * lr]);
    labelSize.set(c.id, Math.max(11, Math.min(24, 9 + Math.sqrt(c.count) * 0.75)));
  });

  // any leftover (shouldn't happen with taxonomy) -> small central cloud
  for (const i of byCluster.get(-1) ?? []) {
    const rnd = mulberry32((i + 5) * 0x85ebca77);
    const r = rnd() * 12;
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    pos[3 * i] = r * Math.sin(ph) * Math.cos(th);
    pos[3 * i + 1] = r * Math.cos(ph);
    pos[3 * i + 2] = r * Math.sin(ph) * Math.sin(th);
  }

  void sub;
  return { pos, nodeRadius, labelPos, labelSize };
}
