import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_LIMITS, listRecent, planEviction, recordFrom, saveRecent } from '../src/lib/recent.ts';

const MB = 1024 * 1024;
const entry = (id: string, bytes: number, openedAt: number) => ({ id, bytes, openedAt });

describe('planEviction', () => {
  test('keeps everything within the limits', () => {
    assert.deepEqual(planEviction([entry('a', MB, 1), entry('b', MB, 2)]), []);
  });

  test('drops the least recently opened once there are too many', () => {
    const entries = Array.from({ length: RECENT_LIMITS.maxEntries + 2 }, (_, i) => entry(`m${i}`, 1, i));
    assert.deepEqual(planEviction(entries).sort(), ['m0', 'm1']);
  });

  test('drops the oldest until the bytes fit, whatever order they come in', () => {
    const limits = { maxEntries: 10, maxTotalBytes: 10 * MB, maxEntryBytes: 10 * MB };
    const entries = [entry('new', 6 * MB, 30), entry('old', 3 * MB, 10), entry('mid', 3 * MB, 20)];
    assert.deepEqual(planEviction(entries, limits), ['old']);
  });
});

describe('recordFrom', () => {
  test('puts the model first and totals every file', () => {
    const model = new File([new Uint8Array(300)], 'a.obj');
    const mtl = new File([new Uint8Array(50)], 'a.mtl');
    const record = recordFrom('key', model, [mtl], { ext: 'obj', colour: '#00ae42', unit: 'mm', thumb: null });
    assert.equal(record.name, 'a.obj');
    assert.equal(record.bytes, 350);
    assert.deepEqual(record.files.map((f) => f.name), ['a.obj', 'a.mtl']);
  });
});

describe('without IndexedDB', () => {
  // Node has none, which is exactly the private-window case: nothing is kept,
  // and nothing throws.
  test('saving reports that nothing was kept', async () => {
    const record = recordFrom('k', new File(['x'], 'a.stl'), [], { ext: 'stl', colour: '#000', unit: 'mm', thumb: null });
    assert.equal(await saveRecent(record), false);
  });

  test('the list is empty', async () => {
    assert.deepEqual(await listRecent(), []);
  });
});
