/**
 * Messages between the UI and the slicing Web Worker. Kept in one place so
 * both sides agree on shapes; only structured-clone-safe data crosses.
 */
import type { SliceChoices, PrintSettings } from '@/lib/bambu/settings';
import type { PreflightReport } from '@/lib/bambu/preflight';
import type { PrintStats } from '@/lib/gcode';

export interface SliceRequest {
  id: number;
  /** Triangles as (plateX, height, plateY) millimetre triples. */
  triangles: Float32Array;
  heightMm: number;
  choices: SliceChoices;
  filamentColour: string;
  application: string;
  objectName: string;
}

export type SliceStage = 'profiles' | 'slicing' | 'checking' | 'packaging';

/** Toolpaths for the preview: one segment per pair of points, layers concatenated. */
export interface PreviewData {
  /** Segment endpoints, (plateX, plateY, z) per vertex. */
  positions: Float32Array;
  colors: Float32Array;
  /** Vertex count at the end of each layer (cumulative). */
  layerEnds: Uint32Array;
  layerZ: Float32Array;
  /** Features present, for the legend. */
  features: string[];
}

export interface SliceSummary {
  stats: PrintStats;
  preflight: PreflightReport;
  settings: Pick<PrintSettings, 'layerHeight' | 'plateType' | 'wallLoops' | 'infillDensity'> & {
    filamentType: string;
    nozzleTemperature: number;
    bedTemperature: number;
    processName: string;
    filamentName: string;
  };
}

export type SliceResponse =
  | { id: number; type: 'progress'; stage: SliceStage }
  | { id: number; type: 'result'; summary: SliceSummary; preview: PreviewData; archive: Uint8Array | null }
  | { id: number; type: 'error'; message: string };
