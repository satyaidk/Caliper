import type { SourceUnit } from '@/types';
import { pathOf } from './archive';

/**
 * Recently opened models, kept on this device so they reopen without being
 * chosen again.
 *
 * The files live in IndexedDB, which stores Blobs natively and is cleared
 * along with the rest of the site's data: clear the browser's cache or site
 * data and every entry goes with it, which is the behaviour a temporary cache
 * should have. Nothing here ever leaves the device.
 *
 * Every call degrades to "nothing remembered" when storage is unavailable —
 * private windows, blocked site data, a full disk — because a missing recent
 * list is a small loss and a crash on open is not.
 *
 * Two stores:
 *   recent   one record per model: the model file, the companions it needs,
 *            a thumbnail, and the colour and unit it was last shown in
 *   session  the last plate: which recent entries were on it, and where
 */

export interface RecentFile {
  name: string;
  path: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

export interface RecentRecord {
  id: string;
  name: string;
  ext: string;
  /** Model plus companions, in bytes. */
  bytes: number;
  openedAt: number;
  colour: string;
  unit: SourceUnit;
  /** A small WebP of the model, or null when it could not be drawn. */
  thumb: string | null;
  /** The model first, then its companions. */
  files: RecentFile[];
}

export type RecentSummary = Omit<RecentRecord, 'files'>;

/** One model on the remembered plate. Position is the footprint centre in mm. */
export interface PlateItem {
  id: string;
  colour: string;
  unit: SourceUnit;
  position: [number, number];
}

export const RECENT_LIMITS = {
  maxEntries: 12,
  maxTotalBytes: 400 * 1024 * 1024,
  /** Bigger files are opened but not kept: one would crowd out everything else. */
  maxEntryBytes: 200 * 1024 * 1024,
};

const DB_NAME = 'caliper';
const DB_VERSION = 1;
const RECENT = 'recent';
const SESSION = 'session';
const PLATE_KEY = 'plate';

/**
 * Which entries to drop so the rest fit the limits: least recently opened
 * first, until both the count and the byte total are within bounds.
 */
export function planEviction(
  entries: Pick<RecentSummary, 'id' | 'bytes' | 'openedAt'>[],
  limits = RECENT_LIMITS,
): string[] {
  const newestFirst = [...entries].sort((a, b) => b.openedAt - a.openedAt);
  const keep: string[] = [];
  const drop: string[] = [];
  let total = 0;
  for (const entry of newestFirst) {
    if (keep.length < limits.maxEntries && total + entry.bytes <= limits.maxTotalBytes) {
      keep.push(entry.id);
      total += entry.bytes;
    } else {
      drop.push(entry.id);
    }
  }
  return drop;
}

/* --- IndexedDB, wrapped in promises -------------------------------------- */

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECENT)) db.createObjectStore(RECENT, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(SESSION)) db.createObjectStore(SESSION);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the schema asks this one to let go.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    const db = await openDb();
    if (!db) return fallback;
    const tx = db.transaction(name, mode);
    const result = await run(tx.objectStore(name));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } catch {
    return fallback;
  }
}

const summarise = ({ files: _files, ...summary }: RecentRecord): RecentSummary => summary;

/* --- public API ----------------------------------------------------------- */

export function listRecent(): Promise<RecentSummary[]> {
  return withStore(
    RECENT,
    'readonly',
    async (store) => {
      const all = (await done(store.getAll())) as RecentRecord[];
      return all.map(summarise).sort((a, b) => b.openedAt - a.openedAt);
    },
    [],
  );
}

/** Builds a record from the files a model was opened with. */
export function recordFrom(
  id: string,
  model: File,
  companions: File[],
  details: Pick<RecentRecord, 'ext' | 'colour' | 'unit' | 'thumb'>,
): RecentRecord {
  const files = [model, ...companions].map((file) => ({
    name: file.name,
    path: pathOf(file),
    type: file.type,
    lastModified: file.lastModified,
    blob: file as Blob,
  }));
  return {
    id,
    name: model.name,
    bytes: files.reduce((sum, f) => sum + f.blob.size, 0),
    openedAt: Date.now(),
    files,
    ...details,
  };
}

/** Stores a record, then evicts the oldest entries past the limits. False if not kept. */
export async function saveRecent(record: RecentRecord): Promise<boolean> {
  if (record.bytes > RECENT_LIMITS.maxEntryBytes) return false;
  const saved = await withStore(
    RECENT,
    'readwrite',
    async (store) => {
      await done(store.put(record));
      return true;
    },
    false,
  );
  if (!saved) return false;
  const drop = planEviction(await listRecent());
  if (drop.length) await withStore(RECENT, 'readwrite', async (s) => void drop.forEach((id) => s.delete(id)), undefined);
  return !drop.includes(record.id);
}

/** Changes the remembered colour, unit or thumbnail without touching the files. */
export function updateRecent(id: string, patch: Partial<Pick<RecentRecord, 'colour' | 'unit' | 'thumb'>>) {
  return withStore(
    RECENT,
    'readwrite',
    async (store) => {
      const record = (await done(store.get(id))) as RecentRecord | undefined;
      if (record) await done(store.put({ ...record, ...patch }));
    },
    undefined,
  );
}

/**
 * The files for one entry, as Files a loader can read, with their archive
 * paths restored. Marks the entry as just opened. Null when it is gone.
 */
export async function loadRecent(id: string): Promise<{ record: RecentSummary; files: File[] } | null> {
  return withStore(
    RECENT,
    'readwrite',
    async (store) => {
      const record = (await done(store.get(id))) as RecentRecord | undefined;
      if (!record) return null;
      await done(store.put({ ...record, openedAt: Date.now() }));
      const files = record.files.map((entry) => {
        const file = new File([entry.blob], entry.name, { type: entry.type, lastModified: entry.lastModified });
        try {
          Object.defineProperty(file, 'webkitRelativePath', { value: entry.path });
        } catch {
          /* the plain name is enough */
        }
        return file;
      });
      return { record: summarise(record), files };
    },
    null,
  );
}

export function removeRecent(id: string) {
  return withStore(RECENT, 'readwrite', async (store) => void (await done(store.delete(id))), undefined);
}

export async function clearRecent() {
  await withStore(RECENT, 'readwrite', async (store) => void (await done(store.clear())), undefined);
  await withStore(SESSION, 'readwrite', async (store) => void (await done(store.clear())), undefined);
}

export function savePlate(items: PlateItem[]) {
  return withStore(SESSION, 'readwrite', async (store) => void (await done(store.put(items, PLATE_KEY))), undefined);
}

export function loadPlate(): Promise<PlateItem[]> {
  return withStore(
    SESSION,
    'readonly',
    async (store) => ((await done(store.get(PLATE_KEY))) as PlateItem[] | undefined) ?? [],
    [],
  );
}
