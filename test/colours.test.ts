import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FILAMENTS, colourName, nextColour } from '../src/lib/colours.ts';

describe('nextColour', () => {
  test('the first model wears the colour the person chose last', () => {
    assert.equal(nextColour([], '#1663c7'), '#1663c7');
  });

  test('a second model never arrives in the same colour as the first', () => {
    const first = nextColour([], '#00ae42');
    const second = nextColour([first], '#00ae42');
    assert.notEqual(second, first);
  });

  test('hands out strong, distinct hues before the neutrals', () => {
    const used: string[] = [];
    for (let i = 0; i < 4; i++) used.push(nextColour(used, '#00ae42'));
    assert.deepEqual(used, ['#00ae42', '#ff6a13', '#1663c7', '#f2cf3c']);
  });

  test('gives every palette colour once before repeating', () => {
    const used: string[] = [];
    for (let i = 0; i < FILAMENTS.length; i++) used.push(nextColour(used, '#00ae42'));
    assert.equal(new Set(used).size, FILAMENTS.length);
    // And still answers once the palette is spent.
    assert.match(nextColour(used, '#00ae42'), /^#[0-9a-f]{6}$/);
  });

  test('compares colours without caring about case', () => {
    assert.notEqual(nextColour(['#00AE42'], '#00ae42'), '#00ae42');
  });
});

describe('colourName', () => {
  test('names palette colours and calls anything else custom', () => {
    assert.equal(colourName('#00AE42'), 'Green');
    assert.equal(colourName('#123456'), 'Custom');
  });
});
