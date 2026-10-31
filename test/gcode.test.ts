import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { fromArray } from '../src/viewer/triangles.ts';
import { loadP1SProfiles, type P1SProfiles } from '../src/lib/bambu/profiles.ts';
import { buildPrintSettings, type SliceChoices } from '../src/lib/bambu/settings.ts';
import { packageSlice, slicePlate, type SliceOutput } from '../src/lib/bambu/slice.ts';
import { runPreflight } from '../src/lib/bambu/preflight.ts';
import { md5Hex } from '../src/lib/bambu/md5.ts';
import { encodePng } from '../src/lib/bambu/thumbnail.ts';
import { beadArea, crossesOutline, layerFanPercent, moveSeconds } from '../src/lib/gcode.ts';
import { fakeBambuFetcher, plateBox } from './fixtures/bambu.ts';

const choices: SliceChoices = {
  processId: 'standard',
  filamentId: 'bambu-pla-basic',
  plateType: 'Textured PEI Plate',
  infillPercent: 15,
  wallLoops: 2,
  supports: false,
  adhesion: 'skirt',
};

let profiles: P1SProfiles;
let cube: SliceOutput;

before(async () => {
  profiles = await loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: fakeBambuFetcher() });
  cube = slicePlate(fromArray(plateBox([118, 0, 118], [138, 10, 138])), 10, profiles, choices, 'Caliper test');
});

/** Re-runs pre-flight on edited G-code, keeping the original start/end blocks. */
function preflightOf(text: string, output = cube) {
  const lines = output.gcode.split('\n');
  const startBlock = lines.slice(lines.indexOf('; MACHINE_START_GCODE_START') + 1, lines.indexOf('; MACHINE_START_GCODE_END')).join('\n');
  const endBlock = lines.slice(lines.indexOf('; MACHINE_END_GCODE_START') + 1, lines.indexOf('; MACHINE_END_GCODE_END')).join('\n');
  return runPreflight({
    text,
    settings: output.settings,
    startBlock,
    endBlock,
    templateBlocks: [
      '; layer num/total_layer_count: 1/1\nM73 L1\nM991 S0 P0',
      '; SKIPPABLE_START\nM622.1 S1\nM1002 judge_flag timelapse_record_flag\nM622 J1\nM971 S11 C10 O0\nM623\n; SKIPPABLE_END',
      '; filament start gcode\nM106 P3 S150',
    ],
  });
}

/** Inserts lines just before the first `; FEATURE: Outer wall` of layer 2. */
function inject(lines: string[]): string {
  const marker = cube.gcode.indexOf('; FEATURE: Outer wall', cube.gcode.indexOf('; Z_HEIGHT: 0.4'));
  return `${cube.gcode.slice(0, marker)}${lines.join('\n')}\n${cube.gcode.slice(marker)}`;
}

describe('P1S slicing pipeline', () => {
  test('slices a 20 mm cube that passes every pre-flight check', () => {
    assert.equal(cube.preflight.ok, true, JSON.stringify(cube.preflight.issues));
    assert.ok(cube.preflight.checks.every((check) => check.status === 'pass'));
    assert.equal(cube.stats.layers, 50);
    assert.ok(cube.stats.filamentGrams > 1 && cube.stats.filamentGrams < 6, `${cube.stats.filamentGrams} g`);
  });

  test("wraps toolpaths in the profile's own start and end sequence", () => {
    const text = cube.gcode;
    assert.ok(text.indexOf('; HEADER_BLOCK_START') === 0);
    assert.match(text, /; total layer number: 50\n/);
    assert.match(text, /M190 S55\n/);
    // Whole millimetres, min rounded down and max rounded up, as Bambu Studio writes it.
    assert.match(text, /G29 A X\d+ Y\d+ I\d+ J\d+\n/);
    assert.match(text, /\nM201 X20000 Y20000 Z500 E5000\nM203 X500 Y500 Z20 E30\nM204 P20000 R5000 T20000\nM205 X9\.00 Y9\.00 Z3\.00 E2\.50\n/);
    assert.match(text, /M981 S1 P20000 ;open spaghetti detector\n/);
    assert.match(text, /M981 S0 P20000 ; close spaghetti detector\n/);
    assert.match(text, /G29\.1 Z-0\.04/);
    assert.match(text, /M620\.1 E F523\.843 T240/, 'flush defaults to max flow and top of temperature range');
    assert.ok(text.indexOf('; MACHINE_START_GCODE_END') < text.indexOf('; CHANGE_LAYER'));
    assert.ok(text.lastIndexOf('; CHANGE_LAYER') < text.indexOf('; MACHINE_END_GCODE_START'));
    assert.match(text, /G1 Z110 F600/, 'end template lifts by max_layer_z + 100');
  });

  test('uses relative extrusion, retracts and lifts on layer change, and prints layer 1 slow', () => {
    const body = cube.gcode.slice(cube.gcode.indexOf('; MACHINE_START_GCODE_END'), cube.gcode.indexOf('; MACHINE_END_GCODE_START'));
    assert.match(body, /M83/);
    assert.doesNotMatch(body, /\nG92 E0\n|\nM82\n|\nG28/);
    const layer2 = body.slice(body.indexOf('; Z_HEIGHT: 0.4'), body.indexOf('; Z_HEIGHT: 0.6'));
    assert.match(layer2, /G1 E-0\.8 F1800[^]*G1 Z0\.8 F1200[^]*G1 Z0\.4 F1200\nG1 E0\.8 F1800/);
    const layer1 = body.slice(body.indexOf('; Z_HEIGHT: 0.2'), body.indexOf('; Z_HEIGHT: 0.4'));
    assert.match(layer1, /M204 S500/);
    assert.match(layer1, /M106 S0|^(?![^]*M106 S255)/, 'fan off on layer 1');
    for (const [, feed] of layer1.matchAll(/G1 X[\d.]+ Y[\d.]+ E[\d.]+ F(\d+)/g)) {
      assert.ok(Number(feed) <= 105 * 60, `first-layer feed ${feed}`);
    }
  });

  test('keeps every extrusion within the filament volumetric limit', () => {
    const area = Math.PI * 0.875 ** 2;
    let x = 0;
    let y = 0;
    let feed = 0;
    for (const line of cube.gcode.split('\n')) {
      const m = /^G1 X([\d.]+) Y([\d.]+)(?: E([\d.]+))?(?: F(\d+))?/.exec(line);
      if (!m) continue;
      if (m[4]) feed = Number(m[4]);
      const nx = Number(m[1]);
      const ny = Number(m[2]);
      if (m[3]) {
        const length = Math.hypot(nx - x, ny - y);
        if (length > 0.01) assert.ok((Number(m[3]) / length) * area * (feed / 60) <= 21 * 1.01);
      }
      x = nx;
      y = ny;
    }
  });

  test('builds supports, brim and bridges for an overhanging cap', () => {
    const source = fromArray([...plateBox([120, 0, 120], [126, 8, 126]), ...plateBox([120, 8, 120], [140, 12, 140])]);
    const output = slicePlate(source, 12, profiles, { ...choices, supports: true, adhesion: 'brim' }, 'Caliper test');
    assert.equal(output.preflight.ok, true, JSON.stringify(output.preflight.issues));
    for (const feature of ['Support', 'Support interface', 'Brim', 'Bridge', 'Top surface', 'Sparse infill']) {
      assert.match(output.gcode, new RegExp(`; FEATURE: ${feature}\\n`));
    }
    assert.doesNotMatch(output.gcode, /; FEATURE: Skirt/);
  });

  test('handles finely tessellated parts whose first layer has tens of thousands of points', () => {
    // A 4,000-facet cylinder: spreading its points into Math.min once overflowed the stack.
    const segments = 4000;
    const triangles: number[] = [];
    const ring = (i: number) => {
      const a = (i / segments) * Math.PI * 2;
      return [128 + 20 * Math.cos(a), 128 + 20 * Math.sin(a)];
    };
    for (let i = 0; i < segments; i++) {
      const [x0, y0] = ring(i);
      const [x1, y1] = ring(i + 1);
      triangles.push(128, 0, 128, x1, 0, y1, x0, 0, y0);
      triangles.push(128, 2, 128, x0, 2, y0, x1, 2, y1);
      triangles.push(x0, 0, y0, x1, 0, y1, x1, 2, y1, x0, 0, y0, x1, 2, y1, x0, 2, y0);
    }
    const output = slicePlate(fromArray(triangles), 2, profiles, choices, 'x');
    assert.equal(output.preflight.ok, true, JSON.stringify(output.preflight.issues.slice(0, 3)));
  });

  test('writes large prints whose G-code runs to well over 100,000 lines', () => {
    // Spreading the whole print body into push() once overflowed the call stack.
    const output = slicePlate(fromArray(plateBox([78, 0, 78], [178, 80, 178])), 80, profiles, choices, 'x');
    assert.ok(output.gcode.split('\n').length > 100_000);
    assert.equal(output.preflight.ok, true, JSON.stringify(output.preflight.issues.slice(0, 3)));
  });

  test('refuses unsafe plate and filament pairings and parts taller than the printer', () => {
    assert.throws(() => buildPrintSettings(profiles, { ...choices, plateType: 'Engineering Plate' }), /must not be printed/);
    assert.throws(
      () => slicePlate(fromArray(plateBox([118, 0, 118], [138, 251, 138])), 251, profiles, choices, 'x'),
      /prints up to 250/,
    );
    assert.throws(
      () => slicePlate(fromArray(plateBox([118, 5, 118], [138, 10, 138])), 10, profiles, choices, 'x'),
      /Nothing touches the plate/,
    );
  });
});

describe('pre-flight guards', () => {
  test('rejects a part placed in the excluded front-left corner', () => {
    const output = slicePlate(fromArray(plateBox([4, 0, 6], [14, 4, 16])), 4, profiles, { ...choices, adhesion: 'none' }, 'x');
    assert.equal(output.preflight.ok, false);
    assert.equal(output.preflight.checks.find((check) => check.id === 'bounds')?.status, 'fail');
    assert.throws(() => packageSlice(output, profiles, choices, '#00AE42', 'x'), /failed the pre-flight/);
  });

  test('warns when the first layer reaches the purge-line strip', () => {
    const output = slicePlate(fromArray(plateBox([100, 0, 4], [120, 4, 24])), 4, profiles, choices, 'x');
    assert.equal(output.preflight.ok, true);
    assert.equal(output.preflight.checks.find((check) => check.id === 'first-layer')?.status, 'warn');
  });

  const failing: [string, string[], RegExp][] = [
    ['off the plate', ['G1 X300 Y128 F30000'], /off the plate/],
    ['excluded corner', ['G1 X5 Y5 F30000'], /excluded corner/],
    ['too high', ['G1 Z251 F600'], /outside 0–250/],
    ['too fast', ['G1 X120 Y120 F60000'], /exceeds 500 mm\/s/],
    ['fast Z', ['G1 Z1 F6000'], /Z feed rate/],
    ['flow limit', ['G1 X130 Y120 E9 F12000'], /Flow .* exceeds/],
    ['homing mid-print', ['G28'], /G28 must not appear/],
    ['absolute extrusion', ['M82'], /M82 must not appear/],
    ['unknown command', ['M600'], /Unexpected command M600/],
    ['huge retraction', ['G1 E-6 F1800'], /too long/],
    ['over-priming', ['G1 E3 F1800'], /Priming 3 mm more/],
    ['fan range', ['M106 S300'], /Fan value out of range/],
    ['acceleration', ['M204 S30000'], /exceeds the P1S limit/],
  ];
  for (const [name, lines, message] of failing) {
    test(`rejects ${name}`, () => {
      const report = preflightOf(inject(lines));
      assert.equal(report.ok, false);
      assert.ok(report.issues.some((issue) => message.test(issue.message)), JSON.stringify(report.issues.slice(0, 3)));
    });
  }

  test('rejects edited machine blocks, wrong temperatures and header mismatches', () => {
    const editedStart = cube.gcode.replace('M190 S55', 'M190 S95');
    assert.match(JSON.stringify(preflightOf(editedStart).issues), /start sequence differs/);
    const noEnd = cube.gcode.replace('; MACHINE_END_GCODE_START\n', '');
    assert.match(JSON.stringify(preflightOf(noEnd).issues), /missing or duplicated/);
    const wrongLayers = cube.gcode.replace('; total layer number: 50', '; total layer number: 49');
    assert.match(JSON.stringify(preflightOf(wrongLayers).issues), /layer count/);
    const lighter = cube.gcode.replace(/; total filament length \[mm\] : [\d.]+/, '; total filament length [mm] : 1');
    assert.match(JSON.stringify(preflightOf(lighter).issues), /filament length/);
  });
});

describe('.gcode.3mf packaging', () => {
  test('writes the plate archive with a verified MD5 and P1S metadata', () => {
    const bytes = packageSlice(cube, profiles, choices, '#00AE42', 'Caliper-test');
    const entries = unzipSync(bytes);
    assert.deepEqual(Object.keys(entries).slice(0, 11), [
      '[Content_Types].xml',
      'Metadata/plate_1.json',
      '3D/3dmodel.model',
      'Metadata/project_settings.config',
      'Metadata/plate_1.gcode.md5',
      'Metadata/plate_1.gcode',
      'Metadata/_rels/model_settings.config.rels',
      'Metadata/model_settings.config',
      'Metadata/slice_info.config',
      'Metadata/filament_sequence.json',
      '_rels/.rels',
    ]);
    const gcode = entries['Metadata/plate_1.gcode'];
    assert.equal(strFromU8(gcode), cube.gcode);
    assert.equal(strFromU8(entries['Metadata/plate_1.gcode.md5']), createHash('md5').update(gcode).digest('hex').toUpperCase());
    const sliceInfo = strFromU8(entries['Metadata/slice_info.config']);
    assert.match(sliceInfo, /key="printer_model_id" value="C12"/);
    assert.match(sliceInfo, /key="X-BBL-Client-Version" value="\d\d\.\d\d\.\d\d\.\d\d"/);
    assert.match(sliceInfo, /tray_info_idx="GFA00" type="PLA"/);
    assert.match(sliceInfo, /key="first_layer_time" value="\d+\.\d{6}"/);
    assert.match(sliceInfo, /<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"\/>/);
    assert.match(sliceInfo, /layer_filament_list filament_list="0" layer_ranges="0 49"/);
    assert.ok(entries['Metadata/filament_sequence.json']);
    const plate = JSON.parse(strFromU8(entries['Metadata/plate_1.json']));
    assert.equal(plate.bed_type, 'textured_plate');
    assert.equal(plate.bbox_all.length, 4);
    assert.ok(plate.bbox_objects[0].area > 300);
    const settings = JSON.parse(strFromU8(entries['Metadata/project_settings.config']));
    assert.equal(settings.curr_bed_type, 'Textured PEI Plate');
    assert.equal(settings.printer_model, 'Bambu Lab P1S');
    assert.deepEqual(settings.filament_settings_id, ['Bambu PLA Basic @BBL P1S 0.4 nozzle']);
    assert.match(strFromU8(entries['Metadata/model_settings.config']), /key="gcode_file" value="Metadata\/plate_1.gcode"/);
    const png = entries['Metadata/plate_1.png'];
    assert.deepEqual([...png.slice(1, 4)], [0x50, 0x4e, 0x47]);
    assert.equal(new DataView(png.buffer, png.byteOffset).getUint32(16), 512);
  });
});

describe('G-code maths', () => {
  test('matches the Flow.cpp bead area, trapezoid timing, fan rules and outline crossing', () => {
    assert.ok(Math.abs(beadArea(0.42, 0.2) - 0.2 * (0.42 - 0.2 * (1 - Math.PI / 4))) < 1e-12);
    assert.equal(moveSeconds(0, 100, 1000), 0);
    assert.ok(Math.abs(moveSeconds(100, 100, 10000) - 1.01) < 1e-9);
    assert.ok(Math.abs(moveSeconds(1, 100, 10000) - 0.02) < 1e-9);
    const settings = cube.settings;
    assert.equal(layerFanPercent(100, 0, settings), 0);
    assert.equal(layerFanPercent(1, 3, settings), 100);
    const outline = [[{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]];
    assert.equal(crossesOutline({ x: 2, y: 2 }, { x: 8, y: 8 }, outline), false);
    assert.equal(crossesOutline({ x: 2, y: 2 }, { x: 20, y: 8 }, outline), true);
  });

  test('MD5 and PNG encoders produce standard output', () => {
    const data = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    assert.equal(md5Hex(data), '9e107d9d372bb6826bd81d3542a419d6');
    assert.equal(md5Hex(new Uint8Array(0)), 'd41d8cd98f00b204e9800998ecf8427e');
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]));
    assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.throws(() => encodePng(2, 2, new Uint8Array(4)), /wrong size/);
  });
});
