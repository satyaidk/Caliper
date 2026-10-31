/**
 * Packs finished G-code into a Bambu `.gcode.3mf`, the plate-sliced archive a
 * P1S prints from microSD.
 *
 * Bambu publishes no specification for this format. The layout below follows
 * what Bambu Studio writes and what the hardware-tested bambox packer (MIT)
 * documents: OPC content types and relationships, an empty model, the G-code
 * with an uppercase-hex MD5 the firmware verifies, plate/slice metadata, and
 * the merged settings as `project_settings.config`. Entry order matches
 * bambox's. Fields that are uncertain are listed in
 * docs/slicer-development-status.md for checking against a Bambu Studio file.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { md5Hex } from './md5';
import { BAMBU_STUDIO_TAG, type P1SProfiles, type ProfileValue } from './profiles';
import type { PlateType, PrintSettings, SliceChoices } from './settings';
import type { PrintStats } from '../gcode';
import type { ToolpathResult } from '../toolpath';
import { wallPathArea } from '../walls';

export const GCODE_ENTRY = 'Metadata/plate_1.gcode';

export interface PackageInput {
  gcode: string;
  toolpaths: ToolpathResult;
  settings: PrintSettings;
  choices: SliceChoices;
  profiles: P1SProfiles;
  stats: PrintStats;
  /** PNG bytes; 512 px for the plate image, 128 px for the small one. */
  thumbnail: Uint8Array;
  thumbnailSmall: Uint8Array;
  /** e.g. "Caliper-2.1.0" */
  application: string;
  filamentColour: string;
  /** Shown on the printer for the plate's object, e.g. the model file name. */
  objectName: string;
}

const BED_TYPE_KEYS: Record<PlateType, string> = {
  'Textured PEI Plate': 'textured_plate',
  'Cool Plate': 'cool_plate',
  'Engineering Plate': 'eng_plate',
  'High Temp Plate': 'hot_plate',
};

/** Bambu Studio's version number, e.g. "02.08.02.61". */
export const CLIENT_VERSION = BAMBU_STUDIO_TAG.replace(/^v/, '');

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>
 <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>
</Relationships>`;

const MODEL_SETTINGS_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/${GCODE_ENTRY}" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>
</Relationships>`;

function modelXml(application: string): string {
  const empty = [
    'Copyright', 'CreationDate', 'Description', 'Designer', 'DesignerCover', 'DesignerUserId', 'License',
    'ModificationDate', 'Origin', 'ProfileCover', 'ProfileDescription', 'ProfileTitle', 'Title',
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
    ` <metadata name="Application">${xml(application)}</metadata>`,
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ...empty.map((name) => ` <metadata name="${name}"></metadata>`),
    ' <resources>',
    ' </resources>',
    ' <build/>',
    '</model>',
    '',
  ].join('\n');
}

export function modelSettingsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="plater_name" value=""/>',
    '    <metadata key="locked" value="false"/>',
    '    <metadata key="filament_map_mode" value="Auto For Flush"/>',
    '    <metadata key="filament_maps" value="1"/>',
    '    <metadata key="filament_volume_maps" value="0"/>',
    `    <metadata key="gcode_file" value="${GCODE_ENTRY}"/>`,
    '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>',
    '    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>',
    '    <metadata key="top_file" value="Metadata/top_1.png"/>',
    '    <metadata key="pick_file" value="Metadata/pick_1.png"/>',
    '    <metadata key="pattern_bbox_file" value="Metadata/plate_1.json"/>',
    '  </plate>',
    '</config>',
    '',
  ].join('\n');
}

/**
 * Layout and field order follow a Bambu Studio 02.08 `.gcode.3mf` for the P1S.
 * Caliper prints one filament, so the slot and map lists hold one entry.
 */
export function sliceInfoXml(
  input: Pick<PackageInput, 'settings' | 'stats' | 'profiles' | 'filamentColour' | 'objectName'> & { layers: number },
): string {
  const { settings, stats, profiles } = input;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <header>',
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
    `    <header_item key="X-BBL-Client-Version" value="${CLIENT_VERSION}"/>`,
    '  </header>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    '    <metadata key="extruder_type" value="0"/>',
    '    <metadata key="nozzle_volume_type" value="0"/>',
    `    <metadata key="printer_model_id" value="${xml(profiles.printerModelId)}"/>`,
    `    <metadata key="nozzle_diameters" value="${settings.machine.nozzleDiameter}"/>`,
    '    <metadata key="timelapse_type" value="0"/>',
    `    <metadata key="prediction" value="${Math.round(stats.printSeconds)}"/>`,
    `    <metadata key="weight" value="${stats.filamentGrams.toFixed(2)}"/>`,
    `    <metadata key="first_layer_time" value="${stats.firstLayerSeconds.toFixed(6)}"/>`,
    '    <metadata key="outside" value="false"/>',
    `    <metadata key="support_used" value="${settings.support.enabled}"/>`,
    '    <metadata key="label_object_enabled" value="false"/>',
    '    <metadata key="enable_filament_dynamic_map" value="false"/>',
    '    <metadata key="has_filament_switcher" value="false"/>',
    '    <metadata key="filament_maps" value="1"/>',
    '    <metadata key="limit_filament_maps" value="0"/>',
    `    <object identify_id="1" name="${xml(input.objectName)}" skipped="false" />`,
    `    <filament id="1" tray_info_idx="${xml(settings.names.filamentId)}" type="${xml(settings.filament.type)}" color="${xml(input.filamentColour)}" used_m="${(stats.filamentMm / 1000).toFixed(2)}" used_g="${stats.filamentGrams.toFixed(2)}" group_id="0" nozzle_diameter="${settings.machine.nozzleDiameter.toFixed(2)}" volume_type="Standard" used_for_object="true" used_for_support="${settings.support.enabled}"/>`,
    `    <nozzle id="0" extruder_id="1" nozzle_diameter="${settings.machine.nozzleDiameter}" volume_type="Standard"/>`,
    '    <layer_filament_lists>',
    `      <layer_filament_list filament_list="0" layer_ranges="0 ${input.layers - 1}" />`,
    '    </layer_filament_lists>',
    '  </plate>',
    '</config>',
    '',
  ].join('\n');
}

export function plateJson(
  settings: PrintSettings,
  filamentColour: string,
  toolpaths: ToolpathResult,
  stats: PrintStats,
  objectName: string,
): string {
  const { min, max } = toolpaths.firstLayerBounds;
  const bbox = [min.x, min.y, max.x, max.y];
  const area = toolpaths.layers[0].outline.reduce((sum, loop) => sum + wallPathArea(loop), 0);
  return JSON.stringify({
    bbox_all: bbox,
    bbox_objects: [{ area: Math.abs(area), bbox, id: 1, layer_height: settings.firstLayerHeight, name: objectName }],
    bed_type: BED_TYPE_KEYS[settings.plateType],
    filament_colors: [filamentColour],
    filament_ids: [0],
    first_extruder: 0,
    first_layer_time: stats.firstLayerSeconds,
    is_seq_print: false,
    nozzle_diameter: settings.machine.nozzleDiameter,
    version: 2,
  });
}

/**
 * The merged machine, filament and process settings, as Bambu Studio stores
 * them in a project, with Caliper's choices written over the preset values.
 */
export function projectSettings(profiles: P1SProfiles, settings: PrintSettings, choices: SliceChoices): Record<string, ProfileValue> {
  const merged: Record<string, ProfileValue> = {
    ...profiles.machine.values,
    ...profiles.filament.values,
    ...profiles.process.values,
  };
  const overrides: Record<string, ProfileValue> = {
    curr_bed_type: settings.plateType,
    sparse_infill_density: `${choices.infillPercent}%`,
    wall_loops: String(choices.wallLoops),
    enable_support: settings.support.enabled ? '1' : '0',
    support_type: settings.support.enabled ? 'normal(auto)' : String(merged.support_type ?? 'normal(auto)'),
    brim_type: choices.adhesion === 'brim' ? 'outer_only' : 'no_brim',
    skirt_loops: choices.adhesion === 'skirt' ? String(settings.adhesion.skirtLoops) : '0',
    printer_settings_id: profiles.machine.name,
    print_settings_id: profiles.process.name,
    filament_settings_id: [profiles.filament.name],
    default_filament_colour: [''],
    filament_colour: ['#00AE42'],
    from: 'project',
    name: 'project_settings',
    version: CLIENT_VERSION,
  };
  const changed = ['sparse_infill_density', 'wall_loops', 'enable_support', 'brim_type', 'skirt_loops'].filter(
    (key) => String(merged[key] ?? '') !== String(overrides[key]),
  );
  return {
    ...merged,
    ...overrides,
    different_settings_to_system: [changed.join(';'), '', ''],
  };
}

/** Builds the `.gcode.3mf` archive bytes. */
export function packGcode3mf(input: PackageInput): Uint8Array {
  const gcodeBytes = strToU8(input.gcode);
  const settingsJson = projectSettings(input.profiles, input.settings, input.choices);
  settingsJson.filament_colour = [input.filamentColour];
  const entries: [string, Uint8Array][] = [
    ['[Content_Types].xml', strToU8(CONTENT_TYPES)],
    ['Metadata/plate_1.json', strToU8(plateJson(input.settings, input.filamentColour, input.toolpaths, input.stats, input.objectName))],
    ['3D/3dmodel.model', strToU8(modelXml(input.application))],
    ['Metadata/project_settings.config', strToU8(JSON.stringify(settingsJson, null, 4))],
    [`${GCODE_ENTRY}.md5`, strToU8(md5Hex(gcodeBytes).toUpperCase())],
    [GCODE_ENTRY, gcodeBytes],
    ['Metadata/_rels/model_settings.config.rels', strToU8(MODEL_SETTINGS_RELS)],
    ['Metadata/model_settings.config', strToU8(modelSettingsXml())],
    ['Metadata/slice_info.config', strToU8(sliceInfoXml({ ...input, layers: input.toolpaths.layers.length }))],
    [
      'Metadata/filament_sequence.json',
      strToU8(JSON.stringify({ plate_1: { nozzle_sequence: [0], optimal_assignment: [0], sequence: [1] } })),
    ],
    ['_rels/.rels', strToU8(RELS)],
    ['Metadata/plate_1.png', input.thumbnail],
    ['Metadata/plate_no_light_1.png', input.thumbnail],
    ['Metadata/plate_1_small.png', input.thumbnailSmall],
    ['Metadata/top_1.png', input.thumbnail],
    ['Metadata/pick_1.png', input.thumbnail],
  ];
  const zippable: Zippable = {};
  for (const [path, data] of entries) zippable[path] = [data, { level: 6 }];
  return zipSync(zippable);
}
