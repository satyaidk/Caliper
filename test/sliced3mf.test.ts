import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { slicedPlates } from '../src/lib/sliced3mf.ts';

describe('sliced 3MF detection', () => {
  test('finds plate G-code in a .gcode.3mf and ignores ordinary 3MF projects', () => {
    const sliced = zipSync({
      '3D/3dmodel.model': strToU8('<model><resources></resources><build/></model>'),
      'Metadata/plate_1.gcode': strToU8('G28'),
      'Metadata/plate_1.gcode.md5': strToU8('ABC'),
    });
    assert.deepEqual(slicedPlates(sliced), ['Metadata/plate_1.gcode']);

    const project = zipSync({ '3D/3dmodel.model': strToU8('<model/>'), 'Metadata/plate_1.png': new Uint8Array(4) });
    assert.deepEqual(slicedPlates(project), []);
    assert.deepEqual(slicedPlates(new Uint8Array([1, 2, 3])), []);
  });
});
