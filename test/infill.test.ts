import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeDirectionFromInfill,
  calculateInfillSpacing,
  generateInfillPaths,
} from '../src/lib/infill.ts';
import type { ContourLoop } from '../src/lib/slicing.ts';

const square: ContourLoop = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 10 },
  { x: 0, z: 10 },
];

function length(path: { x: number; z: number }[]) {
  const [a, b] = path;
  return Math.hypot(b.x - a.x, b.z - a.z);
}

describe('infill', () => {
  test('chooses a bridge direction perpendicular to measured infill paths', () => {
    const horizontal = [[{ x: 0, z: 2 }, { x: 10, z: 2 }]] as const;
    const vertical = [[{ x: 2, z: 0 }, { x: 2, z: 10 }]] as const;

    assert.equal(bridgeDirectionFromInfill(horizontal, 0), 90);
    assert.equal(bridgeDirectionFromInfill(vertical, 90), 0);
    assert.equal(bridgeDirectionFromInfill([], 90), 90);
    assert.throws(
      () => bridgeDirectionFromInfill([[{ x: 0, z: 0 }, { x: Infinity, z: 1 }]], 0),
      /coordinates must be finite/i,
    );
  });

  test('converts density to centre-to-centre line spacing', () => {
    assert.equal(calculateInfillSpacing(0.45, 0.2), 2.25);
    assert.equal(calculateInfillSpacing(0.45, 1), 0.45);
    assert.throws(() => calculateInfillSpacing(0.45, 0), /density/);
    assert.throws(() => calculateInfillSpacing(0.45, 1.1), /density/);
  });

  test('clips solid rectilinear lines to a square and alternates their direction', () => {
    const paths = generateInfillPaths([square], {
      pattern: 'rectilinear',
      lineSpacing: 2,
      angleDegrees: 0,
    });

    assert.equal(paths.length, 5);
    assert.ok(paths.every((path) => Math.abs(length(path) - 10) < 1e-8));
    assert.deepEqual(paths.map(([a, b]) => Math.sign(b.x - a.x)), [1, -1, 1, -1, 1]);
  });

  test('keeps holes empty and emits separate paths for each side', () => {
    const hole = [
      { x: 4, z: 4 },
      { x: 6, z: 4 },
      { x: 6, z: 6 },
      { x: 4, z: 6 },
    ].reverse();
    const paths = generateInfillPaths([square, hole], {
      pattern: 'monotonic',
      lineSpacing: 5,
      angleDegrees: 0,
    });
    const crossingHole = paths.filter((path) => Math.abs(path[0].z - 5) < 1e-8);

    assert.equal(crossingHole.length, 2);
    assert.ok(crossingHole.every((path) => Math.abs(length(path) - 4) < 1e-8));
    assert.ok(crossingHole.every(([a, b]) => b.x > a.x));
  });

  test('keeps monotonic infill direction consistent across layers', () => {
    const firstLayer = generateInfillPaths([square], {
      pattern: 'monotonic',
      lineSpacing: 2,
      angleDegrees: 0,
      layerIndex: 0,
    });
    const nextLayer = generateInfillPaths([square], {
      pattern: 'monotonic',
      lineSpacing: 2,
      angleDegrees: 0,
      layerIndex: 1,
    });

    assert.deepEqual(nextLayer, firstLayer);
  });

  test('grid uses two crossing line families; orientation alternates between layers', () => {
    const grid = generateInfillPaths([square], {
      pattern: 'grid',
      lineSpacing: 2,
      angleDegrees: 0,
    });
    const nextLayer = generateInfillPaths([square], {
      pattern: 'rectilinear',
      lineSpacing: 2,
      angleDegrees: 0,
      layerIndex: 1,
    });

    assert.equal(grid.length, 10);
    assert.ok(nextLayer.every((path) => Math.abs(path[1].z - path[0].z) > 9.9));
  });

  test('rejects invalid line spacing, angle, layer and pattern inputs', () => {
    assert.throws(
      () => generateInfillPaths([square], { pattern: 'grid', lineSpacing: 0 }),
      /spacing/,
    );
    assert.throws(
      () => generateInfillPaths([square], { pattern: 'grid', lineSpacing: 1, angleDegrees: Infinity }),
      /angle/,
    );
    assert.throws(
      () => generateInfillPaths([square], { pattern: 'grid', lineSpacing: 1, layerIndex: -1 }),
      /layer index/,
    );
    assert.throws(
      () => generateInfillPaths([square], { pattern: 'cross' as 'grid', lineSpacing: 1 }),
      /pattern/,
    );
  });
});
