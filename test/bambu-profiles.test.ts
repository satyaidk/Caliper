import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  P1S_MACHINE,
  PROFILE_BASE_URL,
  createProfileLoader,
  loadP1SProfiles,
  profileNumber,
  profilePoints,
  profileUrl,
  type ProfileCache,
} from '../src/lib/bambu/profiles.ts';

/** Synthetic profiles shaped like Bambu's, keyed by "kind/name". */
function fakeRepository(overrides: Record<string, object> = {}) {
  const files: Record<string, object> = {
    'machine/Bambu Lab P1S': { type: 'machine_model', name: 'Bambu Lab P1S', model_id: 'C12' },
    'machine/base machine': { name: 'base machine', printable_height: '250', retraction_length: ['1', '1'] },
    [`machine/${P1S_MACHINE}`]: {
      name: P1S_MACHINE,
      inherits: 'base machine',
      printer_model: 'Bambu Lab P1S',
      retraction_length: ['0.8', '0.8'],
      bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
      include: ['start template', 'end template'],
    },
    'machine/start template': {
      name: 'start template',
      machine_start_gcode: 'M140 S[bed]',
      layer_change_gcode: 'M73 L{layer_num+1}',
      time_lapse_gcode: '; SKIPPABLE_START',
    },
    'machine/end template': { name: 'end template', machine_end_gcode: 'M104 S0' },
    'process/0.20mm Standard @BBL X1C': {
      name: '0.20mm Standard @BBL X1C',
      layer_height: '0.2',
      sparse_infill_density: '15%',
      compatible_printers: [P1S_MACHINE],
    },
    'filament/Bambu PLA Basic @BBL P1S 0.4 nozzle': {
      name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
      inherits: 'pla base',
      compatible_printers: [P1S_MACHINE],
    },
    'filament/pla base': { name: 'pla base', nozzle_temperature: ['220', '220'] },
    ...overrides,
  };
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    assert.ok(url.startsWith(`${PROFILE_BASE_URL}/`), `unexpected URL ${url}`);
    const key = decodeURIComponent(url.slice(PROFILE_BASE_URL.length + 1, -'.json'.length));
    const file = files[key];
    if (!file) throw new Error(`404 ${key}`);
    return JSON.stringify(file);
  };
  return { fetcher, requests };
}

describe('Bambu profile loader', () => {
  test('resolves inheritance and machine includes, child values winning', async () => {
    const { fetcher } = fakeRepository();
    const { machine, process, filament, printerModelId } = await loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher });
    assert.equal(printerModelId, 'C12');
    assert.deepEqual(machine.chain, ['base machine', P1S_MACHINE]);
    assert.equal(profileNumber(machine, 'retraction_length'), 0.8);
    assert.equal(profileNumber(machine, 'printable_height'), 250);
    assert.equal(machine.values.machine_start_gcode, 'M140 S[bed]');
    assert.equal(machine.values.inherits, undefined);
    assert.deepEqual(profilePoints(machine, 'bed_exclude_area')[2], { x: 18, y: 28 });
    assert.equal(profileNumber(process, 'sparse_infill_density'), 15);
    assert.equal(profileNumber(filament, 'nozzle_temperature', 1), 220);
  });

  test('refuses presets not marked compatible with the P1S, and non-P1S machines', async () => {
    const incompatible = fakeRepository({
      'filament/pla base': { name: 'pla base', nozzle_temperature: ['220'] },
      'filament/Bambu PLA Basic @BBL P1S 0.4 nozzle': {
        name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
        inherits: 'pla base',
        compatible_printers: ['Bambu Lab A1 0.4 nozzle'],
      },
    });
    await assert.rejects(
      loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: incompatible.fetcher }),
      /not marked compatible/,
    );
    const wrongMachine = fakeRepository({
      [`machine/${P1S_MACHINE}`]: { name: P1S_MACHINE, printer_model: 'Bambu Lab A1', include: ['start template', 'end template'] },
    });
    await assert.rejects(
      loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: wrongMachine.fetcher }),
      /not the P1S/,
    );
    await assert.rejects(loadP1SProfiles('nope', 'bambu-pla-basic', { fetcher: wrongMachine.fetcher }), /Unknown preset/);
  });

  test('fails closed on missing templates, cycles, bad values and mismatched names', async () => {
    const noEnd = fakeRepository({ 'machine/end template': { name: 'end template', machine_end_gcode: '  ' } });
    await assert.rejects(loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: noEnd.fetcher }), /empty "machine_end_gcode"/);

    const cycle = fakeRepository({ 'filament/pla base': { name: 'pla base', inherits: 'Bambu PLA Basic @BBL P1S 0.4 nozzle' } });
    await assert.rejects(createProfileLoader({ fetcher: cycle.fetcher }).resolve('filament', 'pla base'), /inherits from itself/);

    const badValue = fakeRepository({ 'filament/pla base': { name: 'pla base', nozzle_temperature: [220] } });
    await assert.rejects(
      createProfileLoader({ fetcher: badValue.fetcher }).resolve('filament', 'pla base'),
      /not a string or list of strings/,
    );

    const renamed = fakeRepository({ 'filament/pla base': { name: 'something else' } });
    await assert.rejects(createProfileLoader({ fetcher: renamed.fetcher }).resolve('filament', 'pla base'), /names itself/);
  });

  test('only builds URLs under the pinned base and rejects path tricks', () => {
    assert.equal(
      profileUrl('process', '0.20mm Standard @BBL X1C'),
      `${PROFILE_BASE_URL}/process/0.20mm%20Standard%20%40BBL%20X1C.json`,
    );
    assert.throws(() => profileUrl('machine', '../../secrets'), /unexpected name/);
    assert.throws(() => profileUrl('machine', 'a/b'), /unexpected name/);
  });

  test('reuses the cache instead of downloading again', async () => {
    const store = new Map<string, string>();
    const cache: ProfileCache = {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
    };
    const first = fakeRepository();
    await loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: first.fetcher, cache });
    assert.ok(first.requests.length >= 6);
    const second = fakeRepository();
    await loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher: second.fetcher, cache });
    assert.equal(second.requests.length, 0);
  });

  test('reads numbers strictly', async () => {
    const { fetcher } = fakeRepository({
      'process/0.20mm Standard @BBL X1C': {
        name: '0.20mm Standard @BBL X1C',
        layer_height: 'nil',
        compatible_printers: [P1S_MACHINE],
      },
    });
    const { process } = await loadP1SProfiles('standard', 'bambu-pla-basic', { fetcher });
    assert.throws(() => profileNumber(process, 'layer_height'), /not a number/);
    assert.throws(() => profileNumber(process, 'missing_key'), /has no "missing_key"/);
  });
});
