import type { TriangleSource } from '@/viewer/triangles';

export interface Layer {
  index: number;
  bottom: number;
  top: number;
  height: number;
  sliceZ: number;
  printZ: number;
}

export interface LayerProfilePoint {
  z: number;
  height: number;
}

export interface LayerPlanOptions {
  layerHeight: number;
  firstLayerHeight?: number;
  minLayerHeight?: number;
  profile?: readonly LayerProfilePoint[];
}

/** A point in model coordinates, projected onto the horizontal X/Z slice. */
export interface ContourPoint {
  x: number;
  z: number;
}

export type ContourLoop = ContourPoint[];

const MAX_LAYERS = 1_000_000;

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number.`);
  return value;
}

function validateProfile(profile: readonly LayerProfilePoint[] | undefined): void {
  if (!profile) return;
  let previousZ = -Infinity;
  for (const point of profile) {
    if (!Number.isFinite(point.z) || point.z < 0 || point.z <= previousZ) {
      throw new RangeError('Layer profile Z values must be finite, non-negative and strictly increasing.');
    }
    positiveFinite(point.height, 'Layer profile height');
    previousZ = point.z;
  }
  if (profile.length === 0) throw new RangeError('A layer profile must contain at least one point.');
}

function heightAt(z: number, options: LayerPlanOptions): number {
  const profile = options.profile;
  if (!profile?.length) return options.layerHeight;
  if (z <= profile[0].z) return profile[0].height;
  for (let i = 1; i < profile.length; i++) {
    const right = profile[i];
    if (z <= right.z) {
      const left = profile[i - 1];
      const fraction = (z - left.z) / (right.z - left.z);
      return left.height + (right.height - left.height) * fraction;
    }
  }
  return profile[profile.length - 1].height;
}

/**
 * Builds a Bambu/Prusa-style layer schedule from a fixed or linearly
 * interpolated height profile. A short final layer is kept so the plan reaches
 * the model top exactly.
 */
export function generateLayerPlan(objectHeight: number, options: LayerPlanOptions): Layer[] {
  if (!Number.isFinite(objectHeight) || objectHeight < 0) {
    throw new RangeError('Object height must be a non-negative finite number.');
  }
  const layerHeight = positiveFinite(options.layerHeight, 'Layer height');
  const firstLayerHeight = positiveFinite(options.firstLayerHeight ?? layerHeight, 'First layer height');
  const minLayerHeight = positiveFinite(options.minLayerHeight ?? Math.min(0.07, layerHeight), 'Minimum layer height');
  validateProfile(options.profile);

  if (objectHeight === 0) {
    return [{ index: 1, bottom: 0, top: 0, height: 0, sliceZ: 0, printZ: 0 }];
  }

  const layers: Layer[] = [];
  let bottom = 0;
  const tolerance = Math.max(objectHeight, layerHeight, firstLayerHeight) * Number.EPSILON * 16;
  const addLayer = (top: number) => {
    const clippedTop = Math.min(objectHeight, top);
    const boundedTop = objectHeight - clippedTop <= tolerance ? objectHeight : clippedTop;
    const height = boundedTop - bottom;
    layers.push({
      index: layers.length + 1,
      bottom,
      top: boundedTop,
      height,
      sliceZ: bottom + height / 2,
      printZ: boundedTop,
    });
    bottom = boundedTop;
  };

  addLayer(firstLayerHeight);
  while (bottom < objectHeight - tolerance) {
    if (layers.length >= MAX_LAYERS) {
      throw new RangeError(`Layer plan exceeds the ${MAX_LAYERS.toLocaleString()} layer limit.`);
    }
    if (objectHeight - bottom <= minLayerHeight) {
      addLayer(objectHeight);
      break;
    }

    const candidateHeight = positiveFinite(heightAt(bottom + minLayerHeight / 2, options), 'Profile layer height');
    const top = Math.min(objectHeight, bottom + candidateHeight);
    if (!(top > bottom)) throw new RangeError('Layer profile did not advance the layer plan.');
    addLayer(top);
  }

  return layers;
}

/** Finds the layer whose mid-height is nearest a normalized cut position. */
export function layerIndexAtFraction(fraction: number, layers: readonly Layer[], objectHeight: number): number {
  if (!layers.length || !(objectHeight > 0)) return 1;
  const target = Math.min(1, Math.max(0, fraction)) * objectHeight;
  let low = 0;
  let high = layers.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (layers[middle].sliceZ < target) low = middle + 1;
    else high = middle;
  }
  const lower = Math.max(0, low - 1);
  const nearest = Math.abs(layers[lower].sliceZ - target) <= Math.abs(layers[low].sliceZ - target) ? lower : low;
  return nearest + 1;
}

/** The normalized mid-height used to preview a 1-based layer. */
export function layerFractionAt(index: number, layers: readonly Layer[], objectHeight: number): number {
  if (!(objectHeight > 0)) return 1;
  const layer = layers[index - 1];
  return layer ? layer.sliceZ / objectHeight : 1;
}

interface Segment {
  a: string;
  b: string;
}

/**
 * Intersects a triangle stream with a horizontal plane, stitches matching
 * endpoints into closed outlines, and drops open chains. Returned loops are
 * deliberately unfilled: inner rings remain visible as holes.
 */
export function sliceContours(source: TriangleSource, planeY: number, tolerance = 1e-7): ContourLoop[] {
  if (!Number.isFinite(planeY)) throw new RangeError('Slice height must be finite.');
  positiveFinite(tolerance, 'Slice tolerance');

  const points = new Map<string, ContourPoint>();
  const segments: Segment[] = [];
  const segmentKeys = new Set<string>();
  const pointKey = (point: ContourPoint) => `${Math.round(point.x / tolerance)},${Math.round(point.z / tolerance)}`;
  const addPoint = (point: ContourPoint) => {
    const key = pointKey(point);
    if (!points.has(key)) points.set(key, point);
    return key;
  };
  const addSegment = (a: ContourPoint, b: ContourPoint) => {
    const ka = addPoint(a);
    const kb = addPoint(b);
    if (ka === kb) return;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (segmentKeys.has(key)) return;
    segmentKeys.add(key);
    segments.push({ a: ka, b: kb });
  };

  source((triangle) => {
    const intersections: ContourPoint[] = [];
    let onPlane = 0;
    let scale = Math.abs(planeY);
    for (let i = 0; i < 9; i += 3) {
      scale = Math.max(scale, Math.abs(triangle[i]), Math.abs(triangle[i + 1]), Math.abs(triangle[i + 2]));
    }
    const epsilon = Math.max(tolerance, scale * Number.EPSILON * 16);
    for (let i = 0; i < 9; i += 3) {
      const y = triangle[i + 1];
      if (Math.abs(y - planeY) <= epsilon) {
        onPlane++;
        intersections.push({ x: triangle[i], z: triangle[i + 2] });
      }
    }
    if (onPlane === 3) return;

    for (let edge = 0; edge < 3; edge++) {
      const a = edge * 3;
      const b = ((edge + 1) % 3) * 3;
      const da = triangle[a + 1] - planeY;
      const db = triangle[b + 1] - planeY;
      if ((da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon)) {
        const fraction = da / (da - db);
        intersections.push({
          x: triangle[a] + (triangle[b] - triangle[a]) * fraction,
          z: triangle[a + 2] + (triangle[b + 2] - triangle[a + 2]) * fraction,
        });
      }
    }

    const unique = new Map(intersections.map((point) => [pointKey(point), point]));
    const crossed = [...unique.values()];
    if (crossed.length < 2) return;
    if (crossed.length === 2) {
      addSegment(crossed[0], crossed[1]);
      return;
    }

    let farthest: [ContourPoint, ContourPoint] = [crossed[0], crossed[1]];
    let distance = -1;
    for (let i = 0; i < crossed.length; i++) {
      for (let j = i + 1; j < crossed.length; j++) {
        const dx = crossed[i].x - crossed[j].x;
        const dz = crossed[i].z - crossed[j].z;
        const candidate = dx * dx + dz * dz;
        if (candidate > distance) {
          distance = candidate;
          farthest = [crossed[i], crossed[j]];
        }
      }
    }
    addSegment(farthest[0], farthest[1]);
  });

  const adjacency = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const key of [segment.a, segment.b]) {
      const attached = adjacency.get(key);
      if (attached) attached.push(index);
      else adjacency.set(key, [index]);
    }
  });

  const used = new Uint8Array(segments.length);
  const loops: ContourLoop[] = [];
  for (let first = 0; first < segments.length; first++) {
    if (used[first]) continue;
    const start = segments[first].a;
    let current = start;
    let edge = first;
    const path: string[] = [start];
    let closed = false;

    while (!used[edge]) {
      used[edge] = 1;
      const segment = segments[edge];
      current = segment.a === current ? segment.b : segment.a;
      if (current === start) {
        closed = true;
        break;
      }
      path.push(current);
      edge = (adjacency.get(current) ?? []).find((candidate) => !used[candidate]) ?? -1;
      if (edge < 0) break;
    }

    if (closed && path.length >= 3) {
      loops.push(path.map((key) => points.get(key)!));
    }
  }
  return loops;
}
