import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandOuterContours, generateClassicWalls, insetContours, openContours, wallPathArea } from '../src/lib/walls.ts';

const square = (min: number, max: number) => [
  { x: min, z: min },
  { x: max, z: min },
  { x: max, z: max },
  { x: min, z: max },
];

function bounds(loop: { x: number; z: number }[]) {
  return {
    minX: Math.min(...loop.map((point) => point.x)),
    maxX: Math.max(...loop.map((point) => point.x)),
    minZ: Math.min(...loop.map((point) => point.z)),
    maxZ: Math.max(...loop.map((point) => point.z)),
  };
}

describe('generateClassicWalls', () => {
  test('expands only the outer footprint for attached adhesion paths', () => {
    const expanded = expandOuterContours([square(0, 10), square(3, 7).reverse()], 0.5);
    assert.equal(expanded.length, 1);
    assert.deepEqual(bounds(expanded[0]), { minX: -0.5, maxX: 10.5, minZ: -0.5, maxZ: 10.5 });
    assert.throws(() => expandOuterContours([square(0, 10)], -1), /non-negative/);
  });

  test('insets the outer wall by half-width and spaces later walls by their centerlines', () => {
    const walls = generateClassicWalls([square(0, 10)], {
      wallCount: 3,
      externalWidth: 0.4,
      spacing: 0.5,
    });

    describe('insetContours', () => {
      test('insets the outer region and expands its hole by the same margin', () => {
        const inset = insetContours([square(0, 10), square(3, 7).reverse()], 1);
        const outer = inset.find((loop) => wallPathArea(loop) > 0);
        const hole = inset.find((loop) => wallPathArea(loop) < 0);

        assert.ok(outer && hole);
        assert.deepEqual(bounds(outer), { minX: 1, maxX: 9, minZ: 1, maxZ: 9 });
        assert.deepEqual(bounds(hole), { minX: 2, maxX: 8, minZ: 2, maxZ: 8 });
      });

      test('returns an empty area when inset collapses and rejects negative distance', () => {
        assert.deepEqual(insetContours([square(0, 1)], 1), []);
        assert.throws(() => insetContours([square(0, 10)], -1), /non-negative/);
      });
    });

    assert.equal(walls.length, 3);
    assert.deepEqual(bounds(walls[0][0]), { minX: 0.2, maxX: 9.8, minZ: 0.2, maxZ: 9.8 });
    assert.deepEqual(bounds(walls[1][0]), { minX: 0.7, maxX: 9.3, minZ: 0.7, maxZ: 9.3 });
    assert.deepEqual(bounds(walls[2][0]), { minX: 1.2, maxX: 8.8, minZ: 1.2, maxZ: 8.8 });
  });

  test('keeps holes and offsets each boundary in the correct direction', () => {
    const walls = generateClassicWalls([square(0, 10), square(3, 7).reverse()], {
      wallCount: 2,
      externalWidth: 0.4,
      spacing: 0.4,
    });

    assert.equal(walls[0].length, 2);
    const areas = walls[0].map((loop) => Math.abs(wallPathArea(loop))).sort((a, b) => a - b);
    assert.ok(Math.abs(areas[0] - 19.36) < 1e-4);
    assert.ok(Math.abs(areas[1] - 92.16) < 1e-4);
    const hole = walls[0].find((loop) => wallPathArea(loop) < 0);
    const outer = walls[0].find((loop) => wallPathArea(loop) > 0);
    assert.ok(hole && outer);
    assert.deepEqual(bounds(hole), { minX: 2.8, maxX: 7.2, minZ: 2.8, maxZ: 7.2 });
    assert.deepEqual(bounds(outer), { minX: 0.2, maxX: 9.8, minZ: 0.2, maxZ: 9.8 });
    assert.equal(walls[1].length, 2);
  });

  test('preserves concave corners while generating successive inset walls', () => {
    const concave = [
      { x: 0, z: 0 },
      { x: 6, z: 0 },
      { x: 6, z: 2 },
      { x: 2, z: 2 },
      { x: 2, z: 6 },
      { x: 0, z: 6 },
    ];
    const walls = generateClassicWalls([concave], {
      wallCount: 2,
      externalWidth: 0.4,
      spacing: 0.4,
    });

    assert.equal(walls.length, 2);
    assert.equal(walls[0].length, 1);
    assert.equal(walls[1].length, 1);
    assert.ok(Math.abs(Math.abs(wallPathArea(walls[0][0])) - 15.36) < 1e-4);
    assert.ok(Math.abs(Math.abs(wallPathArea(walls[1][0])) - 7.04) < 1e-4);
  });

  test('stops when the cross-section collapses and supports zero walls', () => {
    assert.equal(generateClassicWalls([square(0, 1)], {
      wallCount: 4,
      externalWidth: 0.4,
      spacing: 0.4,
    }).length, 1);
    assert.deepEqual(generateClassicWalls([square(0, 10)], {
      wallCount: 0,
      externalWidth: 0.4,
      spacing: 0.4,
    }), []);
  });

  test('ignores degenerate contours and rejects invalid wall settings', () => {
    assert.deepEqual(generateClassicWalls([[{ x: 0, z: 0 }, { x: 1, z: 1 }]], {
      wallCount: 1,
      externalWidth: 0.4,
      spacing: 0.4,
    }), []);
    assert.throws(() => generateClassicWalls([square(0, 10)], {
      wallCount: 1.5,
      externalWidth: 0.4,
      spacing: 0.4,
    }), /integer/);
    assert.throws(() => generateClassicWalls([square(0, 10)], {
      wallCount: 1,
      externalWidth: 0,
      spacing: 0.4,
    }), /positive finite/);
  });
});

describe('openContours', () => {
  test('drops regions narrower than the width and keeps wider ones', () => {
    const thin = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 0.3 }, { x: 0, z: 0.3 }];
    const wide = [{ x: 0, z: 5 }, { x: 10, z: 5 }, { x: 10, z: 7 }, { x: 0, z: 7 }];
    assert.deepEqual(openContours([thin], 0.45), []);
    const kept = openContours([wide], 0.45);
    assert.equal(kept.length, 1);
    assert.ok(Math.abs(Math.abs(wallPathArea(kept[0])) - 20) < 1e-3);
    assert.throws(() => openContours([wide], -1), /non-negative/);
  });
});
