import { LayerRow, Segmented } from "./ui";
import type { ColorMode, SizeMode } from "./types";

interface Props {
  showEdges: boolean;
  setShowEdges: (v: boolean) => void;
  bridgesOnly: boolean;
  setBridgesOnly: (v: boolean) => void;
  showRegions: boolean;
  setShowRegions: (v: boolean) => void;
  showLabels: boolean;
  setShowLabels: (v: boolean) => void;
  showOrphans: boolean;
  setShowOrphans: (v: boolean) => void;
  colorMode: ColorMode;
  setColorMode: (v: ColorMode) => void;
  sizeMode: SizeMode;
  setSizeMode: (v: SizeMode) => void;
}

export default function LayersPanel(props: Props) {
  return (
    <div className="layers glass">
      <div className="layers-head">Layers</div>

      <LayerRow
        icon="edges"
        label="Edges"
        on={props.showEdges}
        onToggle={() => props.setShowEdges(!props.showEdges)}
      />
      <LayerRow
        icon="bridges"
        label="Bridges"
        on={props.bridgesOnly}
        onToggle={() => props.setBridgesOnly(!props.bridgesOnly)}
      />
      <LayerRow
        icon="regions"
        label="Regions"
        on={props.showRegions}
        onToggle={() => props.setShowRegions(!props.showRegions)}
      />
      <LayerRow
        icon="labels"
        label="Labels"
        on={props.showLabels}
        onToggle={() => props.setShowLabels(!props.showLabels)}
      />
      <LayerRow
        icon="orphans"
        label="Orphans"
        on={props.showOrphans}
        onToggle={() => props.setShowOrphans(!props.showOrphans)}
      />

      <div className="layers-divider" />

      <div className="layers-sub">Color</div>
      <Segmented<ColorMode>
        value={props.colorMode}
        options={[
          { value: "cluster", label: "Theme" },
          { value: "density", label: "Heat" },
          { value: "source", label: "Source" },
        ]}
        onChange={props.setColorMode}
      />

      <div className="layers-sub" style={{ marginTop: 14 }}>
        Node size
      </div>
      <Segmented<SizeMode>
        value={props.sizeMode === "density" ? "density" : "uniform"}
        options={[
          { value: "uniform", label: "Uniform" },
          { value: "density", label: "Density" },
        ]}
        onChange={props.setSizeMode}
      />
    </div>
  );
}
