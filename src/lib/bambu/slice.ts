/**
 * One slice, start to finish: settings → toolpaths → G-code → pre-flight.
 * Framework-free so it runs in a Web Worker and in tests alike.
 */
import type { TriangleSource } from '@/viewer/triangles';
import { generateToolpaths, type ToolpathResult } from '../toolpath';
import { writePrintGcode, type MachineTemplates, type PrintStats } from '../gcode';
import { BAMBU_STUDIO_TAG, profileString, type P1SProfiles } from './profiles';
import {
  buildPrintSettings,
  layerTemplateContext,
  startEndTemplateContext,
  type PrintSettings,
  type SliceChoices,
} from './settings';
import { renderTemplate } from './template';
import { runPreflight, type PreflightReport } from './preflight';
import { packGcode3mf } from './package3mf';
import { renderThumbnail } from './thumbnail';

export interface SliceOutput {
  settings: PrintSettings;
  toolpaths: ToolpathResult;
  gcode: string;
  stats: PrintStats;
  preflight: PreflightReport;
}

export function machineTemplates(profiles: P1SProfiles): MachineTemplates {
  return {
    start: profileString(profiles.machine, 'machine_start_gcode'),
    end: profileString(profiles.machine, 'machine_end_gcode'),
    layerChange: profileString(profiles.machine, 'layer_change_gcode'),
    timelapse: profileString(profiles.machine, 'time_lapse_gcode'),
    filamentStart: profileString(profiles.filament, 'filament_start_gcode'),
    filamentEnd: profileString(profiles.filament, 'filament_end_gcode'),
  };
}

/**
 * Slices a mesh already placed on the plate. Vertices are
 * `(plateX, heightAboveBed, plateY)` in millimetres (see `toolpath.ts`).
 */
export function slicePlate(
  source: TriangleSource,
  objectHeight: number,
  profiles: P1SProfiles,
  choices: SliceChoices,
  generator: string,
): SliceOutput {
  const settings = buildPrintSettings(profiles, choices);
  const toolpaths = generateToolpaths(source, objectHeight, settings);
  const { min, max } = toolpaths.firstLayerBounds;
  const context = startEndTemplateContext(profiles, settings, {
    firstLayerMin: min,
    firstLayerSize: { x: max.x - min.x, y: max.y - min.y },
    maxLayerZ: toolpaths.maxZ,
    totalLayerCount: toolpaths.layers.length,
  });
  const templates = machineTemplates(profiles);
  const written = writePrintGcode({
    toolpaths,
    settings,
    templates,
    context,
    generator,
    profileSource: `Bambu Studio ${BAMBU_STUDIO_TAG}`,
  });
  const preflight = runPreflight({
    text: written.text,
    settings,
    startBlock: written.startBlock,
    endBlock: written.endBlock,
    // Commands Bambu's per-layer and filament templates emit are allowed in the
    // print body; taken from the rendered text so conditionals are resolved.
    templateBlocks: [
      renderTemplate(templates.layerChange, layerTemplateContext(context, 0, toolpaths.layers[0].z)),
      renderTemplate(templates.timelapse, layerTemplateContext(context, 0, toolpaths.layers[0].z)),
      renderTemplate(templates.filamentStart, context),
      renderTemplate(templates.filamentEnd, context),
    ],
  });
  return { settings, toolpaths, gcode: written.text, stats: written.stats, preflight };
}

/** Packs a passing slice into `.gcode.3mf` bytes; refuses one that failed pre-flight. */
export function packageSlice(
  output: SliceOutput,
  profiles: P1SProfiles,
  choices: SliceChoices,
  filamentColour: string,
  application: string,
  objectName = 'plate',
): Uint8Array {
  if (!output.preflight.ok) throw new Error('This slice failed the pre-flight check and cannot be exported.');
  return packGcode3mf({
    gcode: output.gcode,
    toolpaths: output.toolpaths,
    settings: output.settings,
    choices,
    profiles,
    stats: output.stats,
    thumbnail: renderThumbnail(output.toolpaths, 512, filamentColour),
    thumbnailSmall: renderThumbnail(output.toolpaths, 128, filamentColour),
    application,
    filamentColour,
    objectName,
  });
}
