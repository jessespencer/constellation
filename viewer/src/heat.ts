// Cool→warm density temperature ramp. A per-node intensity in [0,1] maps to a
// color: sparse nodes read as dim cool blue, dense cores bloom hot orange.
type Stop = [number, [number, number, number]];

// Soft cornflower-blue → warm gold duotone (weather-app palette), no neon orange.
const STOPS: Stop[] = [
  [0.0, [86, 104, 143]], // #56688f sparse — dim cool blue
  [0.3, [143, 176, 224]], // #8fb0e0 cornflower blue
  [0.55, [230, 238, 255]], // #e6eeff near-white
  [0.75, [240, 212, 154]], // #f0d49a pale gold
  [0.9, [233, 189, 118]], // #e9bd76 amber gold
  [1.0, [224, 168, 87]], // #e0a857 deep gold
];

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

export function heatColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (x - t0) / (t1 - t0 || 1);
      const r = c0[0] + (c1[0] - c0[0]) * f;
      const g = c0[1] + (c1[1] - c0[1]) * f;
      const b = c0[2] + (c1[2] - c0[2]) * f;
      return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    }
  }
  const last = STOPS[STOPS.length - 1][1];
  return `#${hex2(last[0])}${hex2(last[1])}${hex2(last[2])}`;
}

// Quantize intensity so the glow-sprite cache stays small (one sprite per bucket).
export function heatBucket(t: number): number {
  return Math.round(Math.max(0, Math.min(1, t)) * 23) / 23;
}
