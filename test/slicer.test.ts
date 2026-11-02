import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exArea, toUnits, type ExPoly } from '../src/slicer/clipper.ts';
import { bridgeArea, capSpeed, ePerMm3, filamentArea, impliedWidth, lineArea, lineSpacing } from '../src/slicer/flow.ts';
import { generateLayers } from '../src/slicer/layers.ts';
import { sliceMesh } from '../src/slicer/slice.ts';
import { makeWalls } from '../src/slicer/walls.ts';
import { classifySurfaces } from '../src/slicer/surfaces.ts';
import { lineFill } from '../src/slicer/infill.ts';
import { fanFor, fillTemplate, slowdownFactor } from '../src/slicer/gcode.ts';
import { slicePlate, SliceError, type SliceInput } from '../src/slicer/index.ts';
import { DEFAULT_PROCESS, filamentById, type FilamentId } from '../src/slicer/profiles.ts';
import { box, cube20, f32, sphere } from './meshes.ts';

/* The slicer, checked against numbers worked out by hand. The worked examples
   are the ones in docs/slicer-logic.md, so the document and the code cannot
   drift apart without a test noticing. */

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

const mm2 = (polys: ExPoly[]) => exArea(polys) / 1e6;

describe('flow maths (docs 15.4)', () => {
  test('a 0.45 × 0.2 mm line holds 0.081416 mm³ per mm', () => {
    near(lineArea(0.45, 0.2), 0.081416, 1e-6);
    near(lineSpacing(0.45, 0.2), 0.40708, 1e-5);
  });

  test('1.75 mm filament is 2.40528 mm², so 10 mm of that line needs 0.33849 mm of filament', () => {
    near(filamentArea(1.75), 2.40528, 1e-5);
    near(lineArea(0.45, 0.2) * ePerMm3(1.75, 1) * 10, 0.33849, 1e-5);
  });

  test('the volumetric cap: 15 mm³/s through that line is 184 mm/s', () => {
    near(capSpeed(250, lineArea(0.45, 0.2), 15), 184.239, 1e-3);
    assert.equal(capSpeed(100, lineArea(0.45, 0.2), 15), 100);
  });

  test('a bridge thread is round', () => near(bridgeArea(0.4), (Math.PI * 0.16) / 4));

  test('impliedWidth inverts lineArea', () => near(impliedWidth(lineArea(0.42, 0.2), 0.2), 0.42, 1e-9));

  test('a line too narrow for its height is refused, not given negative flow', () => {
    assert.throws(() => lineArea(0.1, 0.5), RangeError);
  });
});

describe('layer heights (docs 7.4)', () => {
  test('a 1 mm part at 0.2 mm is five layers, each cut at its middle', () => {
    const layers = generateLayers(1, 0.2, 0.2);
    assert.deepEqual(
      layers.map((l) => [l.bottom, l.top, l.sliceZ]),
      [
        [0, 0.2, 0.1],
        [0.2, 0.4, 0.30000000000000004],
        [0.4, 0.6, 0.5],
        [0.6, 0.8, 0.7],
        [0.8, 1, 0.9],
      ].map(([b, t, s]) => [b, t, s]),
    );
  });

  test('a different first layer height, and the top that ends short (the FIXME in 7.4)', () => {
    // 0.3 + 3 × 0.2 = 0.9. A fifth layer would be cut at 1.0, not below the
    // 1 mm top, so it is left out and the print ends 0.1 mm short, as in both slicers.
    const layers = generateLayers(1, 0.3, 0.2);
    assert.equal(layers[0].top, 0.3);
    assert.equal(layers[1].top, 0.5);
    assert.equal(layers.length, 4);
    assert.equal(layers[3].top, 0.9);
  });

  test('no drift over a thousand layers', () => {
    const layers = generateLayers(200, 0.2, 0.2);
    assert.equal(layers.length, 1000);
    assert.equal(layers[999].top, 200);
  });
});

describe('cutting the mesh (docs 8)', () => {
  test('a 20 mm cube is a 400 mm² square on every layer', () => {
    const zs = generateLayers(20, 0.2, 0.2).map((l) => l.sliceZ);
    const { layers, diagnostics } = sliceMesh({ positions: f32(cube20()) }, zs);
    assert.equal(layers.length, 100);
    for (const layer of layers) {
      assert.equal(layer.length, 1);
      near(mm2(layer), 400, 1e-6);
    }
    assert.equal(diagnostics.openContours.size, 0);
  });

  test('an inside-out box inside a box is a hole', () => {
    const mesh = [...box([-15, -15, 0], [15, 15, 10]), ...box([-5, -5, 2], [5, 5, 8], { flip: true })];
    const { layers } = sliceMesh({ positions: f32(mesh) }, [1, 5]);
    near(mm2(layers[0]), 900, 1e-6);
    assert.equal(layers[1][0].holes.length, 1);
    near(mm2(layers[1]), 800, 1e-6);
  });

  test('overlapping shells merge into one solid (the non-zero rule)', () => {
    const mesh = [...box([0, 0, 0], [10, 10, 5]), ...box([5, 0, 0], [15, 10, 5])];
    const { layers } = sliceMesh({ positions: f32(mesh) }, [2]);
    assert.equal(layers[0].length, 1);
    near(mm2(layers[0]), 150, 1e-6);
  });

  test('a mesh with a missing wall is reported, not silently mended', () => {
    const { diagnostics } = sliceMesh({ positions: f32(box([0, 0, 0], [20, 20, 5], { skip: ['front'] })) }, [1, 2]);
    assert.equal(diagnostics.openContours.size, 2);
  });

  test('corners exactly on a cutting plane: the face above counts, the one below does not', () => {
    const { layers } = sliceMesh({ positions: f32(cube20()) }, [0, 20]);
    assert.equal(layers[0].length, 1);
    assert.equal(layers[1].length, 0);
  });

  test('two parts stacked exactly on a cutting plane keep their outline there', () => {
    const stacked = [...box([0, 0, 0], [10, 10, 5]), ...box([0, 0, 5], [10, 10, 10])];
    const { layers, diagnostics } = sliceMesh({ positions: f32(stacked) }, [5]);
    near(mm2(layers[0]), 100, 1e-6);
    assert.equal(diagnostics.openContours.size, 0);
  });
});

describe('walls (docs 9.3)', () => {
  const square: ExPoly = {
    contour: [
      { X: 0, Y: 0 },
      { X: toUnits(20), Y: 0 },
      { X: toUnits(20), Y: toUnits(20) },
      { X: 0, Y: toUnits(20) },
    ],
    holes: [],
  };

  test('the outer wall runs half a line inside the outline, the next one a spacing further in', () => {
    const walls = makeWalls(square, 2, { outer: 0.42, inner: 0.45, infillSpacing: lineSpacing(0.45, 0.2) }, 0.2);
    const outer = walls.loops.find((l) => l.index === 0)!;
    const inner = walls.loops.find((l) => l.index === 1)!;
    const side = (path: { X: number }[]) => (Math.max(...path.map((p) => p.X)) - Math.min(...path.map((p) => p.X))) / 1000;
    near(side(outer.path), 20 - 0.42, 1e-3);
    const step = (lineSpacing(0.42, 0.2) + lineSpacing(0.45, 0.2)) / 2;
    near(side(inner.path), 20 - 0.42 - 2 * step, 1e-3);
    assert.ok(walls.infillArea.length === 1);
    assert.equal(walls.lostArea, 0);
  });

  test('a strip thinner than one line is reported as lost', () => {
    const strip: ExPoly = {
      contour: [
        { X: 0, Y: 0 },
        { X: toUnits(10), Y: 0 },
        { X: toUnits(10), Y: toUnits(0.3) },
        { X: 0, Y: toUnits(0.3) },
      ],
      holes: [],
    };
    const walls = makeWalls(strip, 2, { outer: 0.42, inner: 0.45, infillSpacing: 0.4 }, 0.2);
    assert.equal(walls.loops.length, 0);
    near(walls.lostArea, 3, 1e-3);
  });
});

describe('surfaces (docs 10)', () => {
  const zs = generateLayers(20, 0.2, 0.2);
  const { layers } = sliceMesh({ positions: f32(cube20()) }, zs.map((l) => l.sliceZ));
  const infill = layers.map((layer) =>
    layer.flatMap((island) => makeWalls(island, 2, { outer: 0.42, inner: 0.45, infillSpacing: 0.4 }, 0.2).infillArea),
  );
  const surfaces = classifySurfaces(layers, infill, 4, 3, toUnits(0.2));

  test('three bottom layers and four top layers are solid, the middle is sparse', () => {
    for (const i of [0, 1, 2, 96, 97, 98, 99]) assert.equal(surfaces[i].sparse.length, 0, `layer ${i}`);
    for (const i of [3, 50, 95]) assert.ok(mm2(surfaces[i].sparse) > 300, `layer ${i}`);
  });

  test('only the last layer is a top surface, and a cube has nothing to bridge', () => {
    assert.ok(mm2(surfaces[99].top) > 300);
    for (let i = 0; i < 99; i++) assert.equal(surfaces[i].top.length, 0, `layer ${i}`);
    assert.ok(surfaces.every((s) => s.bridge.length === 0));
  });

  test('a table top over two legs bridges on its first layer', () => {
    const table = [
      ...box([0, 0, 0], [5, 20, 10]),
      ...box([25, 0, 0], [30, 20, 10]),
      ...box([0, 0, 10], [30, 20, 12]),
    ];
    const specs = generateLayers(12, 0.2, 0.2);
    const sliced = sliceMesh({ positions: f32(table) }, specs.map((l) => l.sliceZ)).layers;
    const fill = sliced.map((layer) =>
      layer.flatMap((island) => makeWalls(island, 2, { outer: 0.42, inner: 0.45, infillSpacing: 0.4 }, 0.2).infillArea),
    );
    const s = classifySurfaces(sliced, fill, 4, 3, toUnits(0.2));
    // Layer 50 is the first at Z 10–10.2: the gap between the legs is in the air.
    assert.ok(mm2(s[50].bridge) > 250, `bridge area ${mm2(s[50].bridge)}`);
    assert.equal(s[51].bridge.length, 0);
  });
});

describe('infill lines (docs 11)', () => {
  const square: ExPoly = {
    contour: [
      { X: 500, Y: 500 },
      { X: 10500, Y: 500 },
      { X: 10500, Y: 10500 },
      { X: 500, Y: 10500 },
    ],
    holes: [],
  };

  test('lines every spacing across the region, alternating direction', () => {
    const lines = lineFill([square], 0, 1000);
    assert.equal(lines.length, 10);
    assert.ok(lines[0][0].X < lines[0][1].X);
    assert.ok(lines[1][0].X > lines[1][1].X);
    for (const [p, q] of lines) near(Math.abs(q.X - p.X), 10000, 2);
  });

  test('the grid is fixed to the bed, so lines line up from layer to layer', () => {
    const a = lineFill([square], 45, 2000).map(([p]) => Math.round((p.Y - p.X) / Math.SQRT2));
    const shifted = { contour: square.contour.map((p) => ({ X: p.X + 300, Y: p.Y })), holes: [] };
    const b = lineFill([shifted], 45, 2000).map(([p]) => Math.round((p.Y - p.X) / Math.SQRT2));
    for (const offset of b) assert.ok(a.some((o) => Math.abs((o - offset) % 2000) < 3 || Math.abs(Math.abs((o - offset) % 2000) - 2000) < 3));
  });
});

describe('cooling (docs 17.4)', () => {
  test('a 30 s layer runs the fan at 70 % (the worked example)', () => {
    const custom = { ...filamentById('pla'), slowdownLayerTime: 5, fanBelowLayerTime: 60 };
    const fan = { ...custom.fan, min: 35, max: 100, alwaysOn: false, offLayers: 0, fullAtLayer: 0 };
    assert.equal(fanFor({ ...custom, fan }, 10, 30), 70);
  });

  test('the fan is off on the first layer and ramps up to full', () => {
    const pla = filamentById('pla');
    assert.equal(fanFor(pla, 0, 100), 0);
    assert.equal(fanFor(pla, 1, 100), 50);
    assert.equal(fanFor(pla, 2, 100), 100);
  });

  test('a short layer is slowed to the minimum layer time', () => {
    near(slowdownFactor(3, 0, 6), 0.5);
    assert.equal(slowdownFactor(10, 0, 6), 1);
  });
});

describe('templates', () => {
  test('a placeholder Caliper does not know is refused instead of written through', () => {
    assert.throws(() => fillTemplate('M190 S{bed_temperature_initial_layer}', {}, 'start'), SliceError);
    assert.equal(fillTemplate('M190 S{ first_bed_temp }', { first_bed_temp: 60 }, 'start'), 'M190 S60');
  });
});

/* ------------------------------------------------------------ end to end */

const input = (positions: number[], overrides: Partial<SliceInput> = {}): SliceInput => ({
  positions: f32(positions),
  models: ['test.stl'],
  printerId: 'ender-3',
  filamentId: 'pla',
  process: DEFAULT_PROCESS,
  custom: null,
  generator: 'Caliper tests',
  ...overrides,
});

describe('slicing a plate end to end', () => {
  test('a 20 mm cube slices, and the G-code passes every check', () => {
    const out = slicePlate(input(cube20()));
    assert.equal(out.report.ok, true, JSON.stringify(out.report.findings.filter((f) => f.severity !== 'info')));
    assert.equal(out.layerCount, 100);
    assert.equal(out.report.stats.layers, 100);
    const p = out.report.stats.printed!;
    // Centred on the 220 mm bed, with a 3 mm skirt around the 20 mm cube.
    near(p.minX, 110 - 10 - 3 - 0.25, 0.01); // skirt centre line: 3 mm gap + half its 0.5 mm width
    near(p.maxZ, 20, 1e-6);
  });

  test('the plastic laid down matches a hand estimate of the cube', () => {
    const out = slicePlate(input(cube20()));
    const volume = out.report.stats.filamentMm * filamentArea(1.75);
    // Solid shell 7 × 0.2 × 400 = 560, two walls over 93 layers ≈ 1240,
    // 15 % of the ≈ 335 mm² core over 86 layers ≈ 860, plus purge and skirt.
    assert.ok(volume > 2400 && volume < 3000, `volume ${volume.toFixed(0)} mm³`);
  });

  test('every printer with a built-in start sequence produces a passing file', () => {
    for (const printerId of ['ender-3', 'prusa-mk4']) {
      const out = slicePlate(input(cube20(), { printerId }));
      assert.equal(out.report.ok, true, printerId);
    }
  });

  test('a Bambu printer is refused until a start sequence is supplied', () => {
    assert.throws(() => slicePlate(input(cube20(), { printerId: 'bambu-256' })), SliceError);
    const start = 'G90\nM83\nM140 S{first_bed_temp}\nG28\nM190 S{first_bed_temp}\nM109 S{first_nozzle_temp}\nG92 E0';
    const out = slicePlate(input(cube20(), { printerId: 'bambu-256', custom: { start, end: '' } }));
    assert.equal(out.report.ok, true);
  });

  test('a start sequence pasted from another slicer is caught by the checker', () => {
    const start = 'G28\nM190 S[bed_temperature_initial_layer_single]\nM109 S{first_nozzle_temp}';
    const out = slicePlate(input(cube20(), { printerId: 'bambu-256', custom: { start, end: '' } }));
    assert.equal(out.report.ok, false);
    assert.ok(out.report.findings.some((f) => f.code === 'E002'));
  });

  test('a part that starts in mid-air blocks export', () => {
    const out = slicePlate(input([...box([-10, -10, 0], [10, 10, 10]), ...box([20, -5, 5], [30, 5, 15])]));
    assert.equal(out.report.ok, false);
    assert.ok(out.report.findings.some((f) => f.code === 'S004'));
  });

  test('a sphere warns about the overhang at its base', () => {
    const out = slicePlate(input(sphere(10, 32)));
    const overhang = out.report.findings.find((f) => f.code === 'S003');
    assert.ok(overhang);
    assert.ok(overhang.layer !== undefined && overhang.layer < 6);
  });

  test('settings the printer cannot take are refused before slicing', () => {
    assert.throws(() => slicePlate(input(cube20(), { filamentId: 'abs' })), /above this printer's 245 °C limit/);
    assert.throws(() => slicePlate(input(cube20(), { printerId: 'bambu-180', filamentId: 'abs', custom: { start: 'G28', end: '' } })), /bed/);
    assert.throws(() => slicePlate(input(cube20(), { process: { ...DEFAULT_PROCESS, layerHeight: 0.4 } })), /Layer height/);
  });

  test('a model off the bed or under it is refused', () => {
    assert.throws(() => slicePlate(input(box([95, -10, 0], [115, 10, 20]))), /outside/);
    assert.throws(() => slicePlate(input(box([-10, -10, -2], [10, 10, 20]))), /do not sit on the bed/);
    assert.throws(() => slicePlate(input([])), /Nothing to slice/);
  });

  test('the defaults are safe for every built-in filament on a printer that can take them', () => {
    for (const filamentId of ['pla', 'petg', 'abs'] as FilamentId[]) {
      const out = slicePlate(input(cube20(), { printerId: 'prusa-mk4', filamentId }));
      assert.equal(out.report.ok, true, filamentId);
    }
  });
});
