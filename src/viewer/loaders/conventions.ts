/**
 * Conventions shared by the mesh loaders.
 */

/**
 * Print formats (STL, 3MF, AMF) are Z-up: that is how every slicer reads them,
 * and 3MF and AMF say so in their specifications. The viewer is Y-up, so they
 * are turned a quarter about X. Without this, a part modelled standing up
 * opened lying on its side, and was sliced that way (ADR 0009).
 */
export const Z_UP_TO_Y_UP = -Math.PI / 2;

/** Crease-angle normals below this many triangles; past it, flat normals, because welding stalls. */
export const CREASE_LIMIT = 800_000;
