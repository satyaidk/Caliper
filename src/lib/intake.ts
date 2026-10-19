import { COMPANION_EXTS, extOf, isSupported, specFor } from './formats';
import { pathOf } from './archive';

/**
 * What to do with a pile of files: which are models, which are payload for a
 * model, and whether to open them straight away or ask first.
 *
 * Pure functions over File metadata, so the rules are tested without a
 * browser, a GPU or a loader.
 */

/** Models on the plate at once. Past this the GPU, not the person, decides. */
export const MAX_MODELS = 24;

/** A plain multi-file drop opens directly up to this many models. */
export const DIRECT_LIMIT = 8;

export interface Intake {
  /** Openable models, in a stable, human order. */
  models: File[];
  /** Textures, materials and buffers that loaders look up by name. */
  companions: File[];
}

/** Natural order by path, so `part-2` sorts before `part-10`. */
export const byPath = (a: File, b: File) =>
  pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true, sensitivity: 'base' });

export function sortIntake(files: File[]): Intake {
  const models: File[] = [];
  const companions: File[] = [];
  for (const file of files) {
    const ext = extOf(file.name);
    if (COMPANION_EXTS.has(ext)) companions.push(file);
    else if (isSupported(file.name)) models.push(file);
  }
  models.sort(byPath);
  return { models, companions };
}

/**
 * True when the person should pick what to open. An archive with several
 * models is a collection, not a request to load all of it; a plain drop of a
 * handful of files is. A huge plain drop is asked about too, because loading
 * forty STLs nobody meant to open locks the tab for a while.
 */
export function needsChooser(modelCount: number, fromArchive: boolean): boolean {
  if (modelCount <= 1) return false;
  return fromArchive || modelCount > DIRECT_LIMIT;
}

/** How many of `wanted` fit next to `existing` models, and how many do not. */
export function capacity(existing: number, wanted: number): { take: number; dropped: number } {
  const room = Math.max(0, MAX_MODELS - existing);
  const take = Math.min(room, wanted);
  return { take, dropped: wanted - take };
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif', 'ktx2', 'basis', 'hdr'];

/**
 * The companions worth keeping with `model` when it is cached. A format that
 * takes no companions keeps none — an STL from a zip of textured glTFs does
 * not need forty megabytes of textures stored alongside it.
 */
export function companionsFor(model: File, companions: File[]): File[] {
  const wanted = specFor(model.name)?.companions;
  if (!wanted?.length) return [];
  const exts = new Set(wanted);
  // A format that takes any image takes every image format.
  if (wanted.some((ext) => IMAGE_EXTS.includes(ext))) IMAGE_EXTS.forEach((ext) => exts.add(ext));
  return companions.filter((file) => exts.has(extOf(file.name)));
}

/** A key that names the same file across sessions without hashing its bytes. */
export function fileKey(file: File): string {
  return `${pathOf(file).toLowerCase()}|${file.size}|${file.lastModified}`;
}
