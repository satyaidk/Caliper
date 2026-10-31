import * as THREE from 'three';
import { disposeObject } from './analyze';
import { setActiveRenderer } from './renderer-registry';
import { CANONICAL, Stage, type PlateSpec, type ThemeName } from './Stage';
import { Annotations } from './Annotations';
import { Bracket } from './Bracket';
import { CameraRig, VIEW_DIRECTIONS } from './CameraRig';
import { Section } from './Section';
import { Explode } from './Explode';
import { angleAt, circleThrough, snapToFeature, type Snap } from './measure';
import {
  capColour,
  filamentMaterial,
  overhangMaterial,
  surfaceAngleMaterial,
  wireMaterial,
  type OverhangMaterial,
} from './materials';
import { meshTriangles } from './triangles';
import { analyse, overhangArea, OVERHANG_DEFAULT, type Vec3 } from './printability';
import { nearestRestingFace, restingFaces, type RestingFace } from './orient';
import { sliceContours } from '@/lib/slicing';
import { fitOnBed, niceStep } from '@/lib/printers';
import { arrange, placeBeside, type Extent, type Footprint } from '@/lib/arrange';
import type {
  ClipState,
  Dimensions,
  MeasurePoint,
  Measurement,
  MeasureTool,
  MeasuringTool,
  PartInfo,
  Printability,
  Projection,
  RenderMode,
  ViewPreset,
} from '@/types';

/**
 * The 3D viewport. No React in here: the Engine owns the renderer, the camera,
 * the model and every tool that touches them, and reports back through a small
 * set of hooks. The store is the only thing that calls it.
 *
 * The scene graph, one branch per model on the plate:
 *
 *   modelGroup
 *     holder   uniform scale (file units → world), and the model's spot on the plate
 *       pivot  orientation — what "lay on face" and auto-orient rotate
 *         the loaded object, untouched
 *     holder   the next model, and so on
 *
 * Keeping the three jobs on three nodes means a reorientation never fights the
 * placement and neither of them ever edits the file's own transforms.
 *
 * Every model shares one scale, `worldPerMm`, set from the first model so it
 * fills the canonical stage. Later models are drawn at the same scale, so two
 * parts side by side are their true sizes relative to each other — a slicer's
 * plate, not a gallery of thumbnails.
 *
 * One model is *active*: the one the sidebar describes and the part tools act
 * on (orient, explode, printability, the units a measurement reads in).
 * Clicking any part of another model makes that model active. Framing, the
 * section cut, the layer preview and the plate cover every visible model.
 */

const EDGE_BUDGET = 350_000;
/** Above this many parts, hover picking costs more than it tells you. */
const HOVER_LIMIT = 6000;
/** Printability checks stop here; past it they would hold the tab for seconds. */
const ANALYSIS_LIMIT = 2_500_000;
/** The open-edge check needs a hash entry per edge, so it stops sooner. */
const EDGE_CHECK_LIMIT = 1_200_000;
/** Keep interactive layer-outline generation bounded until it moves to a worker. */
const SLICE_TRIANGLE_LIMIT = 250_000;
/** Part labels past this many are noise, not information. */
const LABEL_LIMIT = 40;
/** Space left between models when they are placed or arranged, in world units. */
const MODEL_GAP = CANONICAL * 0.05;

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

/** Screen position for one floating tag, in CSS pixels. */
export interface LabelAnchor {
  id: number;
  x: number;
  y: number;
  behind: boolean;
}

export interface PartLabel extends LabelAnchor {
  name: string;
}

export interface PlateInfo {
  /** Grid spacing in millimetres, or null with no model on the plate. */
  cellMm: number | null;
  /** Null without a printer chosen. */
  fits: boolean | null;
}

export interface EngineHooks {
  onSelect(info: SelectionInfo | null): void;
  onHover(name: string | null): void;
  onFrame(info: FrameInfo): void;
  onMeasure(measurements: Measurement[], pending: number): void;
  /** A finished set of points that does not describe anything measurable. */
  onMeasureRejected(reason: string): void;
  onContextChange(lost: boolean): void;
  /** The model was reoriented, so its bounds along each axis changed. */
  onTransform(dimensions: Dimensions): void;
  /** Visibility changed in the object list. */
  onParts(parts: PartInfo[]): void;
  /** A click or drag on the canvas made another model the active one. */
  onActiveModel(id: number | null): void;
}

/** How a model is mounted. Every field is optional; the defaults suit one file. */
export interface MountOptions {
  name?: string;
  /** How many millimetres one of the file's units is. */
  mmPerUnit?: number;
  colour?: string;
  paintAuthored?: boolean;
  /** Footprint centre on the plate in millimetres. Omit to place it beside the others. */
  position?: [number, number];
}

/** One model on the plate, and everything the Engine keeps about it. */
interface Mounted {
  id: number;
  name: string;
  holder: THREE.Group;
  pivot: THREE.Group;
  root: THREE.Object3D;
  parts: THREE.Object3D[];
  meshes: THREE.Mesh[];
  triangleCounts: Map<number, number>;
  authored: boolean;
  colour: string;
  paintAuthored: boolean;
  /** This model's paint-over and overhang surfaces: they carry its colour. */
  solid: THREE.MeshStandardMaterial;
  overhang: OverhangMaterial;
  mmPerUnit: number;
  /** Footprint centre on the plate, world units. */
  spot: THREE.Vector2;
  /** World bounds, refreshed whenever the model is seated or moved. */
  box: THREE.Box3;
  restCache: RestingFace[] | null;
}

interface Drag {
  model: Mounted;
  pointerId: number;
  /** The horizontal plane through the point that was grabbed. */
  plane: THREE.Plane;
  last: THREE.Vector3;
  moved: boolean;
}

const NO_HOOKS: EngineHooks = {
  onSelect() {},
  onHover() {},
  onFrame() {},
  onMeasure() {},
  onMeasureRejected() {},
  onContextChange() {},
  onTransform() {},
  onParts() {},
  onActiveModel() {},
};

/** How many points each tool needs before it produces a measurement. */
const POINTS_NEEDED: Record<MeasuringTool, number> = {
  distance: 2,
  diameter: 3,
  angle: 3,
};

/**
 * Why a completed set of points produced nothing. Silence would leave a person
 * clicking three times and watching the tool reset with no idea what it wanted.
 */
const REJECTION: Record<MeasuringTool, string> = {
  distance: 'Both points landed in the same spot, so there is no distance between them.',
  diameter:
    'Those three points sit in a straight line, so no circle passes through them. Spread them around the arc.',
  angle:
    'Two of those points landed in the same spot, so one arm has no direction. Click an arm, then the corner, then the other arm.',
};

/** Points closer together than this are the same point as far as a tool cares. */
const COINCIDENT = 1e-7;
const DOWN = new THREE.Vector3(0, -1, 0);
const noRaycast = () => {};

const isHelper = (node: THREE.Object3D) => Boolean(node.userData.caliperHelper);

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();

  private readonly canvas: HTMLCanvasElement;
  private readonly hooks: EngineHooks;
  private readonly rig: CameraRig;

  private readonly modelGroup = new THREE.Group();
  private readonly stage: Stage;
  private readonly annotations = new Annotations();
  private readonly section = new Section();
  private readonly explode = new Explode();
  private readonly layerContours: THREE.LineSegments;

  private models: Mounted[] = [];
  private active: Mounted | null = null;
  private modelSeq = 0;
  /** World units per millimetre, shared by every model. Set by the first one. */
  private worldPerMm: number | null = null;
  private drag: Drag | null = null;

  private selectionMark!: Bracket;
  private hoverMark!: Bracket;
  private layMark!: THREE.Mesh;
  private selectedNode: THREE.Object3D | null = null;

  /* --- appearance -------------------------------------------------------- */
  private renderMode: RenderMode = 'shaded';
  private filament = '#00ae42';
  private paintAuthored = false;
  private overhangOn = false;
  private overhangDeg = OVERHANG_DEFAULT;
  private readonly wire: THREE.MeshBasicMaterial;
  /** Colours by facing direction, so it needs no theme or filament colour. */
  private readonly surfaceAngle = surfaceAngleMaterial();
  /** Shared by every outline in the overlay, so clearEdges owns disposing it. */
  private readonly edgeMaterial: THREE.LineBasicMaterial;
  private edgeLines: THREE.LineSegments[] = [];
  private edgesComplete = true;
  private theme: ThemeName = 'dark';

  /* --- plate ------------------------------------------------------------- */
  private gridWanted = true;
  private bed: [number, number, number] | null = null;
  private plate: PlateInfo = { cellMm: null, fits: null };

  /* --- section ----------------------------------------------------------- */
  private clip: ClipState | null = null;
  private layerPreviewAt: number | null = null;
  private layerContoursLimited = false;

  /* --- labels ------------------------------------------------------------ */
  private labelSink: ((anchors: LabelAnchor[]) => void) | null = null;
  private partSink: ((labels: PartLabel[]) => void) | null = null;
  private partLabelsOn = false;
  private partCentres: { id: number; name: string; centre: THREE.Vector3 }[] | null = null;

  /* --- measuring --------------------------------------------------------- */
  private tool: MeasureTool = 'off';
  private measurements: Measurement[] = [];
  private pending: THREE.Vector3[] = [];
  private snap: Snap | null = null;
  private measureSeq = 0;

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

  constructor(canvas: HTMLCanvasElement, hooks: Partial<EngineHooks> = {}) {
    this.canvas = canvas;
    this.hooks = { ...NO_HOOKS, ...hooks };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      // The section cap is drawn through the stencil buffer.
      stencil: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral keeps a material's base colour where ACES would
    // wash it toward pastel: a part in Bambu green should read as that green.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;

    this.rig = new CameraRig(canvas);
    setActiveRenderer(this.renderer);

    this.stage = new Stage(this.scene, this.renderer);
    const skin = this.stage.skin;
    this.wire = wireMaterial(skin.wire);
    this.edgeMaterial = new THREE.LineBasicMaterial({
      color: skin.edgeInk,
      transparent: true,
      opacity: skin.edgeOpacity,
    });
    this.layerContours = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: skin.mark, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.layerContours.renderOrder = 4;
    this.layerContours.raycast = noRaycast;

    this.scene.add(
      this.modelGroup,
      this.stage.group,
      this.section.group,
      this.layerContours,
      this.annotations.group,
    );
    this.buildMarkers();
    this.bindPointer();
    this.bindContextLoss();

    this.animate = this.animate.bind(this);
    this.raf = requestAnimationFrame(this.animate);
  }

  /* ------------------------------------------------------------ setup ---- */

  private get camera() {
    return this.rig.camera;
  }

  private buildMarkers() {
    const skin = this.stage.skin;
    this.selectionMark = new Bracket(skin.select, 1);
    this.hoverMark = new Bracket(skin.select, 0.45);
    this.annotations.setColour(skin.mark);

    // The "lay on face" target: a disc lying on whatever face is under the
    // cursor, so it is obvious which way down the part is about to go.
    this.layMark = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        color: skin.select,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    );
    this.layMark.visible = false;
    this.layMark.renderOrder = 5;
    this.layMark.raycast = noRaycast;

    this.scene.add(this.selectionMark.group, this.hoverMark.group, this.layMark);
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
    // Capture phase, so the move tool sees a press before the orbit controls
    // do: a press on a model is a drag of that model, and the camera must not
    // swing round underneath it. A press on empty canvas still orbits.
    this.canvas.addEventListener('pointerdown', (event) => this.startDrag(event), { capture: true });

    this.canvas.addEventListener('pointerdown', (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY };
    });

    this.canvas.addEventListener('pointerup', (event) => {
      if (this.drag) return this.endDrag(event);
      if (!this.pointerDown) return;
      const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved > 5) return; // an orbit, not a click
      if (this.tool === 'off' || this.tool === 'move') this.pick(event);
      else if (this.tool === 'lay') this.layAt(event);
      else this.placePoint(event);
    });

    this.canvas.addEventListener('pointercancel', (event) => this.endDrag(event));

    this.canvas.addEventListener('pointermove', (event) => {
      if (this.drag) return this.dragTo(event);
      if (this.hoverQueued) return;
      this.hoverQueued = true;
      requestAnimationFrame(() => {
        this.hoverQueued = false;
        if (this.tool === 'off' || this.tool === 'move') this.trackHover(event);
        else if (this.tool === 'lay') this.trackLay(event);
        else this.trackSnap(event);
      });
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (this.snap) {
        this.snap = null;
        this.annotations.invalidate();
        this.invalidate();
      }
      if (this.layMark.visible) {
        this.layMark.visible = false;
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

    if (this.rig.update(this.clock.getDelta())) {
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
    this.publishPartLabels();
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

  /** Replaces whatever is on the plate with one model, framed. */
  setModel(object: THREE.Object3D, hasAuthoredMaterials: boolean, options: MountOptions = {}): number {
    this.clearModel();
    const id = this.addModel(object, hasAuthoredMaterials, options);
    this.setActiveModel(id);
    this.frameAll(true);
    return id;
  }

  /**
   * Puts one more model on the plate and returns its id. It is drawn at the
   * plate's shared scale and set down beside what is already there, unless
   * `options.position` says where. It does not become active on its own.
   */
  addModel(object: THREE.Object3D, hasAuthoredMaterials: boolean, options: MountOptions = {}): number {
    const id = ++this.modelSeq;
    const pivot = new THREE.Group();
    pivot.name = '__caliper_pivot';
    pivot.add(object);
    const holder = new THREE.Group();
    holder.name = '__caliper_holder';
    holder.userData.caliperModel = id;
    holder.add(pivot);
    this.modelGroup.add(holder);

    const mmPerUnit = options.mmPerUnit && options.mmPerUnit > 0 ? options.mmPerUnit : 1;
    // Scale once per plate, from the first model's own bounds, and never
    // again: a rescale would make the grid jump under every part on it.
    holder.updateMatrixWorld(true);
    if (this.worldPerMm === null) {
      const size = new THREE.Box3().setFromObject(pivot, true).getSize(new THREE.Vector3());
      this.worldPerMm = CANONICAL / ((size.length() || 1) * mmPerUnit);
    }
    holder.scale.setScalar(this.worldPerMm * mmPerUnit);

    const colour = options.colour ?? this.filament;
    const model: Mounted = {
      id,
      name: options.name || object.name || `Model ${id}`,
      holder,
      pivot,
      root: object,
      parts: [],
      meshes: [],
      triangleCounts: new Map(),
      authored: hasAuthoredMaterials,
      colour,
      paintAuthored: options.paintAuthored ?? this.paintAuthored,
      solid: filamentMaterial(colour),
      overhang: overhangMaterial(colour, this.overhangDeg, this.stage.skin.over),
      mmPerUnit,
      spot: new THREE.Vector2(),
      box: new THREE.Box3(),
      restCache: null,
    };
    model.overhang.setThreshold(this.overhangDeg);
    this.collectParts(model);

    const castShadows = this.stage.shadowsEnabled;
    for (const mesh of model.meshes) {
      // Honour the shadow toggle the person already set, rather than forcing
      // shadows back on with every file they open.
      mesh.castShadow = castShadows;
      mesh.receiveShadow = castShadows;
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
      mesh.userData.caliperBase = mesh.material;
    }
    this.paintFilament(model);

    // Seat it at the origin first: that measures its footprint.
    const others = this.extentOf(this.models);
    this.models.push(model);
    this.seat(model);
    const wpm = this.worldPerMm;
    const [x, z] = options.position
      ? [options.position[0] * wpm, options.position[1] * wpm]
      : placeBeside(others, this.footprint(model), MODEL_GAP);
    this.moveBy(model, x - model.spot.x, z - model.spot.y);

    this.annotations.setScaleHint(CANONICAL / 2);
    this.section.attach(this.allMeshes());
    this.applyRenderMode();
    this.applyClip();
    this.refreshLayerContours();
    this.syncPlate();
    this.invalidate();
    return id;
  }

  /** Every drawable node in the file, in file order. Helpers are skipped. */
  private collectParts(model: Mounted) {
    model.parts = [];
    model.meshes = [];
    model.triangleCounts.clear();
    model.root.traverse((node) => {
      if (isHelper(node)) return;
      const mesh = node as THREE.Mesh;
      const points = node as THREE.Points;
      if (!mesh.isMesh && !points.isPoints) return;
      model.parts.push(node);
      const geometry = mesh.geometry as THREE.BufferGeometry;
      const position = geometry?.getAttribute('position');
      const index = geometry?.getIndex();
      const triangles = mesh.isMesh && position ? Math.round((index ? index.count : position.count) / 3) : 0;
      model.triangleCounts.set(node.id, triangles);
      if (mesh.isMesh) model.meshes.push(mesh);
    });
  }

  private allMeshes(): THREE.Mesh[] {
    return this.models.flatMap((m) => m.meshes);
  }

  private find(id: number | null | undefined): Mounted | null {
    return this.models.find((m) => m.id === id) ?? null;
  }

  /** The model a node belongs to, found by walking up to its holder. */
  private ownerOf(node: THREE.Object3D | null): Mounted | null {
    for (let n = node; n && n !== this.modelGroup; n = n.parent) {
      const id = n.userData.caliperModel as number | undefined;
      if (id !== undefined) return this.find(id);
    }
    return null;
  }

  /**
   * Stands a model on the plate with its footprint centred on its spot. Runs
   * after every reorientation, with the bounds measured precisely: an
   * axis-aligned box of a rotated box is larger than the part, and the part
   * would float. The explode slider re-seats at drag rate, so it asks for the
   * quick bounds.
   */
  private seat(model: Mounted, precise = true) {
    const { holder, pivot } = model;
    holder.position.set(0, 0, 0);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(pivot, precise);
    const centre = box.getCenter(new THREE.Vector3());
    holder.position.set(model.spot.x - centre.x, -box.min.y, model.spot.y - centre.z);
    holder.updateMatrixWorld(true);
    model.box = box.translate(holder.position);
  }

  /** Slides a model across the plate. No bounds are recomputed: it only moves. */
  private moveBy(model: Mounted, dx: number, dz: number) {
    if (!dx && !dz) return;
    model.holder.position.x += dx;
    model.holder.position.z += dz;
    model.holder.updateMatrixWorld(true);
    model.spot.x += dx;
    model.spot.y += dz;
    model.box.translate(new THREE.Vector3(dx, 0, dz));
  }

  private footprint(model: Mounted): Footprint {
    const size = model.box.getSize(new THREE.Vector3());
    return { w: size.x, d: size.z };
  }

  /** The rectangle seen from above that `models` cover, or null for none. */
  private extentOf(models: Mounted[]): Extent | null {
    const boxes = models.filter((m) => !m.box.isEmpty());
    if (!boxes.length) return null;
    return {
      minX: Math.min(...boxes.map((m) => m.box.min.x)),
      maxX: Math.max(...boxes.map((m) => m.box.max.x)),
      minZ: Math.min(...boxes.map((m) => m.box.min.z)),
      maxZ: Math.max(...boxes.map((m) => m.box.max.z)),
    };
  }

  /** World bounds of every visible model; empty when none are. */
  private visibleBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const model of this.models) if (model.holder.visible) box.union(model.box);
    return box;
  }

  /** Rebuilds the visible layer's perimeter lines in world space. */
  private refreshLayerContours(): boolean {
    const replaceGeometry = (vertices: number[]) => {
      const previous = this.layerContours.geometry;
      this.layerContours.geometry = new THREE.BufferGeometry();
      this.layerContours.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      previous.dispose();
    };

    this.layerContoursLimited = false;
    const bounds = this.visibleBounds();
    if (this.layerPreviewAt === null || bounds.isEmpty()) {
      if (this.layerContours.geometry.getAttribute('position')?.count) replaceGeometry([]);
      return true;
    }

    const sources: { source: ReturnType<typeof meshTriangles>['source']; matrix: THREE.Matrix4 }[] = [];
    let total = 0;
    for (const model of this.models) {
      if (!model.holder.visible) continue;
      model.root.updateWorldMatrix(true, true);
      const { source, total: modelTotal } = meshTriangles(model.root, SLICE_TRIANGLE_LIMIT, true);
      total += modelTotal;
      if (total > SLICE_TRIANGLE_LIMIT) {
        this.layerContoursLimited = true;
        replaceGeometry([]);
        return false;
      }
      sources.push({ source, matrix: model.root.matrixWorld.clone() });
    }

    const size = bounds.getSize(new THREE.Vector3());
    const planeY = bounds.min.y + size.y * THREE.MathUtils.clamp(this.layerPreviewAt, 0.0005, 1);
    const transformed = new Float64Array(9);
    const point = new THREE.Vector3();
    const source = (visit: (triangle: ArrayLike<number>) => void) => {
      for (const item of sources) {
        item.source((triangle) => {
          for (let corner = 0; corner < 3; corner++) {
            const i = corner * 3;
            point.set(triangle[i], triangle[i + 1], triangle[i + 2]).applyMatrix4(item.matrix);
            transformed[i] = point.x;
            transformed[i + 1] = point.y;
            transformed[i + 2] = point.z;
          }
          visit(transformed);
        });
      }
    };

    const tolerance = Math.max(size.length() * 1e-8, 1e-8);
    const loops = sliceContours(source, planeY, tolerance);
    const vertices: number[] = [];
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        vertices.push(a.x, planeY, a.z, b.x, planeY, b.z);
      }
    }
    replaceGeometry(vertices);
    return true;
  }

  /** Selects a normalized plate-height plane and shows its stitched contours. */
  setLayerPreview(at: number | null): boolean {
    const next = at === null ? null : THREE.MathUtils.clamp(at, 0, 1);
    if (next === this.layerPreviewAt) return !this.layerContoursLimited;
    this.layerPreviewAt = next;
    const complete = this.refreshLayerContours();
    this.invalidate();
    return complete;
  }

  /** Takes every model off the plate. */
  clearModel() {
    this.endDrag();
    this.explode.clear();
    this.section.detach();
    this.clearEdges();
    for (const model of this.models) this.unmount(model);
    this.models = [];
    this.refreshLayerContours();
    this.active = null;
    this.worldPerMm = null;
    this.partCentres = null;
    this.selectionMark.hide();
    this.hoverMark.hide();
    this.layMark.visible = false;
    this.selectedNode = null;
    this.clearMeasurements();
    this.syncPlate();
    this.hooks.onSelect(null);
    this.hooks.onHover(null);
    this.invalidate();
  }

  /** Detaches one model's branch and frees what only it was using. */
  private unmount(model: Mounted) {
    // Put each mesh's own material back first: the shared overrides outlive
    // the model and must not be disposed along with it.
    for (const mesh of model.meshes) {
      if (mesh.userData.caliperBase) mesh.material = mesh.userData.caliperBase;
    }
    this.modelGroup.remove(model.holder);
    disposeObject(model.holder);
    model.solid.dispose();
    model.overhang.dispose();
  }

  /**
   * Takes one model off the plate. Returns the id of the model that is active
   * afterwards — another one when the removed model was active — or null when
   * the plate is empty.
   */
  removeModel(id: number): number | null {
    const model = this.find(id);
    if (!model) return this.active?.id ?? null;
    if (this.models.length === 1) {
      this.clearModel();
      return null;
    }
    if (this.drag?.model === model) this.endDrag();
    if (model === this.active) this.explode.clear();
    if (this.ownerOf(this.selectedNode) === model) this.select(null);

    this.section.detach();
    this.clearEdges();
    this.unmount(model);
    this.models = this.models.filter((m) => m !== model);
    if (model === this.active) {
      this.active = null;
      this.activate(this.models[this.models.length - 1], false);
    }

    this.hoverMark.hide();
    this.afterLayout();
    this.section.attach(this.allMeshes());
    this.applyRenderMode();
    return this.active?.id ?? null;
  }

  /** Makes a model the one the sidebar and the part tools work on. */
  setActiveModel(id: number | null) {
    this.activate(this.find(id), false);
  }

  private activate(model: Mounted | null, notify: boolean) {
    if (model === this.active) return;
    // The assembly view belongs to one model: put the old one back together.
    const previous = this.active;
    this.explode.clear();
    if (previous) this.seat(previous);
    this.active = model;
    if (model) this.explode.prepare(model.pivot, model.parts);
    if (this.selectedNode && this.ownerOf(this.selectedNode) !== model) {
      this.selectedNode = null;
      this.selectionMark.hide();
      this.hooks.onSelect(null);
    }
    this.partCentres = null;
    this.section.setCapColour(capColour(model?.colour ?? this.filament, this.stage.skin.cap));
    this.refreshLayerContours();
    if (notify) this.hooks.onActiveModel(model?.id ?? null);
    this.invalidate();
  }

  get activeModelId(): number | null {
    return this.active?.id ?? null;
  }

  get modelCount(): number {
    return this.models.length;
  }

  /** Shows or hides a whole model. A hidden model is skipped by every tool. */
  setModelVisible(id: number, visible: boolean) {
    const model = this.find(id);
    if (!model) return;
    model.holder.visible = visible;
    if (!visible && this.ownerOf(this.selectedNode) === model) this.select(null);
    this.hoverMark.hide();
    this.afterLayout();
  }

  /** A model's colour, and whether it covers the file's own colours too. */
  setModelColour(id: number, colour: string, paintAuthored?: boolean) {
    const model = this.find(id);
    if (!model) return;
    model.colour = colour;
    if (paintAuthored !== undefined) model.paintAuthored = paintAuthored;
    model.solid.color.set(colour);
    model.overhang.color.set(colour);
    if (model === this.active) this.section.setCapColour(capColour(colour, this.stage.skin.cap));
    this.paintFilament(model);
    this.applySurfaces();
  }

  /**
   * Says how many millimetres one of a model's units is. With one model on the
   * plate the model keeps its size on screen and the grid rescales under it;
   * with several, the model grows or shrinks against its neighbours, which is
   * the point of correcting its unit.
   */
  setModelUnit(id: number, mmPerUnit: number) {
    const model = this.find(id);
    if (!model || this.worldPerMm === null) return;
    model.mmPerUnit = mmPerUnit > 0 ? mmPerUnit : 1;
    if (this.models.length === 1) {
      this.worldPerMm = model.holder.scale.x / model.mmPerUnit;
    } else {
      if (model === this.active) this.explode.clear();
      model.holder.scale.setScalar(this.worldPerMm * model.mmPerUnit);
      this.seat(model);
      if (model === this.active) this.explode.prepare(model.pivot, model.parts);
      // Points dropped on the old size would hang in mid-air on the new one.
      this.clearMeasurements();
    }
    this.afterLayout();
  }

  /** Where a model's footprint centre sits on the plate, in millimetres. */
  modelPosition(id: number): [number, number] {
    const model = this.find(id);
    if (!model || !this.worldPerMm) return [0, 0];
    return [model.spot.x / this.worldPerMm, model.spot.y / this.worldPerMm];
  }

  /** Puts a model's footprint centre at a point on the plate, in millimetres. */
  setModelPosition(id: number, [x, z]: [number, number]) {
    const model = this.find(id);
    if (!model || !this.worldPerMm) return;
    this.moveBy(model, x * this.worldPerMm - model.spot.x, z * this.worldPerMm - model.spot.y);
    this.afterMove();
  }

  /** Nudges a model across the plate by a distance in millimetres. */
  moveModelBy(id: number, dxMm: number, dzMm: number) {
    const [x, z] = this.modelPosition(id);
    this.setModelPosition(id, [x + dxMm, z + dzMm]);
  }

  /** Bambu Studio's Arrange: packs every model onto the plate, centred, without overlaps. */
  arrange() {
    if (!this.models.length) return;
    this.explode.clear();
    for (const model of this.models) this.seat(model);
    const spots = arrange(this.models.map((m) => this.footprint(m)), MODEL_GAP);
    this.models.forEach((model, i) => this.moveBy(model, spots[i][0] - model.spot.x, spots[i][1] - model.spot.y));
    if (this.active) this.explode.prepare(this.active.pivot, this.active.parts);
    this.afterMove();
    this.frameAll();
  }

  /** After models moved: everything that hangs off their positions catches up. */
  private afterMove() {
    // Measurements are anchored in world space; on a moved part they would
    // float where the part used to be.
    if (this.measurements.length || this.pending.length) this.clearMeasurements();
    if (this.selectedNode) this.selectionMark.show(this.selectedNode);
    this.afterLayout();
    this.hooks.onTransform(this.dimensions());
  }

  /** Plate, section and labels follow the models after any change of layout. */
  private afterLayout() {
    this.partCentres = null;
    this.applyClip();
    this.refreshLayerContours();
    this.syncPlate();
    this.invalidate();
  }

  /* -------------------------------------------------------------- drag ---- */

  private startDrag(event: PointerEvent) {
    if (this.tool !== 'move' || event.button !== 0 || this.drag) return;
    const hit = this.hit(event);
    const model = hit ? this.ownerOf(hit.object) : null;
    if (!hit || !model) return;

    event.stopImmediatePropagation();
    this.rig.controls.enabled = false;
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* a synthetic event has no pointer to capture */
    }
    this.activate(model, true);
    this.select(hit.object);
    this.hoverMark.hide();
    this.canvas.style.cursor = 'grabbing';
    this.drag = {
      model,
      pointerId: event.pointerId,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y),
      last: hit.point.clone(),
      moved: false,
    };
  }

  /**
   * The grabbed point follows the cursor across a horizontal plane at the
   * height it was grabbed, so the part stays under the finger at any camera
   * angle rather than sliding at the plate's height beneath it.
   */
  private dragTo(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.rayFrom(event);
    const point = this.raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!point) return;
    this.moveBy(drag.model, point.x - drag.last.x, point.z - drag.last.z);
    drag.last.copy(point);
    drag.moved = true;
    if (this.selectedNode) this.selectionMark.show(this.selectedNode);
    this.refreshLayerContours();
    this.invalidate();
  }

  private endDrag(event?: PointerEvent) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    this.drag = null;
    this.rig.controls.enabled = true;
    this.canvas.style.cursor = '';
    try {
      this.canvas.releasePointerCapture(drag.pointerId);
    } catch {
      /* already released */
    }
    if (drag.moved) this.afterMove();
  }

  /**
   * A small picture of one model on its own, for the recent-files list. Drawn
   * through the real renderer with a camera of its own, so the view the person
   * is looking at is left exactly as it was.
   */
  thumbnail(id: number, width = 192, height = 144): string | null {
    const model = this.find(id);
    if (!model || this.contextLost || model.box.isEmpty()) return null;

    const centre = model.box.getCenter(new THREE.Vector3());
    const radius = Math.max(model.box.getSize(new THREE.Vector3()).length() / 2, 0.001);
    const camera = new THREE.PerspectiveCamera(30, width / height, radius / 100, radius * 100);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02;
    camera.position.copy(centre).addScaledVector(new THREE.Vector3(...VIEW_DIRECTIONS.iso).normalize(), distance);
    camera.lookAt(centre);

    const helpers = [this.selectionMark.group, this.hoverMark.group, this.layMark, this.annotations.group, this.section.group];
    const hidden = [...this.models.filter((m) => m !== model).map((m) => m.holder), ...helpers];
    const before = hidden.map((node) => node.visible);
    const wasVisible = model.holder.visible;
    const size = this.renderer.getSize(new THREE.Vector2());
    const ratio = this.renderer.getPixelRatio();

    try {
      hidden.forEach((node) => (node.visible = false));
      model.holder.visible = true;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      return this.stage.withoutPlate(() => {
        this.renderer.render(this.scene, camera);
        return this.canvas.toDataURL('image/webp', 0.82);
      });
    } catch {
      return null;
    } finally {
      hidden.forEach((node, i) => (node.visible = before[i]));
      model.holder.visible = wasVisible;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(size.x, size.y, false);
      this.invalidate();
    }
  }

  /** The active model's loaded object, without Caliper's framing wrappers. */
  get modelRoot(): THREE.Object3D | null {
    return this.active?.root ?? null;
  }

  /** True when the outline pass had to stop short of drawing every edge. */
  get edgesTruncated() {
    return !this.edgesComplete;
  }

  get hoverEnabled() {
    const parts = this.models.reduce((sum, m) => sum + m.parts.length, 0);
    return parts > 0 && parts <= HOVER_LIMIT;
  }

  /** A model's bounds in its current orientation, in the file's own units. The active one by default. */
  dimensions(id?: number): Dimensions {
    const model = id === undefined ? this.active : this.find(id);
    if (!model) return { x: 0, y: 0, z: 0, diagonal: 0, center: [0, 0, 0] };
    const { holder, pivot } = model;
    holder.updateMatrixWorld(true);
    const world = new THREE.Box3().setFromObject(pivot, true);
    // The holder is a uniform scale and a translation, so its inverse maps the
    // world box straight back to a box in file units.
    const inverse = holder.matrixWorld.clone().invert();
    const box = world.applyMatrix4(inverse);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    return { x: size.x, y: size.y, z: size.z, diagonal: size.length(), center: [centre.x, centre.y, centre.z] };
  }

  /** What every visible model covers together, in millimetres. */
  plateExtent(): { x: number; y: number; z: number } {
    const box = this.visibleBounds();
    if (box.isEmpty() || !this.worldPerMm) return { x: 0, y: 0, z: 0 };
    const size = box.getSize(new THREE.Vector3()).divideScalar(this.worldPerMm);
    return { x: size.x, y: size.y, z: size.z };
  }

  /* ---------------------------------------------------- printability ---- */

  /** The plate's down direction, expressed in the loaded object's own space. */
  private downInObject(model: Mounted): Vec3 {
    const down = DOWN.clone().applyQuaternion(model.pivot.quaternion.clone().invert());
    const toObject = new THREE.Matrix4().copy(model.root.matrix).invert();
    down.transformDirection(toObject);
    return [down.x, down.y, down.z];
  }

  /** The active model's volume, area, closure and overhang. Null past the size limit. */
  analyse(): Printability | null {
    const model = this.active;
    if (!model) return null;
    const { source, total } = meshTriangles(model.root);
    if (total > ANALYSIS_LIMIT) return null;
    return analyse(source, {
      down: this.downInObject(model),
      overhangDeg: this.overhangDeg,
      skipEdges: total > EDGE_CHECK_LIMIT,
    });
  }

  /** Just the overhang, which is all a reorientation or a new limit changes. */
  overhangArea(): number | null {
    const model = this.active;
    if (!model) return null;
    const { source, total } = meshTriangles(model.root);
    if (total > ANALYSIS_LIMIT) return null;
    return overhangArea(source, this.downInObject(model), this.overhangDeg);
  }

  /* ------------------------------------------------------ orientation ---- */

  /** Resting faces in the pivot's frame, worked out once per model. */
  private restingFaces(model: Mounted): RestingFace[] {
    if (model.restCache) return model.restCache;
    const root = model.root;
    const { source, total } = meshTriangles(root, ANALYSIS_LIMIT);
    if (total > ANALYSIS_LIMIT * 2) return (model.restCache = []);
    const faces = restingFaces(source, 12);
    model.restCache = faces.map((face) => {
      const normal = new THREE.Vector3(...face.normal).transformDirection(root.matrix);
      return { area: face.area, normal: [normal.x, normal.y, normal.z] as Vec3 };
    });
    return model.restCache;
  }

  /** Turns the part so `normal` (in the pivot's own frame) points at the plate. */
  private layNormal(model: Mounted, normal: THREE.Vector3) {
    this.explode.reset();
    model.pivot.quaternion.setFromUnitVectors(normal.clone().normalize(), DOWN);
    this.afterReorient(model);
  }

  private afterReorient(model: Mounted) {
    this.seat(model);
    this.partCentres = null;
    // Points dropped on the old pose would hang in mid-air on the new one.
    this.clearMeasurements();
    if (this.selectedNode) this.selectionMark.show(this.selectedNode);
    this.applyClip();
    this.refreshLayerContours();
    this.syncPlate();
    this.hooks.onTransform(this.dimensions());
    this.frameAll();
  }

  /** Bambu Studio's auto-orient, in its simplest honest form: the largest flat face goes down. */
  autoOrient(): boolean {
    const model = this.active;
    if (!model) return false;
    const [best] = this.restingFaces(model);
    if (!best) return false;
    this.layNormal(model, new THREE.Vector3(...best.normal));
    return true;
  }

  resetOrientation() {
    const model = this.active;
    if (!model) return;
    this.explode.reset();
    model.pivot.quaternion.identity();
    this.afterReorient(model);
  }

  get oriented(): boolean {
    return Boolean(this.active && !this.active.pivot.quaternion.equals(new THREE.Quaternion()));
  }

  private faceUnder(event: PointerEvent): { point: THREE.Vector3; normal: THREE.Vector3; object: THREE.Object3D } | null {
    const hit = this.hit(event);
    if (!hit?.face) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { point: hit.point.clone(), normal, object: hit.object };
  }

  private trackLay(event: PointerEvent) {
    const face = this.faceUnder(event);
    if (!face) {
      if (this.layMark.visible) {
        this.layMark.visible = false;
        this.invalidate();
      }
      return;
    }
    this.layMark.visible = true;
    this.layMark.scale.setScalar(CANONICAL * 0.045);
    this.layMark.position.copy(face.point).addScaledVector(face.normal, CANONICAL * 0.002);
    this.layMark.lookAt(face.point.clone().add(face.normal));
    this.invalidate();
  }

  private layAt(event: PointerEvent) {
    const face = this.faceUnder(event);
    const model = face ? this.ownerOf(face.object) : null;
    if (!face || !model) return;
    // Laying a face of another model down is a request to work on that model.
    this.activate(model, true);
    // From world back into the pivot's own frame: undo the current rotation.
    const local = face.normal.clone().applyQuaternion(model.pivot.quaternion.clone().invert());
    // Snap to the hull face it belongs to, so a click on a faceted surface
    // still lands square; otherwise trust the face that was clicked.
    const snapped = nearestRestingFace(this.restingFaces(model), [local.x, local.y, local.z]);
    this.layMark.visible = false;
    this.layNormal(model, snapped ? new THREE.Vector3(...snapped.normal) : local);
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
    this.clearEdges();
    if (this.renderMode === 'edges') this.buildEdges();
    this.applySurfaces();
  }

  /** The one material a model's meshes should wear right now, or null for their own. */
  private surfaceOverride(model: Mounted): THREE.Material | null {
    if (this.renderMode === 'wireframe') return this.wire;
    if (this.renderMode === 'surface') return this.surfaceAngle;
    if (this.overhangOn) return model.overhang;
    if (model.authored && model.paintAuthored) return model.solid;
    return null;
  }

  private applySurfaces() {
    for (const model of this.models) {
      const override = this.surfaceOverride(model);
      for (const mesh of model.meshes) {
        mesh.material = override ?? (mesh.userData.caliperBase as THREE.Material | THREE.Material[]);
      }
    }
    this.syncClipping();
    this.invalidate();
  }

  /**
   * Formats with no materials of their own wear their model's colour directly
   * on the material their loader made, so a texture-less STL looks printed.
   */
  private paintFilament(model: Mounted) {
    if (model.authored) return;
    for (const mesh of model.meshes) {
      const base = mesh.userData.caliperBase as THREE.Material | THREE.Material[];
      for (const material of Array.isArray(base) ? base : [base]) {
        const standard = material as THREE.MeshStandardMaterial;
        if (!standard.isMeshStandardMaterial || standard.vertexColors) continue;
        standard.color.set(model.colour);
        standard.metalness = 0.05;
        standard.roughness = 0.55;
      }
    }
  }

  /**
   * The filament colour for every model on the plate and every model added
   * later, and whether it should cover a file's own colours too. The app sets
   * colours per model with setModelColour; this is the one-colour shortcut.
   */
  setFilament(colour: string, paintAuthored: boolean) {
    this.filament = colour;
    this.paintAuthored = paintAuthored;
    for (const model of this.models) this.setModelColour(model.id, colour, paintAuthored);
    this.section.setCapColour(capColour(this.active?.colour ?? colour, this.stage.skin.cap));
    this.applySurfaces();
  }

  /** Bambu Studio's "show overhang", with the limit in degrees from vertical. */
  setOverhang(enabled: boolean, degrees = this.overhangDeg) {
    this.overhangOn = enabled;
    this.overhangDeg = degrees;
    for (const model of this.models) model.overhang.setThreshold(degrees);
    this.applySurfaces();
  }

  private buildEdges() {
    let budget = EDGE_BUDGET;
    this.edgesComplete = true;
    for (const mesh of this.allMeshes()) {
      const index = mesh.geometry.getIndex();
      const position = mesh.geometry.getAttribute('position');
      if (!position) continue;
      budget -= (index ? index.count : position.count) / 3;
      if (budget <= 0) {
        this.edgesComplete = false;
        break;
      }
      // A child of the mesh, so it follows every explode and reorientation.
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 32), this.edgeMaterial);
      lines.userData.caliperHelper = true;
      lines.raycast = noRaycast;
      mesh.add(lines);
      this.edgeLines.push(lines);
    }
  }

  private clearEdges() {
    for (const lines of this.edgeLines) {
      lines.parent?.remove(lines);
      lines.geometry.dispose();
    }
    this.edgeLines = [];
    this.edgesComplete = true;
  }

  setGridVisible(visible: boolean) {
    this.gridWanted = visible;
    this.stage.setGridVisible(visible);
    this.invalidate();
  }

  setShadowsEnabled(enabled: boolean) {
    this.renderer.shadowMap.enabled = enabled;
    this.stage.setShadowsEnabled(enabled);
    const meshes = this.allMeshes();
    for (const mesh of meshes) {
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    }
    this.renderer.shadowMap.needsUpdate = true;
    // Shadow maps are part of the program key, so materials must recompile.
    for (const mesh of meshes) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      list.forEach((m) => (m.needsUpdate = true));
    }
    this.invalidate();
  }

  setTheme(theme: ThemeName) {
    this.theme = theme;
    this.stage.setTheme(theme);
    const skin = this.stage.skin;

    this.selectionMark.setColour(skin.select);
    this.hoverMark.setColour(skin.select);
    (this.layMark.material as THREE.MeshBasicMaterial).color.setHex(skin.select);
    this.annotations.setColour(skin.mark);
    this.wire.color.setHex(skin.wire);
    for (const model of this.models) model.overhang.setOverhangColour(skin.over);
    this.edgeMaterial.color.setHex(skin.edgeInk);
    this.edgeMaterial.opacity = skin.edgeOpacity;
    (this.layerContours.material as THREE.LineBasicMaterial).color.setHex(skin.mark);
    this.section.setCapColour(capColour(this.active?.colour ?? this.filament, skin.cap));
    this.invalidate();
  }

  get themeName() {
    return this.theme;
  }

  /* ------------------------------------------------------------ plate ---- */

  /**
   * Chooses the plate: a printer's bed at true size (millimetres), or `null`
   * for a plate sized to the models. Each model's unit (setModelUnit) is what
   * lets a bed in millimetres be laid under a file whose numbers mean metres.
   */
  setPlate(bed: [number, number, number] | null): PlateInfo {
    this.bed = bed;
    this.syncPlate();
    return this.plate;
  }

  get plateInfo(): PlateInfo {
    return this.plate;
  }

  private syncPlate() {
    const worldPerMm = this.worldPerMm;
    if (!this.models.length || worldPerMm === null) {
      this.stage.setPlate({ width: CANONICAL * 3, depth: CANONICAL * 3, cell: 1, height: null, fits: true });
      this.stage.setShadowReach(0);
      this.stage.setGridVisible(this.gridWanted);
      this.plate = { cellMm: null, fits: null };
      this.invalidate();
      return;
    }

    const bounds = this.visibleBounds();
    // How far the models reach from the plate's centre, in any direction.
    const reach = bounds.isEmpty()
      ? 0
      : Math.max(-bounds.min.x, bounds.max.x, -bounds.min.z, bounds.max.z);
    let spec: PlateSpec;
    let fits: boolean | null = null;
    let cellMm: number;

    if (this.bed) {
      fits = this.fitsBed(this.bed, bounds, worldPerMm);
      cellMm = 10;
      spec = {
        width: this.bed[0] * worldPerMm,
        depth: this.bed[1] * worldPerMm,
        height: this.bed[2] * worldPerMm,
        cell: cellMm * worldPerMm,
        fits,
      };
    } else {
      // The model-sized plate grows to hold models spread out across it.
      const size = Math.max(CANONICAL * 3, reach * 2 * 1.15);
      cellMm = niceStep(size / worldPerMm, 24);
      spec = { width: size, depth: size, height: null, cell: cellMm * worldPerMm, fits: true };
    }

    this.stage.setShadowReach(reach * 1.15);
    this.stage.setPlate(spec);
    this.stage.setGridVisible(this.gridWanted);
    this.plate = { cellMm, fits };
    this.invalidate();
  }

  /**
   * Whether everything visible fits the printer. A single model that has not
   * been moved may turn a quarter on the bed, as a slicer would turn it; once
   * models have been placed, each has to sit inside the bed where it is.
   */
  private fitsBed(bed: [number, number, number], bounds: THREE.Box3, worldPerMm: number): boolean {
    if (bounds.isEmpty()) return true;
    const size = bounds.getSize(new THREE.Vector3()).divideScalar(worldPerMm);
    const visible = this.models.filter((m) => m.holder.visible);
    if (visible.length === 1 && visible[0].spot.lengthSq() < 1e-12) {
      return fitOnBed([size.x, size.y, size.z], bed).fits;
    }
    const halfW = (bed[0] / 2) * worldPerMm + 1e-6;
    const halfD = (bed[1] / 2) * worldPerMm + 1e-6;
    return (
      size.y <= bed[2] + 1e-6 &&
      bounds.min.x >= -halfW &&
      bounds.max.x <= halfW &&
      bounds.min.z >= -halfD &&
      bounds.max.z <= halfD
    );
  }

  /* ---------------------------------------------------------- section ---- */

  /** One cutting plane through the model, or `null` to put it back together. */
  setClip(state: ClipState | null) {
    this.clip = state;
    this.applyClip();
  }

  private applyClip() {
    this.section.set(this.clip, this.visibleBounds());
    this.syncClipping();
    this.invalidate();
  }

  /** Pushes the current planes onto every material the model can be wearing. */
  private syncClipping() {
    const planes = this.section.planes;
    const value = planes.length ? planes : null;
    const touch = (material: THREE.Material) => {
      material.clippingPlanes = value;
      material.clipShadows = true;
    };
    for (const model of this.models) {
      for (const mesh of model.meshes) {
        const base = mesh.userData.caliperBase as THREE.Material | THREE.Material[];
        (Array.isArray(base) ? base : [base]).forEach(touch);
        (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(touch);
      }
      for (const part of model.parts) {
        const points = part as THREE.Points;
        if (points.isPoints) (Array.isArray(points.material) ? points.material : [points.material]).forEach(touch);
      }
      [model.solid, model.overhang].forEach(touch);
    }
    [this.wire, this.surfaceAngle, this.edgeMaterial].forEach(touch);
  }

  /** True when a world point is on the side of the plane that was cut away. */
  private clipped(point: THREE.Vector3): boolean {
    return this.section.enabled && this.section.plane.distanceToPoint(point) < 0;
  }

  /* ---------------------------------------------------------- explode ---- */

  get canExplode() {
    return this.explode.available;
  }

  get explodeRatio() {
    return this.explode.value;
  }

  setExplode(ratio: number) {
    const model = this.active;
    if (!model) return;
    this.explode.apply(ratio);
    // Parts below the centre move down; lift the whole assembly so the lowest
    // one still stands on the plate instead of sinking through it.
    this.seat(model, this.explode.value === 1);
    this.partCentres = null;
    this.annotations.invalidate();
    if (this.selectedNode) this.selectionMark.show(this.selectedNode);
    this.applyClip();
    this.refreshLayerContours();
    this.invalidate();
  }

  /* ------------------------------------------------------------ parts ---- */

  /** The active model's parts, as the object list shows them. */
  partList(): PartInfo[] {
    const model = this.active;
    if (!model) return [];
    return model.parts.map((node, i) => ({
      id: node.id,
      name: node.name || `Part ${i + 1}`,
      triangles: model.triangleCounts.get(node.id) ?? 0,
      visible: node.visible,
    }));
  }

  private afterVisibility() {
    if (this.selectedNode && !this.shown(this.selectedNode)) this.select(null);
    this.hoverMark.hide();
    this.partCentres = null;
    this.hooks.onParts(this.partList());
    this.refreshLayerContours();
    this.invalidate();
  }

  setPartVisible(id: number, visible: boolean) {
    const node = this.active?.parts.find((part) => part.id === id);
    if (!node) return;
    node.visible = visible;
    this.afterVisibility();
  }

  /** Shows only one part, or every part again with `null`. */
  isolate(id: number | null) {
    for (const part of this.active?.parts ?? []) part.visible = id === null || part.id === id;
    this.afterVisibility();
  }

  /* ----------------------------------------------------------- labels ---- */

  setLabelSink(sink: ((anchors: LabelAnchor[]) => void) | null) {
    this.labelSink = sink;
  }

  setPartLabelSink(sink: ((labels: PartLabel[]) => void) | null) {
    this.partSink = sink;
  }

  /** Bambu Studio's "show labels": part names floating over the parts. */
  setPartLabels(enabled: boolean) {
    this.partLabelsOn = enabled;
    if (!enabled) this.partSink?.([]);
    this.invalidate();
  }

  private publishPartLabels() {
    if (!this.partSink || !this.partLabelsOn) return;
    if (!this.partCentres) this.partCentres = this.labelPoints();

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const at = new THREE.Vector3();
    this.partSink(
      this.partCentres.map(({ id, name, centre }) => {
        at.copy(centre).project(this.camera);
        return {
          id,
          name,
          x: (at.x * 0.5 + 0.5) * width,
          y: (-at.y * 0.5 + 0.5) * height,
          behind: at.z > 1 || this.clipped(centre),
        };
      }),
    );
  }

  /**
   * With several models on the plate, a label names each model, over its top;
   * with one, labels name its parts. The largest visible parts get names: a
   * hundred tags is a screen of text.
   */
  private labelPoints(): { id: number; name: string; centre: THREE.Vector3 }[] {
    if (this.models.length > 1) {
      return this.models
        .filter((m) => m.holder.visible && !m.box.isEmpty())
        .map((m) => {
          const centre = m.box.getCenter(new THREE.Vector3());
          centre.y = m.box.max.y;
          return { id: m.id, name: m.name, centre };
        });
    }
    const model = this.active;
    if (!model) return [];
    return model.parts
      .map((node, i) => ({ node, i }))
      .filter(({ node }) => this.shown(node))
      .sort((a, b) => (model.triangleCounts.get(b.node.id) ?? 0) - (model.triangleCounts.get(a.node.id) ?? 0))
      .slice(0, LABEL_LIMIT)
      .map(({ node, i }) => ({
        id: node.id,
        name: node.name || `Part ${i + 1}`,
        centre: new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3()),
      }));
  }

  /* ----------------------------------------------------------- camera ---- */

  setProjection(mode: Projection) {
    this.rig.setProjection(mode);
    this.annotations.invalidate();
    this.invalidate();
  }

  get projection(): Projection {
    return this.rig.projection;
  }

  /** Optional controls for embedding: the landing page turns zoom off. */
  configureControls(options: { zoom?: boolean; autoRotate?: number }) {
    const controls = this.rig.controls;
    if (options.zoom !== undefined) controls.enableZoom = options.zoom;
    if (options.autoRotate !== undefined) {
      controls.autoRotate = options.autoRotate !== 0;
      controls.autoRotateSpeed = options.autoRotate;
    }
    this.invalidate();
  }

  private boundsOf(target?: THREE.Object3D): THREE.Box3 {
    if (target) return new THREE.Box3().setFromObject(target);
    const visible = this.visibleBounds();
    return visible.isEmpty() ? new THREE.Box3().setFromObject(this.stage.group) : visible;
  }

  frameAll(instant = false) {
    this.rig.frame(this.boundsOf(), instant ? new THREE.Vector3(...VIEW_DIRECTIONS.iso) : undefined);
    this.annotations.invalidate();
    this.invalidate();
  }

  /** Zoom to one model on the plate. */
  frameModel(id: number) {
    const model = this.find(id);
    if (model && !model.box.isEmpty()) this.rig.frame(model.box.clone());
    this.annotations.invalidate();
    this.invalidate();
  }

  /** Zoom to the selected part — the move a person reaches for constantly. */
  frameSelection(id: number) {
    const node = this.scene.getObjectById(id);
    if (node) this.rig.frame(this.boundsOf(node));
    this.invalidate();
  }

  setView(preset: ViewPreset) {
    const direction = new THREE.Vector3(...VIEW_DIRECTIONS[preset]);
    // Bambu Studio's 0 shows the whole plate; everywhere else frames the part.
    const box = preset === 'default' && this.bed ? this.stage.plateBox : this.boundsOf();
    this.rig.frame(box, direction);
    this.annotations.invalidate();
    this.invalidate();
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

  /** Visible all the way up — a part inside a hidden part is hidden too. */
  private shown(node: THREE.Object3D): boolean {
    for (let n: THREE.Object3D | null = node; n && n !== this.modelGroup; n = n.parent) {
      if (!n.visible) return false;
    }
    return true;
  }

  private rayFrom(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return { rect, cursor: { x: event.clientX - rect.left, y: event.clientY - rect.top } };
  }

  private nearestHit(): THREE.Intersection | null {
    const hits = this.raycaster.intersectObjects(this.modelGroup.children, true);
    return hits.find((candidate) => this.shown(candidate.object) && !this.clipped(candidate.point)) ?? null;
  }

  private hit(event: PointerEvent): THREE.Intersection | null {
    this.rayFrom(event);
    return this.nearestHit();
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
    this.hooks.onHover(this.describe(node));
    this.invalidate();
  }

  /** A part's name, and which model it is in once there is more than one. */
  private describe(node: THREE.Object3D): string {
    const name = node.name || node.type;
    const owner = this.models.length > 1 ? this.ownerOf(node) : null;
    return owner ? `${owner.name} · ${name}` : name;
  }

  select(target: THREE.Object3D | number | null) {
    const node = typeof target === 'number' ? (this.scene.getObjectById(target) ?? null) : target;
    // Picking a part of another model is picking that model.
    const owner = this.ownerOf(node);
    if (owner && owner !== this.active) this.activate(owner, true);

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
      name: this.describe(node),
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
    this.layMark.visible = false;
    if (tool !== 'off') this.setHover(null);
    this.annotations.invalidate();
    this.hooks.onMeasure(this.measurements, 0);
    this.invalidate();
  }

  get measureTool() {
    return this.tool;
  }

  private trackSnap(event: PointerEvent) {
    const { cursor, rect } = this.rayFrom(event);
    const hit = this.nearestHit();
    this.snap = hit ? snapToFeature(hit, this.camera, cursor, rect.width, rect.height) : null;
    this.annotations.invalidate();
    this.invalidate();
  }

  private placePoint(event: PointerEvent) {
    this.trackSnap(event);
    if (!this.snap || this.tool === 'off' || this.tool === 'lay' || this.tool === 'move') return;

    this.pending.push(this.snap.point.clone());
    const tool = this.tool;
    if (this.pending.length < POINTS_NEEDED[tool]) {
      this.hooks.onMeasure(this.measurements, this.pending.length);
      this.annotations.invalidate();
      this.invalidate();
      return;
    }

    const measurement = this.buildMeasurement(tool, this.pending, this.snap.kind);
    this.pending = [];
    if (measurement) this.measurements = [...this.measurements, measurement];
    else this.hooks.onMeasureRejected(REJECTION[tool]);
    this.hooks.onMeasure(this.measurements, 0);
    this.annotations.invalidate();
    this.invalidate();
  }

  /**
   * World space is the canonical 8-unit stage; the file's own numbers are what
   * a person came here for. Both are kept — one to draw with, one to read. The
   * holder is a scale and a translation, so its local space is file units in
   * the part's current orientation.
   */
  private toModel(world: THREE.Vector3): THREE.Vector3 {
    if (!this.active) return world.clone();
    return this.active.holder.worldToLocal(world.clone());
  }

  private buildMeasurement(
    tool: MeasuringTool,
    world: THREE.Vector3[],
    lastKind: MeasurePoint['kind'] = 'surface',
  ): Measurement | null {
    const model = world.map((point) => this.toModel(point));
    const points: MeasurePoint[] = world.map((point, i) => ({
      world: [point.x, point.y, point.z],
      model: [model[i].x, model[i].y, model[i].z],
      kind: lastKind,
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

    if (tool === 'angle') {
      const degrees = angleAt(model[0], model[1], model[2]);
      if (degrees === null) return null;
      return { id, tool, points, value: degrees };
    }

    const circle = circleThrough(model[0], model[1], model[2]);
    if (!circle) return null;
    return { id, tool, points, value: circle.radius * 2 };
  }

  /**
   * Places a measurement from points in the file's own units, without clicks.
   * The landing page uses it to show a real dimension on its demo part.
   */
  addMeasurement(tool: MeasuringTool, modelPoints: [number, number, number][]): Measurement | null {
    const holder = this.active?.holder;
    if (!holder || modelPoints.length !== POINTS_NEEDED[tool]) return null;
    const world = modelPoints.map((p) => holder.localToWorld(new THREE.Vector3(...p)));
    const measurement = this.buildMeasurement(tool, world, 'vertex');
    if (!measurement) return null;
    this.measurements = [...this.measurements, measurement];
    this.hooks.onMeasure(this.measurements, this.pending.length);
    this.annotations.invalidate();
    this.invalidate();
    return measurement;
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
      } else if (measurement.tool === 'angle') {
        // Out along the bisector, just past the arc.
        const [a, vertex, b] = points;
        const u = a.clone().sub(vertex);
        const v = b.clone().sub(vertex);
        const reach = Math.min(u.length(), v.length()) * 0.55;
        const bisector = u.normalize().add(v.normalize());
        if (bisector.lengthSq() < 1e-12) bisector.copy(u);
        anchor.copy(vertex).addScaledVector(bisector.normalize(), reach);
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
   * canvas colour is painted in for the capture so the PNG matches the viewport
   * rather than arriving with a transparent hole where the backdrop was.
   */
  screenshot(scale = 2): string {
    const { width, height } = this.renderer.getSize(new THREE.Vector2());
    const ratio = this.renderer.getPixelRatio();
    const background = this.scene.background;
    const canvasColour =
      getComputedStyle(this.canvas).getPropertyValue('--canvas').trim() ||
      getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() ||
      '#54545a';

    this.scene.background = new THREE.Color(canvasColour);
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

  /* ------------------------------------------------------------- loop ---- */

  resize() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.rig.setAspect(width / height);

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
    this.partSink = null;
    this.clearModel();
    this.rig.dispose();
    this.annotations.dispose();
    this.section.dispose();
    this.layerContours.geometry.dispose();
    (this.layerContours.material as THREE.Material).dispose();
    this.stage.dispose();
    this.selectionMark.dispose();
    this.hoverMark.dispose();
    this.layMark.geometry.dispose();
    (this.layMark.material as THREE.Material).dispose();
    [this.wire, this.surfaceAngle, this.edgeMaterial].forEach((m) => m.dispose());
    this.renderer.dispose();
  }
}
