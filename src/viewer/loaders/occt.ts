import * as THREE from 'three';
import { unzipSync } from 'fflate';
import { CDN, globalOf, loadScript } from '@/lib/cdn';
import { extOf } from '@/lib/formats';
import type { LoadContext, LoadResult } from '@/types';

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  attributes: {
    position: { array: number[] | Float32Array };
    normal?: { array: number[] | Float32Array };
  };
  index?: { array: number[] | Uint32Array };
}

interface OcctResult {
  success: boolean;
  root?: { name?: string; meshes?: number[]; children?: unknown[] };
  meshes: OcctMesh[];
}

interface OcctModule {
  ReadStepFile(buffer: Uint8Array, params: unknown): OcctResult;
  ReadIgesFile(buffer: Uint8Array, params: unknown): OcctResult;
  ReadBrepFile(buffer: Uint8Array, params: unknown): OcctResult;
}

type OcctFactory = (opts: { locateFile: (path: string) => string }) => Promise<OcctModule>;

let modulePromise: Promise<OcctModule> | null = null;

async function getKernel(ctx: LoadContext): Promise<OcctModule> {
  if (modulePromise) return modulePromise;
  ctx.onProgress(null, 'Downloading the CAD kernel (one time, ~8 MB)');

  modulePromise = (async () => {
    await loadScript(`${CDN.occt}occt-import-js.js`);
    const factory = globalOf<OcctFactory>('occtimportjs');
    if (!factory) throw new Error('The CAD kernel loaded but did not register itself.');
    return factory({ locateFile: (path) => `${CDN.occt}${path}` });
  })();

  try {
    return await modulePromise;
  } catch (err) {
    modulePromise = null;
    throw err;
  }
}

/**
 * Tessellation quality. `linearUnit` stays at the file's own unit; deflection is
 * relative so the same value works for a bolt and a bridge.
 */
const PARAMS = { linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 };

function toObject(result: OcctResult, name: string): THREE.Object3D {
  if (!result.success || !result.meshes?.length) {
    throw new Error('The CAD kernel opened the file but produced no surfaces.');
  }

  const root = new THREE.Group();
  root.name = name;

  result.meshes.forEach((mesh, i) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(Float32Array.from(mesh.attributes.position.array), 3),
    );
    if (mesh.attributes.normal) {
      geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(Float32Array.from(mesh.attributes.normal.array), 3),
      );
    }
    if (mesh.index) {
      geometry.setIndex(Array.from(mesh.index.array));
    }
    if (!mesh.attributes.normal) geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: mesh.color
        ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2])
        : new THREE.Color(0.72, 0.75, 0.8),
      metalness: 0.15,
      roughness: 0.48,
      side: THREE.DoubleSide,
    });

    const child = new THREE.Mesh(geometry, material);
    child.name = mesh.name || `Solid ${i + 1}`;
    root.add(child);
  });

  return root;
}

/** FreeCAD documents are zip archives; the shapes inside are OpenCascade B-reps. */
async function readFcstd(file: File, occt: OcctModule, ctx: LoadContext): Promise<THREE.Object3D> {
  ctx.onProgress(null, 'Unpacking the FreeCAD document');
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const shapes = Object.keys(zip).filter((n) => /\.(brp|brep)$/i.test(n));
  if (!shapes.length) {
    throw new Error('This FreeCAD document has no saved shapes. Re-save it with geometry included.');
  }

  const root = new THREE.Group();
  root.name = file.name;
  shapes.forEach((entry, i) => {
    ctx.onProgress(i / shapes.length, `Tessellating shape ${i + 1} of ${shapes.length}`);
    try {
      const part = toObject(occt.ReadBrepFile(zip[entry], PARAMS), entry.replace(/\.[^.]+$/, ''));
      root.add(part);
    } catch {
      /* One unreadable shape should not sink the whole document. */
    }
  });

  if (!root.children.length) throw new Error('None of the shapes in this document could be read.');
  return root;
}

export async function loadOcct(file: File, ctx: LoadContext): Promise<LoadResult> {
  const occt = await getKernel(ctx);
  const ext = extOf(file.name);

  if (ext === 'fcstd') {
    return { object: await readFcstd(file, occt, ctx), hasAuthoredMaterials: true };
  }

  ctx.onProgress(null, 'Tessellating surfaces');
  const buffer = new Uint8Array(await file.arrayBuffer());

  // Yield once so the progress note paints before the kernel blocks the thread.
  await new Promise((r) => setTimeout(r, 16));

  let result: OcctResult;
  if (ext === 'step' || ext === 'stp') result = occt.ReadStepFile(buffer, PARAMS);
  else if (ext === 'iges' || ext === 'igs') result = occt.ReadIgesFile(buffer, PARAMS);
  else result = occt.ReadBrepFile(buffer, PARAMS);

  return { object: toObject(result, file.name), hasAuthoredMaterials: true };
}
