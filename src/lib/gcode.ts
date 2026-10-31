/**
 * Writes Bambu Lab P1S G-code from ordered toolpaths.
 *
 * The machine-specific parts — heating, nozzle wipe, Z homing, bed levelling,
 * purge line, park and cool-down — are Bambu's own templates from the fetched
 * profile, rendered by the fail-closed evaluator in `bambu/template.ts`. This
 * module only writes what sits between them: layer changes, travel with
 * retraction and Z-hop, extrusion and fan, in the form Bambu Studio writes
 * them (relative extrusion, `; CHANGE_LAYER`, `; FEATURE:`, `M73`, a
 * `HEADER_BLOCK` the printer reads for time and filament).
 *
 * Maths, from PrusaSlicer/Bambu Studio's Flow.cpp and CoolingBuffer.cpp:
 * - bead area = h × (w − h × (1 − π/4)); bridges are a round thread, π d² / 4;
 * - E per mm = flow ratio × bead area ÷ filament cross-section;
 * - feed rate = min(role speed, max volumetric speed ÷ bead area, machine max);
 * - a layer faster than `slow_down_layer_time` is slowed to meet it, never
 *   below `slow_down_min_speed`; fan runs at max below that time, at min above
 *   `fan_cooling_layer_time`, interpolated between, and off for the first
 *   `close_fan_the_first_x_layers` layers.
 */
import type { ContourLoop } from './slicing';
import type { PlatePoint, Toolpath, ToolpathResult } from './toolpath';
import type { PrintSettings } from './bambu/settings';
import { layerTemplateContext } from './bambu/settings';
import { renderTemplate, type TemplateContext } from './bambu/template';

export interface MachineTemplates {
  start: string;
  end: string;
  layerChange: string;
  timelapse: string;
  filamentStart: string;
  filamentEnd: string;
}

export interface PrintGcodeInput {
  toolpaths: ToolpathResult;
  settings: PrintSettings;
  templates: MachineTemplates;
  /** Variables for the start/end templates (`startEndTemplateContext`). */
  context: TemplateContext;
  /** Shown in the header, e.g. "Caliper 2.1.0". */
  generator: string;
  /** Profile source, e.g. the pinned Bambu Studio tag. */
  profileSource: string;
}

export interface PrintStats {
  layers: number;
  printSeconds: number;
  filamentMm: number;
  filamentCm3: number;
  filamentGrams: number;
  cost: number;
  maxZ: number;
  /** Estimated time of the first layer, in seconds. */
  firstLayerSeconds: number;
}

export interface PrintGcode {
  text: string;
  stats: PrintStats;
  /** The rendered machine start and end blocks, so pre-flight can find them verbatim. */
  startBlock: string;
  endBlock: string;
}

export const START_MARK = '; MACHINE_START_GCODE_START';
export const START_END_MARK = '; MACHINE_START_GCODE_END';
export const END_MARK = '; MACHINE_END_GCODE_START';
export const END_END_MARK = '; MACHINE_END_GCODE_END';

export class GcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GcodeError';
  }
}

/** Rounded-rectangle bead area in mm² (Flow.cpp `mm3_per_mm`). */
export function beadArea(width: number, height: number): number {
  return height * (width - height * (1 - Math.PI / 4));
}

/** Round bridge thread area in mm². */
export function bridgeArea(diameter: number): number {
  return (Math.PI * diameter ** 2) / 4;
}

function pathArea(path: Toolpath, height: number): number {
  return path.feature === 'Bridge' ? bridgeArea(path.width) : beadArea(path.width, height);
}

/** Time for a move from rest to rest with a trapezoidal speed profile. */
export function moveSeconds(length: number, speed: number, acceleration: number): number {
  if (length <= 0) return 0;
  if (!(acceleration > 0)) return length / speed;
  return length < (speed * speed) / acceleration ? 2 * Math.sqrt(length / acceleration) : length / speed + speed / acceleration;
}

/** Fan percentage for a layer, per Bambu's CoolingBuffer rules. */
export function layerFanPercent(layerSeconds: number, layerIndex: number, settings: PrintSettings): number {
  const f = settings.filament;
  if (layerIndex < f.fanOffFirstLayers) return 0;
  if (layerSeconds <= f.slowDownLayerTime) return f.fanMaxPercent;
  if (layerSeconds >= f.fanCoolingLayerTime) return f.fanMinPercent;
  const t = (layerSeconds - f.slowDownLayerTime) / (f.fanCoolingLayerTime - f.slowDownLayerTime);
  return f.fanMaxPercent + t * (f.fanMinPercent - f.fanMaxPercent);
}

const fanValue = (percent: number) => Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);

function num(value: number, places = 3): string {
  if (!Number.isFinite(value)) throw new GcodeError('A non-finite coordinate reached the G-code writer.');
  const fixed = value.toFixed(places).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return fixed === '-0' ? '0' : fixed;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

/** True if a travel from `a` to `b` crosses any edge of the layer outline. */
export function crossesOutline(a: PlatePoint, b: PlatePoint, outline: readonly ContourLoop[]): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const loop of outline) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      if (Math.max(p.x, q.x) < minX || Math.min(p.x, q.x) > maxX || Math.max(p.z, q.z) < minY || Math.min(p.z, q.z) > maxY) {
        continue;
      }
      const d1 = (q.x - p.x) * (a.y - p.z) - (q.z - p.z) * (a.x - p.x);
      const d2 = (q.x - p.x) * (b.y - p.z) - (q.z - p.z) * (b.x - p.x);
      const d3 = (b.x - a.x) * (p.z - a.y) - (b.y - a.y) * (p.x - a.x);
      const d4 = (b.x - a.x) * (q.z - a.y) - (b.y - a.y) * (q.x - a.x);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return false;
}

export function writePrintGcode(input: PrintGcodeInput): PrintGcode {
  const { toolpaths, settings, templates, context } = input;
  const { machine, filament } = settings;
  if (!toolpaths.layers.length) throw new GcodeError('There are no layers to print.');

  const filamentArea = Math.PI * (filament.diameter / 2) ** 2;
  const ePerMm = (path: Toolpath, height: number) => (filament.flowRatio * pathArea(path, height)) / filamentArea;
  const cappedSpeed = (path: Toolpath, height: number) =>
    Math.min(path.speed, filament.maxVolumetricSpeed / pathArea(path, height), machine.maxSpeedXY);
  const travelAcceleration = Math.min(settings.accelerations.travel, machine.maxAccelerationTravel);
  const travelSpeed = Math.min(settings.speeds.travel, machine.maxSpeedXY);

  // Per-layer timing before cooling, to choose slowdown and fan.
  const layerTimes = toolpaths.layers.map((layer, layerIndex) => {
    let print = 0;
    let travel = 0;
    let position: PlatePoint | null = layerIndex === 0 ? null : toolpaths.layers[layerIndex - 1].paths.at(-1)?.points.at(-1) ?? null;
    for (const path of layer.paths) {
      if (position) travel += moveSeconds(Math.hypot(path.points[0].x - position.x, path.points[0].y - position.y), travelSpeed, travelAcceleration);
      const speed = cappedSpeed(path, layer.height);
      for (let i = 1; i < path.points.length; i++) {
        const length = Math.hypot(path.points[i].x - path.points[i - 1].x, path.points[i].y - path.points[i - 1].y);
        print += moveSeconds(length, speed, Math.min(path.acceleration, machine.maxAccelerationExtruding));
      }
      position = path.points[path.points.length - 1];
    }
    return { print, travel };
  });
  const cooling = layerTimes.map(({ print, travel }, layerIndex) => {
    const total = print + travel;
    // Factor by which extrusion time must grow so the layer meets the minimum time.
    const stretch = total < filament.slowDownLayerTime && print > 0 ? (filament.slowDownLayerTime - travel) / print : 1;
    return { stretch: Math.max(1, stretch), fan: layerFanPercent(total, layerIndex, settings) };
  });
  const slowed = (speed: number, stretch: number) =>
    stretch <= 1 ? speed : Math.min(speed, Math.max(filament.slowDownMinSpeed, speed / stretch));

  const out: string[] = [];
  const body: string[] = [];
  let x: number | null = null;
  let y: number | null = null;
  let z = 0;
  let retracted = false;
  let acceleration = 0;
  let fan = 0;
  let filamentMm = 0;
  let printSeconds = 0;
  let firstLayerSeconds = 0;

  const setAcceleration = (value: number) => {
    const next = Math.round(Math.min(value, machine.maxAccelerationExtruding));
    if (next !== acceleration) {
      body.push(`M204 S${next}`);
      acceleration = next;
    }
  };
  const setFan = (percent: number) => {
    const value = fanValue(percent);
    if (value !== fan) {
      body.push(`M106 S${value}`);
      fan = value;
    }
  };
  const retract = () => {
    if (retracted || machine.retractionLength <= 0) return;
    body.push(`G1 E-${num(machine.retractionLength, 5)} F${num(machine.retractionSpeed * 60, 0)}`);
    printSeconds += machine.retractionLength / machine.retractionSpeed;
    retracted = true;
  };
  const unretract = () => {
    if (!retracted) return;
    body.push(`G1 E${num(machine.retractionLength, 5)} F${num(machine.deretractionSpeed * 60, 0)}`);
    printSeconds += machine.retractionLength / machine.deretractionSpeed;
    retracted = false;
  };
  const moveZ = (target: number) => {
    if (Math.abs(target - z) < 1e-9) return;
    body.push(`G1 Z${num(target)} F${num(machine.maxSpeedZ * 60, 0)}`);
    printSeconds += Math.abs(target - z) / machine.maxSpeedZ;
    z = target;
  };
  /** Travel to `to` at layer height `layerZ`; retract and lift unless the move stays inside the part. */
  const travelTo = (to: PlatePoint, layerZ: number, outline: readonly ContourLoop[], force: boolean) => {
    const from = x === null || y === null ? null : { x, y };
    const length = from ? Math.hypot(to.x - from.x, to.y - from.y) : Infinity;
    if (length < 1e-6 && Math.abs(z - layerZ) < 1e-9) return;
    const longTravel = length > machine.retractionMinimumTravel;
    const needsRetract = force || !from || (longTravel && crossesOutline(from, to, outline));
    if (needsRetract) {
      retract();
      const hop = machine.zHop > 0 && layerZ < machine.zHopBelow ? machine.zHop : 0;
      moveZ(Math.max(z, layerZ + hop));
    }
    setAcceleration(travelAcceleration);
    body.push(`G1 X${num(to.x)} Y${num(to.y)} F${num(travelSpeed * 60, 0)}`);
    if (from) printSeconds += moveSeconds(length, travelSpeed, travelAcceleration);
    x = Number(num(to.x));
    y = Number(num(to.y));
    moveZ(layerZ);
    unretract();
  };

  const layerCount = toolpaths.layers.length;
  const auxiliaryFan = machine.auxiliaryFan && filament.auxiliaryFanPercent > 0;
  let auxiliaryOn = false;
  const estimatedTotal = layerTimes.reduce((sum, t, i) => sum + t.print * cooling[i].stretch + t.travel, 0);

  toolpaths.layers.forEach((layer, layerIndex) => {
    const { stretch, fan: layerFan } = cooling[layerIndex];
    body.push(
      '; CHANGE_LAYER',
      `; Z_HEIGHT: ${num(layer.z)}`,
      `; LAYER_HEIGHT: ${num(layer.height)}`,
    );
    if (machine.retractOnLayerChange) retract();
    const layerContext = layerTemplateContext(context, layerIndex, layer.z);
    body.push(renderTemplate(templates.layerChange, layerContext).trimEnd());
    body.push(renderTemplate(templates.timelapse, layerContext).trimEnd());
    setFan(layerFan);
    if (auxiliaryFan && !auxiliaryOn && layerIndex >= filament.fanOffFirstLayers) {
      body.push(`M106 P2 S${fanValue(filament.auxiliaryFanPercent)}`);
      auxiliaryOn = true;
    }

    let feature = '';
    let firstInLayer = true;
    for (const path of layer.paths) {
      if (path.points.length < 2) continue;
      if (path.feature !== feature) {
        if (feature === 'Bridge') setFan(layerFan);
        body.push(`; FEATURE: ${path.feature}`, `; LINE_WIDTH: ${num(path.width)}`);
        if (path.feature === 'Bridge' && layerIndex >= filament.fanOffFirstLayers) {
          setFan(Math.max(layerFan, filament.overhangFanPercent));
        }
        feature = path.feature;
      }
      // The first move of a layer always lifts: the nozzle is still at the
      // previous layer's height, over freshly printed plastic.
      travelTo(path.points[0], layer.z, layer.outline, firstInLayer);
      firstInLayer = false;
      setAcceleration(path.acceleration);
      const speed = slowed(cappedSpeed(path, layer.height), stretch);
      const perMm = ePerMm(path, layer.height);
      let lastFeed = -1;
      for (let i = 1; i < path.points.length; i++) {
        // E is computed from the coordinates exactly as written (0.001 mm), so
        // rounding can never make a short segment's flow spike.
        const px = Number(num(path.points[i].x));
        const py = Number(num(path.points[i].y));
        const length = Math.hypot(px - x!, py - y!);
        if (length < 0.005) continue;
        const e = Number(num(perMm * length, 5));
        if (e <= 0) continue;
        const feed = Math.round(speed * 60);
        body.push(`G1 X${num(px)} Y${num(py)} E${num(e, 5)}${feed !== lastFeed ? ` F${feed}` : ''}`);
        lastFeed = feed;
        filamentMm += e;
        printSeconds += moveSeconds(length, speed, Math.min(path.acceleration, machine.maxAccelerationExtruding));
        x = px;
        y = py;
      }
    }
    if (feature === 'Bridge') setFan(layerFan);
    if (layerIndex === 0) firstLayerSeconds = printSeconds;
    const percent = Math.min(99, Math.floor(((layerIndex + 1) / layerCount) * 100));
    const remaining = Math.max(0, Math.ceil((estimatedTotal - printSeconds) / 60));
    body.push(`M73 P${percent} R${remaining}`);
  });

  const filamentCm3 = (filamentMm * filamentArea) / 1000;
  const filamentGrams = filamentCm3 * filament.density;
  const stats: PrintStats = {
    layers: layerCount,
    printSeconds,
    filamentMm,
    filamentCm3,
    filamentGrams,
    cost: (filamentGrams / 1000) * filament.costPerKg,
    maxZ: toolpaths.maxZ,
    firstLayerSeconds,
  };

  const startBlock = renderTemplate(templates.start, context).trimEnd();
  const endBlock = renderTemplate(templates.end, context).trimEnd();
  const filamentStart = renderTemplate(templates.filamentStart, context).trimEnd();
  const filamentEnd = renderTemplate(templates.filamentEnd, context).trimEnd();

  out.push(
    '; HEADER_BLOCK_START',
    `; ${input.generator} — Bambu Lab P1S profiles from ${input.profileSource}`,
    `; model printing time: ${formatDuration(printSeconds)}; total estimated time: ${formatDuration(printSeconds)}`,
    `; total layer number: ${layerCount}`,
    `; total filament length [mm] : ${num(filamentMm, 2)}`,
    `; total filament volume [cm^3] : ${num(filamentCm3, 2)}`,
    `; total filament weight [g] : ${num(filamentGrams, 2)}`,
    `; filament_density: ${num(filament.density, 2)}`,
    `; filament_diameter: ${num(filament.diameter, 2)}`,
    `; max_z_height: ${num(toolpaths.maxZ, 2)}`,
    '; filament: 1',
    '; HEADER_BLOCK_END',
    '',
    '; CONFIG_BLOCK_START',
    `; printer_settings_id = ${settings.names.machine}`,
    `; print_settings_id = ${settings.names.process}`,
    `; filament_settings_id = "${settings.names.filament}"`,
    `; curr_bed_type = ${settings.plateType}`,
    `; layer_height = ${num(settings.layerHeight)}`,
    `; initial_layer_print_height = ${num(settings.firstLayerHeight)}`,
    `; wall_loops = ${settings.wallLoops}`,
    `; sparse_infill_density = ${num(settings.infillDensity * 100, 0)}%`,
    `; enable_support = ${settings.support.enabled ? 1 : 0}`,
    `; nozzle_temperature = ${filament.nozzleTemperature}`,
    `; bed_temperature = ${filament.bedTemperature}`,
    `; filament_type = ${filament.type}`,
    '; CONFIG_BLOCK_END',
    '',
    '; EXECUTABLE_BLOCK_START',
    `M73 P0 R${Math.ceil(estimatedTotal / 60)}`,
    // Firmware limits, written as Bambu Studio writes them for the P1S.
    `M201 X${num(machine.limits.accelerationX, 0)} Y${num(machine.limits.accelerationY, 0)} Z${num(machine.limits.accelerationZ, 0)} E${num(machine.limits.accelerationE, 0)}`,
    `M203 X${num(machine.maxSpeedXY, 0)} Y${num(machine.maxSpeedXY, 0)} Z${num(machine.maxSpeedZ, 0)} E${num(machine.limits.speedE, 0)}`,
    `M204 P${num(machine.maxAccelerationExtruding, 0)} R${num(machine.limits.accelerationRetracting, 0)} T${num(machine.maxAccelerationExtruding, 0)}`,
    `M205 X${machine.limits.jerkX.toFixed(2)} Y${machine.limits.jerkY.toFixed(2)} Z${machine.limits.jerkZ.toFixed(2)} E${machine.limits.jerkE.toFixed(2)}`,
    'M106 S0',
    'M106 P2 S0',
    '; FEATURE: Custom',
    START_MARK,
    startBlock,
    START_END_MARK,
    filamentStart,
    'G90',
    'G21',
    'M83 ; use relative distances for extrusion',
    'M981 S1 P20000 ;open spaghetti detector',
  );
  // The print body can run to millions of lines, so it is joined on its own:
  // spreading it into push() overflows the call stack on real models.
  const tail: string[] = [
    '; close powerlost recovery',
    'M1003 S0',
    'M106 S0',
    'M106 P2 S0',
    'M981 S0 P20000 ; close spaghetti detector',
    '; FEATURE: Custom',
    // Bambu's end sequence retracts, lifts and parks on its own.
    filamentEnd,
    END_MARK,
    endBlock,
    END_END_MARK,
    'M73 P100 R0',
    '; EXECUTABLE_BLOCK_END',
    '',
    `; filament used [mm] = ${num(filamentMm, 2)}`,
    `; filament used [cm3] = ${num(filamentCm3, 2)}`,
    `; filament used [g] = ${num(filamentGrams, 2)}`,
    `; total filament cost = ${num(stats.cost, 2)}`,
    `; estimated printing time (normal mode) = ${formatDuration(printSeconds)}`,
    '',
  ];
  const text = [out.join('\n'), body.join('\n'), tail.join('\n')].join('\n');
  return { text, stats, startBlock, endBlock };
}
