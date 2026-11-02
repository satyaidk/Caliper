import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { parse3mf } from '../src/viewer/loaders/threemf.ts';

/* 3MF packages built the way real slicers write them, each checked against
   sizes and positions worked out by hand. The Bambu-style package is the one
   three.js's loader could not open at all. */

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

const CORE = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
const PROD = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

/** A box from the origin, as 3MF vertices and outward-facing triangles. */
function boxMesh(x: number, y: number, z: number, triangleAttrs = ''): string {
  const v = [
    [0, 0, 0],
    [x, 0, 0],
    [x, y, 0],
    [0, y, 0],
    [0, 0, z],
    [x, 0, z],
    [x, y, z],
    [0, y, z],
  ];
  const t = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return `<mesh><vertices>${v.map(([a, b, c]) => `<vertex x="${a}" y="${b}" z="${c}"/>`).join('')}</vertices><triangles>${t
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"${triangleAttrs}/>`)
    .join('')}</triangles></mesh>`;
}

function pack(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = { '_rels/.rels': strToU8(RELS) };
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return zipSync(entries);
}

function bounds(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  return { min, max, size: max.map((m, k) => m - min[k]) };
}

describe('the core spec', () => {
  test('a single-file model with a build transform', () => {
    const r = parse3mf(
      pack({
        '3D/3dmodel.model': `<model unit="millimeter" ${CORE}><resources><object id="1" name="tall box">${boxMesh(10, 10, 40)}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 125 105 0"/></build></model>`,
      }),
    );
    assert.equal(r.parts.length, 1);
    assert.equal(r.parts[0].name, 'tall box');
    const b = bounds(r.parts[0].positions);
    assert.deepEqual(b.size, [10, 10, 40]); // Z stays up: the box is 40 mm tall
    assert.deepEqual(b.min, [125, 105, 0]);
  });

  test('inches are converted to millimetres', () => {
    const r = parse3mf(
      pack({ '3D/3dmodel.model': `<model unit="inch" ${CORE}><resources><object id="1">${boxMesh(1, 1, 2)}</object></resources><build><item objectid="1"/></build></model>` }),
    );
    const b = bounds(r.parts[0].positions);
    near(b.size[0], 25.4, 1e-4);
    near(b.size[2], 50.8, 1e-4);
    assert.ok(r.notes.some((n) => n.includes('inch')));
  });

  test('one object built twice is two parts, and a rotation is applied', () => {
    // A quarter turn about Z: (x, y) → (−y, x).
    const r = parse3mf(
      pack({
        '3D/3dmodel.model': `<model ${CORE}><resources><object id="1">${boxMesh(20, 10, 5)}</object></resources><build><item objectid="1"/><item objectid="1" transform="0 1 0 -1 0 0 0 0 1 100 0 0"/></build></model>`,
      }),
    );
    assert.equal(r.parts.length, 2);
    const turned = bounds(r.parts[1].positions);
    assert.deepEqual(turned.size, [10, 20, 5]);
    assert.deepEqual(turned.min, [90, 0, 0]);
  });

  test('a mirrored instance keeps its triangles facing outwards', () => {
    const r = parse3mf(
      pack({
        '3D/3dmodel.model': `<model ${CORE}><resources><object id="1">${boxMesh(10, 10, 10)}</object></resources><build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`,
      }),
    );
    // The bottom face's first triangle must still face down: normal z < 0.
    const p = r.parts[0].positions;
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]];
    const w = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    assert.ok(u[0] * w[1] - u[1] * w[0] < 0);
  });

  test('colours from basematerials', () => {
    const r = parse3mf(
      pack({
        '3D/3dmodel.model': `<model ${CORE}><resources><basematerials id="5"><base name="red" displaycolor="#FF0000FF"/><base name="blue" displaycolor="#0000FF"/></basematerials><object id="1" pid="5" pindex="1">${boxMesh(5, 5, 5)}</object></resources><build><item objectid="1"/></build></model>`,
      }),
    );
    assert.equal(r.parts[0].colour, '#0000ff');
    assert.equal(r.parts[0].colours, null);
  });

  test('a damaged archive and a missing model say what is wrong', () => {
    assert.throws(() => parse3mf(new Uint8Array([1, 2, 3])), /not a readable zip/);
    assert.throws(() => parse3mf(pack({})), /no 3D model inside/);
  });
});

describe('Bambu Studio projects (the Production extension)', () => {
  const objectFile = (x: number, y: number, z: number) =>
    `<model unit="millimeter" ${CORE} ${PROD} requiredextensions="p"><resources><object id="1" type="model">${boxMesh(x, y, z)}</object></resources><build/></model>`;
  const main = `<model unit="millimeter" ${CORE} ${PROD} requiredextensions="p"><resources>
    <object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
    <object id="4" type="model"><components><component p:path="/3D/Objects/object_2.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
  </resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 128 0"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 150 128 0"/></build></model>`;

  test('objects in separate files, each numbered 1, resolve to the right mesh', () => {
    const r = parse3mf(
      pack({ '3D/3dmodel.model': main, '3D/Objects/object_1.model': objectFile(10, 10, 40), '3D/Objects/object_2.model': objectFile(30, 30, 3) }),
    );
    assert.equal(r.parts.length, 2);
    assert.deepEqual(bounds(r.parts[0].positions).size, [10, 10, 40]);
    assert.deepEqual(bounds(r.parts[0].positions).min, [100, 128, 0]);
    assert.deepEqual(bounds(r.parts[1].positions).size, [30, 30, 3]);
    assert.deepEqual(bounds(r.parts[1].positions).min, [150, 128, 0]);
  });

  test('a modifier part is left out, and the names come from the project', () => {
    const twoParts = `<model ${CORE} ${PROD}><resources><object id="1">${boxMesh(20, 20, 20)}</object><object id="2">${boxMesh(5, 5, 5)}</object></resources><build/></model>`;
    const mainWithModifier = `<model ${CORE} ${PROD}><resources><object id="3"><components>
      <component p:path="/3D/Objects/object_1.model" objectid="1"/>
      <component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 5 5 5"/>
    </components></object></resources><build><item objectid="3"/></build></model>`;
    const config = `<?xml version="1.0"?><config><object id="3"><metadata key="name" value="Bracket"/>
      <part id="1" subtype="normal_part"><metadata key="name" value="body"/></part>
      <part id="2" subtype="modifier_part"><metadata key="name" value="denser infill"/></part>
    </object></config>`;
    const r = parse3mf(
      pack({ '3D/3dmodel.model': mainWithModifier, '3D/Objects/object_1.model': twoParts, 'Metadata/model_settings.config': config }),
    );
    assert.equal(r.parts.length, 1);
    assert.equal(r.parts[0].name, 'Bracket');
    assert.deepEqual(bounds(r.parts[0].positions).size, [20, 20, 20]);
    assert.ok(r.notes.some((n) => n.includes('modifier')));
  });

  test('a component pointing at a missing file is reported by name', () => {
    assert.throws(() => parse3mf(pack({ '3D/3dmodel.model': main })), /object_1\.model/);
  });
});

describe('PrusaSlicer projects', () => {
  test('a modifier volume stored as a triangle range is left out', () => {
    // One mesh object holding two boxes: triangles 0–11 the part, 12–23 a modifier.
    const twoBoxes = boxMesh(10, 10, 10).replace('</triangles></mesh>', '');
    const extra = Array.from({ length: 12 }, () => '<triangle v1="0" v2="1" v3="2"/>').join('');
    const model = `<model ${CORE}><resources><object id="1">${twoBoxes}${extra}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const config = `<?xml version="1.0"?><config><object id="1"><metadata type="object" key="name" value="Widget"/>
      <volume firstid="0" lastid="11"><metadata type="volume" key="name" value="body"/></volume>
      <volume firstid="12" lastid="23"><metadata type="volume" key="modifier" value="1"/><metadata type="volume" key="volume_type" value="ModifierVolume"/></volume>
    </object></config>`;
    const r = parse3mf(pack({ '3D/3dmodel.model': model, 'Metadata/Slic3r_PE_model.config': config }));
    assert.equal(r.parts[0].positions.length / 9, 12);
    assert.equal(r.parts[0].name, 'Widget');
    assert.ok(r.notes.some((n) => n.includes('modifier')));
  });
});
