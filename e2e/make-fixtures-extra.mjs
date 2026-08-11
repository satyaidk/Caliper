import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The four formats with no public sample worth downloading: two text formats
 * that are trivial to author, one binary-glTF sibling, and an STL because the
 * obvious three.js path is behind a CDN size limit.
 *
 * All four describe the same 20 x 12 x 8 box, so a wrong answer is obvious.
 */

const OUT = fileURLToPath(new URL('fixtures', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const V = [
  [0, 0, 0], [20, 0, 0], [20, 12, 0], [0, 12, 0],
  [0, 0, 8], [20, 0, 8], [20, 12, 8], [0, 12, 8],
];
const QUADS = [
  [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
  [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
];
const TRIS = QUADS.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);

/* --- OFF ------------------------------------------------------------------ */

fs.writeFileSync(
  path.join(OUT, 'sample.off'),
  ['OFF', `${V.length} ${QUADS.length} 0`,
    ...V.map((v) => v.join(' ')),
    ...QUADS.map((f) => `${f.length} ${f.join(' ')}`)].join('\n') + '\n',
);

/* --- STL (ASCII) ---------------------------------------------------------- */

const cross = (u, v) => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const stl = ['solid box'];
for (const [a, b, c] of TRIS) {
  const n = cross(sub(V[b], V[a]), sub(V[c], V[a]));
  const len = Math.hypot(...n) || 1;
  stl.push(`facet normal ${n.map((x) => (x / len).toFixed(6)).join(' ')}`);
  stl.push('  outer loop');
  for (const i of [a, b, c]) stl.push(`    vertex ${V[i].map((x) => x.toFixed(4)).join(' ')}`);
  stl.push('  endloop', 'endfacet');
}
stl.push('endsolid box');
fs.writeFileSync(path.join(OUT, 'sample.stl'), stl.join('\n') + '\n');

/* --- glTF (JSON, with an embedded buffer) --------------------------------- */

const positions = new Float32Array(TRIS.flat().flatMap((i) => V[i]));
const buffer = Buffer.from(positions.buffer);

fs.writeFileSync(
  path.join(OUT, 'sample.gltf'),
  JSON.stringify({
    asset: { version: '2.0', generator: 'caliper-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Box', mesh: 0 }],
    meshes: [{ name: 'Box', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [
      {
        name: 'Steel',
        pbrMetallicRoughness: {
          baseColorFactor: [0.62, 0.66, 0.72, 1],
          metallicFactor: 0.2,
          roughnessFactor: 0.45,
        },
      },
    ],
    buffers: [
      {
        byteLength: buffer.byteLength,
        uri: `data:application/octet-stream;base64,${buffer.toString('base64')}`,
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: buffer.byteLength, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [20, 12, 8],
      },
    ],
  }),
);

/* --- dotbim: two placed elements sharing one mesh ------------------------- */

fs.writeFileSync(
  path.join(OUT, 'sample.bim'),
  JSON.stringify({
    schema_version: '1.0.0',
    meshes: [{ mesh_id: 0, coordinates: V.flat(), indices: TRIS.flat() }],
    elements: [
      {
        mesh_id: 0,
        vector: { x: 0, y: 0, z: 0 },
        rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
        guid: '9f61b565-06a2-4bef-8b72-f37091ab54d6',
        type: 'Wall',
        color: { r: 200, g: 180, b: 140, a: 255 },
        info: { Name: 'Wall A' },
      },
      {
        mesh_id: 0,
        vector: { x: 30, y: 0, z: 0 },
        rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
        guid: '2b9a1f77-4c1e-4a2b-9d3f-1c0e5a7b8c21',
        type: 'Slab',
        color: { r: 150, g: 155, b: 165, a: 255 },
        info: { Name: 'Slab B' },
      },
    ],
    info: { Author: 'Caliper test fixture' },
  }),
);

console.log(`  wrote sample.off, sample.stl, sample.gltf and sample.bim into ${OUT}`);
