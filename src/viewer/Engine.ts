import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { disposeObject } from './analyze';
import { setActiveRenderer } from './renderer-registry';
import type { ClipAxis, ProjectionMode, RenderMode, ViewPreset } from '@/types';

/** Every model is scaled to this diagonal so lighting, grid and clipping behave. */
const CANONICAL = 8;
const EDGE_BUDGET = 350_000;

export interface SelectionInfo {
  id: number;
  name: string;
  type: string;
  triangles: number;
  vertices: number;
  material: string;
  position: [number, number, number];
}

export interface FrameInfo {
  fps: number;
  calls: number;
  triangles: number;
}

export interface EngineHooks {
  onSelect(info: SelectionInfo | null): void;
  onFrame(info: FrameInfo): void;
}

interface MeshMemory {
  home: THREE.Vector3;
  direction: THREE.Vector3;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();

  private readonly perspective: THREE.PerspectiveCamera;
  private readonly orthographic: THREE.OrthographicCamera;
  private camera: THREE.Camera;
  private readonly controls: OrbitControls;

  private readonly modelGroup = new THREE.Group();
  private readonly edgeGroup = new THREE.Group();
  private readonly helpers = new THREE.Group();
  /** Wraps the loaded object so normalisation never fights the file's own transform. */
  private holder: THREE.Group | null = null;
  private readonly modelCenter = new THREE.Vector3();

  private grid!: THREE.GridHelper;
  private axes!: THREE.AxesHelper;
  private ground!: THREE.Mesh;
  private sun!: THREE.DirectionalLight;
  private selectionBox!: THREE.BoxHelper;

  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private clipEnabled = false;
  private clipAxis: ClipAxis = 'x';
  private clipT = 1;

  private readonly memory = new Map<number, MeshMemory>();
  private explodeAmount = 0;
  private modelRadius = CANONICAL / 2;

  private renderMode: RenderMode = 'shaded';
  private overrideMaterial: THREE.Material | null = null;
  private authoredMaterials = true;
  private tint = new THREE.Color('#b8c3d4');

  private raf = 0;
  private frames = 0;
  private lastSample = performance.now();
  private readonly clock = new THREE.Clock();
  private disposed = false;

  private readonly pointer = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: EngineHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;

    this.perspective = new THREE.PerspectiveCamera(42, 1, 0.01, 4000);
    this.perspective.position.set(9, 6.5, 11);
    this.orthographic = new THREE.OrthographicCamera(-8, 8, 8, -8, -2000, 4000);
    this.orthographic.position.copy(this.perspective.position);
    this.camera = this.perspective;

    this.controls = new OrbitControls(this.perspective, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.maxDistance = 900;
    this.controls.minDistance = 0.05;
    this.controls.autoRotateSpeed = 1.1;

    setActiveRenderer(this.renderer);

    this.scene.add(this.modelGroup, this.edgeGroup, this.helpers);
    this.buildEnvironment();
    this.buildHelpers();
    this.bindPointer();

    this.animate = this.animate.bind(this);
    this.raf = requestAnimationFrame(this.animate);
  }

  /* ------------------------------------------------------------ setup ---- */

  private buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.position.set(6, 11, 7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    const cam = this.sun.shadow.camera;
    cam.near = 0.5;
    cam.far = 60;
    cam.left = cam.bottom = -12;
    cam.right = cam.top = 12;
    this.scene.add(this.sun, new THREE.AmbientLight(0xffffff, 0.22));
  }

  private buildHelpers() {
    this.grid = new THREE.GridHelper(40, 40, 0x3a4150, 0x2b303a);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.grid.position.y = -0.001;

    this.axes = new THREE.AxesHelper(2.2);
    this.axes.visible = false;
    (this.axes.material as THREE.Material).depthTest = false;
    this.axes.renderOrder = 5;

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.002;
    this.ground.receiveShadow = true;

    this.selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x5a9cf8);
    this.selectionBox.visible = false;
    (this.selectionBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.selectionBox.renderOrder = 6;

    this.helpers.add(this.grid, this.axes, this.ground, this.selectionBox);
  }

  private bindPointer() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved > 5) return; // an orbit, not a click
      this.pick(e);
    });
  }

  /* ------------------------------------------------------------ model ---- */

  setModel(object: THREE.Object3D, hasAuthoredMaterials: boolean) {
    this.clearModel();
    this.authoredMaterials = hasAuthoredMaterials;

    // The loaded root keeps whatever transform its format gave it. All framing
    // happens on a wrapper, so a file that places its geometry far from the
    // origin still lands centred on the grid.
    const holder = new THREE.Group();
    holder.name = '__caliper_holder';
    holder.add(object);

    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = CANONICAL / (size.length() || 1);

    holder.scale.setScalar(scale);
    holder.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

    this.holder = holder;
    this.modelGroup.add(holder);
    this.modelRadius = CANONICAL / 2;
    this.modelCenter.set(0, (size.y * scale) / 2, 0);

    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
      }
    });

    this.captureExplodeMemory();
    if (!hasAuthoredMaterials) this.applyTint();
    this.applyRenderMode();
    this.applyClipping();
    this.frameAll(true);
  }

  clearModel() {
    for (const child of [...this.modelGroup.children]) {
      this.modelGroup.remove(child);
      disposeObject(child);
    }
    this.clearEdges();
    this.holder = null;
    this.memory.clear();
    this.explodeAmount = 0;
    this.modelCenter.set(0, 0, 0);
    this.selectionBox.visible = false;
    this.hooks.onSelect(null);
  }

  /** The object the loader produced, without Caliper's framing wrapper. */
  get modelRoot(): THREE.Object3D | null {
    return this.holder?.children[0] ?? null;
  }

  /**
   * Records where each part sits and which way it should travel when the
   * assembly is pulled apart — outward from the model's own centre, not from
   * the world origin, so a tall model does not fan out from its feet.
   */
  private captureExplodeMemory() {
    if (!this.holder) return;
    const world = new THREE.Vector3();
    const centre = new THREE.Box3().setFromObject(this.holder).getCenter(new THREE.Vector3());

    this.holder.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh && !(node as THREE.Points).isPoints) return;
      new THREE.Box3().setFromObject(node).getCenter(world);
      const direction = world.clone().sub(centre);
      if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0);
      this.memory.set(node.id, {
        home: node.position.clone(),
        direction: direction.normalize(),
      });
    });
  }

  /* ------------------------------------------------------- appearance ---- */

  setRenderMode(mode: RenderMode) {
    this.renderMode = mode;
    this.applyRenderMode();
  }

  private applyRenderMode() {
    this.overrideMaterial?.dispose();
    this.overrideMaterial = null;
    this.scene.overrideMaterial = null;
    this.clearEdges();

    switch (this.renderMode) {
      case 'wireframe':
        this.overrideMaterial = new THREE.MeshBasicMaterial({
          color: 0x8fb6f0,
          wireframe: true,
          transparent: true,
          opacity: 0.75,
        });
        break;
      case 'xray':
        this.overrideMaterial = new THREE.MeshBasicMaterial({
          color: 0x7fb2ff,
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        });
        break;
      case 'normals':
        this.overrideMaterial = new THREE.MeshNormalMaterial({ flatShading: false });
        break;
      case 'edges':
        this.buildEdges();
        break;
      default:
        break;
    }

    if (this.overrideMaterial) {
      this.overrideMaterial.clippingPlanes = this.clipEnabled ? [this.clipPlane] : null;
      this.scene.overrideMaterial = this.overrideMaterial;
    }
  }

  /** Returns false when the model is too dense to outline without stalling. */
  private buildEdges(): boolean {
    let budget = EDGE_BUDGET;
    const material = new THREE.LineBasicMaterial({
      color: 0x0b0d12,
      transparent: true,
      opacity: 0.42,
      clippingPlanes: this.clipEnabled ? [this.clipPlane] : undefined,
    });

    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || budget <= 0) return;
      const index = mesh.geometry.getIndex();
      const tris = (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
      budget -= tris;
      if (budget <= 0) return;

      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 32), material);
      mesh.updateWorldMatrix(true, false);
      lines.applyMatrix4(mesh.matrixWorld);
      this.edgeGroup.add(lines);
    });

    return budget > 0;
  }

  private clearEdges() {
    for (const child of [...this.edgeGroup.children]) {
      this.edgeGroup.remove(child);
      (child as THREE.LineSegments).geometry.dispose();
    }
  }

  setTint(hex: string) {
    this.tint.set(hex);
    if (!this.authoredMaterials) this.applyTint();
  }

  get canTint() {
    return !this.authoredMaterials;
  }

  private applyTint() {
    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) {
        const standard = m as THREE.MeshStandardMaterial;
        if (standard.isMeshStandardMaterial && !standard.vertexColors) {
          standard.color.copy(this.tint);
          standard.metalness = 0.12;
          standard.roughness = 0.45;
        }
      }
    });
  }

  setExposure(value: number) {
    this.renderer.toneMappingExposure = value;
  }

  setEnvironmentIntensity(value: number) {
    this.scene.environmentIntensity = value;
    this.sun.intensity = 0.4 + value * 1.2;
  }

  setGridVisible(v: boolean) {
    this.grid.visible = v;
  }

  setAxesVisible(v: boolean) {
    this.axes.visible = v;
  }

  setShadowsEnabled(v: boolean) {
    this.renderer.shadowMap.enabled = v;
    this.ground.visible = v;
    this.sun.castShadow = v;
    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = v;
    });
    this.renderer.shadowMap.needsUpdate = true;
  }

  setAutoRotate(v: boolean) {
    this.controls.autoRotate = v;
  }

  setTheme(theme: 'dark' | 'light') {
    const line = theme === 'dark' ? 0x2b303a : 0xc9cfda;
    const major = theme === 'dark' ? 0x3a4150 : 0xaeb6c4;
    const next = new THREE.GridHelper(40, 40, major, line);

    this.grid.geometry.dispose();
    const previous = this.grid.material;
    (Array.isArray(previous) ? previous : [previous]).forEach((m) => m.dispose());

    this.grid.geometry = next.geometry;
    this.grid.material = next.material;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    (this.ground.material as THREE.ShadowMaterial).opacity = theme === 'dark' ? 0.3 : 0.17;
    if (this.renderMode === 'edges') {
      this.clearEdges();
      this.buildEdges();
    }
  }

  /* ---------------------------------------------------------- explode ---- */

  /** A model with one part has nothing to pull apart, so the control is inert. */
  get canExplode() {
    return this.memory.size > 1;
  }

  setExplode(amount: number) {
    if (!this.canExplode) {
      this.explodeAmount = 0;
      return;
    }
    this.explodeAmount = amount;
    const offset = new THREE.Vector3();
    for (const [id, memo] of this.memory) {
      const node = this.scene.getObjectById(id);
      if (!node) continue;
      offset.copy(memo.direction).multiplyScalar(amount * this.modelRadius * 1.6);
      node.position.copy(memo.home).add(offset);
    }
    if (this.renderMode === 'edges') {
      this.clearEdges();
      this.buildEdges();
    }
    if (this.selectionBox.visible) this.selectionBox.update();
  }

  get explode() {
    return this.explodeAmount;
  }

  /* --------------------------------------------------------- clipping ---- */

  setClipping(enabled: boolean, axis: ClipAxis, t: number) {
    this.clipEnabled = enabled;
    this.clipAxis = axis;
    this.clipT = t;
    this.applyClipping();
  }

  private applyClipping() {
    const normal =
      this.clipAxis === 'x'
        ? new THREE.Vector3(-1, 0, 0)
        : this.clipAxis === 'y'
          ? new THREE.Vector3(0, -1, 0)
          : new THREE.Vector3(0, 0, -1);
    const extent = CANONICAL * 0.62;
    const offset = this.clipAxis === 'y' ? extent * this.clipT : extent * (this.clipT * 2 - 1);

    this.clipPlane.normal.copy(normal);
    this.clipPlane.constant = offset;
    this.renderer.clippingPlanes = this.clipEnabled ? [this.clipPlane] : [];

    // Cut surfaces need back faces, otherwise the interior reads as a hole.
    this.modelGroup.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) {
        m.side = this.clipEnabled ? THREE.DoubleSide : THREE.FrontSide;
        m.needsUpdate = true;
      }
    });
    if (this.overrideMaterial) {
      this.overrideMaterial.clippingPlanes = this.clipEnabled ? [this.clipPlane] : null;
    }
  }

  /* ----------------------------------------------------------- camera ---- */

  setProjection(mode: ProjectionMode) {
    const from = this.camera;
    const to = mode === 'perspective' ? this.perspective : this.orthographic;
    if (from === to) return;

    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    this.camera = to;
    this.controls.object = to;
    this.resize();
    this.fitOrtho();
    this.controls.update();
  }

  private fitOrtho() {
    if (this.camera !== this.orthographic) return;
    const distance = this.orthographic.position.distanceTo(this.controls.target);
    const aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
    const half = distance * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
    this.orthographic.left = -half * aspect;
    this.orthographic.right = half * aspect;
    this.orthographic.top = half;
    this.orthographic.bottom = -half;
    this.orthographic.updateProjectionMatrix();
  }

  frameAll(instant = false) {
    const box = new THREE.Box3().setFromObject(
      this.modelGroup.children.length ? this.modelGroup : this.grid,
    );
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.001);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.perspective.fov / 2))) * 1.08;

    const direction = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize();
    if (direction.lengthSq() < 1e-6 || instant) direction.set(0.72, 0.48, 0.9).normalize();

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.perspective.near = Math.max(radius / 800, 0.005);
    this.perspective.far = radius * 400;
    this.perspective.updateProjectionMatrix();
    this.fitOrtho();
    this.controls.update();
  }

  setView(preset: ViewPreset) {
    const box = new THREE.Box3().setFromObject(
      this.modelGroup.children.length ? this.modelGroup : this.grid,
    );
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.001);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.perspective.fov / 2))) * 1.08;

    const directions: Record<ViewPreset, [number, number, number]> = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      top: [0, 1, 0.0001],
      bottom: [0, -1, 0.0001],
      iso: [0.72, 0.48, 0.9],
    };

    const direction = new THREE.Vector3(...directions[preset]).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.up.set(0, 1, 0);
    this.fitOrtho();
    this.controls.update();
  }

  /* -------------------------------------------------------- selection ---- */

  private pick(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera as THREE.PerspectiveCamera);

    const hits = this.raycaster.intersectObjects(this.modelGroup.children, true);
    const hit = hits.find((h) => h.object.visible);
    if (!hit) {
      this.select(null);
      return;
    }
    this.select(hit.object);
  }

  select(target: THREE.Object3D | number | null) {
    const node =
      typeof target === 'number' ? (this.scene.getObjectById(target) ?? null) : target;

    if (!node) {
      this.selectionBox.visible = false;
      this.hooks.onSelect(null);
      return;
    }

    this.selectionBox.setFromObject(node);
    this.selectionBox.visible = true;

    const mesh = node as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute?.('position');
    const index = geometry?.getIndex?.();
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const world = node.getWorldPosition(new THREE.Vector3());

    this.hooks.onSelect({
      id: node.id,
      name: node.name || node.type,
      type: node.type,
      triangles: position ? Math.round((index ? index.count : position.count) / 3) : 0,
      vertices: position?.count ?? 0,
      material: material ? material.name || material.type : '—',
      position: [world.x, world.y, world.z],
    });
  }

  setNodeVisible(id: number, visible: boolean) {
    const node = this.scene.getObjectById(id);
    if (node) node.visible = visible;
  }

  isolate(id: number) {
    const target = this.scene.getObjectById(id);
    if (!target) return;
    this.modelGroup.traverse((node) => {
      node.visible = node === target || target.getObjectById(node.id) != null;
    });
    let parent = target.parent;
    while (parent) {
      parent.visible = true;
      parent = parent.parent;
    }
  }

  showAll() {
    this.modelGroup.traverse((node) => {
      node.visible = true;
    });
  }

  /* ------------------------------------------------------------ output --- */

  screenshot(scale = 2): string {
    const { width, height } = this.renderer.getSize(new THREE.Vector2());
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(Math.min(ratio * scale, 4));
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    return url;
  }

  async exportGLB(): Promise<Blob> {
    const root = this.modelRoot;
    if (!root) throw new Error('There is no model open to export.');
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(root, { binary: true, onlyVisible: true });
    return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
  }

  exportSTL(): Blob {
    const root = this.modelRoot;
    if (!root) throw new Error('There is no model open to export.');
    const text = new STLExporter().parse(root, { binary: false }) as unknown as string;
    return new Blob([text], { type: 'model/stl' });
  }

  /* ------------------------------------------------------------- loop ---- */

  resize() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.fitOrtho();
  }

  private animate() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);

    this.controls.update(this.clock.getDelta());
    this.renderer.render(this.scene, this.camera);

    this.frames++;
    const now = performance.now();
    if (now - this.lastSample >= 500) {
      this.hooks.onFrame({
        fps: Math.round((this.frames * 1000) / (now - this.lastSample)),
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      });
      this.frames = 0;
      this.lastSample = now;
    }
  }

  dispose() {
    this.disposed = true;
    setActiveRenderer(null);
    cancelAnimationFrame(this.raf);
    this.clearModel();
    this.controls.dispose();
    this.overrideMaterial?.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
  }
}
