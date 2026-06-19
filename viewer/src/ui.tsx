// Small shared UI primitives: inline Tabler outline icons, a toggle switch row,
// and a segmented control — all styled by the night-sky tokens in styles.css.

export type IconName =
  | "search"
  | "edges"
  | "bridges"
  | "regions"
  | "labels"
  | "orphans"
  | "fit"
  | "info"
  | "close";

const PATHS: Record<IconName, JSX.Element> = {
  // ti-search
  search: (
    <>
      <path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
      <path d="M21 21l-6 -6" />
    </>
  ),
  // ti-line — two stars joined
  edges: (
    <>
      <path d="M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M7.5 16.5l9 -9" />
    </>
  ),
  // ti-route — cross-cluster links
  bridges: (
    <>
      <path d="M6 19m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      <path d="M18 5m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      <path d="M6 16v-6a3 3 0 0 1 3 -3h6" />
    </>
  ),
  // ti-hexagon — soft region hull
  regions: (
    <path d="M19.875 6.27c.7 .398 1.125 1.116 1.125 1.889v7.682a2.2 2.2 0 0 1 -1.125 1.889l-7.5 4.219a2.3 2.3 0 0 1 -2.25 0l-7.5 -4.219a2.2 2.2 0 0 1 -1.125 -1.889v-7.682a2.2 2.2 0 0 1 1.125 -1.889l7.5 -4.219a2.3 2.3 0 0 1 2.25 0z" />
  ),
  // ti-tag — cluster labels
  labels: (
    <>
      <path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z" />
    </>
  ),
  // lone star + faint companions
  orphans: (
    <>
      <path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      <path d="M19 5l0 .01" />
      <path d="M5 18l0 .01" />
    </>
  ),
  // ti-maximize — frame the whole view
  fit: (
    <>
      <path d="M4 8v-2a2 2 0 0 1 2 -2h2" />
      <path d="M4 16v2a2 2 0 0 0 2 2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M16 20h2a2 2 0 0 0 2 -2v-2" />
    </>
  ),
  // ti-info-circle — open the control guide
  info: (
    <>
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
      <path d="M12 9h.01" />
      <path d="M11 12h1v4h1" />
    </>
  ),
  // ti-x — close the guide
  close: (
    <>
      <path d="M18 6l-12 12" />
      <path d="M6 6l12 12" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function LayerRow({
  icon,
  label,
  on,
  onToggle,
}: {
  icon: IconName;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`layer-row${on ? " active" : ""}`}
      onClick={onToggle}
      role="switch"
      aria-checked={on}
    >
      <Icon name={icon} />
      <span className="layer-label">{label}</span>
      <span className={`switch${on ? " on" : ""}`} />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
