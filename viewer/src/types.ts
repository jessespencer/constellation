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

export type ColorMode = "cluster" | "source";

export const SOURCE_COLORS: Record<NodeDatum["source"], string> = {
  claude: "#b07a4a", // warm ochre
  chatgpt: "#4a7a85", // muted teal
};
