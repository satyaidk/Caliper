import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateGridSupportRegions } from '../src/lib/supports.ts';
import { calculateInfillSpacing, generateInfillPaths } from '../src/lib/infill.ts';
import type { ContourLoop } from '../src/lib/slicing.ts';

function rectangle(x0: number, z0: number, x1: number, z1: number): ContourLoop {
  return [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 },
  ];
}

describe('generateGridSupportRegions', () => {
  test('projects unsupported overhangs down while preserving the contact gap', () => {
    const stem = rectangle(4, 4, 6, 6);
    const supports = generateGridSupportRegions(
      [
        { region: [stem], bottom: 0, printZ: 0.2, height: 0.2 },
        { region: [stem], bottom: 0.2, printZ: 0.4, height: 0.2 },
        { region: [stem], bottom: 0.4, printZ: 0.6, height: 0.2 },
        { region: [stem], bottom: 0.6, printZ: 0.8, height: 0.2 },
        { region: [rectangle(0, 0, 10, 10)], bottom: 0.8, printZ: 1, height: 0.2 },
      ],
      {
        thresholdAngleDegrees: 30,
        contactDistance: 0.2,
        lineWidth: 0.45,
        interfaceLayers: 2,
      },
    );

    assert.ok(supports.body[0].length > 0);
    assert.ok(supports.interface[1].length > 0);
    assert.ok(supports.interface[2].length > 0);
    assert.ok(generateInfillPaths(supports.interface[1], {
      pattern: 'rectilinear',
      lineSpacing: calculateInfillSpacing(0.45, 0.6),
      angleDegrees: 0,
    }).length > 0);
    assert.deepEqual(supports.body[1], []);
    assert.deepEqual(supports.body[2], []);
    assert.deepEqual(supports.body[3], []);
    assert.deepEqual(supports.interface[0], []);
    assert.deepEqual(supports.interface[3], []);
    assert.deepEqual(supports.interface[4], []);
  });

  test('does not add supports beneath cross-sections within the allowed overhang angle', () => {
    const stem = rectangle(4, 4, 6, 6);
    const supports = generateGridSupportRegions(
      [
        { region: [stem], bottom: 0, printZ: 0.2, height: 0.2 },
        { region: [rectangle(3.8, 3.8, 6.2, 6.2)], bottom: 0.2, printZ: 0.4, height: 0.2 },
        { region: [rectangle(3.6, 3.6, 6.4, 6.4)], bottom: 0.4, printZ: 0.6, height: 0.2 },
      ],
      {
        thresholdAngleDegrees: 30,
        contactDistance: 0.2,
        lineWidth: 0.45,
        interfaceLayers: 2,
      },
    );
    assert.deepEqual(supports, { body: [[], [], []], interface: [[], [], []] });
  });

  test('rejects invalid support settings', () => {
    const layers = [{ region: [rectangle(0, 0, 1, 1)], bottom: 0, printZ: 0.2, height: 0.2 }];
    assert.throws(
      () => generateGridSupportRegions(layers, {
        thresholdAngleDegrees: 90,
        contactDistance: 0.2,
        lineWidth: 0.45,
        interfaceLayers: 2,
      }),
      /threshold angle/i,
    );
    assert.throws(
      () => generateGridSupportRegions(layers, {
        thresholdAngleDegrees: 30,
        contactDistance: -0.1,
        lineWidth: 0.45,
        interfaceLayers: 2,
      }),
      /contact distance/i,
    );
    assert.throws(
      () => generateGridSupportRegions(layers, {
        thresholdAngleDegrees: 30,
        contactDistance: 0.2,
        lineWidth: 0.45,
        interfaceLayers: 11,
      }),
      /interface layers/i,
    );
  });
});

describe('generateGridSupportRegions clearances', () => {
  const options = { thresholdAngleDegrees: 30, contactDistance: 0.2, lineWidth: 0.45, interfaceLayers: 0 };

  test('keeps an XY gap from the part and ignores overhang slivers thinner than a line', () => {
    const stem = rectangle(4, 4, 6, 6);
    const plan = generateGridSupportRegions(
      [
        { region: [stem], bottom: 0, printZ: 0.2, height: 0.2 },
        { region: [stem], bottom: 0.2, printZ: 0.4, height: 0.2 },
        { region: [rectangle(0, 0, 10, 10)], bottom: 0.4, printZ: 0.6, height: 0.2 },
      ],
      { ...options, xyDistance: 0.5 },
    );
    const points = plan.body[0].flat();
    assert.ok(points.length > 0);
    for (const { x, z } of points) {
      const inside = x > 3.5 + 1e-6 && x < 6.5 - 1e-6 && z > 3.5 + 1e-6 && z < 6.5 - 1e-6;
      assert.ok(!inside, `support vertex ${x}, ${z} is within the XY gap`);
    }

    const sliver = generateGridSupportRegions(
      [
        { region: [rectangle(0, 0, 10, 10)], bottom: 0, printZ: 0.2, height: 0.2 },
        { region: [rectangle(0, 0, 10.4, 10)], bottom: 0.2, printZ: 0.4, height: 0.2 },
      ],
      { ...options, thresholdAngleDegrees: 80 },
    );
    assert.deepEqual(sliver.body, [[], []]);
  });

  test('stops a column on the part below and leaves the contact gap above it', () => {
    const base = rectangle(0, 0, 10, 10);
    const stem = rectangle(0, 0, 2, 2);
    const plan = generateGridSupportRegions(
      [
        { region: [base], bottom: 0, printZ: 0.2, height: 0.2 },
        { region: [stem], bottom: 0.2, printZ: 0.4, height: 0.2 },
        { region: [stem], bottom: 0.4, printZ: 0.6, height: 0.2 },
        { region: [stem], bottom: 0.6, printZ: 0.8, height: 0.2 },
        { region: [base], bottom: 0.8, printZ: 1, height: 0.2 },
      ],
      options,
    );
    assert.deepEqual(plan.body[0], [], 'no support inside the base');
    assert.deepEqual(plan.body[1], [], 'one-layer gap above the base');
    assert.ok(plan.body[2].length > 0);
    assert.deepEqual(plan.body[3], [], 'one-layer gap below the overhang');
  });
});
