export type MakerWorldRegion = 'global' | 'cn';

export interface MakerWorldTarget {
  designId: string;
  region: MakerWorldRegion;
  pageUrl: string;
  requestedProfileId: string | null;
}

export interface MakerWorldProfile {
  instanceId: string;
  profileId: string | null;
  title: string;
  isDefault: boolean;
  previewUrl: string | null;
}

export interface MakerWorldImage {
  url: string;
  label: string;
}

export interface MakerWorldFile {
  id: string;
  name: string;
  path: string;
  extension: string;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
  protected: boolean;
}

export interface MakerWorldDesign {
  designId: string;
  title: string;
  slug: string;
  region: MakerWorldRegion;
  coverUrl: string | null;
  images: MakerWorldImage[];
  profiles: MakerWorldProfile[];
  files: MakerWorldFile[];
}

const MODEL_EXTENSIONS = new Set([
  'stl', 'obj', 'ply', 'off', 'gltf', 'glb', 'fbx', 'dae', '3ds', '3mf', 'amf', 'wrl',
  'step', 'stp', 'iges', 'igs', 'brep', 'brp', 'fcstd', '3dm', 'ifc', 'bim',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function safeMakerWorldImage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trustedHost =
      host === 'makerworld.com' ||
      host.endsWith('.makerworld.com') ||
      host === 'makerworld.com.cn' ||
      host.endsWith('.makerworld.com.cn') ||
      host === 'bblmw.com' ||
      host.endsWith('.bblmw.com') ||
      host === 'bblmw.cn' ||
      host.endsWith('.bblmw.cn');
    return url.protocol === 'https:' && trustedHost ? url.href : null;
  } catch {
    return null;
  }
}

export function makerWorldFiles(value: unknown, limit = 80): MakerWorldFile[] {
  const files: MakerWorldFile[] = [];
  const visit = (entries: unknown, parent: string, depth: number) => {
    if (!Array.isArray(entries) || depth > 12 || files.length >= limit) return;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const nameValue = entry.modelName;
      const name = typeof nameValue === 'string' ? nameValue.trim() : '';
      const isDirectory = entry.isDir === true;
      const pathName = typeof entry.dirName === 'string' && entry.dirName.trim() ? entry.dirName.trim() : name;
      const path = [parent, pathName].filter(Boolean).join('/');
      if (isDirectory) {
        visit(entry.children, path, depth + 1);
        if (files.length >= limit) return;
        continue;
      }

      const extension = name.split('.').pop()?.toLowerCase() ?? '';
      if (!name || !MODEL_EXTENSIONS.has(extension)) continue;
      const size = typeof entry.modelSize === 'number' && Number.isFinite(entry.modelSize) && entry.modelSize >= 0
        ? entry.modelSize
        : null;
      files.push({
        id: `${files.length}`,
        name,
        path: [parent, name].filter(Boolean).join('/'),
        extension,
        sizeBytes: size,
        thumbnailUrl: safeMakerWorldImage(entry.thumbnailUrl),
        protected: entry.protected === true,
      });
      if (files.length >= limit) return;
    }
  };
  visit(value, '', 0);
  return files;
}

export function parseMakerWorldUrl(value: string): MakerWorldTarget | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const region: MakerWorldRegion | null =
      host === 'makerworld.com' || host.endsWith('.makerworld.com')
        ? 'global'
        : host === 'makerworld.com.cn' || host.endsWith('.makerworld.com.cn')
          ? 'cn'
          : null;
    if (!region) return null;

    const designId = url.pathname.match(/\/models\/(\d+)(?:[-/]|$)/)?.[1];
    if (!designId) return null;

    return {
      designId,
      region,
      pageUrl: url.href,
      requestedProfileId: url.hash.match(/(?:^|[#&])profileId-(\d+)/)?.[1] ?? null,
    };
  } catch {
    return null;
  }
}

export function makerWorldProfileUrl(design: MakerWorldDesign, profile: MakerWorldProfile): string {
  const host = design.region === 'cn' ? 'makerworld.com.cn' : 'makerworld.com';
  const language = design.region === 'cn' ? 'zh' : 'en';
  const slug = design.slug.replace(/[^a-z\d-]/gi, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'model';
  const url = new URL(`https://${host}/${language}/models/${design.designId}-${slug}`);
  if (profile.profileId) url.hash = `profileId-${profile.profileId}`;
  return url.href;
}

export async function fetchMakerWorldDesign(
  target: MakerWorldTarget,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<MakerWorldDesign> {
  const query = new URLSearchParams({ id: target.designId, region: target.region });
  let response: Response;
  try {
    response = await fetcher(`/api/makerworld?${query}`, { signal });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Caliper could not reach its MakerWorld catalogue service. Check your connection and try again.');
    }
    throw error;
  }

  const data = (await response.json().catch(() => null)) as
    | (MakerWorldDesign & { error?: string })
    | null;
  if (!response.ok || !data) {
    throw new Error(data?.error || `MakerWorld lookup failed (${response.status}).`);
  }
  return data;
}
