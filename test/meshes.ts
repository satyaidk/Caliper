/**
 * Test meshes for the slicer, in printer space (Z up, millimetres), as the flat
 * nine-numbers-per-triangle array the slicer takes. Each has answers you can
 * work out on paper. Not a test file itself: the runner only picks up
 * `*.test.ts`.
 */

type V = [number, number, number];

/** Two triangles per quad, corners counter-clockwise seen from outside. */
function quads(faces: V[][], flip = false): number[] {
  const out: number[] = [];
  for (const q of faces) {
    const [a, b, c, d] = flip ? [q[0], q[3], q[2], q[1]] : q;
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return out;
}

/**
 * An axis-aligned box. `flip` turns it inside out, which is how a hollow is
 * modelled: an inside-out box within a box. `skip` leaves faces off, for open meshes.
 */
export function box(min: V, max: V, options: { flip?: boolean; skip?: string[] } = {}): number[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: Record<string, V[]> = {
    bottom: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    top: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    front: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    right: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
    back: [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
    left: [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
  };
  const skip = new Set(options.skip ?? []);
  return quads(
    Object.entries(faces)
      .filter(([name]) => !skip.has(name))
      .map(([, face]) => face),
    options.flip,
  );
}

/** A 20 mm cube centred on the bed (the slicer's input is bed-centred). */
export const cube20 = () => box([-10, -10, 0], [10, 10, 20]);

/** A UV sphere resting on the bed. */
export function sphere(radius: number, segments: number): number[] {
  const out: number[] = [];
  const at = (i: number, j: number): V => {
    const theta = (Math.PI * i) / segments;
    const phi = (2 * Math.PI * j) / (2 * segments);
    return [radius * Math.sin(theta) * Math.cos(phi), radius * Math.sin(theta) * Math.sin(phi), radius - radius * Math.cos(theta)];
  };
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < 2 * segments; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i > 0) out.push(...a, ...b, ...d);
      if (i < segments - 1) out.push(...b, ...c, ...d);
    }
  return out;
}

export const f32 = (values: number[]) => new Float32Array(values);
