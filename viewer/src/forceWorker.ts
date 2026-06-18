/// <reference lib="webworker" />
// Relaxes the radial bloom off the main thread. Each node starts collapsed near
// the center and is pulled toward its precomputed radial target (cx,cy) while
// collision spreads overlaps — so the layout "blooms open" over ~2s, then
// freezes. No link force: structure comes from the targets, edges are only
// drawn, so the tufts stay splayed instead of clumping.
import {
  forceSimulation,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";

interface SimNode {
  x: number;
  y: number;
  cx: number; // radial target
  cy: number;
}

let sim: Simulation<SimNode, undefined> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

self.onmessage = (ev: MessageEvent) => {
  const { nodes } = ev.data as { nodes: SimNode[] };
  if (timer) clearTimeout(timer);
  if (sim) sim.stop();

  const n = nodes.length;

  sim = forceSimulation<SimNode>(nodes)
    .force("x", forceX<SimNode>((d) => d.cx).strength(0.18))
    .force("y", forceY<SimNode>((d) => d.cy).strength(0.18))
    .force("charge", forceManyBody<SimNode>().strength(-1.5).distanceMax(28))
    .force("collide", forceCollide<SimNode>(1.3))
    .alpha(1)
    .alphaMin(0.02)
    .alphaDecay(0.03)
    .stop();

  const snapshot = (): Float32Array => {
    const arr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      arr[2 * i] = nodes[i].x;
      arr[2 * i + 1] = nodes[i].y;
    }
    return arr;
  };

  const step = () => {
    if (!sim) return;
    sim.tick();
    const arr = snapshot();
    (self as DedicatedWorkerGlobalScope).postMessage(
      { type: "tick", positions: arr },
      [arr.buffer]
    );
    if (sim.alpha() > sim.alphaMin()) {
      timer = setTimeout(step, 16);
    } else {
      const fin = snapshot();
      (self as DedicatedWorkerGlobalScope).postMessage(
        { type: "end", positions: fin },
        [fin.buffer]
      );
    }
  };
  step();
};
