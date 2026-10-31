import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findUnsupportedBridgeSpans, planBridgeOverInfill } from '../src/lib/bridges.ts';
import type { ContourLoop } from '../src/lib/slicing.ts';

const square: ContourLoop = [
  { x: 0, z: 0 },
  { x: 20, z: 0 },
  { x: 20, z: 20 },
  { x: 0, z: 20 },
];

describe('bridge-over-infill planning', () => {
  test('marks only bridge intervals between actual sparse-infill crossings', () => {
    const spans = findUnsupportedBridgeSpans(
      [[{ x: 0, z: 5 }, { x: 10, z: 5 }]],
      [
        [{ x: 3, z: 0 }, { x: 3, z: 10 }],
        [{ x: 7, z: 0 }, { x: 7, z: 10 }],
      ],
    );

    assert.deepEqual(spans, [[{ x: 3, z: 5 }, { x: 7, z: 5 }]]);
  });

  test('plans visible bridge paths over sparse internal regions', () => {
    const plan = planBridgeOverInfill([square], [square], {
      lineWidthMm: 0.45,
      worldPerMm: 1,
      density: 0.2,
      layerIndex: 1,
      analyzeSupportSpans: true,
    });

    assert.ok(plan.region.length > 0);
    assert.ok(plan.paths.length > 0);
    assert.ok(plan.unsupportedSpans.length > 0);
    assert.ok(plan.paths.every((path) => path.length === 2));
    assert.ok(plan.angleDegrees === 0 || plan.angleDegrees === 90);
  });

  test('omits first-layer and fully-supported dense-infill bridge paths', () => {
    const options = { lineWidthMm: 0.45, worldPerMm: 1, density: 0.2, layerIndex: 0 };
    assert.deepEqual(planBridgeOverInfill([square], [square], options).paths, []);
    assert.deepEqual(
      planBridgeOverInfill([square], [square], { ...options, density: 1, layerIndex: 1 }).paths,
      [],
    );
  });
});
