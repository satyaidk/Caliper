/**
 * Fail-closed pre-flight check of finished P1S G-code.
 *
 * Why a second, independent pass: the generator could have a bug, and a bug
 * here can drive the nozzle into the plate, off the bed, or into the
 * printer's no-go corner. This module re-reads the final text the way the
 * printer would — line by line, tracking position, extrusion mode, feed rate
 * and fan — and shares no code with the generator. Export is allowed only when
 * it reports no errors.
 *
 * The machine start and end blocks are Bambu's own and deliberately move
 * outside the print area (brush wipe at Y 265, Z below 0 on the wiper), so
 * they are checked for being exactly the rendered templates instead of being
 * bounds-checked.
 */
import type { PrintSettings, Point2 } from './settings';
import { END_END_MARK, END_MARK, START_END_MARK, START_MARK } from '../gcode';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightIssue {
  level: 'error' | 'warning';
  message: string;
  line?: number;
}

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  issues: PreflightIssue[];
}

export interface PreflightInput {
  text: string;
  settings: PrintSettings;
  /** Exact rendered machine start and end blocks. */
  startBlock: string;
  endBlock: string;
  /** Rendered per-layer and filament templates; their commands are allowed in the body. */
  templateBlocks: readonly string[];
}

const EPS = 1e-3;
/** Commands Caliper itself writes between the machine blocks. */
const BODY_COMMANDS = new Set(['G1', 'G90', 'G21', 'M83', 'M73', 'M106', 'M204', 'M981', 'M1003']);
/** Never allowed in the print body: homing, levelling, relative moves, absolute E, motor/endstop changes. */
const FORBIDDEN = new Set(['G28', 'G29', 'G29.1', 'G29.2', 'G91', 'M82', 'G380', 'M17', 'M221', 'M290', 'G92']);

function commandOf(line: string): { code: string; params: Map<string, number>; raw: string } | null {
  const raw = line.replace(/;.*$/, '').trim();
  if (!raw) return null;
  const [code, ...rest] = raw.split(/\s+/);
  const params = new Map<string, number>();
  for (const token of rest) {
    const match = /^([A-Za-z])(-?[\d.]+)$/.exec(token);
    if (match) params.set(match[1].toUpperCase(), Number(match[2]));
  }
  return { code: code.toUpperCase(), params, raw };
}

function insidePolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (o: Point2, p: Point2, q: Point2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if the move from a to b touches the polygon's interior. */
function moveEntersPolygon(a: Point2, b: Point2, polygon: readonly Point2[]): boolean {
  if (insidePolygon(a, polygon) || insidePolygon(b, polygon)) return true;
  for (let i = 0; i < polygon.length; i++) {
    if (segmentsCross(a, b, polygon[i], polygon[(i + 1) % polygon.length])) return true;
  }
  return false;
}

/** Loops rather than spreading: a first layer can have more points than the call stack allows arguments. */
function boundsOf(points: readonly Point2[]) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}

export function runPreflight(input: PreflightInput): PreflightReport {
  const { text, settings } = input;
  const { machine, filament } = settings;
  const issues: PreflightIssue[] = [];
  const failed = new Map<string, string>();
  const warned = new Map<string, string>();
  const error = (check: string, message: string, line?: number) => {
    issues.push({ level: 'error', message, line });
    if (!failed.has(check)) failed.set(check, message);
  };
  const warn = (check: string, message: string, line?: number) => {
    issues.push({ level: 'warning', message, line });
    if (!warned.has(check)) warned.set(check, message);
  };

  const lines = text.split('\n');
  const startIndex = lines.indexOf(START_MARK);
  const startEndIndex = lines.indexOf(START_END_MARK);
  const endIndex = lines.indexOf(END_MARK);
  const endEndIndex = lines.indexOf(END_END_MARK);

  // 1. Machine blocks are present once, in order, and byte-identical to Bambu's rendered templates.
  const count = (mark: string) => lines.filter((line) => line === mark).length;
  if ([START_MARK, START_END_MARK, END_MARK, END_END_MARK].some((mark) => count(mark) !== 1)) {
    error('machine-blocks', 'The Bambu start or end sequence is missing or duplicated.');
  } else if (!(startIndex < startEndIndex && startEndIndex < endIndex && endIndex < endEndIndex)) {
    error('machine-blocks', 'The Bambu start and end sequences are out of order.');
  } else {
    if (lines.slice(startIndex + 1, startEndIndex).join('\n') !== input.startBlock) {
      error('machine-blocks', "The start sequence differs from Bambu's P1S template.", startIndex + 1);
    }
    if (lines.slice(endIndex + 1, endEndIndex).join('\n') !== input.endBlock) {
      error('machine-blocks', "The end sequence differs from Bambu's P1S template.", endIndex + 1);
    }
  }
  const startCommands = input.startBlock.split('\n').map(commandOf).filter((c) => c !== null);
  for (const required of ['G28', 'M190', 'M109', 'G29']) {
    if (!startCommands.some((command) => command.code === required)) {
      error('machine-blocks', `The start sequence has no ${required}; it may not be the P1S template.`);
    }
  }

  // 2. Heating: the start block must end at the first-layer nozzle and bed temperatures.
  const lastValue = (codes: string[]) =>
    [...startCommands].reverse().find((command) => codes.includes(command.code) && command.params.has('S'))?.params.get('S');
  const nozzle = [...startCommands].reverse().find((c) => c.code === 'M109' && c.params.has('S'))?.params.get('S');
  const bed = lastValue(['M190']);
  if (nozzle !== filament.nozzleTemperatureFirstLayer) {
    error('heating', `The nozzle is not brought to ${filament.nozzleTemperatureFirstLayer} °C before printing.`);
  }
  if (bed !== filament.bedTemperatureFirstLayer) {
    error('heating', `The bed is not brought to ${filament.bedTemperatureFirstLayer} °C before printing.`);
  }

  // 3. Bed levelling probes the first-layer area, inside the plate.
  const level = startCommands.find((command) => command.code === 'G29' && command.params.has('I'));
  const area = boundsOf(machine.printableArea);
  if (!level) {
    error('levelling', 'The start sequence does not level the bed over the print area.');
  } else {
    const lx = level.params.get('X') ?? NaN;
    const ly = level.params.get('Y') ?? NaN;
    const li = level.params.get('I') ?? NaN;
    const lj = level.params.get('J') ?? NaN;
    if (![lx, ly, li, lj].every(Number.isFinite) || li <= 0 || lj <= 0) {
      error('levelling', 'The bed-levelling area is invalid.');
    } else if (lx < area.minX - EPS || ly < area.minY - EPS || lx + li > area.maxX + EPS || ly + lj > area.maxY + EPS) {
      error('levelling', 'The bed-levelling area extends past the plate.');
    }
  }

  // 4. Walk the print body like the printer would.
  const allowed = new Set(BODY_COMMANDS);
  for (const block of input.templateBlocks) {
    for (const command of block.split('\n').map(commandOf)) if (command) allowed.add(command.code);
  }
  const filamentArea = Math.PI * (filament.diameter / 2) ** 2;
  const maxFlow = filament.maxVolumetricSpeed * Math.max(1, filament.flowRatio) * 1.01;
  const maxFeedXY = machine.maxSpeedXY * 60 * (1 + EPS);
  const maxFeedZ = machine.maxSpeedZ * 60 * (1 + EPS);
  let x: number | null = null;
  let y: number | null = null;
  let z: number | null = null;
  let feed = 0;
  let relativeE = false;
  let netRetraction = 0;
  let extruded = 0;
  let layers = 0;
  let lastLayerZ = -Infinity;
  let maxZ = 0;
  let firstExtrusionZ: number | null = null;
  const firstLayerPoints: Point2[] = [];

  // The start sequence ends in relative-extrusion mode (`M83`) on the P1S.
  if (startCommands.some((c) => c.code === 'M83')) relativeE = true;
  if (startEndIndex < 0 || endIndex < 0) relativeE = false;

  for (let index = startEndIndex + 1; startEndIndex >= 0 && index < endIndex; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.startsWith('; CHANGE_LAYER')) {
      layers++;
      continue;
    }
    const zMarker = /^; Z_HEIGHT: ([\d.]+)/.exec(line);
    if (zMarker) {
      const layerZ = Number(zMarker[1]);
      if (!(layerZ > lastLayerZ)) error('layers', `Layer heights do not increase at Z ${layerZ}.`, lineNumber);
      lastLayerZ = layerZ;
      continue;
    }
    const command = commandOf(line);
    if (!command) continue;
    const { code, params } = command;
    if (FORBIDDEN.has(code)) {
      error('commands', `${code} must not appear in the print body.`, lineNumber);
      continue;
    }
    if (!allowed.has(code)) {
      error('commands', `Unexpected command ${code} in the print body.`, lineNumber);
      continue;
    }
    if (code === 'M83') relativeE = true;
    if (code === 'M106') {
      const value = params.get('S');
      if (value === undefined || value < 0 || value > 255) error('fan', `Fan value out of range: ${command.raw}`, lineNumber);
    }
    if (code === 'M204') {
      const value = params.get('S') ?? 0;
      if (value <= 0 || value > machine.maxAccelerationExtruding) {
        error('motion', `Acceleration ${value} exceeds the P1S limit.`, lineNumber);
      }
    }
    if (code !== 'G1') continue;

    if (params.has('F')) feed = params.get('F')!;
    const nx: number | null = params.has('X') ? params.get('X')! : x;
    const ny: number | null = params.has('Y') ? params.get('Y')! : y;
    const nz: number | null = params.has('Z') ? params.get('Z')! : z;
    const e = params.get('E') ?? 0;
    if (params.has('E') && !relativeE) error('extrusion', 'Extrusion before relative mode (M83) was set.', lineNumber);
    const movesXY = (params.has('X') || params.has('Y')) && x !== null && y !== null && nx !== null && ny !== null;
    const length = movesXY ? Math.hypot(nx! - x!, ny! - y!) : 0;

    if (nz !== null) {
      if (nz <= 0 || nz > machine.maxHeight + EPS) error('height', `Z ${nz} is outside 0–${machine.maxHeight} mm.`, lineNumber);
      maxZ = Math.max(maxZ, nz);
    }
    if (params.has('Z') && !params.has('X') && !params.has('Y') && feed > maxFeedZ) {
      error('motion', `Z feed rate F${feed} exceeds ${machine.maxSpeedZ} mm/s.`, lineNumber);
    }
    if ((params.has('X') || params.has('Y')) && feed > maxFeedXY) {
      error('motion', `Feed rate F${feed} exceeds ${machine.maxSpeedXY} mm/s.`, lineNumber);
    }
    if (nx !== null && ny !== null) {
      if (nx < area.minX - EPS || nx > area.maxX + EPS || ny < area.minY - EPS || ny > area.maxY + EPS) {
        error('bounds', `Move to X${nx} Y${ny} is off the plate.`, lineNumber);
      }
      const from = x !== null && y !== null ? { x, y } : { x: nx, y: ny };
      for (const polygon of machine.excludeAreas) {
        if (moveEntersPolygon(from, { x: nx, y: ny }, polygon)) {
          error('bounds', `Move to X${nx} Y${ny} enters the P1S excluded corner.`, lineNumber);
        }
      }
    }

    if (e < 0) {
      if (-e > 5) error('extrusion', `Retraction of ${-e} mm is too long.`, lineNumber);
      netRetraction += -e;
      if (netRetraction > machine.retractionLength * 2 + EPS) error('extrusion', 'Filament is retracted repeatedly without priming.', lineNumber);
    } else if (e > 0) {
      if (length > 0) {
        if (z === null || z <= 0) error('extrusion', 'Extrusion before the nozzle reached a layer height.', lineNumber);
        const flow = (e / length) * filamentArea * (feed / 60);
        if (flow > maxFlow) {
          error('flow', `Flow ${flow.toFixed(1)} mm³/s exceeds ${filament.maxVolumetricSpeed} mm³/s.`, lineNumber);
        }
        if ((e / length) * filamentArea > 0.75) error('flow', 'An extrusion is far too thick for a 0.4 mm nozzle.', lineNumber);
        if (firstExtrusionZ === null) firstExtrusionZ = z;
        if (layers === 1) firstLayerPoints.push({ x: x!, y: y! }, { x: nx!, y: ny! });
        const primed = Math.min(netRetraction, e);
        netRetraction -= primed;
        extruded += e - primed;
      } else {
        // A pure prime: it must not over-push past what was retracted.
        if (e > netRetraction + EPS) error('extrusion', `Priming ${e} mm more than was retracted.`, lineNumber);
        netRetraction = Math.max(0, netRetraction - e);
      }
    }
    x = nx;
    y = ny;
    z = nz;
  }

  // 5. First layer starts at the first-layer height and stays clear of the purge line.
  if (firstExtrusionZ === null) error('layers', 'The print body never extrudes.');
  else if (Math.abs(firstExtrusionZ - settings.firstLayerHeight) > EPS) {
    error('layers', `The first layer is printed at Z ${firstExtrusionZ}, not ${settings.firstLayerHeight}.`);
  }
  if (firstLayerPoints.length) {
    const first = boundsOf(firstLayerPoints);
    if (level) {
      const lx = level.params.get('X')!;
      const ly = level.params.get('Y')!;
      if (first.minX < lx - 0.5 || first.minY < ly - 0.5 || first.maxX > lx + level.params.get('I')! + 0.5 || first.maxY > ly + level.params.get('J')! + 0.5) {
        error('levelling', 'The first layer extends past the area the printer levels.');
      }
    }
    if (first.minY < 12 && first.maxX > 18 && first.minX < 240) {
      warn('first-layer', 'The first layer reaches the front strip where the P1S draws its purge line (Y < 12 mm). Move the part back if the purge line is left on the plate.');
    }
  }

  // 6. Header totals agree with the body.
  const headerLayers = /; total layer number: (\d+)/.exec(text);
  if (!headerLayers || Number(headerLayers[1]) !== layers) error('header', 'The header layer count does not match the body.');
  const headerLength = /; total filament length \[mm\] : ([\d.]+)/.exec(text);
  if (!headerLength || Math.abs(Number(headerLength[1]) - extruded) > Math.max(1, extruded * 0.01)) {
    error('header', 'The header filament length does not match the extrusion in the body.');
  }
  if (Math.abs(maxZ - lastLayerZ) > (machine.zHop || 0) + EPS && Number.isFinite(lastLayerZ)) {
    error('height', 'The highest move is well above the last layer.');
  }
  const headerMaxZ = /; max_z_height: ([\d.]+)/.exec(text);
  if (!headerMaxZ || Math.abs(Number(headerMaxZ[1]) - lastLayerZ) > 0.01) error('header', 'The header max Z does not match the last layer.');

  const definitions: [string, string][] = [
    ['machine-blocks', "Bambu's P1S start and end sequence, unmodified"],
    ['heating', 'Nozzle and bed heated to the filament temperatures'],
    ['levelling', 'Bed levelled over the first layer'],
    ['bounds', 'Every move on the plate and out of the excluded corner'],
    ['height', 'Height within the 250 mm build volume'],
    ['layers', 'Layers in order, first layer at the right height'],
    ['extrusion', 'Relative extrusion with balanced retraction'],
    ['flow', 'Flow within the filament limit'],
    ['motion', 'Speeds and accelerations within P1S limits'],
    ['fan', 'Fan commands valid'],
    ['commands', 'No homing, levelling or mode changes mid-print'],
    ['header', 'Header totals match the toolpaths'],
    ['first-layer', 'First layer clear of the purge line'],
  ];
  const checks: PreflightCheck[] = definitions.map(([id, label]) => ({
    id,
    label,
    status: failed.has(id) ? 'fail' : warned.has(id) ? 'warn' : 'pass',
    detail: failed.get(id) ?? warned.get(id),
  }));
  return { ok: failed.size === 0, checks, issues };
}
