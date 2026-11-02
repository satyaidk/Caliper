/**
 * What the slicer needs to know about the printer, the filament and the print.
 *
 * The printer profiles are also the safety envelope the G-code checker
 * (`verify.ts`) holds every file to: the axes may not leave `limits`, no heater
 * may be set past its maximum, and so on. Numbers come from the makers'
 * published specifications, rounded towards the safe side where a model range
 * shares one profile (the Bambu X1, P1 and A1 share a 256 mm bed but not a
 * maximum bed temperature, so the profile takes the lowest).
 *
 * The start and end sequences are Caliper's own, written from the G-code
 * standards (RepRap / Marlin documentation), not taken from any slicer's
 * profiles. Bambu Lab printers ship none: their own start sequence does
 * nozzle wiping, AMS loading and calibration that Caliper cannot reproduce
 * safely, so for them a person pastes a start sequence they trust, and the
 * checker still verifies it.
 */

export type FilamentId = 'pla' | 'petg' | 'abs';
export type InfillPattern = 'grid' | 'lines';
export type SeamPosition = 'rear' | 'aligned';

export interface PrinterProfile {
  /** Same id as the build plate in `src/lib/printers.ts`. */
  id: string;
  label: string;
  /** Printable area: width (X), depth (Y), height (Z) in mm. */
  bed: [number, number, number];
  /** How far each axis may travel, in mm. Moves past these are errors. */
  limits: { x: [number, number]; y: [number, number]; z: [number, number] };
  nozzle: number;
  filamentDiameter: number;
  /** Highest temperatures the hardware is rated for. */
  maxNozzleTemp: number;
  maxBedTemp: number;
  /** Firmware ceilings in mm/s. A move asking for more is capped by the firmware. */
  maxSpeed: { xy: number; z: number; e: number };
  maxAccel: number;
  /** Most plastic the hot end melts reliably, mm³/s. */
  hotendMaxFlow: number;
  /** The longest retraction that is still safe for this extruder, mm. */
  maxRetract: number;
  retract: { length: number; speed: number; minTravel: number; lift: number };
  speeds: {
    outerWall: number;
    innerWall: number;
    sparseInfill: number;
    solidInfill: number;
    topSurface: number;
    bridge: number;
    firstLayer: number;
    travel: number;
    firstLayerTravel: number;
  };
  accel: { print: number; travel: number; firstLayer: number };
  /** A primed line drawn before the print, in printer mm. Null for none. */
  purge: { from: [number, number]; to: [number, number] } | null;
  /**
   * `builtin`: Caliper's own start and end sequences are used.
   * `custom`: the person must supply them; export is blocked until they do.
   */
  startMode: 'builtin' | 'custom';
  startGcode: string;
  endGcode: string;
  /** Shown beside the printer, so the limits of the support are never hidden. */
  notes: string[];
}

export interface FilamentProfile {
  id: FilamentId;
  label: string;
  nozzleTemp: number;
  firstLayerNozzleTemp: number;
  bedTemp: number;
  firstLayerBedTemp: number;
  /** Temperatures this material prints well between. Outside is a warning. */
  nozzleRange: [number, number];
  fan: { min: number; max: number; alwaysOn: boolean; offLayers: number; fullAtLayer: number; bridge: number };
  /** Below this layer time the print slows down; below `fanBelow` the fan rises. */
  slowdownLayerTime: number;
  fanBelowLayerTime: number;
  minPrintSpeed: number;
  maxFlow: number;
  density: number;
  flowRatio: number;
  needsEnclosure: boolean;
}

export interface ProcessSettings {
  layerHeight: number;
  firstLayerHeight: number;
  walls: number;
  topLayers: number;
  bottomLayers: number;
  /** 0 to 1. */
  infillDensity: number;
  infillPattern: InfillPattern;
  /** Degrees from the X axis for the first layer's lines. */
  infillAngle: number;
  skirtLoops: number;
  /** Gap between the skirt and the parts, mm. */
  skirtDistance: number;
  /** Brim width, mm. 0 for none. */
  brimWidth: number;
  seam: SeamPosition;
  /** Overhangs steeper than this, from vertical, are reported as needing support. */
  overhangLimitDeg: number;
}

export interface CustomGcode {
  start: string;
  end: string;
}

/** Placeholders a start or end sequence may use. Anything else is refused. */
export const PLACEHOLDERS = [
  'printer',
  'first_bed_temp',
  'first_nozzle_temp',
  'bed_temp',
  'nozzle_temp',
  'nozzle_diameter',
  'retract_length',
  'retract_speed',
  'park_x',
  'park_y',
  'park_z',
  'z_speed',
  'travel_speed',
] as const;

/* ---------------------------------------------------------------- printers */

const MARLIN_END = `; Caliper end sequence
G1 E-{retract_length} F{retract_speed}  ; take the pressure off the nozzle
G1 Z{park_z} F{z_speed}              ; lift clear of the print
G1 X{park_x} Y{park_y} F{travel_speed}  ; present the print
M104 S0                              ; nozzle heater off
M140 S0                              ; bed heater off
M106 S0                              ; part fan off
M84 X Y E                            ; release the motors, keep Z holding`;

export const PRINTERS: PrinterProfile[] = [
  {
    id: 'ender-3',
    label: 'Creality Ender-3',
    bed: [220, 220, 250],
    limits: { x: [0, 220], y: [0, 220], z: [0, 250] },
    nozzle: 0.4,
    filamentDiameter: 1.75,
    // The stock hot end lines its heat break with PTFE, which starts to break
    // down around 240–250 °C. 245 keeps a margin under that.
    maxNozzleTemp: 245,
    maxBedTemp: 100,
    maxSpeed: { xy: 180, z: 5, e: 25 },
    maxAccel: 1000,
    hotendMaxFlow: 10,
    maxRetract: 8,
    retract: { length: 5, speed: 45, minTravel: 1.5, lift: 0 },
    speeds: {
      outerWall: 25,
      innerWall: 40,
      sparseInfill: 50,
      solidInfill: 40,
      topSurface: 30,
      bridge: 25,
      firstLayer: 20,
      travel: 120,
      firstLayerTravel: 80,
    },
    accel: { print: 500, travel: 1000, firstLayer: 500 },
    purge: { from: [3, 20], to: [3, 180] },
    startMode: 'builtin',
    startGcode: `; Caliper start sequence for {printer}
G90                       ; absolute X, Y and Z
M83                       ; relative extrusion
M140 S{first_bed_temp}    ; start heating the bed
M104 S150                 ; warm the nozzle without letting it ooze
G28                       ; home all axes
M190 S{first_bed_temp}    ; wait for the bed
M104 S{first_nozzle_temp}
M109 S{first_nozzle_temp} ; wait for the nozzle
G92 E0`,
    endGcode: MARLIN_END,
    notes: [
      'Stock Ender-3 with Marlin: no automatic bed levelling, so level the bed by hand first.',
      'Nozzle temperature is capped at 245 °C for the stock PTFE-lined hot end.',
    ],
  },
  {
    id: 'prusa-mk4',
    label: 'Prusa MK4',
    bed: [250, 210, 220],
    limits: { x: [0, 250], y: [-4, 210], z: [0, 220] },
    nozzle: 0.4,
    filamentDiameter: 1.75,
    maxNozzleTemp: 290,
    maxBedTemp: 120,
    maxSpeed: { xy: 300, z: 12, e: 100 },
    maxAccel: 4000,
    hotendMaxFlow: 15,
    maxRetract: 3,
    retract: { length: 0.8, speed: 35, minTravel: 1.5, lift: 0.2 },
    speeds: {
      outerWall: 45,
      innerWall: 80,
      sparseInfill: 120,
      solidInfill: 100,
      topSurface: 60,
      bridge: 25,
      firstLayer: 25,
      travel: 200,
      firstLayerTravel: 120,
    },
    accel: { print: 2000, travel: 4000, firstLayer: 800 },
    purge: { from: [5, 2], to: [100, 2] },
    startMode: 'builtin',
    startGcode: `; Caliper start sequence for {printer}
M862.3 P "MK4"            ; the printer asks before running a file made for another model
M862.1 P{nozzle_diameter} ; and before running one made for another nozzle
G90                       ; absolute X, Y and Z
M83                       ; relative extrusion
M140 S{first_bed_temp}    ; start heating the bed
M104 S170                 ; probing temperature: clean, but too cool to ooze
M190 S{first_bed_temp}    ; wait for the bed
M109 S170                 ; wait for the probing temperature
G28                       ; home all axes (the nozzle is the probe)
G29                       ; measure the bed mesh
M104 S{first_nozzle_temp}
M109 S{first_nozzle_temp} ; wait for the printing temperature
G92 E0`,
    endGcode: MARLIN_END,
    notes: [
      'The file starts by asking the printer to confirm the model (MK4) and the nozzle size.',
      'Experimental: this start sequence has not been tried on every firmware release.',
    ],
  },
  {
    id: 'bambu-256',
    label: 'Bambu Lab X1, P1 and A1',
    bed: [256, 256, 256],
    limits: { x: [0, 256], y: [0, 256], z: [0, 256] },
    nozzle: 0.4,
    filamentDiameter: 1.75,
    maxNozzleTemp: 300,
    // The A1 and P1 beds are rated to 100 °C; the X1's goes higher.
    maxBedTemp: 100,
    maxSpeed: { xy: 500, z: 20, e: 60 },
    maxAccel: 10000,
    hotendMaxFlow: 20,
    maxRetract: 3,
    retract: { length: 0.8, speed: 30, minTravel: 1.5, lift: 0.4 },
    speeds: {
      outerWall: 100,
      innerWall: 150,
      sparseInfill: 200,
      solidInfill: 150,
      topSurface: 100,
      bridge: 30,
      firstLayer: 40,
      travel: 300,
      firstLayerTravel: 200,
    },
    accel: { print: 5000, travel: 10000, firstLayer: 500 },
    purge: { from: [20, 3], to: [120, 3] },
    startMode: 'custom',
    startGcode: '',
    endGcode: MARLIN_END,
    notes: [
      'Bambu printers need their own start sequence (nozzle wipe, bed levelling, AMS). Caliper does not ship one.',
      'To export, paste a start sequence you trust under Custom G-code. It is checked like the rest of the file.',
    ],
  },
  {
    id: 'bambu-180',
    label: 'Bambu Lab A1 mini',
    bed: [180, 180, 180],
    limits: { x: [0, 180], y: [0, 180], z: [0, 180] },
    nozzle: 0.4,
    filamentDiameter: 1.75,
    maxNozzleTemp: 300,
    maxBedTemp: 80,
    maxSpeed: { xy: 500, z: 20, e: 60 },
    maxAccel: 10000,
    hotendMaxFlow: 20,
    maxRetract: 3,
    retract: { length: 0.8, speed: 30, minTravel: 1.5, lift: 0.4 },
    speeds: {
      outerWall: 100,
      innerWall: 150,
      sparseInfill: 200,
      solidInfill: 150,
      topSurface: 100,
      bridge: 30,
      firstLayer: 40,
      travel: 300,
      firstLayerTravel: 200,
    },
    accel: { print: 5000, travel: 10000, firstLayer: 500 },
    purge: { from: [10, 3], to: [90, 3] },
    startMode: 'custom',
    startGcode: '',
    endGcode: MARLIN_END,
    notes: [
      'Bambu printers need their own start sequence (nozzle wipe, bed levelling, AMS). Caliper does not ship one.',
      'The A1 mini bed is rated to 80 °C, so ABS is refused.',
    ],
  },
];

export function printerById(id: string): PrinterProfile | null {
  return PRINTERS.find((p) => p.id === id) ?? null;
}

/* --------------------------------------------------------------- filaments */

export const FILAMENT_PROFILES: FilamentProfile[] = [
  {
    id: 'pla',
    label: 'PLA',
    nozzleTemp: 210,
    firstLayerNozzleTemp: 215,
    bedTemp: 60,
    firstLayerBedTemp: 60,
    nozzleRange: [190, 230],
    fan: { min: 100, max: 100, alwaysOn: true, offLayers: 1, fullAtLayer: 3, bridge: 100 },
    slowdownLayerTime: 6,
    fanBelowLayerTime: 60,
    minPrintSpeed: 10,
    maxFlow: 15,
    density: 1.24,
    flowRatio: 1,
    needsEnclosure: false,
  },
  {
    id: 'petg',
    label: 'PETG',
    nozzleTemp: 240,
    firstLayerNozzleTemp: 240,
    bedTemp: 75,
    firstLayerBedTemp: 75,
    nozzleRange: [220, 260],
    fan: { min: 30, max: 50, alwaysOn: true, offLayers: 3, fullAtLayer: 5, bridge: 80 },
    slowdownLayerTime: 10,
    fanBelowLayerTime: 30,
    minPrintSpeed: 10,
    maxFlow: 10,
    density: 1.27,
    flowRatio: 0.95,
    needsEnclosure: false,
  },
  {
    id: 'abs',
    label: 'ABS',
    nozzleTemp: 250,
    firstLayerNozzleTemp: 255,
    bedTemp: 100,
    firstLayerBedTemp: 100,
    nozzleRange: [235, 270],
    fan: { min: 0, max: 30, alwaysOn: false, offLayers: 3, fullAtLayer: 5, bridge: 50 },
    slowdownLayerTime: 15,
    fanBelowLayerTime: 30,
    minPrintSpeed: 10,
    maxFlow: 15,
    density: 1.04,
    flowRatio: 1,
    needsEnclosure: true,
  },
];

export function filamentById(id: FilamentId): FilamentProfile {
  return FILAMENT_PROFILES.find((f) => f.id === id) ?? FILAMENT_PROFILES[0];
}

/* ----------------------------------------------------------------- process */

export const DEFAULT_PROCESS: ProcessSettings = {
  layerHeight: 0.2,
  firstLayerHeight: 0.2,
  walls: 2,
  topLayers: 4,
  bottomLayers: 3,
  infillDensity: 0.15,
  infillPattern: 'grid',
  infillAngle: 45,
  skirtLoops: 1,
  skirtDistance: 3,
  brimWidth: 0,
  seam: 'rear',
  overhangLimitDeg: 45,
};

/**
 * Settings the slicer refuses outright, before it starts. Everything here
 * would produce a file that is wrong in a way no later check can rescue.
 * Returns human-readable reasons; empty means the settings are usable.
 */
export function settingProblems(printer: PrinterProfile, filament: FilamentProfile, process: ProcessSettings): string[] {
  const problems: string[] = [];
  const maxLayer = printer.nozzle * 0.75;
  if (!(process.layerHeight >= 0.05 && process.layerHeight <= maxLayer + 1e-9))
    problems.push(`Layer height must be between 0.05 and ${maxLayer.toFixed(2)} mm for a ${printer.nozzle} mm nozzle.`);
  if (!(process.firstLayerHeight >= 0.1 && process.firstLayerHeight <= maxLayer + 1e-9))
    problems.push(`First layer height must be between 0.10 and ${maxLayer.toFixed(2)} mm.`);
  if (!(process.walls >= 1 && process.walls <= 10)) problems.push('Use between 1 and 10 walls.');
  if (!(process.topLayers >= 0 && process.topLayers <= 20)) problems.push('Use between 0 and 20 top layers.');
  if (!(process.bottomLayers >= 1 && process.bottomLayers <= 20)) problems.push('Use between 1 and 20 bottom layers.');
  if (!(process.infillDensity >= 0 && process.infillDensity <= 1)) problems.push('Infill density must be 0–100 %.');
  if (!(process.brimWidth >= 0 && process.brimWidth <= 20)) problems.push('Brim width must be 0–20 mm.');
  if (filament.firstLayerNozzleTemp > printer.maxNozzleTemp || filament.nozzleTemp > printer.maxNozzleTemp)
    problems.push(
      `${filament.label} prints at ${Math.max(filament.nozzleTemp, filament.firstLayerNozzleTemp)} °C, above this printer's ${printer.maxNozzleTemp} °C limit.`,
    );
  if (filament.firstLayerBedTemp > printer.maxBedTemp || filament.bedTemp > printer.maxBedTemp)
    problems.push(
      `${filament.label} needs a ${Math.max(filament.bedTemp, filament.firstLayerBedTemp)} °C bed, above this printer's ${printer.maxBedTemp} °C limit.`,
    );
  return problems;
}
