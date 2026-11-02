import { offset, toUnits, unionEx, type ExPoly, type Path, type Pt } from './clipper';
import { BRIDGE_EXTRA_SPACING, bridgeArea, lineArea, lineSpacing } from './flow';
import { bridgeAngle, lineFill } from './infill';
import type { LayerSurfaces } from './surfaces';
import type { IslandWalls } from './walls';
import type { InfillPattern, SeamPosition } from './profiles';

/**
 * One layer's extrusions, in the order they will be printed. The G-code writer
 * only adds travel, speed, cooling and the text itself.
 */

export type Role =
  | 'outer-wall'
  | 'inner-wall'
  | 'sparse-infill'
  | 'solid-infill'
  | 'top-surface'
  | 'bridge'
  | 'skirt'
  | 'brim';

/** The ;TYPE: comment for each role, as both slicers' previews read it. */
export const ROLE_LABEL: Record<Role, string> = {
  'outer-wall': 'Outer wall',
  'inner-wall': 'Inner wall',
  'sparse-infill': 'Sparse infill',
  'solid-infill': 'Internal solid infill',
  'top-surface': 'Top surface',
  bridge: 'Bridge',
  skirt: 'Skirt',
  brim: 'Brim',
};

export interface Extrusion {
  role: Role;
  /** Clipper units. A closed loop does not repeat its first point. */
  points: Path;
  closed: boolean;
  width: number;
  height: number;
  /** mm³ of plastic per mm of travel. */
  area: number;
}

export interface LayerPlan {
  index: number;
  /** Nozzle height, mm. */
  z: number;
  height: number;
  extrusions: Extrusion[];
  /** The layer's outlines, for deciding whether a travel crosses open air. */
  outlines: ExPoly[];
}

export interface PlanWidths {
  outerWall: number;
  innerWall: number;
  infill: number;
  solid: number;
  top: number;
  firstLayer: number;
  skirt: number;
  bridge: number;
}

export interface PlanSettings {
  infillDensity: number;
  infillPattern: InfillPattern;
  infillAngle: number;
  seam: SeamPosition;
  skirtLoops: number;
  skirtDistance: number;
  brimWidth: number;
}

export interface LayerInput {
  index: number;
  z: number;
  height: number;
  slices: ExPoly[];
  walls: IslandWalls[];
  surfaces: LayerSurfaces;
}

const centre = (poly: ExPoly): Pt => {
  let x = 0;
  let y = 0;
  for (const p of poly.contour) {
    x += p.X;
    y += p.Y;
  }
  return { X: x / poly.contour.length, Y: y / poly.contour.length };
};

const dist2 = (a: Pt, b: Pt) => (a.X - b.X) ** 2 + (a.Y - b.Y) ** 2;

/** Rotates a closed loop so it starts at the seam. */
function startAtSeam(path: Path, seam: SeamPosition, previous: Pt | null): Path {
  let best = 0;
  if (seam === 'aligned' && previous) {
    let bestD = Infinity;
    path.forEach((p, i) => {
      const d = dist2(p, previous);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
  } else {
    // Rear: the point furthest back (largest Y), leftmost among equals.
    path.forEach((p, i) => {
      const b = path[best];
      if (p.Y > b.Y || (p.Y === b.Y && p.X < b.X)) best = i;
    });
  }
  return best === 0 ? path : [...path.slice(best), ...path.slice(0, best)];
}

/** The skirt and brim around the first layer, outermost first. */
function adhesion(slices: ExPoly[], settings: PlanSettings, width: number, height: number): Extrusion[] {
  const out: Extrusion[] = [];
  if (!slices.length) return out;
  const spacing = lineSpacing(width, height);
  const area = lineArea(width, height);
  const outer = unionEx(slices).map((p) => ({ contour: p.contour, holes: [] }));

  const brimLoops = Math.round(settings.brimWidth / spacing);
  const brim: Extrusion[] = [];
  for (let k = 0; k < brimLoops; k++) {
    for (const poly of offset(outer, toUnits(spacing * (k + 0.5)), 'round'))
      brim.push({ role: 'brim', points: poly.contour, closed: true, width, height, area });
  }

  const skirt: Extrusion[] = [];
  if (settings.skirtLoops > 0) {
    const reach = (brimLoops > 0 ? brimLoops * spacing : 0) + settings.skirtDistance;
    // One loop around everything: merge first, so close parts share a skirt.
    const hull = offset(outer, toUnits(reach + width / 2), 'round').map((p) => ({ contour: p.contour, holes: [] }));
    for (let k = 0; k < settings.skirtLoops; k++)
      for (const poly of offset(hull, toUnits(spacing * k), 'round'))
        skirt.push({ role: 'skirt', points: poly.contour, closed: true, width, height, area });
  }

  // Skirt first (it primes the nozzle), then the brim from the outside in, so
  // the nozzle finishes the brim right beside the part.
  out.push(...skirt.reverse(), ...brim.reverse());
  return out;
}

export function planLayer(
  layer: LayerInput,
  widths: PlanWidths,
  settings: PlanSettings,
  state: { position: Pt; seam: Pt | null },
): LayerPlan {
  const first = layer.index === 0;
  const h = layer.height;
  const w = (normal: number) => (first ? widths.firstLayer : normal);
  const line = (role: Role, width: number) => ({ role, width, height: h, area: lineArea(width, h) });

  const extrusions: Extrusion[] = first ? adhesion(layer.slices, settings, widths.skirt, h) : [];
  if (extrusions.length) {
    const last = extrusions[extrusions.length - 1];
    state.position = last.points[0];
  }

  // Islands nearest-first from wherever the nozzle is.
  const remaining = layer.walls.slice();
  const ordered: IslandWalls[] = [];
  let cursor = state.position;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((island, i) => {
      const d = dist2(centre(island.outline), cursor);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [island] = remaining.splice(best, 1);
    ordered.push(island);
    cursor = centre(island.outline);
  }

  // Fill regions belong to whichever island contains them; clipping each kind
  // of surface by the island keeps the nozzle on one island at a time.
  const angle = settings.infillAngle + (layer.index % 2 ? 90 : 0);
  const solidSpacing = (width: number) => toUnits(lineSpacing(width, h));
  const sparseWidth = w(widths.infill);
  const sparseSpacing = lineSpacing(sparseWidth, h);

  for (const island of ordered) {
    // Inner walls before the outer one: the outer wall then has something to
    // lean against, which is both slicers' default.
    const loops = island.loops.slice().sort((a, b) => b.index - a.index);
    for (const loop of loops) {
      const role: Role = loop.index === 0 ? 'outer-wall' : 'inner-wall';
      const width = w(loop.index === 0 ? widths.outerWall : widths.innerWall);
      const points = startAtSeam(loop.path, settings.seam, loop.index === 0 ? state.seam : null);
      if (loop.index === 0 && !loop.hole) state.seam = points[0];
      extrusions.push({ ...line(role, width), points, closed: true });
      // A loop ends where it started.
      state.position = points[0];
    }

    const clip = (region: ExPoly[]) => (layer.walls.length === 1 ? region : intersectIsland(region, island));
    const lines = (
      role: Role,
      region: ExPoly[],
      width: number,
      spacing: number,
      fillAngle: number,
      area?: number,
      join = false,
    ) => {
      // Each separate piece of the region is filled on its own, so its lines
      // stay together; sorting every line of the layer by row would send the
      // nozzle back and forth across the part between distant pieces.
      const polylines: Path[] = [];
      const reach2 = (2 * spacing) ** 2;
      for (const piece of clip(region)) {
        let current: Path | null = null;
        for (const seg of lineFill([piece], fillAngle, spacing)) {
          // Dense fills: join each line to the next with a short extrusion when
          // its start is right beside this one's end (a zig-zag), instead of a
          // travel. Only within two line spacings, so the link stays inside.
          if (join && current && dist2(current[current.length - 1], seg[0]) <= reach2) {
            current.push(...seg);
            continue;
          }
          current = seg.slice();
          polylines.push(current);
        }
      }
      for (const points of nearestFirst(polylines, state)) {
        extrusions.push({ ...line(role, width), ...(area ? { area } : {}), points, closed: false });
      }
    };

    const { surfaces } = layer;
    if (surfaces.bridge.length) {
      const width = widths.bridge;
      const spacing = toUnits(width + BRIDGE_EXTRA_SPACING);
      lines('bridge', surfaces.bridge, width, spacing, bridgeAngle(clip(surfaces.bridge), spacing), bridgeArea(width));
    }
    if (surfaces.solid.length)
      lines('solid-infill', surfaces.solid, w(widths.solid), solidSpacing(w(widths.solid)), angle, undefined, true);
    if (surfaces.sparse.length && settings.infillDensity > 0) {
      if (settings.infillDensity >= 0.999) {
        lines('solid-infill', surfaces.sparse, sparseWidth, solidSpacing(sparseWidth), angle, undefined, true);
      } else if (settings.infillPattern === 'grid') {
        // Two directions on every layer, each at half the density.
        const spacing = toUnits((2 * sparseSpacing) / settings.infillDensity);
        lines('sparse-infill', surfaces.sparse, sparseWidth, spacing, settings.infillAngle);
        lines('sparse-infill', surfaces.sparse, sparseWidth, spacing, settings.infillAngle + 90);
      } else {
        lines('sparse-infill', surfaces.sparse, sparseWidth, toUnits(sparseSpacing / settings.infillDensity), angle);
      }
    }
    if (surfaces.top.length)
      lines('top-surface', surfaces.top, w(widths.top), solidSpacing(w(widths.top)), angle, undefined, true);
  }

  return { index: layer.index, z: layer.z, height: h, extrusions, outlines: layer.slices };
}

/**
 * Orders open polylines nearest-first from the nozzle, printing each from
 * whichever end is closer. Greedy, which is what both slicers do for infill.
 */
function nearestFirst(polylines: Path[], state: { position: Pt }): Path[] {
  const left = polylines.slice();
  const out: Path[] = [];
  while (left.length) {
    let best = 0;
    let bestD = Infinity;
    let flip = false;
    for (let i = 0; i < left.length; i++) {
      const path = left[i];
      const dStart = dist2(path[0], state.position);
      const dEnd = dist2(path[path.length - 1], state.position);
      if (dStart < bestD) {
        bestD = dStart;
        best = i;
        flip = false;
      }
      if (dEnd < bestD) {
        bestD = dEnd;
        best = i;
        flip = true;
      }
    }
    const [path] = left.splice(best, 1);
    const ordered = flip ? path.slice().reverse() : path;
    out.push(ordered);
    state.position = ordered[ordered.length - 1];
  }
  return out;
}

function intersectIsland(region: ExPoly[], island: IslandWalls): ExPoly[] {
  // Islands never overlap, so a region piece belongs to the island that holds its first point.
  return region.filter((poly) => contains(island.outline, poly.contour[0]));
}

function contains(poly: ExPoly, p: Pt): boolean {
  if (!inside(poly.contour, p)) return false;
  return !poly.holes.some((hole) => inside(hole, p));
}

/** Even-odd ray test; edge cases do not matter here because regions sit well inside walls. */
function inside(path: Path, p: Pt): boolean {
  let hit = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i];
    const b = path[j];
    if (a.Y > p.Y !== b.Y > p.Y && p.X < ((b.X - a.X) * (p.Y - a.Y)) / (b.Y - a.Y) + a.X) hit = !hit;
  }
  return hit;
}
