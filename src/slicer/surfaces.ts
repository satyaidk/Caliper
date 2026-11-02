import { difference, exArea, intersection, offset, opening, toUnits, type ExPoly } from './clipper';

/**
 * Which parts of each layer's infill area are solid, and what kind of solid
 * (docs/slicer-logic.md, section 10).
 *
 * The rule, checked against the neighbouring layers' infill areas:
 *
 *   sparse(i) = infill(i) ∩ infill(i+1) ∩ … ∩ infill(i+T)
 *                         ∩ infill(i−1) ∩ … ∩ infill(i−B)
 *   solid(i)  = infill(i) − sparse(i)
 *
 * so anything within T layers of a top surface or B layers of a bottom
 * surface is printed solid. Because it uses the neighbours' *infill* areas
 * (inside their walls), a gently sloping wall also gets solid fill behind it,
 * which keeps the shell thick on slopes: PrusaSlicer's "ensure vertical shell
 * thickness", by a simpler route.
 *
 * Solid areas are then split by what they touch:
 *   top    — nothing printed directly above (printed neatly, monotonic)
 *   bridge — nothing printed directly below, above the first layer (bridge flow)
 *   solid  — everything else
 */

export interface LayerSurfaces {
  sparse: ExPoly[];
  solid: ExPoly[];
  top: ExPoly[];
  bridge: ExPoly[];
}

export interface OverhangReport {
  /** Area that sticks out further than the overhang limit allows, mm². */
  area: number;
  /** Islands that start with nothing at all under them. */
  floating: number;
}

const MM2 = 1000 * 1000;

export function classifySurfaces(
  slices: ExPoly[][],
  infill: ExPoly[][],
  topLayers: number,
  bottomLayers: number,
  /** Smallest feature worth keeping, units: slivers thinner than this are merged. */
  sliver: number,
): LayerSurfaces[] {
  const n = infill.length;
  return infill.map((own, i) => {
    if (!own.length) return { sparse: [], solid: [], top: [], bridge: [] };

    let sparse = own;
    for (let k = 1; k <= topLayers && sparse.length; k++) sparse = i + k < n ? intersection(sparse, infill[i + k]) : [];
    for (let k = 1; k <= bottomLayers && sparse.length; k++)
      sparse = i - k >= 0 ? intersection(sparse, infill[i - k]) : [];
    // A sparse strip one line wide prints as a few stray strokes; make it solid.
    sparse = opening(sparse, sliver);

    const solid = difference(own, sparse);
    if (!solid.length) return { sparse, solid: [], top: [], bridge: [] };

    const above = i + 1 < n ? slices[i + 1] : [];
    const top = opening(intersection(solid, difference(own, above)), sliver / 2);
    const rest = difference(solid, top);
    const bridge = i > 0 ? opening(intersection(rest, difference(own, slices[i - 1])), sliver / 2) : [];
    return { sparse, solid: difference(rest, bridge), top, bridge };
  });
}

/**
 * Where a layer reaches out past the one below by more than the overhang
 * limit allows. A wall leaning `limitDeg` from vertical steps out
 * `height × tan(limit)` per layer; past that it needs support or a good bridge.
 */
export function overhangs(slices: ExPoly[][], heights: number[], limitDeg: number): OverhangReport[] {
  const tan = Math.tan((limitDeg * Math.PI) / 180);
  return slices.map((layer, i) => {
    if (i === 0 || !layer.length) return { area: 0, floating: 0 };
    const below = slices[i - 1];
    const allowed = offset(below, toUnits(heights[i] * tan));
    const out = opening(difference(layer, allowed), toUnits(0.2));
    let floating = 0;
    for (const island of layer) if (!intersection([island], below).length) floating++;
    return { area: exArea(out) / MM2, floating };
  });
}
