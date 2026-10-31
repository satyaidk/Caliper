/**
 * Synthetic Bambu-shaped profiles for tests. Values mirror the shape and
 * magnitudes of the real P1S 0.4 / 0.20 Standard / PLA Basic profiles. The
 * machine G-code is a short stand-in written for these tests, not Bambu's,
 * using the same template variables and the commands pre-flight looks for.
 */
import { P1S_MACHINE, PROFILE_BASE_URL } from '../../src/lib/bambu/profiles.ts';

export const START_TEMPLATE = [
  'M104 S75',
  'G28 X',
  'M140 S[bed_temperature_initial_layer_single]',
  'M190 S[bed_temperature_initial_layer_single]',
  '{if filament_type[initial_extruder]=="PLA"}M106 P3 S180{endif}',
  'M620.1 E F{flush_volumetric_speeds[initial_no_support_extruder]/2.4053*60} T{flush_temperatures[initial_no_support_extruder]}',
  'G1 X65 Y265 F12000',
  'G28 Z P0 T300',
  'G29 A X{first_layer_print_min[0]} Y{first_layer_print_min[1]} I{first_layer_print_size[0]} J{first_layer_print_size[1]}',
  'G28',
  'M83',
  'G1 X18.0 Y1.0 Z0.8 F18000',
  'M109 S{nozzle_temperature_initial_layer[initial_extruder]}',
  'G1 Z0.2',
  'G0 X240 E15 F{outer_wall_volumetric_speed/(0.3*0.5) * 60}',
  '{if curr_bed_type=="Textured PEI Plate"}G29.1 Z{-0.04}{endif}',
].join('\n');

export const END_TEMPLATE = [
  'M400',
  'G92 E0',
  'G1 E-0.8 F1800',
  'G1 Z{max_layer_z + 0.5} F900',
  'G1 X65 Y245 F12000',
  'M140 S0',
  'M104 S0',
  '{if (max_layer_z + 100.0) < 250}G1 Z{max_layer_z + 100.0} F600{else}G1 Z250 F600{endif}',
].join('\n');

const files: Record<string, object> = {
  'machine/Bambu Lab P1S': { type: 'machine_model', name: 'Bambu Lab P1S', model_id: 'C12' },
  'machine/test machine common': {
    name: 'test machine common',
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '250',
    auxiliary_fan: '1',
    support_air_filtration: '0',
  },
  [`machine/${P1S_MACHINE}`]: {
    name: P1S_MACHINE,
    inherits: 'test machine common',
    printer_model: 'Bambu Lab P1S',
    nozzle_diameter: ['0.4'],
    bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
    retraction_length: ['0.8', '0.8'],
    retraction_speed: ['30', '30'],
    deretraction_speed: ['30', '30'],
    retraction_minimum_travel: ['1', '1'],
    retract_when_changing_layer: ['1', '1'],
    retract_lift_below: ['249', '249'],
    z_hop: ['0.4', '0.4'],
    machine_max_speed_x: ['500'],
    machine_max_speed_y: ['500'],
    machine_max_speed_z: ['20'],
    machine_max_acceleration_extruding: ['20000'],
    machine_max_acceleration_travel: ['9000'],
    machine_max_acceleration_x: ['20000'],
    machine_max_acceleration_y: ['20000'],
    machine_max_acceleration_z: ['500'],
    machine_max_acceleration_e: ['5000'],
    machine_max_acceleration_retracting: ['5000'],
    machine_max_speed_e: ['30'],
    machine_max_jerk_x: ['9'],
    machine_max_jerk_y: ['9'],
    machine_max_jerk_z: ['3'],
    machine_max_jerk_e: ['2.5'],
    include: ['test start template', 'test end template'],
  },
  'machine/test start template': {
    name: 'test start template',
    machine_start_gcode: START_TEMPLATE,
    layer_change_gcode: '; layer num/total_layer_count: {layer_num+1}/[total_layer_count]\nM73 L{layer_num+1}\nM991 S0 P{layer_num}',
    time_lapse_gcode:
      '; SKIPPABLE_START\nM622.1 S1\nM1002 judge_flag timelapse_record_flag\nM622 J1\n{if timelapse_type == 0}M971 S11 C10 O0{endif}\nM623\n; SKIPPABLE_END',
  },
  'machine/test end template': { name: 'test end template', machine_end_gcode: END_TEMPLATE },
  'process/0.20mm Standard @BBL X1C': {
    name: '0.20mm Standard @BBL X1C',
    compatible_printers: [P1S_MACHINE],
    layer_height: '0.2',
    initial_layer_print_height: '0.2',
    line_width: '0.42',
    outer_wall_line_width: '0.42',
    inner_wall_line_width: '0.45',
    sparse_infill_line_width: '0.45',
    internal_solid_infill_line_width: '0.42',
    top_surface_line_width: '0.42',
    initial_layer_line_width: '0.5',
    support_line_width: '0.42',
    top_shell_layers: '5',
    top_shell_thickness: '1.0',
    bottom_shell_layers: '3',
    bottom_shell_thickness: '0',
    infill_direction: '45',
    infill_wall_overlap: '15%',
    elefant_foot_compensation: '0.15',
    outer_wall_speed: ['200', '350'],
    inner_wall_speed: ['300', '400'],
    sparse_infill_speed: ['270', '370'],
    internal_solid_infill_speed: ['250', '350'],
    top_surface_speed: ['200', '300'],
    initial_layer_speed: ['50', '50'],
    initial_layer_infill_speed: ['105', '105'],
    travel_speed: ['500', '500'],
    bridge_speed: ['50', '50'],
    support_speed: ['150', '150'],
    default_acceleration: ['10000', '10000'],
    outer_wall_acceleration: ['5000', '5000'],
    initial_layer_acceleration: ['500', '500'],
    top_surface_acceleration: ['2000', '2000'],
    travel_acceleration: ['10000', '10000'],
    support_threshold_angle: '30',
    support_top_z_distance: '0.2',
    support_object_xy_distance: '0.35',
    support_interface_top_layers: '2',
    support_base_pattern_spacing: '2.5',
    support_interface_spacing: '0.5',
    brim_width: '5',
    brim_object_gap: '0.1',
    skirt_distance: '2',
    skirt_loops: '0',
    sparse_infill_density: '15%',
    wall_loops: '2',
  },
  'filament/Bambu PLA Basic @BBL P1S 0.4 nozzle': {
    name: 'Bambu PLA Basic @BBL P1S 0.4 nozzle',
    compatible_printers: [P1S_MACHINE],
    filament_id: 'GFA00',
    filament_type: ['PLA'],
    filament_diameter: ['1.75'],
    filament_density: ['1.26'],
    filament_flow_ratio: ['0.98', '0.985'],
    filament_max_volumetric_speed: ['21', '29'],
    filament_cost: ['19.99'],
    nozzle_temperature: ['220', '220'],
    nozzle_temperature_initial_layer: ['220', '220'],
    nozzle_temperature_range_low: ['190'],
    nozzle_temperature_range_high: ['240'],
    textured_plate_temp: ['55'],
    textured_plate_temp_initial_layer: ['55'],
    cool_plate_temp: ['35'],
    cool_plate_temp_initial_layer: ['35'],
    eng_plate_temp: ['0'],
    eng_plate_temp_initial_layer: ['0'],
    hot_plate_temp: ['55'],
    hot_plate_temp_initial_layer: ['55'],
    fan_min_speed: ['100'],
    fan_max_speed: ['100'],
    fan_cooling_layer_time: ['100'],
    slow_down_layer_time: ['4'],
    slow_down_min_speed: ['20', '20'],
    close_fan_the_first_x_layers: ['1'],
    overhang_fan_speed: ['100'],
    additional_cooling_fan_speed: ['70'],
    filament_retraction_length: ['nil', '0.4'],
    filament_z_hop: ['nil', '0.6'],
    filament_retraction_speed: ['nil', '50'],
    filament_deretraction_speed: ['nil', '50'],
    filament_flush_temp: ['0'],
    filament_flush_volumetric_speed: ['0'],
    activate_air_filtration: ['0'],
    during_print_exhaust_fan_speed: ['70'],
    filament_start_gcode: ['; filament start gcode\n{if (bed_temperature[current_extruder] >50)}M106 P3 S150{endif}'],
    filament_end_gcode: ['; filament end gcode'],
  },
};

export function fakeBambuFetcher(overrides: Record<string, object> = {}) {
  const all = { ...files, ...overrides };
  return async (url: string) => {
    const key = decodeURIComponent(url.slice(PROFILE_BASE_URL.length + 1, -'.json'.length));
    const file = all[key];
    if (!file) throw new Error(`404 ${key}`);
    return JSON.stringify(file);
  };
}

/** A box as triangles in slicer order: (plateX, height, plateY). */
export function plateBox(
  [x0, h0, y0]: [number, number, number],
  [x1, h1, y1]: [number, number, number],
): number[] {
  const out: number[] = [];
  const faces = [
    [[x0, h0, y0], [x1, h0, y0], [x1, h0, y1], [x0, h0, y1]],
    [[x0, h1, y1], [x1, h1, y1], [x1, h1, y0], [x0, h1, y0]],
    [[x0, h0, y1], [x1, h0, y1], [x1, h1, y1], [x0, h1, y1]],
    [[x1, h0, y0], [x0, h0, y0], [x0, h1, y0], [x1, h1, y0]],
    [[x0, h0, y0], [x0, h0, y1], [x0, h1, y1], [x0, h1, y0]],
    [[x1, h0, y1], [x1, h0, y0], [x1, h1, y0], [x1, h1, y1]],
  ] as const;
  for (const [a, b, c, d] of faces) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return out;
}
