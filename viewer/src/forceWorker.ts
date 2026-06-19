/// <reference lib="webworker" />
// Relaxes the radial constellation layout off the main thread. Each node starts
// near its precomputed radial target (cx,cy) and is pulled the rest of the way
// in while collision spreads overlaps. No link force: structure comes from the
// targets, edges are only drawn, so the tufts stay splayed instead of clumping.
// Runs once to its settled equilibrium and returns it — the viewer shows it
// statically, no animation.
import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";

interface SimNode {
  x: number;
  y: number;
  cx: number; // radial target
  cy: number;
}

const snapshotOf = (ns: SimNode[]): Float32Array => {
  const arr = new Float32Array(ns.length * 2);
  for (let i = 0; i < ns.length; i++) {
    arr[2 * i] = ns[i].x;
    arr[2 * i + 1] = ns[i].y;
  }
  return arr;
};

// Relax the radial layout to its settled equilibrium and return it once. The
// viewer caches this and shows it statically (no animation) — the constellation
// just appears, like the static map, with labels fading in.
self.onmessage = (ev: MessageEvent) => {
  const { nodes } = ev.data as { nodes: SimNode[] };

  const sim = forceSimulation<SimNode>(nodes)
    // gentle pull toward the radial targets; collision spreads overlaps
    .force("x", forceX<SimNode>((d) => d.cx).strength(0.07))
    .force("y", forceY<SimNode>((d) => d.cy).strength(0.07))
    .force("charge", forceManyBody<SimNode>().strength(-1.5).distanceMax(28))
    .force("collide", forceCollide<SimNode>(1.3))
    .alpha(1)
    .alphaMin(0.02)
    .alphaDecay(0.015)
    .stop();

  while (sim.alpha() > sim.alphaMin()) sim.tick();

  const pos = snapshotOf(nodes);
  (self as DedicatedWorkerGlobalScope).postMessage({ positions: pos }, [
    pos.buffer,
  ]);
};
