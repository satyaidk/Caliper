import { unzip, type UnzipFileInfo } from 'fflate';
import { COMPANION_EXTS, baseOf, extOf, isSupported } from './formats';

/**
 * Zip archives, opened in the browser.
 *
 * People share models as a .zip far more often than as a loose file: a
 * Printables or Thingiverse download, a folder of STLs from a colleague, a glTF
 * with its textures. Caliper reads the archive's table of contents first and
 * only inflates the entries it could use — model files and the textures and
 * materials that go with them — so a zip full of PDFs and photos costs nothing
 * beyond reading its directory.
 *
 * Nothing is written to disk: each kept entry becomes an in-memory File with
 * its path inside the archive as `webkitRelativePath`, which is exactly the
 * shape a folder drop produces. Everything downstream (the loaders' companion
 * lookup, the model chooser, the recent-files cache) therefore treats "a zip"
 * and "a dropped folder" the same way.
 */

/** Hard limits, so a hostile or accidental archive cannot take the tab down. */
export const ARCHIVE_LIMITS = {
  /** Entries kept after filtering. A building-sized IFC set is a few hundred. */
  maxEntries: 1000,
  /** Total uncompressed bytes kept, across every entry. */
  maxTotalBytes: 1024 * 1024 * 1024,
  /** One entry's uncompressed size. */
  maxEntryBytes: 512 * 1024 * 1024,
};

/** Compression methods fflate can inflate: stored and deflate. */
const READABLE_METHODS = new Set([0, 8]);

export function isArchive(filename: string): boolean {
  return extOf(filename) === 'zip';
}

/**
 * The entry's path, tidied: Windows tools write backslashes, some tools write
 * a leading slash or `./`, and `..` segments mean nothing once there is no
 * disk to escape from, so they are dropped rather than resolved.
 */
export function normalisePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

export type SkipReason = 'folder' | 'system' | 'unsupported' | 'archive' | 'method' | 'too-large';

/**
 * Whether an entry is worth inflating, decided from the directory alone.
 * Returns null to keep it, or why it was left behind.
 */
export function skipReason(info: Pick<UnzipFileInfo, 'name' | 'originalSize' | 'compression'>): SkipReason | null {
  const path = normalisePath(info.name);
  if (!path || info.name.endsWith('/')) return 'folder';
  const segments = path.split('/');
  // macOS resource forks and dotfiles: never a model, often a duplicate name.
  if (segments.some((s) => s === '__MACOSX' || s.startsWith('.'))) return 'system';
  if (isArchive(path)) return 'archive';
  const ext = extOf(path);
  if (!isSupported(path) && !COMPANION_EXTS.has(ext)) return 'unsupported';
  if (!READABLE_METHODS.has(info.compression)) return 'method';
  if (info.originalSize > ARCHIVE_LIMITS.maxEntryBytes) return 'too-large';
  return null;
}

export interface ExtractedArchive {
  /** Kept entries, as Files carrying their archive path. */
  files: File[];
  /** Paths left behind, with the reason — models among them are worth a mention. */
  skipped: { path: string; reason: SkipReason }[];
}

function inflate(data: Uint8Array, filter: (info: UnzipFileInfo) => boolean) {
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, { filter }, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/**
 * Opens `file` as a zip and returns the entries a loader could use.
 * Throws with a sentence a person can act on when the archive is unreadable.
 */
export async function extractArchive(file: File): Promise<ExtractedArchive> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const skipped: ExtractedArchive['skipped'] = [];
  let kept = 0;
  let total = 0;
  let overBudget = false;

  const filter = (info: UnzipFileInfo) => {
    const reason = skipReason(info);
    if (reason) {
      if (reason !== 'folder' && reason !== 'system') skipped.push({ path: normalisePath(info.name), reason });
      return false;
    }
    if (kept >= ARCHIVE_LIMITS.maxEntries || total + info.originalSize > ARCHIVE_LIMITS.maxTotalBytes) {
      overBudget = true;
      skipped.push({ path: normalisePath(info.name), reason: 'too-large' });
      return false;
    }
    kept++;
    total += info.originalSize;
    return true;
  };

  let entries: Record<string, Uint8Array>;
  try {
    entries = await inflate(bytes, filter);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new Error(
      /invalid zip|end of central/i.test(detail)
        ? `${file.name} is not a zip archive, or it is damaged.`
        : `${file.name} could not be unpacked. Password-protected archives are not supported.`,
    );
  }

  const files = Object.entries(entries).map(([name, data]) => {
    const path = normalisePath(name);
    const entry = new File([data as Uint8Array<ArrayBuffer>], baseOf(path), { lastModified: file.lastModified });
    try {
      Object.defineProperty(entry, 'webkitRelativePath', { value: path });
    } catch {
      /* Some engines define it read-only; the plain name still works. */
    }
    return entry;
  });

  if (overBudget && !files.length) {
    throw new Error(`${file.name} is too large to unpack in the browser.`);
  }
  return { files, skipped };
}

/** The archive path of a File, or its plain name when it did not come from one. */
export function pathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative || file.name;
}
