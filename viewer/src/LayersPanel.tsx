import { LayerRow, Segmented, SourceRow } from "./ui";
import type { ColorMode, Layout, SizeMode, Source } from "./types";
import { SOURCE_COLORS, SOURCE_LABELS } from "./types";

interface Props {
  layout: Layout;
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
  presentSources: Source[];
  hiddenSources: Set<Source>;
  toggleSource: (s: Source) => void;
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
      {props.layout !== "3d" && (
        <LayerRow
          icon="regions"
          label="Regions"
          on={props.showRegions}
          onToggle={() => props.setShowRegions(!props.showRegions)}
        />
      )}
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

      {props.presentSources.length > 0 && (
        <>
          <div className="layers-divider" />
          <div className="layers-sub">Sources</div>
          {props.presentSources.map((s) => (
            <SourceRow
              key={s}
              color={SOURCE_COLORS[s]}
              label={SOURCE_LABELS[s]}
              on={!props.hiddenSources.has(s)}
              onToggle={() => props.toggleSource(s)}
            />
          ))}
        </>
      )}

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
