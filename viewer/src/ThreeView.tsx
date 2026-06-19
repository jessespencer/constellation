import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { computeBloom3D } from "./bloom3d";
import type { MapData, NodeDatum, ColorMode, ResolvedEdge } from "./types";
import { SOURCE_COLORS } from "./types";
import { heatColor } from "./heat";
import type { Dims } from "./projection";

const INK = new THREE.Color(0x82cdeb); // light cyan edge hairline (echoes the bridge accent, kept faint)
const BRIDGE = new THREE.Color(0x5fdcff); // accent cyan for cross-cluster links
const BASE3D = 3.4; // node base size; minimal glow keeps stars crisp

// once-per-page-load guard for the camera fly-in (re-arms on a full reload)
let threeIntroPlayed = false;

interface Props {
  data: MapData;
  dims: Dims;
  degree: number[];
  edges: ResolvedEdge[];
  clusterColor: Map<number, string>;
  colorMode: ColorMode;
  nodeScale: Float32Array;
  heat: Float32Array;
  query: string;
  showEdges: boolean;
  bridgesOnly: boolean;
  showLabels: boolean;
  showOrphans: boolean;
  onHover: (node: NodeDatum | null, screen: [number, number]) => void;
  onSelect: (node: NodeDatum) => void;
}

const vert = `
  uniform float uPixelRatio;
  uniform float uK;            // 2 * framing distance -> matches 2D dot size
  attribute vec3 aColor;
  attribute float size;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * uPixelRatio * (uK / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const frag = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c) * 2.0;          // 0 center -> 1 edge
    if (r > 1.0) discard;
    float glow = pow(1.0 - r, 3.2);     // tight radial falloff (minimal halo)
    float core = smoothstep(0.45, 0.0, r); // crisp star core
    vec3 col = mix(vColor, vec3(1.0), core * 0.4);
    gl_FragColor = vec4(col, vAlpha * (glow * 0.4 + core * 0.7));
  }
`;

export interface ThreeViewHandle {
  fit: () => void;
}

const ThreeView = forwardRef<ThreeViewHandle, Props>(function ThreeView(props, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  // hold the latest props for callbacks inside the animation loop
  const p = useRef(props);
  p.current = props;
  const api = useRef<{
    points: THREE.Points;
    geom: THREE.BufferGeometry;
    edgesObj: THREE.LineSegments;
    bridgesObj: THREE.LineSegments;
    labelObjs: CSS2DObject[];
    bloom: ReturnType<typeof computeBloom3D>;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    cen: THREE.Vector3;
    fitDist: number;
  } | null>(null);

  // re-frame the camera to the initial bounding-sphere fit
  useImperativeHandle(ref, () => ({
    fit: () => {
      const a = api.current;
      if (!a) return;
      a.camera.position.set(a.cen.x, a.cen.y, a.cen.z + a.fitDist);
      a.controls.target.copy(a.cen);
      a.controls.update();
    },
  }), []);

  // ---- build the scene once per data load ------------------------------- //
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const { data, degree, edges } = p.current;
    const n = data.nodes.length;
    const bloom = computeBloom3D(data, degree);

    // Frame the geometric bounding box (points + label anchors). Big themes get
    // longer tufts, so the box is mildly shifted off origin; centering on it
    // fills the viewport evenly. Distance auto-fits the bounding sphere so the
    // whole structure stays framed as it rotates.
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const acc = (x: number, y: number, z: number) => {
      lo.x = Math.min(lo.x, x); lo.y = Math.min(lo.y, y); lo.z = Math.min(lo.z, z);
      hi.x = Math.max(hi.x, x); hi.y = Math.max(hi.y, y); hi.z = Math.max(hi.z, z);
    };
    for (let i = 0; i < n; i++) acc(bloom.pos[3 * i], bloom.pos[3 * i + 1], bloom.pos[3 * i + 2]);
    bloom.labelPos.forEach(([x, y, z]) => acc(x, y, z));

    const cen = new THREE.Vector3().addVectors(lo, hi).multiplyScalar(0.5);
    // true bounding-sphere radius (silhouette), not the box diagonal
    let radius = 1;
    const grow = (x: number, y: number, z: number) =>
      (radius = Math.max(radius, Math.hypot(x - cen.x, y - cen.y, z - cen.z)));
    for (let i = 0; i < n; i++) grow(bloom.pos[3 * i], bloom.pos[3 * i + 1], bloom.pos[3 * i + 2]);
    bloom.labelPos.forEach(([x, y, z]) => grow(x, y, z));
    const FOV = 50;
    const fitDist = (radius / Math.sin((FOV / 2) * (Math.PI / 180))) * 1.04;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
    camera.position.set(cen.x, cen.y, cen.z + fitDist);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0); // transparent -> the stage's atlas gradient shows
    mount.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    mount.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(cen);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.minDistance = 60;
    controls.maxDistance = 600;

    // points
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(bloom.pos, 3));
    geom.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const sizeArr = new Float32Array(n);
    for (let i = 0; i < n; i++) sizeArr[i] = BASE3D * (p.current.nodeScale[i] || 1);
    geom.setAttribute("size", new THREE.BufferAttribute(sizeArr, 1));
    geom.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(n).fill(0.85), 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending, // overlapping stars bloom into bright patches
      uniforms: {
        uPixelRatio: { value: renderer.getPixelRatio() },
        uK: { value: 2 * fitDist }, // matches 2D dot size at the framing plane
      },
    });
    const points = new THREE.Points(geom, mat);
    scene.add(points);

    // edge geometry helper
    function buildLines(list: ResolvedEdge[], color: THREE.Color, opacity: number) {
      const g = new THREE.BufferGeometry();
      const arr = new Float32Array(list.length * 6);
      for (let i = 0; i < list.length; i++) {
        const a = list[i].si * 3;
        const b = list[i].ti * 3;
        arr.set([bloom.pos[a], bloom.pos[a + 1], bloom.pos[a + 2]], i * 6);
        arr.set([bloom.pos[b], bloom.pos[b + 1], bloom.pos[b + 2]], i * 6 + 3);
      }
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const m = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      return new THREE.LineSegments(g, m);
    }
    const edgesObj = buildLines(edges, INK, 0.1); // cool faint hairlines
    const bridgesObj = buildLines(edges.filter((e) => e.bridge), BRIDGE, 0.55);
    bridgesObj.visible = false;
    scene.add(edgesObj);
    scene.add(bridgesObj);

    // floating theme labels
    const labelObjs: CSS2DObject[] = [];
    for (const c of data.clusters) {
      if (c.id === -1) continue;
      const anchor = bloom.labelPos.get(c.id);
      if (!anchor) continue;
      const el = document.createElement("div");
      el.className = "three-label";
      el.textContent = c.label;
      // uniform category-heading size, matching the 2D map/constellation labels
      el.style.fontSize = "12px";
      const obj = new CSS2DObject(el);
      obj.position.set(anchor[0], anchor[1], anchor[2]);
      scene.add(obj);
      labelObjs.push(obj);
    }

    api.current = { points, geom, edgesObj, bridgesObj, labelObjs, bloom, camera, controls, cen, fitDist };

    // ---- raycast hover / click ----
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points!.threshold = 2.6;
    const ndc = new THREE.Vector2();
    let hovered = -1;

    function pick(ev: PointerEvent): number {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(points);
      return hits.length ? (hits[0].index ?? -1) : -1;
    }
    function onMove(ev: PointerEvent) {
      const idx = pick(ev);
      if (idx !== hovered) {
        hovered = idx;
        controls.autoRotate = idx < 0; // pause spin while inspecting
      }
      const rect = mount!.getBoundingClientRect();
      p.current.onHover(
        idx >= 0 ? p.current.data.nodes[idx] : null,
        [ev.clientX - rect.left, ev.clientY - rect.top]
      );
      renderer.domElement.style.cursor = idx >= 0 ? "pointer" : "grab";
    }
    function onClick(ev: PointerEvent) {
      const idx = pick(ev);
      if (idx >= 0) p.current.onSelect(p.current.data.nodes[idx]);
    }
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);

    // ---- resize ----
    function resize() {
      const { width, height } = p.current.dims;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      labelRenderer.setSize(width, height);
    }
    resize();
    window.addEventListener("resize", resize);

    // intro (first page load only): ease the camera in from just a touch further
    // out, so the constellation settles gently into frame rather than rushing the
    // viewer. Kept subtle ("slight") since this is the first thing the site shows.
    const INTRO_MS = 1800;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const playIntro = !threeIntroPlayed && !reduceMotion;
    if (playIntro) threeIntroPlayed = true;
    const introT0 = performance.now();
    const startDist = playIntro ? fitDist * 1.28 : fitDist;
    camera.position.set(cen.x, cen.y, cen.z + startDist);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      const e = (performance.now() - introT0) / INTRO_MS;
      if (playIntro && e < 1) {
        const k = 1 - Math.pow(1 - e, 3); // easeOutCubic
        const dist = startDist + (fitDist - startDist) * k;
        const dir = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(controls.target).addScaledVector(dir, dist);
      }
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      geom.dispose();
      mat.dispose();
      edgesObj.geometry.dispose();
      bridgesObj.geometry.dispose();
      (edgesObj.material as THREE.Material).dispose();
      (bridgesObj.material as THREE.Material).dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      mount.removeChild(labelRenderer.domElement);
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data]);

  // ---- colors (cluster vs source) --------------------------------------- //
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const { data, clusterColor, colorMode, heat } = props;
    const attr = a.geom.getAttribute("aColor") as THREE.BufferAttribute;
    const col = new THREE.Color();
    data.nodes.forEach((nd, i) => {
      const hex =
        colorMode === "density"
          ? heatColor(heat[i] || 0)
          : colorMode === "source"
          ? SOURCE_COLORS[nd.source]
          : clusterColor.get(nd.cluster) ?? "#c8c2b6";
      col.set(hex);
      attr.setXYZ(i, col.r, col.g, col.b);
    });
    attr.needsUpdate = true;
  }, [props.colorMode, props.clusterColor, props.data, props.heat]);

  // ---- size-by metric --------------------------------------------------- //
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const attr = a.geom.getAttribute("size") as THREE.BufferAttribute;
    const isHeat = props.colorMode === "density";
    for (let i = 0; i < props.nodeScale.length; i++) {
      // in density mode, dense cores bloom larger; sparse stay small points
      const heatScale = isHeat ? 0.7 + (props.heat[i] || 0) * 1.1 : 1;
      attr.setX(i, BASE3D * (props.nodeScale[i] || 1) * heatScale);
    }
    attr.needsUpdate = true;
  }, [props.nodeScale, props.colorMode, props.heat]);

  // ---- search dim + orphan hiding --------------------------------------- //
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const attr = a.geom.getAttribute("aAlpha") as THREE.BufferAttribute;
    const q = props.query.trim().toLowerCase();
    props.data.nodes.forEach((nd, i) => {
      const match = !q || nd.title.toLowerCase().includes(q);
      // Orphan = no edges cleared the similarity threshold (the pipeline still
      // assigns every node a theme cluster, so cluster === -1 is never set).
      const hiddenOrphan = !props.showOrphans && (props.degree[i] || 0) === 0;
      attr.setX(i, hiddenOrphan ? 0 : match ? 0.92 : 0.06);
    });
    attr.needsUpdate = true;
  }, [props.query, props.data, props.showOrphans, props.degree]);

  // ---- edges / bridges toggle ------------------------------------------- //
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.edgesObj.visible = props.showEdges && !props.bridgesOnly;
    a.bridgesObj.visible = props.bridgesOnly;
  }, [props.showEdges, props.bridgesOnly]);

  // ---- labels toggle ---------------------------------------------------- //
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.labelObjs.forEach((o) => (o.visible = props.showLabels));
  }, [props.showLabels]);

  // ---- resize on dims change ------------------------------------------- //
  useEffect(() => {
    // handled inside the loop's closure via p.current; trigger a one-off
    const a = api.current;
    if (!a) return;
    window.dispatchEvent(new Event("resize"));
  }, [props.dims]);

  return <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />;
});

export default ThreeView;
