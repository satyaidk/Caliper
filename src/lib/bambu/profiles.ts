/**
 * Loads Bambu Lab's own printer, process and filament profiles at slice time.
 *
 * Why fetch instead of bundling: the profiles and machine G-code templates
 * belong to Bambu Studio, which is AGPL-3.0, while Caliper is MIT (ADR 0008).
 * The browser downloads them from Bambu's public repository at one pinned
 * release, so the bytes never ship with Caliper and can't drift under us.
 *
 * Why so strict: these files decide nozzle temperature, the homing and
 * bed-levelling sequence, and the printable area. Only names under the fixed
 * base URL are fetched, the `inherits` chain is bounded, every value must be a
 * string or list of strings, and a preset is refused unless the profile itself
 * lists the P1S 0.4 nozzle as compatible.
 */

export const BAMBU_STUDIO_TAG = 'v02.08.02.61';
export const PROFILE_BASE_URL =
  `https://raw.githubusercontent.com/bambulab/BambuStudio/${BAMBU_STUDIO_TAG}/resources/profiles/BBL`;

export const P1S_MACHINE = 'Bambu Lab P1S 0.4 nozzle';
export const P1S_PRINTER_MODEL = 'Bambu Lab P1S';

export type ProfileKind = 'machine' | 'process' | 'filament';
export type ProfileValue = string | readonly string[];
export type ProfileValues = Readonly<Record<string, ProfileValue>>;

export interface ResolvedProfile {
  kind: ProfileKind;
  name: string;
  /** Names from the root ancestor down to this profile. */
  chain: readonly string[];
  values: ProfileValues;
}

export interface Preset {
  id: string;
  label: string;
  /** Bambu Studio's profile name, which is also its file name. */
  profile: string;
}

export const PROCESS_PRESETS: readonly Preset[] = [
  { id: 'standard', label: '0.20 mm Standard', profile: '0.20mm Standard @BBL X1C' },
  { id: 'fine', label: '0.16 mm Fine', profile: '0.16mm Optimal @BBL X1C' },
  { id: 'draft', label: '0.24 mm Draft', profile: '0.24mm Draft @BBL X1C' },
];

export const FILAMENT_PRESETS: readonly Preset[] = [
  { id: 'bambu-pla-basic', label: 'Bambu PLA Basic', profile: 'Bambu PLA Basic @BBL P1S 0.4 nozzle' },
  { id: 'bambu-petg-basic', label: 'Bambu PETG Basic', profile: 'Bambu PETG Basic @BBL X1C' },
  { id: 'generic-pla', label: 'Generic PLA', profile: 'Generic PLA' },
  { id: 'generic-petg', label: 'Generic PETG', profile: 'Generic PETG' },
];

/** The machine templates the slicer renders; each must be present after includes. */
export const REQUIRED_MACHINE_TEMPLATES = [
  'machine_start_gcode',
  'machine_end_gcode',
  'layer_change_gcode',
  'time_lapse_gcode',
] as const;

export type ProfileFetcher = (url: string) => Promise<string>;

export interface ProfileCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface ProfileLoaderOptions {
  fetcher?: ProfileFetcher;
  cache?: ProfileCache;
}

const MAX_CHAIN_DEPTH = 12;
const SAFE_NAME = /^[A-Za-z0-9 @._+()-]{1,120}$/;
/** Keys that describe a file rather than a setting, so they are not merged. */
const FILE_KEYS = new Set(['name', 'inherits', 'from', 'instantiation', 'type', 'include', 'setting_id']);

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export function profileUrl(kind: ProfileKind, name: string): string {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new ProfileError(`Refusing to fetch a profile with an unexpected name: "${name}".`);
  }
  return `${PROFILE_BASE_URL}/${kind}/${encodeURIComponent(name)}.json`;
}

async function defaultFetcher(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new ProfileError(`Bambu profile download failed (${response.status}): ${url}`);
  return response.text();
}

function parseProfile(text: string, kind: ProfileKind, name: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProfileError(`The ${kind} profile "${name}" is not valid JSON.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProfileError(`The ${kind} profile "${name}" is not a JSON object.`);
  }
  const profile = data as Record<string, unknown>;
  if (profile.name !== name) {
    throw new ProfileError(`The ${kind} file "${name}" names itself "${String(profile.name)}".`);
  }
  return profile;
}

function settingValues(profile: Record<string, unknown>, label: string): Record<string, ProfileValue> {
  const values: Record<string, ProfileValue> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (FILE_KEYS.has(key)) continue;
    if (typeof value === 'string') values[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) values[key] = [...value];
    else throw new ProfileError(`Setting "${key}" in ${label} is not a string or list of strings.`);
  }
  return values;
}

export function createProfileLoader(options: ProfileLoaderOptions = {}) {
  const fetcher = options.fetcher ?? defaultFetcher;
  const cache = options.cache;
  const memory = new Map<string, Promise<Record<string, unknown>>>();

  const loadFile = (kind: ProfileKind, name: string): Promise<Record<string, unknown>> => {
    const key = `${BAMBU_STUDIO_TAG}/${kind}/${name}`;
    let pending = memory.get(key);
    if (!pending) {
      pending = (async () => {
        const url = profileUrl(kind, name);
        let text = cache ? await cache.get(key) : undefined;
        if (text === undefined) {
          text = await fetcher(url);
          parseProfile(text, kind, name);
          await cache?.set(key, text);
        }
        return parseProfile(text, kind, name);
      })();
      pending.catch(() => memory.delete(key));
      memory.set(key, pending);
    }
    return pending;
  };

  /** Resolves `inherits` (and, for machines, `include` templates) into one profile. */
  const resolve = async (kind: ProfileKind, name: string): Promise<ResolvedProfile> => {
    const files: Record<string, unknown>[] = [];
    let current: string | undefined = name;
    while (current !== undefined) {
      if (files.length >= MAX_CHAIN_DEPTH) throw new ProfileError(`The ${kind} profile "${name}" inherits too deeply.`);
      if (files.some((file) => file.name === current)) {
        throw new ProfileError(`The ${kind} profile "${name}" inherits from itself.`);
      }
      const file = await loadFile(kind, current);
      files.unshift(file);
      const parent = file.inherits;
      if (parent !== undefined && (typeof parent !== 'string' || !parent)) {
        throw new ProfileError(`The ${kind} profile "${current}" has an invalid parent.`);
      }
      current = parent as string | undefined;
    }

    const values: Record<string, ProfileValue> = {};
    for (const file of files) {
      Object.assign(values, settingValues(file, `${kind} "${String(file.name)}"`));
      const include = file.include;
      if (include === undefined) continue;
      if (!Array.isArray(include) || !include.every((item) => typeof item === 'string')) {
        throw new ProfileError(`The ${kind} profile "${String(file.name)}" has an invalid include list.`);
      }
      for (const included of include) {
        const template = await loadFile(kind, included);
        Object.assign(values, settingValues(template, `${kind} template "${included}"`));
      }
    }
    return { kind, name, chain: files.map((file) => String(file.name)), values };
  };

  /** Reads Bambu's printer-model file (e.g. "Bambu Lab P1S") for its firmware model ID. */
  const modelId = async (printerModel: string): Promise<string> => {
    const file = await loadFile('machine', printerModel);
    if (file.type !== 'machine_model' || typeof file.model_id !== 'string' || !/^[A-Za-z0-9-]{1,16}$/.test(file.model_id)) {
      throw new ProfileError(`"${printerModel}" does not declare a printer model ID.`);
    }
    return file.model_id;
  };

  return { resolve, modelId };
}

export function profileString(profile: ResolvedProfile, key: string, index = 0): string {
  const value = profile.values[key];
  if (value === undefined) throw new ProfileError(`The ${profile.kind} profile "${profile.name}" has no "${key}".`);
  if (typeof value === 'string') return value;
  if (index < 0 || index >= value.length) {
    throw new ProfileError(`"${key}" in "${profile.name}" has no entry ${index}.`);
  }
  return value[index];
}

/** Reads a number; "15%" reads as 15. Throws on anything that is not a finite number. */
export function profileNumber(profile: ResolvedProfile, key: string, index = 0): number {
  const text = profileString(profile, key, index).trim().replace(/%$/, '');
  const value = Number(text);
  if (text === '' || !Number.isFinite(value)) {
    throw new ProfileError(`"${key}" in "${profile.name}" is not a number ("${text}").`);
  }
  return value;
}

export function profileList(profile: ResolvedProfile, key: string): readonly string[] {
  const value = profile.values[key];
  if (value === undefined) throw new ProfileError(`The ${profile.kind} profile "${profile.name}" has no "${key}".`);
  return typeof value === 'string' ? [value] : value;
}

/** Parses Bambu's "XxY" point lists, such as `printable_area` and `bed_exclude_area`. */
export function profilePoints(profile: ResolvedProfile, key: string): { x: number; y: number }[] {
  const value = profile.values[key];
  if (value === undefined) return [];
  return (typeof value === 'string' ? [value] : value).map((entry) => {
    const match = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)\s*$/.exec(entry);
    if (!match) throw new ProfileError(`"${key}" in "${profile.name}" has an invalid point "${entry}".`);
    return { x: Number(match[1]), y: Number(match[2]) };
  });
}

function assertCompatible(profile: ResolvedProfile): void {
  const compatible = profileList(profile, 'compatible_printers');
  if (!compatible.includes(P1S_MACHINE)) {
    throw new ProfileError(`"${profile.name}" is not marked compatible with the ${P1S_MACHINE}.`);
  }
}

export interface P1SProfiles {
  machine: ResolvedProfile;
  process: ResolvedProfile;
  filament: ResolvedProfile;
  /** Firmware model ID from Bambu's printer-model file ("C12" for the P1S). */
  printerModelId: string;
}

export function presetById(presets: readonly Preset[], id: string): Preset {
  const preset = presets.find((candidate) => candidate.id === id);
  if (!preset) throw new ProfileError(`Unknown preset "${id}".`);
  return preset;
}

/** Loads and cross-checks the machine, process and filament for one slice. */
export async function loadP1SProfiles(
  processId: string,
  filamentId: string,
  options: ProfileLoaderOptions = {},
): Promise<P1SProfiles> {
  const loader = createProfileLoader(options);
  const [machine, process, filament] = await Promise.all([
    loader.resolve('machine', P1S_MACHINE),
    loader.resolve('process', presetById(PROCESS_PRESETS, processId).profile),
    loader.resolve('filament', presetById(FILAMENT_PRESETS, filamentId).profile),
  ]);
  if (profileString(machine, 'printer_model') !== P1S_PRINTER_MODEL) {
    throw new ProfileError(`The machine profile is for "${profileString(machine, 'printer_model')}", not the P1S.`);
  }
  for (const key of REQUIRED_MACHINE_TEMPLATES) {
    if (!profileString(machine, key).trim()) throw new ProfileError(`The P1S profile has an empty "${key}".`);
  }
  assertCompatible(process);
  assertCompatible(filament);
  const printerModelId = await loader.modelId(P1S_PRINTER_MODEL);
  return { machine, process, filament, printerModelId };
}

/** IndexedDB cache so profiles keep working offline after the first slice. */
export function indexedDbProfileCache(databaseName = 'caliper-bambu-profiles'): ProfileCache | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const database = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = action(database.transaction('files', mode).objectStore('files'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  };
  return {
    async get(key) {
      try {
        const value = await run('readonly', (store) => store.get(key));
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        await run('readwrite', (store) => store.put(value, key));
      } catch {
        // A full or blocked cache only costs a re-download next time.
      }
    },
  };
}
