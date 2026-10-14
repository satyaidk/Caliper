import * as THREE from 'three';
import type { LoadContext, LoadResult } from '@/types';

interface DotBimMesh {
  mesh_id: number;
  coordinates: number[];
  indices: number[];
}

interface DotBimElement {
  mesh_id: number;
  vector: { x: number; y: number; z: number };
  rotation: { qx: number; qy: number; qz: number; qw: number };
  color?: { r: number; g: number; b: number; a: number };
  type?: string;
  guid?: string;
  info?: Record<string, string>;
}

interface DotBimFile {
  schema_version?: string;
  meshes: DotBimMesh[];
  elements: DotBimElement[];
}

/**
 * dotbim is a small JSON schema: a pool of meshes plus elements that place them
 * with a position, a quaternion and an RGBA colour. Instances share geometry,
 * so one mesh reused a thousand times stays one buffer.
 */
export async function loadDotBim(file: File, ctx: LoadContext): Promise<LoadResult> {
  ctx.onProgress(null, 'Parsing dotbim');

  let doc: DotBimFile;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    throw new Error('The .bim file is not valid JSON.');
  }
  if (!Array.isArray(doc.meshes) || !Array.isArray(doc.elements)) {
    throw new Error('The .bim file is missing its meshes or elements array.');
  }

  const geometries = new Map<number, THREE.BufferGeometry>();
  for (const mesh of doc.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(Float32Array.from(mesh.coordinates), 3),
    );
    geometry.setIndex(mesh.indices);
    geometry.computeVertexNormals();
    geometries.set(mesh.mesh_id, geometry);
  }

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const root = new THREE.Group();
  root.name = file.name;

  // Group by element type so the scene tree reads like a building, not a soup.
  const buckets = new Map<string, THREE.Group>();

  doc.elements.forEach((element, index) => {
    const geometry = geometries.get(element.mesh_id);
    if (!geometry) return;

    const c = element.color ?? { r: 200, g: 200, b: 200, a: 255 };
    const key = `${c.r},${c.g},${c.b},${c.a}`;
    let material = materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(c.r / 255, c.g / 255, c.b / 255).convertSRGBToLinear(),
        transparent: c.a < 255,
        opacity: c.a / 255,
        roughness: 0.72,
        metalness: 0.02,
        side: c.a < 255 ? THREE.DoubleSide : THREE.FrontSide,
      });
      materials.set(key, material);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = element.info?.Name ?? element.type ?? `Element ${index + 1}`;
    mesh.position.set(element.vector.x, element.vector.y, element.vector.z);
    mesh.quaternion.set(
      element.rotation.qx,
      element.rotation.qy,
      element.rotation.qz,
      element.rotation.qw,
    );
    mesh.userData = { guid: element.guid, type: element.type, ...element.info };

    const bucketName = element.type || 'Untyped';
    let bucket = buckets.get(bucketName);
    if (!bucket) {
      bucket = new THREE.Group();
      bucket.name = bucketName;
      buckets.set(bucketName, bucket);
      root.add(bucket);
    }
    bucket.add(mesh);

    if (index % 500 === 0) ctx.onProgress(index / doc.elements.length, 'Placing elements');
  });

  if (!root.children.length) throw new Error('No placeable elements were found in the file.');
  return { object: root, hasAuthoredMaterials: true };
}
