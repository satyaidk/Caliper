import * as THREE from 'three';
import type { FilamentColor } from '@/types';
import { creasedNormals } from '@/viewer/normals';
import type { ThreeMfResult } from './threemf';
import { CREASE_LIMIT, Z_UP_TO_Y_UP } from './conventions';

/**
 * Turns a parsed 3MF into meshes, and keeps Bambu Studio's filament slots
 * editable afterwards.
 *
 * Slots are recorded the same way whichever way a part is coloured, which is
 * what the AMS colour editing below relies on:
 *
 * - a part with faces in different slots gets per-vertex colours, and
 *   `geometry.userData.caliperBambuFilamentIndices` holds each vertex's slot;
 * - a part in one slot keeps a plain material with that colour, and
 *   `material.userData.caliperBambuFilamentIndex` holds the slot;
 * - `root.userData.caliperBambuFilamentColors` lists the slots in use.
 *
 * Colours a file defines itself (3MF materials, per-face colour groups) win
 * over the project palette, so a model's own colours are never tinted.
 */

export function threeMfObject(parsed: ThreeMfResult, name: string): { object: THREE.Group; coloured: boolean } {
  const root = new THREE.Group();
  root.name = name;
  const palette = parsed.palette ?? [];
  const used = new Set<number>();
  let coloured = false;

  for (const part of parsed.parts) {
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    geometry.rotateX(Z_UP_TO_Y_UP);
    const triangles = part.positions.length / 9;
    // The geometry stays non-indexed, so vertex 3t, 3t+1, 3t+2 is triangle t.
    if (triangles < CREASE_LIMIT) geometry = creasedNormals(geometry, Math.PI / 6);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial();

    const slots = part.colours ? null : part.filament;
    const single = slots && slots.every((slot) => slot === slots[0]) && slots[0] >= 0 ? slots[0] : null;
    if (part.colours) {
      geometry.setAttribute('color', new THREE.BufferAttribute(part.colours, 3));
      material.vertexColors = true;
      coloured = true;
    } else if (single !== null && palette[single]) {
      material.color.set(palette[single]);
      material.userData.caliperBambuFilamentIndex = single;
      used.add(single);
      coloured = true;
    } else if (slots) {
      const fallback = new THREE.Color(part.colour ?? '#ffffff');
      const colours = new Float32Array(triangles * 9);
      const indices = new Int16Array(triangles * 3).fill(-1);
      for (let t = 0; t < triangles; t++) {
        const slot = slots[t];
        const colour = slot >= 0 && palette[slot] ? new THREE.Color(palette[slot]) : fallback;
        if (slot >= 0) used.add(slot);
        indices.fill(slot, t * 3, t * 3 + 3);
        for (let corner = 0; corner < 3; corner++) colour.toArray(colours, t * 9 + corner * 3);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      geometry.userData.caliperBambuFilamentIndices = indices;
      material.vertexColors = true;
      coloured = true;
    } else if (part.colour) {
      material.color.set(part.colour);
      coloured = true;
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = part.name;
    root.add(mesh);
  }

  root.userData.caliperBambuFilamentColors = [...used]
    .sort((a, b) => a - b)
    .map((index) => ({ index, color: palette[index] }));
  return { object: root, coloured };
}

export function getBambu3mfFilamentColors(root: THREE.Object3D): FilamentColor[] {
  const colors = root.userData.caliperBambuFilamentColors as FilamentColor[] | undefined;
  return Array.isArray(colors) ? colors : [];
}

/** Update every mesh paint assignment that uses one saved AMS palette slot. */
export function setBambuFilamentColor(
  root: THREE.Object3D,
  paletteIndex: number,
  hex: string,
): boolean {
  if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 0 || !/^#[\da-f]{6}$/i.test(hex)) return false;

  const color = new THREE.Color(hex);
  let changed = false;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    const indices = object.geometry.userData.caliperBambuFilamentIndices as Int16Array | undefined;
    const attribute = object.geometry.getAttribute('color');
    if (indices && attribute && indices.length === attribute.count) {
      let geometryChanged = false;
      for (let vertex = 0; vertex < indices.length; vertex++) {
        if (indices[vertex] === paletteIndex) {
          attribute.setXYZ(vertex, color.r, color.g, color.b);
          changed = true;
          geometryChanged = true;
        }
      }
      if (geometryChanged) attribute.needsUpdate = true;
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material.userData.caliperBambuFilamentIndex !== paletteIndex) continue;
      const colored = material as THREE.Material & { color?: THREE.Color };
      if (colored.color) {
        colored.color.set(hex);
        changed = true;
      }
    }
  });
  return changed;
}

/** Reassigns all faces in one selected object to a single imported AMS slot. */
export function setBambuObjectFilamentColor(
  root: THREE.Object3D,
  objectId: number,
  paletteIndex: number,
  hex: string,
): boolean {
  if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 0 || !/^#[\da-f]{6}$/i.test(hex)) return false;
  const target = root.getObjectById(objectId);
  if (!(target instanceof THREE.Mesh)) return false;

  const color = new THREE.Color(hex);
  const sourceGeometry = target.geometry;
  const sourceIndices = sourceGeometry.userData.caliperBambuFilamentIndices as Int16Array | undefined;
  const sourceAttribute = sourceGeometry.getAttribute('color');
  if (sourceIndices && sourceAttribute && sourceIndices.length === sourceAttribute.count) {
    let shared = false;
    root.traverse((node) => {
      if (node !== target && (node as THREE.Mesh).isMesh && (node as THREE.Mesh).geometry === sourceGeometry) {
        shared = true;
      }
    });
    if (shared) {
      const geometry = sourceGeometry.clone();
      const indices = sourceIndices.slice();
      geometry.userData = {
        ...geometry.userData,
        caliperBambuFilamentIndices: indices,
      };
      target.geometry = geometry;
    }

    const indices = target.geometry.userData.caliperBambuFilamentIndices as Int16Array;
    const attribute = target.geometry.getAttribute('color');
    indices.fill(paletteIndex);
    for (let vertex = 0; vertex < indices.length; vertex++) {
      attribute.setXYZ(vertex, color.r, color.g, color.b);
    }
    attribute.needsUpdate = true;
    return true;
  }

  const sourceMaterials = Array.isArray(target.material) ? target.material : [target.material];
  const sharedMaterials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (node === target || !(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (sourceMaterials.includes(material)) sharedMaterials.add(material);
    }
  });

  const clones = new Map<THREE.Material, THREE.Material>();
  const materials = sourceMaterials.map((material) => {
    if (!sharedMaterials.has(material)) return material;
    const existing = clones.get(material);
    if (existing) return existing;
    const clone = material.clone();
    clones.set(material, clone);
    return clone;
  });
  target.material = Array.isArray(target.material) ? materials : materials[0] ?? target.material;
  let changed = false;
  for (const material of new Set(materials)) {
    const colored = material as THREE.Material & { color?: THREE.Color };
    if (!colored.color) continue;
    colored.color.set(hex);
    material.userData.caliperBambuFilamentIndex = paletteIndex;
    changed = true;
  }
  return changed;
}

/** Current one-slot assignment for an object-list row; null means mixed. */
export function bambuObjectFilamentIndex(object: THREE.Object3D): number | null | undefined {
  let found: number | null | undefined;
  let mixed = false;
  const readMesh = (node: THREE.Mesh) => {
    const indices = node.geometry.userData.caliperBambuFilamentIndices as Int16Array | undefined;
    if (indices?.length) {
      for (const index of indices) {
        if (index < 0) continue;
        if (found === undefined) found = index;
        else if (found !== index) mixed = true;
      }
    } else {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        const index = material.userData.caliperBambuFilamentIndex;
        if (typeof index !== 'number') continue;
        if (found === undefined) found = index;
        else if (found !== index) mixed = true;
      }
    }
  };
  if (object instanceof THREE.Mesh) readMesh(object);
  return mixed ? null : found;
}
