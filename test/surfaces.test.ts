import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLayerSurfaces, subtractSurfaceRegions } from '../src/lib/surfaces.ts';

const square = (min: number, max: number) => [
  { x: min, z: min },
  { x: max, z: min },
  { x: max, z: max },
  { x: min, z: max },
];

function area(loops: { x: number; z: number }[][]): number {
  return loops.reduce((sum, loop) => {
    let twiceArea = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      twiceArea += a.x * b.z - b.x * a.z;
    }
    return sum + twiceArea / 2;
  }, 0);
}

describe('classifyLayerSurfaces', () => {
  test('subtracts exposed skin regions without filling holes', () => {
    const remaining = subtractSurfaceRegions(
      [square(0, 10), square(3, 7).reverse()],
      [square(0, 5)],
    );

    assert.ok(Math.abs(area(remaining) - 63) < 1e-4);
  });

  test('marks exactly three solid layers below an exposed top surface', () => {
    const layers = Array.from({ length: 5 }, () => ({ region: [square(0, 10)] }));
    const result = classifyLayerSurfaces(layers, { topSolidLayers: 3, bottomSolidLayers: 0 });

    assert.deepEqual(result.map((layer) => area(layer.topShell)), [0, 0, 100, 100, 100]);
    assert.deepEqual(result.map((layer) => area(layer.internal)), [100, 100, 0, 0, 0]);
    assert.equal(area(result[4].top), 100);
    assert.equal(area(result[3].top), 0);
  });

  test('marks bottom shells upward and limits shell propagation to the changing region', () => {
    const layers = [
      { region: [square(0, 10)] },
      { region: [square(1, 9)] },
      { region: [square(2, 8)] },
      { region: [square(2, 8)] },
    ];
    const result = classifyLayerSurfaces(layers, { topSolidLayers: 0, bottomSolidLayers: 3 });
    assert.deepEqual(result.map((layer) => area(layer.bottomShell)), [100, 64, 36, 0]);
    assert.equal(area(result[0].bottom), 100);
    assert.equal(area(result[0].bottom), 100);
  });

  test('preserves holes when computing exposed surfaces and internal area', () => {
    const region = [square(0, 10), square(3, 7).reverse()];
    const result = classifyLayerSurfaces([{ region }], { topSolidLayers: 1, bottomSolidLayers: 1 });

    assert.ok(Math.abs(area(result[0].top) - 84) < 1e-4);
    assert.ok(Math.abs(area(result[0].bottom) - 84) < 1e-4);
    assert.ok(Math.abs(area(result[0].solid) - 84) < 1e-4);
    assert.equal(result[0].top.length, 2);
    assert.equal(area(result[0].internal), 0);
  });

  test('unions overlapping contours into one layer region', () => {
    const result = classifyLayerSurfaces(
      [{ region: [square(0, 2), square(1, 3)] }],
      { topSolidLayers: 1, bottomSolidLayers: 1 },
    );

    assert.equal(result[0].top.length, 1);
    assert.equal(area(result[0].top), 7);
    assert.equal(area(result[0].solid), 7);
  });

  test('supports zero shells and rejects invalid shell counts', () => {
    const layers = [{ region: [square(0, 2)] }];
    const result = classifyLayerSurfaces(layers, { topSolidLayers: 0, bottomSolidLayers: 0 });

    assert.equal(area(result[0].solid), 0);
    assert.equal(area(result[0].internal), 4);
    assert.throws(
      () => classifyLayerSurfaces(layers, { topSolidLayers: 1.5, bottomSolidLayers: 0 }),
      /integer/,
    );
  });
});
