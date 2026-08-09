import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Every model is scaled to this diagonal so lighting and the grid behave. */
export const CANONICAL = 8;

/* --- the stage -------------------------------------------------------------
   A model standing on a plate reads as an object; the same model on an endless
   grid reads as a shape adrift. The plate is three times the canonical diagonal
   — the proportion a 256 mm print bed has to a typical print — and the grid
   divides it into cells one working unit across, so cells stay countable at any
   zoom. */
const PLATE_SIZE = CANONICAL * 3;
const PLATE_CORNER = 1.1;
const PLATE_DIVISIONS = PLATE_SIZE;

export type ThemeName = 'dark' | 'light';

/**
 * The stage palette. These are three.js materials rather than CSS, so this table
 * owns them outright — styles/tokens.css owns the backdrop gradient behind them
 * and nothing is duplicated across the two.
 *
 * `mark` is the amber every authored thing wears: the selection marker and the
 * measuring annotations. The model's own colours and the axis triad are the only
 * other colours on stage, so anything amber is by definition something the
 * person put there.
 */
const SKIN = {
  dark: {
    plate: 0x43464d,
    edge: 0x676b75,
    grid: 0x53565e,
    gridMajor: 0x44464d,
    shadow: 0.36,
    mark: 0xffb224,
    ghost: 0xffb224,
    edgeInk: 0x0b0d12,
    edgeOpacity: 0.52,
  },
  light: {
    plate: 0xfcfcfd,
    edge: 0xb4b9c2,
    grid: 0xd3d6dc,
    gridMajor: 0xb9bdc5,
    shadow: 0.19,
    mark: 0xb45e06,
    ghost: 0xb45e06,
    edgeInk: 0x1d2126,
    edgeOpacity: 0.4,
  },
} as const;

export type Skin = (typeof SKIN)[ThemeName];

/** The plate outline, as a closed path in XY — laid flat by the caller. */
function plateOutline(size: number, radius: number): THREE.Shape {
  const h = size / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-h + radius, -h);
  shape.lineTo(h - radius, -h);
  shape.quadraticCurveTo(h, -h, h, -h + radius);
  shape.lineTo(h, h - radius);
  shape.quadraticCurveTo(h, h, h - radius, h);
  shape.lineTo(-h + radius, h);
  shape.quadraticCurveTo(-h, h, -h, h - radius);
  shape.lineTo(-h, -h + radius);
  shape.quadraticCurveTo(-h, -h, -h + radius, -h);
  shape.closePath();
  return shape;
}

/**
 * Everything on stage that is not the model: the plate it stands on and the
 * light that falls on it. The Engine owns the model and the camera; this owns
 * the room they are in.
 *
 * One lighting rig, tuned to show a surface honestly. Presets and sliders are
 * for making a model look good in a picture; this app is for reading its size.
 */
export class Stage {
  readonly group = new THREE.Group();

  private readonly plate: THREE.Mesh;
  private readonly plateEdge: THREE.LineLoop;
  private grid: THREE.GridHelper;
  private readonly ground: THREE.Mesh;

  private readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;

  private theme: ThemeName = 'dark';
  private shadowsOn = true;

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    const outline = plateOutline(PLATE_SIZE, PLATE_CORNER);
    const skin = SKIN[this.theme];

    // Unlit, so the plate stays an even field instead of catching the key
    // light's hotspot and reading as a fifth surface in the model.
    this.plate = new THREE.Mesh(
      new THREE.ShapeGeometry(outline),
      new THREE.MeshBasicMaterial({ color: skin.plate }),
    );
    this.plate.rotation.x = -Math.PI / 2;
    this.plate.position.y = -0.006;
    this.plate.renderOrder = -2;

    this.plateEdge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(outline.getPoints(16)),
      new THREE.LineBasicMaterial({ color: skin.edge }),
    );
    this.plateEdge.rotation.x = -Math.PI / 2;
    this.plateEdge.position.y = -0.005;

    this.grid = new THREE.GridHelper(PLATE_SIZE, PLATE_DIVISIONS, skin.gridMajor, skin.grid);
    this.dressGrid();

    // The shadow catcher takes the plate's own shape, so nothing casts onto the
    // backdrop past the plate edge.
    this.ground = new THREE.Mesh(
      new THREE.ShapeGeometry(outline),
      new THREE.ShadowMaterial({ opacity: skin.shadow }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.003;
    this.ground.receiveShadow = true;

    this.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.key.position.set(6, 11, 7);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 0.02;
    const shadowCam = this.key.shadow.camera;
    shadowCam.near = 0.5;
    shadowCam.far = 60;
    shadowCam.left = shadowCam.bottom = -12;
    shadowCam.right = shadowCam.top = 12;

    this.fill = new THREE.DirectionalLight(0xdfe6f2, 0.35);
    this.fill.position.set(-7, 4, -5);
    this.rim = new THREE.DirectionalLight(0xffffff, 0.4);
    this.rim.position.set(-3, 6, -9);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 1;

    this.group.add(
      this.plate,
      this.plateEdge,
      this.grid,
      this.ground,
      this.key,
      this.fill,
      this.rim,
      new THREE.AmbientLight(0xffffff, 0.22),
    );
  }

  get skin(): Skin {
    return SKIN[this.theme];
  }

  private dressGrid() {
    const material = this.grid.material as THREE.Material;
    material.transparent = true;
    material.opacity = 0.55;
    this.grid.position.y = -0.001;
  }

  setGridVisible(visible: boolean) {
    this.grid.visible = visible;
    this.plate.visible = visible;
    this.plateEdge.visible = visible;
  }

  setShadowsEnabled(enabled: boolean) {
    this.shadowsOn = enabled;
    this.ground.visible = enabled;
    this.key.castShadow = enabled;
  }

  get shadowsEnabled() {
    return this.shadowsOn;
  }

  setTheme(theme: ThemeName) {
    this.theme = theme;
    const skin = SKIN[theme];

    // GridHelper bakes its two colours into a vertex attribute, so recolouring
    // means swapping the geometry — there is no colour to set.
    const next = new THREE.GridHelper(PLATE_SIZE, PLATE_DIVISIONS, skin.gridMajor, skin.grid);
    this.grid.geometry.dispose();
    const previous = this.grid.material;
    (Array.isArray(previous) ? previous : [previous]).forEach((m) => m.dispose());
    this.grid.geometry = next.geometry;
    this.grid.material = next.material;
    this.dressGrid();

    (this.plate.material as THREE.MeshBasicMaterial).color.setHex(skin.plate);
    (this.plateEdge.material as THREE.LineBasicMaterial).color.setHex(skin.edge);
    (this.ground.material as THREE.ShadowMaterial).opacity = skin.shadow;
  }

  dispose() {
    this.group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      const list = Array.isArray(material) ? material : material ? [material] : [];
      list.forEach((m) => m.dispose());
    });
    this.scene.environment?.dispose();
  }
}
