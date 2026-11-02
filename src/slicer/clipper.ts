import * as ClipperNamespace from 'clipper-lib';

/**
 * Polygon geometry for the slicer, on top of Angus Johnson's Clipper 6
 * (`clipper-lib`, Boost Software License). Both PrusaSlicer and Bambu Studio
 * use Clipper for the same jobs: offsets, booleans and clipping lines to a
 * region.
 *
 * Coordinates are integers, as in both slicers (docs/slicer-logic.md, 5.5):
 * floating-point booleans fail on nearly coincident edges, integers do not.
 * One unit is one micrometre, which is finer than any printer moves and keeps
 * every coordinate on a 350 mm bed far inside the range Clipper handles exactly.
 */

// clipper-lib is CommonJS (`module.exports = ClipperLib`). Vite exposes it as
// the namespace and Node's ESM loader as `default`; take whichever is there.
const C = ((ClipperNamespace as unknown as { default?: typeof ClipperNamespace }).default ??
  ClipperNamespace) as typeof ClipperNamespace;

/** Integer units per millimetre. */
export const SCALE = 1000;

export interface Pt {
  X: number;
  Y: number;
}
export type Path = Pt[];

/** One outline with the holes cut out of it, as slicers store a slice. */
export interface ExPoly {
  contour: Path;
  holes: Path[];
}

export const toUnits = (mm: number) => Math.round(mm * SCALE);
export const toMm = (units: number) => units / SCALE;

/** Signed area in units². Positive for counter-clockwise. */
export function area(path: Path): number {
  return C.Clipper.Area(path as ClipperNamespace.Path);
}

export function exArea(polys: ExPoly[]): number {
  let total = 0;
  for (const poly of polys) {
    total += Math.abs(area(poly.contour));
    for (const hole of poly.holes) total -= Math.abs(area(hole));
  }
  return total;
}

/** Every outline and hole as plain paths, outlines CCW and holes CW. */
export function toPaths(polys: ExPoly[]): Path[] {
  const out: Path[] = [];
  for (const poly of polys) {
    out.push(poly.contour);
    for (const hole of poly.holes) out.push(hole);
  }
  return out;
}

/** Walks a PolyTree into ExPolygons. Islands inside holes become their own ExPolygons. */
function fromTree(tree: ClipperNamespace.PolyTree): ExPoly[] {
  const out: ExPoly[] = [];
  const visitOuter = (node: ClipperNamespace.PolyNode) => {
    const poly: ExPoly = { contour: node.Contour() as Path, holes: [] };
    for (const hole of node.Childs()) {
      poly.holes.push(hole.Contour() as Path);
      for (const island of hole.Childs()) visitOuter(island);
    }
    out.push(poly);
  };
  for (const child of tree.Childs()) visitOuter(child);
  return out;
}

type Fill = 'nonzero' | 'evenodd';
const fillType = (fill: Fill) => (fill === 'nonzero' ? C.PolyFillType.pftNonZero : C.PolyFillType.pftEvenOdd);

function run(
  type: ClipperNamespace.ClipType,
  subject: Path[],
  clip: Path[],
  fill: Fill = 'nonzero',
): ExPoly[] {
  const clipper = new C.Clipper();
  clipper.AddPaths(subject as ClipperNamespace.Paths, C.PolyType.ptSubject, true);
  if (clip.length) clipper.AddPaths(clip as ClipperNamespace.Paths, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  clipper.Execute(type, tree, fillType(fill), fillType(fill));
  return fromTree(tree);
}

/** Merges paths into ExPolygons. The non-zero rule makes overlapping shells one solid. */
export function union(paths: Path[], fill: Fill = 'nonzero'): ExPoly[] {
  return run(C.ClipType.ctUnion, paths, [], fill);
}

export function unionEx(...groups: ExPoly[][]): ExPoly[] {
  return union(groups.flatMap(toPaths));
}

export function difference(subject: ExPoly[], clip: ExPoly[]): ExPoly[] {
  if (!subject.length) return [];
  if (!clip.length) return subject;
  return run(C.ClipType.ctDifference, toPaths(subject), toPaths(clip));
}

export function intersection(subject: ExPoly[], clip: ExPoly[]): ExPoly[] {
  if (!subject.length || !clip.length) return [];
  return run(C.ClipType.ctIntersection, toPaths(subject), toPaths(clip));
}

/**
 * Grows (positive) or shrinks (negative) every outline by `delta` units. Miter
 * joins keep square corners square, which is what a wall should do; the miter
 * limit stops a needle-sharp corner shooting out.
 */
export function offset(polys: ExPoly[], delta: number, join: 'miter' | 'round' = 'miter'): ExPoly[] {
  if (!polys.length) return [];
  if (delta === 0) return polys;
  const co = new C.ClipperOffset(3, SCALE * 0.005);
  co.AddPaths(
    toPaths(polys) as ClipperNamespace.Paths,
    join === 'miter' ? C.JoinType.jtMiter : C.JoinType.jtRound,
    C.EndType.etClosedPolygon,
  );
  const tree = new C.PolyTree();
  co.Execute(tree, delta);
  return fromTree(tree);
}

/**
 * Shrink then grow by the same amount: deletes every part narrower than
 * 2 × `delta` and leaves the rest as it was. The slicers call this "opening".
 */
export function opening(polys: ExPoly[], delta: number): ExPoly[] {
  return offset(offset(polys, -delta), delta);
}

/** Grow then shrink: closes cracks narrower than 2 × `delta`. */
export function closing(polys: ExPoly[], delta: number): ExPoly[] {
  return offset(offset(polys, delta), -delta);
}

/** Clips open polylines to a region and returns the parts inside it. */
export function clipLines(lines: Path[], region: ExPoly[]): Path[] {
  if (!lines.length || !region.length) return [];
  const clipper = new C.Clipper();
  clipper.AddPaths(lines as ClipperNamespace.Paths, C.PolyType.ptSubject, false);
  clipper.AddPaths(toPaths(region) as ClipperNamespace.Paths, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  clipper.Execute(C.ClipType.ctIntersection, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return C.Clipper.OpenPathsFromPolyTree(tree) as Path[];
}

/** Removes points that add nothing: duplicates and near-collinear points within `distance`. */
export function clean(paths: Path[], distance: number): Path[] {
  return (C.Clipper.CleanPolygons(paths as ClipperNamespace.Paths, distance) as Path[]).filter((p) => p.length >= 3);
}

export function cleanEx(polys: ExPoly[], distance: number): ExPoly[] {
  const out: ExPoly[] = [];
  for (const poly of polys) {
    const [contour] = clean([poly.contour], distance);
    if (!contour) continue;
    out.push({ contour, holes: clean(poly.holes, distance) });
  }
  return out;
}

/** 1 inside, 0 outside, -1 on the edge. */
export function pointInPath(point: Pt, path: Path): number {
  return C.Clipper.PointInPolygon(point as ClipperNamespace.IntPoint, path as ClipperNamespace.Path);
}

export function pointInEx(point: Pt, polys: ExPoly[]): boolean {
  for (const poly of polys) {
    if (pointInPath(point, poly.contour) === 0) continue;
    if (poly.holes.some((hole) => pointInPath(point, hole) === 1)) continue;
    return true;
  }
  return false;
}

export function pathLength(path: Path, closed: boolean): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].X - path[i - 1].X, path[i].Y - path[i - 1].Y);
  if (closed && path.length > 1) {
    const a = path[path.length - 1];
    total += Math.hypot(path[0].X - a.X, path[0].Y - a.Y);
  }
  return total;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(paths: Path[]): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const path of paths)
    for (const p of path) {
      if (p.X < box.minX) box.minX = p.X;
      if (p.Y < box.minY) box.minY = p.Y;
      if (p.X > box.maxX) box.maxX = p.X;
      if (p.Y > box.maxY) box.maxY = p.Y;
    }
  return box;
}
