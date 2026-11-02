import { filamentArea, impliedWidth } from './flow';
import { MotionPlanner } from './motion';
import type { FilamentProfile, PrinterProfile } from './profiles';

/**
 * The G-code checker: reads a finished G-code file the way a printer would and
 * reports anything that could damage the printer, ruin the print or mean the
 * file is not what it claims to be.
 *
 * It reads the *text*, not the slicer's intentions. What is checked is exactly
 * what would be sent to the printer, so a bug anywhere upstream (slicer,
 * template, a person's edit, a truncated download) is caught here. The same
 * pass also measures the file (time, filament) and collects the moves the
 * Preview draws, so what is drawn is the file itself.
 *
 * Errors block export. Warnings must be read and acknowledged. Info is for
 * context. The checks are deliberately strict for Caliper's own files and a
 * little looser for files from other slicers, whose start sequences do things
 * (purge lines off the plate, calibration moves) Caliper cannot judge.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  /** First line it happened on, 1-based. */
  line?: number;
  /** First layer it happened on, 0-based. */
  layer?: number;
  count: number;
}

export interface VerifyOptions {
  printer: PrinterProfile;
  /** Known when the file is Caliper's own; used for the temperature range. */
  filament?: FilamentProfile | null;
  source: 'caliper' | 'external';
}

/** Moves for the Preview, in printer millimetres. */
export interface PreviewData {
  /** Six numbers per extrusion segment: x0 y0 z0 x1 y1 z1. */
  segments: Float32Array;
  /** Role index per extrusion segment; see PREVIEW_ROLES. */
  roles: Uint8Array;
  /** Index of the first segment of each layer. */
  layerStarts: Uint32Array;
  layerZ: Float32Array;
  /** Six numbers per travel move, with the same layering. */
  travels: Float32Array;
  travelLayerStarts: Uint32Array;
}

export interface VerifyStats {
  lines: number;
  layers: number;
  /** Filament pushed while printing, mm. */
  filamentMm: number;
  filamentGrams: number | null;
  /** Moving time; heating and waits are not included. */
  seconds: number;
  maxNozzleTemp: number;
  maxBedTemp: number;
  /** Highest flow asked of the hot end, mm³/s. */
  peakFlow: number;
  printed: { minX: number; minY: number; maxX: number; maxY: number; maxZ: number } | null;
  firstLayerZ: number | null;
}

export interface VerifyReport {
  /** True when nothing blocks sending the file to the printer. */
  ok: boolean;
  findings: Finding[];
  stats: VerifyStats;
  preview: PreviewData;
}

export const PREVIEW_ROLES = [
  'Outer wall',
  'Inner wall',
  'Sparse infill',
  'Solid infill',
  'Top surface',
  'Bridge',
  'Skirt and brim',
  'Support',
  'Purge',
  'Other',
] as const;

/** Maps ;TYPE: labels from Caliper, PrusaSlicer and Bambu Studio onto preview roles. */
export function roleIndex(label: string): number {
  const t = label.toLowerCase();
  if (t.includes('purge') || t.includes('prime') || t.includes('wipe')) return 8;
  if (t.includes('support')) return 7;
  if (t.includes('skirt') || t.includes('brim')) return 6;
  if (t.includes('bridge')) return 5;
  if (t.includes('top')) return 4;
  if (t.includes('external') || t.includes('outer') || t.includes('overhang')) return 0;
  if (t.includes('perimeter') || t.includes('wall')) return 1;
  if (t.includes('solid') || t.includes('ironing')) return 3;
  if (t.includes('infill') || t.includes('gap')) return 2;
  return 9;
}

/** Marlin refuses to extrude below this by default (EXTRUDE_MINTEMP). */
const MIN_EXTRUDE_TEMP = 170;
/** Temperatures this low are probing or standby, not printing. */
const STANDBY_BELOW = 180;
const EPS = 0.011;

class FloatList {
  private data = new Float32Array(1024);
  length = 0;
  push6(a: number, b: number, c: number, d: number, e: number, f: number) {
    if (this.length + 6 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.length;
    this.data[o] = a;
    this.data[o + 1] = b;
    this.data[o + 2] = c;
    this.data[o + 3] = d;
    this.data[o + 4] = e;
    this.data[o + 5] = f;
    this.length += 6;
  }
  done() {
    return this.data.slice(0, this.length);
  }
}

class ByteList {
  private data = new Uint8Array(1024);
  length = 0;
  push(v: number) {
    if (this.length >= this.data.length) {
      const next = new Uint8Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  done() {
    return this.data.slice(0, this.length);
  }
}

export function verifyGcode(text: string, options: VerifyOptions): VerifyReport {
  const { printer, source } = options;
  const strict = source === 'caliper';
  const filament = options.filament ?? null;
  const fArea = filamentArea(printer.filamentDiameter);
  const [bedW, bedD, bedH] = printer.bed;
  const L = printer.limits;

  const findings = new Map<string, Finding>();
  const report = (
    code: string,
    severity: Severity,
    title: string,
    detail: string,
    line: number | undefined,
    layer: number | undefined,
  ) => {
    const found = findings.get(code);
    if (found) {
      found.count++;
      return;
    }
    findings.set(code, { code, severity, title, detail, line, layer: layer !== undefined && layer >= 0 ? layer : undefined, count: 1 });
  };
  /** Strict for Caliper's files, a warning for files from elsewhere. */
  const strictly = (severity: Severity): Severity => (strict ? severity : severity === 'error' ? 'warning' : severity);

  // Machine state, as the firmware would track it.
  let absolute = true;
  let relativeE = false;
  let x: number | null = null;
  let y: number | null = null;
  let z: number | null = null;
  let e = 0;
  const homed = { x: false, y: false, z: false };
  let feed = 0;
  let accel = printer.accel.print;
  let nozzleTarget = 0;
  let nozzleWaited = false;
  let bedTarget = 0;
  let bedWaited = false;
  let fanOn = false;

  // What has been printed.
  let role = 9;
  let inStart = false;
  let inEnd = false;
  let sawStartMarkers = false;
  let layer = -1;
  let layerZ = -Infinity;
  let prevLayerZ = 0;
  let maxPrintedZ = -Infinity;
  let lastExtrudeLine = 0;
  let netE = 0;
  let filamentMm = 0;
  const motion = new MotionPlanner();
  let peakFlow = 0;
  let maxNozzle = 0;
  let maxBed = 0;
  let firstLayerZ: number | null = null;
  let declaredNetE: number | null = null;
  let declaredPrinter: string | null = null;
  let lastNonEmpty = '';
  // A macro (PRINT_START and the like) may home and heat out of sight.
  let sawMacro = false;
  const unlessMacro = (severity: Severity): Severity => (sawMacro && !strict ? 'warning' : severity);
  const printed = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const unknown = new Map<string, number>();

  const segments = new FloatList();
  const roles = new ByteList();
  const travels = new FloatList();
  const layerStarts: number[] = [];
  const travelLayerStarts: number[] = [];
  const layerZs: number[] = [];

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const raw = lines[n];
    const semicolon = raw.indexOf(';');
    const comment = semicolon >= 0 ? raw.slice(semicolon + 1).trim() : '';
    let code = (semicolon >= 0 ? raw.slice(0, semicolon) : raw).trim();
    if (raw.trim()) lastNonEmpty = raw.trim();

    /* --- comments: roles, markers, the header and footer ------------- */
    if (comment) {
      if (comment.startsWith('TYPE:')) role = roleIndex(comment.slice(5));
      else if (comment === 'CALIPER_START_BEGIN') {
        inStart = true;
        sawStartMarkers = true;
      } else if (comment === 'CALIPER_START_END') inStart = false;
      else if (comment === 'CALIPER_END_BEGIN') inEnd = true;
      else if (comment.startsWith('caliper_printer =')) declaredPrinter = comment.split('=')[1].trim();
      else if (comment.startsWith('caliper_net_e_mm =')) declaredNetE = Number(comment.split('=')[1]);
    }
    if (!code) continue;

    // Quoted text (M862.3 P "MK4", M117 messages) is a parameter, not G-code.
    const unquoted = code.replace(/"[^"]*"/g, '""');
    const upper = unquoted.toUpperCase();

    if (/[{}[\]]/.test(unquoted)) {
      report(
        'E002',
        'error',
        'Unfilled template placeholder',
        `"${code}" still contains a {placeholder} or [variable]. A printer would read it as garbage; usually a start sequence copied from another slicer.`,
        lineNo,
        layer,
      );
      continue;
    }

    const head = upper.match(/^([GMT])(\d+)(?:\.(\d+))?/);
    if (!head) {
      // Klipper macros and similar are plain words; Caliper never writes them.
      sawMacro = true;
      report(
        'W003',
        strictly('error'),
        'Line the checker does not understand',
        `"${code}" is not a G, M or T command, so its effect cannot be checked.`,
        lineNo,
        layer,
      );
      continue;
    }
    const letter = head[1];
    const number = Number(head[2]);
    const command = `${letter}${head[2]}${head[3] ? `.${head[3]}` : ''}`;

    // Parameters. M117/M118 carry free text and are skipped.
    const params: Record<string, number> = {};
    let malformed = false;
    if (!(letter === 'M' && (number === 117 || number === 118 || number === 23 || number === 28 || number === 30))) {
      const rest = upper.slice(head[0].length);
      for (const match of rest.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:E[-+]?\d+)?)?/g)) {
        if (match[2] === undefined) {
          params[match[1]] = NaN;
          continue;
        }
        const value = Number(match[2]);
        if (!Number.isFinite(value)) malformed = true;
        params[match[1]] = value;
      }
      if (/[A-Z]\s*[-+]?(?:NAN|INF)/.test(rest)) malformed = true;
    }
    if (malformed) {
      report('E001', 'error', 'Number the printer cannot read', `"${code}" has a value that is not a finite number.`, lineNo, layer);
      continue;
    }
    const has = (k: string) => k in params && Number.isFinite(params[k]);

    /* --- motion ------------------------------------------------------ */
    if (letter === 'G' && number <= 3) {
      if ('F' in params) {
        if (!(params.F > 0)) {
          report('E040', 'error', 'Zero or missing speed', `"${code}" sets a feed rate of ${params.F}. A move at speed 0 never finishes or stalls the printer.`, lineNo, layer);
        } else feed = params.F;
      }
      const moves = has('X') || has('Y') || has('Z') || has('E');
      if (!moves) continue;

      if ((has('X') && !homed.x) || (has('Y') && !homed.y) || (has('Z') && !homed.z)) {
        report(
          'E010',
          unlessMacro('error'),
          'Movement before homing',
          `"${code}" moves an axis before G28 has homed it. The printer does not know where the nozzle is, so it could crash into the frame or the bed.`,
          lineNo,
          layer,
        );
      }
      if (!(feed > 0)) {
        report('E040', 'error', 'Move with no speed set', `"${code}" moves before any feed rate (F) was set.`, lineNo, layer);
      }

      const nx: number | null = has('X') ? (absolute ? params.X : (x ?? 0) + params.X) : x;
      const ny: number | null = has('Y') ? (absolute ? params.Y : (y ?? 0) + params.Y) : y;
      const nz: number | null = has('Z') ? (absolute ? params.Z : (z ?? 0) + params.Z) : z;
      const de = has('E') ? (relativeE ? params.E : params.E - e) : 0;
      if (has('E')) e = relativeE ? e + params.E : params.E;

      // Every axis inside the machine's travel.
      const outside: string[] = [];
      if (nx !== null && (nx < L.x[0] - EPS || nx > L.x[1] + EPS)) outside.push(`X${nx.toFixed(2)}`);
      if (ny !== null && (ny < L.y[0] - EPS || ny > L.y[1] + EPS)) outside.push(`Y${ny.toFixed(2)}`);
      if (nz !== null && nz > L.z[1] + EPS) outside.push(`Z${nz.toFixed(2)}`);
      if (outside.length)
        report(
          'E011',
          'error',
          'Move past the machine’s limits',
          `${outside.join(', ')} is outside what ${printer.label} can reach (X ${L.x[0]}–${L.x[1]}, Y ${L.y[0]}–${L.y[1]}, Z up to ${L.z[1]} mm). The motors would grind against the end stops or the frame.`,
          lineNo,
          layer,
        );
      if (nz !== null && nz < -EPS)
        report('E020', 'error', 'Nozzle below the bed', `"${code}" sends the nozzle to Z ${nz.toFixed(3)}, below the bed surface.`, lineNo, layer);

      // Arcs: check the whole circle stays inside the limits.
      if (number === 2 || number === 3) {
        report('I004', 'info', 'Arc moves present', 'The file uses G2/G3 arcs. Their full circles are checked against the limits, not their exact paths.', lineNo, layer);
        if (x !== null && y !== null && (has('I') || has('J'))) {
          const cx = x + (params.I || 0);
          const cy = y + (params.J || 0);
          const r = Math.hypot(params.I || 0, params.J || 0);
          if (cx - r < L.x[0] - EPS || cx + r > L.x[1] + EPS || cy - r < L.y[0] - EPS || cy + r > L.y[1] + EPS)
            report('E011', 'error', 'Move past the machine’s limits', `The arc on line ${lineNo} could leave the machine’s travel.`, lineNo, layer);
        }
      }

      const known = x !== null && y !== null && nx !== null && ny !== null;
      const dxy = known ? Math.hypot(nx! - x!, ny! - y!) : 0;
      // After homing Z is unknown; a Z move then still counts as one.
      const dz = nz === null ? 0 : z !== null ? Math.abs(nz - z) : has('Z') ? Math.abs(nz) : 0;
      const speed = feed / 60;

      // Feed-rate ceilings: the firmware caps them, so this is a warning.
      if (dxy > 0 && speed > printer.maxSpeed.xy * 1.01)
        report('W041', 'warning', 'Faster than the printer allows', `Some moves ask for ${Math.round(speed)} mm/s; ${printer.label} tops out at ${printer.maxSpeed.xy} mm/s, so the firmware will slow them and the time estimate will be short.`, lineNo, layer);
      if (dxy === 0 && dz > 0 && speed > printer.maxSpeed.z * 1.01)
        report('W042', 'warning', 'Z moves faster than the printer allows', `A Z move asks for ${Math.round(speed)} mm/s; the Z axis tops out at ${printer.maxSpeed.z} mm/s.`, lineNo, layer);

      // Time: the planner carries speed through corners like the firmware does.
      const length = Math.hypot(dxy, dz);
      const axisMax = dxy > 0 ? printer.maxSpeed.xy : dz > 0 ? printer.maxSpeed.z : printer.maxSpeed.e;
      if (length > 0 && known && nz !== null && z !== null) {
        const direction: [number, number, number] = [(nx! - x!) / length, (ny! - y!) / length, (nz - z) / length];
        motion.add(length, Math.min(speed, axisMax), Math.min(accel, printer.maxAccel), direction);
      } else if (length > 0 || de !== 0) {
        // Position unknown (just homed) or extruder only: a move from and to rest.
        motion.add(length > 0 ? length : Math.abs(de), Math.min(speed, axisMax), Math.min(accel, printer.maxAccel), [0, 0, 0]);
      }

      netE += de;
      const printing = de > 0 && dxy > 0;

      if (de > 0) {
        // Heat before plastic.
        if (nozzleTarget < MIN_EXTRUDE_TEMP)
          report('E034', unlessMacro('error'), 'Extruding with a cold nozzle', `Line ${lineNo} pushes filament while the nozzle is set to ${nozzleTarget} °C. The extruder would grind the filament or jam.`, lineNo, layer);
        else if (!nozzleWaited)
          report('E035', unlessMacro('error'), 'Extruding before the nozzle is hot', `Line ${lineNo} extrudes before any M109 has waited for the nozzle to reach temperature.`, lineNo, layer);
        if (bedTarget > 0 && !bedWaited)
          report('W036', 'warning', 'Printing before the bed is warm', 'The bed is heating but nothing waits for it (M190), so the first layer may not stick.', lineNo, layer);
        if (filament && nozzleTarget >= STANDBY_BELOW && (nozzleTarget < filament.nozzleRange[0] || nozzleTarget > filament.nozzleRange[1]))
          report('W032', 'warning', 'Temperature outside the filament’s range', `Printing at ${nozzleTarget} °C; ${filament.label} prints well between ${filament.nozzleRange[0]} and ${filament.nozzleRange[1]} °C.`, lineNo, layer);
      }

      if (!printing && de !== 0 && dxy === 0) {
        // Retraction, unretraction or priming in place.
        const limit = printer.maxRetract;
        if (de < 0 && -de > limit * 3)
          report('E053', strictly('error'), 'Very long retraction', `Line ${lineNo} pulls back ${(-de).toFixed(1)} mm of filament, far past the ${limit} mm this extruder handles. It can pull molten plastic into the cold zone and jam.`, lineNo, layer);
        else if (de < 0 && -de > limit + EPS)
          report('W052', 'warning', 'Long retraction', `Line ${lineNo} retracts ${(-de).toFixed(2)} mm; ${printer.label} is set up for at most ${limit} mm.`, lineNo, layer);
        if (de > Math.max(limit * 3, 30))
          report('E054', strictly('error'), 'Large blob of filament in one place', `Line ${lineNo} pushes ${de.toFixed(1)} mm of filament without moving, which leaves a blob the nozzle then hits.`, lineNo, layer);
      }

      if (printing && nx !== null && ny !== null && nz !== null) {
        const purge = role === 8;
        if (nz < 0.05)
          report('E021', 'error', 'Extruding with the nozzle on the bed', `Line ${lineNo} extrudes at Z ${nz.toFixed(3)}. The nozzle would scrape the bed and the plastic has nowhere to go.`, lineNo, layer);

        // Layers follow the extrusion height; purge lines do not count.
        if (!purge && !inStart && !inEnd) {
          if (nz > layerZ + 1e-4) {
            prevLayerZ = layerZ === -Infinity ? 0 : layerZ;
            layerZ = nz;
            layer++;
            layerStarts.push(segments.length / 6);
            travelLayerStarts.push(travels.length / 6);
            layerZs.push(nz);
            if (firstLayerZ === null) firstLayerZ = nz;
          } else if (nz < layerZ - 1e-4) {
            report('E023', strictly('error'), 'Printing below a finished layer', `Line ${lineNo} extrudes at Z ${nz.toFixed(3)}, under the layer already printed at Z ${layerZ.toFixed(3)}. The nozzle would plough through the part.`, lineNo, layer);
          }
          maxPrintedZ = Math.max(maxPrintedZ, nz);
          lastExtrudeLine = lineNo;
          if (nx < printed.minX) printed.minX = Math.min(nx, x!);
          if (ny < printed.minY) printed.minY = Math.min(ny, y!);
          if (nx > printed.maxX) printed.maxX = Math.max(nx, x!);
          if (ny > printed.maxY) printed.maxY = Math.max(ny, y!);
          printed.maxZ = Math.max(printed.maxZ, nz);
        }

        if (nx < -EPS || ny < -EPS || nx > bedW + EPS || ny > bedD + EPS)
          report('E012', purge ? 'warning' : strictly('error'), 'Plastic outside the bed', `Line ${lineNo} extrudes at X ${nx.toFixed(2)} Y ${ny.toFixed(2)}, outside the ${bedW} × ${bedD} mm bed.`, lineNo, layer);
        if (nz > bedH + EPS)
          report('E022', 'error', 'Taller than the printer', `Line ${lineNo} prints at Z ${nz.toFixed(2)} mm; ${printer.label} can print up to ${bedH} mm.`, lineNo, layer);

        // Flow: how hard the hot end is pushed, and how wide the line would be.
        const volumePerMm = (de * fArea) / dxy;
        const flow = volumePerMm * Math.min(speed, printer.maxSpeed.xy);
        peakFlow = Math.max(peakFlow, flow);
        if (flow > printer.hotendMaxFlow * 1.1)
          report('W050', 'warning', 'More flow than the hot end can melt', `Some moves ask for ${flow.toFixed(1)} mm³/s; the hot end melts about ${printer.hotendMaxFlow} mm³/s. Expect under-extrusion there.`, lineNo, layer);
        const height = purge || layer <= 0 ? nz : Math.max(0.01, nz - prevLayerZ);
        const width = impliedWidth(volumePerMm, height);
        if (dxy > 0.5 && width > printer.nozzle * 2.5)
          report('E051', purge ? 'warning' : strictly('error'), 'Far too much plastic for the line', `Line ${lineNo} would lay a line about ${width.toFixed(2)} mm wide from a ${printer.nozzle} mm nozzle. The excess builds a ridge the nozzle collides with.`, lineNo, layer);

        filamentMm += de;
        segments.push6(x!, y!, z ?? nz, nx, ny, nz);
        roles.push(role);
      } else if (known && dxy > 0 && de <= 0 && layer >= 0 && !inEnd) {
        travels.push6(x!, y!, z ?? 0, nx!, ny!, nz ?? z ?? 0);
      }

      // Any move dropping into the finished print, extruding or not.
      if (nz !== null && !inEnd && maxPrintedZ > -Infinity && nz < maxPrintedZ - 0.011 && !printing)
        report('E024', strictly('error'), 'Nozzle moves down into the print', `Line ${lineNo} lowers the nozzle to Z ${nz.toFixed(3)}, below the top of what is already printed (Z ${maxPrintedZ.toFixed(3)}).`, lineNo, layer);

      x = nx;
      y = ny;
      z = nz;
      continue;
    }

    /* --- everything else --------------------------------------------- */
    switch (command) {
      case 'G4': {
        // Dwell: P milliseconds or S seconds.
        motion.stop(has('S') ? params.S : has('P') ? params.P / 1000 : 0);
        break;
      }
      case 'G28': {
        motion.stop();
        const any = has('X') || has('Y') || has('Z') || 'X' in params || 'Y' in params || 'Z' in params;
        if (!any || 'X' in params) homed.x = true;
        if (!any || 'Y' in params) homed.y = true;
        if (!any || 'Z' in params) homed.z = true;
        // Where homing parks the head differs by printer: position is unknown until set.
        x = null;
        y = null;
        z = null;
        break;
      }
      case 'G29':
      case 'G80':
      case 'M400':
        motion.stop();
        break;
      case 'G90':
        absolute = true;
        break;
      case 'G91':
        absolute = false;
        break;
      case 'G92': {
        if (has('E')) e = params.E;
        if (has('X') || has('Y') || has('Z'))
          report('W043', strictly('warning'), 'Position redefined with G92', `"${code}" tells the printer it is somewhere it may not be. The limit checks assume it is right.`, lineNo, layer);
        if (has('X')) x = params.X;
        if (has('Y')) y = params.Y;
        if (has('Z')) z = params.Z;
        break;
      }
      case 'M82':
        relativeE = false;
        break;
      case 'M83':
        relativeE = true;
        break;
      case 'M104':
      case 'M109': {
        const target = has('S') ? params.S : has('R') ? params.R : null;
        if (target === null) break;
        if (target > printer.maxNozzleTemp)
          report('E030', 'error', 'Nozzle hotter than the printer is rated for', `"${code}" sets ${target} °C; ${printer.label} is rated to ${printer.maxNozzleTemp} °C. Overheating can damage the hot end and release fumes.`, lineNo, layer);
        nozzleTarget = target;
        maxNozzle = Math.max(maxNozzle, target);
        if (command === 'M109') {
          nozzleWaited = target >= MIN_EXTRUDE_TEMP;
          motion.stop();
        }
        break;
      }
      case 'M140':
      case 'M190': {
        const target = has('S') ? params.S : has('R') ? params.R : null;
        if (target === null) break;
        if (target > printer.maxBedTemp)
          report('E031', 'error', 'Bed hotter than the printer is rated for', `"${code}" sets the bed to ${target} °C; ${printer.label}'s bed is rated to ${printer.maxBedTemp} °C.`, lineNo, layer);
        bedTarget = target;
        maxBed = Math.max(maxBed, target);
        if (command === 'M190') {
          bedWaited = true;
          motion.stop();
        }
        break;
      }
      case 'M106': {
        const s = has('S') ? params.S : 255;
        if (s < 0 || s > 255)
          report('E061', 'error', 'Fan speed out of range', `"${code}" sets the fan to ${s}; valid values are 0–255.`, lineNo, layer);
        fanOn = s > 0;
        break;
      }
      case 'M107':
        fanOn = false;
        break;
      case 'M204':
        if (has('S')) accel = params.S;
        else if (has('P')) accel = params.P;
        if (accel > printer.maxAccel * 1.01)
          report('W044', 'warning', 'Acceleration above the printer’s limit', `"${code}" asks for ${accel} mm/s²; the printer allows ${printer.maxAccel}.`, lineNo, layer);
        break;
      case 'M84':
      case 'M18': {
        // Motors off loses the position: anything after needs homing again.
        const any = 'X' in params || 'Y' in params || 'Z' in params || 'E' in params;
        if (!any || 'X' in params) homed.x = false;
        if (!any || 'Y' in params) homed.y = false;
        if (!any || 'Z' in params) homed.z = false;
        break;
      }
      default: {
        if (letter === 'T') {
          if (number !== 0)
            report('E060', strictly('error'), 'Tool change on a single-nozzle printer', `"${code}" selects tool ${number}; Caliper's ${printer.label} profile has one extruder.`, lineNo, layer);
          break;
        }
        // M862.x (Prusa model checks), M201/M203/M205, M115 and the like are
        // harmless or printer-specific; list them so a person can see them.
        unknown.set(command, (unknown.get(command) ?? 0) + 1);
      }
    }
  }

  /* --- whole-file checks ----------------------------------------------- */
  if (filamentMm <= 0)
    report('E100', 'error', 'Nothing is printed', 'The file never extrudes along a path. Either it is empty or the model was too small or thin to slice.', undefined, undefined);

  if (declaredPrinter !== null && declaredPrinter !== printer.id)
    report('E080', 'error', 'Made for a different printer', `The file says it was sliced for "${declaredPrinter}" but the printer chosen is ${printer.label}. Its limits do not apply to this file.`, 1, undefined);

  if (strict) {
    if (!sawStartMarkers)
      report('E082', 'error', 'Start sequence missing', 'The file has no Caliper start sequence markers, so it may have been edited or cut short.', undefined, undefined);
    if (lastNonEmpty !== '; caliper_end_of_file')
      report('E083', 'error', 'File is incomplete', 'The last line is not Caliper’s end-of-file marker: the file was cut short or edited after slicing.', undefined, undefined);
    if (declaredNetE === null || Math.abs(declaredNetE - netE) > 0.01 + Math.abs(declaredNetE) * 1e-5)
      report('E081', 'error', 'Extrusion total does not match', `The moves add up to ${netE.toFixed(4)} mm of filament but the file declares ${declaredNetE ?? 'nothing'}. The file was changed after slicing.`, undefined, undefined);
  }

  if (filamentMm > 0) {
    if (nozzleTarget > 0 || bedTarget > 0)
      report('W070', 'warning', 'Heaters left on at the end', `The file ends with the ${nozzleTarget > 0 ? 'nozzle' : 'bed'} still heating. Add M104 S0 and M140 S0 to the end sequence.`, lastExtrudeLine, layer);
    if (z !== null && z < maxPrintedZ + 0.5)
      report('W071', 'warning', 'Nozzle left resting on the print', `The nozzle stays at Z ${z.toFixed(2)} after printing up to Z ${maxPrintedZ.toFixed(2)}; it can melt into the top of the part.`, lastExtrudeLine, layer);
    if (fanOn) report('I072', 'info', 'Part fan left on', 'The fan keeps running after the print. Harmless, but M107 turns it off.', undefined, undefined);
    if (firstLayerZ !== null && (firstLayerZ < 0.08 || firstLayerZ > printer.nozzle * 0.8))
      report('W037', 'warning', 'Unusual first layer height', `The first layer is printed at Z ${firstLayerZ.toFixed(3)} mm; ${(printer.nozzle * 0.5).toFixed(2)}–${(printer.nozzle * 0.75).toFixed(2)} mm is usual for a ${printer.nozzle} mm nozzle.`, undefined, 0);
  }

  if (unknown.size) {
    const listed = [...unknown.entries()].map(([c, k]) => (k > 1 ? `${c} ×${k}` : c)).join(', ');
    findings.set('I090', {
      code: 'I090',
      severity: 'info',
      title: 'Commands the checker passes through',
      detail: `${listed}. These are printer-specific or harmless settings; they are not checked.`,
      count: unknown.size,
    });
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const list = [...findings.values()].sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0));
  const grams = filament ? ((filamentMm * fArea) / 1000) * filament.density : null;

  return {
    ok: !list.some((f) => f.severity === 'error'),
    findings: list,
    stats: {
      lines: lines.length,
      layers: Math.max(0, layer + 1),
      filamentMm,
      filamentGrams: grams,
      seconds: motion.total(),
      maxNozzleTemp: maxNozzle,
      maxBedTemp: maxBed,
      peakFlow,
      printed: Number.isFinite(printed.minX) ? printed : null,
      firstLayerZ,
    },
    preview: {
      segments: segments.done(),
      roles: roles.done(),
      layerStarts: Uint32Array.from(layerStarts),
      layerZ: Float32Array.from(layerZs),
      travels: travels.done(),
      travelLayerStarts: Uint32Array.from(travelLayerStarts),
    },
  };
}
