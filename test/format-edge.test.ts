import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, dim, grams, volume, area, shortName, count, compact } from '../src/lib/format.ts';

/**
 * Additional edge-case tests for lib/format.ts.
 * These cover NaN / Infinity / negative inputs that the main suite does not
 * exercise, ensuring the functions never silently produce 'NaN unit' or
 * 'Infinity unit' in the UI.
 */

describe('bytes — edge cases', () => {
  test('treats NaN as zero bytes', () => {
    assert.equal(bytes(NaN), '0 B');
  });

  test('treats Infinity as zero bytes', () => {
    assert.equal(bytes(Infinity), '0 B');
  });

  test('treats negative values as zero bytes', () => {
    assert.equal(bytes(-512), '0 B');
  });

  test('rounds sub-kilobyte values to whole bytes', () => {
    assert.equal(bytes(0), '0 B');
    assert.equal(bytes(512.9), '513 B');
  });

  test('boundary at exactly 1 KB', () => {
    assert.equal(bytes(1024), '1.0 KB');
    assert.equal(bytes(1023), '1023 B');
  });
});

describe('dim — edge cases', () => {
  test('returns "0 <unit>" for NaN input', () => {
    assert.equal(dim(NaN, 'mm'), '0 mm');
    assert.equal(dim(NaN, 'in'), '0 in');
  });

  test('returns "0 <unit>" for Infinity input', () => {
    assert.equal(dim(Infinity, 'mm'), '0 mm');
    assert.equal(dim(-Infinity, 'cm'), '0 cm');
  });

  test('formats negative dimensions with their sign', () => {
    assert.equal(dim(-100, 'mm'), '-100.0 mm');
    assert.equal(dim(-0.5, 'mm'), '-0.5000 mm');
  });

  test('formats very large values with no decimals', () => {
    const out = dim(9999, 'mm');
    assert.match(out, /^9999 mm$/);
  });
});

describe('grams — edge cases', () => {
  test('formats zero grams', () => {
    assert.equal(grams(0), '0.0 g');
  });

  test('formats very small values to one decimal', () => {
    assert.equal(grams(0.1), '0.1 g');
  });

  test('rounds values >= 100 g to a whole number', () => {
    assert.equal(grams(100.4), '100 g');
    assert.equal(grams(999.9), '1000 g');
  });
});

describe('volume — edge cases', () => {
  test('returns 0.0 mm³ for zero volume', () => {
    assert.equal(volume(0, 'mm'), '0.0 mm³');
  });

  test('handles fractional cubic mm', () => {
    assert.equal(volume(0.5, 'mm'), '0.5 mm³');
  });
});

describe('area — edge cases', () => {
  test('returns 0.0 mm² for zero area', () => {
    assert.equal(area(0, 'mm'), '0.0 mm²');
  });
});

describe('shortName — edge cases', () => {
  test('handles a filename with no extension', () => {
    const name = 'a-very-long-filename-with-no-extension-at-all';
    const out = shortName(name, 20);
    assert.ok(out.length <= 20, `"${out}" should be at most 20 chars`);
    assert.ok(out.includes('…'), `"${out}" should be truncated`);
  });

  test('returns unchanged when name equals exactly max', () => {
    const name = 'exactly20chars.stl!!'; // 20 chars
    assert.equal(shortName(name, 20), name);
  });

  test('handles an empty string', () => {
    assert.equal(shortName('', 10), '');
  });
});

describe('count — edge cases', () => {
  test('formats zero', () => {
    assert.equal(count(0), '0');
  });

  test('formats negative numbers', () => {
    assert.equal(count(-1000), '-1,000');
  });
});

describe('compact — edge cases', () => {
  test('formats zero', () => {
    assert.equal(compact(0), '0');
  });

  test('handles exact boundaries', () => {
    assert.equal(compact(1000), '1.0k');
    assert.equal(compact(10000), '10k');
    assert.equal(compact(1000000), '1.0M');
    assert.equal(compact(10000000), '10M');
  });
});
