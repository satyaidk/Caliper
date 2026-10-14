import type { WebGLRenderer } from 'three';

/**
 * KTX2 textures are transcoded to whatever compressed format the GPU actually
 * supports, which means the loader needs the live renderer. Loaders run outside
 * the Engine, so the Engine parks its renderer here on construction.
 */
let active: WebGLRenderer | null = null;

export function setActiveRenderer(renderer: WebGLRenderer | null) {
  active = renderer;
}

export function getActiveRenderer(): WebGLRenderer | null {
  return active;
}
