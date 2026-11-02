import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateLayerPlan, sliceContours } from '../src/lib/slicing.ts';
import { fromArray } from '../src/viewer/triangles.ts';

function boxTriangles(
  output: number[],
  min: [number, number, number],
  max: [number, number, number],
): void {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
  ] as const;
  for (const [a, b, c, d] of faces) {
    output.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
}

function loopArea(loop: { x: number; z: number }[]): number {
  let twiceArea = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    twiceArea += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twiceArea / 2);
}

describe('generateLayerPlan', () => {
  test('matches the 1 mm worked example with five 0.2 mm layers', () => {
    const layers = generateLayerPlan(1, { layerHeight: 0.2, firstLayerHeight: 0.2 });
    assert.equal(layers.length, 5);
    const expected = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const [index, layer] of layers.entries()) {
      assert.ok(Math.abs(layer.sliceZ - expected[index]) < 1e-12);
      assert.ok(Math.abs(layer.height - 0.2) < 1e-12);
    }
  });

  test('interpolates variable layer heights and reaches the part top', () => {
    const layers = generateLayerPlan(1, {
      layerHeight: 0.2,
      firstLayerHeight: 0.2,
      profile: [
        { z: 0, height: 0.2 },
        { z: 1, height: 0.4 },
      ],
    });
    assert.ok(Math.abs(layers[1].height - 0.247) < 1e-12);
    assert.equal(layers.at(-1)?.top, 1);
    assert.equal(layers.at(-1)?.sliceZ, (layers.at(-1)!.bottom + 1) / 2);
  });

  test('keeps a short final layer and handles zero-height models', () => {
    const layers = generateLayerPlan(1.05, { layerHeight: 0.2 });
    assert.ok(Math.abs((layers.at(-1)?.height ?? 0) - 0.05) < 1e-12);
    assert.deepEqual(generateLayerPlan(0, { layerHeight: 0.2 }), [
      { index: 1, bottom: 0, top: 0, height: 0, sliceZ: 0, printZ: 0 },
    ]);
  });

  test('rejects invalid layer settings and unsorted profiles', () => {
    assert.throws(() => generateLayerPlan(1, { layerHeight: 0 }), RangeError);
    assert.throws(
      () =>
        generateLayerPlan(1, {
          layerHeight: 0.2,
          profile: [
            { z: 0.5, height: 0.2 },
            { z: 0.4, height: 0.3 },
          ],
        }),
      /strictly increasing/,
    );
  });
});

describe('sliceContours', () => {
  test('cuts a cube into one closed square outline, including a plane through vertices', () => {
    const triangles: number[] = [];
    boxTriangles(triangles, [0, 0, 0], [2, 1, 2]);
    const source = fromArray(triangles);

    const middle = sliceContours(source, 0.5);
    assert.equal(middle.length, 1);
    assert.ok(Math.abs(loopArea(middle[0]) - 4) < 1e-6);

    const bottom = sliceContours(source, 0);
    assert.equal(bottom.length, 1);
    assert.ok(Math.abs(loopArea(bottom[0]) - 4) < 1e-6);
  });

  test('cuts a cylinder into a closed polygonal perimeter', () => {
    const triangles: number[] = [];
    const sides = 16;
    const radius = 2;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const b = ((i + 1) / sides) * Math.PI * 2;
      const bottomA = [Math.cos(a) * radius, 0, Math.sin(a) * radius];
      const bottomB = [Math.cos(b) * radius, 0, Math.sin(b) * radius];
      const topA = [bottomA[0], 1, bottomA[2]];
      const topB = [bottomB[0], 1, bottomB[2]];
      triangles.push(...bottomA, ...bottomB, ...topB, ...bottomA, ...topB, ...topA);
    }

    const loops = sliceContours(fromArray(triangles), 0.5);
    const expectedArea = (sides * radius * radius * Math.sin((Math.PI * 2) / sides)) / 2;
    assert.equal(loops.length, 1);
    assert.ok(Math.abs(loopArea(loops[0]) - expectedArea) < 1e-5);
  });

  test('keeps inner rings as separate loops for a hollow box', () => {
    const triangles: number[] = [];
    boxTriangles(triangles, [0, 0, 0], [2, 1, 2]);
    boxTriangles(triangles, [0.5, 0, 0.5], [1.5, 1, 1.5]);

    const loops = sliceContours(fromArray(triangles), 0.5);
    assert.equal(loops.length, 2);
    assert.deepEqual(loops.map(loopArea).sort((a, b) => a - b), [1, 4]);
  });

  test('drops open chains and rejects invalid planes and tolerances', () => {
    const open = fromArray([0, 0, 0, 1, 1, 0, 0, 1, 1]);
    assert.deepEqual(sliceContours(open, 0.5), []);
    assert.throws(() => sliceContours(open, Number.NaN), /finite/);
    assert.throws(() => sliceContours(open, 0.5, 0), /positive finite/);
  });
});
