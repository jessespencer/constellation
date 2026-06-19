export interface ClusterMeta {
  id: number;
  label: string;
  terms: string[];
  color: string;
  count: number;
  cx: number;
  cy: number;
}

export interface NodeDatum {
  id: string;
  source: "claude" | "chatgpt";
  title: string;
  created_at: string;
  msg_count: number;
  cluster: number;
  x: number;
  y: number;
  density?: number; // # of conversations within cosine threshold
}

export type SizeMode = "uniform" | "length" | "links" | "density";

export interface Edge {
  source: string;
  target: string;
  weight: number;
  bridge: boolean;
}

export interface MapData {
  meta: {
    generated_at: string;
    model: string;
    n: number;
    sources: { claude: number; chatgpt: number };
    n_clusters: number;
  };
  clusters: ClusterMeta[];
  nodes: NodeDatum[];
  edges?: Edge[];
}

export type Layout = "map" | "constellation" | "3d";

// Edge with endpoints resolved to node indices (built once for fast drawing).
export interface ResolvedEdge {
  si: number;
  ti: number;
  w: number;
  bridge: boolean;
}

export interface Transcript {
  id: string;
  source: "claude" | "chatgpt";
  title: string;
  created_at: string;
  messages: { role: "user" | "assistant"; text: string }[];
}

export type ColorMode = "density" | "cluster" | "source";

// Source chips/dots: Claude reads cool blue, ChatGPT teal (night-sky palette).
export const SOURCE_COLORS: Record<NodeDatum["source"], string> = {
  claude: "#6ea8ff", // bright periwinkle blue
  chatgpt: "#f5a35a", // warm amber — complementary to Claude's blue
};

// Luminous theme palette — 14 hues spread evenly around the full color wheel at
// matched saturation/lightness (HSL ~62%/65%), so each cluster reads as its own
// distinct color while still glowing on navy. The order is interleaved (stride 5)
// so consecutive cluster ids land on opposite sides of the wheel — neighbors stay
// far apart in hue. Indexed by cluster id (0..13).
export const THEME_PALETTE: string[] = [
  "#6ea6dd", // blue
  "#dd6e95", // rose
  "#85dd6e", // green
  "#6e76dd", // indigo
  "#dd786e", // coral
  "#6edd86", // green-teal
  "#976edd", // violet
  "#dda86e", // orange
  "#6eddb6", // teal
  "#c56edd", // purple
  "#ddd66e", // yellow
  "#6ed4dd", // cyan
  "#dd6ec5", // magenta
  "#b5dd6e", // yellow-green
];

export const ORPHAN_COLOR = "#8092b4"; // unclustered nodes (cluster === -1)

export function themeColor(clusterId: number): string {
  if (clusterId < 0) return ORPHAN_COLOR;
  return THEME_PALETTE[clusterId % THEME_PALETTE.length];
}
