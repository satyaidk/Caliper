import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, extentOf, overlaps, placeBeside, type Footprint } from '../src/lib/arrange.ts';

const GAP = 0.5;

/** Every pair, checked: a layout that overlaps two parts is the one bug arrange must never have. */
function assertNoOverlap(spots: [number, number][], footprints: Footprint[]) {
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      assert.ok(!overlaps(spots[i], footprints[i], spots[j], footprints[j]), `parts ${i} and ${j} overlap`);
    }
  }
}

describe('arrange', () => {
  test('returns nothing for nothing', () => {
    assert.deepEqual(arrange([], GAP), []);
  });

  test('puts a single part at the centre', () => {
    assert.deepEqual(arrange([{ w: 4, d: 2 }], GAP), [[0, 0]]);
  });

  test('keeps the order it was given', () => {
    const footprints = [
      { w: 1, d: 1 },
      { w: 3, d: 5 },
    ];
    const spots = arrange(footprints, GAP);
    assert.equal(spots.length, 2);
    assertNoOverlap(spots, footprints);
  });

  test('never overlaps, whatever the mix of sizes', () => {
    const footprints = [
      { w: 10, d: 2 },
      { w: 1, d: 1 },
      { w: 3, d: 7 },
      { w: 4, d: 4 },
      { w: 2, d: 9 },
      { w: 6, d: 1 },
      { w: 1, d: 1 },
      { w: 5, d: 5 },
    ];
    assertNoOverlap(arrange(footprints, GAP), footprints);
  });

  test('centres the layout on the plate', () => {
    const footprints = Array.from({ length: 5 }, () => ({ w: 2, d: 3 }));
    const box = extentOf(arrange(footprints, GAP), footprints);
    assert.ok(Math.abs(box.minX + box.maxX) < 1e-9, 'centred in X');
    assert.ok(Math.abs(box.minZ + box.maxZ) < 1e-9, 'centred in Z');
  });

  test('grows towards a square rather than one long row', () => {
    const footprints = Array.from({ length: 16 }, () => ({ w: 1, d: 1 }));
    const box = extentOf(arrange(footprints, GAP), footprints);
    const ratio = (box.maxX - box.minX) / (box.maxZ - box.minZ);
    assert.ok(ratio > 0.5 && ratio < 2, `aspect ${ratio.toFixed(2)} should be near square`);
  });
});

describe('placeBeside', () => {
  test('the first model goes in the middle', () => {
    assert.deepEqual(placeBeside(null, { w: 2, d: 2 }, GAP), [0, 0]);
  });

  test('the next goes to the right of a layout that is not yet wide', () => {
    const existing = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    const spot = placeBeside(existing, { w: 2, d: 2 }, GAP);
    assert.deepEqual(spot, [1 + GAP + 1, 0]);
    assert.ok(!overlaps(spot, { w: 2, d: 2 }, [0, 0], { w: 2, d: 2 }));
  });

  test('a layout that is already wide grows along the front instead', () => {
    const existing = { minX: -5, maxX: 5, minZ: -1, maxZ: 1 };
    const [x, z] = placeBeside(existing, { w: 2, d: 2 }, GAP);
    assert.equal(z, 1 + GAP + 1);
    assert.equal(x, -5 + 1);
  });
});
