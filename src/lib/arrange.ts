/**
 * Laying several models out on one plate.
 *
 * Bambu Studio's Arrange packs parts by their real outlines; this is the
 * simple, predictable version a viewer needs: every model is treated as its
 * bounding rectangle seen from above, and rectangles are packed onto shelves —
 * rows, deepest part first — until the layout is roughly square. The result is
 * centred on the plate's origin.
 *
 * Units do not matter here: footprints and gap only have to agree.
 */

export interface Footprint {
  /** Extent along X. */
  w: number;
  /** Extent along Z. */
  d: number;
}

/** Where a footprint's centre goes, as [x, z]. */
export type Spot = [number, number];

export interface Extent {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Shelf packing. Returns one centre per footprint, in the order given, with the
 * whole layout centred on (0, 0) and at least `gap` between neighbours.
 */
export function arrange(footprints: Footprint[], gap: number): Spot[] {
  if (!footprints.length) return [];
  const order = footprints.map((f, i) => ({ ...f, i })).sort((a, b) => b.d - a.d || b.w - a.w);

  // A shelf as wide as a square holding everything would be, but never
  // narrower than the widest single part.
  const area = order.reduce((sum, f) => sum + (f.w + gap) * (f.d + gap), 0);
  const widest = Math.max(...order.map((f) => f.w));
  const shelf = Math.max(widest, Math.sqrt(area) * 1.1);

  const spots: Spot[] = new Array(footprints.length);
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  for (const f of order) {
    if (x > 0 && x + f.w > shelf) {
      z += rowDepth + gap;
      x = 0;
      rowDepth = 0;
    }
    spots[f.i] = [x + f.w / 2, z + f.d / 2];
    x += f.w + gap;
    rowDepth = Math.max(rowDepth, f.d);
  }

  return centre(spots, footprints);
}

/** Shifts a layout so the rectangle around all of it is centred on the origin. */
function centre(spots: Spot[], footprints: Footprint[]): Spot[] {
  const box = extentOf(spots, footprints);
  const cx = (box.minX + box.maxX) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  return spots.map(([x, z]) => [x - cx, z - cz]);
}

export function extentOf(spots: Spot[], footprints: Footprint[]): Extent {
  const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  spots.forEach(([x, z], i) => {
    const { w, d } = footprints[i];
    box.minX = Math.min(box.minX, x - w / 2);
    box.maxX = Math.max(box.maxX, x + w / 2);
    box.minZ = Math.min(box.minZ, z - d / 2);
    box.maxZ = Math.max(box.maxZ, z + d / 2);
  });
  return box;
}

/**
 * A spot for one more model next to what is already on the plate: to the right
 * while the layout is no wider than it is deep, otherwise along the front.
 * Either way the layout grows towards square, and nothing already placed moves.
 */
export function placeBeside(existing: Extent | null, footprint: Footprint, gap: number): Spot {
  if (!existing || !Number.isFinite(existing.minX)) return [0, 0];
  const width = existing.maxX - existing.minX;
  const depth = existing.maxZ - existing.minZ;
  if (width <= depth * 1.6) {
    return [existing.maxX + gap + footprint.w / 2, existing.minZ + footprint.d / 2];
  }
  return [existing.minX + footprint.w / 2, existing.maxZ + gap + footprint.d / 2];
}

/** True when two footprints, centred at the given spots, overlap. */
export function overlaps(a: Spot, fa: Footprint, b: Spot, fb: Footprint): boolean {
  return Math.abs(a[0] - b[0]) * 2 < fa.w + fb.w && Math.abs(a[1] - b[1]) * 2 < fa.d + fb.d;
}
