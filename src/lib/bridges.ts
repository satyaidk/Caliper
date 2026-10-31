import { bridgeDirectionFromInfill, calculateInfillSpacing, generateInfillPaths } from './infill';
import type { InfillPath } from './infill';
import type { ContourLoop } from './slicing';
import { intersectSurfaceRegions } from './surfaces';
import { expandContours, insetContours } from './walls';

export const BRIDGE_ANCHOR_MM = 3;
/** Flow.cpp's BRIDGE_EXTRA_SPACING: bridge threads sit this far apart beyond their diameter. */
export const BRIDGE_EXTRA_SPACING_MM = 0.05;

export function bridgeLineSpacing(threadDiameterMm: number): number {
  return threadDiameterMm + BRIDGE_EXTRA_SPACING_MM;
}

export interface BridgeInfillOptions {
  lineWidthMm: number;
  worldPerMm: number;
  density: number;
  layerIndex: number;
  analyzeSupportSpans?: boolean;
  /**
   * Area the bridge may occupy, normally the layer inside its walls. Without
   * it the 3 mm anchor grows bridge paths into the wall beads.
   */
  boundary?: readonly ContourLoop[];
  /** Diameter of the round bridge thread (the nozzle diameter); defaults to `lineWidthMm`. */
  bridgeLineWidthMm?: number;
  /** Area of the previous layer's sparse paths; defaults to its internal region inset by two lines. */
  previousSparseArea?: readonly ContourLoop[];
}

export interface BridgeInfillPlan {
  region: ContourLoop[];
  paths: InfillPath[];
  unsupportedSpans: InfillPath[];
  angleDegrees: number;
}

function segmentIntersectionParameter(
  bridge: InfillPath,
  support: InfillPath,
): number | null {
  const [a, b] = bridge;
  const [c, d] = support;
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denominator = rx * sz - rz * sx;
  if (Math.abs(denominator) < 1e-10) return null;

  const qx = c.x - a.x;
  const qz = c.z - a.z;
  const t = (qx * sz - qz * sx) / denominator;
  const u = (qx * rz - qz * rx) / denominator;
  const epsilon = 1e-9;
  return t > epsilon && t < 1 - epsilon && u >= -epsilon && u <= 1 + epsilon
    ? t
    : null;
}

export function findUnsupportedBridgeSpans(
  bridgePaths: readonly InfillPath[],
  supportPaths: readonly InfillPath[],
): InfillPath[] {
  const spans: InfillPath[] = [];
  for (const bridge of bridgePaths) {
    const intersections = supportPaths
      .map((support) => segmentIntersectionParameter(bridge, support))
      .filter((parameter): parameter is number => parameter !== null)
      .sort((a, b) => a - b)
      .filter((parameter, index, values) => index === 0 || parameter - values[index - 1] > 1e-8);
    for (let index = 0; index + 1 < intersections.length; index++) {
      const startT = intersections[index];
      const endT = intersections[index + 1];
      const [start, end] = bridge;
      const at = (t: number) => ({
        x: start.x + (end.x - start.x) * t,
        z: start.z + (end.z - start.z) * t,
      });
      spans.push([at(startT), at(endT)]);
    }
  }
  return spans;
}

export function bridgeFallbackAngle(contours: readonly ContourLoop[]): number {
  const bounds = contours.flat().reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      maxX: Math.max(result.maxX, point.x),
      minZ: Math.min(result.minZ, point.z),
      maxZ: Math.max(result.maxZ, point.z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  );
  return bounds.maxX - bounds.minX <= bounds.maxZ - bounds.minZ ? 0 : 90;
}

export function planBridgeOverInfill(
  topShell: readonly ContourLoop[],
  previousInternal: readonly ContourLoop[],
  options: BridgeInfillOptions,
): BridgeInfillPlan {
  if (!Number.isFinite(options.lineWidthMm) || options.lineWidthMm <= 0) {
    throw new RangeError('Bridge line width must be a positive finite number.');
  }
  if (!Number.isFinite(options.worldPerMm) || options.worldPerMm <= 0) {
    throw new RangeError('Bridge world scale must be a positive finite number.');
  }
  if (
    options.bridgeLineWidthMm !== undefined &&
    (!Number.isFinite(options.bridgeLineWidthMm) || options.bridgeLineWidthMm <= 0)
  ) {
    throw new RangeError('Bridge thread width must be a positive finite number.');
  }
  if (!Number.isInteger(options.layerIndex) || options.layerIndex < 0) {
    throw new RangeError('Bridge layer index must be a non-negative integer.');
  }
  const lineWidth = options.lineWidthMm * options.worldPerMm;
  const sparseLineSpacing = calculateInfillSpacing(lineWidth, options.density);
  const empty = { region: [], paths: [], unsupportedSpans: [], angleDegrees: 0 };
  if (!topShell.length || !previousInternal.length || options.density >= 1 || options.layerIndex === 0) {
    return empty;
  }

  const candidate = intersectSurfaceRegions(topShell, previousInternal);
  if (!candidate.length) return empty;
  const anchored = intersectSurfaceRegions(
    expandContours(candidate, BRIDGE_ANCHOR_MM * options.worldPerMm),
    topShell,
  );
  const region = options.boundary ? intersectSurfaceRegions(anchored, options.boundary) : anchored;
  if (!region.length) return empty;

  const sparsePaths = generateInfillPaths(
    options.previousSparseArea ?? insetContours(previousInternal, 2 * lineWidth),
    {
      pattern: 'grid',
      lineSpacing: sparseLineSpacing,
      angleDegrees: 45,
      layerIndex: options.layerIndex - 1,
    },
  );
  const angleDegrees = bridgeDirectionFromInfill(sparsePaths, bridgeFallbackAngle(region));
  const paths = generateInfillPaths(region, {
    pattern: 'monotonic',
    lineSpacing: bridgeLineSpacing(options.bridgeLineWidthMm ?? options.lineWidthMm) * options.worldPerMm,
    angleDegrees,
    layerIndex: options.layerIndex,
  });
  const unsupportedSpans = options.analyzeSupportSpans
    ? findUnsupportedBridgeSpans(paths, sparsePaths)
    : [];
  return { region, paths, unsupportedSpans, angleDegrees };
}
