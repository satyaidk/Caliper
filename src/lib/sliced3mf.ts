import { unzipSync } from 'fflate';

/**
 * Recognises a sliced Bambu/Orca print file (`.gcode.3mf`).
 *
 * Why it needs its own check: a plate-sliced 3MF holds G-code for the printer
 * and an empty 3D model, so the 3MF loader finds nothing to draw. Saying that
 * plainly beats a generic "no geometry" error. Only the zip directory is read;
 * no entry is decompressed.
 */
export function slicedPlates(data: ArrayBuffer | Uint8Array): string[] {
  const plates: string[] = [];
  try {
    unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data), {
      filter(file) {
        if (/^Metadata\/plate_\d+\.gcode$/.test(file.name)) plates.push(file.name);
        return false;
      },
    });
  } catch {
    return [];
  }
  return plates;
}

export const SLICED_3MF_MESSAGE =
  'This is a sliced print file (.gcode.3mf): it holds G-code for the printer, not a 3D model. ' +
  'Open the original .stl, .3mf or .step to slice it here, or send this file to the printer as it is.';
