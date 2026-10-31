import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseGcode } from '../src/lib/gcodeParse.ts';
import { fromArray } from '../src/viewer/triangles.ts';
import { loadP1SProfiles } from '../src/lib/bambu/profiles.ts';
import { slicePlate } from '../src/lib/bambu/slice.ts';
import { fakeBambuFetcher, plateBox } from './fixtures/bambu.ts';

const bambuLike = [
  '; HEADER_BLOCK_START',
  '; BambuStudio 02.08.01.55',
  '; model printing time: 17m 49s; total estimated time: 24m 6s',
  '; total filament length [mm] : 1558.64',
  '; total filament weight [g] : 4.65',
  '; HEADER_BLOCK_END',
  'M83',
  'G1 X18 Y1 Z0.2 F18000',
  'G0 X240 E15 F4800 ; purge line, inside the start block',
  '; MACHINE_START_GCODE_END',
  'G90',
  'M83',
  '; CHANGE_LAYER',
  '; Z_HEIGHT: 0.2',
  'G1 X100 Y100 F30000',
  '; FEATURE: Outer wall',
  'G1 X110 Y100 E0.5',
  'G2 X120 Y100 I5 J0 E0.8',
  'G1 X130 Y100 F30000',
  '; CHANGE_LAYER',
  '; Z_HEIGHT: 0.4',
  'G1 Z0.4',
  '; FEATURE: Gap infill',
  'G1 X140 Y100 E0.2',
  '; MACHINE_END_GCODE_START',
  'G1 X65 Y245 E5 ; not part of the print',
].join('\n');

describe('G-code preview parser', () => {
  test('reads layers, features, arcs and the header, skipping machine start and end moves', () => {
    const parsed = parseGcode(bambuLike);
    assert.deepEqual(Array.from(parsed.layerZ).map((z) => Number(z.toFixed(2))), [0.2, 0.4]);
    assert.deepEqual(parsed.features, ['Outer wall', 'Gap infill']);
    // Layer 1: one line plus a half-circle arc split into short segments; layer 2: one line.
    const layer1Segments = parsed.layerEnds[0] / 2;
    assert.ok(layer1Segments > 10, `${layer1Segments} segments`);
    assert.equal((parsed.layerEnds[1] - parsed.layerEnds[0]) / 2, 1);
    // G2 is clockwise seen from above with Y to the back, so from X110 around X115 it passes over the top
    // (Y 105); the purge line (Y 1) and the park move (Y 245) are never drawn.
    assert.ok(Math.abs(parsed.bounds.max[1] - 105) < 0.05, `max Y ${parsed.bounds.max[1]}`);
    assert.equal(parsed.bounds.min[1], 100);
    assert.ok(parsed.bounds.min[0] >= 100 && parsed.bounds.max[0] <= 140);
    assert.deepEqual(parsed.header, {
      generator: 'BambuStudio 02.08.01.55',
      printSeconds: 1069,
      totalSeconds: 1446,
      filamentGrams: 4.65,
      filamentMm: 1558.64,
    });
  });

  test('handles absolute extrusion, G92 resets, relative moves and Prusa/Cura feature names', () => {
    const prusa = [
      'M82',
      'G92 E0',
      ';LAYER_CHANGE',
      ';Z:0.2',
      ';TYPE:External perimeter',
      'G1 X10 Y10 Z0.2 F3000',
      'G1 X20 Y10 E1',
      'G1 X20 Y20 E1 ; no change in E: travel, not drawn',
      'G92 E0',
      ';TYPE:Internal infill',
      'G91',
      'G1 X5 Y0 E0.4',
      'G90',
      '; filament used [g] = 3.20',
      '; estimated printing time (normal mode) = 1h 2m 3s',
    ].join('\n');
    const parsed = parseGcode(prusa);
    assert.deepEqual(parsed.features, ['Outer wall', 'Sparse infill']);
    assert.equal(parsed.segmentFeatures.length, 2);
    assert.deepEqual(Array.from(parsed.positions.slice(6, 12)), [20, 20, 0.20000000298023224, 25, 20, 0.20000000298023224]);
    assert.equal(parsed.header.filamentGrams, 3.2);
    assert.equal(parsed.header.totalSeconds, 3723);

    const cura = ';FLAVOR:Marlin\n;TIME:600\n;LAYER:0\n;TYPE:WALL-OUTER\nG1 X0 Y0 Z0.3\nG1 X5 Y0 E1\n';
    const curaParsed = parseGcode(cura);
    assert.deepEqual(curaParsed.features, ['Outer wall']);
    assert.equal(curaParsed.header.printSeconds, 600);
  });

  test('falls back to Z changes for layers and rejects files with nothing to draw', () => {
    const plain = 'M83\nG1 X0 Y0 Z0.2\nG1 X10 Y0 E1\nG1 Z0.4\nG1 X0 Y0 E1\nG1 Z0.6\nG1 X10 Y0 E1\n';
    assert.equal(parseGcode(plain).layerZ.length, 3);
    assert.throws(() => parseGcode('G28\nG1 X10 Y10 F3000\n'), /no extrusion moves/);
  });

  test("reads Caliper's own P1S output back with matching layers and position", async () => {
    const profiles = await loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: fakeBambuFetcher() });
    const output = slicePlate(fromArray(plateBox([118, 0, 118], [138, 4, 138])), 4, profiles, {
      processId: 'standard',
      filamentId: 'bambu-pla-basic',
      plateType: 'Textured PEI Plate',
      infillPercent: 15,
      wallLoops: 2,
      supports: false,
      adhesion: 'none',
    }, 'x');
    const parsed = parseGcode(output.gcode);
    assert.equal(parsed.layerZ.length, output.stats.layers);
    assert.ok(parsed.bounds.min[0] > 117 && parsed.bounds.max[0] < 139, 'part stays where it was sliced');
    assert.ok(parsed.features.includes('Outer wall') && parsed.features.includes('Top surface'));
  });

  test('parses durations in every form slicers write', () => {
    assert.equal(parseDuration('17m 49s'), 1069);
    assert.equal(parseDuration('1d 2h 3m 4s'), 93784);
    assert.equal(parseDuration('600'), 600);
    assert.equal(parseDuration('soon'), null);
  });
});
