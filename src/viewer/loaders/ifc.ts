import * as THREE from 'three';
import { CDN, globalOf, loadScript } from '@/lib/cdn';
import type { LoadContext, LoadResult } from '@/types';

/* Minimal shape of the parts of web-ifc's API that are used here. */
interface IfcVector<T> {
  size(): number;
  get(i: number): T;
}
interface PlacedGeometry {
  geometryExpressID: number;
  flatTransformation: number[];
  color: { x: number; y: number; z: number; w: number };
}
interface FlatMesh {
  expressID: number;
  geometries: IfcVector<PlacedGeometry>;
}
interface IfcGeometry {
  GetVertexData(): number;
  GetVertexDataSize(): number;
  GetIndexData(): number;
  GetIndexDataSize(): number;
  delete(): void;
}
interface IfcApi {
  SetWasmPath(path: string, absolute?: boolean): void;
  Init(): Promise<void>;
  OpenModel(data: Uint8Array, settings?: unknown): number;
  CloseModel(id: number): void;
  StreamAllMeshes(id: number, cb: (mesh: FlatMesh) => void): void;
  GetGeometry(id: number, expressID: number): IfcGeometry;
  GetVertexArray(ptr: number, size: number): Float32Array;
  GetIndexArray(ptr: number, size: number): Uint32Array;
  GetLine(id: number, expressID: number, flatten?: boolean): Record<string, unknown>;
}

let apiPromise: Promise<IfcApi> | null = null;

async function getApi(ctx: LoadContext): Promise<IfcApi> {
  if (apiPromise) return apiPromise;
  ctx.onProgress(null, 'Downloading the IFC engine (one time, ~9 MB)');

  apiPromise = (async () => {
    await loadScript(`${CDN.webIfc}web-ifc-api-iife.js`);
    const ns = globalOf<{ IfcAPI: new () => IfcApi }>('WebIFC');
    if (!ns?.IfcAPI) throw new Error('The IFC engine loaded but did not register itself.');
    const api = new ns.IfcAPI();
    api.SetWasmPath(CDN.webIfc, true);
    await api.Init();
    return api;
  })();

  try {
    return await apiPromise;
  } catch (err) {
    apiPromise = null;
    throw err;
  }
}

function readName(api: IfcApi, modelID: number, expressID: number): string | null {
  try {
    const line = api.GetLine(modelID, expressID, false) as {
      Name?: { value?: string };
      constructor?: { name?: string };
      type?: number;
    };
    return line?.Name?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * web-ifc streams one flat mesh per building element. Vertices arrive
 * interleaved as position + normal, and each placement carries its own colour
 * and a column-major 4×4 transform.
 */
export async function loadIfc(file: File, ctx: LoadContext): Promise<LoadResult> {
  const api = await getApi(ctx);

  ctx.onProgress(null, 'Opening the IFC model');
  const modelID = api.OpenModel(new Uint8Array(await file.arrayBuffer()), {
    COORDINATE_TO_ORIGIN: true,
    USE_FAST_BOOLS: true,
  });

  const root = new THREE.Group();
  root.name = file.name;

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const matrix = new THREE.Matrix4();
  let elements = 0;

  try {
    api.StreamAllMeshes(modelID, (flat) => {
      const placements = flat.geometries;
      const group = new THREE.Group();
      group.name = `#${flat.expressID}`;

      for (let i = 0; i < placements.size(); i++) {
        const placement = placements.get(i);
        const geom = api.GetGeometry(modelID, placement.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

        const count = verts.length / 6;
        const positions = new Float32Array(count * 3);
        const normals = new Float32Array(count * 3);
        for (let v = 0; v < count; v++) {
          positions[v * 3] = verts[v * 6];
          positions[v * 3 + 1] = verts[v * 6 + 1];
          positions[v * 3 + 2] = verts[v * 6 + 2];
          normals[v * 3] = verts[v * 6 + 3];
          normals[v * 3 + 1] = verts[v * 6 + 4];
          normals[v * 3 + 2] = verts[v * 6 + 5];
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

        const { x: r, y: g, z: b, w: a } = placement.color;
        const key = `${r.toFixed(3)}|${g.toFixed(3)}|${b.toFixed(3)}|${a.toFixed(3)}`;
        let material = materials.get(key);
        if (!material) {
          material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(r, g, b),
            transparent: a < 1,
            opacity: a,
            roughness: 0.78,
            metalness: 0.02,
            side: a < 1 ? THREE.DoubleSide : THREE.FrontSide,
            depthWrite: a >= 1,
          });
          materials.set(key, material);
        }

        const mesh = new THREE.Mesh(geometry, material);
        matrix.fromArray(placement.flatTransformation);
        mesh.applyMatrix4(matrix);
        group.add(mesh);
        geom.delete();
      }

      if (group.children.length) {
        root.add(group);
        elements++;
        if (elements % 200 === 0) ctx.onProgress(null, `Built ${elements} elements`);
      }
    });

    // Names are one query per element; skip it on very large models.
    if (elements > 0 && elements <= 4000) {
      ctx.onProgress(null, 'Reading element names');
      for (const child of root.children) {
        const expressID = Number(child.name.slice(1));
        const name = readName(api, modelID, expressID);
        if (name) child.name = name;
        child.userData.expressID = expressID;
      }
    }
  } finally {
    api.CloseModel(modelID);
  }

  if (!elements) throw new Error('No geometry was found in this IFC model.');

  // IFC is Z-up; rotate into the Y-up world the viewer renders in.
  root.rotateX(-Math.PI / 2);

  return { object: root, hasAuthoredMaterials: true };
}
