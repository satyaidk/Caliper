import * as THREE from 'three';
import type { Dimensions, SceneStats, TreeNode } from '@/types';

export function computeStats(root: THREE.Object3D): SceneStats {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const geometries = new Set<THREE.BufferGeometry>();
  let objects = 0;
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;

  root.traverse((node) => {
    objects++;
    const geo = (node as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geo?.isBufferGeometry) return;

    const isMesh = (node as THREE.Mesh).isMesh;
    if (isMesh) meshes++;

    const position = geo.getAttribute('position');
    if (position) {
      vertices += position.count;
      if (isMesh) {
        const indexed = geo.getIndex();
        triangles += (indexed ? indexed.count : position.count) / 3;
      }
    }
    geometries.add(geo);

    const material = (node as THREE.Mesh).material;
    const list = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of list) {
      materials.add(m);
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
      }
    }
  });

  return {
    objects,
    meshes,
    triangles: Math.round(triangles),
    vertices,
    materials: materials.size,
    textures: textures.size,
  };
}

export function computeDimensions(root: THREE.Object3D): Dimensions {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    return { x: 0, y: 0, z: 0, diagonal: 0, center: [0, 0, 0] };
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    x: size.x,
    y: size.y,
    z: size.z,
    diagonal: size.length(),
    center: [center.x, center.y, center.z],
  };
}

function labelFor(node: THREE.Object3D): string {
  if (node.name) return node.name;
  if ((node as THREE.Mesh).isMesh) return 'Mesh';
  if ((node as THREE.Points).isPoints) return 'Points';
  if ((node as THREE.Line).isLine) return 'Line';
  return node.type;
}

function trianglesOf(node: THREE.Object3D): number {
  let total = 0;
  node.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const geo = (child as THREE.Mesh).geometry as THREE.BufferGeometry;
    const index = geo.getIndex();
    const position = geo.getAttribute('position');
    if (position) total += (index ? index.count : position.count) / 3;
  });
  return Math.round(total);
}

/**
 * The tree mirrors the file's own hierarchy. Very wide groups are truncated so
 * a 40,000-element IFC does not lock the panel; the count still shows the truth.
 */
export function buildTree(root: THREE.Object3D, maxChildren = 400): TreeNode {
  const walk = (node: THREE.Object3D, depth: number): TreeNode => {
    const visible = depth < 6 ? node.children.slice(0, maxChildren) : [];
    return {
      id: String(node.id),
      name: labelFor(node),
      type: node.type,
      triangles: trianglesOf(node),
      children: visible.map((child) => walk(child, depth + 1)),
    };
  };
  return walk(root, 0);
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    const list = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of list) {
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}
