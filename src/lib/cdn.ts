/**
 * The CAD and BIM kernels are WebAssembly builds in the 5–12 MB range. They are
 * fetched on first use rather than bundled, so a viewer that only ever opens an
 * STL never downloads them. Pin versions here; nothing else references them.
 *
 * To run fully offline, copy each package's dist folder into `public/vendor/`
 * and point these constants at the local paths.
 */
export const CDN = {
  occt: 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/',
  webIfc: 'https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/',
  rhino3dm: 'https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/',
  draco: 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/',
  basis: 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/basis/',
} as const;

const pending = new Map<string, Promise<void>>();

/** Loads a classic script once and resolves when its global is available. */
export function loadScript(url: string): Promise<void> {
  const existing = pending.get(url);
  if (existing) return existing;

  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve();
    el.onerror = () => {
      pending.delete(url);
      el.remove();
      reject(new Error(`Could not download the geometry kernel from ${url}`));
    };
    document.head.appendChild(el);
  });

  pending.set(url, p);
  return p;
}

export function globalOf<T>(name: string): T | undefined {
  return (window as unknown as Record<string, T | undefined>)[name];
}
