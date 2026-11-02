/**
 * Turns a closed mesh into ordered toolpaths, layer by layer, in plate
 * millimetres. This is the geometry half of the slicer; `gcode.ts` turns the
 * result into machine moves.
 *
 * Pipeline per layer, following PrusaSlicer/Bambu Studio's order:
 * slice → walls (classic, fixed width) → classify top/bottom/solid/sparse →
 * bridges → supports → skirt/brim → order paths to keep travel short.
 *
 * Coordinates: the input mesh is already on the plate. Each vertex is
 * `(plateX, heightAboveBed, plateY)` — height in the second slot because the
 * slicer cuts along that axis — and the result uses plate X/Y, so
 * `ContourPoint.x` is plate X and `ContourPoint.z` is plate Y.
 *
 * Everything that controls the printer — widths, speeds, shells, gaps — comes
 * from `PrintSettings`, which is built from Bambu's own profiles.
 */
import { generateLayerPlan, sliceContours, type ContourLoop, type ContourPoint } from './slicing';
import { generateInfillPaths } from './infill';
import {
  expandContours,
  expandOuterContours,
  generateClassicWalls,
  insetContours,
  openContours,
  wallPathArea,
} from './walls';
import {
  classifyLayerSurfaces,
  intersectSurfaceRegions,
  subtractSurfaceRegions,
  unionSurfaceRegions,
} from './surfaces';
import { generateGridSupportRegions } from './supports';
import { BRIDGE_ANCHOR_MM, bridgeFallbackAngle, bridgeLineSpacing, planBridgeOverInfill } from './bridges';
import type { TriangleSource } from '@/viewer/triangles';
import type { PrintSettings } from './bambu/settings';

export type Feature =
  | 'Skirt'
  | 'Brim'
  | 'Support'
  | 'Support interface'
  | 'Inner wall'
  | 'Outer wall'
  | 'Bridge'
  | 'Bottom surface'
  | 'Internal solid infill'
  | 'Sparse infill'
  | 'Top surface';

/** Print order within a layer: adhesion, supports, walls inside-out, then fill, top last. */
export const FEATURE_ORDER: readonly Feature[] = [
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Inner wall',
  'Outer wall',
  'Bridge',
  'Bottom surface',
  'Internal solid infill',
  'Sparse infill',
  'Top surface',
];

export interface PlatePoint {
  x: number;
  y: number;
}

export interface Toolpath {
  feature: Feature;
  points: PlatePoint[];
  /** Closed loops repeat their first point at the end. */
  closed: boolean;
  /** Extrusion width in mm; bridges print a round thread of nozzle diameter. */
  width: number;
  /** Feed rate before cooling slowdown, in mm/s. */
  speed: number;
  acceleration: number;
}

export interface ToolpathLayer {
  index: number;
  /** Nozzle height for this layer (its top), in mm. */
  z: number;
  height: number;
  paths: Toolpath[];
  /** The slice outline, for travel decisions and preview. */
  outline: ContourLoop[];
}

export interface ToolpathResult {
  layers: ToolpathLayer[];
  /** Bounding box of everything printed on the first layer. */
  firstLayerBounds: { min: PlatePoint; max: PlatePoint };
  maxZ: number;
}

/** Bead centre-to-centre spacing for a rounded-rectangle extrusion (Flow.cpp). */
export function extrusionSpacing(width: number, height: number): number {
  return width - height * (1 - Math.PI / 4);
}

const MIN_FINAL_LAYER_MM = 0.08;
const MAX_LAYERS = 2_500;

export class ToolpathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolpathError';
  }
}

function toPlate(points: readonly ContourPoint[]): PlatePoint[] {
  return points.map((point) => ({ x: point.x, y: point.z }));
}

/** Rotates a closed loop to start at its rearmost point, so seams line up on the back. */
function seamAligned(loop: readonly ContourPoint[]): PlatePoint[] {
  let start = 0;
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[start];
    if (a.z > b.z + 1e-9 || (Math.abs(a.z - b.z) <= 1e-9 && a.x < b.x)) start = i;
  }
  const rotated = [...loop.slice(start), ...loop.slice(0, start)].map((point) => ({ x: point.x, y: point.z }));
  rotated.push({ ...rotated[0] });
  return rotated;
}

/** Outer boundaries counter-clockwise, holes clockwise, seen from above. */
function wallLoop(loop: readonly ContourPoint[], isHole: boolean): ContourPoint[] {
  const counterClockwise = wallPathArea(loop) > 0;
  return counterClockwise === !isHole ? [...loop] : [...loop].reverse();
}

const distance = (a: PlatePoint, b: PlatePoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Bambu Studio's default G-code resolution: detail finer than this is noise. */
export const PATH_RESOLUTION_MM = 0.0125;

/**
 * Ramer–Douglas–Peucker simplification. Finely tessellated meshes slice into
 * thousands of sub-0.01 mm segments; written as G-code they flood the
 * printer's planner, and rounding to 0.001 mm makes their flow erratic.
 */
export function simplifyPath(points: readonly PlatePoint[], tolerance = PATH_RESOLUTION_MM): PlatePoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const d = length < 1e-12 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / length;
      if (d > farthestDistance) {
        farthest = i;
        farthestDistance = d;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Greedy nearest-neighbour ordering. Open paths may be reversed unless the
 * pattern depends on direction (monotonic surfaces, bridges); closed loops
 * keep their aligned seam.
 */
export function orderPaths(paths: Toolpath[], start: PlatePoint, allowReverse: boolean): Toolpath[] {
  const remaining = [...paths];
  const ordered: Toolpath[] = [];
  let position = start;
  while (remaining.length) {
    let best = 0;
    let bestDistance = Infinity;
    let reverse = false;
    for (let i = 0; i < remaining.length; i++) {
      const path = remaining[i];
      const toStart = distance(position, path.points[0]);
      if (toStart < bestDistance) {
        best = i;
        bestDistance = toStart;
        reverse = false;
      }
      if (allowReverse && !path.closed) {
        const toEnd = distance(position, path.points[path.points.length - 1]);
        if (toEnd < bestDistance) {
          best = i;
          bestDistance = toEnd;
          reverse = true;
        }
      }
    }
    const [chosen] = remaining.splice(best, 1);
    const path = reverse ? { ...chosen, points: [...chosen.points].reverse() } : chosen;
    ordered.push(path);
    position = path.points[path.points.length - 1];
  }
  return ordered;
}

/** Regions of `region` within `area`, or nothing if either is empty. */
function clipTo(region: readonly ContourLoop[], area: readonly ContourLoop[]): ContourLoop[] {
  return region.length && area.length ? intersectSurfaceRegions(region, area) : [];
}

/** Slices a closed mesh that sits on the plate into ordered toolpaths. */
export function generateToolpaths(source: TriangleSource, objectHeight: number, settings: PrintSettings): ToolpathResult {
  if (!(objectHeight > 0) || !Number.isFinite(objectHeight)) throw new ToolpathError('The model has no height to slice.');
  if (objectHeight > settings.machine.maxHeight) {
    throw new ToolpathError(`The model is ${objectHeight.toFixed(1)} mm tall; the P1S prints up to ${settings.machine.maxHeight} mm.`);
  }

  let plan = generateLayerPlan(objectHeight, {
    layerHeight: settings.layerHeight,
    firstLayerHeight: settings.firstLayerHeight,
  });
  // A sliver of a final layer would drag the nozzle across the top without
  // extruding; leave it off. The part comes out at most 0.08 mm shorter.
  if (plan.length > 1 && plan[plan.length - 1].height < MIN_FINAL_LAYER_MM) plan = plan.slice(0, -1);
  if (plan.length > MAX_LAYERS) throw new ToolpathError(`The model needs more than ${MAX_LAYERS} layers.`);

  const tolerance = 1e-6;
  const regions = plan.map((layer, index) => {
    // Simplify outlines to the G-code resolution before any polygon maths:
    // a finely tessellated part otherwise drags thousands of redundant
    // vertices through every offset and boolean on every layer.
    const outline = sliceContours(source, layer.sliceZ, tolerance)
      .map((loop) => {
        const closed = toPlate([...loop, loop[0]]);
        return simplifyPath(closed).slice(0, -1).map((point) => ({ x: point.x, z: point.y }));
      })
      .filter((loop) => loop.length >= 3);
    // Elephant-foot compensation: the first layer is squashed wider, so its
    // outline is drawn in slightly (Bambu's `elefant_foot_compensation`).
    return index === 0 && settings.elephantFootCompensation > 0
      ? insetContours(outline, settings.elephantFootCompensation)
      : outline;
  });
  if (!regions[0].length) {
    throw new ToolpathError('Nothing touches the plate on the first layer. Lay the model flat on the plate.');
  }

  const surfaces = classifyLayerSurfaces(
    regions.map((region) => ({ region })),
    { topSolidLayers: settings.topShellLayers, bottomSolidLayers: settings.bottomShellLayers },
  );
  const supportPlan = settings.support.enabled
    ? generateGridSupportRegions(
        plan.map((layer, index) => ({ region: regions[index], bottom: layer.bottom, printZ: layer.printZ, height: layer.height })),
        {
          thresholdAngleDegrees: settings.support.thresholdAngle,
          contactDistance: settings.support.topZDistance,
          lineWidth: settings.widths.support,
          interfaceLayers: settings.support.interfaceLayers,
          xyDistance: settings.support.xyDistance,
        },
      )
    : { body: plan.map((): ContourLoop[] => []), interface: plan.map((): ContourLoop[] => []) };

  // Infill area per layer: inside the innermost wall, overlapping it by
  // `infill_wall_overlap` of the infill width so fill bonds to the walls.
  const infillAreas = plan.map((layer, index) => {
    const first = index === 0;
    const outer = first ? settings.widths.firstLayer : settings.widths.outer;
    const inner = first ? settings.widths.firstLayer : settings.widths.inner;
    const innerSpacing = extrusionSpacing(inner, layer.height);
    const lastWallCentre = outer / 2 + (settings.wallLoops - 1) * innerSpacing;
    const inset = lastWallCentre + inner / 2 - settings.infillWallOverlap * inner;
    return insetContours(regions[index], inset);
  });

  const layers: ToolpathLayer[] = plan.map((layer, index) => {
    const first = index === 0;
    const h = layer.height;
    const w = settings.widths;
    const s = settings.speeds;
    const accel = settings.accelerations;
    const wallSpeed = (normal: number) => (first ? s.firstLayer : normal);
    const fillSpeed = (normal: number) => (first ? s.firstLayerInfill : normal);
    const fillAccel = (normal: number) => (first ? accel.firstLayer : normal);
    const width = (normal: number) => (first ? w.firstLayer : normal);
    const classified = surfaces[index];
    const infillArea = infillAreas[index];
    const clip = (region: readonly ContourLoop[]) => clipTo(region, infillArea);
    const paths: Toolpath[] = [];
    const add = (feature: Feature, loops: PlatePoint[][], closed: boolean, pathWidth: number, speed: number, acceleration: number) => {
      for (const raw of loops) {
        const points = simplifyPath(raw);
        if (points.length >= 2) paths.push({ feature, points, closed, width: pathWidth, speed, acceleration });
      }
    };
    const lines = (segments: readonly (readonly ContourPoint[])[]) => segments.map(toPlate);

    // Walls, inside-out: outer wall last so it is laid against the inner walls.
    const outerWidth = width(w.outer);
    const innerWidth = width(w.inner);
    const walls = generateClassicWalls(regions[index], {
      wallCount: settings.wallLoops,
      externalWidth: outerWidth,
      spacing: extrusionSpacing(innerWidth, h),
    });
    walls.forEach((wall, wallIndex) => {
      const loops = wall.map((loop) => {
        const isHole = wallPathArea(loop) < 0;
        return seamAligned(wallLoop(loop, isHole));
      });
      add(
        wallIndex === 0 ? 'Outer wall' : 'Inner wall',
        loops,
        true,
        wallIndex === 0 ? outerWidth : innerWidth,
        wallSpeed(wallIndex === 0 ? s.outer : s.inner),
        first ? accel.firstLayer : wallIndex === 0 ? accel.outer : accel.normal,
      );
    });

    // Bridges over sparse infill (first top-shell layer) and under overhangs.
    const bridgeOverInfill = first
      ? { region: [] as ContourLoop[], paths: [] as [ContourPoint, ContourPoint][] }
      : planBridgeOverInfill(classified.topShell, surfaces[index - 1].internal, {
          lineWidthMm: w.sparse,
          bridgeLineWidthMm: settings.machine.nozzleDiameter,
          worldPerMm: 1,
          // At 0 % the top skin spans a hollow interior, so it is bridged too;
          // a near-zero density leaves no sparse lines and the planner falls
          // back to the region's shorter axis for direction.
          density: settings.infillDensity > 0 ? settings.infillDensity : 0.01,
          layerIndex: index,
          boundary: infillArea,
          previousSparseArea: clipTo(surfaces[index - 1].internal, infillAreas[index - 1]),
        });
    const supportWindow = Math.max(0, index - settings.support.interfaceLayers - 2);
    const supportBelow = unionSurfaceRegions(
      ...supportPlan.body.slice(supportWindow, index),
      ...supportPlan.interface.slice(supportWindow, index),
    );
    const exposedBottom = first
      ? []
      : openContours(
          supportBelow.length ? subtractSurfaceRegions(classified.bottom, supportBelow) : classified.bottom,
          w.solid,
        );
    const undersideBridge = exposedBottom.length ? clip(expandContours(exposedBottom, BRIDGE_ANCHOR_MM)) : [];
    const bridgeRegion = unionSurfaceRegions(undersideBridge, bridgeOverInfill.region);
    const withoutBridges = (region: readonly ContourLoop[]) => {
      const clipped = clip(region);
      return clipped.length && bridgeRegion.length ? subtractSurfaceRegions(clipped, bridgeRegion) : clipped;
    };
    const bridgeSpacing = bridgeLineSpacing(settings.machine.nozzleDiameter);
    add(
      'Bridge',
      [
        ...lines(generateInfillPaths(undersideBridge, {
          pattern: 'monotonic',
          lineSpacing: bridgeSpacing,
          angleDegrees: bridgeFallbackAngle(exposedBottom),
          layerIndex: index,
        })),
        ...lines(bridgeOverInfill.paths),
      ],
      false,
      settings.machine.nozzleDiameter,
      s.bridge,
      accel.normal,
    );

    // Fill roles partition the infill area so they neither overlap nor gap.
    const topRegion = withoutBridges(classified.top);
    const bottomRegion = withoutBridges(subtractSurfaceRegions(classified.bottom, classified.top));
    const solidRegion = withoutBridges(
      subtractSurfaceRegions(classified.solid, unionSurfaceRegions(classified.top, classified.bottom)),
    );
    // With 0 % infill the interior stays hollow; at 100 % it is all solid.
    const sparseSource = withoutBridges(classified.internal);
    const solidWidth = width(w.solid);
    const solidSpacing = extrusionSpacing(solidWidth, h);
    const angle = settings.infillAngle;
    add(
      'Bottom surface',
      lines(generateInfillPaths(bottomRegion, { pattern: 'monotonic', lineSpacing: solidSpacing, angleDegrees: angle, layerIndex: index })),
      false,
      solidWidth,
      fillSpeed(s.solid),
      fillAccel(accel.normal),
    );
    const solidPaths = generateInfillPaths(
      settings.infillDensity >= 1 ? unionSurfaceRegions(solidRegion, sparseSource) : solidRegion,
      { pattern: 'rectilinear', lineSpacing: solidSpacing, angleDegrees: angle, layerIndex: index },
    );
    add('Internal solid infill', lines(solidPaths), false, solidWidth, fillSpeed(s.solid), fillAccel(accel.normal));
    if (settings.infillDensity > 0 && settings.infillDensity < 1) {
      const sparseWidth = width(w.sparse);
      add(
        'Sparse infill',
        lines(generateInfillPaths(sparseSource, {
          pattern: 'grid',
          lineSpacing: extrusionSpacing(sparseWidth, h) / settings.infillDensity,
          angleDegrees: angle,
          layerIndex: index,
        })),
        false,
        sparseWidth,
        fillSpeed(s.sparse),
        fillAccel(accel.normal),
      );
    }
    const topWidth = width(w.top);
    add(
      'Top surface',
      lines(generateInfillPaths(topRegion, {
        pattern: 'monotonic',
        lineSpacing: extrusionSpacing(topWidth, h),
        angleDegrees: angle,
        layerIndex: index,
      })),
      false,
      topWidth,
      fillSpeed(s.top),
      first ? accel.firstLayer : accel.top,
    );

    // Supports: grid body and dense interface under the contact gap.
    const supportWidth = width(w.support);
    add(
      'Support',
      lines(generateInfillPaths(supportPlan.body[index], {
        pattern: 'grid',
        lineSpacing: supportWidth + settings.support.baseSpacing,
        angleDegrees: 0,
        layerIndex: index,
      })),
      false,
      supportWidth,
      wallSpeed(s.support),
      fillAccel(accel.normal),
    );
    add(
      'Support interface',
      lines(generateInfillPaths(supportPlan.interface[index], {
        pattern: 'rectilinear',
        lineSpacing: supportWidth + settings.support.interfaceSpacing,
        angleDegrees: 0,
        layerIndex: index,
      })),
      false,
      supportWidth,
      wallSpeed(s.support),
      fillAccel(accel.normal),
    );

    // First-layer adhesion. The skirt surrounds supports as well as parts.
    if (first && settings.adhesion.type === 'skirt') {
      const footprint = unionSurfaceRegions(regions[0], supportPlan.body[0], supportPlan.interface[0]);
      const spacing = extrusionSpacing(w.firstLayer, h);
      for (let loop = 0; loop < settings.adhesion.skirtLoops; loop++) {
        const offset = settings.adhesion.skirtDistance + w.firstLayer / 2 + loop * spacing;
        add('Skirt', expandOuterContours(footprint, offset).map((ring) => seamAligned(wallLoop(ring, false))), true, w.firstLayer, s.firstLayer, accel.firstLayer);
      }
    }
    if (first && settings.adhesion.type === 'brim' && settings.adhesion.brimWidth > 0) {
      const spacing = extrusionSpacing(w.firstLayer, h);
      const loops = Math.max(1, Math.floor(settings.adhesion.brimWidth / spacing));
      const rings: PlatePoint[][] = [];
      for (let loop = 0; loop < loops; loop++) {
        const offset = settings.adhesion.brimGap + w.firstLayer / 2 + loop * spacing;
        for (const ring of expandOuterContours(regions[0], offset)) rings.push(seamAligned(wallLoop(ring, false)));
      }
      add('Brim', rings, true, w.firstLayer, s.firstLayer, accel.firstLayer);
    }

    return { index, z: layer.printZ, height: h, paths, outline: regions[index] };
  });

  // Order each layer's paths by feature, then nearest-neighbour within it.
  let position: PlatePoint = { x: 0, y: 0 };
  for (const layer of layers) {
    const ordered: Toolpath[] = [];
    for (const feature of FEATURE_ORDER) {
      const group = layer.paths.filter((path) => path.feature === feature);
      if (!group.length) continue;
      const directional = feature === 'Top surface' || feature === 'Bottom surface' || feature === 'Bridge';
      const next = orderPaths(group, position, !directional);
      for (const path of next) ordered.push(path);
      position = next[next.length - 1].points[next[next.length - 1].points.length - 1];
    }
    layer.paths = ordered;
  }

  const firstLayerBounds = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  for (const path of layers[0].paths) {
    for (const point of path.points) {
      firstLayerBounds.min.x = Math.min(firstLayerBounds.min.x, point.x);
      firstLayerBounds.min.y = Math.min(firstLayerBounds.min.y, point.y);
      firstLayerBounds.max.x = Math.max(firstLayerBounds.max.x, point.x);
      firstLayerBounds.max.y = Math.max(firstLayerBounds.max.y, point.y);
    }
  }
  if (!Number.isFinite(firstLayerBounds.min.x)) throw new ToolpathError('The first layer produced no toolpaths.');
  return { layers, firstLayerBounds, maxZ: layers[layers.length - 1].z };
}
