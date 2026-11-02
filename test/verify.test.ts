import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGcode, roleIndex, PREVIEW_ROLES, type VerifyOptions } from '../src/slicer/verify.ts';
import { filamentById, printerById } from '../src/slicer/profiles.ts';
import { slicePlate } from '../src/slicer/index.ts';
import { DEFAULT_PROCESS } from '../src/slicer/profiles.ts';
import { cube20, f32 } from './meshes.ts';

/* The G-code checker, fed one dangerous file per test. Each file is the
   smallest that shows one failure, built from a known-good program by changing
   a single line, so a test that passes cannot be passing by accident. */

const ender = printerById('ender-3')!;
const external: VerifyOptions = { printer: ender, filament: filamentById('pla'), source: 'external' };

/** A minimal, correct print: home, heat, two layers of one line each, cool down. */
const GOOD = [
  'G90',
  'M83',
  'M140 S60',
  'G28',
  'M190 S60',
  'M109 S210',
  'G92 E0',
  'G1 Z0.2 F300',
  'G1 X50 Y50 F6000',
  ';TYPE:Outer wall',
  'G1 X70 Y50 E0.7 F1800',
  'G1 Z0.4 F300',
  'G1 X50 Y50 E0.7 F1800',
  'G1 Z10 F300',
  'M104 S0',
  'M140 S0',
  'M84 X Y E',
];

const program = (edit: (lines: string[]) => void = () => {}) => {
  const lines = GOOD.slice();
  edit(lines);
  return lines.join('\n');
};
const codes = (text: string, options: VerifyOptions = external) => verifyGcode(text, options).findings.map((f) => f.code);
const replace = (from: string, to: string) => (lines: string[]) => {
  const i = lines.indexOf(from);
  assert.ok(i >= 0, `no line "${from}"`);
  lines[i] = to;
};
const insertBefore = (anchor: string, ...added: string[]) => (lines: string[]) => {
  const i = lines.indexOf(anchor);
  assert.ok(i >= 0, `no line "${anchor}"`);
  lines.splice(i, 0, ...added);
};

describe('a good program', () => {
  test('passes with no errors or warnings', () => {
    const report = verifyGcode(program(), external);
    assert.deepEqual(
      report.findings.filter((f) => f.severity !== 'info'),
      [],
    );
    assert.equal(report.ok, true);
    assert.equal(report.stats.layers, 2);
    assert.equal(report.stats.filamentMm, 1.4);
    assert.equal(report.stats.firstLayerZ, 0.2);
  });

  test('the preview holds exactly its two printed lines, one per layer', () => {
    const { preview } = verifyGcode(program(), external);
    assert.equal(preview.segments.length, 12);
    assert.deepEqual([...preview.layerStarts], [0, 1]);
    // Stored as 32-bit floats for the GPU, so compared to a micrometre.
    [50, 50, 0.2, 70, 50, 0.2].forEach((v, i) => assert.ok(Math.abs(preview.segments[i] - v) < 1e-3));
    assert.equal(preview.roles[0], 0);
  });
});

describe('crashes and the machine’s limits', () => {
  test('moving before homing', () => {
    assert.ok(codes(program(insertBefore('G28', 'G1 X10 Y10 F3000'))).includes('E010'));
  });

  test('moving again after the motors were released, without homing', () => {
    assert.ok(codes(program((l) => l.push('G1 X10 F3000'))).includes('E010'));
  });

  test('past the end of an axis', () => {
    assert.ok(codes(program(replace('G1 X50 Y50 F6000', 'G1 X250 Y50 F6000'))).includes('E011'));
  });

  test('taller than the printer', () => {
    assert.ok(codes(program(replace('G1 Z10 F300', 'G1 Z260 F300'))).includes('E011'));
  });

  test('the nozzle below the bed', () => {
    assert.ok(codes(program(replace('G1 Z0.2 F300', 'G1 Z-0.5 F300'))).includes('E020'));
  });

  test('extruding with the nozzle touching the bed', () => {
    assert.ok(codes(program(replace('G1 Z0.2 F300', 'G1 Z0.02 F300'))).includes('E021'));
  });

  test('printing below a layer that is already finished', () => {
    const text = program(insertBefore('G1 Z10 F300', 'G1 Z0.2 F300', 'G1 X50 Y60 E0.35 F1800'));
    assert.ok(codes(text).includes('E023'));
  });

  test('travelling down into the print', () => {
    const text = program(insertBefore('G1 Z10 F300', 'G1 Z0.1 F300', 'G1 X60 Y60 F6000'));
    assert.ok(codes(text).includes('E024'));
  });

  test('an arc whose circle leaves the bed', () => {
    const text = program(insertBefore('G1 Z10 F300', 'G2 X50 Y50 I200 J0 E1 F1800'));
    assert.ok(codes(text).includes('E011'));
  });
});

describe('temperatures', () => {
  test('a nozzle hotter than the hot end is rated for', () => {
    assert.ok(codes(program(replace('M109 S210', 'M109 S280'))).includes('E030'));
  });

  test('a bed hotter than it is rated for', () => {
    assert.ok(codes(program(replace('M140 S60', 'M140 S130'))).includes('E031'));
  });

  test('extruding with a cold nozzle', () => {
    assert.ok(codes(program(replace('M109 S210', 'M104 S0'))).includes('E034'));
  });

  test('extruding before waiting for the nozzle', () => {
    assert.ok(codes(program(replace('M109 S210', 'M104 S210'))).includes('E035'));
  });

  test('printing before the bed has warmed', () => {
    assert.ok(codes(program(replace('M190 S60', 'M140 S60'))).includes('W036'));
  });

  test('a temperature outside the filament’s range', () => {
    assert.ok(codes(program(replace('M109 S210', 'M109 S240'))).includes('W032'));
  });

  test('heaters left on at the end', () => {
    assert.ok(codes(program(replace('M104 S0', 'M104 S200'))).includes('W070'));
  });

  test('the nozzle left sitting on the print', () => {
    assert.ok(codes(program(replace('G1 Z10 F300', 'G1 X10 F6000'))).includes('W071'));
  });
});

describe('extrusion', () => {
  test('a move with no speed', () => {
    assert.ok(codes(program(replace('G1 Z0.2 F300', 'G1 Z0.2 F0'))).includes('E040'));
  });

  test('a Z move faster than the axis allows', () => {
    assert.ok(codes(program(replace('G1 Z0.2 F300', 'G1 Z0.2 F1200'))).includes('W042'));
  });

  test('a blob: far more plastic than a line can hold', () => {
    assert.ok(codes(program(replace('G1 X70 Y50 E0.7 F1800', 'G1 X70 Y50 E9 F1800')), { ...external, source: 'caliper' }).includes('E051'));
  });

  test('a very long retraction', () => {
    const text = program(insertBefore('G1 Z0.4 F300', 'G1 E-30 F2400', 'G1 E30 F2400'));
    const report = verifyGcode(text, { ...external, source: 'caliper' });
    assert.ok(report.findings.some((f) => f.code === 'E053' && f.severity === 'error'));
    // From another slicer the same thing is a warning: some unload filament on purpose.
    assert.ok(verifyGcode(text, external).findings.some((f) => f.code === 'E053' && f.severity === 'warning'));
  });

  test('more flow than the hot end can melt', () => {
    assert.ok(codes(program(replace('G1 X70 Y50 E0.7 F1800', 'G1 X70 Y50 E0.7 F18000'))).includes('W050'));
  });

  test('plastic outside the bed but inside the machine’s reach', () => {
    const mk4 = printerById('prusa-mk4')!;
    const text = program(insertBefore('G1 Z0.4 F300', 'G1 X60 Y-3 E0.6 F1800'));
    assert.ok(codes(text, { ...external, printer: mk4, source: 'caliper' }).includes('E012'));
  });
});

describe('a file that cannot be trusted', () => {
  test('an unfilled placeholder from another slicer’s template', () => {
    assert.ok(codes(program(replace('M190 S60', 'M190 S[bed_temperature_initial_layer_single]'))).includes('E002'));
    assert.ok(codes(program(replace('M190 S60', 'M190 S{bed_temp}'))).includes('E002'));
  });

  test('a number the printer cannot read', () => {
    assert.ok(codes(program(replace('G1 X70 Y50 E0.7 F1800', 'G1 XNaN Y50 E0.7 F1800'))).includes('E001'));
  });

  test('a tool change on a single-nozzle printer', () => {
    assert.ok(codes(program(insertBefore('G1 Z0.4 F300', 'T1')), { ...external, source: 'caliper' }).includes('E060'));
  });

  test('an empty file', () => {
    assert.ok(codes('G28\n').includes('E100'));
  });
});

describe('Caliper’s own files', () => {
  const sliced = () =>
    slicePlate({
      positions: f32(cube20()),
      models: ['cube.stl'],
      printerId: 'ender-3',
      filamentId: 'pla',
      process: DEFAULT_PROCESS,
      custom: null,
      generator: 'Caliper tests',
    }).gcode;
  const caliper: VerifyOptions = { printer: ender, filament: filamentById('pla'), source: 'caliper' };

  test('a sliced file passes', () => {
    assert.equal(verifyGcode(sliced(), caliper).ok, true);
  });

  test('changing a single E value after slicing is detected', () => {
    const text = sliced().replace(/(G1 X[\d.]+ Y[\d.]+ E)0\.6/, '$11.6');
    assert.ok(codes(text, caliper).includes('E081'));
  });

  test('a file cut short is detected', () => {
    const text = sliced();
    assert.ok(codes(text.slice(0, Math.floor(text.length * 0.6)), caliper).includes('E083'));
  });

  test('checking it against a different printer is refused', () => {
    assert.ok(codes(sliced(), { ...caliper, printer: printerById('prusa-mk4')! }).includes('E080'));
  });

  test('the time estimate counts acceleration', () => {
    // 100 mm at 50 mm/s with 500 mm/s²: 2 s cruising + 0.1 s for the ramps.
    const text = ['G28', 'G1 X0 Y0 F3000', 'M204 S500', 'G1 X100 F3000'].join('\n');
    const { stats } = verifyGcode(text, { ...external, printer: { ...ender, maxAccel: 10000 } });
    assert.ok(Math.abs(stats.seconds - 2.1) < 1e-9, `${stats.seconds}`);
  });
});

describe('preview roles from other slicers', () => {
  test('PrusaSlicer and Bambu Studio labels map onto the same roles', () => {
    const role = (label: string) => PREVIEW_ROLES[roleIndex(label)];
    assert.equal(role('External perimeter'), 'Outer wall');
    assert.equal(role('Outer wall'), 'Outer wall');
    assert.equal(role('Overhang wall'), 'Outer wall');
    assert.equal(role('Perimeter'), 'Inner wall');
    assert.equal(role('Internal infill'), 'Sparse infill');
    assert.equal(role('Solid infill'), 'Solid infill');
    assert.equal(role('Top solid infill'), 'Top surface');
    assert.equal(role('Bridge infill'), 'Bridge');
    assert.equal(role('Skirt/Brim'), 'Skirt and brim');
    assert.equal(role('Support material'), 'Support');
    assert.equal(role('Prime tower'), 'Purge');
  });
});
