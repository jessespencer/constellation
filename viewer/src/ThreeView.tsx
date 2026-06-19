import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { computeBloom3D } from "./bloom3d";
import type { MapData, NodeDatum, ColorMode, ResolvedEdge, Source } from "./types";
import { SOURCE_COLORS, DEFAULT_ZOOM } from "./types";
import { heatColor } from "./heat";
import type { Dims } from "./projection";

const INK = new THREE.Color(0x82cdeb); // light cyan edge hairline (echoes the bridge accent, kept faint)
const BRIDGE = new THREE.Color(0x5fdcff); // accent cyan for cross-cluster links
const BASE3D = 3.4; // node base size; minimal glow keeps stars crisp
const HIT_PAD = 10; // px slack around a dot's rendered radius for easier hovering

// once-per-page-load guard for the camera fly-in (re-arms on a full reload)
let threeIntroPlayed = false;

const FIT_MS = 900; // duration of the "fit" re-frame tween
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

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
  hiddenSources: Set<Source>;
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
    edgeList: ResolvedEdge[];
    bridgeList: ResolvedEdge[];
    labelObjs: CSS2DObject[];
    bloom: ReturnType<typeof computeBloom3D>;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    cen: THREE.Vector3;
    fitDist: number;
  } | null>(null);

  // active "fit" tween, consumed by the render loop (null when idle)
  const fitAnim = useRef<{
    t0: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPos: THREE.Vector3;
    toTarget: THREE.Vector3;
    wasAutoRotate: boolean;
  } | null>(null);

  // re-frame the camera to the initial bounding-sphere fit, easing smoothly
  // back out so a zoomed-in viewer isn't snapped across the scene
  useImperativeHandle(ref, () => ({
    fit: () => {
      const a = api.current;
      if (!a) return;
      const toPos = new THREE.Vector3(a.cen.x, a.cen.y, a.cen.z + a.fitDist);
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        a.camera.position.copy(toPos);
        a.controls.target.copy(a.cen);
        a.controls.update();
        return;
      }
      fitAnim.current = {
        t0: performance.now(),
        fromPos: a.camera.position.clone(),
        fromTarget: a.controls.target.clone(),
        toPos,
        toTarget: a.cen.clone(),
        wasAutoRotate: a.controls.autoRotate,
      };
      a.controls.autoRotate = false; // hold the spin until we've settled
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
    // resting distance: 15% tighter than exact fit, matching the 2D default.
    // The Fit button still tweens back to the exact fitDist.
    const restDist = fitDist / DEFAULT_ZOOM;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
    camera.position.set(cen.x, cen.y, cen.z + restDist);

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
    const bridgeEdges = edges.filter((e) => e.bridge);
    const edgesObj = buildLines(edges, INK, 0.1); // cool faint hairlines
    const bridgesObj = buildLines(bridgeEdges, BRIDGE, 0.55);
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

    api.current = { points, geom, edgesObj, bridgesObj, edgeList: edges, bridgeList: bridgeEdges, labelObjs, bloom, camera, controls, cen, fitDist };

    // ---- screen-space hover / click ----
    // Pick the node whose rendered disc actually sits under the cursor. A
    // raycaster's world-space threshold breaks when zoomed in: a node close to
    // the camera subtends a huge screen angle for a fixed world distance, so one
    // dot grabs the whole viewport and the tooltip sticks everywhere. Matching
    // the on-screen dot radius (gl_PointSize, in CSS px) keeps the hit area tied
    // to what's drawn at any zoom.
    const uK = 2 * fitDist; // mirrors the vertex shader's framing constant
    const wv = new THREE.Vector3();
    let hovered = -1;

    function pick(ev: PointerEvent): number {
      const rect = renderer.domElement.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      if (!w || !h) return -1;
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const sizeAttr = geom.getAttribute("size") as THREE.BufferAttribute;
      const alphaAttr = geom.getAttribute("aAlpha") as THREE.BufferAttribute;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (alphaAttr.getX(i) <= 0) continue; // hidden orphan — not drawn
        wv.set(bloom.pos[3 * i], bloom.pos[3 * i + 1], bloom.pos[3 * i + 2]);
        const depth = camera.position.distanceTo(wv);
        wv.project(camera);
        if (wv.z < -1 || wv.z > 1) continue; // behind camera / outside frustum
        const sx = (wv.x * 0.5 + 0.5) * w;
        const sy = (-wv.y * 0.5 + 0.5) * h;
        const d = Math.hypot(sx - cx, sy - cy);
        // rendered CSS radius: gl_PointSize/2 with the pixelRatio factored out
        const r = 0.5 * sizeAttr.getX(i) * (uK / depth) + HIT_PAD;
        if (d <= r && d < bestD) { bestD = d; best = i; }
      }
      return best;
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
    // track pointer-down so an orbit/pan drag doesn't count as a node click
    let downPos: [number, number] = [0, 0];
    function onDown(ev: PointerEvent) {
      downPos = [ev.clientX, ev.clientY];
    }
    function onClick(ev: PointerEvent) {
      const moved = Math.hypot(ev.clientX - downPos[0], ev.clientY - downPos[1]);
      if (moved > 5) return; // dragged to navigate — not a selection
      const idx = pick(ev);
      if (idx >= 0) p.current.onSelect(p.current.data.nodes[idx]);
    }
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
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
    // StrictMode (dev) mounts→unmounts→remounts: the first mount would "consume"
    // the intro on a canvas it then throws away, leaving the surviving mount with
    // nothing to play. Re-arm the flag if we unmount before the intro completes.
    let introDone = !playIntro;
    const introT0 = performance.now();
    const startDist = playIntro ? restDist * 1.28 : restDist;
    camera.position.set(cen.x, cen.y, cen.z + startDist);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      // "fit" tween: ease both the orbit target and the camera back to the
      // bounding-sphere framing. Set the target before controls.update() so the
      // damping/orbit math uses it; override the position after.
      const fa = fitAnim.current;
      const fk = fa ? easeInOutCubic(Math.min(1, (performance.now() - fa.t0) / FIT_MS)) : 0;
      if (fa) controls.target.lerpVectors(fa.fromTarget, fa.toTarget, fk);
      controls.update();
      if (fa) {
        camera.position.lerpVectors(fa.fromPos, fa.toPos, fk);
        if (fk >= 1) {
          controls.autoRotate = fa.wasAutoRotate;
          fitAnim.current = null;
        }
      }
      const e = (performance.now() - introT0) / INTRO_MS;
      if (playIntro && e < 1) {
        const k = 1 - Math.pow(1 - e, 3); // easeOutCubic
        const dist = startDist + (restDist - startDist) * k;
        const dir = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(controls.target).addScaledVector(dir, dist);
      } else if (playIntro) {
        introDone = true;
      }
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
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
      if (!introDone) threeIntroPlayed = false; // re-arm for the surviving remount
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
      const hiddenSource = props.hiddenSources.has(nd.source);
      // alpha 0 also drops the node from pick() (it skips alpha <= 0)
      attr.setX(i, hiddenOrphan || hiddenSource ? 0 : match ? 0.92 : 0.06);
    });
    attr.needsUpdate = true;
  }, [props.query, props.data, props.showOrphans, props.hiddenSources, props.degree]);

  // ---- edges / bridges toggle ------------------------------------------- //
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.edgesObj.visible = props.showEdges && !props.bridgesOnly;
    a.bridgesObj.visible = props.bridgesOnly;
  }, [props.showEdges, props.bridgesOnly]);

  // ---- hide edges touching a hidden source ------------------------------ //
  // Line geometry is built once, so rather than rebuild we rewrite endpoints in
  // place: an edge with a hidden endpoint collapses to a zero-length (invisible)
  // segment; otherwise it gets its real endpoints back from bloom.pos.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const { nodes } = props.data;
    const hidden = props.hiddenSources;
    const rewrite = (obj: THREE.LineSegments, list: ResolvedEdge[]) => {
      const arr = (obj.geometry.getAttribute("position") as THREE.BufferAttribute)
        .array as Float32Array;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const a3 = e.si * 3;
        const b3 = e.ti * 3;
        const off = i * 6;
        if (hidden.has(nodes[e.si].source) || hidden.has(nodes[e.ti].source)) {
          // both endpoints at the source node -> degenerate, draws nothing
          arr[off] = arr[off + 3] = a.bloom.pos[a3];
          arr[off + 1] = arr[off + 4] = a.bloom.pos[a3 + 1];
          arr[off + 2] = arr[off + 5] = a.bloom.pos[a3 + 2];
        } else {
          arr[off] = a.bloom.pos[a3];
          arr[off + 1] = a.bloom.pos[a3 + 1];
          arr[off + 2] = a.bloom.pos[a3 + 2];
          arr[off + 3] = a.bloom.pos[b3];
          arr[off + 4] = a.bloom.pos[b3 + 1];
          arr[off + 5] = a.bloom.pos[b3 + 2];
        }
      }
      (obj.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    };
    rewrite(a.edgesObj, a.edgeList);
    rewrite(a.bridgesObj, a.bridgeList);
  }, [props.hiddenSources, props.data]);

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
