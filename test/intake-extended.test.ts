import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortIntake,
  needsChooser,
  capacity,
  companionsFor,
  fileKey,
  MAX_MODELS,
  DIRECT_LIMIT,
} from '../src/lib/intake.ts';

/**
 * Extended intake tests covering edge cases not in intake.test.ts:
 * empty drops, boundary conditions, MAX_MODELS, fileKey stability.
 */

describe('sortIntake — extended', () => {
  test('returns empty arrays for an empty file list', () => {
    const result = sortIntake([]);
    assert.deepEqual(result.models, []);
    assert.deepEqual(result.companions, []);
  });

  test('companion-only drops yield no models', () => {
    const files = [new File([''], 'material.mtl'), new File([''], 'texture.png')];
    const result = sortIntake(files);
    assert.equal(result.models.length, 0);
    assert.equal(result.companions.length, 2);
  });

  test('unsupported file types are silently dropped', () => {
    const files = [new File([''], 'notes.txt'), new File([''], 'photo.jpg'), new File([''], 'model.stl')];
    const result = sortIntake(files);
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].name, 'model.stl');
    // jpg is a companion extension
    assert.equal(result.companions.length, 1);
  });
});

describe('needsChooser — extended', () => {
  test('false for zero models (nothing to choose)', () => {
    assert.equal(needsChooser(0, false), false);
    assert.equal(needsChooser(0, true), false);
  });

  test('false for exactly DIRECT_LIMIT loose files', () => {
    assert.equal(needsChooser(DIRECT_LIMIT, false), false);
  });

  test('true for DIRECT_LIMIT + 1 loose files', () => {
    assert.equal(needsChooser(DIRECT_LIMIT + 1, false), true);
  });

  test('true for 2 models from an archive even if under the limit', () => {
    assert.equal(needsChooser(2, true), true);
  });
});

describe('capacity', () => {
  test('returns take=0 and dropped=N when the plate is full', () => {
    const result = capacity(MAX_MODELS, 5);
    assert.equal(result.take, 0);
    assert.equal(result.dropped, 5);
  });

  test('partial fit: only the room that exists is taken', () => {
    const result = capacity(MAX_MODELS - 2, 5);
    assert.equal(result.take, 2);
    assert.equal(result.dropped, 3);
  });

  test('when plate is empty, all wanted models are taken up to MAX_MODELS', () => {
    const result = capacity(0, MAX_MODELS + 10);
    assert.equal(result.take, MAX_MODELS);
    assert.equal(result.dropped, 10);
  });
});

describe('companionsFor', () => {
  test('a zip file keeps no companions (not a textured format)', () => {
    const zip = new File([''], 'bundle.zip');
    const companions = [new File([''], 'texture.png'), new File([''], 'mat.mtl')];
    // zip is an archive not a model format so specFor returns undefined and we
    // expect an empty companion list
    const result = companionsFor(zip, companions);
    assert.deepEqual(result, []);
  });
});

describe('fileKey', () => {
  test('two different files with the same name are distinguished', () => {
    const a = new File(['aaa'], 'model.stl');
    const b = new File(['bbbbb'], 'model.stl');
    // Different sizes → different keys
    assert.notEqual(fileKey(a), fileKey(b));
  });

  test('the same file produces the same key when called twice', () => {
    const f = new File(['data'], 'part.obj');
    assert.equal(fileKey(f), fileKey(f));
  });
});
