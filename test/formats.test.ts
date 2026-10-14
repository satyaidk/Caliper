import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPT,
  BY_PIPELINE,
  COMPANION_EXTS,
  FORMATS,
  baseOf,
  extOf,
  isSupported,
  specFor,
} from '../src/lib/formats.ts';
import { pickPrimary } from '../src/viewer/loaders/index.ts';

describe('extension helpers', () => {
  test('extOf lower-cases and drops the dot', () => {
    assert.equal(extOf('Model.STL'), 'stl');
    assert.equal(extOf('a.b.step'), 'step');
    assert.equal(extOf('noextension'), '');
  });

  test('baseOf strips both slash styles', () => {
    assert.equal(baseOf('textures/wood.png'), 'wood.png');
    assert.equal(baseOf('C:\\models\\part.step'), 'part.step');
    assert.equal(baseOf('plain.stl'), 'plain.stl');
  });

  test('specFor and isSupported agree with the registry', () => {
    assert.equal(specFor('x.step')?.pipeline, 'cad');
    assert.equal(specFor('x.stl')?.pipeline, 'mesh');
    assert.equal(specFor('x.ifc')?.pipeline, 'bim');
    assert.equal(specFor('x.docx'), undefined);
    assert.ok(isSupported('X.GLB'));
    assert.ok(!isSupported('notes.txt'));
  });
});

describe('the format registry', () => {
  test('has no duplicate extensions', () => {
    const seen = new Set(FORMATS.map((f) => f.ext));
    assert.equal(seen.size, FORMATS.length, 'every ext must appear once');
  });

  test('every extension is lower-case and dotless', () => {
    for (const f of FORMATS) {
      assert.equal(f.ext, f.ext.toLowerCase(), `${f.ext} must be lower-case`);
      assert.ok(!f.ext.includes('.'), `${f.ext} must not contain a dot`);
      assert.ok(f.label.length > 0, `${f.ext} needs a label`);
    }
  });

  test('the pipeline grouping accounts for every format exactly once', () => {
    const grouped = [...BY_PIPELINE.mesh, ...BY_PIPELINE.cad, ...BY_PIPELINE.bim];
    assert.equal(grouped.length, FORMATS.length);
    assert.deepEqual(
      new Set(grouped.map((f) => f.ext)),
      new Set(FORMATS.map((f) => f.ext)),
    );
  });

  test('the accept attribute covers every registered format', () => {
    const accepted = new Set(ACCEPT.split(',').map((s) => s.trim()));
    for (const f of FORMATS) {
      assert.ok(accepted.has(`.${f.ext}`), `.${f.ext} missing from ACCEPT`);
    }
  });

  test('no format is also listed as a companion', () => {
    // A file cannot be both "the model" and "payload for another model".
    for (const f of FORMATS) {
      assert.ok(!COMPANION_EXTS.has(f.ext), `${f.ext} cannot be a companion and a format`);
    }
  });
});

describe('pickPrimary', () => {
  const file = (name: string, size = 100) =>
    new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });

  test('returns null when nothing is openable', () => {
    assert.equal(pickPrimary([file('notes.txt'), file('photo.jpg')]), null);
  });

  test('ignores companions when choosing', () => {
    const picked = pickPrimary([file('model.mtl', 900), file('model.obj', 10)]);
    assert.equal(picked?.name, 'model.obj');
  });

  test('prefers the largest real model', () => {
    const picked = pickPrimary([file('small.stl', 10), file('big.step', 5000)]);
    assert.equal(picked?.name, 'big.step');
  });

  test('finds the model inside a folder drop', () => {
    const picked = pickPrimary([
      file('readme.txt', 10),
      file('wood.png', 4000),
      file('scene.gltf', 200),
      file('scene.bin', 9000),
    ]);
    assert.equal(picked?.name, 'scene.gltf');
  });
});
