import { expandContours, openContours } from './walls';
import {
  intersectSurfaceRegions,
  normalizeSurfaceRegion,
  subtractSurfaceRegions,
  unionSurfaceRegions,
} from './surfaces';
import type { ContourLoop } from './slicing';

/**
 * One layer of the support input. `region` must use the same unit as the
 * heights and option distances (millimetres in the G-code exporter); mixing
 * world units with millimetre distances silently changes every overhang test.
 */
export interface SupportLayerInput {
  region: readonly ContourLoop[];
  bottom: number;
  printZ: number;
  height: number;
}

export interface GridSupportOptions {
  thresholdAngleDegrees: number;
  /** Vertical air gap between the top support layer and the part above it. */
  contactDistance: number;
  /** Extrusion width; overhang slivers narrower than this are ignored. */
  lineWidth: number;
  interfaceLayers: number;
  /** Horizontal clearance between support and the part on the same layer. */
  xyDistance?: number;
}

export interface GridSupportPlan {
  body: ContourLoop[][];
  interface: ContourLoop[][];
}

const DEFAULT_XY_DISTANCE = 0.35;
const EPSILON = 1e-8;

function validateOptions(options: GridSupportOptions): void {
  if (
    !Number.isFinite(options.thresholdAngleDegrees) ||
    options.thresholdAngleDegrees <= 0 ||
    options.thresholdAngleDegrees >= 89
  ) {
    throw new RangeError('Support threshold angle must be greater than 0 and less than 89 degrees.');
  }
  if (!Number.isFinite(options.contactDistance) || options.contactDistance < 0) {
    throw new RangeError('Support contact distance must be a non-negative finite number.');
  }
  if (!Number.isFinite(options.lineWidth) || options.lineWidth <= 0) {
    throw new RangeError('Support line width must be a positive finite number.');
  }
  if (!Number.isInteger(options.interfaceLayers) || options.interfaceLayers < 0 || options.interfaceLayers > 10) {
    throw new RangeError('Support interface layers must be an integer from 0 to 10.');
  }
  if (
    options.xyDistance !== undefined &&
    (!Number.isFinite(options.xyDistance) || options.xyDistance < 0)
  ) {
    throw new RangeError('Support XY distance must be a non-negative finite number.');
  }
}

/**
 * Projects unsupported overhang regions vertically down to the build plate or
 * to the part below. The top support layer stays at least `contactDistance`
 * below the overhang; a column that lands on the part stops there and leaves
 * the same gap above the part's surface.
 *
 * Works top-down in one pass: each layer's support is the column carried from
 * above, plus overhangs whose contact gap begins on this layer, minus the part.
 */
export function generateGridSupportRegions(
  layers: readonly SupportLayerInput[],
  options: GridSupportOptions,
): GridSupportPlan {
  validateOptions(options);
  const xyDistance = options.xyDistance ?? DEFAULT_XY_DISTANCE;
  const regions = layers.map((layer) => normalizeSurfaceRegion(layer.region));
  // PrusaSlicer tests against threshold + 1 degree, so a wall exactly at the
  // threshold is still treated as self-supporting.
  const tangent = Math.tan(((options.thresholdAngleDegrees + 1) * Math.PI) / 180);

  // Overhangs, keyed by the highest layer that may carry their support.
  const seeds = layers.map((): ContourLoop[][] => []);
  for (let overhangIndex = 1; overhangIndex < layers.length; overhangIndex++) {
    const overhang = layers[overhangIndex];
    const allowedStep = overhang.height / tangent;
    const supportedArea = expandContours(regions[overhangIndex - 1], allowedStep);
    const unsupported = openContours(
      subtractSurfaceRegions(regions[overhangIndex], supportedArea),
      options.lineWidth,
    );
    if (!unsupported.length) continue;
    let target = overhangIndex - 1;
    while (target >= 0 && overhang.bottom - layers[target].printZ + EPSILON < options.contactDistance) {
      target--;
    }
    if (target >= 0) seeds[target].push(unsupported);
  }

  const body = layers.map((): ContourLoop[] => []);
  const supportInterface = layers.map((): ContourLoop[] => []);
  let column: ContourLoop[] = [];
  // The most recent seeds, newest first, each still shrinking as the part blocks it.
  let recentSeeds: ContourLoop[][] = [];

  for (let index = layers.length - 1; index >= 0; index--) {
    const seed = seeds[index].length ? unionSurfaceRegions(...seeds[index]) : [];
    if (!seed.length && !column.length) {
      recentSeeds = [];
      continue;
    }
    column = subtractSurfaceRegions(unionSurfaceRegions(column, seed), regions[index]);
    recentSeeds = [seed, ...recentSeeds]
      .slice(0, options.interfaceLayers)
      .map((region) => (region.length ? subtractSurfaceRegions(region, regions[index]) : region));
    if (!column.length) continue;

    // Keep clear of the part on this layer, and of the part's top surface just
    // below so a column landing on the model leaves the same contact gap.
    const keepOutParts: ContourLoop[][] = [
      regions[index].length && xyDistance > 0 ? expandContours(regions[index], xyDistance) : regions[index],
    ];
    for (let below = index - 1; below >= 0; below--) {
      if (layers[index].bottom - layers[below].printZ + EPSILON >= options.contactDistance) break;
      keepOutParts.push(regions[below]);
    }
    const keepOut = unionSurfaceRegions(...keepOutParts);
    const free = keepOut.length ? subtractSurfaceRegions(column, keepOut) : column;
    if (!free.length) continue;

    const contact = unionSurfaceRegions(...recentSeeds);
    const interfaceArea = contact.length ? intersectSurfaceRegions(free, contact) : [];
    supportInterface[index] = interfaceArea;
    body[index] = interfaceArea.length ? subtractSurfaceRegions(free, interfaceArea) : free;
  }

  return { body, interface: supportInterface };
}
