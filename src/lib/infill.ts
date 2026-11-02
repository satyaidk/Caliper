import type { ContourLoop, ContourPoint } from './slicing';
import { normalizeSurfaceRegion } from './surfaces';

export type InfillPattern = 'rectilinear' | 'monotonic' | 'grid';

export interface InfillOptions {
  pattern: InfillPattern;
  lineSpacing: number;
  angleDegrees?: number;
  layerIndex?: number;
}

export type InfillPath = [ContourPoint, ContourPoint];

const MAX_SCANLINES = 20_000;

export function calculateInfillSpacing(baseSpacing: number, density: number): number {
  if (!Number.isFinite(baseSpacing) || baseSpacing <= 0) {
    throw new RangeError('Base infill spacing must be a positive finite number.');
  }
  if (!Number.isFinite(density) || density <= 0 || density > 1) {
    throw new RangeError('Infill density must be greater than 0 and at most 1.');
  }
  return baseSpacing / density;
}

/**
 * Chooses the cardinal bridge direction that crosses the most measured infill
 * path length. Ties use a deterministic geometric fallback.
 */
export function bridgeDirectionFromInfill(
  paths: readonly (readonly [ContourPoint, ContourPoint])[],
  fallbackAngleDegrees: number,
): number {
  if (!Number.isFinite(fallbackAngleDegrees)) {
    throw new RangeError('Bridge fallback angle must be finite.');
  }
  const scores = [0, 0];
  for (const [start, end] of paths) {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length)) throw new RangeError('Infill path coordinates must be finite.');
    if (length <= 1e-10) continue;
    const angle = Math.atan2(dz, dx);
    scores[0] += length * Math.abs(Math.sin(angle));
    scores[1] += length * Math.abs(Math.cos(angle));
  }
  if (Math.abs(scores[0] - scores[1]) <= Math.max(scores[0], scores[1], 1) * 1e-10) {
    return Math.abs(Math.sin((fallbackAngleDegrees * Math.PI) / 180)) >
      Math.abs(Math.cos((fallbackAngleDegrees * Math.PI) / 180))
      ? 90
      : 0;
  }
  return scores[0] > scores[1] ? 0 : 90;
}

function validateOptions(options: InfillOptions): void {
  if (!['rectilinear', 'monotonic', 'grid'].includes(options.pattern)) {
    throw new RangeError('Unsupported infill pattern.');
  }
  if (!Number.isFinite(options.lineSpacing) || options.lineSpacing <= 0) {
    throw new RangeError('Infill line spacing must be a positive finite number.');
  }
  if (options.angleDegrees !== undefined && !Number.isFinite(options.angleDegrees)) {
    throw new RangeError('Infill angle must be finite.');
  }
  if (options.layerIndex !== undefined && (!Number.isInteger(options.layerIndex) || options.layerIndex < 0)) {
    throw new RangeError('Infill layer index must be a non-negative integer.');
  }
}

function familyPaths(
  region: readonly ContourLoop[],
  lineSpacing: number,
  angleDegrees: number,
  alternateDirection: boolean,
): InfillPath[] {
  if (!region.length) return [];
  const angle = (angleDegrees * Math.PI) / 180;
  const cleanAxis = (value: number) =>
    Math.abs(value) < 1e-12 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-12 ? Math.sign(value) : value;
  const directionX = cleanAxis(Math.cos(angle));
  const directionZ = cleanAxis(Math.sin(angle));
  const normalX = -directionZ;
  const normalZ = directionX;
  let minProjection = Infinity;
  let maxProjection = -Infinity;
  for (const loop of region) {
    for (const point of loop) {
      const projection = point.x * normalX + point.z * normalZ;
      minProjection = Math.min(minProjection, projection);
      maxProjection = Math.max(maxProjection, projection);
    }
  }
  const minLine = Math.ceil(minProjection / lineSpacing - 1e-10);
  const maxLine = Math.floor(maxProjection / lineSpacing + 1e-10);
  if (maxLine - minLine + 1 > MAX_SCANLINES) {
    throw new RangeError(`Infill exceeds the ${MAX_SCANLINES} scanline safety limit.`);
  }

  const intersectionsByLine = Array.from(
    { length: Math.max(0, maxLine - minLine + 1) },
    () => [] as number[],
  );
  for (const loop of region) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const aNormal = a.x * normalX + a.z * normalZ;
      const bNormal = b.x * normalX + b.z * normalZ;
      const firstLine = Math.max(minLine, Math.ceil(Math.min(aNormal, bNormal) / lineSpacing - 1e-10));
      const lastLine = Math.min(maxLine, Math.floor(Math.max(aNormal, bNormal) / lineSpacing + 1e-10));
      for (let line = firstLine; line <= lastLine; line++) {
        const offset = line * lineSpacing;
        if (!((aNormal <= offset && offset < bNormal) || (bNormal <= offset && offset < aNormal))) continue;
        const ratio = (offset - aNormal) / (bNormal - aNormal);
        const x = a.x + (b.x - a.x) * ratio;
        const z = a.z + (b.z - a.z) * ratio;
        intersectionsByLine[line - minLine].push(x * directionX + z * directionZ);
      }
    }
  }

  const paths: InfillPath[] = [];
  for (let line = minLine; line <= maxLine; line++) {
    const offset = line * lineSpacing;
    const intersections = intersectionsByLine[line - minLine]
      .sort((a, b) => a - b)
      .filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > 1e-10);

    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = intersections[i];
      const end = intersections[i + 1];
      if (end - start <= 1e-10) continue;

      const startPoint = {
        x: directionX * start + normalX * offset,
        z: directionZ * start + normalZ * offset,
      };
      const endPoint = {
        x: directionX * end + normalX * offset,
        z: directionZ * end + normalZ * offset,
      };
      const reverse = alternateDirection && Math.abs(line % 2) === 1;
      paths.push(reverse ? [endPoint, startPoint] : [startPoint, endPoint]);
    }
  }
  return paths;
}

/**
 * Clips parallel fill lines to closed layer contours. Nested rings remain
 * empty, while disjoint islands generate independent line segments.
 */
export function generateInfillPaths(
  contours: readonly ContourLoop[],
  options: InfillOptions,
): InfillPath[] {
  validateOptions(options);
  const region = normalizeSurfaceRegion(contours);
  if (!region.length) return [];

  const layerIndex = options.layerIndex ?? 0;
  const baseAngle =
    (options.angleDegrees ?? 45) +
    (options.pattern !== 'monotonic' && layerIndex % 2 === 1 ? 90 : 0);
  const primary = familyPaths(
    region,
    options.lineSpacing,
    baseAngle,
    options.pattern === 'rectilinear',
  );
  if (options.pattern !== 'grid') return primary;
  return primary.concat(familyPaths(region, options.lineSpacing, baseAngle + 90, false));
}
