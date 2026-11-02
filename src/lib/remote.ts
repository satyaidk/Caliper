import { baseOf, isSupported } from './formats';

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanFilename(value: string): string {
  return baseOf(decode(value).replace(/[\u0000-\u001f\u007f]/g, '')).trim();
}

/** A useful filename for direct links and download endpoints without file extensions in their paths. */
export function modelNameFromUrl(value: string): string {
  const url = new URL(value);
  const name = url.searchParams.get('filename') || url.searchParams.get('name') || baseOf(url.pathname);
  return cleanFilename(name) || 'model';
}

export function isMakerWorldUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'makerworld.com' ||
      host.endsWith('.makerworld.com') ||
      host === 'makerworld.com.cn' ||
      host.endsWith('.makerworld.com.cn')
    );
  } catch {
    return false;
  }
}

function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = value.match(/filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)?.[1]?.trim().replace(/^"|"$/g, '');
  const plain = value.match(/filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i);
  const candidate = encoded ? decode(encoded) : plain?.[1]?.replace(/\\"/g, '"') ?? plain?.[2]?.trim();
  if (!candidate) return undefined;
  const filename = cleanFilename(candidate);
  return filename || undefined;
}

/**
 * Fetch a public model directly into memory. The host must permit browser
 * cross-origin reads; the app never sends the model to a proxy or saves it.
 */
export async function fetchRemoteModel(
  url: string,
  fallbackName: string,
  fetcher: typeof fetch = fetch,
): Promise<File> {
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        'The browser could not access this link. The host may block cross-origin access (CORS); use a direct model link that permits browser access, or open a local file.',
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`The server replied ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
  }

  const urlName = modelNameFromUrl(url);
  const fallback = cleanFilename(fallbackName);
  const filename =
    filenameFromDisposition(response.headers.get('content-disposition')) ||
    (isSupported(urlName) || urlName.toLowerCase().endsWith('.zip') ? urlName : fallback) ||
    urlName;
  if (!isSupported(filename) && !filename.toLowerCase().endsWith('.zip')) {
    throw new Error(
      'The link did not identify a supported model file. Use a direct model URL with a supported file extension.',
    );
  }

  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type });
}
