/**
 * Turns Bambu's machine, process and filament profiles plus the few choices
 * Caliper exposes into one typed, validated settings object, and builds the
 * variables the machine G-code templates need.
 *
 * Every number the slicer and G-code writer use comes from here, read from
 * the fetched profiles rather than written into Caliper. Values are read at
 * index 0, the standard (not high-flow) hotend variant the P1S ships with.
 * A filament value of "nil" means "use the machine's value", as in Bambu
 * Studio. `validatePrintSettings` rejects anything outside what the P1S and
 * the filament allow, so an out-of-range value stops the slice instead of
 * reaching the printer.
 */
import {
  P1S_MACHINE,
  profileList,
  profileNumber,
  profilePoints,
  profileString,
  type P1SProfiles,
  type ProfileValue,
  type ResolvedProfile,
} from './profiles';
import type { TemplateContext } from './template';

export type PlateType = 'Textured PEI Plate' | 'Cool Plate' | 'Engineering Plate' | 'High Temp Plate';
export type Adhesion = 'skirt' | 'brim' | 'none';

export const PLATE_TYPES: readonly { id: PlateType; label: string; temperatureKey: string }[] = [
  { id: 'Textured PEI Plate', label: 'Textured PEI', temperatureKey: 'textured_plate_temp' },
  { id: 'Cool Plate', label: 'Cool Plate', temperatureKey: 'cool_plate_temp' },
  { id: 'Engineering Plate', label: 'Engineering Plate', temperatureKey: 'eng_plate_temp' },
  { id: 'High Temp Plate', label: 'High Temp Plate', temperatureKey: 'hot_plate_temp' },
];

export interface SliceChoices {
  processId: string;
  filamentId: string;
  plateType: PlateType;
  /** Sparse infill, 0–100 %. */
  infillPercent: number;
  wallLoops: number;
  supports: boolean;
  adhesion: Adhesion;
}

export interface Point2 {
  x: number;
  y: number;
}

export interface PrintSettings {
  names: { machine: string; process: string; filament: string; filamentId: string };
  plateType: PlateType;
  machine: {
    printableArea: Point2[];
    excludeAreas: Point2[][];
    maxHeight: number;
    nozzleDiameter: number;
    maxSpeedXY: number;
    maxSpeedZ: number;
    maxAccelerationExtruding: number;
    maxAccelerationTravel: number;
    retractionLength: number;
    retractionSpeed: number;
    deretractionSpeed: number;
    retractionMinimumTravel: number;
    retractOnLayerChange: boolean;
    zHop: number;
    /** Z-hop is skipped above this height (Bambu's `retract_lift_below`). */
    zHopBelow: number;
    auxiliaryFan: boolean;
    /** Firmware limits Bambu Studio writes at the start of a file (M201/M203/M204/M205). */
    limits: {
      accelerationX: number;
      accelerationY: number;
      accelerationZ: number;
      accelerationE: number;
      accelerationRetracting: number;
      speedE: number;
      jerkX: number;
      jerkY: number;
      jerkZ: number;
      jerkE: number;
    };
  };
  layerHeight: number;
  firstLayerHeight: number;
  widths: { outer: number; inner: number; sparse: number; solid: number; top: number; firstLayer: number; support: number };
  wallLoops: number;
  topShellLayers: number;
  bottomShellLayers: number;
  infillDensity: number;
  infillAngle: number;
  infillWallOverlap: number;
  elephantFootCompensation: number;
  speeds: {
    outer: number;
    inner: number;
    sparse: number;
    solid: number;
    top: number;
    firstLayer: number;
    firstLayerInfill: number;
    travel: number;
    bridge: number;
    support: number;
  };
  accelerations: { normal: number; outer: number; firstLayer: number; top: number; travel: number };
  filament: {
    type: string;
    diameter: number;
    density: number;
    flowRatio: number;
    maxVolumetricSpeed: number;
    nozzleTemperature: number;
    nozzleTemperatureFirstLayer: number;
    temperatureRange: [number, number];
    bedTemperature: number;
    bedTemperatureFirstLayer: number;
    fanMinPercent: number;
    fanMaxPercent: number;
    fanCoolingLayerTime: number;
    slowDownLayerTime: number;
    slowDownMinSpeed: number;
    fanOffFirstLayers: number;
    overhangFanPercent: number;
    auxiliaryFanPercent: number;
    costPerKg: number;
    startGcode: string;
    endGcode: string;
  };
  support: {
    enabled: boolean;
    thresholdAngle: number;
    topZDistance: number;
    xyDistance: number;
    interfaceLayers: number;
    /** Gap between support body lines, and between interface lines. */
    baseSpacing: number;
    interfaceSpacing: number;
  };
  adhesion: { type: Adhesion; brimWidth: number; brimGap: number; skirtDistance: number; skirtLoops: number };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/* P1S hardware limits that no profile value may exceed. */
export const P1S_LIMITS = {
  nozzleTemperatureMax: 300,
  bedTemperatureMax: 100,
  heightMax: 250,
  layerHeightMin: 0.08,
  layerHeightMax: 0.28,
  firstLayerHeightMax: 0.35,
} as const;

function isNil(profile: ResolvedProfile, key: string): boolean {
  const value: ProfileValue | undefined = profile.values[key];
  if (value === undefined) return true;
  const first = typeof value === 'string' ? value : value[0];
  return first === undefined || first.trim() === '' || first === 'nil';
}

/** A filament override, falling back to the machine value when it is "nil". */
function filamentOr(profiles: P1SProfiles, filamentKey: string, machineKey: string): number {
  return isNil(profiles.filament, filamentKey)
    ? profileNumber(profiles.machine, machineKey)
    : profileNumber(profiles.filament, filamentKey);
}

/** A width of 0 means "use the default line width", as in Bambu Studio. */
function width(process: ResolvedProfile, key: string): number {
  const value = profileNumber(process, key);
  return value > 0 ? value : profileNumber(process, 'line_width');
}

/** Bambu writes some accelerations as a percentage of the default. */
function acceleration(process: ResolvedProfile, key: string, normal: number): number {
  const raw = profileString(process, key).trim();
  if (raw.endsWith('%')) return (normal * profileNumber(process, key)) / 100;
  const value = profileNumber(process, key);
  return value > 0 ? value : normal;
}

function bool(profile: ResolvedProfile, key: string): boolean {
  const value = profileString(profile, key).trim();
  if (value !== '0' && value !== '1') throw new SettingsError(`"${key}" in "${profile.name}" is not 0 or 1.`);
  return value === '1';
}

/** Shell layers: the larger of the layer count and the minimum thickness. */
function shellLayers(process: ResolvedProfile, layersKey: string, thicknessKey: string, layerHeight: number): number {
  const layers = profileNumber(process, layersKey);
  const thickness = process.values[thicknessKey] === undefined ? 0 : profileNumber(process, thicknessKey);
  return layers === 0 ? 0 : Math.max(layers, Math.ceil(thickness / layerHeight - 1e-9));
}

export function buildPrintSettings(profiles: P1SProfiles, choices: SliceChoices): PrintSettings {
  const { machine, process, filament } = profiles;
  const plate = PLATE_TYPES.find((candidate) => candidate.id === choices.plateType);
  if (!plate) throw new SettingsError(`Unknown plate type "${choices.plateType}".`);
  const bedTemperature = profileNumber(filament, plate.temperatureKey);
  const bedTemperatureFirstLayer = profileNumber(filament, `${plate.temperatureKey}_initial_layer`);
  if (bedTemperature <= 0 || bedTemperatureFirstLayer <= 0) {
    throw new SettingsError(
      `${profileString(filament, 'filament_type')} must not be printed on the ${plate.label}; choose another plate.`,
    );
  }

  const layerHeight = profileNumber(process, 'layer_height');
  const normalAcceleration = profileNumber(process, 'default_acceleration');
  const printableHeight = profileNumber(machine, 'printable_height');
  const exclude = profilePoints(machine, 'bed_exclude_area');

  const settings: PrintSettings = {
    names: {
      machine: machine.name,
      process: process.name,
      filament: filament.name,
      filamentId: profileString(filament, 'filament_id'),
    },
    plateType: choices.plateType,
    machine: {
      printableArea: profilePoints(machine, 'printable_area'),
      excludeAreas: exclude.length ? [exclude] : [],
      maxHeight: Math.min(printableHeight, P1S_LIMITS.heightMax),
      nozzleDiameter: profileNumber(machine, 'nozzle_diameter'),
      maxSpeedXY: Math.min(profileNumber(machine, 'machine_max_speed_x'), profileNumber(machine, 'machine_max_speed_y')),
      maxSpeedZ: profileNumber(machine, 'machine_max_speed_z'),
      maxAccelerationExtruding: profileNumber(machine, 'machine_max_acceleration_extruding'),
      maxAccelerationTravel: profileNumber(machine, 'machine_max_acceleration_travel'),
      retractionLength: filamentOr(profiles, 'filament_retraction_length', 'retraction_length'),
      retractionSpeed: filamentOr(profiles, 'filament_retraction_speed', 'retraction_speed'),
      deretractionSpeed: filamentOr(profiles, 'filament_deretraction_speed', 'deretraction_speed'),
      retractionMinimumTravel: filamentOr(profiles, 'filament_retraction_minimum_travel', 'retraction_minimum_travel'),
      retractOnLayerChange: bool(machine, 'retract_when_changing_layer'),
      zHop: filamentOr(profiles, 'filament_z_hop', 'z_hop'),
      zHopBelow: profileNumber(machine, 'retract_lift_below'),
      auxiliaryFan: bool(machine, 'auxiliary_fan'),
      limits: {
        accelerationX: profileNumber(machine, 'machine_max_acceleration_x'),
        accelerationY: profileNumber(machine, 'machine_max_acceleration_y'),
        accelerationZ: profileNumber(machine, 'machine_max_acceleration_z'),
        accelerationE: profileNumber(machine, 'machine_max_acceleration_e'),
        accelerationRetracting: profileNumber(machine, 'machine_max_acceleration_retracting'),
        speedE: profileNumber(machine, 'machine_max_speed_e'),
        jerkX: profileNumber(machine, 'machine_max_jerk_x'),
        jerkY: profileNumber(machine, 'machine_max_jerk_y'),
        jerkZ: profileNumber(machine, 'machine_max_jerk_z'),
        jerkE: profileNumber(machine, 'machine_max_jerk_e'),
      },
    },
    layerHeight,
    firstLayerHeight: profileNumber(process, 'initial_layer_print_height'),
    widths: {
      outer: width(process, 'outer_wall_line_width'),
      inner: width(process, 'inner_wall_line_width'),
      sparse: width(process, 'sparse_infill_line_width'),
      solid: width(process, 'internal_solid_infill_line_width'),
      top: width(process, 'top_surface_line_width'),
      firstLayer: width(process, 'initial_layer_line_width'),
      support: width(process, 'support_line_width'),
    },
    wallLoops: choices.wallLoops,
    topShellLayers: shellLayers(process, 'top_shell_layers', 'top_shell_thickness', layerHeight),
    bottomShellLayers: shellLayers(process, 'bottom_shell_layers', 'bottom_shell_thickness', layerHeight),
    infillDensity: choices.infillPercent / 100,
    infillAngle: profileNumber(process, 'infill_direction'),
    infillWallOverlap: profileNumber(process, 'infill_wall_overlap') / 100,
    elephantFootCompensation: profileNumber(process, 'elefant_foot_compensation'),
    speeds: {
      outer: profileNumber(process, 'outer_wall_speed'),
      inner: profileNumber(process, 'inner_wall_speed'),
      sparse: profileNumber(process, 'sparse_infill_speed'),
      solid: profileNumber(process, 'internal_solid_infill_speed'),
      top: profileNumber(process, 'top_surface_speed'),
      firstLayer: profileNumber(process, 'initial_layer_speed'),
      firstLayerInfill: profileNumber(process, 'initial_layer_infill_speed'),
      travel: profileNumber(process, 'travel_speed'),
      bridge: profileNumber(process, 'bridge_speed'),
      support: profileNumber(process, 'support_speed'),
    },
    accelerations: {
      normal: normalAcceleration,
      outer: acceleration(process, 'outer_wall_acceleration', normalAcceleration),
      firstLayer: acceleration(process, 'initial_layer_acceleration', normalAcceleration),
      top: acceleration(process, 'top_surface_acceleration', normalAcceleration),
      travel: acceleration(process, 'travel_acceleration', normalAcceleration),
    },
    filament: {
      type: profileString(filament, 'filament_type'),
      diameter: profileNumber(filament, 'filament_diameter'),
      density: profileNumber(filament, 'filament_density'),
      flowRatio: profileNumber(filament, 'filament_flow_ratio'),
      maxVolumetricSpeed: profileNumber(filament, 'filament_max_volumetric_speed'),
      nozzleTemperature: profileNumber(filament, 'nozzle_temperature'),
      nozzleTemperatureFirstLayer: profileNumber(filament, 'nozzle_temperature_initial_layer'),
      temperatureRange: [
        profileNumber(filament, 'nozzle_temperature_range_low'),
        profileNumber(filament, 'nozzle_temperature_range_high'),
      ],
      bedTemperature,
      bedTemperatureFirstLayer,
      fanMinPercent: profileNumber(filament, 'fan_min_speed'),
      fanMaxPercent: profileNumber(filament, 'fan_max_speed'),
      fanCoolingLayerTime: profileNumber(filament, 'fan_cooling_layer_time'),
      slowDownLayerTime: profileNumber(filament, 'slow_down_layer_time'),
      slowDownMinSpeed: profileNumber(filament, 'slow_down_min_speed'),
      fanOffFirstLayers: profileNumber(filament, 'close_fan_the_first_x_layers'),
      overhangFanPercent: profileNumber(filament, 'overhang_fan_speed'),
      auxiliaryFanPercent: profileNumber(filament, 'additional_cooling_fan_speed'),
      costPerKg: profileNumber(filament, 'filament_cost'),
      startGcode: profileString(filament, 'filament_start_gcode'),
      endGcode: profileString(filament, 'filament_end_gcode'),
    },
    support: {
      enabled: choices.supports,
      thresholdAngle: profileNumber(process, 'support_threshold_angle'),
      topZDistance: profileNumber(process, 'support_top_z_distance'),
      xyDistance: profileNumber(process, 'support_object_xy_distance'),
      interfaceLayers: profileNumber(process, 'support_interface_top_layers'),
      baseSpacing: profileNumber(process, 'support_base_pattern_spacing'),
      interfaceSpacing: profileNumber(process, 'support_interface_spacing'),
    },
    adhesion: {
      type: choices.adhesion,
      brimWidth: profileNumber(process, 'brim_width'),
      brimGap: profileNumber(process, 'brim_object_gap'),
      skirtDistance: profileNumber(process, 'skirt_distance'),
      skirtLoops: Math.max(1, profileNumber(process, 'skirt_loops')),
    },
  };
  validatePrintSettings(settings);
  return settings;
}

/** Throws if any value is outside what the P1S hardware or the filament allows. */
export function validatePrintSettings(settings: PrintSettings): void {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  const positive = (value: number, label: string, max = Infinity) =>
    check(Number.isFinite(value) && value > 0 && value <= max, `${label} must be above 0 and at most ${max}.`);
  const { machine, filament } = settings;

  check(settings.names.machine === P1S_MACHINE, 'Only the P1S 0.4 mm nozzle is supported.');
  check(machine.nozzleDiameter === 0.4, 'The nozzle must be 0.4 mm.');
  check(
    settings.layerHeight >= P1S_LIMITS.layerHeightMin && settings.layerHeight <= P1S_LIMITS.layerHeightMax,
    `Layer height must be ${P1S_LIMITS.layerHeightMin}–${P1S_LIMITS.layerHeightMax} mm.`,
  );
  check(
    settings.firstLayerHeight >= P1S_LIMITS.layerHeightMin && settings.firstLayerHeight <= P1S_LIMITS.firstLayerHeightMax,
    `First layer height must be ${P1S_LIMITS.layerHeightMin}–${P1S_LIMITS.firstLayerHeightMax} mm.`,
  );
  for (const [name, value] of Object.entries(settings.widths)) {
    check(value >= 0.3 && value <= 0.8, `The ${name} line width must be 0.3–0.8 mm for a 0.4 mm nozzle.`);
  }
  check(Number.isInteger(settings.wallLoops) && settings.wallLoops >= 1 && settings.wallLoops <= 6, 'Walls must be 1–6.');
  check(settings.infillDensity >= 0 && settings.infillDensity <= 1, 'Infill must be 0–100 %.');
  check(settings.topShellLayers >= 1 && settings.topShellLayers <= 20, 'Top shell layers must be 1–20.');
  check(settings.bottomShellLayers >= 1 && settings.bottomShellLayers <= 20, 'Bottom shell layers must be 1–20.');
  for (const [name, value] of Object.entries(settings.speeds)) positive(value, `The ${name} speed`, machine.maxSpeedXY);
  for (const [name, value] of Object.entries(settings.accelerations)) {
    positive(value, `The ${name} acceleration`, machine.maxAccelerationExtruding);
  }
  positive(machine.maxHeight, 'Printable height', P1S_LIMITS.heightMax);
  positive(machine.maxSpeedZ, 'Maximum Z speed', 50);
  check(machine.printableArea.length >= 3, 'The printable area is missing.');
  check(machine.retractionLength >= 0 && machine.retractionLength <= 5, 'Retraction must be 0–5 mm.');
  positive(machine.retractionSpeed, 'Retraction speed', 100);
  positive(machine.deretractionSpeed, 'Deretraction speed', 100);
  check(machine.zHop >= 0 && machine.zHop <= 2, 'Z-hop must be 0–2 mm.');
  check(filament.diameter === 1.75, 'Filament diameter must be 1.75 mm.');
  check(filament.flowRatio > 0.8 && filament.flowRatio <= 1.2, 'Flow ratio must be 0.8–1.2.');
  positive(filament.density, 'Filament density', 3);
  positive(filament.maxVolumetricSpeed, 'Maximum volumetric speed', 40);
  const [low, high] = filament.temperatureRange;
  for (const [label, value] of [
    ['Nozzle temperature', filament.nozzleTemperature],
    ['First-layer nozzle temperature', filament.nozzleTemperatureFirstLayer],
  ] as const) {
    check(
      value >= low && value <= high && value <= P1S_LIMITS.nozzleTemperatureMax,
      `${label} ${value} °C is outside ${low}–${Math.min(high, P1S_LIMITS.nozzleTemperatureMax)} °C.`,
    );
  }
  for (const [label, value] of [
    ['Bed temperature', filament.bedTemperature],
    ['First-layer bed temperature', filament.bedTemperatureFirstLayer],
  ] as const) {
    check(value > 0 && value <= P1S_LIMITS.bedTemperatureMax, `${label} must be 1–${P1S_LIMITS.bedTemperatureMax} °C.`);
  }
  for (const [label, value] of [
    ['Minimum fan', filament.fanMinPercent],
    ['Maximum fan', filament.fanMaxPercent],
    ['Overhang fan', filament.overhangFanPercent],
    ['Auxiliary fan', filament.auxiliaryFanPercent],
  ] as const) {
    check(value >= 0 && value <= 100, `${label} must be 0–100 %.`);
  }
  check(filament.fanMinPercent <= filament.fanMaxPercent, 'Minimum fan must not exceed maximum fan.');
  positive(filament.slowDownMinSpeed, 'Minimum print speed', machine.maxSpeedXY);
  check(settings.support.thresholdAngle > 0 && settings.support.thresholdAngle < 89, 'Support angle must be 1–88°.');
  check(settings.support.topZDistance >= 0 && settings.support.topZDistance <= 1, 'Support Z gap must be 0–1 mm.');
  check(settings.support.xyDistance >= 0 && settings.support.xyDistance <= 3, 'Support XY gap must be 0–3 mm.');
  check(
    Number.isInteger(settings.support.interfaceLayers) && settings.support.interfaceLayers >= 0 && settings.support.interfaceLayers <= 10,
    'Support interface layers must be 0–10.',
  );
  check(settings.support.baseSpacing > 0 && settings.support.baseSpacing <= 10, 'Support spacing must be above 0 and at most 10 mm.');
  check(settings.support.interfaceSpacing >= 0 && settings.support.interfaceSpacing <= 5, 'Support interface spacing must be 0–5 mm.');
  check(settings.adhesion.brimWidth >= 0 && settings.adhesion.brimWidth <= 20, 'Brim width must be 0–20 mm.');
  if (problems.length) throw new SettingsError(problems.join(' '));
}

/** The flow Bambu's start sequence uses for its purge line: the outer-wall flow, capped by the filament. */
export function outerWallVolumetricSpeed(settings: PrintSettings): number {
  return Math.min(
    settings.speeds.outer * settings.widths.outer * settings.layerHeight,
    settings.filament.maxVolumetricSpeed,
  );
}

export interface TemplateInputs {
  /** Bounding box of everything printed on the first layer, in plate mm. */
  firstLayerMin: Point2;
  firstLayerSize: Point2;
  maxLayerZ: number;
  totalLayerCount: number;
}

/**
 * Variables for the machine start/end templates and the filament start/end
 * code. Built explicitly: the template evaluator rejects any variable not
 * listed here, so a new Bambu template that needs something Caliper does not
 * provide fails instead of rendering wrongly.
 *
 * `flush_temperatures` and `flush_volumetric_speeds` are computed by Bambu
 * Studio rather than stored; when the filament's flush values are 0 they fall
 * back to the top of its temperature range and its maximum volumetric speed.
 */
export function startEndTemplateContext(profiles: P1SProfiles, settings: PrintSettings, inputs: TemplateInputs): TemplateContext {
  const { filament } = settings;
  const flushTemperature = isNil(profiles.filament, 'filament_flush_temp') || profileNumber(profiles.filament, 'filament_flush_temp') === 0
    ? filament.temperatureRange[1]
    : profileNumber(profiles.filament, 'filament_flush_temp');
  const flushSpeed =
    isNil(profiles.filament, 'filament_flush_volumetric_speed') ||
    profileNumber(profiles.filament, 'filament_flush_volumetric_speed') === 0
      ? filament.maxVolumetricSpeed
      : profileNumber(profiles.filament, 'filament_flush_volumetric_speed');
  const exhaust = profiles.filament.values.during_print_exhaust_fan_speed === undefined
    ? 0
    : profileNumber(profiles.filament, 'during_print_exhaust_fan_speed');
  return {
    initial_extruder: 0,
    initial_no_support_extruder: 0,
    current_extruder: 0,
    filament_type: [filament.type],
    nozzle_temperature: [filament.nozzleTemperature],
    nozzle_temperature_initial_layer: [filament.nozzleTemperatureFirstLayer],
    bed_temperature: [filament.bedTemperature],
    bed_temperature_initial_layer: [filament.bedTemperatureFirstLayer],
    bed_temperature_initial_layer_single: filament.bedTemperatureFirstLayer,
    flush_temperatures: [flushTemperature],
    flush_volumetric_speeds: [flushSpeed],
    // Whole millimetres, minimum rounded down and maximum rounded up, as Bambu
    // Studio writes it: the levelled area always covers the first layer.
    first_layer_print_min: [Math.floor(inputs.firstLayerMin.x), Math.floor(inputs.firstLayerMin.y)],
    first_layer_print_size: [
      Math.ceil(inputs.firstLayerMin.x + inputs.firstLayerSize.x) - Math.floor(inputs.firstLayerMin.x),
      Math.ceil(inputs.firstLayerMin.y + inputs.firstLayerSize.y) - Math.floor(inputs.firstLayerMin.y),
    ],
    outer_wall_volumetric_speed: outerWallVolumetricSpeed(settings),
    curr_bed_type: settings.plateType,
    max_layer_z: round3(inputs.maxLayerZ),
    total_layer_count: inputs.totalLayerCount,
    activate_air_filtration: [profileList(profiles.filament, 'activate_air_filtration')[0] === '1'],
    support_air_filtration: profiles.machine.values.support_air_filtration === '1',
    during_print_exhaust_fan_speed_num: [Math.round((exhaust * 255) / 100)],
  };
}

/** Variables for the per-layer templates (layer change, timelapse). */
export function layerTemplateContext(
  base: TemplateContext,
  layerIndex: number,
  layerZ: number,
): TemplateContext {
  return { ...base, layer_num: layerIndex, layer_z: round3(layerZ), timelapse_type: 0 };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
