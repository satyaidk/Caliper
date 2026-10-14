import * as THREE from 'three';

/**
 * The selection marker: a faint cage around the part with solid brackets at its
 * corners.
 *
 * A full wire box in the accent colour is most of a second model on screen, and
 * on a single-mesh file it wraps the whole thing and says nothing. Corners alone
 * are quieter but they read as debris — eight little crosses hanging in space,
 * because an axis-aligned box has corners well clear of an L-shaped part. The
 * cage is what ties them together: barely there, but enough that the brackets
 * are obviously the corners *of something*.
 */

const CAGE_ALPHA = 0.2;

/** Index pairs for the twelve edges of a box, over the eight corner order below. */
const EDGES = [
  [0, 1], [1, 3], [3, 2], [2, 0],
  [4, 5], [5, 7], [7, 6], [6, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export class Bracket {
  readonly group = new THREE.Group();

  private readonly corners: THREE.LineSegments;
  private readonly cage: THREE.LineSegments;
  private readonly cornerMaterial: THREE.LineBasicMaterial;
  private readonly cageMaterial: THREE.LineBasicMaterial;

  constructor(colour: number, opacity = 1) {
    this.cornerMaterial = new THREE.LineBasicMaterial({
      color: colour,
      depthTest: false,
      transparent: true,
      opacity,
    });
    this.cageMaterial = new THREE.LineBasicMaterial({
      color: colour,
      depthTest: false,
      transparent: true,
      opacity: opacity * CAGE_ALPHA,
    });

    this.corners = new THREE.LineSegments(new THREE.BufferGeometry(), this.cornerMaterial);
    this.cage = new THREE.LineSegments(new THREE.BufferGeometry(), this.cageMaterial);
    for (const part of [this.cage, this.corners]) {
      part.frustumCulled = false;
      this.group.add(part);
    }
    this.group.visible = false;
    this.group.renderOrder = 6;
  }

  get visible() {
    return this.group.visible;
  }

  setColour(hex: number) {
    this.cornerMaterial.color.setHex(hex);
    this.cageMaterial.color.setHex(hex);
  }

  hide() {
    this.group.visible = false;
  }

  /** Wraps `node`'s world bounds, or hides when there is nothing to wrap. */
  show(node: THREE.Object3D | null) {
    if (!node) {
      this.hide();
      return;
    }

    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) {
      this.hide();
      return;
    }

    const size = box.getSize(new THREE.Vector3());
    const reach = Math.max(size.length() * 0.1, 1e-5);
    // A bracket never runs past the halfway point of its own edge, so a thin
    // part gets short brackets instead of two that meet in the middle.
    const arm = [
      Math.min(reach, size.x / 2),
      Math.min(reach, size.y / 2),
      Math.min(reach, size.z / 2),
    ];

    const xs = [box.min.x, box.max.x];
    const ys = [box.min.y, box.max.y];
    const zs = [box.min.z, box.max.z];

    const cornerPoints: number[] = [];
    const corners: THREE.Vector3[] = [];

    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          const x = xs[i];
          const y = ys[j];
          const z = zs[k];
          corners.push(new THREE.Vector3(x, y, z));
          const sx = i === 0 ? 1 : -1;
          const sy = j === 0 ? 1 : -1;
          const sz = k === 0 ? 1 : -1;
          cornerPoints.push(x, y, z, x + sx * arm[0], y, z);
          cornerPoints.push(x, y, z, x, y + sy * arm[1], z);
          cornerPoints.push(x, y, z, x, y, z + sz * arm[2]);
        }
      }
    }

    const cagePoints: number[] = [];
    for (const [a, b] of EDGES) {
      cagePoints.push(corners[a].x, corners[a].y, corners[a].z);
      cagePoints.push(corners[b].x, corners[b].y, corners[b].z);
    }

    write(this.corners, cornerPoints);
    write(this.cage, cagePoints);
    this.group.visible = true;
  }

  dispose() {
    this.corners.geometry.dispose();
    this.cage.geometry.dispose();
    this.cornerMaterial.dispose();
    this.cageMaterial.dispose();
  }
}

function write(target: THREE.LineSegments, points: number[]) {
  target.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  target.geometry = geometry;
}
