import { exArea, offset, opening, toUnits, type ExPoly, type Path } from './clipper';
import { lineSpacing } from './flow';

/**
 * Classic walls (docs/slicer-logic.md, 9.3): the outline shrunk inwards one
 * line at a time. Every wall has the same width; Arachne's variable-width walls
 * are not implemented.
 *
 *   wall 0 (outer) = outline shrunk by outer width / 2   (its centre line)
 *   wall 1         = wall 0 shrunk by (outer spacing + inner spacing) / 2
 *   wall n         = wall n−1 shrunk by inner spacing
 *
 * Walls step by *spacing*, not width, so neighbouring lines overlap slightly and
 * fuse. The infill area is the last wall's inside edge, pushed 25 % back into
 * the wall so the two bond.
 */

export interface WallLoop {
  /** 0 is the outer wall. */
  index: number;
  path: Path;
  /** True for a loop around a hole. */
  hole: boolean;
}

export interface IslandWalls {
  /** The island's outline, for travel and ordering. */
  outline: ExPoly;
  loops: WallLoop[];
  /** Where infill goes. */
  infillArea: ExPoly[];
  /** Area of features too thin for even one wall, mm². They will not print. */
  lostArea: number;
}

export interface WallWidths {
  outer: number;
  inner: number;
  /** Infill line spacing, for the overlap and sliver rules. */
  infillSpacing: number;
}

/** How far the infill reaches back into the last wall, as a fraction (PrusaSlicer's default). */
const INFILL_OVERLAP = 0.25;

export function makeWalls(island: ExPoly, wallCount: number, widths: WallWidths, height: number): IslandWalls {
  const outerSpacing = lineSpacing(widths.outer, height);
  const innerSpacing = lineSpacing(widths.inner, height);
  const loops: WallLoop[] = [];
  let last: ExPoly[] = [island];
  let made = 0;

  for (let i = 0; i < wallCount; i++) {
    const distance = i === 0 ? widths.outer / 2 : i === 1 ? (outerSpacing + innerSpacing) / 2 : innerSpacing;
    const next = offset(last, -toUnits(distance));
    if (!next.length) break;
    last = next;
    made++;
    for (const poly of next) {
      loops.push({ index: i, path: poly.contour, hole: false });
      for (const hole of poly.holes) loops.push({ index: i, path: hole, hole: true });
    }
  }

  let infillArea: ExPoly[] = [];
  if (made > 0) {
    const inset = made === 1 ? outerSpacing / 2 : innerSpacing / 2;
    const overlap = INFILL_OVERLAP * (inset + widths.infillSpacing / 2);
    // Remove slivers narrower than one infill line: they would print as noise.
    infillArea = opening(offset(last, -toUnits(inset - overlap)), toUnits(widths.infillSpacing / 2));
  }

  // What a single outer wall would cover, compared with the outline itself:
  // anything that vanished is thinner than one line.
  const printable = offset(offset([island], -toUnits(widths.outer / 2)), toUnits(widths.outer / 2));
  const lostArea = Math.max(0, (exArea([island]) - exArea(printable)) / (1000 * 1000));

  return { outline: island, loops, infillArea, lostArea };
}

/** All loop paths of a set of islands, for drawing or tests. */
export function loopPaths(walls: IslandWalls[]): Path[] {
  return walls.flatMap((w) => w.loops.map((l) => l.path));
}
