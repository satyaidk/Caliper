import type { IncomingMessage, ServerResponse } from 'node:http';
import { makerWorldFiles, safeMakerWorldImage, type MakerWorldImage } from '../src/lib/makerworld';

type Request = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
};

type Region = 'global' | 'cn';
const MAKERWORLD_API = 'https://api.bambulab.com/v1/design-service';

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

export default async function makerWorldApi(req: Request, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    respond(res, 405, { error: 'Use GET to look up a MakerWorld model.' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const id = single(req.query?.id) ?? url.searchParams.get('id') ?? undefined;
  const requestedRegion = single(req.query?.region) ?? url.searchParams.get('region') ?? undefined;
  if (!id || !/^\d{1,20}$/.test(id)) {
    respond(res, 400, { error: 'Paste a MakerWorld model page URL with a numeric model ID.' });
    return;
  }
  if (requestedRegion !== 'global' && requestedRegion !== 'cn') {
    respond(res, 400, { error: 'The MakerWorld region is not supported.' });
    return;
  }

  const region: Region = requestedRegion;
  const host = region === 'cn' ? 'makerworld.com.cn' : 'makerworld.com';
  const pageLanguage = region === 'cn' ? 'zh' : 'en';
  const endpoint = `${MAKERWORLD_API}/design/${id}`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `https://${host}/${pageLanguage}/models/${id}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      respond(res, response.status === 404 ? 404 : 502, {
        error: response.status === 404
          ? 'MakerWorld could not find that model.'
          : `MakerWorld did not return model details (HTTP ${response.status}).`,
      });
      return;
    }

    const design = (await response.json()) as {
      id?: number | string;
      title?: string;
      slug?: string;
      defaultInstanceId?: number | string;
      instances?: Array<{
        id?: number | string;
        profileId?: number | string;
        title?: string;
        status?: number;
        isDefault?: boolean;
        cover?: string;
        pictures?: Array<{ name?: string; url?: string }>;
      }>;
      coverUrl?: string;
      designExtension?: {
        design_pictures?: Array<{ name?: string; url?: string }>;
        model_files?: unknown[];
      };
    };

    const instances = (Array.isArray(design.instances) ? design.instances : [])
      .filter((instance) => instance.id != null && /^\d+$/.test(String(instance.id)) && instance.status !== 0);
    const profiles = instances.map((instance) => ({
        instanceId: String(instance.id),
        profileId: instance.profileId != null && /^\d+$/.test(String(instance.profileId))
          ? String(instance.profileId)
          : null,
        title: typeof instance.title === 'string' && instance.title.trim() ? instance.title.trim() : 'Print profile',
        isDefault: instance.isDefault === true || String(instance.id) === String(design.defaultInstanceId),
        previewUrl: safeMakerWorldImage(instance.cover) ??
          (Array.isArray(instance.pictures)
            ? safeMakerWorldImage(instance.pictures.find((picture) => picture.url)?.url)
            : null),
      }));

    if (!profiles.length || typeof design.title !== 'string') {
      respond(res, 404, { error: 'This MakerWorld page has no downloadable print profiles.' });
      return;
    }

    const images: MakerWorldImage[] = [];
    const addImage = (value: unknown, label: string) => {
      const safeUrl = safeMakerWorldImage(value);
      if (safeUrl && !images.some((image) => image.url === safeUrl)) images.push({ url: safeUrl, label });
    };
    const coverUrl = safeMakerWorldImage(design.coverUrl);
    addImage(coverUrl, 'Cover');
    for (const picture of design.designExtension?.design_pictures ?? []) {
      addImage(picture.url, typeof picture.name === 'string' && picture.name.trim() ? picture.name : 'Model reference');
    }
    for (const profile of instances) {
      for (const picture of profile.pictures ?? []) {
        addImage(picture.url, typeof picture.name === 'string' && picture.name.trim() ? picture.name : profile.title || 'Print profile');
      }
    }
    const files = makerWorldFiles(design.designExtension?.model_files);
    for (const file of files) {
      addImage(file.thumbnailUrl, file.name);
    }

    respond(res, 200, {
      designId: String(design.id ?? id),
      title: design.title,
      slug: typeof design.slug === 'string' ? design.slug : '',
      region,
      coverUrl,
      images: images.slice(0, 40),
      profiles,
      files,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    respond(res, 502, {
      error: timedOut
        ? 'MakerWorld took too long to respond. Try again.'
        : 'Caliper could not read this MakerWorld model. It may be temporarily unavailable.',
    });
  }
}
