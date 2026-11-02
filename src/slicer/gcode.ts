import { toMm, type ExPoly, type Pt } from './clipper';
import { capSpeed, ePerMm3, lineArea } from './flow';
import type { CustomGcode, FilamentProfile, PrinterProfile, ProcessSettings } from './profiles';
import { ROLE_LABEL, type Extrusion, type LayerPlan, type Role } from './toolpaths';

/**
 * Turns planned layers into G-code text (docs/slicer-logic.md, sections 16–17).
 *
 * Relative extrusion (M83) throughout: every E is the filament for that move
 * alone, which is what both slicers write for modern printers and what makes a
 * single wrong move easy to spot. The file is bracketed with markers the
 * checker relies on: where the start sequence ends, where the end sequence
 * begins, and a footer with the totals, so a truncated or edited file is
 * detected rather than printed.
 */

export class SliceError extends Error {}

export interface GcodeMeta {
  generator: string;
  models: string[];
}

export interface GcodeResult {
  text: string;
  /** Sum of every E in the file, retractions included, mm. */
  netE: number;
  /** Filament pushed for extrusion only, mm. */
  filamentMm: number;
  layerCount: number;
}


export function fillTemplate(template: string, values: Record<string, string | number>, which: string): string {
  return template.replace(/\{([^{}]*)\}/g, (_, raw: string) => {
    const name = raw.trim();
    if (!(name in values)) throw new SliceError(`The ${which} sequence uses {${name}}, which Caliper does not fill in.`);
    return String(values[name]);
  });
}

/** Numbers without trailing zeros, at most `decimals` places. */
const num = (value: number, decimals: number) => {
  const text = value.toFixed(decimals);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};

/** Every edge of a layer's outlines, bucketed on a grid, for "does this travel leave the part?". */
class EdgeGrid {
  private readonly cell = 5000; // 5 mm in units
  private readonly cells = new Map<string, [Pt, Pt][]>();

  constructor(outlines: ExPoly[]) {
    for (const poly of outlines)
      for (const path of [poly.contour, ...poly.holes])
        for (let i = 0; i < path.length; i++) this.add(path[i], path[(i + 1) % path.length]);
  }

  private add(a: Pt, b: Pt) {
    for (const key of this.keys(a, b)) {
      const list = this.cells.get(key);
      if (list) list.push([a, b]);
      else this.cells.set(key, [[a, b]]);
    }
  }

  private keys(a: Pt, b: Pt): string[] {
    const x0 = Math.floor(Math.min(a.X, b.X) / this.cell);
    const x1 = Math.floor(Math.max(a.X, b.X) / this.cell);
    const y0 = Math.floor(Math.min(a.Y, b.Y) / this.cell);
    const y1 = Math.floor(Math.max(a.Y, b.Y) / this.cell);
    const out: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  }

  /** True when the straight line a→b crosses any outline edge. */
  crosses(a: Pt, b: Pt): boolean {
    const seen = new Set<[Pt, Pt]>();
    for (const key of this.keys(a, b)) {
      for (const edge of this.cells.get(key) ?? []) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        if (segmentsCross(a, b, edge[0], edge[1])) return true;
      }
    }
    return false;
  }
}

function segmentsCross(p: Pt, q: Pt, r: Pt, s: Pt): boolean {
  const d1 = cross(r, s, p);
  const d2 = cross(r, s, q);
  const d3 = cross(p, q, r);
  const d4 = cross(p, q, s);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
const cross = (a: Pt, b: Pt, c: Pt) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);

/** Print speed for a role on a layer, before cooling and the flow cap. */
function roleSpeed(role: Role, printer: PrinterProfile, first: boolean): number {
  const s = printer.speeds;
  if (first) return s.firstLayer;
  switch (role) {
    case 'outer-wall':
      return s.outerWall;
    case 'inner-wall':
      return s.innerWall;
    case 'sparse-infill':
      return s.sparseInfill;
    case 'solid-infill':
      return s.solidInfill;
    case 'top-surface':
      return s.topSurface;
    case 'bridge':
      return s.bridge;
    default:
      return s.firstLayer;
  }
}

const pathLength = (e: Extrusion) => {
  let total = 0;
  const pts = e.points;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].X - pts[i - 1].X, pts[i].Y - pts[i - 1].Y);
  if (e.closed && pts.length > 1)
    total += Math.hypot(pts[0].X - pts[pts.length - 1].X, pts[0].Y - pts[pts.length - 1].Y);
  return toMm(total);
};

/** Fan percentage for a layer: PrusaSlicer's cooling rule (docs, 17.4). */
export function fanFor(filament: FilamentProfile, layerIndex: number, layerTime: number): number {
  const { fan } = filament;
  if (layerIndex < fan.offLayers) return 0;
  let value = fan.alwaysOn ? fan.min : 0;
  if (layerTime < filament.slowdownLayerTime) value = fan.max;
  else if (layerTime < filament.fanBelowLayerTime) {
    const t = (layerTime - filament.slowdownLayerTime) / (filament.fanBelowLayerTime - filament.slowdownLayerTime);
    value = t * fan.min + (1 - t) * fan.max;
  }
  if (layerIndex + 1 < fan.fullAtLayer) {
    value *= (layerIndex + 1 - fan.offLayers) / Math.max(1, fan.fullAtLayer - fan.offLayers);
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * How much to slow a layer so it takes at least the minimum layer time, never
 * below the minimum print speed (docs, 17.4). Returns the factor for speeds.
 */
export function slowdownFactor(extrudeTime: number, otherTime: number, minLayerTime: number): number {
  if (extrudeTime <= 0 || extrudeTime + otherTime >= minLayerTime) return 1;
  const wanted = minLayerTime - otherTime;
  return Math.min(1, extrudeTime / wanted);
}

export function writeGcode(
  layers: LayerPlan[],
  printer: PrinterProfile,
  filament: FilamentProfile,
  process: ProcessSettings,
  custom: CustomGcode | null,
  meta: GcodeMeta,
): GcodeResult {
  const out: string[] = [];
  const emit = (line: string) => out.push(line);
  const eRate = ePerMm3(printer.filamentDiameter, filament.flowRatio);
  const maxFlow = Math.min(printer.hotendMaxFlow, filament.maxFlow);
  const retractF = printer.retract.speed * 60;
  const zF = Math.min(printer.maxSpeed.z, 10) * 60;

  let netE = 0;
  let filamentMm = 0;
  let x = NaN;
  let y = NaN;
  let z = NaN;
  let retracted = false;
  let lastType = '';
  let lastWidth = -1;
  let fan = -1;

  const topZ = layers.length ? layers[layers.length - 1].z : 0;
  const values: Record<string, string | number> = {
    printer: printer.label,
    first_bed_temp: filament.firstLayerBedTemp,
    first_nozzle_temp: filament.firstLayerNozzleTemp,
    bed_temp: filament.bedTemp,
    nozzle_temp: filament.nozzleTemp,
    nozzle_diameter: printer.nozzle,
    retract_length: num(printer.retract.length, 3),
    retract_speed: retractF,
    park_x: num(printer.limits.x[0] + 2, 2),
    park_y: num(printer.limits.y[1] - 2, 2),
    park_z: num(Math.min(topZ + 10, printer.limits.z[1]), 3),
    z_speed: zF,
    travel_speed: printer.speeds.travel * 60,
  };

  const start = printer.startMode === 'builtin' ? printer.startGcode : (custom?.start ?? '');
  const end = printer.startMode === 'builtin' ? printer.endGcode : custom?.end?.trim() ? custom.end : printer.endGcode;
  if (!start.trim()) throw new SliceError(`${printer.label} needs a start sequence. Add one under Custom G-code.`);

  /* --- header ---------------------------------------------------------- */
  emit(`; generated by ${meta.generator}`);
  emit('; EXPERIMENTAL slicer output. Run the checks in Caliper and watch the first layer.');
  emit('; caliper_format = 1');
  emit(`; caliper_printer = ${printer.id}`);
  emit(`; caliper_printer_label = ${printer.label}`);
  emit(`; caliper_nozzle_diameter = ${printer.nozzle}`);
  emit(`; caliper_filament_diameter = ${printer.filamentDiameter}`);
  emit(`; caliper_filament = ${filament.label}`);
  emit(`; caliper_filament_density = ${filament.density}`);
  emit(`; caliper_layer_height = ${process.layerHeight}`);
  emit(`; caliper_first_layer_height = ${process.firstLayerHeight}`);
  emit(`; caliper_layers = ${layers.length}`);
  emit(`; caliper_models = ${meta.models.join(', ').replace(/[\r\n]/g, ' ')}`);
  emit('');

  /* --- start ----------------------------------------------------------- */
  emit(';CALIPER_START_BEGIN');
  for (const line of fillTemplate(start, values, 'start').split(/\r?\n/)) emit(line);
  emit(';CALIPER_START_END');
  emit('M83 ; relative extrusion for everything that follows');
  emit('G90');

  const moveTo = (p: Pt, F: number) => {
    const px = toMm(p.X);
    const py = toMm(p.Y);
    emit(`G0 X${num(px, 3)} Y${num(py, 3)} F${Math.round(F)}`);
    x = px;
    y = py;
  };
  const setZ = (target: number) => {
    if (Math.abs(target - z) < 1e-6) return;
    emit(`G1 Z${num(target, 3)} F${zF}`);
    z = target;
  };
  const retract = () => {
    if (retracted || printer.retract.length <= 0) return;
    const text = num(printer.retract.length, 4);
    emit(`G1 E-${text} F${retractF}`);
    netE -= Number(text);
    retracted = true;
  };
  const unretract = () => {
    if (!retracted) return;
    const text = num(printer.retract.length, 4);
    emit(`G1 E${text} F${retractF}`);
    netE += Number(text);
    retracted = false;
  };
  const extrude = (to: Pt, area: number) => {
    const px = toMm(to.X);
    const py = toMm(to.Y);
    const length = Math.hypot(px - x, py - y);
    if (length < 1e-4) return;
    // Count exactly what is written, so the declared total matches a re-read to the digit.
    const e = Number(num(length * area * eRate, 5));
    if (e <= 0) return;
    emit(`G1 X${num(px, 3)} Y${num(py, 3)} E${num(e, 5)}`);
    netE += e;
    filamentMm += e;
    x = px;
    y = py;
  };
  const setFan = (percent: number) => {
    if (percent === fan) return;
    fan = percent;
    emit(percent > 0 ? `M106 S${Math.round((percent * 255) / 100)}` : 'M107');
  };

  /* --- purge line ------------------------------------------------------ */
  const firstZ = layers[0]?.z ?? process.firstLayerHeight;
  if (printer.purge) {
    const height = 0.3;
    const width = printer.nozzle * 2;
    emit(';TYPE:Purge');
    setZ(2);
    moveTo({ X: printer.purge.from[0] * 1000, Y: printer.purge.from[1] * 1000 }, printer.speeds.travel * 60);
    setZ(height);
    emit(`G1 F${20 * 60}`);
    extrude({ X: printer.purge.to[0] * 1000, Y: printer.purge.to[1] * 1000 }, lineArea(width, height));
    retract();
    setZ(Math.max(firstZ, height) + 0.6);
  }

  /* --- layers ---------------------------------------------------------- */
  const lift = printer.retract.lift;
  for (const layer of layers) {
    const first = layer.index === 0;
    const grid = new EdgeGrid(layer.outlines);
    const travelSpeed = first ? printer.speeds.firstLayerTravel : printer.speeds.travel;

    // Estimate the layer time to decide slow-down and fan before writing it.
    let extrudeTime = 0;
    let travelLength = 0;
    let cursor: Pt | null = null;
    for (const e of layer.extrusions) {
      const speed = capSpeed(roleSpeed(e.role, printer, first), e.area, maxFlow);
      extrudeTime += pathLength(e) / speed;
      if (cursor) travelLength += toMm(Math.hypot(e.points[0].X - cursor.X, e.points[0].Y - cursor.Y));
      cursor = e.closed ? e.points[0] : e.points[e.points.length - 1];
    }
    const otherTime = travelLength / travelSpeed;
    const factor = slowdownFactor(extrudeTime, otherTime, filament.slowdownLayerTime);
    const layerTime = extrudeTime / factor + otherTime;
    const layerFan = fanFor(filament, layer.index, layerTime);

    emit(';LAYER_CHANGE');
    emit(`;Z:${num(layer.z, 3)}`);
    emit(`;HEIGHT:${num(layer.height, 3)}`);
    emit(`;LAYER:${layer.index}`);
    if (first) {
      // Bed and nozzle move from first-layer to normal temperatures on layer 2.
    } else if (layer.index === 1) {
      if (filament.nozzleTemp !== filament.firstLayerNozzleTemp) emit(`M104 S${filament.nozzleTemp}`);
      if (filament.bedTemp !== filament.firstLayerBedTemp) emit(`M140 S${filament.bedTemp}`);
    }
    setFan(layerFan);
    retract();
    setZ(layer.z);

    for (const e of layer.extrusions) {
      const startPoint = e.points[0];
      const sx = toMm(startPoint.X);
      const sy = toMm(startPoint.Y);
      const far = Number.isNaN(x) ? Infinity : Math.hypot(sx - x, sy - y);
      if (far > 1e-4) {
        const from: Pt = { X: Math.round(x * 1000), Y: Math.round(y * 1000) };
        const needsRetract =
          Number.isNaN(x) || (far >= printer.retract.minTravel && grid.crosses(from, startPoint));
        if (needsRetract) {
          retract();
          if (lift > 0) setZ(layer.z + lift);
        }
        moveTo(startPoint, travelSpeed * 60);
        setZ(layer.z);
      }
      unretract();

      const label = ROLE_LABEL[e.role];
      if (label !== lastType) {
        emit(`;TYPE:${label}`);
        lastType = label;
      }
      if (e.width !== lastWidth) {
        emit(`;WIDTH:${num(e.width, 3)}`);
        lastWidth = e.width;
      }
      const bridgeFan = e.role === 'bridge' && layer.index >= filament.fan.offLayers;
      if (bridgeFan) setFan(filament.fan.bridge);

      const base = roleSpeed(e.role, printer, first);
      const speed = Math.max(Math.min(base, filament.minPrintSpeed), capSpeed(base, e.area, maxFlow) * factor);
      emit(`G1 F${Math.round(speed * 60)}`);
      for (let i = 1; i < e.points.length; i++) extrude(e.points[i], e.area);
      if (e.closed) extrude(e.points[0], e.area);

      if (bridgeFan) setFan(layerFan);
    }
  }

  /* --- end ------------------------------------------------------------- */
  emit(';CALIPER_END_BEGIN');
  for (const line of fillTemplate(end, values, 'end').split(/\r?\n/)) emit(line);
  emit(';CALIPER_END_END');
  // The end sequence's own retraction counts toward the total.
  const endE = parseEndE(fillTemplate(end, values, 'end'));
  netE += endE;

  emit('');
  emit(`; caliper_filament_used_mm = ${num(filamentMm, 3)}`);
  emit(`; caliper_net_e_mm = ${num(netE, 5)}`);
  emit(`; caliper_layer_count = ${layers.length}`);
  emit('; caliper_end_of_file');

  return { text: out.join('\n') + '\n', netE, filamentMm, layerCount: layers.length };
}

/** E moves inside the end sequence, which runs in relative extrusion mode. */
function parseEndE(text: string): number {
  let total = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim().toUpperCase();
    if (!/^G[01]\b/.test(line)) continue;
    const m = line.match(/\bE(-?\d*\.?\d+)/);
    if (m) total += Number(m[1]);
  }
  return total;
}
