import ClipperLib from 'clipper-lib';
import type { ContourLoop, ContourPoint } from './slicing';

export interface ClassicWallOptions {
  /** Number of fixed-width wall centerlines to generate. */
  wallCount: number;
  /** Width of the outer wall, in the same units as the contour coordinates. */
  externalWidth: number;
  /** Centerline distance between subsequent walls. */
  spacing: number;
}

/**
 * Clipper works on integers. Its JavaScript port switches to slow BigInteger
 * maths once a coordinate exceeds 47,453,132, so the scale keeps the 256 mm
 * plate (2.56e7) below that while still resolving 10 nm.
 */
const OFFSET_SCALE = 100_000;
const MAX_WALL_COUNT = 100;

function validateOptions(options: ClassicWallOptions): void {
  if (!Number.isInteger(options.wallCount) || options.wallCount < 0 || options.wallCount > MAX_WALL_COUNT) {
    throw new RangeError(`Wall count must be an integer from 0 to ${MAX_WALL_COUNT}.`);
  }
  if (!Number.isFinite(options.externalWidth) || options.externalWidth <= 0) {
    throw new RangeError('External wall width must be a positive finite number.');
  }
  if (!Number.isFinite(options.spacing) || options.spacing <= 0) {
    throw new RangeError('Wall spacing must be a positive finite number.');
  }
}

function toClipperPath(loop: ContourLoop): ClipperLib.Path {
  const path: ClipperLib.Path = [];
  for (const point of loop) {
    const next = {
      X: Math.round(point.x * OFFSET_SCALE),
      Y: Math.round(point.z * OFFSET_SCALE),
    };
    if (!Number.isSafeInteger(next.X) || !Number.isSafeInteger(next.Y)) {
      throw new RangeError('Contour coordinates exceed the safe polygon offset range.');
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

function fromClipperPath(path: ClipperLib.Path): ContourLoop {
  return path.map((point) => ({ x: point.X / OFFSET_SCALE, z: point.Y / OFFSET_SCALE }));
}

/** Shrinks a closed region by a physical wall margin, preserving holes. */
export function insetContours(contours: readonly ContourLoop[], distance: number): ContourLoop[] {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new RangeError('Infill inset distance must be a non-negative finite number.');
  }
  if (!distance || !contours.length) return contours.map((loop) => [...loop]);
  const paths = normalizeWinding(contours.map(toClipperPath).filter((path) => path.length >= 3));
  if (!paths.length) return [];
  const offset = new ClipperLib.ClipperOffset();
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const inset: ClipperLib.Paths = [];
  offset.Execute(inset, -distance * OFFSET_SCALE);
  return inset
    .filter((path) => path.length >= 3 && ClipperLib.Clipper.Area(path) !== 0)
    .map(fromClipperPath);
}

/** Expands a closed region by a physical margin, preserving holes and islands. */
export function expandContours(contours: readonly ContourLoop[], distance: number): ContourLoop[] {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new RangeError('Contour expansion must be a non-negative finite number.');
  }
  if (!distance || !contours.length) return contours.map((loop) => [...loop]);
  const paths = normalizeWinding(contours.map(toClipperPath).filter((path) => path.length >= 3));
  if (!paths.length) return [];
  const offset = new ClipperLib.ClipperOffset();
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const expanded: ClipperLib.Paths = [];
  offset.Execute(expanded, distance * OFFSET_SCALE);
  return expanded
    .filter((path) => path.length >= 3 && ClipperLib.Clipper.Area(path) !== 0)
    .map(fromClipperPath);
}

/**
 * Removes parts of a region narrower than `width` (a morphological opening:
 * shrink, then grow back). Used to drop slivers that sloped walls leave in
 * layer differences, which are too thin to be real overhangs or bridges.
 */
export function openContours(contours: readonly ContourLoop[], width: number): ContourLoop[] {
  if (!Number.isFinite(width) || width < 0) {
    throw new RangeError('Opening width must be a non-negative finite number.');
  }
  if (!width) return contours.map((loop) => [...loop]);
  const shrunk = insetContours(contours, width / 2);
  return shrunk.length ? expandContours(shrunk, width / 2) : [];
}

/** Expands only outer object boundaries, excluding hole boundaries. */
export function expandOuterContours(
  contours: readonly ContourLoop[],
  distance: number,
): ContourLoop[] {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new RangeError('Outer contour expansion must be a non-negative finite number.');
  }
  if (!distance || !contours.length) return [];
  const paths = normalizeWinding(contours.map(toClipperPath).filter((path) => path.length >= 3))
    .filter((path) => ClipperLib.Clipper.Orientation(path));
  if (!paths.length) return [];
  const offset = new ClipperLib.ClipperOffset();
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const expanded: ClipperLib.Paths = [];
  offset.Execute(expanded, distance * OFFSET_SCALE);
  return expanded
    .filter((path) => path.length >= 3 && ClipperLib.Clipper.Area(path) !== 0)
    .map(fromClipperPath);
}

/**
 * Generates classic fixed-width wall centerlines from closed slice contours.
 * The first centerline is inset by half the external width; subsequent paths
 * are inset by one spacing each. Nested contours are wound as holes so offsets
 * shrink the part boundary while expanding holes into the printed region.
 */
export function generateClassicWalls(
  contours: readonly ContourLoop[],
  options: ClassicWallOptions,
): ContourLoop[][] {
  validateOptions(options);
  if (options.wallCount === 0 || !contours.length) return [];

  let current = normalizeWinding(contours.map(toClipperPath).filter((path) => path.length >= 3));
  if (!current.length) return [];

  const walls: ContourLoop[][] = [];
  for (let wall = 0; wall < options.wallCount; wall++) {
    const distance = wall === 0 ? options.externalWidth / 2 : options.spacing;
    const offset = new ClipperLib.ClipperOffset();
    offset.AddPaths(current, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    const next: ClipperLib.Paths = [];
    offset.Execute(next, -distance * OFFSET_SCALE);
    current = next.filter((path) => path.length >= 3 && ClipperLib.Clipper.Area(path) !== 0);
    if (!current.length) break;
    walls.push(current.map(fromClipperPath));
  }
  return walls;
}

/** Polygon area helper, useful to inspect remaining cross-section by layer. */
export function wallPathArea(loop: readonly ContourPoint[]): number {
  let twiceArea = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    twiceArea += a.x * b.z - b.x * a.z;
  }
  return twiceArea / 2;
}
