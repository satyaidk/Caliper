import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRemoteModel, isMakerWorldUrl, modelNameFromUrl } from '../src/lib/remote.ts';

describe('remote model links', () => {
  test('uses the URL filename or filename query parameter', () => {
    assert.equal(modelNameFromUrl('https://models.example/parts/gear%20box.stl'), 'gear box.stl');
    assert.equal(modelNameFromUrl('https://models.example/download?filename=gear.stl'), 'gear.stl');
    assert.equal(modelNameFromUrl('https://models.example/download'), 'download');
  });

  test('recognizes MakerWorld domains without matching lookalikes', () => {
    assert.equal(isMakerWorldUrl('https://makerworld.com/en/models/123-model'), true);
    assert.equal(isMakerWorldUrl('https://www.makerworld.com/en/models/123-model'), true);
    assert.equal(isMakerWorldUrl('https://makerworld.com.cn/zh/models/123-model'), true);
    assert.equal(isMakerWorldUrl('https://makerworld.com.attacker.example/model.3mf'), false);
    assert.equal(isMakerWorldUrl('not a url'), false);
  });

  test('reads a model into memory and honors Content-Disposition filenames', async () => {
    const file = await fetchRemoteModel(
      'https://models.example/download?id=123',
      'fallback.stl',
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-disposition': "attachment; filename*=UTF-8''gear%20box.stl" },
        }),
    );
    assert.equal(file.name, 'gear box.stl');
    assert.equal(file.size, 3);
  });

  test('reads an RFC 5987 filename with a language tag', async () => {
    const file = await fetchRemoteModel(
      'https://models.example/download?id=123',
      'fallback.stl',
      async () =>
        new Response(new Uint8Array([1]), {
          headers: { 'content-disposition': "attachment; filename*=UTF-8'en'gear%20box.stl" },
        }),
    );
    assert.equal(file.name, 'gear box.stl');
  });

  test('uses the supplied name for an extensionless download endpoint', async () => {
    const file = await fetchRemoteModel(
      'https://models.example/download?id=123',
      'saved-model.glb',
      async () => new Response(new Uint8Array([1])),
    );
    assert.equal(file.name, 'saved-model.glb');
  });

  test('explains CORS and network failures without using a proxy', async () => {
    await assert.rejects(
      fetchRemoteModel('https://models.example/part.stl', 'part.stl', async () => {
        throw new TypeError('Failed to fetch');
      }),
      /cross-origin access \(CORS\)/,
    );
  });

  test('rejects HTTP errors and responses without a supported model name', async () => {
    await assert.rejects(
      fetchRemoteModel('https://models.example/part.stl', 'part.stl', async () => new Response(null, { status: 404 })),
      /404/,
    );
    await assert.rejects(
      fetchRemoteModel('https://models.example/download', 'download.html', async () => new Response('not a model')),
      /supported model file/,
    );
  });
});
