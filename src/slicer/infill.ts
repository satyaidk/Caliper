import { boundsOf, clipLines, toPaths, type ExPoly, type Path, type Pt } from './clipper';

/**
 * Straight-line fills (docs/slicer-logic.md, section 11).
 *
 * The region is turned so the lines run along X, lines are laid every
 * `spacing` across it, clipped to the region, and turned back. Lines sit on a
 * grid fixed to the bed, not to the region, so the same infill line lands in
 * the same place on every layer and crossing layers bond.
 *
 * Lines come back in sweep order, alternating direction (back and forth, like
 * mowing a lawn), so the nozzle moves to the next line instead of crossing the
 * part. That is also what makes it "monotonic": every line is printed after
 * the one beside it.
 */

const rotate = (p: Pt, cos: number, sin: number): Pt => ({
  X: Math.round(p.X * cos - p.Y * sin),
  Y: Math.round(p.X * sin + p.Y * cos),
});

export function lineFill(region: ExPoly[], angleDeg: number, spacing: number): Path[] {
  if (!region.length || !(spacing > 0)) return [];
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  // Into the frame where the lines are horizontal: rotate by −angle.
  const turned: ExPoly[] = region.map((poly) => ({
    contour: poly.contour.map((p) => rotate(p, cos, -sin)),
    holes: poly.holes.map((h) => h.map((p) => rotate(p, cos, -sin))),
  }));
  const box = boundsOf(toPaths(turned));
  const first = Math.ceil(box.minY / spacing);
  const last = Math.floor(box.maxY / spacing);
  if (last < first) return [];

  const lines: Path[] = [];
  for (let k = first; k <= last; k++) {
    const y = k * spacing;
    lines.push([
      { X: box.minX - 10, Y: y },
      { X: box.maxX + 10, Y: y },
    ]);
  }

  const pieces = clipLines(lines, turned)
    .filter((piece) => piece.length >= 2)
    .map((piece) => {
      const k = Math.round(piece[0].Y / spacing);
      const [p, q] = piece[0].X <= piece[piece.length - 1].X ? [piece[0], piece[piece.length - 1]] : [piece[piece.length - 1], piece[0]];
      return { k, p, q };
    });
  pieces.sort((u, v) => u.k - v.k || u.p.X - v.p.X);

  return pieces.map(({ k, p, q }) => {
    const ends = (k - first) % 2 === 0 ? [p, q] : [q, p];
    return ends.map((e) => rotate(e, cos, sin));
  });
}

/**
 * The bridge direction: of a few candidate angles, the one whose lines are
 * shortest on average. Short threads span the gap; long ones run along it and
 * sag. A simplified stand-in for the slicers' bridge detector.
 */
export function bridgeAngle(region: ExPoly[], spacing: number): number {
  let best = 0;
  let bestLength = Infinity;
  for (const angle of [0, 45, 90, 135]) {
    const lines = lineFill(region, angle, spacing);
    if (!lines.length) continue;
    let total = 0;
    for (const [p, q] of lines) total += Math.hypot(q.X - p.X, q.Y - p.Y);
    const mean = total / lines.length;
    if (mean < bestLength - 1) {
      best = angle;
      bestLength = mean;
    }
  }
  return best;
}
