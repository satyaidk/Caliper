import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMakerWorldDesign,
  makerWorldFiles,
  makerWorldProfileUrl,
  parseMakerWorldUrl,
  safeMakerWorldImage,
} from '../src/lib/makerworld.ts';

describe('MakerWorld link support', () => {
  test('parses global and China model pages and selected profile hashes', () => {
    assert.deepEqual(parseMakerWorldUrl('https://makerworld.com/en/models/2963569-paint-rack#profileId-833728263'), {
      designId: '2963569',
      region: 'global',
      pageUrl: 'https://makerworld.com/en/models/2963569-paint-rack#profileId-833728263',
      requestedProfileId: '833728263',
    });
    assert.equal(parseMakerWorldUrl('https://makerworld.com.cn/zh/models/123-example')?.region, 'cn');
    assert.equal(parseMakerWorldUrl('https://makerworld.com/en/collections/123-example'), null);
    assert.equal(parseMakerWorldUrl('https://makerworld.com.attacker.example/en/models/123-example'), null);
  });

  test('builds a MakerWorld page URL for the chosen profile', () => {
    assert.equal(
      makerWorldProfileUrl(
        { designId: '123', title: 'Model', slug: 'example-model', region: 'global', profiles: [], coverUrl: null, images: [], files: [] },
        { instanceId: '456', profileId: '789', title: 'PLA', isDefault: true, previewUrl: null },
      ),
      'https://makerworld.com/en/models/123-example-model#profileId-789',
    );
    assert.equal(
      makerWorldProfileUrl(
        { designId: '123', title: 'Model', slug: '', region: 'cn', profiles: [], coverUrl: null, images: [], files: [] },
        { instanceId: '456', profileId: null, title: 'PLA', isDefault: false, previewUrl: null },
      ),
      'https://makerworld.com.cn/zh/models/123-model',
    );
  });

  test('extracts nested model choices while rejecting unsafe preview URLs', () => {
    assert.deepEqual(
      makerWorldFiles([
        {
          isDir: true,
          dirName: 'Parts',
          children: [
            {
              modelName: 'base.stl',
              modelSize: 1024,
              modelType: 'stl',
              thumbnailUrl: 'https://makerworld.bblmw.com/thumb.jpg?token=short-lived',
            },
            { modelName: 'notes.txt', modelSize: 1200, modelType: 'txt' },
          ],
        },
      ]),
      [{
        id: '0',
        name: 'base.stl',
        path: 'Parts/base.stl',
        extension: 'stl',
        sizeBytes: 1024,
        thumbnailUrl: 'https://makerworld.bblmw.com/thumb.jpg?token=short-lived',
        protected: false,
      }],
    );
    assert.equal(safeMakerWorldImage('https://attacker.example/image.png'), null);
    assert.equal(safeMakerWorldImage('javascript:alert(1)'), null);
  });

  test('loads reduced catalogue data from Caliper’s same-origin endpoint', async () => {
    let requested = '';
    const design = await fetchMakerWorldDesign(
      {
        designId: '123',
        region: 'cn',
        pageUrl: 'https://makerworld.com.cn/zh/models/123-test',
        requestedProfileId: null,
      },
      async (input) => {
        requested = String(input);
        return Response.json({
          designId: '123',
          title: 'Test model',
          slug: 'test-model',
          region: 'cn',
          profiles: [],
        });
      },
    );
    assert.equal(requested, '/api/makerworld?id=123&region=cn');
    assert.equal(design.title, 'Test model');
  });

  test('surfaces catalogue service errors', async () => {
    await assert.rejects(
      fetchMakerWorldDesign(
        { designId: '123', region: 'global', pageUrl: 'https://makerworld.com/en/models/123', requestedProfileId: null },
        async () => Response.json({ error: 'Model not found.' }, { status: 404 }),
      ),
      /Model not found/,
    );
  });
});
