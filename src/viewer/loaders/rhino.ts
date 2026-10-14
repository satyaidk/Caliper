import * as THREE from 'three';
import { Rhino3dmLoader } from 'three/examples/jsm/loaders/3DMLoader.js';
import { CDN } from '@/lib/cdn';
import type { LoadContext, LoadResult } from '@/types';

/**
 * Rhino files carry render meshes for their NURBS surfaces, so the wasm build
 * only has to read them out. Layer names come through in `userData.attributes`,
 * which is what the scene tree ends up showing.
 */
export async function loadRhino(file: File, ctx: LoadContext): Promise<LoadResult> {
  ctx.onProgress(null, 'Downloading the Rhino kernel (one time, ~6 MB)');

  const loader = new Rhino3dmLoader();
  loader.setLibraryPath(CDN.rhino3dm);

  const buffer = await file.arrayBuffer();
  ctx.onProgress(null, 'Reading Rhino geometry');

  const object = await new Promise<THREE.Object3D>((resolve, reject) => {
    loader.parse(
      buffer,
      (result) => resolve(result),
      (err) => reject(new Error(err?.message || 'The Rhino file could not be read.')),
    );
  });

  loader.dispose();
  object.name = file.name;

  // Rhino models are commonly Z-up; match the CAD convention used elsewhere.
  object.rotateX(-Math.PI / 2);

  let renderable = 0;
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh || (child as THREE.Points).isPoints) renderable++;
  });
  if (!renderable) {
    throw new Error('This 3DM file has no render meshes. Re-save it from Rhino with meshes.');
  }

  return { object, hasAuthoredMaterials: true };
}
