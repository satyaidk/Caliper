import ClipperLib from 'clipper-lib';
import type { ContourLoop } from './slicing';

export interface SurfaceLayerInput {
  /** Closed slice boundaries for this layer, including nested holes. */
  region: readonly ContourLoop[];
}

export interface SurfaceLayerOptions {
  topSolidLayers: number;
  bottomSolidLayers: number;
}

export interface ClassifiedLayerSurfaces {
  top: ContourLoop[];
  bottom: ContourLoop[];
  topShell: ContourLoop[];
  bottomShell: ContourLoop[];
  solid: ContourLoop[];
  internal: ContourLoop[];
}

/**
 * Clipper works on integers. Its JavaScript port switches to slow BigInteger
 * maths once a coordinate exceeds 47,453,132, so the scale keeps the 256 mm
 * plate (2.56e7) below that while still resolving 10 nm.
 */
const SCALE = 100_000;

function validateCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be an integer from 0 to 100.`);
  }
}

function toPath(loop: ContourLoop): ClipperLib.Path {
  const path: ClipperLib.Path = [];
  for (const point of loop) {
    const next = { X: Math.round(point.x * SCALE), Y: Math.round(point.z * SCALE) };
    if (!Number.isSafeInteger(next.X) || !Number.isSafeInteger(next.Y)) {
      throw new RangeError('Contour coordinates exceed the safe surface-classification range.');
    }
    const previous = path[path.length - 1];
    if (!previous || previous.X !== next.X || previous.Y !== next.Y) path.push(next);
  }
  if (path.length > 1 && path[0].X === path[path.length - 1].X && path[0].Y === path[path.length - 1].Y) {
    path.pop();
  }
  return path.length >= 3 && ClipperLib.Clipper.Area(path) !== 0 ? path : [];
}

function normalizeWinding(paths: ClipperLib.Paths): ClipperLib.Paths {
  const areas = paths.map((path) => Math.abs(ClipperLib.Clipper.Area(path)));
  const bounds = paths.map((path) => ClipperLib.JS.BoundsOfPath(path));
  return paths.map((path, index) => {
    let depth = 0;
    const probe = path[0];
    for (let other = 0; other < paths.length; other++) {
      const box = bounds[other];
      if (
        other !== index &&
        areas[other] > areas[index] &&
        probe.X > box.left &&
        probe.X < box.right &&
        probe.Y > box.top &&
        probe.Y < box.bottom &&
        ClipperLib.Clipper.PointInPolygon(probe, paths[other]) === 1
      ) {
        depth++;
      }
    }
    const shouldBeOuter = depth % 2 === 0;
    return ClipperLib.Clipper.Orientation(path) === shouldBeOuter ? path : [...path].reverse();
  });
}

function normalizeRegion(contours: readonly ContourLoop[]): ClipperLib.Paths {
  const paths = normalizeWinding(contours.map(toPath).filter((path) => path.length >= 3));
  if (!paths.length) return [];
  // A non-zero union also resolves self-intersections, so no separate simplify pass.
  return booleanPaths(paths, [], ClipperLib.ClipType.ctUnion);
}

function booleanPaths(
  subject: ClipperLib.Paths,
  clip: ClipperLib.Paths,
  operation: ClipperLib.ClipType,
): ClipperLib.Paths {
  if (!subject.length) return [];
  if (!clip.length) {
    if (operation === ClipperLib.ClipType.ctIntersection) return [];
    if (operation === ClipperLib.ClipType.ctDifference) return subject;
  }
  const engine = new ClipperLib.Clipper();
  engine.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) engine.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const output: ClipperLib.Paths = [];
  engine.Execute(
    operation,
    output,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return output.filter((path) => path.length >= 3 && ClipperLib.Clipper.Area(path) !== 0);
}

function combine(...regions: ClipperLib.Paths[]): ClipperLib.Paths {
  const nonEmpty = regions.filter((region) => region.length);
  if (!nonEmpty.length) return [];
  return booleanPaths(nonEmpty.flat(), [], ClipperLib.ClipType.ctUnion);
}

function intersect(subject: ClipperLib.Paths, clip: ClipperLib.Paths): ClipperLib.Paths {
  return booleanPaths(subject, clip, ClipperLib.ClipType.ctIntersection);
}

function subtract(subject: ClipperLib.Paths, clip: ClipperLib.Paths): ClipperLib.Paths {
  return booleanPaths(subject, clip, ClipperLib.ClipType.ctDifference);
}

function toContours(paths: ClipperLib.Paths): ContourLoop[] {
  return paths.map((path) => path.map((point) => ({ x: point.X / SCALE, z: point.Y / SCALE })));
}

export function normalizeSurfaceRegion(contours: readonly ContourLoop[]): ContourLoop[] {
  return toContours(normalizeRegion(contours));
}

/**
 * Unions separate regions. Each region is normalised on its own first:
 * concatenating their loops into one list would make any loop that lies inside
 * another region's loop read as a hole, cutting overlaps out instead of
 * merging them.
 */
export function unionSurfaceRegions(...regions: readonly (readonly ContourLoop[])[]): ContourLoop[] {
  return toContours(combine(...regions.map(normalizeRegion)));
}

export function subtractSurfaceRegions(
  subject: readonly ContourLoop[],
  clips: readonly ContourLoop[],
): ContourLoop[] {
  return toContours(subtract(normalizeRegion(subject), normalizeRegion(clips)));
}

export function intersectSurfaceRegions(
  subject: readonly ContourLoop[],
  clips: readonly ContourLoop[],
): ContourLoop[] {
  return toContours(intersect(normalizeRegion(subject), normalizeRegion(clips)));
}

function propagateShells(
  seeds: ClipperLib.Paths[],
  regions: ClipperLib.Paths[],
  layerCount: number,
  direction: -1 | 1,
): ClipperLib.Paths[] {
  const shells = regions.map((): ClipperLib.Paths => []);
  if (!layerCount) return shells;

  for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
    let active = seeds[seedIndex];
    if (!active.length) continue;
    for (let offset = 0; offset < layerCount; offset++) {
      const index = seedIndex + direction * offset;
      if (index < 0 || index >= regions.length) break;
      active = intersect(active, regions[index]);
      if (!active.length) break;
      shells[index] = combine(shells[index], active);
    }
  }
  return shells;
}

/**
 * Compares neighboring layer regions, then propagates exposed top and bottom
 * areas through the requested number of horizontal solid shell layers.
 * Geometry remains framework-independent and does not generate infill paths.
 */
export function classifyLayerSurfaces(
  layers: readonly SurfaceLayerInput[],
  options: SurfaceLayerOptions,
): ClassifiedLayerSurfaces[] {
  validateCount(options.topSolidLayers, 'Top solid layer count');
  validateCount(options.bottomSolidLayers, 'Bottom solid layer count');

  const regions = layers.map((layer) => normalizeRegion(layer.region));
  const top = regions.map((region, index) =>
    subtract(region, regions[index + 1] ?? []));
  const bottom = regions.map((region, index) =>
    subtract(region, regions[index - 1] ?? []));
  const topShell = propagateShells(top, regions, options.topSolidLayers, -1);
  const bottomShell = propagateShells(bottom, regions, options.bottomSolidLayers, 1);

  return regions.map((region, index) => {
    const solid = combine(topShell[index], bottomShell[index]);
    return {
      top: toContours(top[index]),
      bottom: toContours(bottom[index]),
      topShell: toContours(topShell[index]),
      bottomShell: toContours(bottomShell[index]),
      solid: toContours(solid),
      internal: toContours(subtract(region, solid)),
    };
  });
}
