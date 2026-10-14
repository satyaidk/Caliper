import * as THREE from 'three';
import type { LoadContext, LoadResult } from '@/types';

/**
 * OFF (Object File Format) — plain text, no official three.js loader.
 *
 *   OFF
 *   <vertices> <faces> <edges>
 *   x y z [r g b [a]]        × vertices
 *   n i0 i1 … [r g b [a]]    × faces
 *
 * COFF/NOFF/4OFF headers add per-vertex colour, normals or homogeneous
 * coordinates. Colours may be 0–1 floats or 0–255 integers; both appear in the
 * wild, so the range is detected from the values themselves.
 */
export async function loadOff(file: File, ctx: LoadContext): Promise<LoadResult> {
  ctx.onProgress(null, 'Parsing OFF');
  const text = await file.text();

  const tokens: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (line) tokens.push(...line.split(/\s+/));
  }
  if (!tokens.length) throw new Error('The file is empty.');

  let cursor = 0;
  const header = tokens[cursor];
  if (!/OFF$/i.test(header)) {
    throw new Error('This does not look like an OFF file — no OFF header found.');
  }
  const hasVertexColor = /^C/i.test(header);
  const hasVertexNormal = /^N/i.test(header) || /^CN/i.test(header);
  const homogeneous = /^4/.test(header);
  cursor++;

  const num = () => {
    const v = Number(tokens[cursor++]);
    if (!Number.isFinite(v)) throw new Error('Malformed OFF: expected a number.');
    return v;
  };

  const vertexCount = num();
  const faceCount = num();
  num(); // edge count, unused

  const positions: number[] = [];
  const normals: number[] = [];
  const vertexColors: number[] = [];
  let colorScale = 1;

  for (let i = 0; i < vertexCount; i++) {
    positions.push(num(), num(), num());
    if (homogeneous) num();
    if (hasVertexNormal) normals.push(num(), num(), num());
    if (hasVertexColor) {
      const r = num();
      const g = num();
      const b = num();
      if (r > 1 || g > 1 || b > 1) colorScale = 1 / 255;
      vertexColors.push(r, g, b);
      // Optional alpha: only consumed when a fourth number precedes the next vertex.
      const next = Number(tokens[cursor]);
      if (Number.isFinite(next) && !Number.isInteger(next) && next <= 1 && next >= 0) cursor++;
    }
  }

  const indices: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const n = num();
    const face: number[] = [];
    for (let k = 0; k < n; k++) face.push(num());
    // Fan-triangulate convex polygons.
    for (let k = 1; k < n - 1; k++) indices.push(face[0], face[k], face[k + 1]);
    // Skip an optional per-face colour block.
    while (cursor < tokens.length && !Number.isInteger(Number(tokens[cursor]))) cursor++;
    if (f % 20_000 === 0) ctx.onProgress(f / Math.max(faceCount, 1), 'Building faces');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (indices.length) geometry.setIndex(indices);
  if (normals.length === positions.length) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (vertexColors.length === positions.length) {
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        colorScale === 1 ? vertexColors : vertexColors.map((c) => c * colorScale),
        3,
      ),
    );
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: Boolean(geometry.getAttribute('color')),
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = file.name;

  return { object: mesh, hasAuthoredMaterials: Boolean(geometry.getAttribute('color')) };
}
