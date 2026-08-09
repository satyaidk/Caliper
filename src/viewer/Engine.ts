import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { disposeObject } from './analyze';
import { setActiveRenderer } from './renderer-registry';
import { CANONICAL, Stage, type ThemeName } from './Stage';
import { Annotations } from './Annotations';
import { Bracket } from './Bracket';
import { circleThrough, snapToFeature, type Snap } from './measure';
import type { MeasurePoint, Measurement, MeasureTool, RenderMode, ViewPreset } from '@/types';

const EDGE_BUDGET = 350_000;
/** Above this many parts, hover picking costs more than it tells you. */
const HOVER_LIMIT = 6000;

export interface SelectionInfo {
  id: number;
  name: string;
  type: string;
  triangles: number;
  vertices: number;
}

export interface FrameInfo {
  fps: number;
  /** Renderer scale, 1 when running at full device resolution. */
  quality: number;
}

/** Screen position for one measurement's readout tag, in CSS pixels. */
export interface LabelAnchor {
  id: number;
  x: number;
  y: number;
  behind: boolean;
}

export interface EngineHooks {
  onSelect(info: SelectionInfo | null): void;
  onHover(name: string | null): void;
  onFrame(info: FrameInfo): void;
  onMeasure(measurements: Measurement[], pending: number): void;
  /** A finished set of points that does not describe anything measurable. */
  onMeasureRejected(reason: string): void;
  onContextChange(lost: boolean): void;
}

type MaybeBase = THREE.Object3D & { userData: { baseMaterial?: THREE.Material | THREE.Material[] } };

/** How many points each tool needs before it produces a measurement. */
const POINTS_NEEDED: Record<Exclude<MeasureTool, 'off'>, number> = {
  distance: 2,
  diameter: 3,
};

/**
 * Why a completed set of points produced nothing. Silence would leave a person
 * clicking three times and watching the tool reset with no idea what it wanted.
 */
const REJECTION: Record<Exclude<MeasureTool, 'off'>, string> = {
  distance: 'Both points landed in the same spot, so there is no distance between them.',
  diameter:
    'Those three points sit in a straight line, so no circle passes through them. Spread them around the arc.',
};

/** Points closer together than this are the same point as far as a tool cares. */
const COINCIDENT = 1e-7;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private readonly modelGroup = new THREE.Group();
  private readonly edgeGroup = new THREE.Group();
  private readonly stage: Stage;
  private readonly annotations = new Annotations();
  /** Wraps the loaded object so normalisation never fights the file's own transform. */
  private holder: THREE.Group | null = null;

  private selectionMark!: Bracket;
  private hoverMark!: Bracket;
  private selectedNode: THREE.Object3D | null = null;

  private modelRadius = CANONICAL / 2;
  private meshCount = 0;
  private gridWanted = true;

  private renderMode: RenderMode = 'shaded';
  private overrideMaterial: THREE.Material | null = null;
  /** Shared by every outline in the overlay, so clearEdges owns disposing it. */
  private edgeMaterial: THREE.LineBasicMaterial | null = null;
  private edgesComplete = true;

  /* --- measuring --------------------------------------------------------- */
  private tool: MeasureTool = 'off';
  private measurements: Measurement[] = [];
  private pending: THREE.Vector3[] = [];
  private snap: Snap | null = null;
  private measureSeq = 0;
  private labelSink: ((anchors: LabelAnchor[]) => void) | null = null;

  /* --- loop -------------------------------------------------------------- */
  private raf = 0;
  private needsRender = true;
  private rendered = 0;
  private lastSample = performance.now();
  private readonly clock = new THREE.Clock();
  private disposed = false;
  private contextLost = false;
  private paused = false;
  private quality = 1;
  private slowSamples = 0;
  private fastSamples = 0;
  private lastMotion = 0;
  private readonly maxPixelRatio = Math.min(window.devicePixelRatio, 2);

  private readonly pointer = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number } | null = null;
  private hoverQueued = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: EngineHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 4000);
    this.camera.position.set(9, 6.5, 11);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.maxDistance = 900;
    this.controls.minDistance = 0.05;

    setActiveRenderer(this.renderer);

    this.stage = new Stage(this.scene, this.renderer);
    this.scene.add(this.modelGroup, this.edgeGroup, this.stage.group, this.annotations.group);
    this.buildMarkers();
    this.bindPointer();
    this.bindContextLoss();

    this.animate = this.animate.bind(this);
    this.raf = requestAnimationFrame(this.animate);
  }

  /* ------------------------------------------------------------ setup ---- */

  private buildMarkers() {
    const skin = this.stage.skin;
    this.selectionMark = new Bracket(skin.mark, 1);
    this.hoverMark = new Bracket(skin.ghost, 0.45);
    this.scene.add(this.selectionMark.group, this.hoverMark.group);
    this.annotations.setColour(skin.mark);
  }

  private bindContextLoss() {
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.hooks.onContextChange(true);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.renderer.resetState();
      this.resize();
      this.invalidate();
      this.hooks.onContextChange(false);
    });
  }

  private bindPointer() {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY };
    });

    this.canvas.addEventListener('pointerup', (event) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(
        event.clientX - this.pointerDown.x,
        event.clientY - this.pointerDown.y,
      );
      this.pointerDown = null;
      if (moved > 5) return; // an orbit, not a click
      if (this.tool === 'off') this.pick(event);
      else this.placePoint(event);
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (this.hoverQueued) return;
      this.hoverQueued = true;
      requestAnimationFrame(() => {
        this.hoverQueued = false;
        if (this.tool === 'off') this.trackHover(event);
        else this.trackSnap(event);
      });
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (this.snap) {
        this.snap = null;
        this.annotations.invalidate();
        this.invalidate();
      }
      this.setHover(null);
    });
  }

  /* ------------------------------------------------------------- loop ---- */

  /** Ask for one more frame. Everything that changes the picture calls this. */
  invalidate() {
    this.needsRender = true;
  }

  /**
   * Held while a modal overlay covers the viewport. Drawing behind a dialog
   * costs a full frame each time and nobody can see it.
   */
  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) this.invalidate();
  }

  private animate() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    if (this.contextLost || this.paused) return;

    if (this.controls.update(this.clock.getDelta())) {
      this.needsRender = true;
      this.lastMotion = performance.now();
    }

    this.sample();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderFrame();
    this.rendered++;
  }

  private renderFrame() {
    if (this.tool !== 'off' || this.measurements.length || this.pending.length) {
      this.annotations.update(this.camera, this.measurements, this.pending, this.snap);
    }
    this.renderer.render(this.scene, this.camera);
    this.publishLabels();
  }

  /**
   * Frame timing, and the quality governor that rides on it. A model that drops
   * below 30 fps gets rendered at a lower device scale rather than staying
   * beautiful and unusable; it climbs back the moment there is headroom.
   */
  private sample() {
    const now = performance.now();
    const elapsed = now - this.lastSample;
    if (elapsed < 500) return;

    const fps = Math.round((this.rendered * 1000) / elapsed);
    // Only judge performance while the camera is actually moving. A viewer
    // sitting still renders nothing and would otherwise read as 0 fps and get
    // its resolution cut for standing there quietly.
    const busy = this.rendered > 0 && now - this.lastMotion < 1200;

    if (busy && fps < 30 && this.quality > 0.55) {
      if (++this.slowSamples >= 2) {
        this.slowSamples = 0;
        this.setQuality(this.quality - 0.2);
      }
    } else if (busy && fps > 55 && this.quality < 1) {
      if (++this.fastSamples >= 4) {
        this.fastSamples = 0;
        this.setQuality(this.quality + 0.2);
      }
    } else {
      this.slowSamples = 0;
      this.fastSamples = 0;
    }

    this.hooks.onFrame({ fps: this.rendered ? fps : 0, quality: this.quality });
    this.rendered = 0;
    this.lastSample = now;
  }

  private setQuality(value: number) {
    this.quality = THREE.MathUtils.clamp(Number(value.toFixed(2)), 0.5, 1);
    this.renderer.setPixelRatio(this.maxPixelRatio * this.quality);
    this.resize();
  }

  /* ------------------------------------------------------------ model ---- */

  setModel(object: THREE.Object3D, hasAuthoredMaterials: boolean) {
    this.clearModel();

    // The loaded root keeps whatever transform its format gave it. All framing
    // happens on a wrapper, so a file that places its geometry far from the
    // origin still lands centred on the plate.
    const holder = new THREE.Group();
    holder.name = '__caliper_holder';
    holder.add(object);

    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = CANONICAL / (size.length() || 1);

    holder.scale.setScalar(scale);
    holder.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    holder.updateMatrixWorld(true);

    this.holder = holder;
    this.modelGroup.add(holder);
    this.modelRadius = CANONICAL / 2;
    this.annotations.setScaleHint(this.modelRadius);

    this.meshCount = 0;
    const castShadows = this.stage.shadowsEnabled;
    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshCount++;
      // Honour the shadow toggle the person already set, rather than forcing
      // shadows back on with every file they open.
      mesh.castShadow = castShadows;
      mesh.receiveShadow = castShadows;
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
      if (!hasAuthoredMaterials) this.dressDefault(mesh);
    });

    this.syncStage();
    this.applyRenderMode();
    this.frameAll(true);
  }

  /** A neutral surface for formats that carry no materials of their own. */
  private dressDefault(mesh: THREE.Mesh) {
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.isMeshStandardMaterial && !standard.vertexColors) {
        standard.color.set('#b8c3d4');
        standard.metalness = 0.12;
        standard.roughness = 0.45;
      }
    }
  }

  clearModel() {
    for (const child of [...this.modelGroup.children]) {
      this.modelGroup.remove(child);
      disposeObject(child);
    }
    this.clearEdges();
    this.overrideMaterial?.dispose();
    this.overrideMaterial = null;
    this.holder = null;
    this.meshCount = 0;
    this.selectionMark.hide();
    this.hoverMark.hide();
    this.selectedNode = null;
    this.clearMeasurements();
    this.syncStage();
    this.hooks.onSelect(null);
    this.hooks.onHover(null);
    this.invalidate();
  }

  /** The object the loader produced, without Caliper's framing wrapper. */
  get modelRoot(): THREE.Object3D | null {
    return this.holder?.children[0] ?? null;
  }

  /** True when the outline pass had to stop short of drawing every edge. */
  get edgesTruncated() {
    return !this.edgesComplete;
  }

  get hoverEnabled() {
    return this.meshCount > 0 && this.meshCount <= HOVER_LIMIT;
  }

  /* ------------------------------------------------------- appearance ---- */

  setRenderMode(mode: RenderMode) {
    this.renderMode = mode;
    this.applyRenderMode();
  }

  /**
   * Render modes swap the material on the model's own meshes. The obvious route
   * — scene.overrideMaterial — also repaints the plate, the grid and the
   * selection marker, which turns "show me the wireframe" into "show me
   * everything as wireframe" and loses the stage entirely.
   */
  private applyRenderMode() {
    this.assignOverride(null);
    this.overrideMaterial?.dispose();
    this.overrideMaterial = null;
    this.clearEdges();

    if (this.renderMode === 'wireframe') {
      this.overrideMaterial = new THREE.MeshBasicMaterial({
        color: 0x8fb6f0,
        wireframe: true,
        transparent: true,
        opacity: 0.75,
      });
      this.assignOverride(this.overrideMaterial);
    } else if (this.renderMode === 'edges') {
      this.buildEdges();
    }

    this.invalidate();
  }

  /** Swaps in `material` across the model, or puts every original back. */
  private assignOverride(material: THREE.Material | null) {
    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return; // point clouds keep their own material
      const holder = node as MaybeBase;
      if (material) {
        if (!holder.userData.baseMaterial) holder.userData.baseMaterial = mesh.material;
        mesh.material = material;
      } else if (holder.userData.baseMaterial) {
        mesh.material = holder.userData.baseMaterial;
        delete holder.userData.baseMaterial;
      }
    });
  }

  private buildEdges() {
    let budget = EDGE_BUDGET;
    const skin = this.stage.skin;
    const material = new THREE.LineBasicMaterial({
      color: skin.edgeInk,
      transparent: true,
      opacity: skin.edgeOpacity,
    });
    this.edgeMaterial = material;
    this.edgesComplete = true;

    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || budget <= 0) return;
      const index = mesh.geometry.getIndex();
      const position = mesh.geometry.getAttribute('position');
      if (!position) return;
      budget -= (index ? index.count : position.count) / 3;
      if (budget <= 0) {
        this.edgesComplete = false;
        return;
      }

      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 32), material);
      mesh.updateWorldMatrix(true, false);
      lines.applyMatrix4(mesh.matrixWorld);
      this.edgeGroup.add(lines);
    });
  }

  private clearEdges() {
    for (const child of [...this.edgeGroup.children]) {
      this.edgeGroup.remove(child);
      (child as THREE.LineSegments).geometry.dispose();
    }
    this.edgeMaterial?.dispose();
    this.edgeMaterial = null;
    this.edgesComplete = true;
  }

  setGridVisible(visible: boolean) {
    this.gridWanted = visible;
    this.syncStage();
  }

  /**
   * An empty plate with a grid on it is a stage set for a play that has not
   * started. With no model open the backdrop is left clean, and the stage comes
   * back the moment there is something to stand on it.
   */
  private syncStage() {
    this.stage.setGridVisible(this.gridWanted && this.modelGroup.children.length > 0);
    this.invalidate();
  }

  setShadowsEnabled(enabled: boolean) {
    this.renderer.shadowMap.enabled = enabled;
    this.stage.setShadowsEnabled(enabled);
    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    });
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  }

  setTheme(theme: ThemeName) {
    this.stage.setTheme(theme);
    const skin = this.stage.skin;

    this.selectionMark.setColour(skin.mark);
    this.hoverMark.setColour(skin.ghost);
    this.annotations.setColour(skin.mark);

    if (this.renderMode === 'edges') {
      this.clearEdges();
      this.buildEdges();
    }
    this.invalidate();
  }

  /* ----------------------------------------------------------- camera ---- */

  private boundsOf(target?: THREE.Object3D): THREE.Box3 {
    const source = target ?? (this.modelGroup.children.length ? this.modelGroup : this.stage.group);
    return new THREE.Box3().setFromObject(source);
  }

  private frameBox(box: THREE.Box3, direction?: THREE.Vector3) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.001);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.08;

    const heading =
      direction ??
      new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (heading.lengthSq() < 1e-6) heading.set(0.72, 0.48, 0.9).normalize();

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(heading, distance);
    this.camera.near = Math.max(radius / 800, 0.005);
    this.camera.far = radius * 400;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  frameAll(instant = false) {
    this.frameBox(
      this.boundsOf(),
      instant ? new THREE.Vector3(0.72, 0.48, 0.9).normalize() : undefined,
    );
  }

  /** Zoom to the selected part — the move a person reaches for constantly. */
  frameSelection(id: number) {
    const node = this.scene.getObjectById(id);
    if (node) this.frameBox(this.boundsOf(node));
  }

  setView(preset: ViewPreset) {
    const directions: Record<ViewPreset, [number, number, number]> = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      top: [0, 1, 0.0001],
      bottom: [0, -1, 0.0001],
      iso: [0.72, 0.48, 0.9],
    };
    this.camera.up.set(0, 1, 0);
    this.frameBox(this.boundsOf(), new THREE.Vector3(...directions[preset]).normalize());
  }

  /**
   * The camera's world rotation. The orientation gizmo needs it to project the
   * world axes into its own little viewport, which is the only way that widget
   * can tell you which way you are actually facing.
   */
  viewQuaternion(target = new THREE.Quaternion()): THREE.Quaternion {
    return this.camera.getWorldQuaternion(target);
  }

  /* -------------------------------------------------------- selection ---- */

  private rayFrom(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return { rect, cursor: { x: event.clientX - rect.left, y: event.clientY - rect.top } };
  }

  private hit(event: PointerEvent): THREE.Intersection | null {
    this.rayFrom(event);
    const hits = this.raycaster.intersectObjects(this.modelGroup.children, true);
    return hits.find((candidate) => candidate.object.visible) ?? null;
  }

  private pick(event: PointerEvent) {
    const hit = this.hit(event);
    this.select(hit ? hit.object : null);
  }

  private trackHover(event: PointerEvent) {
    if (!this.hoverEnabled) return;
    const hit = this.hit(event);
    this.setHover(hit ? hit.object : null);
  }

  private setHover(node: THREE.Object3D | null) {
    if (!node) {
      if (this.hoverMark.visible) {
        this.hoverMark.hide();
        this.hooks.onHover(null);
        this.invalidate();
      }
      return;
    }
    // Hovering the part you already have selected adds nothing but noise.
    if (node === this.selectedNode) {
      this.hoverMark.hide();
      this.hooks.onHover(null);
      return;
    }
    this.hoverMark.show(node);
    this.hooks.onHover(node.name || node.type);
    this.invalidate();
  }

  select(target: THREE.Object3D | number | null) {
    const node = typeof target === 'number' ? (this.scene.getObjectById(target) ?? null) : target;

    this.selectedNode = node;
    if (!node) {
      this.selectionMark.hide();
      this.hooks.onSelect(null);
      this.invalidate();
      return;
    }

    this.selectionMark.show(node);
    this.invalidate();

    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute?.('position');
    const index = geometry?.getIndex?.();

    this.hooks.onSelect({
      id: node.id,
      name: node.name || node.type,
      type: node.type,
      triangles: position ? Math.round((index ? index.count : position.count) / 3) : 0,
      vertices: position?.count ?? 0,
    });
  }

  /* ------------------------------------------------------- measuring ---- */

  setMeasureTool(tool: MeasureTool) {
    this.tool = tool;
    this.pending = [];
    this.snap = null;
    this.annotations.invalidate();
    this.hooks.onMeasure(this.measurements, 0);
    this.invalidate();
  }

  get measureTool() {
    return this.tool;
  }

  private trackSnap(event: PointerEvent) {
    const { cursor, rect } = this.rayFrom(event);
    const hits = this.raycaster.intersectObjects(this.modelGroup.children, true);
    const hit = hits.find((candidate) => candidate.object.visible);

    this.snap = hit ? snapToFeature(hit, this.camera, cursor, rect.width, rect.height) : null;
    this.annotations.invalidate();
    this.invalidate();
  }

  private placePoint(event: PointerEvent) {
    this.trackSnap(event);
    if (!this.snap || this.tool === 'off') return;

    this.pending.push(this.snap.point.clone());
    const needed = POINTS_NEEDED[this.tool];
    if (this.pending.length < needed) {
      this.hooks.onMeasure(this.measurements, this.pending.length);
      this.annotations.invalidate();
      this.invalidate();
      return;
    }

    const measurement = this.buildMeasurement(this.tool, this.pending);
    const tool = this.tool;
    this.pending = [];
    if (measurement) this.measurements = [...this.measurements, measurement];
    else this.hooks.onMeasureRejected(REJECTION[tool]);
    this.hooks.onMeasure(this.measurements, 0);
    this.annotations.invalidate();
    this.invalidate();
  }

  /**
   * World space is the canonical 8-unit stage; the file's own numbers are what
   * a person came here for. Both are kept — one to draw with, one to read.
   */
  private toModel(world: THREE.Vector3): THREE.Vector3 {
    if (!this.holder) return world.clone();
    return this.holder.worldToLocal(world.clone());
  }

  private buildMeasurement(
    tool: Exclude<MeasureTool, 'off'>,
    world: THREE.Vector3[],
  ): Measurement | null {
    const model = world.map((point) => this.toModel(point));
    const points: MeasurePoint[] = world.map((point, i) => ({
      world: [point.x, point.y, point.z],
      model: [model[i].x, model[i].y, model[i].z],
      kind: this.snap?.kind ?? 'surface',
    }));

    const id = ++this.measureSeq;
    if (tool === 'distance') {
      const delta = model[1].clone().sub(model[0]);
      if (delta.lengthSq() < COINCIDENT) return null;
      return {
        id,
        tool,
        points,
        value: delta.length(),
        delta: [Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)],
      };
    }

    const circle = circleThrough(model[0], model[1], model[2]);
    if (!circle) return null;
    return { id, tool, points, value: circle.radius * 2 };
  }

  undoMeasurePoint() {
    if (this.pending.length) this.pending.pop();
    else this.measurements = this.measurements.slice(0, -1);
    this.hooks.onMeasure(this.measurements, this.pending.length);
    this.annotations.invalidate();
    this.invalidate();
  }

  removeMeasurement(id: number) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.hooks.onMeasure(this.measurements, this.pending.length);
    this.annotations.invalidate();
    this.invalidate();
  }

  clearMeasurements() {
    this.measurements = [];
    this.pending = [];
    this.snap = null;
    this.annotations.clear();
    this.hooks.onMeasure([], 0);
    this.invalidate();
  }

  setLabelSink(sink: ((anchors: LabelAnchor[]) => void) | null) {
    this.labelSink = sink;
  }

  /** Projects each measurement's tag position into CSS pixels for the overlay. */
  private publishLabels() {
    if (!this.labelSink) return;
    if (!this.measurements.length) {
      this.labelSink([]);
      return;
    }

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const anchor = new THREE.Vector3();

    const anchors = this.measurements.map((measurement) => {
      const points = measurement.points.map((p) => new THREE.Vector3(...p.world));
      if (measurement.tool === 'distance') {
        anchor.copy(points[0]).add(points[1]).multiplyScalar(0.5);
      } else {
        anchor.copy(circleThrough(points[0], points[1], points[2])?.centre ?? points[0]);
      }

      anchor.project(this.camera);
      return {
        id: measurement.id,
        x: (anchor.x * 0.5 + 0.5) * width,
        y: (-anchor.y * 0.5 + 0.5) * height,
        behind: anchor.z > 1,
      };
    });

    this.labelSink(anchors);
  }

  /* ------------------------------------------------------------ output --- */

  /**
   * Renders one frame at a higher device scale and reads it straight back. The
   * backdrop is painted in for the capture so the PNG matches the viewport
   * rather than arriving with a hole where the gradient was.
   */
  screenshot(scale = 2): string {
    const { width, height } = this.renderer.getSize(new THREE.Vector2());
    const ratio = this.renderer.getPixelRatio();
    const background = this.scene.background;

    this.scene.background = this.backdropTexture();
    this.renderer.setPixelRatio(Math.min(this.maxPixelRatio * scale, 4));
    this.renderer.setSize(width, height, false);
    this.renderFrame();

    const url = this.canvas.toDataURL('image/png');

    this.scene.background = background;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.invalidate();
    return url;
  }

  /** The same vertical fall-off the CSS backdrop paints, as a texture. */
  private backdropTexture(): THREE.Texture {
    const styles = getComputedStyle(document.documentElement);
    const top = styles.getPropertyValue('--stage-top').trim() || '#3c3f46';
    const bottom = styles.getPropertyValue('--stage-bottom').trim() || '#24262b';

    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4, 256);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /* ------------------------------------------------------------- loop ---- */

  resize() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.annotations.setResolution(buffer.x, buffer.y);
    this.annotations.invalidate();
    this.invalidate();
  }

  dispose() {
    this.disposed = true;
    setActiveRenderer(null);
    cancelAnimationFrame(this.raf);
    this.labelSink = null;
    this.clearModel();
    this.controls.dispose();
    this.annotations.dispose();
    this.stage.dispose();
    this.selectionMark.dispose();
    this.hoverMark.dispose();
    this.renderer.dispose();
  }
}
