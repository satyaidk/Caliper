import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_LIMIT,
  MAX_MODELS,
  capacity,
  companionsFor,
  fileKey,
  needsChooser,
  sortIntake,
} from '../src/lib/intake.ts';

const file = (name: string, size = 100, path?: string) => {
  const f = new File([new Uint8Array(size)], name, { lastModified: 42 });
  if (path) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
};

describe('sortIntake', () => {
  test('splits models from companions and drops the rest', () => {
    const { models, companions } = sortIntake([
      file('scene.gltf'),
      file('scene.bin'),
      file('wood.png'),
      file('notes.txt'),
      file('gear.stl'),
    ]);
    assert.deepEqual(models.map((f) => f.name), ['gear.stl', 'scene.gltf']);
    assert.deepEqual(companions.map((f) => f.name).sort(), ['scene.bin', 'wood.png']);
  });

  test('orders models naturally by path, so part-2 comes before part-10', () => {
    const { models } = sortIntake([file('part-10.stl'), file('Part-2.stl'), file('part-1.stl')]);
    assert.deepEqual(models.map((f) => f.name), ['part-1.stl', 'Part-2.stl', 'part-10.stl']);
  });
});

describe('needsChooser', () => {
  test('never asks about a single model', () => {
    assert.equal(needsChooser(1, true), false);
    assert.equal(needsChooser(1, false), false);
  });

  test('always asks about an archive holding several', () => {
    assert.equal(needsChooser(2, true), true);
  });

  test('opens a handful of loose files straight away, and asks about a pile', () => {
    assert.equal(needsChooser(DIRECT_LIMIT, false), false);
    assert.equal(needsChooser(DIRECT_LIMIT + 1, false), true);
  });
});

describe('capacity', () => {
  test('takes everything while there is room', () => {
    assert.deepEqual(capacity(0, 3), { take: 3, dropped: 0 });
  });

  test('takes what fits and counts the rest', () => {
    assert.deepEqual(capacity(MAX_MODELS - 2, 5), { take: 2, dropped: 3 });
  });

  test('takes nothing from a full plate', () => {
    assert.deepEqual(capacity(MAX_MODELS, 1), { take: 0, dropped: 1 });
    assert.deepEqual(capacity(MAX_MODELS + 3, 1), { take: 0, dropped: 1 });
  });
});

describe('companionsFor', () => {
  const pool = [file('a.mtl'), file('a.bin'), file('wood.png'), file('bump.tga')];

  test('an STL keeps nothing: it takes no companions', () => {
    assert.deepEqual(companionsFor(file('gear.stl'), pool), []);
  });

  test('an OBJ keeps its materials and every kind of image', () => {
    assert.deepEqual(companionsFor(file('a.obj'), pool).map((f) => f.name), ['a.mtl', 'wood.png', 'bump.tga']);
  });

  test('a glTF keeps its buffers and images, not an OBJ material', () => {
    assert.deepEqual(companionsFor(file('a.gltf'), pool).map((f) => f.name), ['a.bin', 'wood.png', 'bump.tga']);
  });
});

describe('fileKey', () => {
  test('tells two files with the same name in different folders apart', () => {
    assert.notEqual(fileKey(file('arm.stl', 10, 'left/arm.stl')), fileKey(file('arm.stl', 10, 'right/arm.stl')));
  });

  test('is the same for the same file opened twice', () => {
    assert.equal(fileKey(file('Arm.STL', 10)), fileKey(file('arm.stl', 10)));
  });
});
