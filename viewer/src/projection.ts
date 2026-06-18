import type { ZoomTransform } from "d3-zoom";

// World coordinates live in roughly [-100, 100]. The base projection fits that
// box into the canvas; the d3 ZoomTransform is then applied on top for pan/zoom.
const WORLD_HALF = 105; // a little padding beyond the [-100,100] data box

export interface Dims {
  width: number;
  height: number;
}

export function baseScale({ width, height }: Dims): number {
  return Math.min(width, height) / (2 * WORLD_HALF);
}

export function worldToScreen(
  wx: number,
  wy: number,
  dims: Dims,
  t: ZoomTransform
): [number, number] {
  const s = baseScale(dims);
  // y is flipped so +y points up, like a map
  const bx = dims.width / 2 + wx * s;
  const by = dims.height / 2 - wy * s;
  return [t.applyX(bx), t.applyY(by)];
}

export function screenToWorld(
  sx: number,
  sy: number,
  dims: Dims,
  t: ZoomTransform
): [number, number] {
  const s = baseScale(dims);
  const bx = t.invertX(sx);
  const by = t.invertY(sy);
  return [(bx - dims.width / 2) / s, -(by - dims.height / 2) / s];
}
