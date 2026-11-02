import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { strToU8, zipSync } from 'fflate';
import { decodeBambuPaintState, parse3mf } from '../src/viewer/loaders/threemf.ts';
import {
  bambuObjectFilamentIndex,
  getBambu3mfFilamentColors,
  setBambuFilamentColor,
  setBambuObjectFilamentColor,
  threeMfObject,
} from '../src/viewer/loaders/3mf-colors.ts';

/* Bambu Studio's filament colours, from a saved project to editable meshes:
   the palette in project_settings.config, each object's and part's filament
   in model_settings.config, and painted faces in the model itself. */

const CORE = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
const PROD = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const PALETTE = JSON.stringify({ filament_colour: ['#12AB34', '#ABCDEF'] });

/** Two triangles; `paint` sets each one's paint_color attribute. */
function twoFaces(id: string, paint: [string | null, string | null] = [null, null]): string {
  const attr = (p: string | null) => (p === null ? '' : ` paint_color="${p}"`);
  return `<object id="${id}" type="model"><mesh><vertices>
    <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
    <vertex x="0" y="0" z="1"/><vertex x="1" y="0" z="1"/><vertex x="0" y="1" z="1"/>
  </vertices><triangles>
    <triangle v1="0" v2="1" v3="2"${attr(paint[0])}/>
    <triangle v1="3" v2="4" v3="5"${attr(paint[1])}/>
  </triangles></mesh></object>`;
}

function load(model: string, settings = '<config/>', extra: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = {
    '3D/3dmodel.model': strToU8(model),
    'Metadata/project_settings.config': strToU8(PALETTE),
    'Metadata/model_settings.config': strToU8(settings),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return threeMfObject(parse3mf(zipSync(files)), 'test.3mf').object;
}

const meshes = (root: THREE.Object3D) => root.children as THREE.Mesh[];
const material = (mesh: THREE.Mesh) => mesh.material as THREE.MeshStandardMaterial;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);
const colourAt = (mesh: THREE.Mesh, vertex: number) => {
  const c = mesh.geometry.getAttribute('color');
  return new THREE.Color(c.getX(vertex), c.getY(vertex), c.getZ(vertex));
};
const same = (a: THREE.Color, hex: string) => {
  const b = new THREE.Color(hex);
  near(a.r, b.r);
  near(a.g, b.g);
  near(a.b, b.b);
};

describe('Bambu 3MF colours', () => {
  test('decodes whole-face filament states and leaves subdivided paint inherited', () => {
    assert.equal(decodeBambuPaintState('4'), 1);
    assert.equal(decodeBambuPaintState('8'), 2);
    assert.equal(decodeBambuPaintState('0C'), 3);
    assert.equal(decodeBambuPaintState('1C'), 4);
    assert.equal(decodeBambuPaintState('0'), 0);
    assert.equal(decodeBambuPaintState('0C0C80C0C30C0C3'), null);
  });

  test('painted faces take the exact saved palette colours, and stay editable', () => {
    const root = load(`<model ${CORE}><resources>${twoFaces('7', ['4', '8'])}</resources><build><item objectid="7"/></build></model>`);
    const [mesh] = meshes(root);
    assert.equal(mesh.geometry.getIndex(), null);
    assert.equal(material(mesh).vertexColors, true);
    same(colourAt(mesh, 0), '#12AB34');
    same(colourAt(mesh, 3), '#ABCDEF');
    assert.deepEqual(getBambu3mfFilamentColors(root), [
      { index: 0, color: '#12AB34' },
      { index: 1, color: '#ABCDEF' },
    ]);

    assert.equal(setBambuFilamentColor(root, 0, '#ff0000'), true);
    assert.equal(setBambuFilamentColor(root, 2, '#ff0000'), false);
    same(colourAt(mesh, 0), '#ff0000');
    same(colourAt(mesh, 3), '#ABCDEF');
  });

  test('unpainted faces use their part’s filament before their object’s', () => {
    const root = load(
      `<model ${CORE}><resources>${twoFaces('7', ['0', '0'])}</resources></model>`,
      '<config><object id="6"><metadata key="extruder" value="1"/><part id="7"><metadata key="extruder" value="2"/></part></object></config>',
    );
    const [mesh] = meshes(root);
    assert.equal(material(mesh).color.getHexString(), 'abcdef');
    assert.equal(setBambuFilamentColor(root, 1, '#123456'), true);
    assert.equal(material(mesh).color.getHexString(), '123456');
  });

  test('an object’s filament applies when nothing is painted', () => {
    const root = load(
      `<model ${CORE}><resources>${twoFaces('7')}</resources><build><item objectid="7"/></build></model>`,
      '<config><object id="7"><metadata key="extruder" value="1"/></object></config>',
    );
    assert.equal(material(meshes(root)[0]).color.getHexString(), '12ab34');
  });

  test('a real Bambu project: parts reached through components keep their filaments', () => {
    const parts = `<model ${CORE} ${PROD}><resources>${twoFaces('1')}${twoFaces('2')}</resources><build/></model>`;
    const main = `<model ${CORE} ${PROD}><resources><object id="3"><components>
      <component p:path="/3D/Objects/object_1.model" objectid="1"/>
      <component p:path="/3D/Objects/object_1.model" objectid="2"/>
    </components></object></resources><build><item objectid="3"/></build></model>`;
    const settings = `<config><object id="3"><metadata key="extruder" value="1"/>
      <part id="1" subtype="normal_part"/>
      <part id="2" subtype="normal_part"><metadata key="extruder" value="2"/></part>
    </object></config>`;
    const root = load(main, settings, { '3D/Objects/object_1.model': parts });
    const [first, second] = meshes(root);
    assert.equal(material(first).color.getHexString(), '12ab34');
    assert.equal(material(second).color.getHexString(), 'abcdef');
  });

  test('one object can be moved to another slot without recolouring its neighbour', () => {
    const root = load(
      `<model ${CORE}><resources>${twoFaces('7', ['4', '8'])}</resources><build><item objectid="7"/><item objectid="7" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build></model>`,
    );
    const [selected, other] = meshes(root);
    assert.equal(bambuObjectFilamentIndex(selected), null);
    assert.equal(setBambuObjectFilamentColor(root, selected.id, 1, '#ABCDEF'), true);
    assert.equal(bambuObjectFilamentIndex(selected), 1);
    assert.equal(bambuObjectFilamentIndex(other), null);
    same(colourAt(selected, 0), '#ABCDEF');
    same(colourAt(other, 0), '#12AB34');
  });

  test('recolouring stays on one object even when geometry and material are shared', () => {
    const root = load(`<model ${CORE}><resources>${twoFaces('7', ['4', '8'])}</resources><build><item objectid="7"/><item objectid="7"/></build></model>`);
    const [selected, other] = meshes(root);
    other.geometry = selected.geometry;
    other.material = selected.material;
    const sharedGeometry = selected.geometry;
    const sharedMaterial = selected.material;

    assert.equal(setBambuObjectFilamentColor(root, selected.id, 1, '#ABCDEF'), true);
    assert.notEqual(selected.geometry, other.geometry);
    assert.equal(other.geometry, sharedGeometry);
    assert.equal(other.material, sharedMaterial);
    assert.deepEqual(Array.from(other.geometry.userData.caliperBambuFilamentIndices as Int16Array), [0, 0, 0, 1, 1, 1]);
    same(colourAt(other, 0), '#12AB34');
  });

  test('a shared single-colour material is cloned before one object changes', () => {
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial({ color: '#12AB34' });
    const selected = new THREE.Mesh(new THREE.BufferGeometry(), shared);
    const other = new THREE.Mesh(new THREE.BufferGeometry(), shared);
    root.add(selected, other);

    assert.equal(setBambuObjectFilamentColor(root, selected.id, 1, '#ABCDEF'), true);
    assert.notEqual(selected.material, other.material);
    assert.equal(other.material, shared);
    assert.equal(material(selected).color.getHexString(), 'abcdef');
    assert.equal(material(other).color.getHexString(), '12ab34');
  });

  test('a file’s own per-face colours are kept, not tinted by the project palette', () => {
    const root = load(
      `<model ${CORE} xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources>
        <m:colorgroup id="9"><m:color color="#FF0000"/><m:color color="#0000FF"/></m:colorgroup>
        <object id="7"><mesh><vertices>
          <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
        </vertices><triangles>
          <triangle v1="0" v2="1" v3="2" pid="9" p1="0"/><triangle v1="0" v2="2" v3="1" pid="9" p1="1"/>
        </triangles></mesh></object></resources><build><item objectid="7"/></build></model>`,
      '<config><object id="7"><metadata key="extruder" value="1"/></object></config>',
    );
    const [mesh] = meshes(root);
    same(colourAt(mesh, 0), '#ff0000');
    same(colourAt(mesh, 3), '#0000ff');
    assert.deepEqual(getBambu3mfFilamentColors(root), []);
  });
});
