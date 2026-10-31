import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { strToU8, zipSync } from 'fflate';
import { applyBambu3mfColors, decodeBambuPaintState } from '../src/viewer/loaders/3mf-colors.ts';

const modelXml = `<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="7" name="painted-part" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
          <vertex x="0" y="0" z="1"/><vertex x="1" y="0" z="1"/><vertex x="0" y="1" z="1"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" paint_color="4"/>
          <triangle v1="3" v2="4" v3="5" paint_color="8"/>
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`;

function makeProject(settingsXml: string, paint: 'face' | 'inherit' | 'none' = 'face'): ArrayBuffer {
  const archive = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8(
      paint === 'face'
        ? modelXml
        : modelXml.replace(
          / paint_color="(?:4|8)"/g,
          paint === 'inherit' ? ' paint_color="0"' : '',
        ),
    ),
    'Metadata/project_settings.config': strToU8(JSON.stringify({
      filament_colour: ['#12AB34', '#ABCDEF'],
    })),
    'Metadata/model_settings.config': strToU8(settingsXml),
  });
  return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
}

function meshWithTwoFaces(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ color: '#ffffff' }));
  mesh.name = 'painted-part';
  return mesh;
}

describe('Bambu 3MF colors', () => {
  test('decodes whole-face filament states and leaves unsupported paint trees inherited', () => {
    assert.equal(decodeBambuPaintState('4'), 1);
    assert.equal(decodeBambuPaintState('8'), 2);
    assert.equal(decodeBambuPaintState('0C'), 3);
    assert.equal(decodeBambuPaintState('1C'), 4);
    assert.equal(decodeBambuPaintState('0'), 0);
    assert.equal(decodeBambuPaintState('0C0C80C0C30C0C3'), null);
  });

  test('applies exact saved palette colors to painted faces', () => {
    const root = new THREE.Group();
    const mesh = meshWithTwoFaces();
    root.add(mesh);

    assert.equal(applyBambu3mfColors(root, makeProject('<config/>')), true);
    assert.equal(mesh.geometry.getIndex(), null);
    const vertexColors = mesh.geometry.getAttribute('color');
    const firstColor = new THREE.Color('#12AB34');
    const secondColor = new THREE.Color('#ABCDEF');
    assert.ok(Math.abs(vertexColors.getX(0) - firstColor.r) < 1e-6);
    assert.ok(Math.abs(vertexColors.getY(1) - firstColor.g) < 1e-6);
    assert.ok(Math.abs(vertexColors.getZ(2) - firstColor.b) < 1e-6);
    assert.ok(Math.abs(vertexColors.getX(3) - secondColor.r) < 1e-6);
    assert.ok(Math.abs(vertexColors.getY(4) - secondColor.g) < 1e-6);
    assert.ok(Math.abs(vertexColors.getZ(5) - secondColor.b) < 1e-6);
    assert.equal((mesh.material as THREE.MeshPhongMaterial).vertexColors, true);
  });

  test('uses the saved part filament for unpainted faces', () => {
    const root = new THREE.Group();
    const mesh = meshWithTwoFaces();
    root.add(mesh);
    const project = makeProject(
      '<config><object id="6"><metadata key="extruder" value="1"/><part id="7"><metadata key="extruder" value="2"/></part></object></config>',
      'inherit',
    );

    assert.equal(applyBambu3mfColors(root, project), true);
    assert.equal((mesh.material as THREE.MeshPhongMaterial).color.getHexString(), 'abcdef');
  });

  test('applies per-object filament metadata when triangle paint is absent', () => {
    const root = new THREE.Group();
    const mesh = meshWithTwoFaces();
    root.add(mesh);
    const project = makeProject(
      '<config><object id="7"><metadata key="extruder" value="1"/></object></config>',
      'none',
    );

    assert.equal(applyBambu3mfColors(root, project), true);
    assert.equal((mesh.material as THREE.MeshPhongMaterial).color.getHexString(), '12ab34');
  });

  test('preserves standard vertex colors instead of tinting them with project metadata', () => {
    const root = new THREE.Group();
    const mesh = meshWithTwoFaces();
    root.add(mesh);
    mesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(18).fill(1), 3));
    const project = makeProject(
      '<config><object id="7"><metadata key="extruder" value="1"/></object></config>',
      'none',
    );

    assert.equal(applyBambu3mfColors(root, project), false);
    assert.equal((mesh.material as THREE.MeshPhongMaterial).color.getHexString(), 'ffffff');
  });
});
