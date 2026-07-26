import { COMPANION_EXTS, extOf, isSupported, specFor } from '@/lib/formats';
import type { LoadContext, LoadResult } from '@/types';
import { loadMesh } from './mesh';
import { loadOff } from './off';
import { loadDotBim } from './dotbim';
import { loadOcct } from './occt';
import { loadRhino } from './rhino';
import { loadIfc } from './ifc';

/**
 * From a drop of n files, choose the one to open. A .mtl next to an .obj is
 * payload, not a model; when two real models are dropped together the larger
 * one wins, because that is almost always the subject.
 */
export function pickPrimary(files: File[]): File | null {
  const candidates = files.filter((f) => isSupported(f.name) && !COMPANION_EXTS.has(extOf(f.name)));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.size - a.size)[0];
}

export function buildContext(
  files: File[],
  onProgress: LoadContext['onProgress'],
): LoadContext & { revoke: () => void } {
  const fileMap = new Map<string, File>();
  const urlMap = new Map<string, string>();
  const created: string[] = [];

  for (const file of files) {
    const url = URL.createObjectURL(file);
    created.push(url);
    // Keyed by plain name and by the relative path from a folder drop.
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    for (const key of [file.name, relative].filter(Boolean) as string[]) {
      fileMap.set(key.toLowerCase(), file);
      urlMap.set(key.toLowerCase(), url);
      // glTF often references `textures/wood.png`; also key the tail segments.
      const parts = key.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) {
        const tail = parts.slice(i).join('/');
        if (!urlMap.has(tail)) {
          urlMap.set(tail, url);
          fileMap.set(tail, file);
        }
      }
    }
  }

  return {
    files: fileMap,
    urls: urlMap,
    onProgress,
    revoke: () => created.forEach((u) => URL.revokeObjectURL(u)),
  };
}

export async function loadModel(file: File, ctx: LoadContext): Promise<LoadResult> {
  const spec = specFor(file.name);
  if (!spec) throw new Error(`.${extOf(file.name)} is not one of the formats Caliper opens.`);

  switch (spec.ext) {
    case 'off':
      return loadOff(file, ctx);
    case 'bim':
      return loadDotBim(file, ctx);
    case 'ifc':
      return loadIfc(file, ctx);
    case '3dm':
      return loadRhino(file, ctx);
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
    case 'brp':
    case 'fcstd':
      return loadOcct(file, ctx);
    default:
      return loadMesh(file, ctx);
  }
}
