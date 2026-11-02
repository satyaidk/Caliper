import { closing, cleanEx, toUnits, union, type ExPoly, type Path } from './clipper';

/**
 * Cutting a triangle mesh into closed outlines, one set per layer
 * (docs/slicer-logic.md, section 8).
 *
 * 1. Weld the corners so triangles that touch share vertex numbers, which
 *    gives every edge an identity.
 * 2. For each layer height, every triangle the plane passes through gives one
 *    segment between two crossed edges.
 * 3. Segments meeting at the same crossed edge are neighbours: chaining by edge
 *    identity closes the loops of a clean mesh without comparing coordinates.
 * 4. Whatever stays open (a broken mesh) is joined end to end where ends lie
 *    close together.
 * 5. The loops are merged with the non-zero rule, so overlapping shells count
 *    as one solid and holes (wound the other way) stay holes.
 *
 * A corner exactly on the plane counts as below it. Every crossed triangle then
 * has exactly two crossed edges, so there are no special cases for touching
 * vertices or horizontal faces.
 */

export interface MeshInput {
  /** Nine numbers per triangle: three corners, x y z, printer mm, Z up. */
  positions: Float32Array;
}

export interface SliceDiagnostics {
  /** Contours that would not close, per layer index, after gap closing. */
  openContours: Map<number, number>;
  /** Total length of the open pieces that had to be dropped, mm. */
  droppedLength: number;
  /** Degenerate (zero-area) triangles skipped. */
  degenerate: number;
}

interface Segment {
  edgeA: number;
  edgeB: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Gaps up to this wide are bridged when a broken mesh leaves contours open, mm. */
const GAP_CLOSE = 1.0;
/** A morphological closing of this radius seals hairline cracks, mm. */
const CLOSING_RADIUS = 0.05;
/** Points nearer together than this are merged, mm. */
const RESOLUTION = 0.01;

export function sliceMesh(
  mesh: MeshInput,
  sliceZs: number[],
  onProgress?: (fraction: number) => void,
): { layers: ExPoly[][]; diagnostics: SliceDiagnostics } {
  const pos = mesh.positions;
  const triangleCount = Math.floor(pos.length / 9);

  // 1. Weld corners. Keys are corner positions rounded to a micrometre.
  const vertexIds = new Map<string, number>();
  const vx: number[] = [];
  const vy: number[] = [];
  const vz: number[] = [];
  const corners = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount * 3; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vx.length;
      vertexIds.set(key, id);
      vx.push(x);
      vy.push(y);
      vz.push(z);
    }
    corners[i] = id;
  }
  const vertexCount = vx.length;
  const edgeId = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);

  // 2. Cut. Each triangle only visits the layers its height range spans.
  const segments: Segment[][] = sliceZs.map(() => []);
  const diagnostics: SliceDiagnostics = { openContours: new Map(), droppedLength: 0, degenerate: 0 };
  const firstAtOrAbove = (z: number) => {
    // Index of the first slice plane at or above z.
    let lo = 0;
    let hi = sliceZs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sliceZs[mid] < z) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (let t = 0; t < triangleCount; t++) {
    const a = corners[t * 3];
    const b = corners[t * 3 + 1];
    const c = corners[t * 3 + 2];
    if (a === b || b === c || c === a) {
      diagnostics.degenerate++;
      continue;
    }
    const zMin = Math.min(vz[a], vz[b], vz[c]);
    const zMax = Math.max(vz[a], vz[b], vz[c]);
    // A plane cuts the triangle when some corner is above it and some is not:
    // zMin <= z < zMax. A plane exactly at zMin still cuts (the low corners count
    // as below), so two parts stacked exactly on a plane keep their outline.
    let p = firstAtOrAbove(zMin);
    if (p >= sliceZs.length || sliceZs[p] >= zMax) continue;

    // The outward normal's horizontal part decides which way the segment runs.
    const ux = vx[b] - vx[a];
    const uy = vy[b] - vy[a];
    const uz = vz[b] - vz[a];
    const wx = vx[c] - vx[a];
    const wy = vy[c] - vy[a];
    const wz = vz[c] - vz[a];
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;

    const tri = [a, b, c];
    for (; p < sliceZs.length && sliceZs[p] < zMax; p++) {
      const z = sliceZs[p];
      const hits: { edge: number; x: number; y: number }[] = [];
      for (let k = 0; k < 3; k++) {
        const i = tri[k];
        const j = tri[(k + 1) % 3];
        const iAbove = vz[i] > z;
        const jAbove = vz[j] > z;
        if (iAbove === jAbove) continue;
        const f = (z - vz[i]) / (vz[j] - vz[i]);
        hits.push({ edge: edgeId(i, j), x: vx[i] + f * (vx[j] - vx[i]), y: vy[i] + f * (vy[j] - vy[i]) });
      }
      if (hits.length !== 2) continue;
      let [h1, h2] = hits;
      // Outward normal on the right of the direction of travel: counter-clockwise outlines.
      const dx = h2.x - h1.x;
      const dy = h2.y - h1.y;
      if (dy * nx - dx * ny < 0) [h1, h2] = [h2, h1];
      segments[p].push({ edgeA: h1.edge, edgeB: h2.edge, ax: h1.x, ay: h1.y, bx: h2.x, by: h2.y });
    }
    if (onProgress && (t & 0xffff) === 0) onProgress((t / triangleCount) * 0.6);
  }

  // 3–5. Chain each layer's segments into loops and merge them.
  const layers = segments.map((layerSegments, index) => {
    if (onProgress && (index & 15) === 0) onProgress(0.6 + (index / segments.length) * 0.4);
    const { loops, open, dropped } = chainLoops(layerSegments);
    if (open) diagnostics.openContours.set(index, open);
    diagnostics.droppedLength += dropped;
    if (!loops.length) return [];
    const merged = union(loops, 'nonzero');
    return cleanEx(closing(merged, toUnits(CLOSING_RADIUS)), toUnits(RESOLUTION));
  });

  return { layers, diagnostics };
}

/** Joins one layer's segments into closed loops (in Clipper units). */
export function chainLoops(segments: Segment[]): { loops: Path[]; open: number; dropped: number } {
  // Each crossed edge is shared by exactly two segments on a clean mesh.
  const byEdge = new Map<number, number[]>();
  const link = (edge: number, s: number) => {
    const list = byEdge.get(edge);
    if (list) list.push(s);
    else byEdge.set(edge, [s]);
  };
  segments.forEach((s, i) => {
    link(s.edgeA, i);
    link(s.edgeB, i);
  });

  const used = new Uint8Array(segments.length);
  const loops: Path[] = [];
  const chains: { pts: [number, number][] }[] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const s0 = segments[start];
    const pts: [number, number][] = [
      [s0.ax, s0.ay],
      [s0.bx, s0.by],
    ];
    // Count how many segments are walked with and against their own direction.
    let forward = 1;
    let backward = 0;

    // Walk forward from edgeB until the loop returns to edgeA or runs out.
    let edge = s0.edgeB;
    let closed = false;
    for (;;) {
      if (edge === s0.edgeA) {
        closed = true;
        break;
      }
      const next = byEdge.get(edge)?.find((s) => !used[s]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segments[next];
      if (s.edgeA === edge) {
        pts.push([s.bx, s.by]);
        edge = s.edgeB;
        forward++;
      } else {
        pts.push([s.ax, s.ay]);
        edge = s.edgeA;
        backward++;
      }
    }

    if (!closed) {
      // Open on a broken mesh: extend backwards from the start too.
      edge = s0.edgeA;
      for (;;) {
        const next = byEdge.get(edge)?.find((s) => !used[s]);
        if (next === undefined) break;
        used[next] = 1;
        const s = segments[next];
        if (s.edgeB === edge) {
          pts.unshift([s.ax, s.ay]);
          edge = s.edgeA;
          forward++;
        } else {
          pts.unshift([s.bx, s.by]);
          edge = s.edgeB;
          backward++;
        }
      }
    }

    // A neighbour with flipped winding makes its segment run backwards. The
    // majority decides the loop's direction, so a few bad triangles cannot
    // turn a solid into a hole.
    if (backward > forward) pts.reverse();
    if (closed) {
      pts.pop(); // the last point repeats the first
      loops.push(pts.map(([x, y]) => ({ X: toUnits(x), Y: toUnits(y) })));
    } else {
      chains.push({ pts });
    }
  }

  // Gap closing: join open chains end to start, nearest first, within GAP_CLOSE.
  let open = 0;
  let dropped = 0;
  const pending = chains.slice().sort((a, b) => b.pts.length - a.pts.length);
  const gap2 = GAP_CLOSE * GAP_CLOSE;
  while (pending.length) {
    const chain = pending.shift()!;
    for (;;) {
      const [ex, ey] = chain.pts[chain.pts.length - 1];
      const [sx, sy] = chain.pts[0];
      if ((ex - sx) ** 2 + (ey - sy) ** 2 <= gap2 && chain.pts.length >= 3) {
        loops.push(chain.pts.map(([x, y]) => ({ X: toUnits(x), Y: toUnits(y) })));
        break;
      }
      // Find the nearest other chain whose start (or end, reversed) is close to our end.
      let best = -1;
      let bestD = gap2;
      let reverse = false;
      pending.forEach((other, i) => {
        const [ox, oy] = other.pts[0];
        const [px, py] = other.pts[other.pts.length - 1];
        const dStart = (ox - ex) ** 2 + (oy - ey) ** 2;
        const dEnd = (px - ex) ** 2 + (py - ey) ** 2;
        if (dStart <= bestD) {
          best = i;
          bestD = dStart;
          reverse = false;
        }
        if (dEnd < bestD) {
          best = i;
          bestD = dEnd;
          reverse = true;
        }
      });
      if (best < 0) {
        open++;
        for (let i = 1; i < chain.pts.length; i++)
          dropped += Math.hypot(chain.pts[i][0] - chain.pts[i - 1][0], chain.pts[i][1] - chain.pts[i - 1][1]);
        break;
      }
      const [other] = pending.splice(best, 1);
      const pts = reverse ? other.pts.slice().reverse() : other.pts;
      chain.pts.push(...pts);
    }
  }

  return { loops, open, dropped };
}
