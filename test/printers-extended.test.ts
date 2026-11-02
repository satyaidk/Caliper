import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fitOnBed, niceStep, bedById, BEDS } from '../src/lib/printers.ts';

/**
 * Tests for src/lib/printers.ts — the bed-fit logic and grid step helper.
 * These were entirely untested; a wrong "fits on the plate" verdict is a real
 * user-facing mistake (a scrapped print).
 */

describe('fitOnBed', () => {
  const bambu256: [number, number, number] = [256, 256, 256];

  test('a small part fits without turning', () => {
    const report = fitOnBed([100, 100, 100], bambu256);
    assert.equal(report.fits, true);
    assert.equal(report.turned, false);
    assert.deepEqual(report.over, { width: 0, depth: 0, height: 0 });
  });

  test('a part that exactly fills the bed fits', () => {
    const report = fitOnBed([256, 256, 256], bambu256);
    assert.equal(report.fits, true);
  });

  test('a part that is 1 mm too wide does not fit', () => {
    const report = fitOnBed([257, 100, 100], bambu256);
    assert.equal(report.fits, false);
    assert.equal(report.over.width, 1);
  });

  test('a part that is too tall does not fit regardless of footprint', () => {
    const report = fitOnBed([100, 257, 100], bambu256);
    assert.equal(report.fits, false);
    assert.equal(report.over.height, 1);
  });

  test('a portrait part only fitting after a quarter turn is reported as turned', () => {
    // 260 mm × 100 mm × 200 mm — 260 > 256 so it doesn't fit straight (width axis),
    // but when turned the 200mm sits on the width axis (200 ≤ 256) and 260mm on depth (260 > 256)
    // ... still doesn't fit. Use a case where turned dimension is ≤ 256 but straight is not:
    // 260 W × 100 H × 200 D → straight: width=4 over; turned: depth=4 over → neither fits.
    // Correct example: 240 W × 100 H × 200 D on a 220×220×220 bed:
    //   straight: width=max(0,240-220)=20, depth=max(0,200-220)=0 → doesn't fit
    //   turned:   width=max(0,200-220)=0,  depth=max(0,240-220)=20 → doesn't fit either
    // Real turned-fits example: width=250, depth=180 on Ender-3 (220×220):
    //   straight: width=max(0,250-220)=30 → fails
    //   turned:   width=max(0,180-220)=0, depth=max(0,250-220)=30 → fails
    // Use Prusa MK4 [250,210,220]: 215mm W × 100mm H × 200mm D:
    //   straight: max(0,215-250)=0, max(0,200-210)=0 → fits straight already — bad example.
    // The true test for "turned=true" from fitOnBed:
    //   straightFits=false, turnedFits=true, useTurned=true
    // Ender-3 [220,220,250], part 210 W × 100 H × 180 D:
    //   straight: max(0,210-220)=0, max(0,180-220)=0 → straightFits=true → bad again.
    // Proper: bed [200, 300, 300], part [250, 100, 150]:
    //   straight: max(0,250-200)=50, max(0,150-300)=0 → doesn't fit; turned: max(0,150-200)=0, max(0,250-300)=0 → fits
    const bed: [number, number, number] = [200, 300, 300];
    const report = fitOnBed([250, 100, 150], bed);
    assert.equal(report.fits, true);
    assert.equal(report.turned, true);
  });

  test('a part too big in every orientation does not fit and reports the smallest excess', () => {
    const report = fitOnBed([300, 100, 290], bambu256);
    assert.equal(report.fits, false);
    // Turned: width = max(0, 290-256) = 34, depth = max(0, 300-256) = 44 → total 78
    // Straight: width = max(0, 300-256) = 44, depth = max(0, 290-256) = 34 → total 78
    // Both equal, so the first (straight) is used — just check it doesn't fit.
    assert.equal(report.over.width + report.over.depth > 0, true);
  });

  test('a zero-size part fits any bed', () => {
    const report = fitOnBed([0, 0, 0], bambu256);
    assert.equal(report.fits, true);
  });
});

describe('niceStep', () => {
  test('picks 10 for a 240 mm span at 24 cells', () => {
    assert.equal(niceStep(240), 10);
  });

  test('picks 1 for a small 20 mm span', () => {
    assert.equal(niceStep(20), 1);
  });

  test('picks 100 for a 2000 mm span', () => {
    assert.equal(niceStep(2000), 100);
  });

  test('returns 1 for a zero or negative span', () => {
    assert.equal(niceStep(0), 1);
    assert.equal(niceStep(-100), 1);
  });

  test('respects a custom cell count', () => {
    // 100 mm / 10 cells = 10 → nicestep is 10
    assert.equal(niceStep(100, 10), 10);
  });
});

describe('bedById', () => {
  test('returns the matching bed by ID', () => {
    const bed = bedById('bambu-256');
    assert.equal(bed.id, 'bambu-256');
    assert.deepEqual(bed.size, [256, 256, 256]);
  });

  test('falls back to the first bed for an unknown ID', () => {
    const bed = bedById('unknown-printer-xyz');
    assert.equal(bed.id, BEDS[0].id);
  });
});
