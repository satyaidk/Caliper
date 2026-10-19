import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { extractArchive, isArchive, normalisePath, pathOf, skipReason } from '../src/lib/archive.ts';

/* The archive reader is the first thing a downloaded .zip meets, so it is
   tested against real archives built in memory: what it keeps, what it leaves
   behind and why, and how it fails on something that is not a zip at all. */

const zipFile = (entries: Record<string, Uint8Array>, name = 'models.zip') =>
  new File([zipSync(entries)], name, { lastModified: 1_700_000_000_000 });

const bytesOf = (text: string) => strToU8(text);

describe('isArchive', () => {
  test('recognises .zip in any case', () => {
    assert.ok(isArchive('parts.zip'));
    assert.ok(isArchive('PARTS.ZIP'));
    assert.ok(!isArchive('part.3mf'), '3MF is a zip inside, but it is a model format of its own');
    assert.ok(!isArchive('part.fcstd'));
  });
});

describe('normalisePath', () => {
  test('turns backslashes into slashes', () => {
    assert.equal(normalisePath('parts\\left\\arm.stl'), 'parts/left/arm.stl');
  });

  test('drops leading slashes, dot and dot-dot segments', () => {
    assert.equal(normalisePath('/./parts/../arm.stl'), 'parts/arm.stl');
    assert.equal(normalisePath('../../etc/arm.stl'), 'etc/arm.stl');
  });
});

describe('skipReason', () => {
  const info = (name: string, originalSize = 10, compression = 8) => ({ name, originalSize, compression });

  test('keeps models and their companions', () => {
    assert.equal(skipReason(info('gear.stl')), null);
    assert.equal(skipReason(info('scene/scene.gltf')), null);
    assert.equal(skipReason(info('scene/textures/wood.png')), null);
    assert.equal(skipReason(info('part.mtl', 10, 0)), null, 'stored entries are fine too');
  });

  test('leaves folders and system junk out', () => {
    assert.equal(skipReason(info('parts/')), 'folder');
    assert.equal(skipReason(info('__MACOSX/._gear.stl')), 'system');
    assert.equal(skipReason(info('parts/.DS_Store')), 'system');
  });

  test('says why other entries are left behind', () => {
    assert.equal(skipReason(info('readme.pdf')), 'unsupported');
    assert.equal(skipReason(info('more.zip')), 'archive');
    assert.equal(skipReason(info('gear.stl', 10, 9)), 'method', 'deflate64 cannot be inflated');
    assert.equal(skipReason(info('huge.stl', 2 ** 40)), 'too-large');
  });
});

describe('extractArchive', () => {
  test('returns the usable entries as Files carrying their archive path', async () => {
    const zip = zipFile({
      'set/gear.stl': bytesOf('solid gear\nendsolid gear\n'),
      'set/sub/bracket.obj': bytesOf('v 0 0 0\n'),
      'set/sub/bracket.mtl': bytesOf('newmtl a\n'),
      'set/readme.txt': bytesOf('hello'),
      '__MACOSX/set/._gear.stl': bytesOf('junk'),
    });
    const { files, skipped } = await extractArchive(zip);

    const paths = files.map(pathOf).sort();
    assert.deepEqual(paths, ['set/gear.stl', 'set/sub/bracket.mtl', 'set/sub/bracket.obj']);
    const gear = files.find((f) => f.name === 'gear.stl')!;
    assert.equal(await gear.text(), 'solid gear\nendsolid gear\n');
    assert.equal(gear.lastModified, 1_700_000_000_000, 'entries inherit the archive date');
    // Junk is dropped silently; things a person might look for are reported.
    assert.deepEqual(skipped, [{ path: 'set/readme.txt', reason: 'unsupported' }]);
  });

  test('reports archives nested inside the archive', async () => {
    const inner = zipSync({ 'a.stl': bytesOf('solid a') });
    const { files, skipped } = await extractArchive(zipFile({ 'inner.zip': inner, 'b.stl': bytesOf('solid b') }));
    assert.deepEqual(files.map((f) => f.name), ['b.stl']);
    assert.deepEqual(skipped, [{ path: 'inner.zip', reason: 'archive' }]);
  });

  test('an archive with nothing usable comes back empty, not as an error', async () => {
    const { files } = await extractArchive(zipFile({ 'notes.txt': bytesOf('x') }));
    assert.equal(files.length, 0);
  });

  test('fails with a sentence a person can act on when the file is not a zip', async () => {
    const fake = new File([bytesOf('this is not a zip archive at all')], 'broken.zip');
    await assert.rejects(extractArchive(fake), /broken\.zip is not a zip archive, or it is damaged/);
  });
});
